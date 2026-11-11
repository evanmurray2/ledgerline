// Accounts: net worth, Owed to you under the total, repair banner, failed-sync banner with Sync now, cash and
// cards (statement covered). The register is in AccountRegister.tsx and the Repair sheet in AccountRepair.tsx.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountRow, AccountsView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAccounts, qk } from '../api/hooks';
import {
  Banner,
  Card,
  cx,
  HeaderAction,
  ErrorNote,
  Icon,
  Loading,
  ScreenBody,
  SectionTitle,
  SoftButton,
  useIsDesktop,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
import { TabHeader } from '../components/MonthBar';
import { PULL_HOLD, usePullToRefresh } from '../lib/pull';
import { errorMessage } from '../api/client';
import { getCopy, syncNow } from '../copy/copy';

export { RegisterScreen } from './AccountRegister';
export { RepairScreen } from './AccountRepair';

/** How often pull to sync looks for the banks' new data, and how long it keeps the indicator up before giving up. */
const SYNC_CHECK_MS = 2_500;
const SYNC_WAIT_MS = 45_000;
/** The pull indicator before the first pull: tucked above the list (lib/pull.ts moves it from there). */
const HIDDEN = { transform: `translate3d(0, -${PULL_HOLD}px, 0)`, opacity: 0 } as const;

/** Banks that finished since `before`: synced again (their accounts' sync time moved on) or newly failed. */
export function banksDone(before: AccountsView | undefined, now: AccountsView): number {
  const last = (v: AccountsView | undefined) => {
    const m = new Map<string, number>();
    for (const g of v?.groups ?? [])
      for (const a of g.accounts) m.set(a.institution, Math.max(m.get(a.institution) ?? 0, a.syncedAt ?? 0));
    return m;
  };
  const was = last(before);
  let done = 0;
  for (const [bank, at] of last(now)) if (at > (was.get(bank) ?? 0)) done++;
  const failed = new Set(before?.failures.map((f) => f.connectionId));
  done += now.failures.filter((f) => !failed.has(f.connectionId)).length;
  return done;
}

function accountSub(a: AccountRow): { text: string; warn: boolean } {
  if (a.connectionStatus !== 'ok') return { text: 'may be out of date', warn: true };
  if (a.kind === 'credit')
    return { text: a.pending > 0 ? `${formatCents(a.pending)} pending at bank` : '', warn: false };
  if (a.pending !== 0) return { text: `after pending ${formatCents(a.working)}`, warn: false };
  return { text: '', warn: false };
}

/** One Accounts alert. A stored one has Dismiss; one about a transaction that still exists opens it. */
function StoredAlert({ a }: { a: AccountsView['alerts'][number] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    if (!a.id) return;
    setBusy(true);
    try {
      await api.dismissAlert(a.id);
      void qc.invalidateQueries({ queryKey: qk.accounts });
    } catch (e) {
      toast.show({ text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner
      tone="warn"
      icon="alert"
      action={
        a.id ? (
          <SoftButton
            tone="outline"
            mutates="offline"
            disabled={busy}
            track={`accounts.alert.dismiss.${a.kind}`}
            onClick={() => void dismiss()}
          >
            Dismiss
          </SoftButton>
        ) : undefined
      }
    >
      {a.text}
      {a.txnKey && (
        <>
          {' '}
          <Link
            to="/activity/txn/$key"
            params={{ key: a.txnKey }}
            data-track={`accounts.alert.open.${a.kind}`}
            className="font-semibold text-inherit underline"
          >
            Open it
          </Link>
        </>
      )}
    </Banner>
  );
}

function SyncFailure({
  f,
}: {
  f: { connectionId: string; institution: string; lastGood: number | null; nextRetry: number | null };
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'failed' | 'trying' | 'ok' | 'error'>('failed');
  const retry = async () => {
    setStep('trying');
    try {
      await api.refreshConnection(f.connectionId);
      setStep('ok');
      void qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: ['budget'] });
    } catch {
      setStep('error');
    }
  };
  const title =
    step === 'trying'
      ? `Syncing ${f.institution}…`
      : step === 'ok'
        ? `${f.institution} is up to date`
        : step === 'error'
          ? `${f.institution} still didn’t sync`
          : `${f.institution} didn’t finish syncing`;
  return (
    <Banner
      tone={step === 'ok' ? 'success' : 'warn'}
      icon={step === 'ok' ? 'check' : 'alert'}
      title={title}
      action={
        (step === 'failed' || step === 'error') && (
          <SoftButton tone="outline" mutates track="accounts.sync.retry" onClick={() => void retry()}>
            Sync now
          </SoftButton>
        )
      }
    />
  );
}

/**
 * At most one banner: a single problem shows as its own one-line banner; several fold into "2 banks need you",
 * which opens to show each. The account rows below still say which balances may be out of date.
 */
function Problems({ items, banks }: { items: ReactElement[]; banks: number }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0]!;
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <button
        type="button"
        data-track="accounts.problems"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 items-center gap-2.5 rounded-lg border border-warn-border bg-warn-bg px-3 py-2.5 text-left text-md font-bold text-warn-fg"
      >
        <Icon name="alert" size={18} stroke={2.4} className="shrink-0" />
        <span className="flex-1">
          {items.length} {banks === items.length ? 'banks need you' : 'things need you'}
        </span>
        <Icon name="chevD" size={18} className={cx('shrink-0 opacity-70', open && 'rotate-180')} />
      </button>
      {open && items}
    </div>
  );
}

export function AccountsScreen() {
  useScreen('accounts');
  const q = useAccounts();
  const desktop = useIsDesktop();
  const v = q.data;
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const scroller = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Syncing runs in the background on the Worker (most banks finish within half a minute). The indicator stays up
  // and the list is checked every few seconds until each bank that started has synced or failed, so new
  // transactions appear as soon as they land instead of after a fixed wait.
  // A phone shows the result in the pull indicator; desktop has none, so it gets a toast.
  const finish = (text: string) => {
    if (desktop) toast.show({ text });
    return text;
  };
  const sync = async (): Promise<string | undefined> => {
    const before = qc.getQueryData<AccountsView>(qk.accounts);
    let started: number;
    try {
      started = (await api.refreshAll()).started;
    } catch (e) {
      toast.show({ text: errorMessage(e) });
      return undefined;
    }
    if (started === 0) return finish('Up to date');
    const until = Date.now() + SYNC_WAIT_MS;
    while (alive.current && Date.now() < until) {
      await new Promise((r) => window.setTimeout(r, SYNC_CHECK_MS));
      if (!alive.current) break;
      // Screens are worked out from the copy on this phone (D-45): bring it up to date first.
      if (getCopy().status === 'ready') await syncNow({ quiet: true }).catch(() => undefined);
      const now = await qc
        .fetchQuery({ queryKey: qk.accounts, queryFn: api.accounts, staleTime: 0 })
        .catch(() => null);
      if (now && banksDone(before, now) >= started) {
        void qc.invalidateQueries();
        return finish('Up to date');
      }
    }
    void qc.invalidateQueries();
    if (alive.current)
      toast.show({ text: 'Your banks are still syncing. New transactions show up in a few minutes.' });
    return undefined;
  };
  const { armed, busy, note, run, body, indicator } = usePullToRefresh(scroller, sync, !desktop && canWrite);
  const syncAction = (
    <HeaderAction
      track="accounts.refresh"
      icon="refresh"
      label={busy ? 'Syncing…' : 'Sync'}
      disabled={!canWrite || busy}
      spin={busy}
      onClick={() => void run()}
      iconOnly={!desktop}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Accounts has no month: balances are today's. Its name sits where the other tabs' month does. */}
      <TabHeader
        name="Accounts"
        left={
          <Link
            to="/settings"
            data-track="accounts.settings"
            aria-label="Settings"
            className="hit flex h-11 w-11 items-center justify-center rounded-full text-ink-2 hover:bg-sunken"
          >
            <Icon name="gear" size={22} />
          </Link>
        }
        right={syncAction}
      />
      {/* The pull indicator sits over the top of the scroller, outside the content the pull moves down. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScreenBody scrollRef={scroller} innerRef={body}>
          {!v ? (
            q.error ? (
              <ErrorNote error={q.error} />
            ) : (
              <Loading />
            )
          ) : (
            <>
              <section className="flex shrink-0 flex-col gap-1 rounded-lg border border-line bg-surface p-3">
                <span className="text-xs text-muted">Net worth</span>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="tnum text-4xl font-bold" data-testid="net-worth">
                    {formatCents(v.netWorth)}
                  </span>
                  <span
                    className={cx(
                      'tnum text-sm font-semibold',
                      v.netWorthChange >= 0 ? 'text-funded-fg' : 'text-over-fg',
                    )}
                  >
                    {formatCents(v.netWorthChange, { plus: true })} in {monthName(v.month)}
                  </span>
                </div>
                <Link
                  to="/owed"
                  search={{ from: 'accounts' }}
                  data-track="accounts.owed"
                  className="mt-1 flex min-h-10 items-center justify-between border-t border-divider pt-1 text-sm text-ink-2 no-underline"
                >
                  <span>Owed to you · not in this total</span>
                  <span className="flex items-center gap-1">
                    <span className="tnum font-bold">{formatCents(v.owedOut)}</span>
                    <Icon name="chevR" size={18} className="text-faint" />
                  </span>
                </Link>
              </section>
              <Problems
                banks={v.repairs.length + v.failures.length}
                items={[
                  ...v.repairs.map((r) => (
                    <Banner
                      key={r.connectionId}
                      tone="warn"
                      icon="alert"
                      to={`/accounts/repair/${r.connectionId}`}
                      track="accounts.repair"
                      title={`${r.institution} needs you to sign in again`}
                    />
                  )),
                  ...v.failures.map((f) => <SyncFailure key={f.connectionId} f={f} />),
                  ...v.alerts.map((a) => <StoredAlert key={a.id ?? a.text} a={a} />),
                ]}
              />
              {v.groups.map((g) => (
                <section key={g.name} className="flex shrink-0 flex-col gap-1.5">
                  <SectionTitle note={<span className="tnum">{formatCents(g.total)}</span>}>
                    {g.name}
                  </SectionTitle>
                  <Card>
                    {g.accounts.map((a) => {
                      const sub = accountSub(a);
                      const credit = a.kind === 'credit';
                      return (
                        <Link
                          key={a.id}
                          to={`/accounts/${a.id}`}
                          data-track="accounts.account"
                          className="flex min-h-14 items-center gap-2.5 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="text-base font-semibold">{a.name}</span>
                            <span
                              className={cx(
                                'text-xs',
                                // Needs a repair: the same warn color as the repair banner.
                                a.connectionStatus !== 'ok' ? 'text-warn-fg' : 'text-muted',
                              )}
                            >
                              {a.meta}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-0.5">
                            <span
                              className={cx(
                                // A card balance isn't a problem: red is kept for overspending and broken links.
                                'tnum text-base font-bold text-ink',
                              )}
                            >
                              {formatCents(credit ? -a.bank : a.bank)}
                            </span>
                            {sub.text && (
                              <span className={cx('text-xs', sub.warn ? 'text-warn-fg' : 'text-muted')}>
                                {sub.text}
                              </span>
                            )}
                            {a.drift !== null && (
                              <span className="tnum text-xs text-muted" data-testid="bank-drift">
                                Differs from bank by {formatCents(Math.abs(a.drift))}
                              </span>
                            )}
                            {a.pendingInBank > 0 && (
                              <span className="tnum text-xs text-muted" data-testid="pending-in-bank">
                                Bank balance includes {formatCents(a.pendingInBank)} pending
                              </span>
                            )}
                          </span>
                          <Icon name="chevR" size={18} className="-ml-1 shrink-0 text-faint" />
                        </Link>
                      );
                    })}
                  </Card>
                </section>
              ))}
              {v.closed.length > 0 && (
                <section className="flex shrink-0 flex-col gap-1.5">
                  <SectionTitle>Closed</SectionTitle>
                  <Card>
                    {v.closed.map((a) => (
                      <Link
                        key={a.id}
                        to={`/accounts/${a.id}`}
                        data-track="accounts.closed"
                        className="flex min-h-12 items-center gap-2.5 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-base text-muted">{a.name}</span>
                          <span className="text-xs text-muted">{a.meta}</span>
                        </span>
                        <Icon name="chevR" size={18} className="-ml-1 shrink-0 text-faint" />
                      </Link>
                    ))}
                  </Card>
                </section>
              )}
            </>
          )}
        </ScreenBody>
        {!desktop && (
          <div
            ref={indicator}
            role="status"
            data-testid="pull-refresh"
            aria-hidden={!busy && !note && !armed}
            style={HIDDEN}
            className="pointer-events-none absolute inset-x-0 top-0 flex h-11 items-center justify-center gap-1.5 text-sm font-semibold text-muted opacity-0"
          >
            <Icon
              name={note ? 'check' : 'refresh'}
              size={16}
              stroke={2.2}
              className={busy ? 'animate-spin' : note ? undefined : 'rotate-[var(--pull-turn,0deg)]'}
            />
            {busy ? 'Syncing banks…' : (note ?? (armed ? 'Release to sync' : 'Pull to sync banks'))}
          </div>
        )}
      </div>
      <Outlet />
    </div>
  );
}
