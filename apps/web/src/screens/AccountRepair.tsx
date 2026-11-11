// Repair a bank connection through Plaid Link update mode (a sheet over Accounts).
import { useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useAccounts, qk } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, ErrorNote, PrimaryButton } from '../components/ui';
import { budgetDateTime } from '../lib/dates';
import { useScreen } from '../lib/common';
import { runPlaidLink } from '../lib/plaid';
import { usage } from '../usage/tracker';

export function RepairScreen() {
  const { connectionId } = useParams({ strict: false }) as { connectionId: string };
  useScreen('repair');
  const q = useAccounts();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const close = () => void navigate({ to: '/accounts' });
  const [step, setStep] = useState<'before' | 'working' | 'after' | 'exited'>('before');
  const [error, setError] = useState<unknown>(null);
  // Signed in, but the sync after it failed: say so, not "needs you to sign in again".
  const [syncFailed, setSyncFailed] = useState(false);
  const repair = q.data?.repairs.find((r) => r.connectionId === connectionId);
  // The bank leaves the repair list once it's fixed: keep its name for the "connected again" note.
  const name = useRef<string | null>(null);
  if (repair) name.current = repair.institution;
  const inst = name.current ?? 'the bank';
  const accts = (q.data?.groups ?? []).flatMap((g) => g.accounts).filter((a) => a.institution === inst);
  // A link that no longer needs signing in (or no longer exists): nothing to do here.
  const nothingToDo = step === 'before' && !!q.data && !repair;
  const start = async () => {
    setError(null);
    let signedIn = false;
    try {
      const r = await runPlaidLink('repair', connectionId);
      if (r.status === 'exited') return setStep('exited');
      signedIn = true;
      setStep('working');
      await api.refreshConnection(connectionId);
      await qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      usage.record('task', 'repair');
      setStep('after');
    } catch (e) {
      if (signedIn) {
        setSyncFailed(true);
        void qc.invalidateQueries({ queryKey: qk.accounts });
        setStep('after');
        return;
      }
      setError(e);
      setStep('before');
    }
  };
  const title = nothingToDo ? 'Bank sign-in' : `Sign in to ${inst} again`;
  return (
    <Sheet
      label={title}
      track="repair"
      onClose={close}
      gap="auto"
      closeLabel="Back to accounts"
      header={<SheetTitle title={title} />}
      footer={
        step === 'after' || nothingToDo ? (
          <PrimaryButton onClick={close}>Done</PrimaryButton>
        ) : (
          <PrimaryButton
            mutates
            track="repair.start"
            disabled={step === 'working' || !repair}
            onClick={() => void start()}
          >
            Sign in to {inst}
          </PrimaryButton>
        )
      }
    >
      {step === 'after' ? (
        syncFailed ? (
          <Banner tone="warn" icon="alert" title={`${inst} is connected again`}>
            Its sync didn’t finish. Tap Sync on Accounts to try again.
          </Banner>
        ) : (
          <Banner tone="success" icon="check" title={`${inst} is connected again`}>
            New transactions show up in Activity.
          </Banner>
        )
      ) : step === 'working' ? (
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg bg-page p-5 text-center">
          <span className="text-base font-bold">Syncing {inst}</span>
          <span className="text-sm text-muted">You can leave this screen. It keeps going.</span>
        </div>
      ) : nothingToDo ? (
        <Banner tone="neutral">This bank doesn’t need you to sign in again.</Banner>
      ) : (
        <>
          <Banner tone="warn" icon="alert" title={`${inst} needs you to sign in again`}>
            Nothing is lost. Everything up to the last sync is kept.
          </Banner>
          <div className="shrink-0 overflow-hidden rounded-lg border border-line">
            {[
              ['Accounts', accts.map((a) => a.name).join(', ') || '—'],
              ['Last sync', repair?.lastSynced ? budgetDateTime(repair.lastSynced) : '—'],
            ].map(([k, val]) => (
              <div
                key={k}
                className="flex justify-between gap-3 border-t border-divider px-3 py-2.5 text-md first:border-t-0"
              >
                <span className="text-muted">{k}</span>
                <span className="text-right font-semibold">{val}</span>
              </div>
            ))}
          </div>
          <p className="m-0 text-sm leading-snug text-muted">
            You sign in with {inst} in Plaid’s secure window. It doesn’t use another bank link.
          </p>
          {step === 'exited' && <Banner tone="neutral">You closed the window. Nothing changed.</Banner>}
          {error ? <ErrorNote error={error} /> : null}
        </>
      )}
    </Sheet>
  );
}
