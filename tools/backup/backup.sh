#!/usr/bin/env bash
# Nightly encrypted backup (design: Backups; decisions.md D-26, D-28). Exports production D1 and encrypts it, either
# to an age PUBLIC key (BACKUP_AGE_RECIPIENT; the private key never touches GitHub) or with a passphrase
# (BACKUP_PASSPHRASE, AES-256 via gpg; for setup from a phone). The workflow then keeps the encrypted file as a
# GitHub Actions artifact for 90 days and reports the finished backup to the app. Writes the files into $OUT.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${OUT:?}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"
if [ -z "${BACKUP_AGE_RECIPIENT:-}" ] && [ "${#BACKUP_PASSPHRASE}" -lt 32 ]; then
  echo "Set BACKUP_AGE_RECIPIENT, or a BACKUP_PASSPHRASE of 32+ characters" >&2
  exit 1
fi
cd "$(dirname "$0")/../../apps/worker"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT"
pnpm exec wrangler d1 export ledgerline --remote --output "$work/dump.sql" >/dev/null
rows=$(grep -c '^INSERT' "$work/dump.sql" || true)
test "$rows" -gt 0
plain_sha=$(sha256sum "$work/dump.sql" | cut -d' ' -f1)
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  file="ledgerline-$stamp.sql.age"
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT/$file" "$work/dump.sql"
else
  file="ledgerline-$stamp.sql.gpg"
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
    --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 -o "$OUT/$file" "$work/dump.sql"
fi
rm "$work/dump.sql"
bytes=$(stat -c %s "$OUT/$file")
enc_sha=$(sha256sum "$OUT/$file" | cut -d' ' -f1)
cat > "$OUT/manifest.json" <<JSON
{"finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","file":"$file","bytes":$bytes,"sha256":"$enc_sha","plaintextSha256":"$plain_sha","rows":$rows}
JSON
echo "backup ok: $file, $bytes bytes, $rows rows"
