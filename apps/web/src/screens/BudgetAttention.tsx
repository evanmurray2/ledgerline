// Budget's Needs attention view: sections by status with one-tap fixes, and Undo for what was just done. Low isn't
// here: the Low status word on its row says it.
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AttentionItem, BudgetView } from '@ledgerline/contracts';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Card, cx, SoftButton, TONE, type IconName, type Tone } from '../components/ui';
import { GroupHeader } from './BudgetRows';
import { formatCents } from '../lib/money';
import { useHere } from '../lib/back';
import { toast } from '../components/Toast';
import { usage } from '../usage/tracker';

interface DoneFix {
  key: string;
  categoryId: string;
  name: string;
  delta: number;
}

const SECTION_ORDER: AttentionItem['section'][] = [
  'Ready to Assign',
  'Overspent',
  'Card payments',
  'Underfunded',
  'Low',
  'Overfunded',
  'Owed to you',
];
const SECTION_TONE: Record<AttentionItem['section'], { tone: Tone; icon: IconName }> = {
  'Ready to Assign': { tone: 'over', icon: 'alert' },
  Overspent: { tone: 'over', icon: 'alert' },
  'Card payments': { tone: 'over', icon: 'alert' },
  Underfunded: { tone: 'under', icon: 'half' },
  Low: { tone: 'low', icon: 'down' },
  Overfunded: { tone: 'overfunded', icon: 'up' },
  'Owed to you': { tone: 'under', icon: 'alert' },
};

function fixLabel(fix: NonNullable<AttentionItem['fix']>): string {
  if (fix.verb === 'Review' || fix.verb === 'Move money') return fix.verb;
  return `${fix.verb} ${formatCents(Math.abs(fix.amount))}`;
}

function useFixes(month: string) {
  const [done, setDone] = useState<DoneFix[]>([]);
  const assign = useMoneyMutation(api.assign);
  const apply = async (items: { key: string; categoryId: string; name: string; amount: number }[]) => {
    const started = Date.now();
    await assign.mutateAsync({
      month,
      items: items.map((i) => ({ categoryId: i.categoryId, amount: i.amount })),
    });
    usage.record('task', 'fix', Date.now() - started);
    setDone((d) => [
      ...items.map((i) => ({ key: i.key, categoryId: i.categoryId, name: i.name, delta: i.amount })),
      ...d.filter((x) => !items.some((i) => i.key === x.key)),
    ]);
  };
  const undo = async (f: DoneFix) => {
    await assign.mutateAsync({ month, items: [{ categoryId: f.categoryId, amount: -f.delta }] });
    usage.undo('fix');
    setDone((d) => d.filter((x) => x.key !== f.key));
  };
  return { done, apply, undo, pending: assign.isPending };
}

/**
 * The Budget tab's badge: the Needs attention list, plus Ready to Assign below zero (its banner on Budget). Red when
 * money is short (overspent, a card payment short, Ready to Assign below zero); gray for targets and the rest.
 */
export function budgetBadge(b: BudgetView): { n: number; danger: boolean } {
  const items = b.attention.filter((a) => a.section !== 'Low');
  return {
    n: items.length,
    danger: items.some(
      (a) => a.section === 'Ready to Assign' || a.section === 'Overspent' || a.section === 'Card payments',
    ),
  };
}

// ------------------------------------------------------------------ needs attention

