// First run: Welcome, 1 · Budget start, 2 · Link banks, 3 · Make your categories.
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk, useAccounts, useConnections, useSession } from '../api/hooks';
import { Banner, cx, ErrorNote, Icon, inputClass, PrimaryButton, SoftButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { monthLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { LinkBankFlow } from './Settings';
import { StatusBanner } from '../components/AppShell';
import { Why } from '../components/Why';

function Step({
  n,
  back,
  children,
  footer,
}: {
  n: number;
  back: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full max-w-[560px] flex-col bg-surface">
      <StatusBanner />
      <header className="flex shrink-0 items-center gap-1 py-2 pl-1 pr-4">
        <Link to={back} aria-label="Back" className="flex h-11 w-11 items-center justify-center text-ink-2">
          <Icon name="back" size={22} />
        </Link>
        <span className="text-sm font-semibold text-muted">Step {n} of 3</span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4 pt-2">{children}</main>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-5 pb-6 pt-3">{footer}</div>
    </div>
  );
}

export function WelcomeScreen() {
  useScreen('welcome');
  return (
    <div className="mx-auto flex h-full max-w-[560px] flex-col bg-surface">
      <main className="flex flex-1 flex-col justify-center gap-5 px-6">
        <div
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-lg bg-accent text-on-accent"
        >
          <Icon name="budget" size={30} />
        </div>
        <div className="flex flex-col gap-3">
          <h1 className="m-0 text-4xl font-bold">Ledgerline</h1>
          <p className="m-0 text-xl leading-snug text-ink-2">
            Give every dollar a job. Your banks fill in the transactions. You decide where the money goes.
          </p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-base">
          {[
            'Private to you. Only your passkeys can sign in.',
            'Read-only bank access. Nothing can move money.',
            'Your bank’s records are never edited, only labeled.',
          ].map((t) => (
            <li key={t} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-funded-bg text-funded-fg"
              >
                <Icon name="check" size={13} stroke={3} />
              </span>
              {t}
            </li>
          ))}
        </ul>
      </main>
      <div className="flex flex-col gap-2 px-6 pb-8">
        <Link
          to="/setup/start"
          data-track="welcome.continue"
          className="flex h-12 items-center justify-center rounded-lg bg-accent text-lg font-bold text-on-accent no-underline"
        >
          Get started
        </Link>
      </div>
    </div>
  );
}

export function StartMonthScreen() {
  useScreen('setup.start');
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const month = session.data?.budget.currentMonth;
  const go = async () => {
    if (!month) return;
    setBusy(true);
    try {
      if (session.data?.budget.setupStep === 'start') await api.setupStart({ startMonth: month });
      await qc.invalidateQueries({ queryKey: qk.session });
      void navigate({ to: session.data?.canLinkBanks === false ? '/setup/categories' : '/setup/link' });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Step
      n={1}
      back="/welcome"
      footer={
        <PrimaryButton
          mutates
          track="setup.start.continue"
          busy={busy}
          disabled={!month || busy}
          onClick={() => void go()}
        >
          Continue
        </PrimaryButton>
      }
    >
      <h1 className="m-0 text-4xl font-bold">
        Your budget starts {month ? `in ${monthLabel(month)}` : 'this month'}
      </h1>
      <p className="m-0 text-base leading-snug text-ink-2">
        You start with what’s in your bank accounts today. Older months aren’t budgeted.
      </p>
      <Banner tone="neutral">
        Card balances aren’t subtracted. Each card gets a payment category you fund.
      </Banner>
      {error ? <ErrorNote error={error} /> : null}
    </Step>
  );
}

export function LinkBanksScreen() {
  useScreen('setup.link');
  const session = useSession();
  const conns = useConnections();
  const accounts = useAccounts();
  const linked = (conns.data?.items ?? []).filter((i) => i.status !== 'removed');
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const navigate = useNavigate();
  // Users who can't link banks skip this step (D-75).
  if (session.data?.canLinkBanks === false) return <Navigate to="/setup/categories" />;
  return (
    <Step
      n={2}
      back="/setup/start"
      footer={
        <PrimaryButton
          track="setup.link.continue"
          disabled={linked.length === 0}
          why={linked.length === 0 ? 'Link a bank to continue' : ''}
          onClick={() => void navigate({ to: '/setup/categories' })}
        >
          Continue
        </PrimaryButton>
      }
    >
      <h1 className="m-0 text-4xl font-bold">Link your banks and cards</h1>
      <p className="m-0 text-base leading-snug text-ink-2">
        One bank link can bring in several accounts. Removing a link doesn’t give it back.
      </p>
      {linked.length > 0 && (
        <div className="flex flex-col gap-2">
          {linked.map((l) => (
            <div key={l.id} className="flex flex-col gap-1 rounded-lg border border-line p-3">
              <span className="flex items-center justify-between">
                <span className="text-base font-bold">{l.institution}</span>
                <span className="rounded-full bg-funded-bg px-2.5 py-0.5 text-xs font-bold text-funded-fg">
                  Linked
                </span>
              </span>
              <span className="text-sm text-muted">
                {accts
                  .filter((a) => a.institution === l.institution)
                  .map((a) => `${a.name} ${formatCents(a.kind === 'credit' ? -a.bank : a.bank)}`)
                  .join(' · ') || l.accounts}
              </span>
            </div>
          ))}
        </div>
      )}
      <LinkBankFlow label={linked.length === 0 ? 'Link a bank' : 'Link another bank'} />
      <span className="text-sm text-muted">
        {conns.data?.used ?? 0} of {conns.data?.limit ?? 10} bank links used
      </span>
      <div className="flex flex-col gap-1 text-sm leading-snug text-muted">
        <span>Ledgerline never sees your bank password.</span>
        <span>Purchases from before your budget starts go into the starting balance.</span>
        <Why>
          Some of them can come in up to 2 weeks late. Ledgerline gets 6 months of history, and this can’t be
          changed later. You can import older history from a CSV file in Settings. Investment and retirement
          accounts aren’t tracked. Money you send to them counts as Invested.
        </Why>
      </div>
    </Step>
  );
}

const IDEAS: { name: string; bills: boolean; items: string[]; off: string[] }[] = [
  {
    name: 'Bills',
    bills: true,
    items: ['Rent', 'Electric', 'Internet', 'Phone', 'Subscriptions'],
    off: ['Phone'],
  },
  {
    name: 'Everyday',
    bills: false,
    items: [
      'Groceries',
      'Dining out',
      'Gas',
      'Shopping',
      'Household',
      'Health',
      'Personal care',
      'Pet',
      'Kids',
    ],
    off: ['Pet', 'Kids'],
  },
  {
    name: 'Savings',
    bills: false,
    items: ['Investments', 'Car insurance', 'Vacation', 'Gifts', 'Emergency fund', 'Home repairs', 'Gym'],
    off: ['Gym'],
  },
];

export function FirstSortScreen() {
  useScreen('setup.categories');
  const accounts = useAccounts();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const [on, setOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(IDEAS.flatMap((g) => g.items.map((i) => [i, !g.off.includes(i)]))),
  );
  const [custom, setCustom] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const cash = accts.filter((a) => a.kind !== 'credit').reduce((s, a) => s + a.bank, 0);
  const count = Object.values(on).filter(Boolean).length + custom.length;
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      // A try again after a failure part way keeps what the first try made, instead of making it twice.
      const have = await api.categories();
      for (const g of IDEAS) {
        const names = g.items.filter((i) => on[i]).concat(g.name === 'Everyday' ? custom : []);
        if (!names.length) continue;
        const made = have.groups.find((x) => !x.system && x.name === g.name);
        const id = made?.id ?? (await api.upsertGroup({ name: g.name, isBills: g.bills })).id;
        const taken = new Set(made?.categories.map((c) => c.name.toLowerCase()));
        for (const n of names)
          if (!taken.has(n.toLowerCase()))
            await api.upsertCategory({
              name: n,
              groupId: id,
              kind: n === 'Investments' ? 'saving' : 'spending',
            });
      }
      await api.startingBalances({
        accounts: accts.map((a) => ({
          accountId: a.id,
          startingBalance: a.kind === 'credit' ? -a.bank : a.bank,
        })),
      });
      await qc.invalidateQueries();
      void navigate({ to: '/budget' });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Step
      n={3}
      back={session.data?.canLinkBanks === false ? '/setup/start' : '/setup/link'}
      footer={
        <>
          <span className="text-center text-sm text-muted">
            {count} {count === 1 ? 'category' : 'categories'}
            {cash > 0 ? ` · next, assign your ${formatCents(cash)}` : ''}
          </span>
          <PrimaryButton
            mutates
            track="setup.finish"
            busy={busy}
            disabled={busy || count === 0}
            why={count === 0 ? 'Keep or add at least one category' : ''}
            onClick={() => void finish()}
          >
            Go to my budget
          </PrimaryButton>
          {error ? <ErrorNote error={error} /> : null}
        </>
      }
    >
      <h1 className="m-0 text-4xl font-bold">Make your categories</h1>
      <p className="m-0 text-base leading-snug text-ink-2">
        Tap to keep the ideas you want, or type your own. You can rename, group and add targets any time.
      </p>
      {IDEAS.map((g) => (
        <section key={g.name} className="flex flex-col gap-2">
          <h2 className="m-0 text-sm font-bold uppercase tracking-caps text-ink-2">{g.name}</h2>
          <div className="flex flex-wrap gap-2">
            {g.items.concat(g.name === 'Everyday' ? custom : []).map((n) => {
              const sel = custom.includes(n) || !!on[n];
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={sel}
                  data-track="setup.category.toggle"
                  onClick={() =>
                    custom.includes(n)
                      ? setCustom(custom.filter((c) => c !== n))
                      : setOn({ ...on, [n]: !on[n] })
                  }
                  className={cx(
                    'hit h-9 rounded-full border px-3.5 text-md font-semibold',
                    sel
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line-strong bg-surface text-ink-2',
                  )}
                >
                  {sel ? '✓ ' : '+ '}
                  {n}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = draft.trim();
          const same = (x: string) => x.toLowerCase() === n.toLowerCase();
          // One of the ideas, typed: keep that idea instead of adding it twice.
          const idea = IDEAS.flatMap((g) => g.items).find(same);
          if (idea) setOn({ ...on, [idea]: true });
          else if (n && !custom.some(same)) setCustom([...custom, n]);
          setDraft('');
        }}
      >
        <input
          aria-label="New category name"
          placeholder="Add your own, e.g. Climbing"
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          className={cx(inputClass, 'min-w-0 flex-1')}
        />
        <SoftButton type="submit" track="setup.category.add">
          Add
        </SoftButton>
      </form>
      <p className="m-0 text-sm leading-snug text-muted">
        Ledgerline also makes a payment category for each card. Money others owe you shows in Owed to you.
      </p>
    </Step>
  );
}
