// Transfer: pick the other side, Check not cleared, Add pending or upcoming.
// Match money back is in ActivityMatch.tsx.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueries } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation, useTxn, useSession, qk } from '../api/hooks';
import { CategoryField } from '../components/CategoryPicker';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  Banner,
  Button,
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
import { dayLabel, monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useClose } from './TxnCommon';
import { usage } from '../usage/tracker';
import { Why } from '../components/Why';

export { MatchScreen } from './ActivityMatch';

// ------------------------------------------------------------------ transfer pick

export function TransferScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('transfer.pick');
  const q = useTxn(key);
  const close = useClose();
  const accounts = useAccounts();
  const pick = useMoneyMutation((v: { otherKey: string | null; unlinked?: boolean; accountId?: string }) =>
    api.pickTransfer(key, v),
  );
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
      <Sheet label="Transfer" track="transfer" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  // The contract has no candidate list: find rows of the opposite amount within 5 days in the other accounts that
  // aren't a transfer already (the route accepts the same ones). From a deposit, the other side is an outflow.
  const sent = t.amount > 0;
  const day = (d: string) =>
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
  const candidates = registers.flatMap((r, i) =>
    (r.data?.days ?? [])
      .flatMap((d) => d.rows)
      .filter(
        (row) =>
          row.amount === -t.amount &&
          Math.abs(day(row.date) - day(t.date)) <= 5 &&
          row.categoryLabel !== 'Transfer',
      )
      .map((row) => ({ row, account: others[i]! })),
  );
  const loadingCands = registers.some((r) => r.isLoading);
  const n = candidates.length;
  // Deposits still waiting for this answer ("Pick the account"): the ones not picked count as income.
  const waiting = sent ? 0 : candidates.filter((c) => c.row.sheet === 'transfer').length;
  const income = (left: number) =>
    left <= 0
      ? ''
      : left === 1
        ? ' The other deposit counts as income.'
        : ' The other deposits count as income.';
  const lines = (name: string | null, picked?: { sheet: string }) =>
    name === null
      ? sent
        ? 'Kept as income. It needs a category.'
        : `Kept as spending. It needs a category.${income(waiting)}`
      : `Paired with ${name}. It needs no category.${income(waiting - (picked?.sheet === 'transfer' ? 1 : 0))}`;
  const question = sent ? 'Which account sent this money?' : 'Which account got this money?';
  // Accounts whose side hasn't arrived yet (D-83): picking one adds a pending entry there, paired with this row.
  const listed = new Set(candidates.map((c) => c.account.id));
  const notYet = others.filter((a) => !listed.has(a.id));
  return (
    <Sheet
      label={question}
      track="transfer"
      onClose={close}
      gap="auto"
      header={
        <SheetTitle
          tag="Transfer to sort out"
          amount={formatCents(Math.abs(t.amount))}
          sub={`${t.accountName} · ${dayLabel(t.date)} · “${t.rawName}”`}
        />
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        {result ? (
          <>
            <Banner tone="success">{result}</Banner>
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
            <span className="text-base font-bold">{question}</span>
            {!loadingCands && (
              <p className="m-0 text-sm leading-snug text-muted">
                {n === 0 ? 'No account' : n === 1 ? '1 account' : `${n} accounts`} {sent ? 'sent' : 'got'}{' '}
                {formatCents(Math.abs(t.amount))} within a few days.
              </p>
            )}
            {loadingCands && <Loading label="Looking for the other account" />}
            <div className="flex flex-col gap-2">
              {candidates.map(({ row, account }) => (
                <Button
                  key={row.key}
                  mutates
                  track="transfer.pick"
                  onClick={async () => {
                    await pick.mutateAsync({ otherKey: row.key });
                    usage.suggestion('transfer_pick', 'paired');
                    setResult(lines(account.name, row));
                  }}
                  className="flex min-h-14 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="flex flex-col">
                    <span className="text-base font-semibold">{account.name}</span>
                    <span className="text-xs text-muted">
                      {dayLabel(row.date)} · “{row.payee}”
                    </span>
                  </span>
                  <span className={sent ? 'tnum font-bold' : 'tnum font-bold text-funded-fg'}>
                    {formatCents(row.amount, { plus: true })}
                  </span>
                </Button>
              ))}
              {notYet.length > 0 && !loadingCands && (
                <span className="pt-2 text-sm font-semibold text-muted">
                  {n === 0 ? 'Pick the account' : 'Or another account'}
                </span>
              )}
              {!loadingCands &&
                notYet.map((a) => (
                  <Button
                    key={a.id}
                    mutates
                    track="transfer.pick_pending"
                    onClick={async () => {
                      await pick.mutateAsync({ otherKey: null, accountId: a.id });
                      usage.suggestion('transfer_pick', 'pending');
                      setResult(
                        `Paired with ${a.name}. It’s pending there until the bank sends it.${income(waiting)}`,
                      );
                    }}
                    className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                  >
                    <span className="text-base font-semibold">{a.name}</span>
                    <span className="text-xs text-muted">Pending until the bank sends it</span>
                  </Button>
                ))}
              <Button
                mutates
                track="transfer.unlinked"
                onClick={async () => {
                  await pick.mutateAsync({ otherKey: null, unlinked: true });
                  usage.suggestion('transfer_pick', 'unlinked');
                  setResult(
                    sent
                      ? 'Marked as a transfer in. It goes into Ready to Assign.'
                      : `Marked as a transfer out. It comes out of Ready to Assign.${income(waiting)}`,
                  );
                }}
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
              >
                <span className="text-base font-semibold">An account that isn’t linked</span>
                <span className="text-xs text-muted">
                  Like Venmo. It {sent ? 'goes into' : 'comes out of'} Ready to Assign.
                </span>
              </Button>
              <Button
                mutates
                track="transfer.none"
                onClick={async () => {
                  await pick.mutateAsync({ otherKey: null });
                  setResult(lines(null));
                }}
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
              >
                <span className="text-base font-semibold">{sent ? 'It was income' : 'It was a payment'}</span>
                <span className="text-xs text-muted">
                  Give it a category like other {sent ? 'income' : 'spending'}
                </span>
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

type CheckPick = 'wait' | 'edit' | 'delete';

export function CheckPendingScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('check_pending');
  const q = useTxn(key);
  const close = useClose();
  const today = useSession().data?.budget.today;
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
  const cat = t.categoryLabel;
  const back = formatCents(Math.abs(t.amount));
  const amt = amount ?? centsToInput(Math.abs(t.amount));
  const utcDay = (d: string) =>
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
  const days = today ? Math.round(utcDay(today) - utcDay(t.date)) : 0;
  const opts: { id: CheckPick; name: string; desc: string; cta: string; result: string }[] = [
    {
      id: 'wait',
      name: 'Keep waiting',
      desc: 'You won’t be asked again for 14 days.',
      cta: 'Keep waiting',
      result: 'Still waiting. You’ll be asked again in 14 days if it hasn’t cleared.',
    },
    {
      id: 'edit',
      name: 'Fix the amount',
      desc: 'If you wrote it for a different amount.',
      cta: 'Save amount',
      result: 'Saved. It keeps waiting for the bank.',
    },
    {
      id: 'delete',
      name: 'Delete it',
      desc: `The check was voided or never sent.${cat ? ` ${cat} gets ${back} back.` : ''}`,
      cta: 'Delete check',
      result: `Deleted.${cat ? ` ${cat} got ${back} back.` : ''}`,
    },
  ];
  const cur = opts.find((o) => o.id === pick)!;
  const confirm = async () => {
    if (pick === 'edit') {
      const c = parseCents(amt);
      if (c === null || c === 0) return;
      // A check is an entry you added: its own amount changes (an estimate is only for a bank pending row).
      await patch.mutateAsync({ amount: t.amount < 0 ? -c : c });
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
        <SheetTitle
          tag={days > 1 ? `Not at the bank after ${days} days` : 'Not at the bank yet'}
          tagClass="text-under-fg"
          amount={formatCents(t.amount)}
          sub={`${t.payee} · ${t.accountName} · added by you ${dayLabel(t.date)}${cat ? ` · ${cat}` : ''}`}
        />
      }
      footer={
        done ? (
          <PrimaryButton onClick={close}>Done</PrimaryButton>
        ) : (
          <div className="flex flex-col gap-2">
            {(keep.error || patch.error) && <ErrorNote error={keep.error ?? patch.error} />}
            <PrimaryButton
              mutates
              track={`check.confirm.${pick}`}
              danger={pick === 'delete'}
              onClick={() => void confirm()}
            >
              {cur.cta}
            </PrimaryButton>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-2">
        {done ? (
          <Banner tone="success">{done}</Banner>
        ) : (
          <>
            <p className="m-0 text-sm leading-snug text-muted">
              It still counts in your budget. Checks can take a few weeks to clear.
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
                <Field label="Amount" className="min-w-0 flex-1">
                  <input
                    className={amountInputClass}
                    inputMode="decimal"
                    value={amt}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
              </div>
            )}
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
  const on = date || today;
  // The date picks the kind: a future date is upcoming (counts from that date), any other is pending (counts now).
  const upcoming = !!today && on > today;
  // Before the budget start is history, which never counts: entries there are refused (D-79).
  const start = session.data?.budget.startMonth;
  const first = start ? `${start}-01` : '';
  const early = !!first && !!on && on < first;
  const ok = cents !== null && cents > 0 && payee.trim() && acct && on && !early;
  const toRta = dir === 'in' && categoryId === 'rta';
  const submit = async () => {
    if (!ok || cents === null) return;
    await add.mutateAsync({
      kind: upcoming ? 'upcoming' : 'pending',
      accountId: acct,
      date: on,
      amount: dir === 'out' ? -cents : cents,
      payee: payee.trim(),
      categoryId: toRta || categoryId === 'rta' ? null : categoryId || null,
      toRta,
      repeats: upcoming ? repeats : 'never',
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
      header={<SheetTitle title="Add a transaction" />}
      footer={
        <PrimaryButton
          mutates
          track="add_txn.add"
          disabled={!ok}
          why={
            !cents || cents <= 0
              ? 'Enter an amount'
              : !payee.trim()
                ? 'Enter a payee'
                : !acct
                  ? 'Choose an account'
                  : early && start
                    ? `Pick a date from ${monthName(start)} 1, ${start.slice(0, 4)} on`
                    : ''
          }
          onClick={() => void submit()}
        >
          Add
        </PrimaryButton>
      }
    >
      <div className="flex items-end gap-2">
        <Field label="Amount" className="min-w-0 flex-1">
          <input
            className={amountInputClass}
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
            onChange={(d) => {
              setDir(d);
              // Only money in can go to Ready to Assign: going back to Out asks for a category again.
              if (d === 'out' && categoryId === 'rta') setCategoryId('');
            }}
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
          maxLength={120}
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
                  { id: '', name: 'Needs a category' },
                  { id: 'rta', name: 'Ready to Assign' },
                ]
              : [{ id: '', name: 'Needs a category' }]
          }
        />
      </Field>
      <Field label="Date">
        <input
          type="date"
          className={inputClass}
          value={on}
          min={first || undefined}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <p className="m-0 text-sm leading-snug text-muted">
        {upcoming
          ? 'A future date. It counts from that date.'
          : 'For money the bank doesn’t show yet, like a check. It counts now.'}
      </p>
      {upcoming && (
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
      <div className="flex flex-col gap-1 text-xs leading-snug text-muted">
        <span>When the bank shows it, the bank’s amount wins.</span>
        <Why>
          The two become one transaction. If the bank doesn’t show it after a few days, you’ll see an alert.
        </Why>
      </div>
      {add.error && <ErrorNote error={add.error} />}
    </Sheet>
  );
}
