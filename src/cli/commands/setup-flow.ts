import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCatalog } from '../../app/catalog-loader.js';
import { draftSetup, parsePartFlag } from '../../app/setup-draft.js';
import { prepareApproval, recordApproval } from '../../app/setup-approve.js';
import { probeSetup, recordProbe } from '../../app/setup-probe.js';
import { UserError } from '../../domain/errors.js';
import { parseProjectSetup } from '../../domain/project-setup.js';
import { SETUP_FILE, jsonCodec } from '../../domain/setup-codec.js';
import { ON_BEHALF_FLAGS, ON_BEHALF_HELP } from '../human-confirm.js';
import type { CliContext } from '../context.js';

/** apos setup draft | probe | approve | show: the lifecycle of a project's setup (`.apos/project.yaml`). */
export function registerSetupFlow(ctx: CliContext): void {
  const { program, options, write, writeError, repo, withJournal, withJournalAsync, assertHuman } = ctx;
  const codec = options.codec ?? jsonCodec;
  const setup = program.command('setup').description('draft, probe and approve the project setup');
  const resolveCommit = (revision: string) => {
    try {
      return execFileSync('git', ['-C', repo(), 'rev-parse', '--verify', `${revision}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new UserError(`${revision} is not a commit in this repo`);
    }
  };

  setup
    .command('draft')
    .description(`write a draft ${SETUP_FILE} from the tool catalog (not committed)`)
    .option(
      '--part <name=dir[:stack]>',
      'a part of the repo, repeatable; without it, parts are detected',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--force', 'overwrite a v2 setup that already has parts')
    .action((flags: { part?: string[]; force?: boolean }) => {
      const file = join(repo(), SETUP_FILE);
      if (!existsSync(join(repo(), '.apos'))) throw new UserError('Run apos init first');
      if (existsSync(file) && !flags.force) {
        const current = parseProjectSetup(readFileSync(file, 'utf8'), codec);
        if (current.version === 2 && Object.keys(current.setup.parts).length)
          throw new UserError(`${SETUP_FILE} already has a v2 setup; pass --force to overwrite it`);
      }
      const { entries, warnings } = loadCatalog({ codec });
      for (const warning of warnings) writeError(`catalog: ${warning}`);
      const parts = Object.fromEntries(
        (flags.part ?? []).map(text => {
          const part = parsePartFlag(text);
          return [part.name, { root: part.root, ...(part.stack ? { stack: part.stack } : {}) }];
        }),
      );
      const draft = draftSetup(repo(), entries, { parts });
      writeFileSync(file, codec.stringify(draft.setup), 'utf8');
      write(`Wrote ${SETUP_FILE}: ${Object.keys(draft.setup.parts).join(', ') || 'no parts'}`);
      for (const note of draft.notes) write(`- ${note}`);
      write('Not committed. Edit it, commit it, then: apos setup probe --commit <sha>');
    });

  setup
    .command('probe')
    .description('run every tool of the committed setup in a clean worktree and record the result')
    .option('--commit <rev>', 'commit holding the setup', 'HEAD')
    .action((flags: { commit: string }) =>
      withJournalAsync(async journal => {
        const commit = resolveCommit(flags.commit);
        const { entries, warnings } = loadCatalog({ codec });
        for (const warning of warnings) writeError(`catalog: ${warning}`);
        const report = await probeSetup(repo(), commit, {
          codec,
          artifactRoot: journal.artifactRoot(),
          catalog: entries,
        });
        recordProbe(journal, commit, report);
        for (const item of report.results)
          write(`${item.ok ? 'ok  ' : 'FAIL'} ${item.part}.${item.layer} ${item.tool}: ${item.reason}`);
        write(
          `setup ${report.sha256.slice(0, 12)} at ${commit.slice(0, 12)}: probe ${report.ok ? 'passed' : 'failed'}`,
        );
        if (!report.ok) throw new UserError('The probe failed: this setup cannot be approved yet');
      }),
    );

  setup
    .command('approve')
    .description('Human decision: approve the probed setup at a commit; Goals approved later pin it')
    .requiredOption('--commit <rev>', 'commit holding the probed setup')
    .option(ON_BEHALF_FLAGS, ON_BEHALF_HELP)
    .action((flags: { commit: string; onBehalf?: string }) =>
      withJournalAsync(async journal => {
        const pending = prepareApproval(journal, repo(), flags.commit, codec);
        const confirmation = await assertHuman('setup approve', pending.commit.slice(0, 12), flags.onBehalf);
        const approved = recordApproval(journal, pending, confirmation);
        write(
          `Approved setup v${approved.version} (${approved.sha256.slice(0, 12)}) at ${approved.commit.slice(0, 12)}`,
        );
      }),
    );

  setup
    .command('show')
    .description('print the latest approved setup version')
    .action(() =>
      withJournal(journal => {
        const latest = journal.setupHistory().latest;
        write(
          latest
            ? `setup v${latest.version} sha256 ${latest.sha256} commit ${latest.commit}`
            : 'No approved setup: guarantees that depend on a setup are off',
        );
      }),
    );
}
