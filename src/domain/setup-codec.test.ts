import { expect, it } from 'vitest';
import { jsonCodec, yamlCodec } from './setup-codec.js';

it('reads existing JSON setup files as YAML', () => {
  expect(yamlCodec.parse('{"schemaVersion":2,"parts":{}}\r\n')).toEqual({ schemaVersion: 2, parts: {} });
});

it('writes readable YAML with stable indentation and a trailing newline', () => {
  const text = yamlCodec.stringify({ schemaVersion: 2, parts: { app: { root: '.', layers: { L0: [] } } } });
  expect(text).toContain('schemaVersion: 2');
  expect(text).toContain('app:');
  expect(text).not.toContain('{"schemaVersion"');
  expect(text.endsWith('\n')).toBe(true);
});

it('keeps the legacy flat schemaVersion: 1 setup readable in the compatibility codec', () => {
  expect(jsonCodec.parse('schemaVersion: 1\r\n')).toEqual({ schemaVersion: 1 });
});
