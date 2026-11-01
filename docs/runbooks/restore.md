# Recovery

There is no off-site backup (decisions.md D-29). Recovery uses what Cloudflare keeps for D1 on the free plan.

## Undo recent damage (last 7 days)

D1 Time Travel restores the production database to any minute in the last 7 days. From a computer, in `apps/worker`:

```sh
pnpm exec wrangler d1 time-travel info ledgerline                       # current bookmark
pnpm exec wrangler d1 time-travel restore ledgerline --timestamp=<ISO time before the damage>
```

A restore replaces the whole database, including everything after that time. Bank transactions after it come back on the next sync; your own edits after it are lost.

## A deleted database (within 7 days)

Use Cloudflare's D1 undelete API as soon as possible; requests for databases deleted more than 7 days ago fail.

## Your own copy

Settings → Import and export → **JSON export** downloads your budget (categories, assignments, transactions, rules, payees). Save it to Files or iCloud now and then: it is the only copy that survives losing the Cloudflare account or damage noticed after 7 days. Ledgerline can't yet re-import a JSON export into a new database; the file keeps your data readable until it can.
