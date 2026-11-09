// Set targets (the list of every category) and the Target sheet for one category.
import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useRouterState, useSearch } from '@tanstack/react-router';
import type { Target } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useCategoriesSettings, useCategorySheet, useMoneyMutation } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  Card,
  ConfirmInline,
  cx,
  DangerLink,
  ErrorNote,
  Field,
  Icon,
  inputBoxClass,
  inputClass,
  Loading,
  OptionCard,
  PrimaryButton,
  SectionTitle,
  Segmented,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { addMonths, compareMonths, monthLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useBudgetMonth } from './Budget';
import { Page } from './settings/common';

// ------------------------------------------------------------------ target

type Kind = 'refill' | 'set_aside' | 'by_date' | 'no_date';
const KINDS: { id: Kind; name: string; desc: string }[] = [
  {
    id: 'refill',
    name: 'Refill',
    desc: 'Have an amount ready each month, quarter or year',
  },
  { id: 'set_aside', name: 'Set aside', desc: 'Add the same amount every month' },
  { id: 'by_date', name: 'Balance by a date', desc: 'Reach a total by a month' },
  { id: 'no_date', name: 'Balance, no date', desc: 'Grow toward a total' },
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
  // Where the target was opened from: the Set targets page, Categories (a new category), or the category sheet.
  const from = (useSearch({ strict: false }) as { from?: string }).from;
  const inTargets = useRouterState({ select: (s) => s.location.pathname.startsWith('/targets') });
  const m = month === current ? undefined : month;
  const back = () =>
    inTargets
      ? void navigate({ to: '/targets', search: { month: m } })
      : from === 'categories'
        ? void navigate({ to: '/categories' })
        : void navigate({ to: `/budget/category/${categoryId}`, search: { month: m } });
  // After saving, skip the category sheet (it was only a stop on the way): back to the list or the budget.
  const done = () =>
    inTargets || from === 'categories' ? back() : void navigate({ to: '/budget', search: { month: m } });
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
    // A month already gone by would ask for nothing and read as funded.
    if (kind === 'by_date')
      return byMonth && compareMonths(byMonth, month) >= 0
        ? { type: 'by_date', amount: cents, targetMonth: byMonth }
        : null;
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
    if (!target)
      return [kind === 'by_date' && cents !== null && cents > 0 ? 'Choose a month' : 'Enter an amount', ''];
    const f = (x: number) => formatCents(x, { whole: true });
    switch (target.type) {
      case 'refill': {
        if (target.periodMonths === 1) {
          const nextNeed = Math.max(0, target.amount - c.available);
          return [
            `Needs ${f(target.amount)} this month`,
            nextNeed > 0
              ? `You have ${formatCents(c.available)} left. Next month needs ${formatCents(nextNeed)}.`
              : `You have ${formatCents(c.available)} left. Next month needs nothing more.`,
          ];
        }
        // Months left run through the Due month; months of the period before now aren't asked for.
        const end = refillDue(target.anchor, target.periodMonths, month);
        const left = monthsBetween(month, end);
        const per = Math.floor(Math.max(0, target.amount - c.available) / left);
        const word = target.periodMonths === 12 ? 'year' : 'quarter';
        return [
          `Needs ${f(per)} a month`,
          `${f(target.amount)} by ${monthLabel(end)}, in ${left === 1 ? '1 step' : `${left} steps`}. After that, ${f(Math.floor(target.amount / target.periodMonths))} a month each ${word}.`,
        ];
      }
      case 'set_aside':
        return [`Needs ${f(target.amount)} every month`, 'Spending doesn’t change it.'];
      case 'by_date': {
        const n = monthsBetween(month, target.targetMonth);
        const per = Math.floor(Math.max(0, target.amount - c.available) / n);
        return [`Needs ${f(per)} a month`, `${f(target.amount)} by ${monthLabel(target.targetMonth)}.`];
      }
      case 'no_date':
        return [
          target.monthly ? `Needs ${f(target.monthly)} a month` : `Toward ${f(target.amount)}`,
          target.monthly
            ? `Until it reaches ${f(target.amount)}.`
            : 'Shows progress only. It asks for nothing each month.',
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
          why={
            !target
              ? cents === null || cents <= 0
                ? 'Enter an amount to save'
                : kind === 'by_date' && byMonth
                  ? `Choose a month from ${monthLabel(month)} on`
                  : 'Choose a month to save'
              : ''
          }
          onClick={() => target && void submit(target)}
        >
          Save target
        </PrimaryButton>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-none p-0">
        <legend className="pb-2 text-sm font-bold text-ink-2">What kind of target?</legend>
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
          className={amountInputClass}
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
            className={cx(inputBoxClass, 'tnum text-xl')}
            inputMode="decimal"
            placeholder="0.00"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </Field>
      )}
      <p className="m-0 rounded-lg bg-page p-3 text-md leading-normal">
        <strong>{summary[0]}</strong>
        {summary[1] && (
          <>
            <br />
            {summary[1]}
          </>
        )}
      </p>
      {save.error && <ErrorNote error={save.error} />}
      {c.target.type !== 'none' &&
        (asking ? (
          <ConfirmInline
            label="Remove target"
            confirmLabel="Remove target"
            track="target.remove.confirm"
            onConfirm={() => void submit({ type: 'none' })}
            onCancel={() => setAsking(false)}
            busy={save.isPending}
          >
            Remove the target from {c.name}? The money stays in the category.
          </ConfirmInline>
        ) : (
          <DangerLink track="target.remove" onClick={() => setAsking(true)} className="mt-4">
            Remove target…
          </DangerLink>
        ))}
    </Sheet>
  );
}

/** Every category and its target, a page of its own like Categories; a row opens that category's Target sheet. */
export function TargetsScreen() {
  useScreen('targets');
  const { month, current } = useBudgetMonth();
  const q = useCategoriesSettings();
  const m = month === current ? undefined : month;
  const groups = (q.data?.groups ?? []).filter((g) => !g.system);
  const none = groups.flatMap((g) => g.categories).filter((c) => c.meta.endsWith('No target'));
  return (
    <Page title="Set targets" back="/budget" backSearch={{ month: m }}>
      {!q.data && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {q.data && (
        <p className="m-0 text-sm text-muted">
          {none.length === 0
            ? 'Every category has a target.'
            : none.length <= 3
              ? `No target yet: ${none.map((c) => c.name).join(', ')}.`
              : `${none.length} categories have no target yet.`}
        </p>
      )}
      {groups.map((g) => (
        <div key={g.id} className="flex shrink-0 flex-col gap-1">
          <SectionTitle>{g.name}</SectionTitle>
          <Card>
            {g.categories.map((c) => {
              const missing = c.meta.endsWith('No target');
              return (
                <Link
                  key={c.id}
                  to={`/targets/${c.id}`}
                  search={{ month: m }}
                  data-track="targets.category"
                  className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-base font-semibold">{c.name}</span>
                    <span
                      className={cx('truncate text-xs', missing ? 'font-semibold text-accent' : 'text-muted')}
                    >
                      {missing ? 'Add a target' : c.meta}
                    </span>
                  </span>
                  <Icon name="chevR" size={18} className="shrink-0 text-faint" />
                </Link>
              );
            })}
          </Card>
        </div>
      ))}
      <Outlet />
    </Page>
  );
}
