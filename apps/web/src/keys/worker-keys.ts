// The Worker's public run-signing keys this release accepts, by key number (docs/privacy-keys.md 9.1). A device
// files a sealed bank run only when one of these signed it, so the list is part of the app, not something the
// server says at run time. `GET /api/run-keys` on the production Worker shows the public halves; a release copies
// them here. A key number is added here in a release BEFORE the Worker starts to use it, and is never taken off
// the list except after a compromise.
import { fromHex } from '@ledgerline/seal';

/**
 * Production's keys, read from `GET /api/run-keys` on Nov 12, 2026. They are public halves: no secret is here.
 */
const PRODUCTION: [number, string][] = [
  [1, '40b4ab6d7d4148004989ceb11a3424ecd0dae66e974fbafaa8f290edce99bb3b'],
];

/**
 * The e2e Worker's keys (`n:hex`, comma-separated), in an e2e build only (`pnpm --filter @ledgerline/web
 * build:e2e`, for e2e/playwright.lock.config.ts). Empty in every other build: vite.config.ts refuses a release
 * build with them, and scripts/check-dist.mjs fails a build that has them without asking for them.
 */
declare const __E2E_RUN_KEYS__: string | undefined;
const E2E: [number, string][] = (typeof __E2E_RUN_KEYS__ === 'string' ? __E2E_RUN_KEYS__ : '')
  .split(',')
  .filter(Boolean)
  .map((k): [number, string] => {
    const [n, pub] = k.split(':');
    return [Number(n), pub ?? ''];
  });

/** [key number, public key]: a sealed bank run is accepted only when one of these signed it. */
export const WORKER_RUN_KEYS: [number, Uint8Array][] = [...PRODUCTION, ...E2E].map(([n, pub]) => [
  n,
  fromHex(pub),
]);
