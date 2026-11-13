// Marks on a budget (table `store_mark`, a store migration). `sealed`: the budget lives in its sealed log, and the
// store answers only the log's routes and the few account calls for it (store/budget-store.ts). Every budget is
// sealed from its first entry (D-102); one that is not has only its session, which tells the device to make it.

/** The budget lives in its sealed log. */
export function isSealed(sql: SqlStorage): boolean {
  return sql.exec(`SELECT 1 FROM store_mark WHERE key = 'sealed'`).toArray().length > 0;
}

/** What the store answers to a request no route of a locked budget takes. */
export function refusal(method: string, path: string): { status: number; body: unknown } {
  // Plaid is told all is well, and nothing is done: a refusal would only make it send the same news again.
  if (method === 'POST' && path === '/api/webhooks/plaid')
    return { status: 200, body: { ok: true, held: true } };
  // An app from before D-102 asks the old routes: it is told to update.
  return { status: 409, body: { error: 'sealed', message: 'Update Ledgerline to continue.' } };
}
