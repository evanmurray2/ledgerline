// The offline banner follows the server, not only the browser's online flag (iPhone Home Screen apps don't always
// fire 'online' when the connection comes back).
import { describe, expect, it } from 'vitest';
import { connectivity } from '../src/state/connectivity';

describe('connectivity', () => {
  it('a server answer clears "offline" even when the online event never came', () => {
    connectivity.setOnline(false);
    expect(connectivity.isOffline()).toBe(true);
    connectivity.reportOk();
    expect(connectivity.isOffline()).toBe(false);
    expect(connectivity.canWrite()).toBe(true);
  });

  it('a failed request still turns it on, and an answer turns it off', () => {
    connectivity.reportNetworkError();
    expect(connectivity.isOffline()).toBe(true);
    connectivity.reportOk();
    expect(connectivity.isOffline()).toBe(false);
  });
});
