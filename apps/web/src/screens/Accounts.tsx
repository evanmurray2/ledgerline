// Accounts: net worth, Owed to you under the total, repair banner, failed-sync banner with Try now, cash and
// cards (statement covered). The register is in AccountRegister.tsx and the Repair sheet in AccountRepair.tsx.
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountRow, AccountsView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAccounts, useSession, qk } from '../api/hooks';
import {
  Banner,
  Card,
  cx,
  DESKTOP_WIDTH,
  DesktopHeader,
  HeaderAction,
  ErrorNote,
  Icon,
  Loading,
  useIsDesktop,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { monthName, pacificTime, syncedLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
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

function SyncFailure({
  f,
  today,
}: {
  f: { connectionId: string; institution: string; lastGood: number | null; nextRetry: number | null };
  today: string;
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState<'failed' | 'trying' | 'ok' | 'error'>('failed');
  const canWrite = useCanWrite();
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
        : `${f.institution} didn’t finish syncing`;
  const text =
    step === 'trying'
      ? `Picking up from ${f.lastGood ? pacificTime(f.lastGood) : 'the last good sync'}.`
      : step === 'ok'
        ? 'Synced just now.'
        : `This is usually on the bank’s side.${f.nextRetry ? ` We’ll try again at ${pacificTime(f.nextRetry)}` : ''}${f.lastGood ? `; last good sync was ${syncedLabel(f.lastGood, today)}.` : '.'}`;
  return (
    <section
      role="status"
      className={cx(
        'flex shrink-0 items-start gap-3 rounded-[14px] border p-3',
        step === 'ok'
          ? 'border-success-border bg-success-soft text-funded-fg'
          : 'border-warn-border bg-warn-bg text-warn-fg',
      )}
    >
      <Icon name={step === 'ok' ? 'check' : 'alert'} size={20} stroke={2.4} />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-bold">{title}</span>
        <span className="text-[13px] leading-snug">{text}</span>
      </span>
      {(step === 'failed' || step === 'error') && (
        <button
          type="button"
          data-track="accounts.sync.retry"
          disabled={!canWrite}
          onClick={() => void retry()}
          className="hit h-9 shrink-0 rounded-full bg-surface px-3 text-[13px] font-bold text-ink disabled:opacity-50"
        >
          Try now
        </button>
      )}
    </section>
  );
}

export function AccountsScreen() {
  useScreen('accounts');
  const q = useAccounts();
  const session = useSession();
  const desktop = useIsDesktop();
  const v = q.data;
  const today = session.data?.budget.today ?? '';
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
    if (started === 0) return finish('Already up to date');
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
      toast.show({ text: 'Your banks are still syncing. New transactions show up in a minute or two.' });
    return undefined;
  };
  const { armed, busy, note, run, body, indicator } = usePullToRefresh(scroller, sync, !desktop && canWrite);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {desktop ? (
        <DesktopHeader
          title="Accounts"
          right={
            <HeaderAction
              track="accounts.refresh"
              icon="refresh"
              label={busy ? 'Syncing…' : 'Refresh'}
              disabled={!canWrite || busy}
              spin={busy}
              onClick={() => void run()}
            />
          }
        />
      ) : (
        <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-line bg-surface pl-4 pr-1">
          <h1 className="m-0 text-[22px] font-bold">Accounts</h1>
          <span className="flex items-center">
            <HeaderAction
              track="accounts.refresh"
              icon="refresh"
              label={busy ? 'Syncing…' : 'Refresh'}
              disabled={!canWrite || busy}
              spin={busy}
              onClick={() => void run()}
            />
            <Link
              to="/settings"
              data-track="accounts.settings"
              aria-label="Settings"
              className="flex h-11 w-11 items-center justify-center text-ink-2"
            >
              <Icon name="gear" size={22} />
            </Link>
          </span>
        </header>
      )}
      <div
        ref={scroller}
        className={cx(
          'relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3',
          desktop ? 'px-6' : 'px-4',
        )}
      >
        {!desktop && (
          <div
            ref={indicator}
            role="status"
            data-testid="pull-refresh"
            aria-hidden={!busy && !note && !armed}
            style={HIDDEN}
            className="pointer-events-none absolute inset-x-0 top-0 flex h-11 items-center justify-center gap-1.5 text-[13px] font-semibold text-muted opacity-0"
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
        <div ref={body} className={cx('flex flex-col gap-3', desktop && DESKTOP_WIDTH)}>
          {!v ? (
            q.error ? (
              <ErrorNote error={q.error} />
            ) : (
              <Loading />
            )
          ) : (
            <>
              <section className="flex shrink-0 flex-col gap-1 rounded-[14px] border border-line bg-surface p-3">
                <span className="text-[12px] text-muted">Net worth</span>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="tnum text-[26px] font-bold" data-testid="net-worth">
                    {formatCents(v.netWorth)}
                  </span>
                  <span
                    className={cx(
                      'tnum text-[13px] font-semibold',
                      v.netWorthChange >= 0 ? 'text-funded-fg' : 'text-over-fg',
                    )}
                  >
                    {formatCents(v.netWorthChange, { plus: true })} in {monthName(v.month)}
                  </span>
                </div>
                <Link
                  to="/owed"
                  data-track="accounts.owed"
                  className="mt-1 flex min-h-10 items-center justify-between border-t border-divider pt-1 text-[13px] text-ink-2 no-underline"
                >
                  <span>Owed to you · not in this total</span>
                  <span className="flex items-center gap-1">
                    <span className="tnum font-bold">{formatCents(v.owedOut)}</span>
                    <Icon name="chevR" size={16} className="text-faint" />
                  </span>
                </Link>
              </section>
              {v.repairs.map((r) => (
                <Link
                  key={r.connectionId}
                  to={`/accounts/repair/${r.connectionId}`}
                  data-track="accounts.repair"
                  className="flex min-h-14 shrink-0 items-center gap-2.5 rounded-[14px] border border-warn-border bg-warn-bg px-3 py-2 text-warn-fg no-underline"
                >
                  <Icon name="alert" size={20} stroke={2.4} />
                  <span className="flex flex-1 flex-col gap-px">
                    <span className="text-[14px] font-bold">{r.institution} needs you to sign in again</span>
                    <span className="text-[12px]">
                      Last synced {r.lastSynced ? syncedLabel(r.lastSynced, today) : 'never'}. Repairing keeps
                      the same link.
                    </span>
                  </span>
                  <span className="text-[14px] font-bold underline">Repair</span>
                </Link>
              ))}
              {v.failures.map((f) => (
                <SyncFailure key={f.connectionId} f={f} today={today} />
              ))}
              {v.alerts.map((a) => (
                <Banner key={a.text} tone="warn">
                  {a.text}
                </Banner>
              ))}
              {v.groups.map((g) => (
                <section key={g.name} className="flex shrink-0 flex-col gap-1.5">
                  <div className="flex min-h-9 items-center justify-between px-0.5">
                    <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
                      {g.name}
                    </h2>
                    <span className="tnum text-[13px] font-semibold text-ink-2">{formatCents(g.total)}</span>
                  </div>
                  <Card>
                    {g.accounts.map((a) => {
                      const sub = accountSub(a);
                      const credit = a.kind === 'credit';
                      return (
                        <Link
                          key={a.id}
                          to={`/accounts/${a.id}`}
                          data-track="accounts.account"
                          className="flex min-h-14 items-center justify-between gap-2.5 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
                        >
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[15px] font-semibold">{a.name}</span>
                            <span
                              className={cx(
                                'text-[12px]',
                                a.connectionStatus !== 'ok' ? 'text-under-fg' : 'text-muted',
                              )}
                            >
                              {a.meta}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-0.5">
                            <span
                              className={cx(
                                // A card balance isn't a problem: red is kept for overspending and broken links.
                                'tnum text-[15px] font-bold text-ink',
                              )}
                            >
                              {formatCents(credit ? -a.bank : a.bank)}
                            </span>
                            {sub.text && (
                              <span className={cx('text-[12px]', sub.warn ? 'text-under-fg' : 'text-muted')}>
                                {sub.text}
                              </span>
                            )}
                          </span>
                        </Link>
                      );
                    })}
                  </Card>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
