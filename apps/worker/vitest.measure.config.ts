import { defineConfig } from 'vitest/config';

// CPU harness: runs the Worker's step functions in Node against node:sqlite (measure/harness.ts; how to run it and
// read the numbers: docs/measurements.md).
export default defineConfig({
  test: { include: ['measure/**/*.measure.ts'], environment: 'node', testTimeout: 600_000, pool: 'forks' },
});
