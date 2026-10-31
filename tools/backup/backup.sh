#!/usr/bin/env bash
# Nightly encrypted backup (design: Backups). Exports production D1, encrypts to an age PUBLIC key (the private key
# never touches GitHub), uploads to R2 with a manifest, then reads the manifest back and checks it.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${BACKUP_AGE_RECIPIENT:?}"
cd "$(dirname "$0")/../../apps/worker"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
pnpm exec wrangler d1 export ledgerline --remote --output "$work/dump.sql" >/dev/null
rows=$(grep -c '^INSERT' "$work/dump.sql" || true)
plain_sha=$(sha256sum "$work/dump.sql" | cut -d' ' -f1)
age -r "$BACKUP_AGE_RECIPIENT" -o "$work/dump.sql.age" "$work/dump.sql"
rm "$work/dump.sql"
bytes=$(stat -c %s "$work/dump.sql.age")
enc_sha=$(sha256sum "$work/dump.sql.age" | cut -d' ' -f1)
key="backups/$stamp.sql.age"
pnpm exec wrangler r2 object put "ledgerline-backups/$key" --file "$work/dump.sql.age" --remote >/dev/null
cat > "$work/manifest.json" <<JSON
{"finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","file":"$key","bytes":$bytes,"sha256":"$enc_sha","plaintextSha256":"$plain_sha","rows":$rows}
JSON
pnpm exec wrangler r2 object put "ledgerline-backups/manifests/$stamp.json" --file "$work/manifest.json" --remote >/dev/null
pnpm exec wrangler r2 object put "ledgerline-backups/manifests/latest.json" --file "$work/manifest.json" --remote >/dev/null
# Check: the uploaded object matches the manifest.
pnpm exec wrangler r2 object get "ledgerline-backups/$key" --file "$work/check.age" --remote >/dev/null
test "$(sha256sum "$work/check.age" | cut -d' ' -f1)" = "$enc_sha"
test "$rows" -gt 0
echo "backup ok: $key, $bytes bytes, $rows rows"
