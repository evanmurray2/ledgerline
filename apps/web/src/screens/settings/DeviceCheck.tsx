// Settings → Device check: the phase 0 checks of the privacy design (docs/privacy.md 15.4), run on this device.
// Settings lists it while phase 0 runs, so the Home Screen app can reach it.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { useConnections, useSession } from '../../api/hooks';
import { runPlaidLink } from '../../lib/plaid';
import { Card, ErrorNote, SectionTitle, SoftButton } from '../../components/ui';
import { type CheckResult, checkPasskey, type PasskeyCheck, runDeviceChecks } from '../../lib/device-check';
import { Page } from './common';

const yesNo = (ok: boolean) => (ok ? 'Yes' : 'No');

function Line({ name, value, bad }: { name: string; value: string; bad?: boolean }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-t border-divider px-3 py-2 first:border-t-0">
      <span className="text-sm text-ink">{name}</span>
      <span className={bad ? 'text-sm font-semibold text-warn-fg' : 'text-sm text-ink-2'}>{value}</span>
    </div>
  );
}

/**
 * The hosted Link test (docs/privacy.md 15.4): sign in again to a bank that is already linked, on Plaid's own site.
 * Plaid's update mode keeps the same link, so this uses none of the 10. Shown only while hosted Link is on.
 */
function BankSignInTest() {
  const hosted = useSession().data?.hostedLink === true;
  const conns = useConnections().data;
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ bank: string; text: string; bad?: boolean } | null>(null);
  if (!hosted || !conns) return null;
  const banks = conns.items.filter((i) => i.status !== 'removed');
  const test = async (id: string, bank: string) => {
    setBusy(id);
    setResult(null);
    try {
      const r = await runPlaidLink('repair', id, true);
      if (r.status === 'repaired') {
        await api.refreshConnection(id);
        void qc.invalidateQueries();
        setResult({ bank, text: 'Signed in again. The app finished it.' });
      } else setResult({ bank, text: 'Left before the end. Nothing changed.' });
    } catch (e) {
      setResult({ bank, text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <SectionTitle>Bank sign-in on Plaid’s site</SectionTitle>
      <span className="text-sm text-muted">
        Signs in again to a bank you already have. It uses none of your bank links.
      </span>
      <Card>
        {banks.map((b) => (
          <div
            key={b.id}
            className="flex min-h-12 items-center justify-between gap-3 border-t border-divider px-3 py-2 first:border-t-0"
          >
            <span className="text-sm text-ink">{b.institution}</span>
            <SoftButton
              onClick={() => void test(b.id, b.institution)}
              disabled={busy !== null}
              data-track="device_check.bank"
            >
              {busy === b.id ? 'Waiting…' : 'Test'}
            </SoftButton>
          </div>
        ))}
      </Card>
      {result && (
        <Card>
          <Line name={result.bank} value={result.text} bad={result.bad} />
        </Card>
      )}
    </>
  );
}

export function DeviceCheckScreen() {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);
  const [passkey, setPasskey] = useState<PasskeyCheck | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    setRunning(true);
    setResults([]);
    await runDeviceChecks((r) => setResults((all) => [...all, r]));
    setRunning(false);
  };
  const ask = async () => {
    setAsking(true);
    setError(null);
    setPasskey(null);
    try {
      setPasskey(await checkPasskey());
    } catch (e) {
      setError(e);
    } finally {
      setAsking(false);
    }
  };

  return (
    <Page title="Device check" back="/settings">
      <span className="text-sm text-muted">
        These checks use made-up data. They don’t read your budget and they send nothing.
      </span>
      <SectionTitle>This device</SectionTitle>
      <Card>
        {results.length === 0 && <Line name="Not run yet" value="" />}
        {results.map((r) => (
          <Line
            key={r.name}
            name={r.name}
            value={
              r.ok ? `OK · ${Math.round(r.ms)} ms${r.note ? ` · ${r.note}` : ''}` : `Failed · ${r.note ?? ''}`
            }
            bad={!r.ok}
          />
        ))}
      </Card>
      <SoftButton onClick={() => void run()} disabled={running} data-track="device_check.run">
        {running ? 'Checking…' : 'Run the checks'}
      </SoftButton>
      <SectionTitle>Your passkey</SectionTitle>
      <Card>
        {!passkey && <Line name="Not checked yet" value="" />}
        {passkey && (
          <>
            <Line name="Gave a first secret" value={yesNo(passkey.first)} bad={!passkey.first} />
            <Line name="Gave a second secret" value={yesNo(passkey.second)} bad={!passkey.second} />
            <Line name="The two are different" value={yesNo(passkey.differ)} bad={!passkey.differ} />
            <Line name="Kind of passkey" value={passkey.attachment} />
          </>
        )}
      </Card>
      {error != null && <ErrorNote error={error} />}
      <SoftButton onClick={() => void ask()} disabled={asking} data-track="device_check.passkey">
        {asking ? 'Waiting for your passkey…' : 'Check my passkey'}
      </SoftButton>
      <BankSignInTest />
    </Page>
  );
}
