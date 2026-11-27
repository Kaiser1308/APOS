import { parseXml, type XmlElement } from './xml-lite.js';
import { unreadable, type ParsedReport, type TestOutcome } from './types.js';

const walk = (
  element: XmlElement,
  visit: (node: XmlElement, suite: XmlElement | undefined) => void,
  suite?: XmlElement,
) => {
  for (const child of element.children) {
    if (child.name === 'testcase') visit(child, suite);
    else walk(child, visit, child.name === 'testsuite' ? child : suite);
  }
};

function outcome(node: XmlElement): Pick<TestOutcome, 'status' | 'message' | 'failureType'> {
  const failing = node.children.find(child => child.name === 'error' || child.name === 'failure');
  if (failing) {
    const summary = failing.attrs.message?.trim();
    const detail = failing.text.trim();
    const message = summary === 'Failed' && detail ? detail : summary || detail;
    const failureType = failing.attrs.type?.trim();
    return {
      status: failing.name === 'error' ? 'error' : 'fail',
      ...(message ? { message } : {}),
      ...(failureType ? { failureType } : {}),
    };
  }
  if (node.children.some(child => child.name === 'skipped')) return { status: 'skip' };
  return { status: 'pass' };
}

/**
 * JUnit XML as written by vitest, jest-junit, pytest, Gradle and Surefire. A test id is
 * `<classname>::<name>`, or `<file or suite name>::<name>` when there is no classname; the same id twice
 * in one report gets `#2`, `#3` ... in report order so that ids stay stable between runs.
 * `<error>` is status `error`, `<failure>` is `fail`.
 */
const slashes = (text: string): string => text.replaceAll('\\', '/');

export function readJunit(content: string): ParsedReport {
  let root: XmlElement;
  try {
    root = parseXml(content);
  } catch (error) {
    return unreadable(`junit report is not valid XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (root.name !== 'testsuites' && root.name !== 'testsuite')
    return unreadable(`junit report root is <${root.name}>, expected <testsuites> or <testsuite>`);
  const tests: TestOutcome[] = [];
  const seen = new Map<string, number>();
  const visit = (node: XmlElement, suite: XmlElement | undefined) => {
    const name = node.attrs.name;
    if (name === undefined) return;
    // A path used as an id must read the same on Windows and Linux.
    const prefix = slashes(node.attrs.classname || node.attrs.file || suite?.attrs.name || 'suite');
    const base = `${prefix}::${name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    tests.push({
      id: count === 1 ? base : `${base}#${count}`,
      ...outcome(node),
      ...(node.attrs.file ? { file: slashes(node.attrs.file) } : {}),
    });
  };
  if (root.name === 'testsuite') walkSuite(root, visit);
  else walk(root, visit);
  return { kind: 'tests', tests };
}

function walkSuite(suite: XmlElement, visit: (node: XmlElement, suite: XmlElement | undefined) => void) {
  walk({ ...suite, name: 'testsuites' }, visit, suite);
}
