import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceText, spec } from '../domain/fixtures.test-support.js';
import { jsonCodec } from '../domain/setup-codec.js';
import { buildSnapshot } from '../ui/read-model.js';
import { ReadOnlyJournal } from '../store/readonly-journal.js';
import { project, removeTemp, temp } from './bug.test-support.js';

const saved = process.env.APOS_HOME;
beforeEach(() => {
  process.env.APOS_HOME = temp('apos-legacy-home-');
});
afterEach(() => {
  process.exitCode = undefined;
  if (saved === undefined) delete process.env.APOS_HOME;
  else process.env.APOS_HOME = saved;
  removeTemp();
});

/** A tool that finds no test while `tests/` has no file, and two tests once it has one: pytest's exit 5 in miniature. */
const tool = `
const fs = require('fs');
const has = fs.existsSync('tests') && fs.readdirSync('tests').some(name => name.endsWith('.txt'));
const n = has ? 2 : 0;
fs.writeFileSync(process.argv[2], '<testsuite name="s">' + Array.from({ length: n }, (_, i) => '<testcase classname="s" name="t' + i + '"/>').join('') + '</testsuite>');
process.exit(has ? 0 : 5);
`;
const setupText = jsonCodec.stringify({
  schemaVersion: 2,
  parts: {
    app: {
      root: '.',
      layers: { L1: [{ id: 'unit', command: 'node tool.js {report}', format: 'junit' }] },
      needsHuman: [],
      forbid: [],
      tests: {
        paths: ['tests/**'],
        assertPatterns: [],
        notImplementedPatterns: [],
        loadErrorPatterns: [],
        noTestsExitCodes: [5],
      },
    },
  },
});

async function legacyProject() {
  const p = await project();
  writeFileSync(join(p.dir, 'tool.js'), tool);
  mkdirSync(join(p.dir, 'tests'));
  writeFileSync(join(p.dir, 'tests', '.gitkeep'), '');
  writeFileSync(join(p.dir, '.apos', 'project.yaml'), setupText);
  p.git('add', '-A');
  p.git('commit', '-qm', 'setup');
  return { ...p, head: () => execFileSync('git', ['-C', p.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

describe('a setup approved with no baseline', () => {
  it('is refused without the flag, accepted with it, and labels every Goal on it, in goal show, the inbox and the UI', async () => {
    const p = await legacyProject();
    const commit = p.head();
    await p.invoke('setup', 'probe', '--commit', commit);
    expect(p.out.join('\n')).toMatch(/none app\.L1 unit: .*no tests/);
    await expect(p.invoke('setup', 'approve', '--commit', commit, '--on-behalf', 'x')).rejects.toThrow(
      /apos setup approve --commit \w+ --baseline-missing/,
    );
    p.out.length = 0;
    await p.invoke('setup', 'approve', '--commit', commit, '--baseline-missing', '--on-behalf', 'x');
    expect(p.out.join('\n')).toContain('BẢO ĐẢM THẤP: repo chưa có test nền (app.L1)');
    await p.invoke('setup', 'show');
    expect(p.out.join('\n')).toMatch(/setup v1 .*\nBẢO ĐẢM THẤP/);

    writeFileSync(join(p.dir, 'goal.json'), JSON.stringify(spec));
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
    await p.invoke(
      'goal',
      'approve',
      spec.id,
      '--size',
      'S',
      '--max-minutes',
      '60',
      '--max-attempts',
      '3',
      '--on-behalf',
      'x',
    );
    expect(p.state(spec.id)?.baselineMissing).toEqual(['app.L1']);

    p.out.length = 0;
    await p.invoke('goal', 'show', spec.id);
    const table = p.out.join('\n').split('\n\n')[1]!;
    expect(table.split('\n')[0]).toBe('BẢO ĐẢM THẤP: repo chưa có test nền (app.L1)');
    p.out.length = 0;
    await p.invoke('inbox');
    expect(p.out.join('\n')).toContain('BẢO ĐẢM THẤP: repo chưa có test nền (app.L1)');
    const snapshot = buildSnapshot(new ReadOnlyJournal(p.home));
    expect(snapshot.inbox.map(item => item.detail).join('\n')).toContain('low-assurance');
    expect(JSON.stringify(snapshot)).toContain('BẢO ĐẢM THẤP: repo chưa có test nền (app.L1)');
  }, 120_000);

  it('loses the label only with a new setup version approved on a probe that sees tests; Goals on the old one keep it', async () => {
    const p = await legacyProject();
    const first = p.head();
    await p.invoke('setup', 'probe', '--commit', first);
    await p.invoke('setup', 'approve', '--commit', first, '--baseline-missing', '--on-behalf', 'x');
    writeFileSync(join(p.dir, 'goal.json'), JSON.stringify(spec));
    writeFileSync(join(p.dir, 'brief.md'), sourceText);
    await p.invoke('goal', 'create', '--file', join(p.dir, 'goal.json'), '--source', join(p.dir, 'brief.md'));
    // The tests arrive; the setup text is the same, so only the new probe makes version 2.
    writeFileSync(join(p.dir, 'tests', 'a.txt'), 'x');
    p.git('add', '-A');
    p.git('commit', '-qm', 'tests arrive');
    const second = p.head();
    await expect(p.invoke('setup', 'approve', '--commit', second, '--on-behalf', 'x')).rejects.toThrow(/Chưa probe/);
    p.out.length = 0;
    await p.invoke('setup', 'probe', '--commit', second);
    expect(p.out.join('\n')).not.toMatch(/none app/);
    await expect(
      p.invoke('setup', 'approve', '--commit', second, '--baseline-missing', '--on-behalf', 'x'),
    ).rejects.toThrow(/--baseline-missing/);
    p.out.length = 0;
    await p.invoke('setup', 'approve', '--commit', second, '--on-behalf', 'x');
    expect(p.out.join('\n')).toContain('Approved setup v2');
    expect(p.out.join('\n')).not.toContain('BẢO ĐẢM THẤP');
    await p.invoke(
      'goal',
      'approve',
      spec.id,
      '--size',
      'S',
      '--max-minutes',
      '60',
      '--max-attempts',
      '3',
      '--on-behalf',
      'x',
    );
    expect(p.state(spec.id)?.setupVersion).toBe(2);
    expect(p.state(spec.id)?.baselineMissing).toBeUndefined();
  }, 120_000);
});
