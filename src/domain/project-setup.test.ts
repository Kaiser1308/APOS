import { describe, expect, it } from 'vitest';
import { parseProjectSetup, parseSetupObject, setupSha256 } from './project-setup.js';
import { jsonCodec } from './setup-codec.js';
import { UserError } from './errors.js';

const tool = { id: 'vitest', command: 'npx vitest run --reporter=junit --outputFile={report}', format: 'junit' };
const valid = {
  schemaVersion: 2,
  parts: {
    backend: {
      root: 'backend/',
      stack: 'java-gradle',
      layers: { L1: [tool] },
      needsHuman: ['build.gradle'],
      forbid: [],
    },
    frontend: {
      root: 'frontend',
      layers: { L2: [{ ...tool, runOne: 'npx vitest run -t {id}' }] },
      needsHuman: [],
      forbid: [],
    },
  },
  system: { L4: [{ id: 'e2e', command: 'npx playwright test', format: 'junit', when: 'flag:e2e' }] },
  floor: { submit: ['L0', 'L1'] },
  triggers: [{ when: { changed: ['frontend/src/ui/**'] }, at: 'submit', run: ['system.L4', 'frontend.L2'] }],
  mutation: { minScore: 70 },
};
const refused = (value: unknown) => {
  try {
    parseSetupObject(value);
  } catch (error) {
    expect(error).toBeInstanceOf(UserError);
    return (error as Error).message;
  }
  throw new Error('expected parseSetupObject to refuse');
};

describe('parseSetupObject', () => {
  it('reads schemaVersion 1 as "no setup"', () => {
    expect(parseSetupObject({ schemaVersion: 1 })).toEqual({ version: 1 });
    expect(parseSetupObject(null)).toEqual({ version: 1 });
  });
  it('reads a valid v2 setup and fills defaults', () => {
    const parsed = parseSetupObject(valid);
    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) return;
    expect(parsed.setup.parts.backend?.root).toBe('backend');
    expect(parsed.setup.parts.frontend?.forbid).toEqual([]);
    expect(parseSetupObject({ schemaVersion: 2, parts: {} })).toEqual({
      version: 2,
      setup: { schemaVersion: 2, parts: {} },
    });
  });
  it('refuses an unknown schemaVersion', () => {
    expect(refused({ schemaVersion: 3 })).toMatch(/schemaVersion/);
    expect(refused('nope')).toMatch(/schemaVersion/);
  });
  it('refuses parts whose roots collide, however they are spelled', () => {
    const part = (root: string) => ({ root, layers: {}, needsHuman: [], forbid: [] });
    expect(refused({ schemaVersion: 2, parts: { a: part('app/'), b: part('./app') } })).toMatch(/same root/);
  });
  it('refuses roots that leave the repo', () => {
    for (const root of ['../x', '/abs', 'a/../../b', 'C:\\x'])
      expect(refused({ schemaVersion: 2, parts: { a: { root, layers: {}, needsHuman: [], forbid: [] } } })).toMatch(
        /root/,
      );
  });
  it('refuses a trigger that runs a layer nobody defines', () => {
    const trigger = (run: string) => ({
      ...valid,
      triggers: [{ when: { goalFlag: 'perf' }, at: 'close', run: [run] }],
    });
    expect(refused(trigger('system.L5'))).toMatch(/system\.L5/);
    expect(refused(trigger('ghost.L1'))).toMatch(/ghost\.L1/);
    expect(refused(trigger('L1'))).toMatch(/L1/);
    expect(refused({ ...valid, triggers: [{ when: {}, at: 'submit', run: ['system.L4'] }] })).toMatch(/when/);
  });
  it('refuses bad tools: unknown format, runOne without {id}, duplicate id, bad when', () => {
    const withTools = (tools: unknown[]) => ({
      schemaVersion: 2,
      parts: { a: { root: 'a', layers: { L1: tools }, needsHuman: [], forbid: [] } },
    });
    expect(refused(withTools([{ ...tool, format: 'tap' }]))).toMatch(/format/);
    expect(refused(withTools([{ ...tool, runOne: 'vitest' }]))).toMatch(/\{id\}/);
    expect(refused(withTools([tool, tool]))).toMatch(/duplicate/);
    expect(refused(withTools([{ ...tool, when: 'sometimes' }]))).toMatch(/when/);
  });
  it('refuses a mutation threshold outside 0..100', () => {
    expect(refused({ ...valid, mutation: { minScore: 120 } })).toMatch(/minScore/);
  });
});

describe('setupSha256', () => {
  it('is the same across line endings and differs when content differs', () => {
    expect(setupSha256('a: 1\r\nb: 2\r\n')).toBe(setupSha256('a: 1\nb: 2\n'));
    expect(setupSha256('a: 1\n')).not.toBe(setupSha256('a: 2\n'));
    expect(setupSha256('a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseProjectSetup', () => {
  it('reads the text with the codec: v1 legacy text, v2 JSON with a hash of the text, and refuses garbage', () => {
    expect(parseProjectSetup('schemaVersion: 1\n', jsonCodec)).toEqual({ version: 1 });
    const text = jsonCodec.stringify(valid);
    const parsed = parseProjectSetup(text, jsonCodec);
    expect(parsed).toMatchObject({ version: 2, sha256: setupSha256(text) });
    expect(() => parseProjectSetup('{ nope', jsonCodec)).toThrow(/cannot be read/);
    expect(() => parseProjectSetup('{"schemaVersion":9}', jsonCodec)).toThrow(UserError);
    expect(parseProjectSetup('', jsonCodec)).toEqual({ version: 1 });
  });
  it('round-trips what a codec writes', () => {
    const parsed = parseSetupObject(valid);
    if (parsed.version !== 2) throw new Error('v2 expected');
    expect(parseSetupObject(jsonCodec.parse(jsonCodec.stringify(parsed.setup)))).toEqual(parsed);
  });
});

it('reserves the part name "system"', () => {
  expect(
    refused({ schemaVersion: 2, parts: { system: { root: 'a', layers: {}, needsHuman: [], forbid: [] } } }),
  ).toMatch(/reserved/);
});
