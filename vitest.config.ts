import { configDefaults, defineConfig } from 'vitest/config';

// Git-subprocess tests (e.g. merge) can exceed the 5s default when the whole suite runs in parallel on Windows.
// examples/ are repos for the demo Goals: they carry tests of their own that must be red at some steps.
export default defineConfig({
  test: {
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 20000,
    exclude: [...configDefaults.exclude, 'examples/**', 'benchmark/**'],
  },
});
