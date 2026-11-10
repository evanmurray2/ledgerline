import { describe, expect, it } from 'vitest';
import { type CheckResult, runDeviceChecks } from '../src/lib/device-check';

describe('the device check', () => {
  it('runs every check and all pass where WebCrypto has Ed25519 and X25519', async () => {
    const results: CheckResult[] = [];
    await runDeviceChecks((r) => results.push(r));
    expect(results.map((r) => r.name)).toEqual([
      'Signing keys (Ed25519)',
      'Sealing keys (X25519)',
      'Seal a bank page to a key (200 KB)',
      'Budget keys, and one signed, sealed entry',
      'Seal and open a snapshot (8 MB in 32 chunks)',
    ]);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.at(-1)!.note).toMatch(/^seal \d+ ms, open \d+ ms$/);
  });
});
