// The ids a request gives its new rows. Ids are an input, like the clock (docs/privacy.md 5.3): an edit that carries
// an id of its own (`x-edit-id`: the phone's queue, and the engine on the phone) names its rows from that id, so the
// phone and the server give the same row the same id. A request with none gets random ids, as before.
import type { Context } from 'hono';
import { seededUlid, ulid } from '@ledgerline/platform';
import { editAt, requestNow } from './clock.js';
import type { AppEnv } from './context.js';

/** Edit ids from the phone's offline queue: kept 30 days (pruned by the daily maintenance job). */
export const EDIT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The time in an id made from an edit: when the person made the edit, as the phone sent it (2020 to 2100). */
function editIdTime(c: Context<AppEnv>): number {
  return editAt(c) ?? requestNow(c);
}

/** The next new id of this request. */
export function newId(c: Context<AppEnv>): string {
  let ids = c.get('ids');
  if (ids === undefined) {
    const id = c.req.header('x-edit-id');
    ids = id && EDIT_ID.test(id) ? { seed: id, n: 0, time: editIdTime(c) } : null;
    c.set('ids', ids);
  }
  return ids ? seededUlid(ids.time, ids.seed, ids.n++) : ulid(requestNow(c));
}
