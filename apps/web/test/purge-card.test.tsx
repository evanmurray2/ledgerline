// Settings → Privacy, the card that deletes the readable copy from before the lock (screens/settings/Purge.tsx),
// and the texts the Privacy screen shows at each stage; and the full backup of a locked budget, sealed with the
// recovery key on the device (keys/backup.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { newRecoveryKey, openBackup, showRecoveryKey } from '@ledgerline/seal';
import { makeQueryClient } from '../src/App';
import { resetRecentChanges } from '../src/api/client';
import type { PurgeView } from '../src/api/endpoints';
import { oldCopyText, pastVersionsText, PurgeCard } from '../src/screens/settings/Purge';
import { sealedBackupFile } from '../src/keys/backup';

const view = (o: Partial<PurgeView>): PurgeView => ({
  stage: 'ready',
  tables: 0,
  done: 0,
  rows: 0,
  startedAt: null,
  doneAt: null,
  checkAt: null,
  clean: null,
  ...o,
});
let posts: string[];

beforeEach(() => {
  posts = [];
  resetRecentChanges();
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(cleanup);

const show = (p: PurgeView | null) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <PurgeCard purge={p} />
    </QueryClientProvider>,
  );

describe('deleting the readable copy', () => {
  it('shows nothing while the way back is open', () => {
    show(view({ stage: 'waiting' }));
    expect(screen.queryByTestId('purge-card')).toBeNull();
    show(null);
    expect(screen.queryByTestId('purge-card')).toBeNull();
  });

  it('asks first, then starts on the server', async () => {
    show(view({ stage: 'ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete the readable copy…' }));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(posts).toEqual(['/api/cutover/purge']));
  });

  it('says how far it has come, and what the check found', () => {
    show(view({ stage: 'running', tables: 40, done: 12 }));
    expect(screen.getByRole('status').textContent).toContain('12 of 40');
    cleanup();
    show(view({ stage: 'checked', clean: true, checkAt: '2027-01-20T00:00:00Z' }));
    expect(screen.getByRole('status').textContent).toContain('nothing readable is left');
  });

  it('the Privacy screen says what is true at each stage', () => {
    expect(oldCopyText(null, '2026-11-19T22:24:00Z')).toContain('for the way back until');
    expect(oldCopyText(view({ stage: 'ready' }), null)).toContain('You can delete it below');
    expect(oldCopyText(view({ stage: 'running' }), null)).toBe('Being deleted now.');
    const done = view({ stage: 'done', doneAt: '2026-11-25T00:00:00Z', checkAt: '2026-12-26T00:00:00Z' });
    expect(oldCopyText(done, null)).toMatch(/^Deleted on /);
    expect(pastVersionsText(done)).toContain('some hold the readable copy');
    expect(pastVersionsText(view({ stage: 'checked', clean: true, checkAt: done.checkAt }))).toContain(
      'None holds the readable copy',
    );
    expect(pastVersionsText(null)).toContain('the older ones readable');
  });
});

describe('the full backup of a locked budget', () => {
  it('is sealed with the typed recovery key, and refuses a key with a slip', async () => {
    const r = newRecoveryKey();
    const shown = await showRecoveryKey(r);
    const plain = new TextEncoder().encode('SQLite format 3');
    const file = await sealedBackupFile(shown.toLowerCase(), plain);
    expect([...(await openBackup(r, file!))]).toEqual([...plain]);
    const slip = shown.slice(0, 3) + (shown[3] === 'A' ? 'B' : 'A') + shown.slice(4);
    expect(await sealedBackupFile(slip, plain)).toBeNull();
  });
});
