import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const parsedGo = z.object({ package: z.string().min(1), imports: z.array(z.string()) });
const parser = fileURLToPath(new URL('../../scripts/go-junit/main.go', import.meta.url));

function parseGo(text: string) {
  const result = execFileSync('go', ['run', parser, '--imports'], {
    input: text,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return parsedGo.parse(JSON.parse(result));
}

export function checkGoEntries(input: {
  file: string;
  partRoot: string;
  files: string[];
  module: string;
  text: string;
  allowed: (path: string) => boolean;
  read?: (path: string) => string | undefined;
}): string[] {
  const fail = (reason: string) => [`${input.file}: cannot check Go imports: ${reason}`];
  const root = input.partRoot === '.' ? '' : `${input.partRoot}/`;
  const ancestors = [''];
  for (const segment of root.split('/').filter(Boolean))
    ancestors.push(`${ancestors[ancestors.length - 1]}${segment}/`);
  if (ancestors.some(prefix => input.files.includes(`${prefix}go.work`))) return fail('Go workspace is not supported');
  if (input.files.some(file => file.startsWith(root) && file.endsWith('/go.mod') && file !== `${root}go.mod`))
    return fail('nested Go modules are not supported');
  if (/^\s*replace\b/m.test(input.module)) return fail('go.mod contains replace directives');
  const module = /^\s*module\s+([^\s"`]+)\s*(?:\/\/.*)?$/m.exec(input.module)?.[1];
  if (!module) return fail('cannot read a simple module path from go.mod');
  let parsed: z.infer<typeof parsedGo>;
  try {
    parsed = parseGo(input.text);
  } catch {
    return fail('Go parser unavailable or test file cannot be parsed');
  }
  if (parsed.imports.includes('unsafe') || parsed.imports.includes('C') || /^\s*\/\/go:linkname\b/m.test(input.text))
    return fail('unsafe, cgo and go:linkname are not supported');
  const dir = input.file.includes('/') ? input.file.slice(0, input.file.lastIndexOf('/') + 1) : '';
  const local = input.files.filter(
    file =>
      file.startsWith(dir) &&
      !file.slice(dir.length).includes('/') &&
      file.endsWith('.go') &&
      !file.endsWith('_test.go'),
  );
  for (const file of local) {
    const text = input.read?.(file);
    if (text === undefined) return fail(`cannot read ${file}`);
    try {
      if (parseGo(text).package === parsed.package && !input.allowed(file))
        return [`${input.file}: same-package test can access undeclared ${file}`];
    } catch {
      return fail(`cannot parse ${file}`);
    }
  }
  const problems: string[] = [];
  for (const path of parsed.imports) {
    if (path !== module && !path.startsWith(`${module}/`)) continue;
    const suffix = path === module ? '' : path.slice(module.length + 1);
    if (suffix && suffix.split('/').some(part => !part || part === '.' || part === '..'))
      return fail(`invalid local import ${path}`);
    const prefix = `${root}${suffix}${suffix ? '/' : ''}`;
    const nested = input.files.some(file => file === `${prefix}go.mod` && file !== `${root}go.mod`);
    if (nested) return fail(`nested module at ${prefix}go.mod`);
    const targets = input.files.filter(
      file =>
        file.startsWith(prefix) &&
        !file.slice(prefix.length).includes('/') &&
        file.endsWith('.go') &&
        !file.endsWith('_test.go'),
    );
    if (!targets.length) return fail(`cannot resolve local import ${path}`);
    for (const file of targets)
      if (!input.allowed(file)) problems.push(`${input.file}: imports "${path}" with undeclared file ${file}`);
  }
  return problems;
}
