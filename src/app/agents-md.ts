import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from '../domain/errors.js';

const BEGIN = '<!-- apos:begin (managed by `apos init`; edits inside are replaced) -->';
const END = '<!-- apos:end -->';
const BEGIN_PREFIX = '<!-- apos:begin';

/** What every agent reads first: this project goes through APOS. Short, English like the skills. */
const AGENTS_BODY = [
  'This project uses APOS, the output-assurance layer: a change counts as done when the gate says so, not when an agent says so.',
  '',
  '- Every code change belongs to a Goal and follows the roles: PM writes the Goal, Lead plans and submits, Tester writes the acceptance tests, Worker writes the code, Reviewer blocks with a red test. Use the matching skill: `apos-pm`, `apos-lead`, `apos-tester`, `apos-worker`, `apos-reviewer`.',
  '- Investigating a bug (reading logs, reproducing, experiments on a scratch branch) needs no Goal. Fixing it does: open a small Goal with `apos bug open` (the Human approves it with `apos bug approve`) whose acceptance test reproduces the bug — red on the current code, locked, then green with the fix.',
  "- Restructuring code that has no tests needs a safety net first: a `characterize` Goal captures what the code does today (`apos goal create --kind characterize --covers <glob>`), then a `refactor` Goal (`--kind refactor --paths <glob>`) restructures only what is captured. Accepting a repo with no tests (`apos setup approve --baseline-missing`) is the Human's decision.",
  '- Upgrading a dependency or patching a security finding is a `maintenance` Goal: `apos maintenance open` (`--security <finding>` to name the finding the patch must remove, `--from-pr <n>` for a Dependabot pull request); the Human approves it with `apos maintenance approve`. It needs no criterion: the gate holds it to the base (no new failure, no new finding, only manifests, lockfiles and the declared paths).',
  '- Work is done only when `apos package submit` (or the integration gate) is green. "Done" in an agent message does not count.',
  '- Do not edit `.apos/`, locked tests or the test infrastructure.',
  '- Do not run Human commands: `goal approve|appetite|select`, `bug approve`, `maintenance approve`, `outcome close|revise|stop`, `gate confirm`, `gate run --base`, `blocker resolve`, `setup approve`, `exception approve --human`. Do not pass `--on-behalf` unless the Human has clearly said yes somewhere else.',
  '- `apos inbox` shows what is waiting for the Human. The setup is `.apos/project.yaml`; see APOS `docs/setup.md`.',
].join('\n');

const CLAUDE_BODY = '@AGENTS.md';

/** The line ending a file already uses; LF for a new or one-line file. */
function eolOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Put `body` between the APOS markers: replace an existing block (and only it), or append one at the
 * end. Text outside the markers is kept byte for byte. Unbalanced markers are refused, not guessed at.
 */
export function upsertBlock(text: string, body: string): string {
  const eol = eolOf(text);
  const block = [BEGIN, ...body.split('\n'), END].join(eol);
  const begin = text.indexOf(BEGIN_PREFIX);
  const end = text.indexOf(END);
  if (begin === -1 && end === -1) {
    if (text === '') return block + eol;
    const lead = text.endsWith('\n') ? '' : eol;
    return `${text}${lead}${eol}${block}${eol}`;
  }
  if (begin === -1 || end < begin)
    throw new UserError(`unbalanced apos:begin / apos:end markers; fix or remove them, then run init again`);
  return text.slice(0, begin) + block + text.slice(end + END.length);
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Teach the project's agents that it uses APOS: a managed block in `AGENTS.md`, and a `CLAUDE.md`
 * that imports it. Returns the real paths of the files it changed.
 */
export function writeAgentFiles(repo: string): string[] {
  const changed: string[] = [];
  const put = (path: string, next: (text: string) => string) => {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const updated = next(text);
    if (updated !== text) {
      writeFileSync(path, updated, 'utf8');
      changed.push(realpathSync(path)); // a symlink writes its target, which is what changed
    }
  };
  const agents = join(repo, 'AGENTS.md');
  const claude = join(repo, 'CLAUDE.md');
  put(agents, text => upsertBlock(text, AGENTS_BODY));
  // A CLAUDE.md that is the same file as AGENTS.md (a symlink) already has the block.
  if (existsSync(claude) && sameFile(claude, agents)) return changed;
  put(claude, text => {
    if (text === '') return `${CLAUDE_BODY}\n`;
    if (/^[ \t]*@(\.\/)?AGENTS\.md[ \t]*\r?$/m.test(text)) return text;
    return upsertBlock(text, CLAUDE_BODY);
  });
  return changed;
}
