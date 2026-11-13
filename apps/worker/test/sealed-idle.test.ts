// A3 for a sealed budget (docs/privacy.md 5.5, 14.2; src/seal/fetch-job.ts): when nobody has opened the budget
// for 90 days, the backstop and the bank's news queue no fetch; the next request of a person starts them again.
import { describe, expect, it } from 'vitest';
import {
  fetchResting,
  IDLE_FETCH_MS,
  noteOpened,
  OPENED_EVERY_MS,
  sealedBackstopHandler,
  sealedFetchId,
  sealedWebhook,
} from '../src/seal/fetch-job.js';
import { T0 } from './log-writer.js';
import { LINK_A, LINK_B, world, type World } from './sealed-world.js';

const asked = (x: World) =>
  x.db
    .prepare(`SELECT id, fetch_requested AS f FROM bank_link ORDER BY id`)
    .all<{ id: string; f: number }>()
    .then((r) => r.results.map((l) => [l.id, l.f]));

describe('no fetching for a budget nobody opened for 90 days (A3)', () => {
  it('rests from 90 days after the last open, and starts again on the next one', async () => {
    await world(async (x) => {
      const queued: string[] = [];
      const enqueue = async (_k: string, o: { id?: string }) => (queued.push(String(o.id)), 'id');
      // Opened at the cutover; nothing since.
      x.sql(`INSERT INTO store_note (key, value) VALUES ('cutover_at', ?)`, T0);
      x.sql(`UPDATE bank_link SET last_fetched_at = ?`, T0);
      expect(await fetchResting(x.db, T0 + IDLE_FETCH_MS)).toBe(false);
      const away = T0 + IDLE_FETCH_MS + 3_600_000;
      expect(await fetchResting(x.db, away)).toBe(true);

      // The backstop queues no fetch and notes that fetching rests; the bank's news is only noted.
      await sealedBackstopHandler(x.d, enqueue)({} as never, away);
      expect(queued).toEqual([]);
      expect(
        await x.db.prepare(`SELECT value FROM store_note WHERE key = 'fetch_resting'`).first('value'),
      ).toBe(away);
      await sealedWebhook(
        x.d,
        enqueue,
        { type: 'sync_updates_available', providerItemId: `item-${LINK_A}`, code: '' } as never,
        away,
      );
      expect(queued).toEqual([]);
      expect(await asked(x)).toEqual([
        [LINK_A, 1],
        [LINK_B, 0],
      ]);

      // The person comes back: every link is asked for at once, and the backstop fetches again.
      const back = away + 86_400_000;
      expect(await noteOpened(x.db, back)).toBe(true);
      expect(await asked(x)).toEqual([
        [LINK_A, 1],
        [LINK_B, 1],
      ]);
      expect(await fetchResting(x.db, back)).toBe(false);
      await sealedBackstopHandler(x.d, enqueue)({} as never, back);
      expect(queued).toEqual([sealedFetchId(LINK_A), sealedFetchId(LINK_B)]);
      // Within the hour it is not written again; after it, the time moves.
      expect(await noteOpened(x.db, back + 60_000)).toBe(false);
      expect(await x.db.prepare(`SELECT value FROM store_note WHERE key = 'opened_at'`).first('value')).toBe(
        back,
      );
      expect(await noteOpened(x.db, back + OPENED_EVERY_MS + 1)).toBe(false);
      expect(await x.db.prepare(`SELECT value FROM store_note WHERE key = 'opened_at'`).first('value')).toBe(
        back + OPENED_EVERY_MS + 1,
      );
    });
  });
});
