// Writes the Worker's secrets for `wrangler deploy --secrets-file` from the GitHub environment's secrets, so setup
// needs no command line (decisions.md D-28). Prints only the names. Secrets are additive: a deploy never deletes one.
// TOKEN_KEYS decrypts every saved bank login: replacing it by mistake would mean re-linking every bank, which
// spends Plaid links that never come back. So once the Worker has TOKEN_KEYS (and TOKEN_KEY_CURRENT), a deploy
// leaves them alone unless the repository variable ROTATE_TOKEN_KEYS is 'true' (docs/runbooks/setup.md).
import { readFileSync, writeFileSync } from 'node:fs';

const [out, existingFile] = process.argv.slice(2);
if (!out) throw new Error('usage: node worker-secrets.mjs <output.json> [existing-secrets.json]');
const env = process.env;
let existing = [];
try {
  // Wrangler may print a banner before the JSON list.
  const text = existingFile ? readFileSync(existingFile, 'utf8') : '[]';
  existing = JSON.parse(text.slice(text.indexOf('['))).map((x) => x.name);
} catch {
  existing = [];
}
const s = {};
for (const n of [
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_REDIRECT_URI',
  'TOKEN_KEYS',
  'TOKEN_KEY_CURRENT',
  'SETUP_CODE',
  'OPS_TOKEN',
  'CF_ANALYTICS_TOKEN',
])
  if (env[n]) s[n] = env[n];
for (const n of ['TOKEN_KEYS', 'TOKEN_KEY_CURRENT'])
  if (s[n] && existing.includes(n) && env.ROTATE_TOKEN_KEYS !== 'true') {
    delete s[n];
    console.log(`${n}: the Worker already has one; kept (set ROTATE_TOKEN_KEYS to true to replace it)`);
  }
if (env.APP_URL) s.PLAID_WEBHOOK_URL = `${env.APP_URL.replace(/\/$/, '')}/api/webhooks/plaid`;
if (env.CLOUDFLARE_ACCOUNT_ID) s.CF_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
// Missing ones are fine: the Worker keeps secrets uploaded earlier (for example by a first deploy from a session).
for (const n of ['TOKEN_KEYS', 'OPS_TOKEN'])
  if (!env[n]) console.log(`${n} is not set here; the Worker keeps its current value`);
for (const n of ['TOKEN_KEYS', 'OPS_TOKEN', 'SETUP_CODE'])
  if (s[n] && s[n].length < 32) throw new Error(`${n} must be at least 32 characters`);
writeFileSync(out, JSON.stringify(s), { mode: 0o600 });
console.log(`secrets for the Worker: ${Object.keys(s).join(', ')}`);
