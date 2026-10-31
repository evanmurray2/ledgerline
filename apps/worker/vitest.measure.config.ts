import { defineConfig } from 'vitest/config';

// Go/no-go CPU harness: runs the Worker's step functions in Node against node:sqlite (see measure/README.md).
export default defineConfig({
  test: { include: ['measure/**/*.measure.ts'], environment: 'node', testTimeout: 600_000, pool: 'forks' },
});
