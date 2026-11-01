// Writes the Worker's secrets for `wrangler deploy --secrets-file` from the GitHub environment's secrets, so setup
// needs no command line (decisions.md D-28). Prints only the names. Secrets are additive: a deploy never deletes one.
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node worker-secrets.mjs <output.json>');
const env = process.env;
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
if (env.APP_URL) s.PLAID_WEBHOOK_URL = `${env.APP_URL.replace(/\/$/, '')}/api/webhooks/plaid`;
if (env.CLOUDFLARE_ACCOUNT_ID) s.CF_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
for (const n of ['TOKEN_KEYS', 'OPS_TOKEN'])
  if (!s[n]) throw new Error(`${n} is not set in this GitHub environment`);
for (const n of ['TOKEN_KEYS', 'OPS_TOKEN', 'SETUP_CODE'])
  if (s[n] && s[n].length < 32) throw new Error(`${n} must be at least 32 characters`);
writeFileSync(out, JSON.stringify(s), { mode: 0o600 });
console.log(`secrets for the Worker: ${Object.keys(s).join(', ')}`);
