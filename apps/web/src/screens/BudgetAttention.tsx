// Budget's Needs attention and Low views: sections by status with one-tap fixes, and Undo for what was just done.
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AttentionItem, BudgetView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Button, Card, cx, Icon, SoftButton, TONE, type IconName, type Tone } from '../components/ui';
import { formatCents } from '../lib/money';
import { useCanWrite } from '../state/connectivity';
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
  'Underfunded',
  'Low',
  'Overfunded',
  'Owed to you',
];
const SECTION_TONE: Record<AttentionItem['section'], { tone: Tone; icon: IconName }> = {
  'Ready to Assign': { tone: 'over', icon: 'alert' },
  Overspent: { tone: 'over', icon: 'alert' },
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

// ------------------------------------------------------------------ needs attention

/** Needs attention (everything but Low), or Low on its own filter. */
export function AttentionList({ b, month, low = false }: { b: BudgetView; month: string; low?: boolean }) {
  const fixes = useFixes(month);
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const open = b.attention.filter(
    (a) => !fixes.done.some((d) => d.key === a.key) && (a.section === 'Low') === low,
  );
  const sections = SECTION_ORDER.map((s) => ({
    title: s,
    items: open.filter((a) => a.section === s),
  })).filter((s) => s.items.length);
  const availOf = (id: string) => b.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.available;
  const run = async (a: AttentionItem) => {
    if (!a.fix) return;
    if (a.link === 'owed') return navigate({ to: '/owed' });
    if (a.section === 'Ready to Assign') return navigate({ to: '/budget', search: { month, view: 'all' } });
    if (!a.categoryId) return;
    try {
      await fixes.apply([{ key: a.key, categoryId: a.categoryId, name: a.name, amount: a.fix.amount }]);
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
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
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
    }
  };
  return (
    <>
      {open.length === 0 && (
        <p className="m-0 shrink-0 rounded-[14px] bg-funded-bg p-4 text-center text-[15px] font-semibold text-funded-fg">
          {low ? 'Nothing is running low.' : 'Nothing needs attention.'}
        </p>
      )}
      {sections.map((sec) => {
        const t = SECTION_TONE[sec.title];
        return (
          <Card key={sec.title}>
            <div className="flex min-h-11 items-center justify-between border-b border-line bg-surface-2 pl-3 pr-2">
              <h2
                className={cx(
                  'm-0 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.6px]',
                  TONE[t.tone].fg,
                )}
              >
                <Icon name={t.icon} size={14} stroke={2.6} />
                {sec.title}
              </h2>
              {sec.title === 'Underfunded' && underfunded.length > 1 && (
                <Button
                  mutates
                  track="budget.attention.fund_all"
                  onClick={fundAll}
                  className="hit h-9 rounded-full bg-accent px-3 text-[13px] font-bold text-on-accent disabled:bg-disabled-bg disabled:text-muted"
                >
                  Fund all · {formatCents(underfunded.reduce((s, a) => s + a.fix!.amount, 0))}
                </Button>
              )}
            </div>
            {sec.items.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
              >
                <Link
                  to={
                    a.link === 'owed'
                      ? '/owed'
                      : a.categoryId
                        ? `/budget/category/${a.categoryId}`
                        : '/budget'
                  }
                  search={a.categoryId ? { month } : undefined}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px] text-ink no-underline"
                >
                  <span className="flex justify-between gap-2">
                    <span className="text-[15px] font-semibold">{a.name}</span>
                    {/* Overspent and Owed amounts are the problem itself; for the rest the balance is just
                        context, and the button says what it needs. */}
                    <span
                      className={cx(
                        'tnum text-[14px] font-bold',
                        sec.title === 'Overspent' || a.link === 'owed' ? TONE[t.tone].fg : 'text-ink-2',
                      )}
                    >
                      {formatCents(a.amount)}
                    </span>
                  </span>
                  <span className="text-[12px] text-muted">{a.detail}</span>
                </Link>
                {a.fix && (
                  <SoftButton
                    mutates={a.link !== 'owed'}
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
          <div className="flex min-h-11 items-center border-b border-line bg-surface-2 px-3">
            <h2 className="m-0 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.6px] text-funded-fg">
              <Icon name="check" size={14} stroke={2.6} />
              Done just now
            </h2>
          </div>
          {fixes.done.map((f) => (
            <div
              key={f.key}
              className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
            >
              <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px]">
                <span className="flex justify-between gap-2">
                  <span className="text-[15px] font-semibold">{f.name}</span>
                  <span className="tnum text-[14px] font-bold text-muted">
                    {formatCents(availOf(f.categoryId) ?? 0)}
                  </span>
                </span>
                <span className="text-[12px] text-muted">
                  {f.delta < 0
                    ? `Moved ${formatCents(-f.delta)} back to Ready to Assign`
                    : `Added ${formatCents(f.delta)} from Ready to Assign`}
                </span>
              </div>
              <Button
                mutates
                track="budget.attention.undo"
                disabled={!canWrite}
                onClick={() => void fixes.undo(f)}
                className="hit h-9 min-w-[92px] shrink-0 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-bold text-ink-2"
              >
                Undo
              </Button>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
