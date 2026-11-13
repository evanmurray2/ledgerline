// An account's register: balances and its transactions by day, older days a page at a time (Show older); Rename,
// Close and Reopen from the ⋯ menu (Close and Reopen in AccountClose.tsx). On a computer it opens in the side panel.
import { useRef, useState } from 'react';
import { Link, Outlet, useChildMatches, useNavigate, useParams } from '@tanstack/react-router';
import { HIDDEN_CHARS, type AccountRow, type RegisterDay, type RegisterView } from '@ledgerline/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useRegisterPages, useSession } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  BackHeader,
  PageFrame,
  Banner,
  Card,
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
  SoftButton,
  textLinkClass,
  useIsDesktop,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel, syncedLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useBack } from '../lib/back';
import { TxnRow } from './Activity';
import { useCanWrite } from '../state/connectivity';
import { StartBalanceSheet, shownBalance } from './StartBalanceSheet';
import { CloseAccountSheet } from './AccountClose';
import { AccountsScreen } from './Accounts';
import { errorMessage } from '../api/client';
import { toast } from '../components/Toast';

/**
 * What is pending, in the sign the balance above it uses (a card: what you owe). Your own entries and estimates
 * count too, so it doesn't say "at the bank"; a payment pending on a card makes it smaller.
 */
export function pendingLine(a: AccountRow, listed: boolean): string {
  if (a.pending > 0) return `+ ${formatCents(a.pending)} pending`;
  if (a.pending < 0) return `− ${formatCents(-a.pending)} pending`;
  return listed ? 'pending adds up to $0' : 'nothing pending';
}

/**
 * An account's page. On a computer, opened from Accounts, the list stays on the page and the account opens in the
 * side panel; opened from another tab (a card on Budget), it is a page with Back to that tab, as on a phone.
 */
export function RegisterScreen() {
  const { accountId } = useParams({ strict: false }) as { accountId: string };
  const desktop = useIsDesktop();
  const back = useBack();
  if (desktop && !back) return <AccountsScreen panel={<Register accountId={accountId} panel />} />;
  return <Register accountId={accountId} panel={false} />;
}

function Register({ accountId, panel }: { accountId: string; panel: boolean }) {
  useScreen('register');
  const navigate = useNavigate();
  // Opened from Budget (a credit card): Back returns there.
  const back = useBack();
  const pages = useRegisterPages(accountId);
  const session = useSession();
  const v = pages.data;
  const a = v?.account;
  const today = session.data?.budget.today ?? '';
  const [renaming, setRenaming] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [closing, setClosing] = useState(false);
  // A transaction opened from the panel takes the panel; the register waits under it, as it was.
  const child = useChildMatches().length > 0;
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const canRename = useCanWrite({ offline: true });
  // The Starting balance row shows while it may change or a late row is new; after that it moves to the ⋯ menu.
  const start = v?.start ?? null;
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
  const more =
    a && menu.length > 0 ? (
      <OverflowMenu label="More for this account" track="account.menu" items={menu} />
    ) : undefined;
  const sheets = (
    <>
      {renaming && a && <RenameAccountSheet id={a.id} name={a.name} close={() => setRenaming(false)} />}
      {closing && a && (
        <CloseAccountSheet
          account={a}
          block={v?.closeBlock ?? null}
          move={v?.closeMove ?? null}
          close={() => setClosing(false)}
        />
      )}
      {showStart && a && start && (
        <StartBalanceSheet start={start} credit={a.kind === 'credit'} close={() => setShowStart(false)} />
      )}
    </>
  );
  const body =
    !a || !v ? (
      pages.error ? (
        <ErrorNote error={pages.error} />
      ) : (
        <Loading />
      )
    ) : (
      <RegisterBody
        v={v}
        a={a}
        older={pages.older}
        hasOlder={pages.hasOlder}
        loadingOlder={pages.loadingOlder}
        loadOlder={pages.loadOlder}
        openStart={() => setShowStart(true)}
      />
    );
  if (panel)
    return (
      <>
        <Sheet
          label={a?.name ?? 'Account'}
          track="register"
          onClose={() => void navigate({ to: '/accounts' })}
          closeLabel="Close account page"
          hidden={child || renaming || closing || showStart}
          header={
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <SheetTitle title={a?.name ?? 'Account'} sub={a ? registerSub(a, today) : undefined} />
              </div>
              {more}
            </div>
          }
        >
          {body}
        </Sheet>
        {sheets}
      </>
    );
  return (
    <PageFrame>
      <BackHeader
        title={a?.name ?? 'Account'}
        sub={a ? registerSub(a, today) : ''}
        onBack={back ? back.go : () => void navigate({ to: '/accounts' })}
        backLabel={back?.label ?? 'Back to accounts'}
        right={more}
      />
      {sheets}
      <ScreenBody>{body}</ScreenBody>
      <Outlet />
    </PageFrame>
  );
}

/**
 * The line under the account's name. A closed account gets nothing more from the bank, and neither does one whose
 * bank was removed (D-87): its line says so (closed on a day, not linked), not when it last synced.
 */
export function registerSub(a: AccountRow, today: string): string {
  if (a.closed || a.unlinked) return a.meta;
  const synced = a.syncedAt
    ? `${a.connectionStatus === 'ok' ? 'synced' : 'last synced'} ${syncedLabel(a.syncedAt, today)}`
    : 'not synced yet';
  return `${a.institution}${a.mask ? ` · ending ${a.mask}` : ''} · ${synced}${a.connectionStatus === 'error' ? ' · see Accounts' : ''}`;
}

