// Budget's special states above the list: a past month, assigned more than there is, a first budget, a new month.
import { useState } from 'react';
import type { BudgetView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAssignView, useMoneyMutation } from '../api/hooks';
import { Banner, Card, PrimaryButton, SecondaryButton, SoftButton, SoftLink } from '../components/ui';
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
              await move.mutateAsync({ month, from: 'rta', to: took.id, amount: took.amount });
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
                  await move.mutateAsync({ month, from: c.id, to: 'rta', amount: need });
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

export function NewMonth({ b, month }: { b: BudgetView; month: string }) {
  const assignView = useAssignView(month);
  const assign = useMoneyMutation(api.assign);
  const [filled, setFilled] = useState<{ categoryId: string; amount: number }[] | null>(null);
  const targets = (assignView.data?.suggestions ?? []).filter((s) => s.reason === 'target' && s.amount > 0);
  const total = targets.reduce((s, t) => s + t.amount, 0);
  const prev = addMonths(month, -1);
  return (
    <>
      <Card className="flex flex-col gap-2 p-3.5">
        <h2 className="m-0 text-xl font-bold">{monthName(month)} has started</h2>
        <span className="text-sm text-muted">
          Every category keeps what it had left in {monthName(prev)}.
        </span>
        <div className="flex items-center justify-between border-t border-divider pt-2 text-md">
          <span className="font-semibold">Ready to Assign</span>
          <span className="tnum font-bold">{formatCents(b.rta)}</span>
        </div>
      </Card>
      {total > 0 && (
        <Card className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-base font-bold">Targets for {monthName(month)}</h2>
            <span className="tnum text-base font-bold">{formatCents(total)}</span>
          </div>
          {filled && <span className="text-sm text-muted">Each target got what it needs this month.</span>}
          {filled ? (
            <SecondaryButton
              mutates="offline"
              track="budget.newmonth.undo"
              onClick={async () => {
                await assign.mutateAsync({
                  month,
                  items: filled.map((f) => ({ categoryId: f.categoryId, amount: -f.amount })),
                });
                usage.undo('fill_targets');
                setFilled(null);
              }}
            >
              Undo
            </SecondaryButton>
          ) : (
            <PrimaryButton
              mutates="offline"
              track="budget.newmonth.fill"
              onClick={async () => {
                const items = targets.map((t) => ({ categoryId: t.categoryId, amount: t.amount }));
                await assign.mutateAsync({ month, items });
                setFilled(items);
              }}
            >
              Fill targets · {formatCents(total)}
            </PrimaryButton>
          )}
        </Card>
      )}
    </>
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
