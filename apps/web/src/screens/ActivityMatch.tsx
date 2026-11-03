// Match money back: what an inflow pays back, and what happens to the rest.
import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMatchView, useMoneyMutation, useSession, useBudget } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { cx, ErrorNote, Loading, PrimaryButton, SecondaryButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useClose, useParentPath } from './TxnCommon';
import { usage } from '../usage/tracker';

function useRta() {
  const session = useSession();
  return useBudget(session.data?.budget.currentMonth).data?.rta;
}

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
                  <span className="text-[12px] text-muted">
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
