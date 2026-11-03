// Budget's special states above the list: a past month, assigned more than there is, a first budget, a new month.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { BudgetView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAssignView, useMoneyMutation } from '../api/hooks';
import { Banner, Button, Card, PrimaryButton, SecondaryButton, SoftButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { addMonths, compareMonths, monthName } from '../lib/dates';
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
          <Button
            mutates
            track="budget.over.undo"
            className="hit h-9 shrink-0 px-2 text-[13px] font-bold underline"
            onClick={async () => {
              await move.mutateAsync({ month, from: 'rta', to: took.id, amount: took.amount });
              usage.undo('take_back');
              setTook(null);
            }}
          >
            Undo
          </Button>
        }
      >
        Took {formatCents(took.amount)} from {took.name}. Ready to Assign is back to {formatCents(b.rta)}.
      </Banner>
    );
  if (b.rta >= 0) return null;
  return (
    <>
      <div
        role="alert"
        className="flex shrink-0 flex-col gap-1 rounded-xl bg-over-bg px-3 py-2.5 text-over-fg"
      >
        <span className="text-[15px] font-bold">You assigned {formatCents(need)} more than you have</span>
        <span className="text-[13px] leading-snug">
          Take {formatCents(need)} back from a category below. Nothing else is blocked meanwhile.
        </span>
      </div>
      <h2 className="m-0 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
        Take it back from
      </h2>
      <Card>
        {candidates.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{c.name}</span>
              <span className="text-[12px] text-muted">
                {formatCents(c.available)} · {c.detail}
              </span>
            </span>
            <SoftButton
              mutates
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
      <p className="m-0 text-[12px] leading-snug text-muted">
        The app never takes money from your categories on its own.
      </p>
    </>
  );
}

export function FirstBudget({ b }: { b: BudgetView }) {
  const owed = b.cards.reduce((s, c) => s + c.owed, 0);
  return (
    <section className="flex shrink-0 flex-col gap-1.5 rounded-[14px] bg-accent-soft p-3.5 text-ink">
      <span className="text-[17px] font-bold">Give your {formatCents(b.rta)} a job</span>
      <span className="text-[13px] leading-snug text-ink-2">
        Fund your card payments first ({formatCents(owed)} owed), then bills, everyday spending and savings.
        Targets tell each category what it needs.
      </span>
      <Link
        to="/targets"
        data-track="budget.first.targets"
        className="hit mt-1 flex h-10 items-center self-start rounded-full bg-accent px-4 text-[14px] font-bold text-on-accent no-underline"
      >
        Set targets
      </Link>
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
      <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5">
        <h2 className="m-0 text-[17px] font-bold">{monthName(month)} has started</h2>
        <span className="text-[13px] text-muted">
          Nothing moved on its own. Every category keeps what it had left in {monthName(prev)}, and Ready to
          Assign carried over.
        </span>
        <div className="flex items-center justify-between border-t border-divider pt-2 text-[14px]">
          <span className="font-semibold">Ready to Assign</span>
          <span className="tnum font-bold">{formatCents(b.rta)}</span>
        </div>
      </section>
      {total > 0 && (
        <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-[15px] font-bold">Targets for {monthName(month)}</h2>
            <span className="tnum text-[15px] font-bold">{formatCents(total)}</span>
          </div>
          <span className="text-[13px] text-muted">
            {filled
              ? 'Filled every refill target and this month’s share of each savings goal.'
              : 'Refill targets plus this month’s share of each savings goal.'}
          </span>
          {filled ? (
            <SecondaryButton
              mutates
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
              mutates
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
        </section>
      )}
    </>
  );
}

export function PastNote({ month, current }: { month: string; current: string }) {
  if (compareMonths(month, current) >= 0) return null;
  return (
    <p className="m-0 shrink-0 rounded-xl bg-info-bg px-3 py-2.5 text-[13px] leading-snug text-info-fg">
      {monthName(month)}. You can still change what was assigned; the change carries into {monthName(current)}
      .
    </p>
  );
}
