// Match money back, Transfer: pick the other side, Check not cleared, Add pending or upcoming.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQueries } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useAccounts, useMatchView, useMoneyMutation, useTxn, useSession, useBudget, qk } from '../api/hooks';
import { CategoryField } from '../components/CategoryPicker';
import { Sheet } from '../components/Sheet';
import {
  Button,
  cx,
  ErrorNote,
  Field,
  inputClass,
  Loading,
  OptionCard,
  PrimaryButton,
  SecondaryButton,
  Segmented,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useParentPath } from './TxnSheets';
import { usage } from '../usage/tracker';

function useClose() {
  const navigate = useNavigate();
  const parent = useParentPath();
  return () => void navigate({ to: parent });
}

function useRta() {
  const session = useSession();
  return useBudget(session.data?.budget.currentMonth).data?.rta;
}

// ------------------------------------------------------------------ match

type Rest = 'keep' | 'income' | 'send_back';

export function MatchScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('match');
  const q = useMatchView(key);
  const close = useClose();
  const parent = useParentPath();
  const match = useMoneyMutation(api.doMatch);
  const unlink = useMoneyMutation(api.unlink);
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
  const [rest, setRest] = useState<Rest>('keep');
  const [other, setOther] = useState(false);
  const [done, setDone] = useState<{ text: string } | null>(null);
  const rta = useRta();
  const v = q.data;

  useEffect(() => {
    usage.startTask('match');
    return () => usage.cancelTask('match');
  }, []);
  useEffect(() => {
    if (v && on === null) setOn(Object.fromEntries(v.open.map((o) => [o.id, o.suggested > 0])));
  }, [v, on]);

  if (!v || !on)
    return (
      <Sheet label="Match money back" track="match" onClose={close} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const inflow = v.inflow.amount;
  let left = inflow;
  const applied = v.open.map((o) => {
    const a = on[o.id] ? Math.min(o.still, Math.max(left, 0)) : 0;
    left -= a;
    return { ...o, applied: a };
  });
  const matched = inflow - left;
  const paidCount = applied.filter((a) => a.applied > 0 && a.applied >= a.still).length;
  const submit = async (asIncome: boolean) => {
    const items = asIncome
      ? []
      : applied.filter((a) => a.applied > 0).map((a) => ({ itemId: a.id, amount: a.applied }));
    const r = await match.mutateAsync({
      inflowKey: v.inflow.key,
      items,
      rest: asIncome ? 'income' : left > 0 ? rest : 'income',
    });
    usage.endTask('match');
    setDone({
      text: asIncome
        ? `Counted as income. Ready to Assign is now ${formatCents(r.rta)}.`
        : `Matched ${formatCents(matched)}. ${paidCount} ${paidCount === 1 ? 'item is' : 'items are'} paid back, and Ready to Assign is now ${formatCents(r.rta)}.`,
    });
  };
  return (
    <Sheet
      label="Match money back"
      track="match"
      onClose={close}
      gap="small"
      header={
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] text-muted">
            {v.inflow.payee} · {v.inflow.accountName} · {dayLabel(v.inflow.date)}
          </span>
          <h1 className="tnum m-0 text-[28px] font-bold text-funded-fg">
            {formatCents(inflow, { plus: true })}
          </h1>
          {!done && (
            <>
              <span className="text-[15px] font-bold">What is this money?</span>
              <span className="text-[13px] text-muted">
                It’s held in Waiting to match, outside Ready to Assign, until you decide.
              </span>
            </>
          )}
        </div>
      }
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <p
            role="status"
            className="m-0 rounded-xl bg-success-soft p-3 text-[14px] leading-snug text-funded-fg"
          >
            {done.text}
          </p>
          <div className="flex gap-2">
            <SecondaryButton
              mutates
              track="match.undo"
              className="flex-1"
              onClick={async () => {
                await unlink.mutateAsync(v.inflow.key);
                usage.undo('match');
                setDone(null);
              }}
            >
              Undo
            </SecondaryButton>
            <Link
              to="/owed"
              className="flex h-12 flex-[2] items-center justify-center rounded-xl bg-accent text-[16px] font-bold text-on-accent no-underline"
            >
              See what’s still owed
            </Link>
          </div>
        </div>
      ) : (
        <>
          <h2 className="m-0 text-[12px] font-bold uppercase tracking-[0.4px] text-ink-2">
            Money back for what’s owed to you
          </h2>
          <div className="shrink-0 overflow-hidden rounded-[14px] border border-line">
            {applied.length === 0 && (
              <p className="m-0 p-3 text-[14px] text-muted">Nothing is marked as owed to you.</p>
            )}
            {applied.map((a) => (
              <label
                key={a.id}
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-1.5 first:border-t-0"
              >
                <input
                  type="checkbox"
                  className="hit h-[22px] w-[22px] shrink-0 accent-[var(--ll-accent)]"
                  checked={!!on[a.id]}
                  data-track="match.item"
                  onChange={() => setOn({ ...on, [a.id]: !on[a.id] })}
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold">{a.label}</span>
                  <span className={cx('text-[12px]', a.late ? 'text-over-fg' : 'text-muted')}>
                    {a.expectBy ? `${a.late ? 'Late · ' : ''}expected by ${dayLabel(a.expectBy)}` : 'No date'}
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="tnum text-[15px] font-bold">
                    {on[a.id] ? formatCents(a.applied) : '—'}
                  </span>
                  <span className="text-[11px] text-muted">
                    {on[a.id] && a.applied < a.still
                      ? `of ${formatCents(a.still)}, rest stays owed`
                      : `of ${formatCents(a.still)}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {other ? (
            <p className="m-0 rounded-xl bg-page p-3 text-[13px] leading-snug text-muted">
              To match money back for something you didn’t mark, open that purchase in Activity and set Owed
              to you first. It then shows up here.
            </p>
          ) : (
            <button
              type="button"
              data-track="match.other"
              onClick={() => setOther(true)}
              className="min-h-9 self-start text-[14px] font-bold text-accent"
            >
              It’s for something I didn’t mark…
            </button>
          )}
          {left > 0 && matched > 0 && (
            <fieldset className="m-0 flex flex-col gap-2 rounded-xl border border-line p-3">
              <legend className="px-1 text-[13px] font-bold text-ink-2">The other {formatCents(left)}</legend>
              {(
                [
                  ['keep', 'Keep it waiting to match'],
                  ['income', 'Income (goes to Ready to Assign)'],
                  ['send_back', 'I’ll send it back (stays out of Ready to Assign until the money leaves)'],
                ] as const
              ).map(([id, name]) => (
                <label key={id} className="flex min-h-9 items-center gap-2 text-[14px]">
                  <input
                    type="radio"
                    name="rest"
                    className="hit h-5 w-5 accent-[var(--ll-accent)]"
                    checked={rest === id}
                    onChange={() => setRest(id)}
                  />
                  {name}
                </label>
              ))}
            </fieldset>
          )}
          <p className="m-0 text-[12px] leading-snug text-muted">
            Either way the money goes to Ready to Assign. Matching also marks what it pays back as settled, so
            it leaves your Owed to you list. Pick “It’s income” if it doesn’t pay anything back.
            {rta !== undefined ? ` Ready to Assign has ${formatCents(rta)} now.` : ''}
          </p>
          {match.error && <ErrorNote error={match.error} />}
          <div className="flex gap-2 pb-4">
            <SecondaryButton
              mutates
              track="match.income"
              className="flex-1"
              onClick={() => void submit(true)}
            >
              It’s income
            </SecondaryButton>
            <PrimaryButton
              mutates
              track="match.apply"
              className="flex-[2]"
              disabled={matched === 0}
              onClick={() => void submit(false)}
            >
              {matched === 0 ? 'Pick what it pays back' : `Match ${formatCents(matched)}`}
            </PrimaryButton>
          </div>
          <span className="sr-only">
            <Link to={parent}>Back</Link>
          </span>
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ transfer pick

export function TransferScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('transfer.pick');
  const q = useTxn(key);
  const close = useClose();
  const accounts = useAccounts();
  const pick = useMoneyMutation((v: { otherKey: string | null }) => api.pickTransfer(key, v));
  const unpair = useMoneyMutation(api.unpairTransfer);
  const [result, setResult] = useState<string | null>(null);
  const t = q.data;
  const others = (accounts.data?.groups ?? [])
    .flatMap((g) => g.accounts)
    .filter((a) => t && a.id !== t.accountId);
  const registers = useQueries({
    queries: others.map((a) => ({
      queryKey: qk.register(a.id, 'all'),
      queryFn: () => api.register(a.id, 'all'),
      enabled: !!t,
    })),
  });
  if (!t)
    return (
      <Sheet label="Which account got this money" track="transfer" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  // The contract has no candidate list: find deposits of the same amount within 5 days in the other accounts.
  const day = (d: string) =>
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
  const candidates = registers.flatMap((r, i) =>
    (r.data?.days ?? [])
      .flatMap((d) => d.rows)
      .filter((row) => row.amount === -t.amount && Math.abs(day(row.date) - day(t.date)) <= 5)
      .map((row) => ({ row, account: others[i]! })),
  );
  const loadingCands = registers.some((r) => r.isLoading);
  const lines = (name: string | null) =>
    name === null
      ? `Kept as spending: it now needs a category. ${candidates.length > 1 ? 'Both deposits are' : 'The deposit is'} income, so Ready to Assign goes up.`
      : `Paired with ${name}. No category needed for the transfer.${candidates.length > 1 ? ' The other deposit is income, so Ready to Assign goes up.' : ''}`;
  return (
    <Sheet
      label="Which account got this money"
      track="transfer"
      onClose={close}
      gap="auto"
      header={
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] text-muted">
            {t.accountName} · {dayLabel(t.date)} · “{t.rawName}”
          </span>
          <h1 className="tnum m-0 text-[28px] font-bold">{formatCents(t.amount)}</h1>
          <span className="text-[15px] font-bold">Where did this go?</span>
        </div>
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        {result ? (
          <>
            <p
              role="status"
              className="m-0 rounded-xl bg-success-soft p-3 text-[14px] leading-snug text-funded-fg"
            >
              {result}
            </p>
            <div className="flex gap-2">
              <SecondaryButton
                mutates
                track="transfer.undo"
                className="flex-1"
                onClick={async () => {
                  await unpair.mutateAsync(key);
                  usage.undo('transfer_pick');
                  setResult(null);
                }}
              >
                Undo
              </SecondaryButton>
              <PrimaryButton className="flex-[2]" onClick={close}>
                Done
              </PrimaryButton>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-[13px] leading-snug text-muted">
              Transfers between your accounts pair up on their own. This one couldn’t:{' '}
              {candidates.length > 1
                ? `${candidates.length} accounts received ${formatCents(-t.amount)} within a few days.`
                : 'no single account clearly matched.'}
            </p>
            {loadingCands && <Loading label="Looking for the other side" />}
            <div className="flex flex-col gap-2">
              {candidates.map(({ row, account }) => (
                <Button
                  key={row.key}
                  mutates
                  track="transfer.pick"
                  onClick={async () => {
                    await pick.mutateAsync({ otherKey: row.key });
                    usage.suggestion('transfer_pick', 'paired');
                    setResult(lines(account.name));
                  }}
                  className="flex min-h-14 w-full items-center justify-between gap-2 rounded-xl border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="flex flex-col">
                    <span className="text-[15px] font-semibold">{account.name}</span>
                    <span className="text-[12px] text-muted">
                      {dayLabel(row.date)} · “{row.payee}”
                    </span>
                  </span>
                  <span className="tnum font-bold text-funded-fg">
                    {formatCents(row.amount, { plus: true })}
                  </span>
                </Button>
              ))}
              <Button
                mutates
                track="transfer.none"
                onClick={async () => {
                  await pick.mutateAsync({ otherKey: null });
                  setResult(lines(null));
                }}
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-xl border border-line-strong bg-surface px-3 py-2 text-left"
              >
                <span className="text-[15px] font-semibold">Neither, it was a payment</span>
                <span className="text-[12px] text-muted">Categorize it like any other spending</span>
              </Button>
            </div>
            {pick.error && <ErrorNote error={pick.error} />}
          </>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ check not cleared

type CheckPick = 'wait' | 'edit' | 'match' | 'delete';

export function CheckPendingScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('check_pending');
  const q = useTxn(key);
  const close = useClose();
  const keep = useMoneyMutation((v: { action: 'keep_waiting' | 'delete' }) => api.pendingCheck(key, v));
  const patch = useMoneyMutation((v: Parameters<typeof api.patchTxn>[1]) => api.patchTxn(key, v));
  const [pick, setPick] = useState<CheckPick>('wait');
  const [amount, setAmount] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const t = q.data;
  if (!t)
    return (
      <Sheet label="Check" track="check" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const cat = t.categoryLabel ?? 'Its category';
  const amt = amount ?? centsToInput(Math.abs(t.amount));
  const days = 9;
  const opts: { id: CheckPick; name: string; desc: string; cta: string; result: string }[] = [
    {
      id: 'wait',
      name: 'Keep waiting',
      desc: 'Leave it as is. You won’t be asked again for 14 days.',
      cta: 'Keep waiting',
      result: 'Still pending. You’ll be asked again in 14 days if it hasn’t cleared.',
    },
    {
      id: 'edit',
      name: 'Fix the amount or date',
      desc: 'If you wrote it for a different amount or day.',
      cta: 'Save changes',
      result: 'Saved. It keeps waiting for the bank.',
    },
    {
      id: 'match',
      name: 'Match it by hand',
      desc: 'Pick the bank transaction if the bank shows it under another name.',
      cta: 'Nothing to match yet',
      result: '',
    },
    {
      id: 'delete',
      name: 'Delete it',
      desc: `The check was voided or never sent. ${cat} gets its ${formatCents(Math.abs(t.amount), { whole: true })} back.`,
      cta: 'Delete check',
      result: `Deleted. ${cat} got ${formatCents(Math.abs(t.amount))} back.`,
    },
  ];
  const cur = opts.find((o) => o.id === pick)!;
  const confirm = async () => {
    if (pick === 'match') return;
    if (pick === 'edit') {
      const c = parseCents(amt);
      if (c === null) return;
      await patch.mutateAsync({ estimatedAmount: c });
    } else await keep.mutateAsync({ action: pick === 'delete' ? 'delete' : 'keep_waiting' });
    setDone(cur.result);
  };
  return (
    <Sheet
      label={t.payee}
      track="check"
      onClose={close}
      gap="auto"
      header={
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] text-muted">
            {t.payee} · {t.accountName} · added by you {dayLabel(t.date)}
          </span>
          <h1 className="tnum m-0 text-[28px] font-bold">{formatCents(t.amount)}</h1>
          <span className="text-[13px] font-semibold text-under-fg">
            Not at the bank after {days} days · {cat}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-2 pb-4">
        {done ? (
          <>
            <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[14px] text-funded-fg">
              {done}
            </p>
            <PrimaryButton onClick={close}>Done</PrimaryButton>
          </>
        ) : (
          <>
            <p className="m-0 text-[13px] leading-snug text-muted">
              It still counts in {cat} and your checking balance. Checks often take a few weeks to be cashed.
            </p>
            {opts.map((o) => (
              <OptionCard
                key={o.id}
                selected={pick === o.id}
                onClick={() => setPick(o.id)}
                title={o.name}
                desc={o.desc}
                track={`check.${o.id}`}
              />
            ))}
            {pick === 'edit' && (
              <div className="flex gap-2">
                <Field label="Amount" className="flex-1">
                  <input
                    className={cx(inputClass, 'tnum')}
                    inputMode="decimal"
                    value={amt}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
              </div>
            )}
            {pick === 'match' && (
              <p className="m-0 rounded-xl bg-page p-3 text-[13px] text-muted">
                No bank transaction near {formatCents(Math.abs(t.amount), { whole: true })} since{' '}
                {dayLabel(t.date)} looks like this check yet. When one arrives, it will appear here to pick.
              </p>
            )}
            {(keep.error || patch.error) && <ErrorNote error={keep.error ?? patch.error} />}
            <PrimaryButton
              mutates
              track={`check.confirm.${pick}`}
              danger={pick === 'delete'}
              disabled={pick === 'match'}
              className="mt-2"
              onClick={() => void confirm()}
            >
              {cur.cta}
            </PrimaryButton>
          </>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ add pending / upcoming

export function AddTxnScreen() {
  useScreen('add_txn');
  const close = useClose();
  const session = useSession();
  const accounts = useAccounts();
  const add = useMoneyMutation(api.newTxn);
  const today = session.data?.budget.today ?? '';
  const [kind, setKind] = useState<'pending' | 'upcoming'>('pending');
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [amount, setAmount] = useState('');
  const [payee, setPayee] = useState('');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState('');
  const [repeats, setRepeats] = useState<'never' | 'monthly' | 'yearly'>('never');
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const acct = accountId || accts[0]?.id || '';
  const cents = parseCents(amount);
  const ok = cents !== null && cents > 0 && payee.trim() && acct && (date || today);
  const toRta = dir === 'in' && categoryId === 'rta';
  const submit = async () => {
    if (!ok || cents === null) return;
    await add.mutateAsync({
      kind,
      accountId: acct,
      date: date || today,
      amount: dir === 'out' ? -cents : cents,
      payee: payee.trim(),
      categoryId: toRta || categoryId === 'rta' ? null : categoryId || null,
      toRta,
      repeats: kind === 'upcoming' ? repeats : 'never',
    });
    close();
  };
  return (
    <Sheet
      label="Add a transaction"
      track="add_txn"
      onClose={close}
      gap="small"
      closeLabel="Cancel"
      header={<h1 className="m-0 text-[20px] font-bold">Add a transaction</h1>}
      footer={
        <PrimaryButton mutates track="add_txn.add" disabled={!ok} onClick={() => void submit()}>
          Add
        </PrimaryButton>
      }
    >
      <Segmented
        label="When"
        track="add_txn.kind"
        value={kind}
        onChange={setKind}
        options={[
          ['pending', 'Already happened'],
          ['upcoming', 'Coming up'],
        ]}
      />
      <p className="m-0 text-[13px] leading-snug text-muted">
        {kind === 'pending'
          ? 'Something you paid that the bank hasn’t shown yet, like a check. It counts in your budget now.'
          : 'A bill or paycheck on a future date. It counts in your budget from that date.'}
      </p>
      <div className="flex items-end gap-2">
        <Field label="Amount" className="flex-1">
          <input
            className={cx(inputClass, 'tnum text-[18px] font-bold')}
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <div className="w-[140px]">
          <Segmented
            label="Direction"
            value={dir}
            onChange={setDir}
            options={[
              ['out', 'Out'],
              ['in', 'In'],
            ]}
          />
        </div>
      </div>
      <Field label="Payee">
        <input
          className={inputClass}
          placeholder="e.g. Check #1044"
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
        />
      </Field>
      <Field label="Account">
        <select className={inputClass} value={acct} onChange={(e) => setAccountId(e.target.value)}>
          {accts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Category">
        <CategoryField
          track="add.category"
          value={categoryId}
          onChange={setCategoryId}
          specials={
            dir === 'in'
              ? [
                  { id: '', name: 'Choose later' },
                  { id: 'rta', name: 'Ready to Assign' },
                ]
              : [{ id: '', name: 'Choose later' }]
          }
        />
      </Field>
      <Field label={kind === 'pending' ? 'Date' : 'On'}>
        <input
          type="date"
          className={inputClass}
          value={date || today}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      {kind === 'upcoming' && (
        <Field label="Repeats">
          <select
            className={inputClass}
            value={repeats}
            onChange={(e) => setRepeats(e.target.value as typeof repeats)}
          >
            <option value="never">Never</option>
            <option value="monthly">Every month</option>
            <option value="yearly">Every year</option>
          </select>
        </Field>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted">
        When the bank shows a matching transaction, the two are merged and the bank’s amount wins. If nothing
        matches in {kind === 'pending' ? 7 : 3} days, you’ll see an alert.
      </p>
      {add.error && <ErrorNote error={add.error} />}
    </Sheet>
  );
}
