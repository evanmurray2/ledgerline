// Deploy smoke test: the app serves, sign-in status answers, and nothing else is served without signing in. With
// OPS_TOKEN set it also reads health and checks the token reaches nothing else.
const base = process.env.BASE_URL;
if (!base) throw new Error('BASE_URL is not set');
const token = process.env.OPS_TOKEN ?? '';
const home = await fetch(`${base}/`);
if (home.status !== 200) throw new Error(`home page ${home.status}`);
const status = await fetch(`${base}/api/auth/status`);
if (status.status !== 200)
  throw new Error(`auth status ${status.status}: ${(await status.text().catch(() => '')).slice(0, 300)}`);
const st = await status.json();
if (typeof st.hasPasskey !== 'boolean') throw new Error('auth status body is missing fields');
const anon = await fetch(`${base}/api/session`, { redirect: 'manual' });
if (anon.status !== 401) throw new Error(`an unauthenticated request got ${anon.status}`);
let health = 'skipped (no OPS_TOKEN)';
if (token) {
  const ops = { authorization: `Bearer ${token}` };
  const h = await fetch(`${base}/api/health`, { headers: ops, redirect: 'manual' });
  if (h.status !== 200) throw new Error(`health ${h.status}`);
  const body = await h.json();
  if (!body.usage || typeof body.watermarkLag !== 'number') throw new Error('health body is missing fields');
  const elsewhere = await fetch(`${base}/api/session`, { headers: ops, redirect: 'manual' });
  if (elsewhere.status !== 403) throw new Error(`the ops token reached /api/session (${elsewhere.status})`);
  health = `200 (lag ${body.watermarkLag})`;
}
console.log(`smoke ok: home 200, passkey set up: ${st.hasPasskey}, unauthenticated 401, health ${health}`);
