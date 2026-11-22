const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** Glob with `*`, `?` and `**`, forward slashes only; enough for report locations and path scopes. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

const normal = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');

/** Whether `path` matches any of the globs (forward slashes, no leading `./`). */
export function matchesAny(path: string, patterns: string[]): boolean {
  const target = normal(path);
  return patterns.some(pattern => globToRegExp(normal(pattern)).test(target));
}

/** Two globs overlap when they are the same, or one matches the other read as a literal path. Coarse on purpose. */
export function globsOverlap(a: string, b: string): boolean {
  const [x, y] = [normal(a), normal(b)];
  return x === y || globToRegExp(x).test(y) || globToRegExp(y).test(x);
}
