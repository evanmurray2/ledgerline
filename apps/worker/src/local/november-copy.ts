// Dev and tests only: a phone copy holding the prototype's November 2026, worked out by the real engine. The web
// app's mock API (apps/web/src/mock, VITE_MOCK=1) answers every screen and change from it, so the mock tests run the
// same routes and Money rules as production instead of a stand-in. Never imported by a production build.
import initSqlJs from 'sql.js';
import { LocalEngine, migrateLocal, type EngineIdentity } from './engine.js';
import { SqlJsDb } from './sqljs-db.js';
import { seedNovember } from '../dev-seed.js';

export const NOVEMBER_WHO: EngineIdentity = {
  budgetId: 'b_mock',
  userId: 'u_mock',
  email: 'you@example.com',
};

/** A fresh November copy. `now` is the clock the engine and the routes use (the mock's Nov 14, 2026). */
export async function novemberCopy(
  now: () => number,
  locateFile?: (file: string) => string,
): Promise<{ engine: LocalEngine; db: SqlJsDb }> {
  const SQL = await initSqlJs(locateFile ? { locateFile } : undefined);
  const db = new SqlJsDb(new SQL.Database());
  await migrateLocal(db, now());
  await seedNovember(db, NOVEMBER_WHO.budgetId, NOVEMBER_WHO.userId, now());
  await db
    .prepare(
      `INSERT INTO local_state (key, value) VALUES ('derive', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify({ full: true, keys: [], fromMonth: null }))
    .run();
  const engine = new LocalEngine(db, NOVEMBER_WHO, now);
  await engine.derive();
  return { engine, db };
}
