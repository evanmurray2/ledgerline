// Drives the phase 0 Worker (phase0/worker.ts) and reads per-step CPU back from Cloudflare's GraphQL Analytics.
// Each measured operation runs as its own group of alarm invocations, with a quiet minute between groups, so each
// group's time window holds only that operation. Writes phase0-results.json. Never fails on an analytics error:
// whatever Cloudflare returns is printed, so a field-name surprise still leaves usable output.
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL;
const KEY = process.env.PHASE0_KEY;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CF_ANALYTICS_TOKEN;
const SCRIPT = 'ledgerline-phase0';
const out = { started: new Date().toISOString(), probes: [], groups: {}, analytics: {}, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, method = 'GET') {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(BASE + path, { method, headers: { 'x-phase0-key': KEY } });
      const t = await r.text();
      if (r.status === 404 && attempt < 20) throw new Error('not yet routed');
      try {
        return { status: r.status, body: JSON.parse(t) };
      } catch {
        return { status: r.status, body: t.slice(0, 300) };
      }
    } catch (e) {
      if (attempt >= 20) throw e;
      await sleep(5000);
    }
  }
}

async function gql(query, variables = {}) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

// 1. CPU limit probe: does a Durable Object request on Free stop at 10 ms?
for (const n of [200_000, 1_000_000, 4_000_000, 20_000_000]) {
  const r = await call(`/burn/${n}`);
  out.probes.push({ iterations: n, ...r.body });
  console.log('burn', n, JSON.stringify(r.body));
}
out.probeWindow = { end: new Date().toISOString() };
await sleep(70_000);

// 2. Point-in-time recovery on Free.
out.pitr = (await call('/pitr')).body;
console.log('pitr', JSON.stringify(out.pitr));

// 3. Alarm retries after a CPU overrun (runs alongside; read at the end).
out.alarmTestStart = (await call('/alarm-test', 'POST')).body;

// 4. The measured operations, one plan at a time.
const KINDS = (process.env.KINDS || 'screens,sync,recompute,move').split(',');
for (const kind of KINDS) {
  console.log('start', kind, JSON.stringify((await call(`/start/${kind}`, 'POST')).body));
  const deadline = Date.now() + 40 * 60_000;
  let s;
  for (;;) {
    await sleep(45_000);
    s = (await call(`/status/${kind}`)).body;
    console.log(kind, `${s.next}/${s.total}`);
    if (s.done || Date.now() > deadline) break;
  }
  out.groups[kind] = s;
  await sleep(70_000);
}
out.alarmTest = (await call('/alarm-test')).body;
// Point-in-time recovery again, now that the object is older than a minute.
out.pitrLater = (await call('/pitr')).body;
console.log('pitr later', JSON.stringify(out.pitrLater));
console.log('alarm test', JSON.stringify(out.alarmTest));

// 5. Analytics: wait for ingestion, find the CPU fields, then query each measured group's window.
await sleep(240_000);
const types = await gql(`{ __schema { types { name fields { name } } } }`);
const wanted = (types.data?.__schema?.types ?? []).filter((t) =>
  /workersinvocationsadaptive|durableobjects/i.test(t.name),
);
out.analytics.types = wanted.map((t) => ({ name: t.name, fields: (t.fields ?? []).map((f) => f.name) }));
const qType = wanted.find((t) => /WorkersInvocationsAdaptiveQuantiles/i.test(t.name));
const cpuQ = (qType?.fields ?? []).map((f) => f.name).filter((f) => /^cpuTimeP/.test(f));
const doSum = wanted.find((t) => /DurableObjectsPeriodicGroupsSum/i.test(t.name));
const doSumFields = (doSum?.fields ?? [])
  .map((f) => f.name)
  .filter((f) => /cpu|rows|active|duration/i.test(f));
const doInvQ = wanted.find((t) => /DurableObjectsInvocationsAdaptiveGroupsQuantiles/i.test(t.name));
const doInvQFields = (doInvQ?.fields ?? []).map((f) => f.name);
out.analytics.fields = { cpuQ, doSumFields, doInvQFields };

const windows = [{ name: 'probe', start: out.started, end: out.probeWindow.end }];
for (const [kind, s] of Object.entries(out.groups))
  for (const g of s?.groups ?? [])
    if (g.measure)
      windows.push({
        name: `${kind}: ${g.grp}`,
        n: g.n,
        failed: g.failed,
        err: g.err,
        start: new Date(g.start - 1000).toISOString(),
        end: new Date(g.end + 1000).toISOString(),
      });

for (const w of windows) {
  const res = {};
  if (cpuQ.length) {
    const r = await gql(
      `query($a: string!, $s: Time!, $e: Time!, $n: string!) { viewer { accounts(filter: {accountTag: $a}) {
        workersInvocationsAdaptive(limit: 20, filter: {scriptName: $n, datetime_geq: $s, datetime_leq: $e}) {
          sum { requests errors } quantiles { ${cpuQ.join(' ')} } dimensions { scriptName status }
        } } } }`,
      { a: ACCOUNT, s: w.start, e: w.end, n: SCRIPT },
    );
    res.workers = r.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? r.errors;
  }
  if (doInvQFields.length) {
    const r = await gql(
      `query($a: string!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
        durableObjectsInvocationsAdaptiveGroups(limit: 20, filter: {datetime_geq: $s, datetime_leq: $e}) {
          sum { requests } quantiles { ${doInvQFields.join(' ')} }
        } } } }`,
      { a: ACCOUNT, s: w.start, e: w.end },
    );
    res.doInvocations = r.data?.viewer?.accounts?.[0]?.durableObjectsInvocationsAdaptiveGroups ?? r.errors;
  }
  if (doSumFields.length) {
    const r = await gql(
      `query($a: string!, $s: Time!, $e: Time!) { viewer { accounts(filter: {accountTag: $a}) {
        durableObjectsPeriodicGroups(limit: 20, filter: {datetimeMinute_geq: $s, datetimeMinute_leq: $e}) {
          sum { ${doSumFields.join(' ')} }
        } } } }`,
      { a: ACCOUNT, s: w.start, e: w.end },
    );
    res.doPeriodic = r.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups ?? r.errors;
  }
  out.analytics[w.name] = { window: w, ...res };
  console.log('\n==', w.name, `(n=${w.n ?? '-'}, failed=${w.failed ?? '-'})`, w.err ?? '');
  console.log(JSON.stringify(res));
}

// 6. Account-wide rows today, D1 and Durable Objects side by side (does Durable Object usage show up as D1?).
const day = new Date().toISOString().slice(0, 10);
const d1 = await gql(
  `query($a: string!, $d: Date!) { viewer { accounts(filter: {accountTag: $a}) {
    d1AnalyticsAdaptiveGroups(limit: 50, filter: {date: $d}) { sum { rowsRead rowsWritten } dimensions { databaseId } }
  } } }`,
  { a: ACCOUNT, d: day },
);
out.analytics.d1Today = d1.data?.viewer?.accounts?.[0] ?? d1.errors;
console.log('\nD1 today', JSON.stringify(out.analytics.d1Today));

writeFileSync('phase0-results.json', JSON.stringify(out, null, 2));
console.log('\nwrote phase0-results.json');
