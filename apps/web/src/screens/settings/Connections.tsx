// Settings → Bank connections: the Item meter, Link with a confirm step, Finish setup.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { qk, useAccounts, useConnections, useSession } from '../../api/hooks';
import { toast } from '../../components/Toast';
import { Button, Card, cx, ErrorNote, Loading, PrimaryButton, SecondaryButton } from '../../components/ui';
import { syncedLabel } from '../../lib/dates';
import { useScreen } from '../../lib/common';
import { runPlaidLink } from '../../lib/plaid';
import { usage } from '../../usage/tracker';
import { useCanWrite } from '../../state/connectivity';
import { Page } from './common';

// ------------------------------------------------------------------ connections

export function LinkMeter({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, limit - used);
  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-bold" data-testid="link-meter">
          {used} of {limit} links used
        </span>
        <span className="text-[13px] text-muted">{left} left, for good</span>
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className={cx('h-2 flex-1 rounded-sm', i < used ? 'bg-accent' : 'bg-track')} />
        ))}
      </div>
      <span className="text-[12px] leading-snug text-muted">
        The free Plaid plan allows {limit} bank logins ever. Removing one doesn’t give it back, so repair a
        broken login instead of re-adding it.
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
  if (left <= 0)
    return (
      <p className="m-0 rounded-xl bg-under-bg p-3 text-[13px] text-under-fg">
        All {v.limit} links are used. Import a CSV from Import and export instead.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {step === 'confirm' || step === 'linking' ? (
        <div
          role="alertdialog"
          aria-label="Use a link"
          className="flex flex-col gap-2.5 rounded-[14px] border border-accent bg-accent-soft p-3"
        >
          <span className="text-[15px] font-bold">Use 1 of your {left} remaining links?</span>
          <span className="text-[13px] leading-snug text-ink-2">
            After this, {v.used + 1} of {v.limit} links are used, for good. If a bank you already linked
            stopped syncing, repair it from Accounts instead. Linking opens Plaid’s secure window; Ledgerline
            never sees your bank password.
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
          {left <= 3 && (
            // Few links left for good: say so before the button, not only in the confirm step.
            <p className="m-0 rounded-xl border border-warn-border bg-warn-bg p-3 text-[13px] leading-snug text-warn-fg">
              <strong>
                Only {left} {left === 1 ? 'link' : 'links'} left, ever.
              </strong>{' '}
              Repair a broken login from Accounts instead of linking it again.
            </p>
          )}
          <Button
            mutates
            track="connections.link"
            onClick={() => setStep('confirm')}
            className="flex h-12 w-full items-center justify-center rounded-xl border border-dashed border-accent text-[15px] font-bold text-accent disabled:border-line disabled:text-disabled"
          >
            {label ?? `+ Link another bank (uses 1 of ${left})`}
          </Button>
        </>
      )}
      {step === 'done' && (
        <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[13px] text-funded-fg">
          Linked. Transactions will show up in Activity after the first sync, usually within a few minutes.
        </p>
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
    <Button
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
            toast.show({ text: e instanceof Error ? e.message : 'Couldn’t finish setup. Try again.' });
          },
        );
      }}
      className="hit flex h-9 items-center self-start rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent"
    >
      {busy ? 'Finishing…' : 'Finish setup'}
    </Button>
  );
}

export function ConnectionsScreen() {
  useScreen('settings.connections');
  const q = useConnections();
  const session = useSession();
  const accounts = useAccounts();
  const v = q.data;
  const today = session.data?.budget.today ?? '';
  const status = (s: string) =>
    s === 'ok'
      ? { text: 'Synced', cls: 'bg-funded-bg text-funded-fg' }
      : s === 'login_required'
        ? { text: 'Sign in again', cls: 'bg-under-bg text-under-fg' }
        : s === 'error'
          ? { text: 'Sync failed', cls: 'bg-over-bg text-over-fg' }
          : { text: 'Still counts', cls: 'bg-none-bg text-none-fg' };
  return (
    <Page title="Bank connections" back="/settings">
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && (
        <>
          <LinkMeter used={v.used} limit={v.limit} />
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
                        className={cx('text-[15px] font-semibold', it.status === 'removed' && 'text-muted')}
                      >
                        {it.institution}
                        {it.status === 'removed' ? ' (removed)' : ''}
                      </span>
                      <span className="text-[12px] text-muted">
                        {it.accounts} · linked {syncedLabel(it.linkedAt, '')}
                      </span>
                    </span>
                    <span className={cx('shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold', st.cls)}>
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
                    <Link
                      to={`/accounts/repair/${it.id}`}
                      data-track="connections.repair"
                      className="hit flex h-9 items-center self-start rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
                    >
                      Repair on Accounts
                    </Link>
                  )}
                </div>
              );
            })}
          </Card>
          <LinkBankFlow />
          {v.environment === 'sandbox' && (
            <p className="m-0 text-[12px] text-muted">Plaid Sandbox: test banks only.</p>
          )}
        </>
      )}
    </Page>
  );
}
