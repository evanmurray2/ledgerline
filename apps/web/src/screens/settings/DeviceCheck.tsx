// Settings → Device check: the phase 0 checks of the privacy design (docs/privacy.md 15.4), run on this device.
// Settings lists it while phase 0 runs, so the Home Screen app can reach it.
import { useState } from 'react';
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
    </Page>
  );
}
