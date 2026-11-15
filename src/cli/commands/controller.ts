import { setTimeout as sleep } from 'node:timers/promises';
import { withControllerLease } from '../../store/lease.js';
import { HandoffService } from '../../app/handoff.js';
import { ControllerService } from '../../app/controller.js';
import { GateService } from '../../app/gate.js';
import { CodexSessionProbe } from '../../runtime/telemetry.js';
import { loadProfiles } from '../../runtime/brief.js';
import { controllerHome } from '../../store/event-log.js';
import type { PackageRuntime, RuntimeAdapter } from '../../ports/runtime.js';
import type { CliContext } from '../context.js';

export function registerController(ctx: CliContext): void {
  const { program, options, write, runtime, repo, home, withJournalAsync } = ctx;
  const controller = program.command('controller');
  const leasedTick = async () => {
    const leased = await withControllerLease(options.home ?? controllerHome(repo()), () =>
      withJournalAsync(async journal =>
        new ControllerService(journal, runtime as RuntimeAdapter & PackageRuntime, {
          gate: new GateService(journal, { inspector: options.inspector, ...options.gate }),
          telemetry: options.telemetry ?? new CodexSessionProbe(),
          freshLead: (goalId, repoPath) =>
            new HandoffService(journal, runtime, () => loadProfiles(home())).handoff(
              goalId,
              { kind: 'lead' },
              repoPath,
            ),
        }).tick(repo()),
      ),
    );
    return leased;
  };
  controller.command('tick').action(async () => {
    const leased = await leasedTick();
    write(
      leased.ran
        ? JSON.stringify(leased.value)
        : JSON.stringify({ skipped: `another controller (pid ${leased.holder}) is ticking this project` }),
    );
  });
  controller
    .command('watch')
    .option('--interval-ms <n>', 'mechanical controller interval', '15000')
    .action(async ({ intervalMs }: { intervalMs: string }) => {
      const interval = Number(intervalMs);
      if (!Number.isInteger(interval) || interval < 1000 || interval > 300000)
        throw new Error('Watch interval must be 1000 to 300000 ms');
      // Seen live: started detached, every Orca call failed with no_active_sender_terminal and the Goal stalled.
      if (!options.runtime && !process.env.ORCA_TERMINAL_HANDLE)
        throw new Error(
          'controller watch must run inside a live Orca terminal (ORCA_TERMINAL_HANDLE is not set); Orca refuses orchestration calls from a process with no sender terminal',
        );
      let stopped = false;
      const abort = new AbortController();
      const stop = () => {
        stopped = true;
        abort.abort();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        let lastReport = '';
        while (!stopped) {
          const leased = await leasedTick();
          const ticks = leased.ran ? leased.value : [];
          const changed = ticks.filter(
            item =>
              item.dispatched.length ||
              item.recovered.length ||
              item.resumed.length ||
              item.settled.length ||
              item.inboxPending.length ||
              item.errors.length ||
              item.supervised.length,
          );
          const report = JSON.stringify(changed);
          if (changed.length && report !== lastReport) write(report);
          lastReport = report;
          if (!stopped) {
            try {
              await sleep(interval, undefined, { signal: abort.signal });
            } catch (error) {
              if (!stopped) throw error;
            }
          }
        }
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    });
}
