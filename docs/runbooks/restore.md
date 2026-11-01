# Monthly restore drill

Done by hand on your computer, once a month, into a local D1. The private backup key never leaves your machine or password manager. Backups are GitHub Actions artifacts of the **nightly** workflow, kept 90 days (decisions.md D-26).

1. Download the latest backup: Actions → nightly → the latest successful run → Artifacts → `backup` (or `gh run download <run id> -n backup`). Unzip it; it holds `ledgerline-<time>.sql.gpg` (passphrase) or `.sql.age` (age key), and `manifest.json`.
2. Check the encrypted file: `sha256sum ledgerline-*` must equal `sha256` in `manifest.json`.
3. Decrypt with your `BACKUP_PASSPHRASE`: `gpg -o backup.sql -d ledgerline-*.sql.gpg` (or `age -d -i ledgerline-backup.key -o backup.sql ledgerline-*.sql.age`). `sha256sum backup.sql` must equal `plaintextSha256`.
4. Restore into a throwaway local database (from `apps/worker`):
   ```sh
   rm -rf .wrangler/state
   pnpm exec wrangler d1 execute DB --local --file backup.sql
   ```
5. Spot-check: run `wrangler dev` with `DEV_AUTH_EMAIL` set (and `PLAID_ENV=sandbox`), open the app, and compare Ready to Assign and account balances with production.
6. Delete `backup.sql`, the downloaded files and the local state.

For recent mistakes, D1 Time Travel restores any minute in the last 7 days (free plan) without a backup: `wrangler d1 time-travel restore ledgerline --timestamp=<ISO time>`.

To restore production itself from a backup, create a new D1 database, run `wrangler d1 execute <new db> --remote --file backup.sql`, point `wrangler.jsonc` at it and deploy.
