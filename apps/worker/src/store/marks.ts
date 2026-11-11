// Marks on a budget (docs/privacy.md section 8, step 3; table `store_mark`, a store migration). Every old code path
// asks here before it touches a budget:
//   sealed: the budget lives in the sealed log. Routes, alarms and webhooks leave it alone.
//   frozen: the budget is being moved. Every write and every job is refused; reads go on. A freeze has a time
//           limit (`until`), after which the budget counts as not frozen, untouched.
// This ships well before any budget is marked, so that a later automatic code rollback lands on code that obeys
// the marks.

export interface Marks {
  sealed: boolean;
  /** When the freeze ends, or null when the budget isn't frozen. */
  frozenUntil: number | null;
}

/** The longest a freeze may last: a move that hasn't finished by then is given up, and the budget is as it was. */
export const MAX_FREEZE_MS = 15 * 60_000;

export function marksOf(sql: SqlStorage, now: number): Marks {
  const rows = sql.exec(`SELECT key, until FROM store_mark`).toArray();
  let sealed = false;
  let frozenUntil: number | null = null;
  for (const r of rows) {
    if (r.key === 'sealed') sealed = true;
    // A freeze with no limit is not a freeze: nothing may hold a budget for ever.
    if (r.key === 'frozen' && typeof r.until === 'number' && r.until > now) frozenUntil = r.until;
  }
  return { sealed, frozenUntil };
}

/** What a marked budget answers to a request it refuses, or null when the request may go on. */
export function refusal(m: Marks, method: string, path: string): { status: number; body: unknown } | null {
  const write = method !== 'GET' && method !== 'HEAD';
  // Plaid is told all is well, and nothing is done: a refusal would only make it send the same news again.
  if ((m.sealed || m.frozenUntil !== null) && path === '/api/webhooks/plaid')
    return { status: 200, body: { ok: true, held: true } };
  if (m.sealed)
    return {
      status: 409,
      body: { error: 'sealed', message: 'Update Ledgerline to continue.' },
    };
  if (m.frozenUntil !== null && write)
    return {
      status: 503,
      body: { error: 'frozen', message: 'Your budget is being moved. Try again in a few minutes.' },
    };
  return null;
}
