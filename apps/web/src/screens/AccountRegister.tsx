// An account's register: balances, the filter chips and its transactions by day; Rename, Close and Reopen from the ⋯
// menu (Close and Reopen in AccountClose.tsx).
import { useState } from 'react';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useRegister, useSession } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { SheetTitle } from '../components/Sheet';
import {
  BackHeader,
  PageFrame,
  Banner,
  Card,
  Chip,
  CountBadge,
  cx,
  EmptyNote,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Loading,
  type MenuItem,
  OverflowMenu,
  PrimaryButton,
  ScreenBody,
  SectionTitle,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { useBack } from '../lib/back';
import { dayLabel, syncedLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { TxnRow } from './Activity';
import { useCanWrite } from '../state/connectivity';
import { StartBalanceSheet, shownBalance } from './StartBalanceSheet';
import { CloseAccountSheet } from './AccountClose';
import { errorMessage } from '../api/client';
import { toast } from '../components/Toast';

type Show = 'all' | 'pending' | 'needs' | 'transfers';

export function RegisterScreen() {
  const { accountId } = useParams({ strict: false }) as { accountId: string };
  const search = useSearch({ strict: false }) as { show?: Show; back?: string };
  // Opened from Budget (a credit card): Back returns there.
  const back = useBack();
  const show: Show = search.show ?? 'all';
  useScreen('register');
  const navigate = useNavigate();
  const all = useRegister(accountId, 'all');
  const filtered = useRegister(accountId, show);
  const session = useSession();
  const v = (show === 'all' ? all : filtered).data;
  const a = all.data?.account;
  const rows = (all.data?.days ?? []).flatMap((d) => d.rows);
  const counts = {
    // The same rows as the Pending section and the server's pending filter: anything not posted yet (upcoming too).
    pending: rows.filter((r) => r.status !== 'posted').length,
    needs: rows.filter((r) => r.badge === 'Needs category').length,
    transfers: rows.filter((r) => r.badge === 'Transfer' || r.sheet === 'transfer').length,
  };
  const today = session.data?.budget.today ?? '';
  const base = `/accounts/${accountId}`;
  const [renaming, setRenaming] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [closing, setClosing] = useState(false);
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const canRename = useCanWrite({ offline: true });
  // The Starting balance row shows while it may change or a late row is new; after that it moves to the ⋯ menu.
  const start = all.data?.start ?? null;
  const startRow = !!start && (start.settling || !!start.recent);
  const startName = a?.kind === 'credit' ? 'Starting debt' : 'Starting balance';
  const menu: MenuItem[] = [];
  if (canRename)
    menu.push({ name: 'Rename account', track: 'account.rename', onClick: () => setRenaming(true) });
  if (start && !startRow)
    menu.push({ name: startName, track: 'account.start', onClick: () => setShowStart(true) });
  if (canWrite && a && !a.closed)
    menu.push({ name: 'Close account', track: 'account.close', onClick: () => setClosing(true) });
  const reopen = async () => {
    if (!a) return;
    try {
      await api.reopenAccount(a.id);
      await qc.invalidateQueries();
      toast.show({ text: `${a.name} is open again.` });
    } catch (e) {
      toast.show({ text: errorMessage(e) });
    }
  };
  if (canWrite && a?.closed)
    menu.push({ name: 'Reopen account', track: 'account.reopen', onClick: () => void reopen() });
  const chips: [Show, string, number?][] = [['all', 'All']];
  // The filter on screen keeps its chip after its last row is gone (or from a saved link), so All can clear it.
  if (counts.pending || show === 'pending') chips.push(['pending', 'Pending', counts.pending]);
  if ((a?.kind === 'credit' && counts.needs) || show === 'needs')
    chips.push(['needs', 'Needs category', counts.needs]);
  if ((a?.kind !== 'credit' && counts.transfers) || show === 'transfers')
    chips.push(['transfers', 'Transfers', counts.transfers]);
  const sub = a
    ? `${a.institution}${a.mask ? ` · ending ${a.mask}` : ''} · ${a.syncedAt ? `${a.connectionStatus === 'ok' ? 'synced' : 'last synced'} ${syncedLabel(a.syncedAt, today)}` : 'not synced yet'}${a.connectionStatus === 'login_required' ? ' · sign in again on Accounts' : a.connectionStatus !== 'ok' ? ' · see Accounts' : ''}`
    : '';
  return (
    <PageFrame>
      <BackHeader
        title={a?.name ?? 'Account'}
        sub={sub}
        onBack={back ? back.go : () => void navigate({ to: '/accounts' })}
        backLabel={back?.label ?? 'Back to accounts'}
        right={
          a && menu.length > 0 ? (
            <OverflowMenu label="More for this account" track="account.menu" items={menu} />
          ) : undefined
        }
        below={
          chips.length > 1 && (
            <div role="group" aria-label="Show" className="chip-row">
              {chips.map(([id, name, n]) => (
                <Chip
                  key={id}
                  pressed={show === id}
                  onClick={() =>
                    void navigate({
                      to: base,
                      search: { show: id === 'all' ? undefined : id, back: search.back },
                    })
                  }
                  track={`register.filter.${id}`}
                >
                  {name}
                  {n !== undefined && <CountBadge n={n} inverted={show === id} />}
                </Chip>
              ))}
            </div>
          )
        }
      />
      {renaming && a && <RenameAccountSheet id={a.id} name={a.name} close={() => setRenaming(false)} />}
      {closing && a && (
        <CloseAccountSheet account={a} block={all.data?.closeBlock ?? null} close={() => setClosing(false)} />
      )}
      {showStart && a && start && (
        <StartBalanceSheet start={start} credit={a.kind === 'credit'} close={() => setShowStart(false)} />
      )}
      <ScreenBody>
        {!a || !v ? (
          all.error ? (
            <ErrorNote error={all.error} />
          ) : (
            <Loading />
          )
        ) : (
          <>
            {a.closed && (
              <Banner tone="info">
                This account is closed. It’s off Accounts and the Add list. Reopen it from the ⋯ menu.
              </Banner>
            )}
            <section className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
              {a.kind === 'credit' ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted">You owe the bank</span>
                      <span className="tnum text-2xl font-bold">{formatCents(a.bank)}</span>
                      <span className="text-xs text-muted">
                        {a.pending > 0
                          ? `+ ${formatCents(a.pending)} pending at the bank`
                          : 'nothing pending'}
                      </span>
                    </div>
                    {a.statement && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted">
                          Statement{a.statement.due ? ` due ${dayLabel(a.statement.due)}` : ''}
                        </span>
                        <span className="tnum text-2xl font-bold">{formatCents(a.statement.balance)}</span>
                        <span
                          className={cx('text-xs', a.statement.covered ? 'text-funded-fg' : 'text-over-fg')}
                        >
                          {a.statement.covered ? 'Covered by payment category' : 'Not covered yet'}
                        </span>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between text-md">
                    <span className="text-muted">Balance at bank</span>
                    <span className="tnum font-bold">{formatCents(a.bank)}</span>
                  </div>
                  <div className="flex justify-between text-md">
                    <span className="text-muted">After pending</span>
                    <span className="tnum font-bold">{formatCents(a.working)}</span>
                  </div>
                </>
              )}
              {startRow && (
                <button
                  type="button"
                  data-track="account.start"
                  onClick={() => setShowStart(true)}
                  className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-page px-3 py-2 text-md text-ink"
                >
                  <span className="font-semibold">
                    {a.kind === 'credit' ? 'Starting debt' : 'Starting balance'}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="flex flex-col items-end leading-tight">
                      <span className="tnum font-bold">
                        {formatCents(shownBalance(start.total, a.kind === 'credit'))}
                      </span>
                      <span className="text-xs text-muted">
                        {start.settling ? 'may still change' : 'final'}
                      </span>
                    </span>
                    <Icon name="chevR" size={18} className="shrink-0 text-faint" />
                  </span>
                </button>
              )}
              {start?.recent && (
                <p className="m-0 text-xs leading-snug text-muted" data-testid="start-recent">
                  {start.recent.payee}{' '}
                  <span className="tnum">{formatCents(Math.abs(start.recent.amount))}</span> from{' '}
                  {dayLabel(start.recent.date)} came in late. It’s in your{' '}
                  {a.kind === 'credit' ? 'starting debt' : 'starting balance'}, not your budget.
                </p>
              )}
              {a.drift !== null && (
                <p className="m-0 text-xs leading-snug text-muted" data-testid="bank-drift">
                  Your transactions differ from the bank balance by{' '}
                  <span className="tnum">{formatCents(Math.abs(a.drift))}</span>. One may be missing or
                  doubled.
                </p>
              )}
              {a.pendingInBank > 0 && (
                <p className="m-0 text-xs leading-snug text-muted" data-testid="pending-in-bank">
                  The bank balance already counts <span className="tnum">{formatCents(a.pendingInBank)}</span>{' '}
                  of your pending. Ledgerline counts it once.
                </p>
              )}
              {v.note && <Banner tone="danger">{v.note}</Banner>}
              {a.kind !== 'credit' && (
                <p className="m-0 text-xs leading-snug text-muted">Upcoming bills aren’t subtracted here.</p>
              )}
            </section>
            {v.days.length === 0 && (
              <EmptyNote>{show === 'all' ? 'No transactions yet.' : 'No transactions match.'}</EmptyNote>
            )}
            {v.days.map((d) => (
              <section key={d.label} className="flex shrink-0 flex-col gap-1.5">
                <SectionTitle
                  note={
                    d.balance === null ? (
                      a.kind === 'credit' ? (
                        'counts now'
                      ) : undefined
                    ) : (
                      <span className="tnum">
                        {a.kind === 'credit'
                          ? `Owed ${formatCents(d.balance)}`
                          : `Balance ${formatCents(d.balance)}`}
                      </span>
                    )
                  }
                >
                  {d.label === 'Pending' ? 'Pending' : /^\d{4}-/.test(d.label) ? dayLabel(d.label) : d.label}
                </SectionTitle>
                <Card>
                  {d.rows.map((r) => (
                    <TxnRow key={r.key} r={r} base={base} style="register" />
                  ))}
                </Card>
              </section>
            ))}
          </>
        )}
      </ScreenBody>
      <Outlet />
    </PageFrame>
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
      header={<SheetTitle title="Rename account" />}
      footer={
        <div className="flex flex-col gap-2">
          {error !== null && <ErrorNote error={error} />}
          <PrimaryButton
            mutates="offline"
            track="account.rename.save"
            busy={busy}
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
      <p className="m-0 text-sm leading-snug text-muted">
        Only the name in Ledgerline changes. For a card, its payment category is renamed too.
      </p>
    </Sheet>
  );
}
