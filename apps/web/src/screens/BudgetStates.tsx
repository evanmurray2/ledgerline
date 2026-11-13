// Budget's special states above the list: a past month, assigned more than there is, a first budget, a new month.
import { useState } from 'react';
import type { BudgetView } from '@ledgerline/contracts';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { useAssignView, useMoneyMutation } from '../api/hooks';
import {
  Banner,
  Card,
  ConfirmInline,
  ErrorNote,
  PrimaryButton,
  SecondaryButton,
  SoftButton,
  SoftLink,
  TextButton,
} from '../components/ui';
import { toast } from '../components/Toast';
import { formatCents } from '../lib/money';
import { addMonths, compareMonths, monthLabel, monthName } from '../lib/dates';
import { usage } from '../usage/tracker';

// ------------------------------------------------------------------ special states

export function OverAssigned({ b, month }: { b: BudgetView; month: string }) {
  const move = useMoneyMutation(api.move);
  const [took, setTook] = useState<{ id: string; name: string; amount: number } | null>(null);
  const need = -b.rta;
  const candidates = b.groups
    .flatMap((g) => g.categories)
    .filter((c) => c.available >= need && c.status !== 'overspent')
    .sort((x, y) =>
      x.status === 'overfunded' ? -1 : y.status === 'overfunded' ? 1 : y.available - x.available,
    )
    .slice(0, 3);
  if (took)
    return (
      <Banner
        tone="success"
        action={
          <SoftButton
            tone="outline"
            mutates="offline"
            track="budget.over.undo"
            onClick={async () => {
              try {
                await move.mutateAsync({ month, from: 'rta', to: took.id, amount: took.amount });
              } catch (e) {
                toast.show({ text: errorMessage(e) });
                return;
              }
              usage.undo('take_back');
              setTook(null);
            }}
          >
            Undo
          </SoftButton>
        }
      >
        Took {formatCents(took.amount)} from {took.name}.
      </Banner>
    );
  if (b.rta >= 0) return null;
  return (
    <>
      <Banner
        tone="danger"
        role="alert"
        icon="alert"
        title={`You assigned ${formatCents(need)} more than you have`}
      >
        {candidates.length > 0
          ? 'Take it back from a category below.'
          : 'Open a category and move money to Ready to Assign.'}
      </Banner>
      {candidates.length > 0 && (
        <Card>
          {candidates.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-base font-semibold wrap-anywhere">{c.name}</span>
                <span className="text-xs text-muted">
                  {formatCents(c.available)} · {c.detail}
                </span>
              </span>
              <SoftButton
                mutates="offline"
                track="budget.over.take"
                aria-label={`Take ${formatCents(need)} from ${c.name}`}
                onClick={async () => {
                  try {
                    await move.mutateAsync({ month, from: c.id, to: 'rta', amount: need });
                  } catch (e) {
                    toast.show({ text: errorMessage(e) });
                    return;
                  }
                  setTook({ id: c.id, name: c.name, amount: need });
                }}
              >
                Take {formatCents(need)}
              </SoftButton>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

export function FirstBudget({ b }: { b: BudgetView }) {
  const owed = b.cards.reduce((s, c) => s + c.owed, 0);
  return (
    <section className="flex shrink-0 flex-col gap-1.5 rounded-lg bg-accent-soft p-3.5 text-ink">
      <span className="text-xl font-bold">
        {b.rta > 0 ? `Give your ${formatCents(b.rta)} a job` : 'Start your budget'}
      </span>
      <span className="text-sm leading-snug text-ink-2">
        {owed > 0
          ? 'Fund card payments first, then bills, spending and savings.'
          : 'Fund bills first, then spending and savings.'}
      </span>
      <SoftLink to="/targets" tone="filled" track="budget.first.targets" className="mt-1 self-start">
        Set targets
      </SoftLink>
    </section>
  );
}

/** The month whose "has started" card was hidden on this device (a convenience only: lost with site data). */
const NEW_MONTH_KEY = 'ledgerline-new-month-hidden';
function hiddenMonth(): string | null {
  try {
    return window.localStorage.getItem(NEW_MONTH_KEY);
  } catch {
    return null;
  }
}
function hideMonth(month: string) {
  try {
    window.localStorage.setItem(NEW_MONTH_KEY, month);
  } catch {
    // per-device convenience only
  }
}

/**
 * This month, before anything is assigned in it: what carried over, and its targets filled in one tap. It stays
 * until hidden or filled, whatever the day; after filling it keeps its Undo until you leave Budget.
 */
export function NewMonth({ b, month }: { b: BudgetView; month: string }) {
  const assignView = useAssignView(month);
  const assign = useMoneyMutation(api.assign);
  const [filled, setFilled] = useState<{ categoryId: string; amount: number; was?: number }[] | null>(null);
  const [hidden, setHidden] = useState(() => hiddenMonth() === month);
  const [warn, setWarn] = useState(false);
  const fresh = b.groups.every((g) => g.categories.every((c) => c.assigned === 0));
  if (hidden || (!fresh && !filled)) return null;
  const v = assignView.data;
  const targets = (v?.suggestions ?? []).filter((s) => s.reason === 'target' && s.amount > 0);
  const total = targets.reduce((s, t) => s + t.amount, 0);
  const prev = addMonths(month, -1);
  const fill = async () => {
    setWarn(false);
    // Each with what this device saw assigned: a second device that filled already makes this one refuse.
    const items = targets.map((t) => ({
      categoryId: t.categoryId,
      amount: t.amount,
      was: v?.assigned[t.categoryId] ?? 0,
    }));
    try {
      await assign.mutateAsync({ month, items });
      setFilled(items);
    } catch {
      // Shown in the card (assign.error).
    }
  };
  const undo = async () => {
    if (!filled) return;
    try {
      await assign.mutateAsync({
        month,
        items: filled.map((f) => ({
          categoryId: f.categoryId,
          amount: -f.amount,
          ...(f.was === undefined ? {} : { was: f.was + f.amount }),
        })),
      });
    } catch (e) {
      toast.show({ text: errorMessage(e) });
      return;
    }
    usage.undo('fill_targets');
    setFilled(null);
  };
  return (
    <>
      <Card className="flex flex-col gap-2 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="m-0 text-xl font-bold">{monthName(month)} has started</h2>
          {!filled && (
            <TextButton
              track="budget.newmonth.hide"
              onClick={() => {
                hideMonth(month);
                setHidden(true);
              }}
              className="-mt-2 self-auto"
            >
              Hide
            </TextButton>
          )}
        </div>
        <span className="text-sm text-muted">
          Every category keeps what it had left in {monthName(prev)}.
        </span>
        {b.carryOver && <CarryOver c={b.carryOver} month={month} />}
        <div className="flex items-center justify-between border-t border-divider pt-2 text-md">
          <span className="font-semibold">Ready to Assign</span>
          <span className="tnum font-bold">{formatCents(b.rta)}</span>
        </div>
      </Card>
      {(total > 0 || filled) && (
        <Card className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-base font-bold">Targets for {monthName(month)}</h2>
            {!filled && <span className="tnum text-base font-bold">{formatCents(total)}</span>}
          </div>
          {filled && <span className="text-sm text-muted">Each target got what it needs this month.</span>}
          {filled ? (
            <SecondaryButton mutates="offline" track="budget.newmonth.undo" onClick={() => void undo()}>
              Undo
            </SecondaryButton>
          ) : warn ? (
            // Filling more than there is leaves Ready to Assign below zero: say so first, then let it go ahead.
            <ConfirmInline
              label="Fill targets"
              confirmLabel="Fill anyway"
              cancelLabel="Not now"
              track="budget.newmonth.fill_anyway"
              mutates="offline"
              busy={assign.isPending}
              onConfirm={() => void fill()}
              onCancel={() => setWarn(false)}
            >
              That’s {formatCents(total - b.rta)} more than Ready to Assign has. It would go to{' '}
              {formatCents(b.rta - total)}.
            </ConfirmInline>
          ) : (
            <PrimaryButton
              mutates="offline"
              track="budget.newmonth.fill"
              busy={assign.isPending}
              onClick={() => (total > b.rta ? setWarn(true) : void fill())}
            >
              Fill targets · {formatCents(total)}
            </PrimaryButton>
          )}
          {assign.error && <ErrorNote error={assign.error} />}
        </Card>
      )}
    </>
  );
}

/**
 * How Ready to Assign came to this month's amount: what last month left, then each part that came in or went out
 * since. Parts that are $0 are left out; the parts add up to Ready to Assign (BudgetView.carryOver).
 */
function CarryOver({ c, month }: { c: NonNullable<BudgetView['carryOver']>; month: string }) {
  const lines: [string, number][] = [
    [`Overspent in ${monthName(c.from)}`, -c.overspent],
    [`Money in during ${monthName(month)}`, c.income],
    ['Paid back to you', c.paidBack],
    ['Closed out', c.closedOut],
    ['Owed to you', -c.owed],
    ['Assigned', -c.assigned],
  ];
  return (
    <dl className="m-0 flex flex-col gap-1 text-md" data-testid="carry-over">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-ink-2">Left from {monthName(c.from)}</dt>
        <dd className="tnum m-0 font-semibold">{formatCents(c.left)}</dd>
      </div>
      {lines
        .filter(([, v]) => v !== 0)
        .map(([name, v]) => (
          <div key={name} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-2">{name}</dt>
            <dd className="tnum m-0 font-semibold">{formatCents(v, { plus: true })}</dd>
          </div>
        ))}
    </dl>
  );
}

export function PastNote({ month, current }: { month: string; current: string }) {
  if (compareMonths(month, current) >= 0) return null;
  return (
    <Banner tone="info">
      {monthLabel(month)} is over. Changes here carry into {monthName(current)}.
    </Banner>
  );
}
