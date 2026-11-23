import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.js';
import { newEvent } from '../app/events.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { ProjectJournal } from '../store/journal.js';

const dirs: string[] = [];
export const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
export const removeTemp = () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
};

export const bugArgs = [
  '--given',
  'a cart of 40 and FREE0',
  '--when',
  'the total is computed',
  '--then',
  'the total is 40',
];
const report =
  'require(\'fs\').writeFileSync(process.argv[2],\'<testsuite name="s"><testcase classname="s" name="a"/></testsuite>\');';

export async function project(options: { withSetup?: boolean; parts?: string[] } = {}) {
  const dir = temp('apos-bug-repo-');
  const home = temp('apos-bug-ctl-');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@local.invalid', ...args], {
      encoding: 'utf8',
    }).trim();
  const out: string[] = [];
  const err: string[] = [];
  const invoke = (...args: string[]) =>
    runCli(['--repo', dir, ...args], {
      home,
      write: line => out.push(line),
      writeError: line => err.push(line),
      io: { isTTY: false, prompt: () => Promise.reject(new Error('no terminal')) },
    });
  await invoke('init');
  if (options.withSetup) {
    writeFileSync(join(dir, 'report.js'), report);
    for (const name of (options.parts ?? []).slice(1)) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'report.js'), report);
    }
    const parts = Object.fromEntries(
      (options.parts ?? ['app']).map((name, index) => [
        name,
        {
          root: index === 0 ? '.' : name,
          layers: { L1: [{ id: 'unit', command: 'node report.js {report}', format: 'junit' }] },
          needsHuman: [],
          forbid: [],
        },
      ]),
    );
    writeFileSync(join(dir, '.apos', 'project.yaml'), jsonCodec.stringify({ schemaVersion: 2, parts }));
    git('add', '-A');
    git('commit', '-qm', 'setup');
    const commit = git('rev-parse', 'HEAD');
    await invoke('setup', 'probe', '--commit', commit);
    await invoke('setup', 'approve', '--commit', commit, '--on-behalf', 'test');
  }
  const open = <T>(fn: (journal: ProjectJournal) => T): T => {
    const opened = ProjectJournal.open(dir, home, newEvent);
    try {
      return fn(opened.journal);
    } finally {
      opened.close();
    }
  };
  return {
    dir,
    home,
    git,
    invoke,
    out,
    err,
    state: (id: string) => open(journal => journal.getGoal(id)),
    events: (id: string) => open(journal => journal.events(id)),
    open,
  };
}
