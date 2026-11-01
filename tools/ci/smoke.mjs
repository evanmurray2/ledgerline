// Deploy smoke test: health with the ops token, sign-in status, and that nothing else is served without signing in.
const base = process.env.BASE_URL;
if (!base) throw new Error('BASE_URL is not set');
const ops = { authorization: `Bearer ${process.env.OPS_TOKEN ?? ''}` };
const health = await fetch(`${base}/api/health`, { headers: ops, redirect: 'manual' });
if (health.status !== 200) throw new Error(`health ${health.status}`);
const body = await health.json();
if (!body.usage || typeof body.watermarkLag !== 'number') throw new Error('health body is missing fields');
const status = await fetch(`${base}/api/auth/status`);
if (status.status !== 200) throw new Error(`auth status ${status.status}`);
const st = await status.json();
if (typeof st.hasPasskey !== 'boolean') throw new Error('auth status body is missing fields');
const anon = await fetch(`${base}/api/session`, { redirect: 'manual' });
if (anon.status !== 401) throw new Error(`an unauthenticated request got ${anon.status}`);
const opsElsewhere = await fetch(`${base}/api/session`, { headers: ops, redirect: 'manual' });
if (opsElsewhere.status !== 403)
  throw new Error(`the ops token reached /api/session (${opsElsewhere.status})`);
console.log(
  `smoke ok: health 200 (lag ${body.watermarkLag}), passkey set up: ${st.hasPasskey}, unauthenticated 401`,
);
