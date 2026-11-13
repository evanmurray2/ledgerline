// The engine's thread (copy/host.ts): a thread that fails to start must end the wait, not leave the app on
// "One moment…".
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {}
}
vi.stubGlobal('Worker', FakeWorker);
const { EngineHost, ENGINE_FAILED } = await import('../src/copy/host');

afterEach(() => vi.restoreAllMocks());

describe('EngineHost', () => {
  it('fails the waiting call and every later one when the thread fails to start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = new EngineHost();
    const waiting = host.state();
    const e = new Event('error', { cancelable: true });
    FakeWorker.last.onerror!(e);
    await expect(waiting).rejects.toThrow(ENGINE_FAILED);
    await expect(host.rta()).rejects.toThrow(ENGINE_FAILED);
    expect(e.defaultPrevented).toBe(true);
    expect(FakeWorker.last.posted).toHaveLength(1);
  });

  it('fails the waiting call when a message can not be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host = new EngineHost();
    const waiting = host.state();
    FakeWorker.last.onmessageerror!();
    await expect(waiting).rejects.toThrow(ENGINE_FAILED);
  });

  it('still answers calls from a thread that runs', async () => {
    const host = new EngineHost();
    const waiting = host.state();
    FakeWorker.last.onmessage!({ data: { id: 1, ok: true, value: { through: 3 } } } as MessageEvent);
    await expect(waiting).resolves.toEqual({ through: 3 });
  });
});
