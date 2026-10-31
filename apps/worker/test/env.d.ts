/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends GeneratedEnv {
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}
export type { Env };
