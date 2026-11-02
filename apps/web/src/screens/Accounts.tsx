// Accounts: net worth, Owed to you under the total, repair banner, failed-sync banner with Try now, cash and
// cards (statement covered). Card and cash registers. Repair a connection through Plaid Link update mode.
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountRow } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAccounts, useBudget, useRegister, useSession, qk } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import {
  BackHeader,
  Banner,
  Card,
  Chip,
  cx,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Loading,
  PrimaryButton,
  useIsDesktop,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel, monthName, pacificDateTime, pacificTime, syncedLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { runPlaidLink } from '../lib/plaid';
import { TxnRow } from './Activity';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';

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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className={cx(
          'flex min-h-14 shrink-0 items-center justify-between border-b border-line bg-surface',
          desktop ? 'px-6' : 'pl-4 pr-1',
        )}
      >
        <h1 className="m-0 text-[22px] font-bold">Accounts</h1>
        {!desktop && (
          <Link
            to="/settings"
            data-track="accounts.settings"
            aria-label="Settings"
            className="flex h-11 w-11 items-center justify-center text-ink-2"
          >
            <Icon name="gear" size={22} />
          </Link>
        )}
      </header>
      <div
        className={cx('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3', desktop ? 'px-6' : 'px-4')}
      >
        <div className={cx('flex flex-col gap-3', desktop && 'mx-auto w-full max-w-[720px]')}>
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
                  <span className="tnum font-bold">{formatCents(v.owedOut)}</span>
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
                                'tnum text-[15px] font-bold',
                                credit ? 'text-over-fg' : 'text-ink',
                              )}
                            >
                              {formatCents(credit ? -a.bank : a.bank)}
                            </span>
                            {sub.text && (
                              <span className={cx('text-[11px]', sub.warn ? 'text-under-fg' : 'text-muted')}>
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

// ------------------------------------------------------------------ register

type Show = 'all' | 'pending' | 'needs' | 'transfers';

export function RegisterScreen() {
  const { accountId } = useParams({ strict: false }) as { accountId: string };
  const search = useSearch({ strict: false }) as { show?: Show };
  const show: Show = search.show ?? 'all';
  useScreen('register');
  const navigate = useNavigate();
  const all = useRegister(accountId, 'all');
  const filtered = useRegister(accountId, show);
  const session = useSession();
  const budget = useBudget(session.data?.budget.currentMonth);
  const desktop = useIsDesktop();
  const v = (show === 'all' ? all : filtered).data;
  const a = all.data?.account;
  const rows = (all.data?.days ?? []).flatMap((d) => d.rows);
  const counts = {
    pending: rows.filter((r) => r.status === 'pending').length,
    needs: rows.filter((r) => r.badge === 'Needs category').length,
    transfers: rows.filter((r) => r.badge === 'Transfer' || r.sheet === 'transfer').length,
  };
  const card = budget.data?.cards.find((c) => c.accountId === accountId);
  const today = session.data?.budget.today ?? '';
  const base = `/accounts/${accountId}`;
  const [renaming, setRenaming] = useState(false);
  const canWrite = useCanWrite();
  const chips: [Show, string][] = [['all', 'All']];
  if (counts.pending) chips.push(['pending', `Pending ${counts.pending}`]);
  if (a?.kind === 'credit' && counts.needs) chips.push(['needs', `Needs category ${counts.needs}`]);
  if (a?.kind !== 'credit' && counts.transfers) chips.push(['transfers', `Transfers ${counts.transfers}`]);
  const sub = a
    ? `${a.institution}${a.mask ? ` · ending ${a.mask}` : ''} · ${a.connectionStatus === 'ok' ? 'synced' : 'last synced'} ${a.syncedAt ? syncedLabel(a.syncedAt, today) : 'never'}${a.connectionStatus !== 'ok' ? ' · repair on Accounts' : ''}`
    : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BackHeader
        title={a?.name ?? 'Account'}
        sub={sub}
        onBack={() => void navigate({ to: '/accounts' })}
        backLabel="Back to accounts"
        right={a && canWrite ? <AccountMenu onRename={() => setRenaming(true)} /> : undefined}
      />
      {renaming && a && <RenameAccountSheet id={a.id} name={a.name} close={() => setRenaming(false)} />}
      <div
        className={cx('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3', desktop ? 'px-6' : 'px-4')}
      >
        <div className={cx('flex flex-col gap-3', desktop && 'mx-auto w-full max-w-[720px]')}>
          {!a || !v ? (
            all.error ? (
              <ErrorNote error={all.error} />
            ) : (
              <Loading />
            )
          ) : (
            <>
              <section className="flex shrink-0 flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-3">
                {a.kind === 'credit' ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[12px] text-muted">You owe the bank</span>
                        <span className="tnum text-[20px] font-bold">{formatCents(a.bank)}</span>
                        <span className="text-[12px] text-muted">
                          {a.pending > 0
                            ? `+ ${formatCents(a.pending)} pending at the bank`
                            : 'nothing pending'}
                        </span>
                      </div>
                      {a.statement && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[12px] text-muted">
                            Statement{a.statement.due ? ` due ${dayLabel(a.statement.due)}` : ''}
                          </span>
                          <span className="tnum text-[20px] font-bold">
                            {formatCents(a.statement.balance)}
                          </span>
                          <span
                            className={cx(
                              'text-[12px]',
                              a.statement.covered ? 'text-funded-fg' : 'text-over-fg',
                            )}
                          >
                            {a.statement.covered ? 'Covered by payment category' : 'Not covered yet'}
                          </span>
                        </div>
                      )}
                    </div>
                    {card && (
                      <Link
                        to="/budget"
                        className="flex min-h-10 items-center justify-between gap-3 rounded-xl bg-page px-3 py-2 text-[14px] text-ink no-underline"
                      >
                        <span className="font-semibold">{a.name.split(' ')[0]} payment category</span>
                        <span className={cx('tnum font-bold', card.short > 0 ? 'text-over-fg' : 'text-ink')}>
                          {formatCents(card.available)}
                          {card.short > 0 ? ` · ${formatCents(card.short)} short` : ' available'}
                        </span>
                      </Link>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex justify-between text-[14px]">
                      <span className="text-muted">Balance at bank</span>
                      <span className="tnum font-bold">{formatCents(a.bank)}</span>
                    </div>
                    <div className="flex justify-between text-[14px]">
                      <span className="text-muted">After pending and your checks</span>
                      <span className="tnum font-bold">{formatCents(a.working)}</span>
                    </div>
                  </>
                )}
                {v.note && (
                  <p className="m-0 rounded-xl bg-over-bg px-3 py-2 text-[13px] leading-snug text-over-fg">
                    {v.note}
                  </p>
                )}
                {a.kind !== 'credit' && (
                  <p className="m-0 text-[12px] leading-snug text-muted">
                    Upcoming bills aren’t subtracted here; they count in your budget on their dates.
                  </p>
                )}
              </section>
              {chips.length > 1 && (
                <div role="group" aria-label="Show" className="flex gap-2 overflow-x-auto">
                  {chips.map(([id, name]) => (
                    <Chip
                      key={id}
                      pressed={show === id}
                      onClick={() =>
                        void navigate({ to: base, search: { show: id === 'all' ? undefined : id } })
                      }
                      track={`register.filter.${id}`}
                    >
                      {name}
                    </Chip>
                  ))}
                </div>
              )}
              {v.days.length === 0 && (
                <p className="m-0 p-4 text-center text-[14px] text-muted">No transactions here.</p>
              )}
              {v.days.map((d) => (
                <section key={d.label} className="flex shrink-0 flex-col gap-1.5">
                  <div className="flex min-h-8 items-center justify-between px-0.5 text-[12px]">
                    <span className="font-bold uppercase tracking-[0.5px] text-ink-2">
                      {d.label === 'Pending'
                        ? 'Pending'
                        : /^\d{4}-/.test(d.label)
                          ? dayLabel(d.label)
                          : d.label}
                    </span>
                    <span className="tnum text-muted">
                      {d.balance === null
                        ? a.kind === 'credit'
                          ? 'counts now'
                          : ''
                        : a.kind === 'credit'
                          ? `Owed ${formatCents(d.balance)}`
                          : `Balance ${formatCents(d.balance)}`}
                    </span>
                  </div>
                  <Card>
                    {d.rows.map((r) => (
                      <TxnRow key={r.key} r={r} base={base} style="register" />
                    ))}
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

// ------------------------------------------------------------------ repair

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
      header={<h1 className="m-0 text-[20px] font-bold">Repair {inst}</h1>}
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
        <div role="status" className="flex flex-col gap-1 rounded-[14px] bg-success-soft p-3 text-funded-fg">
          <span className="text-[15px] font-bold">{inst} is connected again</span>
          <span className="text-[13px] leading-snug">
            New transactions are coming in. Your rules categorize what they can; anything else waits in
            Activity.
          </span>
        </div>
      ) : step === 'working' ? (
        <div
          role="status"
          className="flex flex-col items-center gap-2 rounded-[14px] bg-page p-5 text-center"
        >
          <span className="text-[15px] font-bold">Catching up on {inst}</span>
          <span className="text-[13px] text-muted">
            Pulling transactions since the last sync. You can leave this screen; we’ll keep going.
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1 rounded-[14px] border border-warn-border bg-warn-bg p-3 text-warn-fg">
            <span className="text-[15px] font-bold">{inst} asked you to sign in again</span>
            <span className="text-[13px] leading-snug">
              This happens when a bank changes its login or asks for a new consent. Nothing is lost: we kept
              everything up to the last sync
              {repair?.lastSynced ? ` on ${syncedLabel(repair.lastSynced, today)}` : ''}.
            </span>
          </div>
          <div className="shrink-0 overflow-hidden rounded-[14px] border border-line">
            {[
              ['Accounts on this login', accts.map((a) => a.name).join(', ') || '—'],
              ['Last good sync', repair?.lastSynced ? pacificDateTime(repair.lastSynced) : '—'],
              ['Balance shown', accts[0] ? `${formatCents(accts[0].bank)} (may be out of date)` : '—'],
              ['Budget effect', 'None until new data arrives'],
            ].map(([k, val]) => (
              <div
                key={k}
                className="flex justify-between gap-3 border-t border-divider px-3 py-2.5 text-[14px] first:border-t-0"
              >
                <span className="text-muted">{k}</span>
                <span className="text-right font-semibold">{val}</span>
              </div>
            ))}
          </div>
          <p className="m-0 text-[13px] leading-snug text-muted">
            Repair opens Plaid’s secure window. You sign in with {inst} there; Ledgerline never sees your bank
            password. Repairing doesn’t use another of your 10 links.
          </p>
          {step === 'exited' && (
            <p className="m-0 text-[13px] text-under-fg">
              You closed the window before finishing. Nothing changed.
            </p>
          )}
          {error ? <ErrorNote error={error} /> : null}
        </>
      )}
    </Sheet>
  );
}

/** The ⋯ button on an account: less-used actions live here, not in the header. */
function AccountMenu({ onRename }: { onRename: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        data-track="account.menu"
        aria-label="More for this account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-11 items-center justify-center text-ink-2"
      >
        <Icon name="more" size={24} stroke={3} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 top-11 z-30 w-52 overflow-hidden rounded-xl border border-line bg-surface shadow-[0_4px_12px_var(--ll-shadow)]"
          >
            <button
              type="button"
              role="menuitem"
              data-track="account.rename"
              onClick={() => {
                setOpen(false);
                onRename();
              }}
              className="flex h-12 w-full items-center px-3 text-left text-[15px] font-semibold text-ink"
            >
              Rename account
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RenameAccountSheet({ id, name, close }: { id: string; name: string; close: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const next = value.trim();
  const save = async () => {
    if (!next || next === name) return close();
    setBusy(true);
    try {
      await api.renameAccount(id, { name: next });
      // The name shows on many screens (accounts, activity, budget card rows, settings).
      await qc.invalidateQueries();
      close();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Sheet
      label="Rename account"
      track="account.rename"
      onClose={close}
      gap="auto"
      closeLabel="Cancel"
      header={<h1 className="m-0 text-[20px] font-bold">Rename account</h1>}
      footer={
        <div className="flex flex-col gap-2">
          {error !== null && <ErrorNote error={error} />}
          <PrimaryButton
            mutates
            track="account.rename.save"
            disabled={!next || busy}
            onClick={() => void save()}
          >
            Save
          </PrimaryButton>
        </div>
      }
    >
      <Field label="Name">
        <input
          className={inputClass}
          value={value}
          maxLength={60}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
      </Field>
      <p className="m-0 text-[13px] leading-snug text-muted">
        Only the name in Ledgerline changes. For a card, its payment category is renamed too.
      </p>
    </Sheet>
  );
}
