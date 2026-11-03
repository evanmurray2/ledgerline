// An account's register: balances, the filter chips and its transactions by day; Rename from the ⋯ menu.
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useBudget, useRegister, useSession } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import {
  BackHeader,
  Card,
  Chip,
  cx,
  DESKTOP_WIDTH,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Loading,
  PrimaryButton,
  useIsDesktop,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel, syncedLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { TxnRow } from './Activity';
import { useCanWrite } from '../state/connectivity';

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
        <div className={cx('flex flex-col gap-3', desktop && DESKTOP_WIDTH)}>
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
                <div role="group" aria-label="Show" className="chip-row">
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
