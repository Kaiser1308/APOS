import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandTree, GLOBAL_FLAGS, matchCommand } from './cli-docs.test-support.js';

const tree = commandTree();
const readme = readFileSync('README.md', 'utf8').replace(/\r\n/g, '\n');

/** The code spans of the first column of the README's CLI reference. */
function readmeCommands(): string[] {
  const section = readme.split('## CLI reference')[1]!.split(/\n## /)[0]!;
  return section
    .split('\n')
    .filter(line => line.startsWith('| `'))
    .flatMap(line => {
      const cell = line.slice(1).split(/ \| /)[0]!;
      return [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1]!.replaceAll('\\|', '|'));
    });
}

/** `goal approve <id> --size <S|M|L> [--overrun <x>]` → the command path and the long flags that span names. */
function parseSpan(span: string, tool = 'apos') {
  const words = span
    .replace(new RegExp(`^${tool}\\s+`), '')
    .replace(/^--repo <[^>]+>\s+/, '')
    .split(/\s+/);
  const path: string[] = [];
  for (const word of words) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    path.push(word);
  }
  return { path: matchCommand(path, tree), flags: [...span.matchAll(/--[a-z][a-z-]*/g)].map(match => match[0]) };
}

describe('README CLI reference', () => {
  const spans = readmeCommands();

  it('lists only commands that exist, with flags that exist', () => {
    const problems: string[] = [];
    for (const span of spans) {
      const { path, flags } = parseSpan(span);
      if (!path) {
        problems.push(`${span}: no such command`);
        continue;
      }
      for (const flag of flags)
        if (!tree.get(path)!.flags.has(flag) && !GLOBAL_FLAGS.has(flag))
          problems.push(`${span}: ${path} has no ${flag}`);
    }
    expect(problems).toEqual([]);
  });

  it('lists every command, and every flag of it', () => {
    const documented = new Map<string, Set<string>>();
    for (const span of spans) {
      const { path, flags } = parseSpan(span);
      if (path) documented.set(path, new Set([...(documented.get(path) ?? []), ...flags]));
    }
    const problems: string[] = [];
    for (const [path, info] of tree) {
      const isGroup = [...tree.keys()].some(other => other.startsWith(`${path} `));
      if (isGroup) continue;
      const flags = documented.get(path);
      if (!flags) {
        problems.push(`${path}: not in the README`);
        continue;
      }
      for (const flag of info.flags)
        if (!flags.has(flag) && !GLOBAL_FLAGS.has(flag)) problems.push(`${path}: README lacks ${flag}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('skills', () => {
  const files = [
    ...readdirSync('skills').map(name => join('skills', name, 'SKILL.md')),
    ...readdirSync(join('.apos', 'skills'), { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.md'))
      .map(name => join('.apos', 'skills', name)),
  ].filter(existsSync);

  it('only mention apos commands that exist', () => {
    const problems: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      for (const [, span] of text.matchAll(/`apos ([^`.]+)`/g)) {
        const { path, flags } = parseSpan(span!, '');
        if (!path) {
          problems.push(`${file}: \`apos ${span}\` is not a command`);
          continue;
        }
        for (const flag of flags)
          if (!tree.get(path)!.flags.has(flag) && !GLOBAL_FLAGS.has(flag))
            problems.push(`${file}: \`apos ${span}\`: ${path} has no ${flag}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('are found at all', () => expect(files.length).toBeGreaterThanOrEqual(10));
});