function RegisterBody({
  v,
  a,
  older,
  hasOlder,
  loadingOlder,
  loadOlder,
  openStart,
}: {
  v: RegisterView;
  a: AccountRow;
  older: RegisterDay[];
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<{ isError: boolean }>;
  openStart: () => void;
}) {
  const base = `/accounts/${a.id}`;
  const start = v.start ?? null;
  const startRow = !!start && (start.settling || !!start.recent);
  const pendingListed = v.days.some((d) => d.label === 'Pending');
  const days = [...v.days, ...older];
  const showOlder = async () => {
    if ((await loadOlder()).isError) toast.show({ text: 'Couldn’t load older transactions. Try again.' });
  };
  return (
    <>
      {a.closed && (
        <Banner tone="info">
          This account is closed. It’s off Accounts and the Add list. Reopen it from the ⋯ menu.
        </Banner>
      )}
      {!a.closed && !a.unlinked && a.connectionStatus === 'login_required' && a.connectionId && (
        <Banner
          tone="warn"
          icon="alert"
          title={`${a.institution} needs you to sign in again`}
          action={
            <Link
              to="/accounts/repair/$connectionId"
              params={{ connectionId: a.connectionId }}
              search={{ close: base }}
              data-track="register.repair"
              className={cx(textLinkClass, 'self-center')}
            >
              Sign in
            </Link>
          }
        />
      )}
      <section className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
        {a.kind === 'credit' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted">You owe the bank</span>
                <span className="tnum text-2xl font-bold">{formatCents(a.bank)}</span>
                <span className="text-xs text-muted">{pendingLine(a, pendingListed)}</span>
              </div>
              {a.statement && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted">
                    Statement{a.statement.due ? ` due ${dayLabel(a.statement.due)}` : ''}
                  </span>
                  <span className="tnum text-2xl font-bold">{formatCents(a.statement.balance)}</span>
                  <span className={cx('text-xs', a.statement.covered ? 'text-funded-fg' : 'text-over-fg')}>
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
            onClick={openStart}
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
                <span className="text-xs text-muted">{start.settling ? 'may still change' : 'final'}</span>
              </span>
              <Icon name="chevR" size={18} className="shrink-0 text-faint" />
            </span>
          </button>
        )}
        {start?.recent && (
          <p className="m-0 text-xs leading-snug text-muted" data-testid="start-recent">
            {start.recent.payee} <span className="tnum">{formatCents(Math.abs(start.recent.amount))}</span>{' '}
            from {dayLabel(start.recent.date)} came in late. It’s in your{' '}
            {a.kind === 'credit' ? 'starting debt' : 'starting balance'}, not your budget.
          </p>
        )}
        {a.drift !== null && (
          <p className="m-0 text-xs leading-snug text-muted" data-testid="bank-drift">
            Your transactions differ from the bank balance by{' '}
            <span className="tnum">{formatCents(Math.abs(a.drift))}</span>. One may be missing or doubled.
          </p>
        )}
        {a.pendingInBank > 0 && (
          <p className="m-0 text-xs leading-snug text-muted" data-testid="pending-in-bank">
            The bank balance already counts <span className="tnum">{formatCents(a.pendingInBank)}</span> of
            your pending. Ledgerline counts it once.
          </p>
        )}
        {v.note && <Banner tone="danger">{v.note}</Banner>}
        {a.kind !== 'credit' && (
          <p className="m-0 text-xs leading-snug text-muted">Upcoming bills aren’t subtracted here.</p>
        )}
      </section>
      {v.days.length === 0 && <EmptyNote>No transactions yet.</EmptyNote>}
      {days.map((d) => (
        <section key={d.label} className="flex shrink-0 flex-col gap-1.5">
          <SectionTitle
            note={
              d.balance === null ? (
                d.label === 'Upcoming' ? (
                  'counts on its date'
                ) : a.kind === 'credit' ? (
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
            {/^\d{4}-/.test(d.label) ? dayLabel(d.label) : d.label}
          </SectionTitle>
          <Card>
            {d.rows.map((r) => (
              <TxnRow key={r.key} r={r} base={base} style="register" />
            ))}
          </Card>
        </section>
      ))}
      {hasOlder && (
        <SoftButton track="register.older" disabled={loadingOlder} onClick={() => void showOlder()}>
          {loadingOlder ? 'Loading…' : 'Show older'}
        </SoftButton>
      )}
    </>
  );
}

function RenameAccountSheet({ id, name, close }: { id: string; name: string; close: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Enter while a save runs must not send it again: state is a render late, the ref isn't.
  const saving = useRef(false);
  const next = value.trim();
  const problem = !next
    ? 'Enter a name.'
    : HIDDEN_CHARS.test(next)
      ? 'Use letters, numbers and punctuation only.'
      : null;
  const save = async () => {
    if (saving.current) return;
    // Disabled with its reason above it ("Enter a name."): Enter does nothing either.
    if (problem) return;
    if (next === name) return close();
    saving.current = true;
    setBusy(true);
    try {
      await api.renameAccount(id, { name: next });
      // The name shows on many screens (accounts, activity, budget card rows, settings).
      await qc.invalidateQueries();
      close();
    } catch (e) {
      setError(e);
      setBusy(false);
      saving.current = false;
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
            disabled={!!problem || busy}
            why={problem ?? ''}
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
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
      </Field>
      <p className="m-0 text-sm leading-snug text-muted">
        Only the name in Ledgerline changes. For a card, its payment category is renamed too.
      </p>
    </Sheet>
  );
}
