// Set targets (the list of every category) and the Target sheet for one category.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { Target } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useCategoriesSettings, useCategorySheet, useMoneyMutation } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  Button,
  cx,
  ErrorNote,
  Field,
  inputClass,
  Label,
  Loading,
  OptionCard,
  PrimaryButton,
  Segmented,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { addMonths, monthLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useBudgetMonth } from './Budget';

// ------------------------------------------------------------------ target

type Kind = 'refill' | 'set_aside' | 'by_date' | 'no_date';
const KINDS: { id: Kind; name: string; desc: string }[] = [
  {
    id: 'refill',
    name: 'Refill',
    desc: 'Have an amount available each month, quarter or year; leftover rolls over',
  },
  { id: 'set_aside', name: 'Set aside', desc: 'Put the same amount in every month, whatever the balance' },
  { id: 'by_date', name: 'Balance by a date', desc: 'Reach a total by a month, in even steps' },
  {
    id: 'no_date',
    name: 'Balance, no date',
    desc: 'Grow toward a total, optionally a set amount each month',
  },
];

function monthsBetween(from: string, to: string) {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

/** The last month of the refill period that contains `month` (periods start at `anchor`, every `n` months). */
function refillDue(anchor: string, n: number, month: string) {
  const idx = (m: string) => {
    const [y, mm] = m.split('-').map(Number) as [number, number];
    return y * 12 + mm - 1;
  };
  const k = Math.floor((idx(month) - idx(anchor)) / n);
  return addMonths(anchor, k * n + n - 1);
}

export function TargetScreen() {
  const { categoryId } = useParams({ strict: false }) as { categoryId: string };
  const { month, current } = useBudgetMonth();
  useScreen('target');
  const q = useCategorySheet(categoryId, month);
  const navigate = useNavigate();
  // Where the target was opened from: the targets list, Categories (a new category), or the category sheet.
  const from = (useSearch({ strict: false }) as { from?: string }).from;
  const m = month === current ? undefined : month;
  const back = () =>
    from === 'targets'
      ? void navigate({ to: '/budget/targets', search: { month: m } })
      : from === 'categories'
        ? void navigate({ to: '/categories' })
        : void navigate({ to: `/budget/category/${categoryId}`, search: { month: m } });
  // After saving, skip the category sheet (it was only a stop on the way): back to the list or the budget.
  const done = () =>
    from === 'targets' || from === 'categories'
      ? back()
      : void navigate({ to: '/budget', search: { month: m } });
  const save = useMoneyMutation((v: { id: string; body: Parameters<typeof api.setTarget>[1] }) =>
    api.setTarget(v.id, v.body),
  );
  const c = q.data;
  const [kind, setKind] = useState<Kind>('refill');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<'1' | '3' | '12'>('1');
  const [due, setDue] = useState('');
  const [byMonth, setByMonth] = useState('');
  const [monthly, setMonthly] = useState('');
  const [asking, setAsking] = useState(false);
  const [init, setInit] = useState(false);
  /** The saved target's kind and amount, so switching kinds and back restores it. */
  const [orig, setOrig] = useState<{ kind: Kind; amount: string } | null>(null);
  // An amount means something different for each kind ($3,000 by June is not $3,000 every month), so a new
  // kind starts empty instead of carrying the old number across.
  const chooseKind = (k: Kind) => {
    if (k === kind) return;
    setKind(k);
    setAmount(orig && orig.kind === k ? orig.amount : '');
  };

  useEffect(() => {
    if (!c || init || !month) return;
    setInit(true);
    const t = c.target;
    if (t.type === 'none') {
      setKind('refill');
      return;
    }
    setKind(t.type);
    setAmount(centsToInput(t.amount));
    setOrig({ kind: t.type, amount: centsToInput(t.amount) });
    if (t.type === 'refill') {
      setPeriod(t.periodMonths === 1 ? '1' : t.periodMonths === 12 ? '12' : '3');
      setDue(refillDue(t.anchor, t.periodMonths, month));
    }
    if (t.type === 'by_date') setByMonth(t.targetMonth);
    if (t.type === 'no_date' && t.monthly !== null) setMonthly(centsToInput(t.monthly));
  }, [c, init, month]);

  const cents = parseCents(amount);
  const target = useMemo<Target | null>(() => {
    if (cents === null || cents <= 0 || !month) return null;
    if (kind === 'refill')
      return {
        type: 'refill',
        amount: cents,
        periodMonths: Number(period) as 1 | 3 | 12,
        // The stored anchor is the first month of a period; the Due month is its last (the target is met by then).
        anchor:
          period === '1' ? month : addMonths(due || addMonths(month, Number(period) - 1), 1 - Number(period)),
      };
    if (kind === 'set_aside') return { type: 'set_aside', amount: cents };
    if (kind === 'by_date') return byMonth ? { type: 'by_date', amount: cents, targetMonth: byMonth } : null;
    const m = parseCents(monthly);
    return { type: 'no_date', amount: cents, monthly: m && m > 0 ? m : null };
  }, [cents, kind, period, due, byMonth, monthly, month]);

  if (!c || !month) {
    return (
      <Sheet label="Target" track="target" onClose={back} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  }
  const summary = (() => {
    if (!target) return ['Enter an amount', 'The target shows what this category needs each month.'];
    const f = (x: number) => formatCents(x, { whole: true });
    switch (target.type) {
      case 'refill': {
        if (target.periodMonths === 1) {
          const nextNeed = Math.max(0, target.amount - c.available);
          return [
            `Needs ${f(target.amount)} this month`,
            `You have ${formatCents(c.available)} left, so next month needs ${formatCents(nextNeed)} to refill.`,
          ];
        }
        // Months left run through the Due month; months of the period before now aren't asked for.
        const end = refillDue(target.anchor, target.periodMonths, month);
        const left = monthsBetween(month, end);
        const per = Math.floor(Math.max(0, target.amount - c.available) / left);
        const word = target.periodMonths === 12 ? 'year' : 'quarter';
        return [
          `Needs ${f(per)} a month`,
          `${f(target.amount)} by ${monthLabel(end)} from what you have now, in ${left === 1 ? 'one step' : `${left} monthly steps`}. Then ${f(Math.floor(target.amount / target.periodMonths))} a month each ${word}; leftover lowers the next ${word}.`,
        ];
      }
      case 'set_aside':
        return [
          `Needs ${f(target.amount)} every month`,
          'The balance keeps growing; spending doesn’t change what’s needed.',
        ];
      case 'by_date': {
        const n = monthsBetween(month, target.targetMonth);
        const per = Math.floor(Math.max(0, target.amount - c.available) / n);
        return [
          `Needs ${f(per)} a month`,
          `${f(target.amount)} by ${monthLabel(target.targetMonth)} from what you have now, in even steps.`,
        ];
      }
      case 'no_date':
        return [
          target.monthly ? `Needs ${f(target.monthly)} a month` : 'No monthly amount',
          `Shows progress toward ${f(target.amount)}; stops asking once reached.`,
        ];
      default:
        return ['', ''];
    }
  })();
  const submit = async (t: Target) => {
    await save.mutateAsync({ id: c.id, body: { categoryId: c.id, month, target: t } });
    done();
  };
  return (
    <Sheet
      label="Target"
      track="target"
      onClose={back}
      gap="small"
      closeLabel={`Back to ${c.name}`}
      header={<SheetTitle title="Target" sub={c.name} />}
      footer={
        <PrimaryButton
          mutates
          track="target.save"
          disabled={!target}
          onClick={() => target && void submit(target)}
        >
          Save target
        </PrimaryButton>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-none p-0">
        <legend className="pb-2 text-[13px] font-bold text-ink-2">What kind of target?</legend>
        {KINDS.map((k) => (
          <OptionCard
            key={k.id}
            selected={kind === k.id}
            onClick={() => chooseKind(k.id)}
            title={k.name}
            desc={k.desc}
            track={`target.kind.${k.id}`}
          />
        ))}
      </fieldset>
      <Field
        label={
          kind === 'refill'
            ? 'Have this much available'
            : kind === 'set_aside'
              ? 'Set aside every month'
              : 'Reach a balance of'
        }
      >
        <input
          className={cx(inputClass, 'tnum text-[18px] font-bold')}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {kind === 'refill' && (
        <>
          <Segmented
            label="Every"
            track="target.period"
            value={period}
            onChange={setPeriod}
            options={[
              ['1', 'Month'],
              ['3', 'Quarter'],
              ['12', 'Year'],
            ]}
          />
          {period !== '1' && (
            <Field label="Due">
              <input
                type="month"
                className={inputClass}
                value={due || addMonths(month, Number(period) - 1)}
                onChange={(e) => setDue(e.target.value)}
              />
            </Field>
          )}
        </>
      )}
      {kind === 'by_date' && (
        <Field label="By">
          <input
            type="month"
            className={inputClass}
            value={byMonth}
            min={month}
            onChange={(e) => setByMonth(e.target.value)}
          />
        </Field>
      )}
      {kind === 'no_date' && (
        <Field label="Add each month (optional)">
          <input
            className={cx(inputClass, 'tnum text-[18px]')}
            inputMode="decimal"
            placeholder="0.00"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </Field>
      )}
      <p className="m-0 rounded-xl bg-page p-3 text-[14px] leading-[1.45]">
        <strong>{summary[0]}</strong>
        <br />
        {summary[1]}
      </p>
      {save.error && <ErrorNote error={save.error} />}
      {c.target.type !== 'none' &&
        (asking ? (
          <div
            role="alertdialog"
            aria-label="Remove target"
            className="flex flex-col gap-2.5 rounded-xl bg-over-bg p-3 text-over-fg"
          >
            <span className="text-[14px] leading-snug">
              Remove the target from {c.name}? The money stays in the category; it just stops showing as
              underfunded or low.
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAsking(false)}
                className="h-11 flex-1 rounded-[10px] border border-line-strong bg-surface text-[14px] font-bold text-ink-2"
              >
                Keep it
              </button>
              <Button
                mutates
                track="target.remove.confirm"
                onClick={() => void submit({ type: 'none' })}
                className="h-11 flex-1 rounded-[10px] bg-danger text-[14px] font-bold text-on-danger"
              >
                Remove target
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-track="target.remove"
            onClick={() => setAsking(true)}
            className="mt-4 min-h-10 self-start text-[14px] font-bold text-over-fg"
          >
            Remove target
          </button>
        ))}
    </Sheet>
  );
}

export function TargetsScreen() {
  useScreen('targets');
  const { month, current } = useBudgetMonth();
  const navigate = useNavigate();
  const q = useCategoriesSettings();
  const m = month === current ? undefined : month;
  const close = () => void navigate({ to: '/budget', search: { month: m } });
  const groups = (q.data?.groups ?? []).filter((g) => !g.system);
  const none = groups.flatMap((g) => g.categories).filter((c) => c.meta.endsWith('No target'));
  return (
    <Sheet
      label="Set targets"
      track="targets"
      onClose={close}
      gap="small"
      header={
        <SheetTitle
          title="Set targets"
          sub={
            !q.data
              ? undefined
              : none.length === 0
                ? 'Every category has a target'
                : `${none.length} ${none.length === 1 ? 'category has' : 'categories have'} no target yet`
          }
        />
      }
    >
      {!q.data && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {groups.map((g) => (
        <div key={g.id} className="flex shrink-0 flex-col gap-2">
          <Label>{g.name}</Label>
          <div className="overflow-hidden rounded-xl border border-line">
            {g.categories.map((c) => {
              const missing = c.meta.endsWith('No target');
              return (
                <Link
                  key={c.id}
                  to={`/budget/category/${c.id}/target`}
                  search={{ month: m, from: 'targets' }}
                  data-track="targets.category"
                  className="flex min-h-14 items-center justify-between gap-3 border-t border-divider bg-surface px-3 py-2 text-ink no-underline first:border-t-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[15px] font-semibold">{c.name}</span>
                    <span className={cx('truncate text-[12px]', missing ? 'text-accent' : 'text-muted')}>
                      {missing ? 'Add a target' : c.meta}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-faint">
                    ›
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </Sheet>
  );
}
