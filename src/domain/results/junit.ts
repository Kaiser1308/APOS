import { unreadable, type ParsedReport } from './types.js';

/** Pending: the JUnit reader waits on the decision about an XML parser. */
export function readJunit(content: string): ParsedReport {
  return unreadable(content ? 'junit reader pending' : 'junit report is empty');
}
