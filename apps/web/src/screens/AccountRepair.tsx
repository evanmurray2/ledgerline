// Repair a bank connection through Plaid Link update mode (a sheet over Accounts).
import { useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useAccounts, useSession, qk } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, ErrorNote, PrimaryButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { budgetDateTime, syncedLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { runPlaidLink } from '../lib/plaid';
import { usage } from '../usage/tracker';

export function RepairScreen() {
  const { connectionId } = useParams({ strict: false }) as { connectionId: string };
  useScreen('repair');
  const q = useAccounts();
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const close = () => void navigate({ to: '/accounts' });
  const [step, setStep] = useState<'before' | 'working' | 'after' | 'exited'>('before');
  const [error, setError] = useState<unknown>(null);
  const repair = q.data?.repairs.find((r) => r.connectionId === connectionId);
  const inst = repair?.institution ?? 'the bank';
  const accts = (q.data?.groups ?? []).flatMap((g) => g.accounts).filter((a) => a.institution === inst);
  const today = session.data?.budget.today ?? '';
  const start = async () => {
    setError(null);
    try {
      const r = await runPlaidLink('repair', connectionId);
      if (r.status === 'exited') return setStep('exited');
      setStep('working');
      await api.refreshConnection(connectionId);
      await qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      usage.record('task', 'repair');
      setStep('after');
    } catch (e) {
      setError(e);
      setStep('before');
    }
  };
  return (
    <Sheet
      label={`Repair ${inst}`}
      track="repair"
      onClose={close}
      gap="auto"
      closeLabel="Back to accounts"
      header={<SheetTitle title={`Repair ${inst}`} />}
      footer={
        step === 'after' ? (
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
        <Banner tone="success" icon="check" title={`${inst} is connected again`}>
          New transactions are coming in. Anything that needs a category waits in Activity.
        </Banner>
      ) : step === 'working' ? (
        <div role="status" className="flex flex-col items-center gap-2 rounded-lg bg-page p-5 text-center">
          <span className="text-base font-bold">Catching up on {inst}</span>
          <span className="text-sm text-muted">
            Pulling transactions since the last sync. You can leave this screen; we’ll keep going.
          </span>
        </div>
      ) : (
        <>
          <Banner tone="warn" icon="alert" title={`${inst} asked you to sign in again`}>
            This happens when a bank changes its login or asks for a new consent. Nothing is lost: we kept
            everything up to the last sync
            {repair?.lastSynced ? ` on ${syncedLabel(repair.lastSynced, today)}` : ''}.
          </Banner>
          <div className="shrink-0 overflow-hidden rounded-lg border border-line">
            {[
              ['Accounts on this login', accts.map((a) => a.name).join(', ') || '—'],
              ['Last good sync', repair?.lastSynced ? budgetDateTime(repair.lastSynced) : '—'],
              ['Balance shown', accts[0] ? `${formatCents(accts[0].bank)} (may be out of date)` : '—'],
              ['Budget effect', 'None until new data arrives'],
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
            Repair opens Plaid’s secure window. You sign in with {inst} there; Ledgerline never sees your bank
            password. Repairing doesn’t use another of your 10 links.
          </p>
          {step === 'exited' && (
            <Banner tone="neutral">You closed the window before finishing. Nothing changed.</Banner>
          )}
          {error ? <ErrorNote error={error} /> : null}
        </>
      )}
    </Sheet>
  );
}
