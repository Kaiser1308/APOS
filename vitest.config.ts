import { defineConfig } from 'vitest/config';

// Git-subprocess tests (e.g. merge) can exceed the 5s default when the whole suite runs in parallel on Windows.
export default defineConfig({ test: { setupFiles: ['./src/test-setup.ts'], testTimeout: 20000 } });
