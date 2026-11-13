// Check not cleared, Add pending or upcoming. Match money back is in ActivityMatch.tsx, the transfer sheet in
// ActivityTransfer.tsx.
import { useMemo, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation, usePayees, useTxn, useSession } from '../api/hooks';
import { AccountField } from '../components/AccountField';
import { CategoryField } from '../components/CategoryPicker';
import { PayeeField } from '../components/PayeeField';
import { sameName } from '../components/RenamePayee';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  Banner,
  ErrorNote,
  Field,
  inputClass,
  Loading,
  OptionCard,
  PrimaryButton,
  Segmented,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel, monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useClose } from './TxnCommon';
import { Why } from '../components/Why';

export { MatchScreen } from './ActivityMatch';
export { TransferScreen } from './ActivityTransfer';

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
              mutates="offline"
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
  // Payees the bank's transactions already have, most used first, to offer as you type.
  const known = usePayees().data;
  const payeeNames = useMemo(
    () => [...(known?.payees ?? []), ...(known?.others ?? [])].map((p) => p.name),
    [known],
  );
  // The category you've used most for money out to the payee typed: the picker offers it first, and you pick.
  const usualFor =
    dir === 'out' && payee.trim()
      ? known?.payees.find((p) => p.usualId && sameName(p.name, payee))
      : undefined;
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
          mutates="offline"
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
              // Money in starts in Ready to Assign. Only money in can go there: going back to Out asks for a
              // category again.
              if (d === 'in' && !categoryId) setCategoryId('rta');
              if (d === 'out' && categoryId === 'rta') setCategoryId('');
            }}
            options={[
              ['out', 'Out'],
              ['in', 'In'],
            ]}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="add-payee" className="text-sm font-semibold text-ink-2">
          Payee
        </label>
        <PayeeField
          id="add-payee"
          track="add_txn.payee"
          placeholder="e.g. Check #1044"
          names={payeeNames}
          value={payee}
          onChange={setPayee}
        />
      </div>
      <Field label="Account">
        <AccountField
          track="add_txn.account"
          groups={accounts.data?.groups ?? []}
          value={acct}
          onChange={setAccountId}
        />
      </Field>
      <Field label="Category">
        <CategoryField
          track="add.category"
          value={categoryId}
          onChange={setCategoryId}
          suggested={usualFor?.usualId ? [usualFor.usualId] : undefined}
          suggestedTitle={usualFor ? `Usually for ${usualFor.name}` : undefined}
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
