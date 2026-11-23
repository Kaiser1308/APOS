import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogEntry } from '../domain/catalog.js';
import { LAYER_IDS } from '../domain/layers.js';
import { parseSetupObject, type PartSetup, type ProjectSetup } from '../domain/project-setup.js';
import { UserError } from '../domain/errors.js';

export type DraftOptions = { parts?: Record<string, { root: string; stack?: string }> };
export type Draft = { setup: ProjectSetup; notes: string[] };

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'vendor']);

/** Every `detect.files` entry is present and every `contains` substring is found. */
function matches(entry: CatalogEntry, dir: string): boolean {
  if (!entry.detect.files.every(file => existsSync(join(dir, file)))) return false;
  return Object.entries(entry.detect.contains ?? {}).every(([file, text]) => {
    try {
      return readFileSync(join(dir, file), 'utf8').includes(text);
    } catch {
      return false;
    }
  });
}

/** Some file a catalog entry looks for is there, though the entry does not match: a project we cannot name. */
function looksLikeProject(catalog: CatalogEntry[], dir: string): string[] {
  return catalog
    .filter(entry => entry.detect.files.some(file => existsSync(join(dir, file))))
    .map(entry => entry.stack);
}

function partFrom(entry: CatalogEntry, root: string): PartSetup {
  const layers: PartSetup['layers'] = {};
  for (const layer of LAYER_IDS) {
    const tools = layer === 'L6' ? [] : (entry.layers[layer] ?? []);
    const first = tools[0];
    // The first tool of a layer, and every tool a Goal flag switches on (mutation): it costs nothing until a Goal asks for it.
    if (first) layers[layer] = [first, ...tools.slice(1).filter(tool => tool.when && tool.when !== 'always')];
  }
  return {
    root,
    stack: entry.stack,
    layers,
    needsHuman: [...entry.needsHuman],
    forbid: [...entry.forbid],
    ...(entry.testPaths.length
      ? {
          tests: {
            paths: [...entry.testPaths],
            infra: [...entry.testInfra],
            assertPatterns: [...entry.assertPatterns],
            notImplementedPatterns: [...entry.notImplementedPatterns],
            loadErrorPatterns: [...entry.loadErrorPatterns],
            ...(entry.entryRule ? { entryRule: structuredClone(entry.entryRule) } : {}),
          },
        }
      : {}),
  };
}

const slug = (dir: string) => {
  const name = dir
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(name) ? name : `p-${name || 'part'}`;
};

/**
 * Drafts `.apos/project.yaml` for a repo: detects the stack of the root and of each directory one level
 * down, takes the first tool of each layer and the stack's strict floor. What it cannot name, it leaves
 * empty with a note; it never guesses a stack.
 */
export function draftSetup(repo: string, catalog: CatalogEntry[], opts: DraftOptions = {}): Draft {
  const notes: string[] = [];
  const parts: Record<string, PartSetup> = {};
  const byStack = (stack: string) => catalog.find(entry => entry.stack === stack);

  const addPart = (name: string, root: string, stack?: string) => {
    const dir = join(repo, root);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new UserError(`part "${name}": ${root} is not a directory in the repo`);
    let entry: CatalogEntry | undefined;
    if (stack) {
      entry = byStack(stack);
      if (!entry) throw new UserError(`part "${name}": the catalog has no stack "${stack}"`);
    } else {
      const found = catalog.filter(item => matches(item, dir));
      if (found.length === 1) entry = found[0];
      else if (found.length > 1)
        notes.push(
          `${name} (${root}): khớp nhiều stack (${found.map(item => item.stack).join(', ')}); chọn bằng --part ${name}=${root}:<stack>`,
        );
      else {
        const hint = looksLikeProject(catalog, dir);
        notes.push(
          `${name} (${root}): chưa nhận ra stack${hint.length ? ` (có file của ${hint.join(', ')} nhưng chưa đủ chắc)` : ''}; các lớp để trống`,
        );
      }
    }
    parts[name] = entry
      ? partFrom(entry, root)
      : { root, layers: {}, needsHuman: [], forbid: [], note: 'chưa nhận ra stack' };
  };

  if (opts.parts && Object.keys(opts.parts).length) {
    for (const [name, part] of Object.entries(opts.parts)) addPart(name, part.root, part.stack);
  } else {
    const rootMatches = catalog.filter(entry => matches(entry, repo));
    const children = readdirSync(repo, { withFileTypes: true })
      .filter(item => item.isDirectory() && !item.name.startsWith('.') && !SKIP_DIRS.has(item.name))
      .map(item => item.name)
      .sort()
      .filter(
        name =>
          catalog.some(entry => matches(entry, join(repo, name))) || looksLikeProject(catalog, join(repo, name)).length,
      );
    if (children.length) {
      if (rootMatches.length)
        notes.push(
          `thư mục gốc cũng khớp ${rootMatches.map(entry => entry.stack).join(', ')}; chỉ các thư mục con thành phần. Dùng --part nếu muốn khác`,
        );
      const used = new Set<string>();
      for (const child of children) {
        let name = slug(child);
        for (let n = 2; used.has(name); n++) name = `${slug(child)}-${n}`;
        used.add(name);
        addPart(name, child);
      }
    } else if (rootMatches.length || looksLikeProject(catalog, repo).length) addPart('app', '.');
    else
      notes.push(
        'chưa nhận ra stack nào ở thư mục gốc hay một cấp dưới; không tạo phần nào. Dùng --part <tên>=<thư mục>:<stack>',
      );
  }

  const setup = parseSetupObject({
    schemaVersion: 2,
    parts,
    floor: { submit: ['L0', 'L1', 'L2'], integrate: ['L1', 'L2', 'L3'], close: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] },
    mutation: { minScore: 70 },
  });
  if (setup.version !== 2) throw new UserError('draft produced no v2 setup');
  return { setup: setup.setup, notes };
}

/** `<name>=<dir>[:<stack>]`, as given to `apos setup draft --part`. */
export function parsePartFlag(text: string): { name: string; root: string; stack?: string } {
  const match = /^([^=]+)=(.+?)(?::([a-z][a-z0-9-]*))?$/.exec(text.trim());
  if (!match) throw new UserError(`--part expects <name>=<dir>[:<stack>], got "${text}"`);
  return { name: match[1]!.trim(), root: match[2]!.trim(), ...(match[3] ? { stack: match[3] } : {}) };
}
