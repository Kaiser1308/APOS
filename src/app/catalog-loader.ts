import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogEntrySchema, type CatalogEntry } from '../domain/catalog.js';
import type { SetupCodec } from '../domain/setup-codec.js';

/** The catalog shipped with APOS (`catalog/` at the package root). */
export const BUNDLED_CATALOG = fileURLToPath(new URL('../../catalog', import.meta.url));

export type LoadedCatalog = { entries: CatalogEntry[]; warnings: string[] };

function readDir(dir: string, codec: SetupCodec, warnings: string[]): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  const entries: CatalogEntry[] = [];
  const names = readdirSync(dir)
    .filter(name => name.endsWith('.yaml') || name.endsWith('.json'))
    .sort((left, right) => {
      const leftYaml = left.endsWith('.yaml');
      const rightYaml = right.endsWith('.yaml');
      return leftYaml === rightYaml ? left.localeCompare(right) : leftYaml ? -1 : 1;
    });
  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = catalogEntrySchema.safeParse(codec.parse(readFileSync(path, 'utf8')));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        warnings.push(`${path}: skipped, ${issue?.path.join('.') || 'file'}: ${issue?.message}`);
      } else if (entries.some(entry => entry.stack === parsed.data.stack))
        warnings.push(`${path}: skipped, stack "${parsed.data.stack}" is already defined in ${dir}`);
      else entries.push(parsed.data);
    } catch (error) {
      warnings.push(
        `${path}: skipped, cannot be read (${error instanceof Error ? error.message.split('\n')[0] : error})`,
      );
    }
  }
  return entries;
}

/**
 * The bundled catalog, with files in `<home>/catalog` (default `~/.apos/catalog`) replacing the bundled
 * entry of the same stack and adding new stacks. A file that does not parse or does not match the schema
 * is skipped with a warning; one broken file never hides the others.
 */
export function loadCatalog(opts: { codec: SetupCodec; home?: string; bundled?: string }): LoadedCatalog {
  const warnings: string[] = [];
  const home = opts.home ?? process.env.APOS_HOME ?? join(homedir(), '.apos');
  const merged = readDir(opts.bundled ?? BUNDLED_CATALOG, opts.codec, warnings);
  for (const entry of readDir(join(home, 'catalog'), opts.codec, warnings)) {
    const at = merged.findIndex(item => item.stack === entry.stack);
    if (at === -1) merged.push(entry);
    else merged[at] = entry;
  }
  return { entries: merged, warnings };
}
