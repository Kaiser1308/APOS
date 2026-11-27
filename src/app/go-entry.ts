import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const parsedGo = z.object({ package: z.string().min(1), imports: z.array(z.string()), active: z.boolean() });
const parser = fileURLToPath(new URL('../../scripts/go-junit/main.go', import.meta.url));

function parseGo(text: string, file?: string) {
  const result = execFileSync('go', ['run', parser, '--imports', ...(file ? ['--filename', basename(file)] : [])], {
    input: text,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return parsedGo.parse(JSON.parse(result));
}

function uncertainToolchain(module: string): boolean {
  if (/^\s*toolchain\s+/m.test(module)) return true;
  const selected = process.env.GOTOOLCHAIN;
  if (selected && selected !== 'local' && selected !== 'auto') return true;
  const required = /^\s*go\s+(\d+)\.(\d+)(?:\.(\d+))?(?:\s|$)/m.exec(module);
  if (!required) return true;
  try {
    const version = execFileSync('go', ['env', 'GOVERSION'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const local = /^go(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
    if (!local) return true;
    for (let index = 1; index <= 3; index++) {
      const difference = Number(required[index] ?? 0) - Number(local[index] ?? 0);
      if (difference !== 0) return difference > 0;
    }
    return false;
  } catch {
    return true;
  }
}

export function checkGoEntries(input: {
  file: string;
  partRoot: string;
  files: string[];
  module: string;
  text: string;
  allowed: (path: string) => boolean;
  read?: (path: string) => string | undefined;
  isTestFile?: (path: string) => boolean;
  recordHelper?: (path: string) => void;
  /** Custom runner commands may use a different build context, so inspect all candidate files. */
  conservativeBuild?: boolean;
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
  const dir = input.file.includes('/') ? input.file.slice(0, input.file.lastIndexOf('/') + 1) : '';
  const conservativeBuild = input.conservativeBuild || uncertainToolchain(input.module);
  const parseCandidate = (text: string, file: string) => parseGo(text, conservativeBuild ? undefined : file);
  const sources = [{ file: input.file, text: input.text, parsed }];
  const visited = new Set([input.file]);
  const helpers = input.files.filter(
    file =>
      file !== input.file && file.startsWith(dir) && !file.slice(dir.length).includes('/') && file.endsWith('_test.go'),
  );
  for (const file of helpers) {
    const text = input.read?.(file);
    if (text === undefined) return fail(`cannot read ${file}`);
    try {
      const helper = parseCandidate(text, file);
      const sameBinary =
        helper.package === parsed.package ||
        helper.package === `${parsed.package}_test` ||
        `${helper.package}_test` === parsed.package;
      if (!helper.active || !sameBinary) continue;
      if (!input.allowed(file)) return fail(`test helper ${file} is outside allowed paths`);
      sources.push({ file, text, parsed: helper });
      visited.add(file);
      input.recordHelper?.(file);
    } catch {
      return fail(`cannot parse ${file}`);
    }
  }
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
      const source = parseCandidate(text, file);
      if (
        source.active &&
        sources.some(item => item.parsed.package === source.package || item.parsed.package === `${source.package}_test`)
      ) {
        if (!input.allowed(file)) return [`${input.file}: same-package test can access undeclared ${file}`];
        if (input.isTestFile?.(file)) {
          sources.push({ file, text, parsed: source });
          visited.add(file);
          input.recordHelper?.(file);
        }
      }
    } catch {
      return fail(`cannot parse ${file}`);
    }
  }
  const problems: string[] = [];
  for (const source of sources) {
    if (
      source.parsed.imports.includes('unsafe') ||
      source.parsed.imports.includes('C') ||
      /^\s*\/\/go:linkname\b/m.test(source.text)
    )
      return fail(`unsafe, cgo and go:linkname are not supported (${source.file})`);
    for (const path of source.parsed.imports) {
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
      for (const file of targets) {
        if (!input.allowed(file)) problems.push(`${source.file}: imports "${path}" with undeclared file ${file}`);
        else if (input.isTestFile?.(file) && !visited.has(file)) {
          const text = input.read?.(file);
          if (text === undefined) return fail(`cannot read ${file}`);
          try {
            const parsedFile = parseCandidate(text, file);
            if (!parsedFile.active) continue;
            sources.push({ file, text, parsed: parsedFile });
            visited.add(file);
            input.recordHelper?.(file);
          } catch {
            return fail(`cannot parse ${file}`);
          }
        }
      }
    }
  }
  return problems;
}
