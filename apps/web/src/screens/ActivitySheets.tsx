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
import { dayLabel } from '../lib/dates';
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
        <SheetTitle
          tag="Transfer to sort out"
          amount={formatCents(t.amount)}
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
            <span className="text-base font-bold">Where did this go?</span>
            <p className="m-0 text-sm leading-snug text-muted">
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
                  className="flex min-h-14 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="flex flex-col">
                    <span className="text-base font-semibold">{account.name}</span>
                    <span className="text-xs text-muted">
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
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
              >
                <span className="text-base font-semibold">Neither, it was a payment</span>
                <span className="text-xs text-muted">Categorize it like any other spending</span>
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
        <SheetTitle
          tag={`Not at the bank after ${days} days`}
          tagClass="text-under-fg"
          amount={formatCents(t.amount)}
          sub={`${t.payee} · ${t.accountName} · added by you ${dayLabel(t.date)} · ${cat}`}
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
              disabled={pick === 'match'}
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
                    className={amountInputClass}
                    inputMode="decimal"
                    value={amt}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
              </div>
            )}
            {pick === 'match' && (
              <Banner tone="neutral">
                No bank transaction near {formatCents(Math.abs(t.amount), { whole: true })} since{' '}
                {dayLabel(t.date)} looks like this check yet. When one arrives, it will appear here to pick.
              </Banner>
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
                  : ''
          }
          onClick={() => void submit()}
        >
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
      <p className="m-0 text-sm leading-snug text-muted">
        {kind === 'pending'
          ? 'Something you paid that the bank hasn’t shown yet, like a check. It counts in your budget now.'
          : 'A bill or paycheck on a future date. It counts in your budget from that date.'}
      </p>
      <div className="flex items-end gap-2">
        <Field label="Amount" className="flex-1">
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
      <div className="flex flex-col gap-1 text-xs leading-snug text-muted">
        <span>When the bank shows it, the bank’s amount wins.</span>
        <Why>
          When the bank shows a matching transaction, the two are merged. If nothing matches in{' '}
          {kind === 'pending' ? 7 : 3} days, you’ll see an alert.
        </Why>
      </div>
      {add.error && <ErrorNote error={add.error} />}
    </Sheet>
  );
}
