import { unreadable, parseJson, type ParsedReport } from './types.js';

/** JSON that is one number, or an object holding one at the dotted path `name` (e.g. `metrics.mutationScore`). */
export function readMetric(content: string, name?: string): ParsedReport {
  const json = parseJson(content);
  if (json === undefined) return unreadable('metric report is not valid JSON');
  let value: unknown = json;
  if (name) {
    for (const key of name.split('.')) {
      if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key))
        return unreadable(`metric "${name}" not found in the report`);
      value = (value as Record<string, unknown>)[key];
    }
  } else if (typeof value === 'object')
    return unreadable('metric report has no single number and no metric path was given');
  if (typeof value !== 'number' || !Number.isFinite(value))
    return unreadable(`metric "${name ?? 'value'}" is not a number`);
  return { kind: 'metric', name: name ?? 'value', value };
}
