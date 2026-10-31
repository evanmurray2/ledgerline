# Monthly restore drill

Done by hand on your computer, once a month, into a local D1. The private backup key never leaves your machine or password manager.

1. Find the latest backup: `pnpm exec wrangler r2 object get ledgerline-backups/manifests/latest.json --remote --file manifest.json` and read `file`, `sha256`, `plaintextSha256` and `rows`.
2. Download it: `pnpm exec wrangler r2 object get ledgerline-backups/<file> --remote --file backup.sql.age`.
3. Check the encrypted file: `sha256sum backup.sql.age` must equal `sha256`.
4. Decrypt: `age -d -i ledgerline-backup.key -o backup.sql backup.sql.age`. `sha256sum backup.sql` must equal `plaintextSha256`.
5. Restore into a throwaway local database (from `apps/worker`):
   ```sh
   rm -rf .wrangler/state
   pnpm exec wrangler d1 execute DB --local --file backup.sql
   ```
6. Spot-check: run `wrangler dev` with `DEV_AUTH_EMAIL` set to the owner email (and `PLAID_ENV=sandbox`), open the app, and compare Ready to Assign and account balances with production.
7. Delete `backup.sql` and the local state.

For recent mistakes, D1 Time Travel restores any minute in the last 7 days without a backup: `wrangler d1 time-travel restore ledgerline --timestamp=<ISO time>`.
