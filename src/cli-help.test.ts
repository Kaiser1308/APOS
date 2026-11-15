import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';

const GROUPS = [
  'profile',
  'goal',
  'lead',
  'execution',
  'package',
  'integration',
  'controller',
  'gate',
  'review',
  'metrics',
  'evidence',
  'decision',
  'blocker',
  'outcome',
  'finding',
];

afterEach(() => vi.restoreAllMocks());

/** commander prints help to stdout and exits; capture the text and turn the exit into a throw. */
async function help(args: string[]): Promise<string> {
  let text = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    text += String(chunk);
    return true;
  });
  // The default of --repo is the working directory; pin it so the help wraps the same on every machine.
  vi.spyOn(process, 'cwd').mockReturnValue('/repo');
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  await runCli([...args, '--help'], { write: () => undefined, home: '/home' }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith('exit 0')) throw error;
  });
  vi.restoreAllMocks();
  return text;
}

it('pins the top-level help', async () => {
  await expect(await help([])).toMatchFileSnapshot('./__snapshots__/cli-help/root.txt');
});

it.each(GROUPS)('pins %s --help', async group => {
  await expect(await help([group])).toMatchFileSnapshot(`./__snapshots__/cli-help/${group}.txt`);
});
