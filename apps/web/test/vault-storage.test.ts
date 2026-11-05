// Reading the saved copy (vault.ts loadRecord): a moment when IndexedDB fails (iOS, after the app comes back from the
// background) is tried again, and a read that keeps failing is not "no saved copy", which would replace the copy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageUnavailable, loadRecord } from '../src/copy/vault';

/** An IndexedDB whose open fails `failures` times, then serves `rows`. */
function fakeIdb(failures: number, rows: Record<string, unknown>) {
  let opens = 0;
  const factory = {
    open() {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        opens++;
        if (opens <= failures) {
          req.error = new Error('Connection to Indexed Database server lost');
          (req.onerror as () => void)();
          return;
        }
        req.result = {
          close() {},
          transaction() {
            const t: Record<string, unknown> = {};
            return Object.assign(t, {
              objectStore: () => ({
                get(key: string) {
                  const r: Record<string, unknown> = {};
                  queueMicrotask(() => {
                    r.result = rows[key];
                    (t.oncomplete as () => void)();
                  });
                  return r;
                },
              }),
            });
          },
        };
        (req.onsuccess as () => void)();
      });
      return req;
    },
  };
  return { factory, opens: () => opens };
}

afterEach(() => vi.unstubAllGlobals());

describe('reading the saved copy', () => {
  it('tries again after a failed open and finds the copy', async () => {
    const f = fakeIdb(2, { k: { key: 'k' } });
    vi.stubGlobal('indexedDB', f.factory);
    expect(await loadRecord('k', [1, 1])).toEqual({ key: 'k' });
    expect(f.opens()).toBe(3);
  });

  it('says the storage failed, not that there is no copy', async () => {
    vi.stubGlobal('indexedDB', fakeIdb(5, { k: { key: 'k' } }).factory);
    await expect(loadRecord('k', [1, 1])).rejects.toBeInstanceOf(StorageUnavailable);
  });

  it('no copy is null', async () => {
    vi.stubGlobal('indexedDB', fakeIdb(0, {}).factory);
    expect(await loadRecord('k', [1, 1])).toBeNull();
  });
});
