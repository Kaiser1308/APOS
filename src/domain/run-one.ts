/** Splits a test id `<classname>::<name>` at the first `::`; an id with no `::` is all name. */
export function splitTestId(id: string): { classname: string; name: string } {
  const at = id.indexOf('::');
  return at === -1 ? { classname: '', name: id } : { classname: id.slice(0, at), name: id.slice(at + 2) };
}

export const PLACEHOLDERS = ['id', 'classname', 'name', 'file', 'within'] as const;
export const MODIFIERS = ['regex', 'spaced', 'noparens'] as const;
/** `{name}`, `{name|regex}`, `{name|spaced|regex}`: a placeholder and the modifiers applied to it, left to right. */
export const PLACEHOLDER = /\{(id|classname|name|file|within)((?:\|[a-z]+)*)\}/g;

const apply: Record<(typeof MODIFIERS)[number], (value: string) => string> = {
  regex: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  spaced: value => value.replaceAll(' > ', ' '),
  noparens: value => value.replace(/\([^)]*\)$/, ''),
};

/** The class segments that sit between the file's module path and the test name, as `Class::Inner::`, or ''. */
export function within(classname: string, file: string | undefined): string {
  if (!file) return '';
  const module = file.replace(/\.[^./]+$/, '').replaceAll('/', '.');
  if (!classname.startsWith(`${module}.`)) return '';
  return `${classname
    .slice(module.length + 1)
    .split('.')
    .join('::')}::`;
}

/** Whether a runOne template uses only known modifiers and at least one placeholder. */
export function runOneProblem(template: string): string | undefined {
  for (const [, , chain] of template.matchAll(PLACEHOLDER))
    for (const modifier of chain!.split('|').filter(Boolean))
      if (!(MODIFIERS as readonly string[]).includes(modifier)) return `unknown modifier |${modifier}`;
  const stray = [...template.matchAll(/\{([^}]*)\}/g)]
    .map(match => match[0])
    .filter(text => !text.startsWith('{report}') && !new RegExp(PLACEHOLDER.source).test(text));
  if (stray.length) return `unknown placeholder ${stray[0]}`;
  return new RegExp(PLACEHOLDER.source).test(template) ? undefined : 'needs a placeholder such as {id} or {name}';
}

/**
 * Puts one test into a `runOne` template. After the modifiers, values are escaped for a double-quoted shell
 * context: quotes, backslashes and (off Windows) `$` and backticks.
 */
export function fillRunOne(
  template: string,
  test: { id: string; file?: string },
  platform: string = process.platform,
): string {
  const quote = (value: string) =>
    platform === 'win32' ? value.replaceAll('"', '\\"') : value.replace(/["\\$`]/g, '\\$&');
  const { classname, name } = splitTestId(test.id);
  const values: Record<(typeof PLACEHOLDERS)[number], string> = {
    id: test.id,
    classname,
    name,
    file: test.file ?? '',
    within: within(classname, test.file),
  };
  return template.replace(new RegExp(PLACEHOLDER.source, 'g'), (_whole, key: keyof typeof values, chain: string) => {
    let value = values[key];
    for (const modifier of chain.split('|').filter(Boolean)) value = apply[modifier as keyof typeof apply](value);
    return quote(value);
  });
}
