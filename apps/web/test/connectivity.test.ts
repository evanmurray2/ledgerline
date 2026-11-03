// The offline banner follows the server, not only the browser's online flag (iPhone apps don't always fire
// 'online' when the connection comes back). The mock API answers inside the page, so it doesn't count.
import { describe, expect, it, vi } from 'vitest';

async function fresh(mock: '0' | '1') {
  vi.resetModules();
  vi.stubEnv('VITE_MOCK', mock);
  return (await import('../src/state/connectivity')).connectivity;
}

describe('connectivity', () => {
  it('a server answer clears "offline" even when the online event never came', async () => {
    const c = await fresh('0');
    c.setOnline(false);
    expect(c.isOffline()).toBe(true);
    c.reportOk();
    expect(c.isOffline()).toBe(false);
    expect(c.canWrite()).toBe(true);
  });

  it('a failed request turns it on, and an answer turns it off', async () => {
    const c = await fresh('0');
    c.reportNetworkError();
    expect(c.isOffline()).toBe(true);
    c.reportOk();
    expect(c.isOffline()).toBe(false);
  });

  it('the mock API answering is not proof of a connection', async () => {
    const c = await fresh('1');
    c.setOnline(false);
    c.reportOk();
    expect(c.isOffline()).toBe(true);
    vi.unstubAllEnvs();
  });
});
