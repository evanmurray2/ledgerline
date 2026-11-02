// First run: Welcome, 1 · Budget start, 2 · Link banks, 3 · Make your categories.
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk, useAccounts, useConnections, useSession } from '../api/hooks';
import { cx, ErrorNote, Icon, OptionCard, PrimaryButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { monthLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { LinkBankFlow } from './Settings';
import { StatusBanner } from '../components/AppShell';

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
        <span className="text-[13px] font-semibold text-muted">Step {n} of 3</span>
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
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-on-accent"
        >
          <Icon name="budget" size={30} />
        </div>
        <div className="flex flex-col gap-3">
          <h1 className="m-0 text-[32px] font-bold">Ledgerline</h1>
          <p className="m-0 text-[17px] leading-snug text-ink-2">
            Give every dollar a job. Your banks fill in the transactions; you decide where the money goes.
          </p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[15px]">
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
          className="flex h-12 items-center justify-center rounded-xl bg-accent text-[16px] font-bold text-on-accent no-underline"
        >
          Get started
        </Link>
        <span className="text-center text-[12px] text-muted">Next, pick the month your budget starts.</span>
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
      void navigate({ to: '/setup/link' });
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
          disabled={!month || busy}
          onClick={() => void go()}
        >
          Continue
        </PrimaryButton>
      }
    >
      <h1 className="m-0 text-[24px] font-bold">When does your budget start?</h1>
      <p className="m-0 text-[15px] leading-snug text-ink-2">
        Transactions from this month on go in your budget. Anything earlier is history: you can search it and
        see it in reports, but it never changes what you have to assign.
      </p>
      <OptionCard
        selected
        onClick={() => undefined}
        title={`Start this month${month ? ` (${monthLabel(month)})` : ''}`}
        desc="Begin with what you have today. Past bank history is imported for reports and rules, but past months aren’t re-budgeted."
      />
      <p className="m-0 rounded-xl bg-page p-3 text-[13px] leading-snug text-muted">
        Your starting money is what’s in your linked checking and savings today. What you owe on cards isn’t
        subtracted: each card gets a payment category to fund instead. You’ll assign it in step 3.
      </p>
      {error ? <ErrorNote error={error} /> : null}
    </Step>
  );
}

export function LinkBanksScreen() {
  useScreen('setup.link');
  const conns = useConnections();
  const accounts = useAccounts();
  const linked = (conns.data?.items ?? []).filter((i) => i.status !== 'removed');
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const navigate = useNavigate();
  return (
    <Step
      n={2}
      back="/setup/start"
      footer={
        <PrimaryButton
          track="setup.link.continue"
          disabled={linked.length === 0}
          onClick={() => void navigate({ to: '/setup/categories' })}
        >
          Continue
        </PrimaryButton>
      }
    >
      <h1 className="m-0 text-[24px] font-bold">Link your banks and cards</h1>
      <p className="m-0 text-[15px] leading-snug text-ink-2">
        One login can bring in several accounts. You have {conns.data?.limit ?? 10} logins in total, and they
        don’t come back if you remove one.
      </p>
      {linked.length > 0 && (
        <div className="flex flex-col gap-2">
          {linked.map((l) => (
            <div key={l.id} className="flex flex-col gap-1 rounded-[14px] border border-line p-3">
              <span className="flex items-center justify-between">
                <span className="text-[15px] font-bold">{l.institution}</span>
                <span className="rounded-full bg-funded-bg px-2.5 py-0.5 text-[12px] font-bold text-funded-fg">
                  Linked
                </span>
              </span>
              <span className="text-[13px] text-muted">
                {accts
                  .filter((a) => a.institution === l.institution)
                  .map((a) => `${a.name} ${formatCents(a.kind === 'credit' ? -a.bank : a.bank)}`)
                  .join(' · ') || l.accounts}
              </span>
            </div>
          ))}
        </div>
      )}
      <LinkBankFlow label={linked.length === 0 ? '+ Link a bank' : '+ Link another bank'} />
      <span className="text-[13px] text-muted">
        {conns.data?.used ?? 0} of {conns.data?.limit ?? 10} logins used
      </span>
      <p className="m-0 text-[13px] leading-snug text-muted">
        Linking opens Plaid’s secure window; Ledgerline never sees your bank password. We ask for 6 months of
        history, which can’t be changed later. Older history can be imported from a CSV file in Settings.
      </p>
      <p className="m-0 text-[13px] leading-snug text-muted">
        Only bank accounts and cards are tracked. Investment and retirement accounts stay outside the app;
        money you send to them counts as Invested.
      </p>
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
      for (const g of IDEAS) {
        const names = g.items.filter((i) => on[i]).concat(g.name === 'Everyday' ? custom : []);
        if (!names.length) continue;
        const { id } = await api.upsertGroup({ name: g.name, isBills: g.bills });
        for (const n of names)
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
      back="/setup/link"
      footer={
        <>
          <span className="text-center text-[13px] text-muted">
            {count} categories · next, assign your {formatCents(cash)}
          </span>
          <PrimaryButton
            mutates
            track="setup.finish"
            disabled={busy || count === 0}
            onClick={() => void finish()}
          >
            Go to my budget
          </PrimaryButton>
          {error ? <ErrorNote error={error} /> : null}
        </>
      }
    >
      <h1 className="m-0 text-[24px] font-bold">Make your categories</h1>
      <p className="m-0 text-[15px] leading-snug text-ink-2">
        Tap to keep the ideas you want, or type your own. You can rename, group and add targets any time.
      </p>
      {IDEAS.map((g) => (
        <section key={g.name} className="flex flex-col gap-2">
          <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">{g.name}</h2>
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
                    'hit h-9 rounded-full border px-3.5 text-[14px] font-semibold',
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
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = draft.trim();
          if (n && !custom.includes(n)) setCustom([...custom, n]);
          setDraft('');
        }}
      >
        <input
          aria-label="New category name"
          placeholder="Add your own, e.g. Climbing"
          value={draft}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          className="h-11 flex-1 rounded-[10px] border border-line-strong bg-surface px-3 text-[16px]"
        />
        <button
          type="submit"
          data-track="setup.category.add"
          className="h-11 rounded-[10px] bg-accent-soft px-4 text-[14px] font-bold text-accent"
        >
          Add
        </button>
      </form>
      <p className="m-0 text-[13px] leading-snug text-muted">
        Also made for you: a payment category for each card. Money you front for others is tracked in an Owed
        to you list, not a category.
      </p>
    </Step>
  );
}
