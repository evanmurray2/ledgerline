#!/usr/bin/env bash
# Nightly encrypted backup (design: Backups; decisions.md D-26: no R2). Exports production D1 and encrypts it to an
# age PUBLIC key (the private key never touches GitHub). The workflow then keeps the encrypted file as a GitHub
# Actions artifact for 90 days and reports the finished backup to the app. Writes the files into $OUT.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${BACKUP_AGE_RECIPIENT:?}" "${OUT:?}"
cd "$(dirname "$0")/../../apps/worker"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT"
pnpm exec wrangler d1 export ledgerline --remote --output "$work/dump.sql" >/dev/null
rows=$(grep -c '^INSERT' "$work/dump.sql" || true)
test "$rows" -gt 0
plain_sha=$(sha256sum "$work/dump.sql" | cut -d' ' -f1)
file="ledgerline-$stamp.sql.age"
age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT/$file" "$work/dump.sql"
rm "$work/dump.sql"
bytes=$(stat -c %s "$OUT/$file")
enc_sha=$(sha256sum "$OUT/$file" | cut -d' ' -f1)
cat > "$OUT/manifest.json" <<JSON
{"finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","file":"$file","bytes":$bytes,"sha256":"$enc_sha","plaintextSha256":"$plain_sha","rows":$rows}
JSON
echo "backup ok: $file, $bytes bytes, $rows rows"
