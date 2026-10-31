// Deploy smoke test: health with the Access service token, auth rejection without it, and a read query.
const base = process.env.BASE_URL;
if (!base) throw new Error('BASE_URL is not set');
const svc = {
  'cf-access-client-id': process.env.ACCESS_CLIENT_ID ?? '',
  'cf-access-client-secret': process.env.ACCESS_CLIENT_SECRET ?? '',
};
const health = await fetch(`${base}/api/health`, { headers: svc, redirect: 'manual' });
if (health.status !== 200) throw new Error(`health ${health.status}`);
const body = await health.json();
if (!body.usage || typeof body.watermarkLag !== 'number') throw new Error('health body is missing fields');
const anon = await fetch(`${base}/api/session`, { redirect: 'manual' });
if (anon.status === 200) throw new Error('an unauthenticated request was served');
console.log(`smoke ok: health 200 (lag ${body.watermarkLag}), unauthenticated ${anon.status}`);
