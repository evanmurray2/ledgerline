// Add pending or upcoming: money the bank doesn't show yet, or a future date. A pending one can also be a transfer,
// owed to you, or pay back what's owed to you.
import { useMemo, useState } from 'react';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation, useOwed, usePayees, useSession } from '../api/hooks';
import { AccountField } from '../components/AccountField';
import { CategoryField } from '../components/CategoryPicker';
import { PayeeField } from '../components/PayeeField';
import { sameName } from '../components/RenamePayee';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  Checkbox,
  cx,
  EmptyNote,
  ErrorNote,
  Field,
  inputClass,
  PrimaryButton,
  Segmented,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel, monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { amountWhy, dateWhy } from '../lib/amount-check';
import { useClose } from './TxnCommon';
import { Why } from '../components/Why';

/** What a pending entry is besides its amount: a plain purchase or money in, a transfer, owed to you or paid back. */
type Kind = 'plain' | 'transfer' | 'owed' | 'paid';
type OwedShare = 'half' | 'all' | 'custom';

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
  const [pick, setKind] = useState<Kind>('plain');
  const [otherId, setOtherId] = useState('');
  const [share, setShare] = useState<OwedShare>('half');
  const [owedAmt, setOwedAmt] = useState('');
  const [expectBy, setExpectBy] = useState('');
  const [paid, setPaid] = useState<Record<string, boolean>>({});
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
  // Only a pending entry can be more than a plain one: a future date is always plain.
  const kind: Kind = upcoming ? 'plain' : pick;
  const transfer = kind === 'transfer';
  // The other account of a transfer: any but this one.
  const otherGroups = (accounts.data?.groups ?? [])
    .map((g) => ({ ...g, accounts: g.accounts.filter((a) => a.id !== acct && !a.closed) }))
    .filter((g) => g.accounts.length > 0);
  const other = otherGroups.flatMap((g) => g.accounts).find((a) => a.id === otherId);
  // A transfer's payee says where the money went, unless you typed one.
  const payeeText =
    payee.trim() || (transfer && other ? `Transfer ${dir === 'out' ? 'to' : 'from'} ${other.name}` : '');
  // Owed to you: a share of what you paid, or a typed amount (at most what you paid).
  const owedCents =
    share === 'half'
      ? Math.round((cents ?? 0) / 2)
      : share === 'all'
        ? (cents ?? 0)
        : (parseCents(owedAmt) ?? 0);
  const owedBad = kind === 'owed' && share === 'custom' ? amountWhy(owedAmt) : '';
  const owedOver = kind === 'owed' && share === 'custom' && cents !== null && owedCents > cents;
  // Paid back: the owed items picked, each paid as far as the money goes, oldest first (as Match money back does).
  const owedQ = useOwed();
  const open = (owedQ.data?.items ?? []).filter((i) => i.status === 'open' || i.status === 'late');
  let left = cents ?? 0;
  const applied = open.map((o) => {
    const a = paid[o.id] ? Math.min(o.still, Math.max(left, 0)) : 0;
    left -= a;
    return { ...o, applied: a };
  });
  const paysBack = applied.filter((a) => a.applied > 0).map((a) => ({ itemId: a.id, amount: a.applied }));
  // Before the budget start is history, which never counts: entries there are refused (D-79).
  const start = session.data?.budget.startMonth;
  const first = start ? `${start}-01` : '';
  const early = !!first && !!on && on < first;
  const amountBad = amountWhy(amount);
  const far = dateWhy(on, today);
  const kindWhy =
    transfer && !other
      ? `Choose the account it went ${dir === 'out' ? 'to' : 'from'}`
      : owedBad
        ? owedBad.replace('an amount', 'the amount owed')
        : owedOver && cents !== null
          ? `Enter at most ${formatCents(cents)} owed`
          : kind === 'paid' && paysBack.length === 0
            ? 'Pick what it pays back'
            : '';
  const ok = !amountBad && cents !== null && payeeText && acct && on && !early && !far && !kindWhy;
  const toRta = dir === 'in' && categoryId === 'rta';
  const submit = async () => {
    if (!ok || cents === null) return;
    const added = await add
      .mutateAsync({
        kind: upcoming ? 'upcoming' : 'pending',
        accountId: acct,
        date: on,
        amount: dir === 'out' ? -cents : cents,
        payee: payeeText,
        categoryId: toRta || categoryId === 'rta' || transfer || kind === 'paid' ? null : categoryId || null,
        toRta: toRta && kind === 'plain',
        repeats: upcoming ? repeats : 'never',
        ...(transfer ? { transferAccountId: otherId } : {}),
        ...(kind === 'owed'
          ? {
              owed:
                share === 'custom'
                  ? { mode: 'fixed' as const, amount: owedCents, expectBy: expectBy || null }
                  : { mode: share, expectBy: expectBy || null },
            }
          : {}),
        ...(kind === 'paid' ? { paysBack } : {}),
      })
      // A refusal shows above Add (add.error), not as an uncaught error.
      .then(
        () => true,
        () => false,
      );
    if (added) close();
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
            amountBad
              ? amountBad
              : !payeeText
                ? 'Enter a payee'
                : !acct
                  ? 'Choose an account'
                  : early && start
                    ? `Pick a date from ${monthName(start)} 1, ${start.slice(0, 4)} on`
                    : far || kindWhy
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
              // Owed to you is for money out, Paid back for money in.
              if (pick === 'owed' || pick === 'paid') setKind('plain');
            }}
            options={[
              ['out', 'Out'],
              ['in', 'In'],
            ]}
          />
        </div>
      </div>
      {!upcoming && (
        <Segmented
          label="Type"
          track="add_txn.kind"
          value={kind}
          onChange={setKind}
          options={
            dir === 'out'
              ? [
                  ['plain', 'Purchase'],
                  ['transfer', 'Transfer'],
                  ['owed', 'Owed to you'],
                ]
              : [
                  ['plain', 'Money in'],
                  ['transfer', 'Transfer'],
                  ['paid', 'Paid back'],
                ]
          }
        />
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="add-payee" className="text-sm font-semibold text-ink-2">
          Payee
        </label>
        <PayeeField
          id="add-payee"
          track="add_txn.payee"
          placeholder={
            transfer && other ? `Transfer ${dir === 'out' ? 'to' : 'from'} ${other.name}` : 'e.g. Check #1044'
          }
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
      {transfer ? (
        <Field label={dir === 'out' ? 'To account' : 'From account'}>
          <AccountField
            track="add_txn.transfer_account"
            groups={otherGroups}
            value={otherId}
            onChange={setOtherId}
          />
        </Field>
      ) : (
        kind !== 'paid' && (
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
        )
      )}
      {kind === 'owed' && (
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <Segmented
            label="Owed to you"
            track="add_txn.owed"
            value={share}
            onChange={setShare}
            options={[
              ['half', 'Half'],
              ['all', 'All'],
              ['custom', 'Custom'],
            ]}
          />
          <div className="flex gap-2">
            <Field label="Amount owed" className="flex-1 text-xs">
              <input
                className={amountInputClass}
                inputMode="decimal"
                placeholder="0.00"
                value={share === 'custom' ? owedAmt : cents !== null ? centsToInput(owedCents) : ''}
                readOnly={share !== 'custom'}
                onChange={(e) => setOwedAmt(e.target.value)}
              />
            </Field>
            <Field label="Expect by" className="flex-1 text-xs">
              <input
                type="date"
                className={inputClass}
                value={expectBy}
                onChange={(e) => setExpectBy(e.target.value)}
              />
            </Field>
          </div>
        </div>
      )}
      {kind === 'paid' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-ink-2">What it pays back</span>
          <div className="shrink-0 overflow-hidden rounded-lg border border-line">
            {applied.length === 0 && <EmptyNote inCard>Nothing is marked as owed to you.</EmptyNote>}
            {applied.map((a) => (
              <label
                key={a.id}
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-1.5 first:border-t-0"
              >
                <Checkbox
                  checked={!!paid[a.id]}
                  data-track="add_txn.paid_item"
                  onChange={() => setPaid({ ...paid, [a.id]: !paid[a.id] })}
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-base font-semibold">{a.label}</span>
                  <span className={cx('text-xs', a.status === 'late' ? 'text-under-fg' : 'text-muted')}>
                    {a.expectBy
                      ? `${a.status === 'late' ? 'Late · ' : ''}expected by ${dayLabel(a.expectBy)}`
                      : 'No date'}
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="tnum text-base font-bold">
                    {paid[a.id] ? formatCents(a.applied) : '—'}
                  </span>
                  <span className="text-xs text-muted">of {formatCents(a.still)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
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
          : transfer
            ? `Money moves between your accounts. ${other ? `${other.name} gets the other side.` : ''}`.trim()
            : kind === 'owed'
              ? 'The category pays only your share. The rest comes out of Ready to Assign until it’s paid back.'
              : kind === 'paid'
                ? 'It goes to Ready to Assign. What it pays back leaves Owed to you.'
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
