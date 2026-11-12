// Match money back: what an inflow pays back, and what happens to the rest.
import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMatchView, useMoneyMutation, useSession, useBudget } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  Banner,
  Checkbox,
  cx,
  EmptyNote,
  ErrorNote,
  Label,
  Loading,
  PrimaryButton,
  SecondaryButton,
  TextButton,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useClose, useCloseHref, useParentPath } from './TxnCommon';
import { usage } from '../usage/tracker';
import { Why } from '../components/Why';

function useRta() {
  const session = useSession();
  return useBudget(session.data?.budget.currentMonth).data?.rta;
}

export function MatchScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('match');
  const q = useMatchView(key);
  const close = useClose();
  const parent = useParentPath();
  // Back from Owed to you returns to the screen under this sheet (the match is done).
  const closeHref = useCloseHref();
  const match = useMoneyMutation(api.doMatch);
  const unlink = useMoneyMutation(api.unlink);
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
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
    const r = await match.mutateAsync({ inflowKey: v.inflow.key, items });
    usage.endTask('match');
    setDone({
      text: asIncome
        ? `Counted as income. Ready to Assign is now ${formatCents(r.rta)}.`
        : `Matched ${formatCents(matched)}.${paidCount > 0 ? ` ${paidCount} ${paidCount === 1 ? 'item is' : 'items are'} paid back.` : ''} Ready to Assign is now ${formatCents(r.rta)}.`,
    });
  };
  return (
    <Sheet
      label="Match money back"
      track="match"
      onClose={close}
      gap="small"
      header={
        <SheetTitle
          tag="Money in"
          tagClass="text-funded-fg"
          amount={formatCents(inflow, { plus: true })}
          amountClass="text-funded-fg"
          sub={`${v.inflow.payee} · ${v.inflow.accountName} · ${dayLabel(v.inflow.date)}`}
        />
      }
      footer={
        done ? undefined : (
          <div className="flex flex-col gap-2">
            {match.error && <ErrorNote error={match.error} />}
            <div className="flex gap-2">
              <SecondaryButton
                mutates="offline"
                track="match.income"
                className="flex-1"
                onClick={() => void submit(true)}
              >
                It’s income
              </SecondaryButton>
              <PrimaryButton
                mutates="offline"
                track="match.apply"
                className="flex-[2]"
                disabled={matched === 0}
                why={matched === 0 ? 'Pick what it pays back' : ''}
                onClick={() => void submit(false)}
              >
                {matched === 0 ? 'Match' : `Match ${formatCents(matched)}`}
              </PrimaryButton>
            </div>
          </div>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-3">
          <Banner tone="success">{done.text}</Banner>
          <div className="flex gap-2">
            <SecondaryButton
              mutates="offline"
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
              search={{ back: closeHref }}
              className="flex h-12 flex-[2] items-center justify-center rounded-lg bg-accent text-lg font-bold text-on-accent no-underline"
            >
              See what’s still owed
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-bold">What does this money pay back?</span>
            <span className="text-sm text-muted">
              It is in Ready to Assign. Matching it doesn’t change that.
            </span>
          </div>
          <Label>What it pays back</Label>
          <div className="shrink-0 overflow-hidden rounded-lg border border-line">
            {applied.length === 0 && <EmptyNote inCard>Nothing is marked as owed to you.</EmptyNote>}
            {applied.map((a) => (
              <label
                key={a.id}
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-1.5 first:border-t-0"
              >
                <Checkbox
                  checked={!!on[a.id]}
                  data-track="match.item"
                  onChange={() => setOn({ ...on, [a.id]: !on[a.id] })}
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-base font-semibold">{a.label}</span>
                  <span className={cx('text-xs', a.late ? 'text-under-fg' : 'text-muted')}>
                    {a.expectBy ? `${a.late ? 'Late · ' : ''}expected by ${dayLabel(a.expectBy)}` : 'No date'}
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  <span className="tnum text-base font-bold">{on[a.id] ? formatCents(a.applied) : '—'}</span>
                  <span className="text-xs text-muted">
                    {on[a.id] && a.applied < a.still
                      ? `of ${formatCents(a.still)}, rest stays owed`
                      : `of ${formatCents(a.still)}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {other ? (
            <Banner tone="neutral">
              Open that purchase in Activity and set Owed to you. It then shows up here.
            </Banner>
          ) : (
            <TextButton track="match.other" onClick={() => setOther(true)}>
              It’s for something I didn’t mark…
            </TextButton>
          )}
          <div className="flex flex-col gap-1 text-xs leading-snug text-muted">
            <span>What it pays back leaves Owed to you.</span>
            <Why>
              Money that comes in counts in Ready to Assign right away. A match only marks what it pays back
              as paid, so the money isn’t counted twice. Any money left over stays in Ready to Assign.
              {rta !== undefined ? ` Ready to Assign has ${formatCents(rta)} now.` : ''}
            </Why>
          </div>
          <span className="sr-only">
            <Link to={parent}>Back</Link>
          </span>
        </>
      )}
    </Sheet>
  );
}
