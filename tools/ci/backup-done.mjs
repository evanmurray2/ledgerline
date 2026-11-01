// Tells the app a nightly backup finished, so Accounts and the monitor show its time (decisions.md D-26).
const base = process.env.BASE_URL;
if (!base) throw new Error('BASE_URL is not set');
const res = await fetch(`${base}/api/ops/backup-done`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.OPS_TOKEN ?? ''}`,
    'content-type': 'application/json',
    'x-ledgerline': '1',
  },
  body: '{}',
});
if (res.status !== 200) throw new Error(`backup-done returned ${res.status}`);
console.log('backup reported');
