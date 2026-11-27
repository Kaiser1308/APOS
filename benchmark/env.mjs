import { realpathSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Do not inherit Node dependency directories or relative paths from the caller. */
export function isolatedPath(path) {
  return (path ?? '')
    .split(delimiter)
    .filter(entry => {
      if (!isAbsolute(entry)) return false;
      let resolved = entry;
      try {
        resolved = realpathSync(entry);
      } catch {
        // A nonexistent entry is still checked by name.
      }
      return ![entry, resolved].some(value => /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(value));
    })
    .join(delimiter);
}

export function gitEnvironment(source) {
  const env = Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_PATH' && key !== 'NODE_OPTIONS'),
  );
  return { ...env, PATH: isolatedPath(env.PATH) };
}

export function gitState(root, source = process.env) {
  const env = gitEnvironment(source);
  const read = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
  return { aposCommit: read('rev-parse', 'HEAD'), dirty: Boolean(read('status', '--porcelain')) };
}
