/** Splits a test id `<classname>::<name>` at the first `::`; an id with no `::` is all name. */
export function splitTestId(id: string): { classname: string; name: string } {
  const at = id.indexOf('::');
  return at === -1 ? { classname: '', name: id } : { classname: id.slice(0, at), name: id.slice(at + 2) };
}

/**
 * Puts one test's id into a `runOne` template. The placeholders usually sit inside double quotes, so quotes,
 * backslashes and (off Windows) `$` and backticks are escaped for that context.
 */
export function fillRunOne(template: string, id: string, platform: string = process.platform): string {
  const escape = (value: string) =>
    platform === 'win32' ? value.replaceAll('"', '\\"') : value.replace(/["\\$`]/g, '\\$&');
  const { classname, name } = splitTestId(id);
  return template
    .replaceAll('{id}', escape(id))
    .replaceAll('{classname}', escape(classname))
    .replaceAll('{name}', escape(name));
}
