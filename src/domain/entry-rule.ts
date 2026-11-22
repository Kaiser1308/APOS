import { z } from 'zod';

const regexText = z.string().refine(value => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');

/**
 * How to see which module a test file imports and where that module lives, for one stack. Data from the catalog,
 * copied into the setup: the core knows no language, it only applies the rule.
 */
export const entryRuleSchema = z.object({
  /**
   * Regexes tried on each line of a test file; the first that matches says what the line imports: group 1 is the module
   * (several, comma-separated, for `import a, b`), the optional group 2 the names a `from <module> import <names>` takes,
   * which may be submodules. Anchored on the statement, so a comment or a sentence that says "from" matches nothing.
   */
  importPatterns: z.array(regexText).min(1),
  /** Modules that are libraries or the standard library: never judged. Regexes against the module text. */
  allowImports: z.array(regexText).default([]),
  /** What separates the parts of a module path in an import: `.` (Python) or `/` (TypeScript). */
  moduleSeparator: z.enum(['.', '/']),
  /** Files a module `a.b` (path `a/b`) may be, `{path}` standing for that path. */
  moduleFiles: z.array(z.string().min(1)).min(1),
  /** Removed from the end of an import before looking for the file (`.js` in `./calc.js`). */
  stripExtension: regexText.optional(),
});
export type EntryRule = z.infer<typeof entryRuleSchema>;

const dirname = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/** `a/b/../c` → `a/c`; a path that climbs out of the repo comes back undefined. */
function normalize(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** The repo-relative paths a module of `file` may live at (before adding the file endings of the rule). */
function modulePaths(rule: EntryRule, module: string, file: string, partRoot: string): string[] {
  const text = rule.stripExtension ? module.replace(new RegExp(rule.stripExtension), '') : module;
  const sep = rule.moduleSeparator;
  if (text.startsWith('.')) {
    if (sep === '/') {
      const path = normalize(`${dirname(file)}/${text}`);
      return path ? [path] : [];
    }
    // Python: one leading dot is this package, each further dot one level up.
    const dots = /^\.+/.exec(text)![0].length;
    let base = dirname(file);
    for (let up = 1; up < dots; up++) base = dirname(base);
    const rest = text.slice(dots).split('.').filter(Boolean).join('/');
    const path = normalize(`${base}/${rest}`);
    return path ? [path] : [];
  }
  const path = text.split(sep).filter(Boolean).join('/');
  const rooted = partRoot === '.' ? path : `${partRoot}/${path}`;
  return [...new Set([normalize(rooted), normalize(path)].filter((item): item is string => item !== undefined))];
}

/**
 * The imports of one test file that reach an internal module (one that exists in the repo) which is not a declared
 * entry or part of the tests. Each is `file:line: ...`. Libraries and the standard library never exist in the repo, so
 * they are not judged; `allowImports` also names modules that are never judged even if a repo file shadows them.
 */
export function entryViolations(input: {
  rule: EntryRule;
  file: string;
  text: string;
  partRoot: string;
  /** A file the test may import: a declared stub, or part of the tests. */
  allowed: (path: string) => boolean;
  exists: (path: string) => boolean;
}): string[] {
  const { rule } = input;
  const patterns = rule.importPatterns.map(item => new RegExp(item));
  const allow = rule.allowImports.map(item => new RegExp(item));
  const sep = rule.moduleSeparator;
  const problems: string[] = [];
  for (const [index, line] of input.text.split(/\r?\n/).entries()) {
    const match = patterns.map(item => item.exec(line)).find(item => item !== null);
    if (!match?.[1]) continue;
    const modules = match[1].split(',').map(item => item.replace(/\s+as\s+.*$/, '').trim());
    // `from pkg import name` may take a submodule of pkg: judge `pkg.name` too.
    const names = (match[2] ?? '')
      .replace(/[()]/g, '')
      .split(',')
      .map(item => item.replace(/\s+as\s+.*$/, '').trim())
      .filter(item => item && item !== '*');
    const asked = new Set(modules);
    for (const module of modules)
      for (const name of names) asked.add(module.endsWith(sep) ? `${module}${name}` : `${module}${sep}${name}`);
    for (const module of asked) {
      if (!module || allow.some(item => item.test(module))) continue;
      const files = modulePaths(rule, module, input.file, input.partRoot).flatMap(path =>
        rule.moduleFiles.map(template => template.replaceAll('{path}', path)),
      );
      const internal = files.filter(path => input.exists(path));
      if (!internal.length || internal.some(path => input.allowed(path))) continue;
      problems.push(
        `${input.file}:${index + 1}: imports "${module}" (${internal[0]}), an internal module that is not a declared entry: a test may call only the entries in stubPaths`,
      );
    }
  }
  return problems;
}
