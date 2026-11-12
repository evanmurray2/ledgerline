// Settings → Bank connections: the Item meter, Link with a confirm step, Finish setup.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { qk, useAccounts, useConnections, useSession } from '../../api/hooks';
import { toast } from '../../components/Toast';
import {
  Banner,
  Button,
  Card,
  cx,
  ErrorNote,
  Icon,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SoftButton,
  SoftLink,
} from '../../components/ui';
import { syncedLabel } from '../../lib/dates';
import { useScreen } from '../../lib/common';
import { runPlaidLink } from '../../lib/plaid';
import { useResumeLink } from '../../lib/resume-link';
import { usage } from '../../usage/tracker';
import { useCanWrite } from '../../state/connectivity';
import { Page } from './common';
import { Why } from '../../components/Why';
import { errorMessage } from '../../api/client';

// ------------------------------------------------------------------ connections

export function LinkMeter({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, limit - used);
  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-base font-bold" data-testid="link-meter">
          {used} of {limit} bank links used
        </span>
        <span className="text-sm text-muted">{left} left</span>
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className={cx('h-2 flex-1 rounded-sm', i < used ? 'bg-accent' : 'bg-track')} />
        ))}
      </div>
      <span className="flex flex-col gap-1 text-xs leading-snug text-muted">
        <span>Removing a link doesn’t give it back.</span>
        <Why>
          The free Plaid plan allows {limit} bank links in total. If a bank stops syncing, sign in again from
          Accounts.
        </Why>
      </span>
    </section>
  );
}

/** "Link a bank" with a confirm step first, since each link uses one of the 10 for good. */
export function LinkBankFlow({ onLinked, label }: { onLinked?: () => void; label?: string }) {
  const conns = useConnections();
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'confirm' | 'linking' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
  const canWrite = useCanWrite();
  const v = conns.data;
  if (!v) return null;
  const left = v.limit - v.used;
  const anyLinked = v.items.some((i) => i.status !== 'removed');
  const start = async () => {
    setStep('linking');
    setError(null);
    try {
      const r = await runPlaidLink('new');
      if (r.status === 'exited') return setStep('idle');
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.connections }),
        qc.invalidateQueries({ queryKey: qk.accounts }),
      ]);
      usage.record('task', 'link_bank');
      setStep('done');
      onLinked?.();
    } catch (e) {
      setError(e);
      setStep('confirm');
    }
  };
  if (left <= 0) return <Banner tone="warn">All {v.limit} bank links are used.</Banner>;
  return (
    <div className="flex flex-col gap-2">
      {step === 'confirm' || step === 'linking' ? (
        <div
          role="alertdialog"
          aria-label="Use a bank link"
          className="flex flex-col gap-2.5 rounded-lg border border-accent bg-accent-soft p-3"
        >
          <span className="text-base font-bold">
            {left === 1 ? 'Use your last bank link?' : `Use 1 of your ${left} bank links?`}
          </span>
          <span className="text-sm leading-snug text-ink-2">
            If a bank stopped syncing, sign in again from Accounts instead.
          </span>
          <div className="flex gap-2">
            <SecondaryButton className="flex-1" onClick={() => setStep('idle')} disabled={step === 'linking'}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              mutates
              track="connections.link.confirm"
              className="flex-[2]"
              disabled={step === 'linking' || !canWrite}
              onClick={() => void start()}
            >
              {step === 'linking' ? 'Opening Plaid…' : 'Link a bank'}
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <>
          <Button
            mutates
            track="connections.link"
            onClick={() => setStep('confirm')}
            className="flex h-12 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-accent text-base font-bold text-accent disabled:border-line disabled:text-disabled"
          >
            <Icon name="plus" size={16} stroke={2.6} />
            {label ?? (anyLinked ? 'Link another bank' : 'Link a bank')}
          </Button>
        </>
      )}
      {step === 'done' && (
        <Banner tone="success" icon="check">
          Linked. Transactions show up in Activity in a few minutes.
        </Banner>
      )}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

/** A link Plaid confirmed whose accounts didn't get set up: finishing it never uses another link. */
function FinishSetup({ id, institution }: { id: string; institution: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <SoftButton
      mutates
      track="connections.finish_setup"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        api.refreshConnection(id).then(
          () => {
            setBusy(false);
            toast.show({ text: `${institution} is set up. Its transactions are on the way.` });
            void qc.invalidateQueries();
          },
          (e: unknown) => {
            setBusy(false);
            toast.show({ text: errorMessage(e) });
          },
        );
      }}
      className="self-start"
    >
      {busy ? 'Finishing…' : 'Finish setup'}
    </SoftButton>
  );
}

export function ConnectionsScreen() {
  useScreen('settings.connections');
  useResumeLink();
  const q = useConnections();
  const session = useSession();
  const accounts = useAccounts();
  const v = q.data;
  const today = session.data?.budget.today ?? '';
  // Only admins link new banks while Plaid Trial applies (D-75); others never see the link count.
  const canLink = session.data?.canLinkBanks !== false;
  const status = (s: string) =>
    s === 'ok'
      ? { text: 'Synced', cls: 'bg-funded-bg text-funded-fg' }
      : s === 'login_required'
        ? { text: 'Not syncing', cls: 'bg-warn-bg text-warn-fg' }
        : s === 'error'
          ? { text: 'Sync failed', cls: 'bg-over-bg text-over-fg' }
          : { text: 'Removed', cls: 'bg-none-bg text-none-fg' };
  return (
    <Page title="Bank connections" back="/settings">
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && (
        <>
          {canLink && <LinkMeter used={v.used} limit={v.limit} />}
          {v.items.length > 0 && (
            <Card>
              {v.items.map((it) => {
                const st = status(it.status);
                const repair = accounts.data?.repairs.find((r) => r.connectionId === it.id);
                return (
                  <div
                    key={it.id}
                    className="flex flex-col gap-2 border-t border-divider px-3 py-2.5 first:border-t-0"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex flex-col gap-0.5">
                        <span
                          className={cx('text-base font-semibold', it.status === 'removed' && 'text-muted')}
                        >
                          {it.institution}
                        </span>
                        <span className="text-xs text-muted">
                          {it.accounts} · linked {syncedLabel(it.linkedAt, '')}
                        </span>
                      </span>
                      <span className={cx('shrink-0 rounded-sm px-2 py-0.5 text-xs font-bold', st.cls)}>
                        {!it.setupDone
                          ? 'Setup unfinished'
                          : it.status === 'ok' && it.lastSynced
                            ? `Synced ${syncedLabel(it.lastSynced, today)}`
                            : st.text}
                      </span>
                    </div>
                    {!it.setupDone && it.status !== 'removed' && (
                      <FinishSetup id={it.id} institution={it.institution} />
                    )}
                    {repair && (
                      <SoftLink
                        to={`/accounts/repair/${it.id}`}
                        search={{ close: '/settings/connections' }}
                        track="connections.repair"
                        className="self-start"
                      >
                        Sign in again
                      </SoftLink>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
          {canLink ? (
            <LinkBankFlow />
          ) : (
            <p className="m-0 text-sm text-muted">Linking banks isn’t available on your account yet.</p>
          )}
          {v.environment === 'sandbox' && (
            <p className="m-0 text-xs text-muted">Test mode: test banks only.</p>
          )}
        </>
      )}
    </Page>
  );
}