/** Needs attention: everything but Low. */
export function AttentionList({ b, month }: { b: BudgetView; month: string }) {
  const fixes = useFixes(month);
  const navigate = useNavigate();
  // An account or Owed to you opened from this list comes back to it (lib/back.ts).
  const here = useHere();
  // Ready to Assign below zero shows once, in the banner above the list (OverAssigned).
  const open = b.attention.filter(
    (a) => !fixes.done.some((d) => d.key === a.key) && a.section !== 'Ready to Assign' && a.section !== 'Low',
  );
  const sections = SECTION_ORDER.map((s) => ({
    title: s,
    items: open.filter((a) => a.section === s),
  })).filter((s) => s.items.length);
  const availOf = (id: string) =>
    b.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.available ??
    b.cards.find((c) => c.categoryId === id)?.available;
  const run = async (a: AttentionItem) => {
    if (!a.fix) return;
    if (a.link === 'owed') return navigate({ to: '/owed', search: { back: here } });
    if (a.section === 'Ready to Assign') return navigate({ to: '/budget', search: { month, view: 'all' } });
    if (!a.categoryId) return;
    try {
      await fixes.apply([{ key: a.key, categoryId: a.categoryId, name: a.name, amount: a.fix.amount }]);
    } catch (e) {
      toast.show({ text: errorMessage(e) });
    }
  };
  const underfunded = open.filter((a) => a.section === 'Underfunded' && a.fix && a.categoryId);
  const fundAll = async () => {
    try {
      await fixes.apply(
        underfunded.map((a) => ({
          key: a.key,
          categoryId: a.categoryId!,
          name: a.name,
          amount: a.fix!.amount,
        })),
      );
    } catch (e) {
      toast.show({ text: errorMessage(e) });
    }
  };
  return (
    <>
      {open.length === 0 && (
        <p className="m-0 shrink-0 rounded-lg bg-funded-bg p-4 text-center text-base font-semibold text-funded-fg">
          Nothing needs attention.
        </p>
      )}
      {sections.map((sec) => {
        const t = SECTION_TONE[sec.title];
        return (
          <Card key={sec.title}>
            <GroupHeader
              title={sec.title}
              icon={t.icon}
              color={TONE[t.tone].fg}
              right={
                sec.title === 'Underfunded' &&
                underfunded.length > 1 && (
                  <SoftButton
                    tone="filled"
                    mutates="offline"
                    track="budget.attention.fund_all"
                    onClick={() => void fundAll()}
                  >
                    Fund all · {formatCents(underfunded.reduce((s, a) => s + a.fix!.amount, 0))}
                  </SoftButton>
                )
              }
            />
            {sec.items.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
              >
                <Link
                  to={
                    a.link === 'owed'
                      ? '/owed'
                      : a.link === 'card' && a.accountId
                        ? `/accounts/${a.accountId}`
                        : a.categoryId
                          ? `/budget/category/${a.categoryId}`
                          : '/budget'
                  }
                  search={
                    a.link === 'owed' || (a.link === 'card' && a.accountId)
                      ? { back: here }
                      : a.categoryId
                        ? { month }
                        : undefined
                  }
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px] text-ink no-underline"
                >
                  <span className="flex justify-between gap-2">
                    <span className="min-w-0 text-base font-semibold wrap-anywhere">{a.name}</span>
                    {/* Overspent, Short card and Owed amounts are the problem itself; for the rest the balance is
                        just context, and the button says what it needs. */}
                    <span
                      className={cx(
                        'tnum text-md font-bold',
                        sec.title === 'Overspent' || sec.title === 'Card payments' || a.link === 'owed'
                          ? TONE[t.tone].fg
                          : 'text-ink-2',
                      )}
                    >
                      {formatCents(a.amount)}
                    </span>
                  </span>
                  <span className="text-xs text-muted">{a.detail}</span>
                </Link>
                {a.fix && (
                  <SoftButton
                    mutates={a.link !== 'owed' && 'offline'}
                    track={`budget.attention.${a.fix.verb.toLowerCase().replace(' ', '_')}`}
                    aria-label={`${fixLabel(a.fix)} for ${a.name}`}
                    onClick={() => void run(a)}
                    disabled={fixes.pending}
                    className="min-w-[92px]"
                  >
                    {fixLabel(a.fix)}
                  </SoftButton>
                )}
              </div>
            ))}
          </Card>
        );
      })}
      {fixes.done.length > 0 && (
        <Card>
          <GroupHeader title="Done just now" icon="check" color="text-funded-fg" />
          {fixes.done.map((f) => (
            <div
              key={f.key}
              className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
            >
              <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px]">
                <span className="flex justify-between gap-2">
                  <span className="text-base font-semibold">{f.name}</span>
                  <span className="tnum text-md font-bold text-muted">
                    {formatCents(availOf(f.categoryId) ?? 0)}
                  </span>
                </span>
                <span className="text-xs text-muted">
                  {f.delta < 0
                    ? `Moved ${formatCents(-f.delta)} back to Ready to Assign`
                    : `Added ${formatCents(f.delta)} from Ready to Assign`}
                </span>
              </div>
              <SoftButton
                tone="outline"
                mutates="offline"
                track="budget.attention.undo"
                onClick={() => void fixes.undo(f)}
                className="min-w-[92px]"
              >
                Undo
              </SoftButton>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
