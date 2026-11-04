// An account's register: balances, the filter chips and its transactions by day; Rename from the ⋯ menu.
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useBudget, useRegister, useSession } from '../api/hooks';
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
  OverflowMenu,
  PrimaryButton,
  ScreenBody,
  SectionTitle,
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
  const chips: [Show, string, number?][] = [['all', 'All']];
  if (counts.pending) chips.push(['pending', 'Pending', counts.pending]);
  if (a?.kind === 'credit' && counts.needs) chips.push(['needs', 'Needs category', counts.needs]);
  if (a?.kind !== 'credit' && counts.transfers) chips.push(['transfers', 'Transfers', counts.transfers]);
  const sub = a
    ? `${a.institution}${a.mask ? ` · ending ${a.mask}` : ''} · ${a.connectionStatus === 'ok' ? 'synced' : 'last synced'} ${a.syncedAt ? syncedLabel(a.syncedAt, today) : 'never'}${a.connectionStatus !== 'ok' ? ' · repair on Accounts' : ''}`
    : '';
  return (
    <PageFrame>
      <BackHeader
        title={a?.name ?? 'Account'}
        sub={sub}
        onBack={() => void navigate({ to: '/accounts' })}
        backLabel="Back to accounts"
        right={
          a && canWrite ? (
            <OverflowMenu
              label="More for this account"
              track="account.menu"
              items={[{ name: 'Rename account', track: 'account.rename', onClick: () => setRenaming(true) }]}
            />
          ) : undefined
        }
        below={
          chips.length > 1 && (
            <div role="group" aria-label="Show" className="chip-row">
              {chips.map(([id, name, n]) => (
                <Chip
                  key={id}
                  pressed={show === id}
                  onClick={() => void navigate({ to: base, search: { show: id === 'all' ? undefined : id } })}
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
      <ScreenBody>
        {!a || !v ? (
          all.error ? (
            <ErrorNote error={all.error} />
          ) : (
            <Loading />
          )
        ) : (
          <>
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
                  {card && (
                    <Link
                      to="/budget"
                      className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-page px-3 py-2 text-md text-ink no-underline"
                    >
                      <span className="font-semibold">{a.name.split(' ')[0]} payment category</span>
                      <span className="flex items-center gap-1">
                        {/* The amount on one line, its status under it, so the two never wrap together. */}
                        <span className="flex flex-col items-end leading-tight">
                          <span
                            className={cx('tnum font-bold', card.short > 0 ? 'text-over-fg' : 'text-ink')}
                          >
                            {formatCents(card.available)}
                          </span>
                          <span
                            className={cx(
                              'tnum text-xs',
                              card.short > 0 ? 'font-semibold text-over-fg' : 'text-muted',
                            )}
                          >
                            {card.short > 0 ? `${formatCents(card.short)} short` : 'available'}
                          </span>
                        </span>
                        <Icon name="chevR" size={18} className="shrink-0 text-faint" />
                      </span>
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <div className="flex justify-between text-md">
                    <span className="text-muted">Balance at bank</span>
                    <span className="tnum font-bold">{formatCents(a.bank)}</span>
                  </div>
                  <div className="flex justify-between text-md">
                    <span className="text-muted">After pending and your checks</span>
                    <span className="tnum font-bold">{formatCents(a.working)}</span>
                  </div>
                </>
              )}
              {v.note && <Banner tone="danger">{v.note}</Banner>}
              {a.kind !== 'credit' && (
                <p className="m-0 text-xs leading-snug text-muted">
                  Upcoming bills aren’t subtracted here; they count in your budget on their dates.
                </p>
              )}
            </section>
            {v.days.length === 0 && <EmptyNote>No transactions here.</EmptyNote>}
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
            mutates
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
