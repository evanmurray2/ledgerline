// Check not cleared. Add pending or upcoming is in ActivityAdd.tsx, Match money back in ActivityMatch.tsx, the
// transfer sheet in ActivityTransfer.tsx.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn, useSession } from '../api/hooks';
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
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { amountWhy } from '../lib/amount-check';
import { useClose } from './TxnCommon';

export { AddTxnScreen } from './ActivityAdd';
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
  const [date, setDate] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const t = q.data;
  if (!t)
    return (
      <Sheet label="Check" track="check" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  // Only an entry you added waits here (a check); a bank row has nothing to keep waiting for or delete.
  if (t.kind !== 'manual')
    return (
      <Sheet label="Check" track="check" onClose={close} gap="auto">
        <Banner tone="neutral">Only an entry you added can be checked here.</Banner>
      </Sheet>
    );
  const cat = t.categoryLabel;
  const back = formatCents(Math.abs(t.amount));
  const amt = amount ?? centsToInput(Math.abs(t.amount));
  const day = date ?? t.date;
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
      name: 'Fix the amount or date',
      desc: 'If you wrote it for a different amount or day.',
      cta: 'Save',
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
  const amtBad =
    pick !== 'edit'
      ? ''
      : amountWhy(amt) ||
        (!day ? 'Pick a date' : today && day > today ? 'Pick today or an earlier date' : '');
  const confirm = async () => {
    // A refusal shows in the sheet (keep.error, patch.error), not as an uncaught error.
    const ok = async (p: Promise<unknown>) =>
      p.then(
        () => true,
        () => false,
      );
    if (pick === 'edit') {
      const c = parseCents(amt);
      if (c === null || c === 0) return;
      // A check is an entry you added: its own amount and date change (an estimate is only for a bank pending row).
      const signed = t.amount < 0 ? -c : c;
      const body = {
        ...(signed !== t.amount ? { amount: signed } : {}),
        ...(day !== t.date ? { date: day } : {}),
      };
      if (Object.keys(body).length && !(await ok(patch.mutateAsync(body)))) return;
    } else if (!(await ok(keep.mutateAsync({ action: pick === 'delete' ? 'delete' : 'keep_waiting' }))))
      return;
    setDone(cur.result);
  };
  return (
    <Sheet
      label={t.payee}
      track="check"
      onClose={close}
      gap="auto"
      unsaved={pick === 'edit' && !done && !patch.isPending && amount !== null}
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
              disabled={!!amtBad}
              why={amtBad}
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
                <Field label="Date" className="min-w-0 flex-1">
                  <input
                    type="date"
                    className={inputClass}
                    value={day}
                    max={today}
                    onChange={(e) => setDate(e.target.value)}
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
