# D-81: No CSV history import, and no CSV or JSON data export (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "Yes remove the import, you can keep the full backup export for now",
in answer to removing CSV import and the CSV/JSON exports while keeping the full backup.

**Decision.**

1. **CSV history import is gone** (`POST /api/import/csv`, the file reader and Settings' import form). It raised two
   Money-rules questions it couldn't answer: history that Plaid also sent counted twice in Reports and net worth, and
   card files that list purchases as positive amounts read them as credits. The design's "CSV import of past
   transactions" and "CSV/OFX import as a fallback provider" (`docs/design.md`) are dropped with it.
2. **The Transactions (CSV) and Everything (JSON) exports are gone** (`GET /api/export/csv`, `GET /api/export/json`).
3. **Kept:** the full backup (`GET /api/export/dump`), the only copy older than Cloudflare's 30-day point-in-time
   recovery (`docs/runbooks/restore.md`), and the Usage and notes export, which review sessions read
   (`docs/design.md`). The page is now Settings → Backup and export.
4. **Rows already imported stay.** A budget may hold 'csv' connections and `csv_…` bank rows from before. They are
   read as before (history before the budget start, never counted), and the code that reads them stays tested
   (`apps/worker/test/history.ts`).

**Money effect.** None: imported rows were history only, and nothing already stored changes.
