import { readEventStream } from '../../store/event-stream.js';
import { UserError } from '../../domain/errors.js';
import type { CliContext } from '../context.js';

export function registerEvents(ctx: CliContext): void {
  ctx.program
    .command('events')
    .requiredOption('--since <seq>', 'last consumed sequence (0 starts from the beginning)')
    .option('--initialize', 'explicitly create a new index and reset all cursors')
    .option('--generation <id>', 'index generation from the previous response')
    .option('--anchor <hash>', 'cursor anchor from the previous response')
    .requiredOption('--json', 'emit JSON')
    .action((flags: { since: string; initialize?: boolean; generation?: string; anchor?: string }) => {
      if (!/^(0|[1-9]\d*)$/.test(flags.since) || !Number.isSafeInteger(Number(flags.since)))
        throw new UserError('--since must be a non-negative safe integer');
      ctx.withJournal(() => {
        const stream = readEventStream(ctx.home(), Number(flags.since), flags);
        ctx.write(JSON.stringify({ schemaVersion: 1, ...stream }));
      });
    });
}
