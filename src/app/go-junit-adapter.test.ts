import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readJunit } from '../domain/results/junit.js';

const available = spawnSync('go', ['version']).status === 0 && spawnSync('gotestsum', ['--version']).status === 0;

it.skipIf(!available || process.platform === 'win32')(
  'refuses a test source that is a symlink outside the checkout',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'apos-go-outside-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(outside, 'target.go'), 'package demo\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n');
      symlinkSync(join(outside, 'target.go'), join(dir, 'linked_test.go'));
      const report = join(dir, 'report.xml');
      const result = spawnSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report], {
        cwd: dir,
        env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(report)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'preserves actual Go failure diagnostics for not-implemented classification',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-red-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(
        join(dir, 'calc_test.go'),
        'package demo\nimport "testing"\nfunc TestAdd(t *testing.T) { t.Fatal("not implemented") }\n',
      );
      const report = join(dir, 'report.xml');
      const result = spawnSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report], {
        cwd: dir,
        env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: [{ id: 'calc_test.go::TestAdd', status: 'fail', message: expect.stringContaining('not implemented') }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'keeps same-named tests in distinct Go packages tied to their own files',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-packages-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'root_test.go'), 'package demo\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n');
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub/add_test.go'), 'package sub\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n');
      const report = join(dir, 'report.xml');
      const run = (...args: string[]) =>
        execFileSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report, ...args], {
          cwd: dir,
          env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
          encoding: 'utf8',
        });
      run();
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: expect.arrayContaining([
          expect.objectContaining({ id: 'root_test.go::TestAdd' }),
          expect.objectContaining({ id: 'sub/add_test.go::TestAdd' }),
        ]),
      });
      run('--file', 'sub/add_test.go', '--test', 'TestAdd');
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: [{ id: 'sub/add_test.go::TestAdd' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'does not invent a test when the requested test is absent',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-unmapped-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'calc_test.go'), 'package demo\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n');
      const report = join(dir, 'report.xml');
      const result = spawnSync(
        'go',
        [
          'run',
          resolve('scripts/go-junit/main.go'),
          '--report',
          report,
          '--file',
          'calc_test.go',
          '--test',
          'TestAbsent',
        ],
        { cwd: dir, env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' }, encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(report)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'maps real Go JUnit tests to their source file',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-adapter-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'calc_test.go'), 'package demo\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n');
      const report = join(dir, 'report.xml');
      execFileSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report], {
        cwd: dir,
        env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
        encoding: 'utf8',
      });
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: [{ id: 'calc_test.go::TestAdd', file: 'calc_test.go', status: 'pass' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available || process.platform === 'win32')(
  'fails without gotestsum rather than emitting a report',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-missing-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'calc_test.go'), 'package demo\nimport "testing"\nfunc TestAdd(t *testing.T) {}\n');
      const go = execFileSync('which', ['go'], { encoding: 'utf8' }).trim();
      const bin = mkdtempSync(join(dir, 'bin-'));
      symlinkSync(go, join(bin, 'go'));
      const report = join(dir, 'report.xml');
      const result = spawnSync(go, ['run', resolve('scripts/go-junit/main.go'), '--report', report], {
        cwd: dir,
        env: { ...process.env, PATH: bin, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('gotestsum');
      expect(() => readFileSync(report)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'refuses a build failure even if the package declares TestMain',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-build-fail-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(
        join(dir, 'calc_test.go'),
        'package demo\nimport "testing"\nfunc TestMain(m *testing.M) {}\nfunc TestBroken(t *testing.T) { missingSymbol() }\n',
      );
      const report = join(dir, 'report.xml');
      const result = spawnSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report], {
        cwd: dir,
        env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(report)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'maps external packages and subtests and can run one subtest alone',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-external-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'calc.go'), 'package demo\nfunc Add(a, b int) int { return a + b }\n');
      writeFileSync(
        join(dir, 'external_test.go'),
        'package demo_test\nimport "testing"\nfunc TestTable(t *testing.T) { t.Run("one", func(t *testing.T) {}); t.Run("two", func(t *testing.T) {}) }\n',
      );
      const report = join(dir, 'report.xml');
      const run = (...args: string[]) =>
        execFileSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report, ...args], {
          cwd: dir,
          env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
          encoding: 'utf8',
        });
      run();
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: expect.arrayContaining([
          { id: 'external_test.go::TestTable/one', file: 'external_test.go', status: 'pass' },
        ]),
      });
      run('--file', 'external_test.go', '--test', 'TestTable/one');
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: [{ id: 'external_test.go::TestTable/one', file: 'external_test.go', status: 'pass' }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(!available)(
  'uses only files selected by Go build tags and refuses ambiguous tests',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'apos-go-tags-'));
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
      writeFileSync(join(dir, 'calc.go'), 'package demo\n');
      writeFileSync(join(dir, 'active_test.go'), 'package demo\nimport "testing"\nfunc TestSame(t *testing.T) {}\n');
      writeFileSync(
        join(dir, 'inactive_test.go'),
        '//go:build apos_never\n\npackage demo\nimport "testing"\nfunc TestSame(t *testing.T) {}\n',
      );
      const report = join(dir, 'report.xml');
      const run = () =>
        spawnSync('go', ['run', resolve('scripts/go-junit/main.go'), '--report', report], {
          cwd: dir,
          env: { ...process.env, GOPROXY: 'off', GOTOOLCHAIN: 'local' },
          encoding: 'utf8',
        });
      expect(run().status).toBe(0);
      expect(readJunit(readFileSync(report, 'utf8'))).toMatchObject({
        kind: 'tests',
        tests: [{ id: 'active_test.go::TestSame' }],
      });
      rmSync(report);
      writeFileSync(
        join(dir, 'external_test.go'),
        'package demo_test\nimport "testing"\nfunc TestSame(t *testing.T) {}\n',
      );
      const ambiguous = run();
      expect(ambiguous.status).not.toBe(0);
      expect(ambiguous.stderr).toMatch(/cannot uniquely map/);
      expect(() => readFileSync(report)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
