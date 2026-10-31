// Category sheet (Assign / Move money, target, recent), Edit target, and the Assign sheet.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { Target } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAssignView, useCategorySheet, useMoneyMutation } from '../api/hooks';
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
  STATUS,
  StatusWord,
  TONE,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { addMonths, dayLabel, monthLabel, monthName } from '../lib/dates';
import { useCategoryOptions, useScreen } from '../lib/common';
import { useBudgetMonth } from './Budget';
import { usage } from '../usage/tracker';
import { useCanWrite } from '../state/connectivity';

function useCloseToBudget(month: string | undefined, current: string | undefined) {
  const navigate = useNavigate();
  return () => void navigate({ to: '/budget', search: { month: month === current ? undefined : month } });
}

// ------------------------------------------------------------------ category sheet

export function CategorySheetScreen() {
  const { categoryId } = useParams({ strict: false }) as { categoryId: string };
  const { month, current } = useBudgetMonth();
  useScreen('category');
  const q = useCategorySheet(categoryId, month);
  const close = useCloseToBudget(month, current);
  const navigate = useNavigate();
  const [mode, setMode] = useState<'assign' | 'move'>('assign');
  const [assigned, setAssigned] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string>('');
  const [moveAmt, setMoveAmt] = useState('');
  const set = useMoneyMutation(api.setAssigned);
  const move = useMoneyMutation(api.move);
  const c = q.data;

  useEffect(() => {
    usage.startTask('assign');
    return () => usage.cancelTask('assign');
  }, []);
  useEffect(() => {
    if (c && assigned === null) setAssigned(centsToInput(c.assigned));
    if (c && !moveTo) setMoveTo(c.moveOptions[0]?.id ?? 'rta');
  }, [c, assigned, moveTo]);

  if (!c || !month) {
    return (
      <Sheet label="Category" track="category" onClose={close}>
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  }
  const st = STATUS[c.status];
  const newAssigned = parseCents(assigned ?? '');
  const changed = newAssigned !== null && newAssigned !== c.assigned;
  const available = c.available + (newAssigned !== null ? newAssigned - c.assigned : 0);
  const moveCents = parseCents(moveAmt);
  const moveOk = moveCents !== null && moveCents > 0 && !!moveTo;
  const target = c.target.type === 'refill' || c.target.type === 'set_aside' ? c.target.amount : null;
  const save = async () => {
    if (mode === 'assign') {
      if (newAssigned === null) return;
      await set.mutateAsync({ month, categoryId: c.id, assigned: newAssigned });
      usage.endTask('assign');
    } else {
      if (!moveOk) return;
      await move.mutateAsync({ month, from: c.id, to: moveTo, amount: moveCents });
      usage.endTask('assign');
    }
    close();
  };
  const err = set.error ?? move.error;
  return (
    <Sheet
      label={c.name}
      track="category"
      onClose={close}
      header={
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 text-[20px] font-bold">{c.name}</h1>
          <span className={cx('inline-flex items-center gap-1 text-[13px] font-bold', TONE[st.tone].fg)}>
            <StatusWord word="" tone={st.tone} icon={st.icon} />
            {c.statusText}
          </span>
        </div>
      }
      footer={
        <PrimaryButton mutates track={mode === 'assign' ? 'category.save' : 'category.move'} onClick={save} disabled={mode === 'assign' ? !changed : !moveOk}>
          {mode === 'assign' ? 'Save' : `Move ${moveCents && moveCents > 0 ? formatCents(moveCents) : ''}`.trim()}
        </PrimaryButton>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-0.5 rounded-xl bg-page p-2.5">
          <span className="text-[12px] text-muted">Assigned</span>
          <span className="tnum text-[16px] font-bold">{formatCents(c.assigned)}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-xl bg-page p-2.5">
          <span className="text-[12px] text-muted">{c.status === 'invested' ? 'Invested' : 'Spent'}</span>
          <span className="tnum text-[16px] font-bold">{formatCents(-c.spent)}</span>
        </div>
        <div className={cx('flex flex-col gap-0.5 rounded-xl p-2.5', TONE[st.tone].bg)}>
          <span className={cx('text-[12px]', TONE[st.tone].fg)}>Available</span>
          <span className={cx('tnum text-[16px] font-bold', TONE[st.tone].fg)} data-testid="category-available">
            {formatCents(available)}
          </span>
        </div>
      </div>
      <Segmented
        label="Mode"
        track="category.mode"
        value={mode}
        onChange={setMode}
        options={[
          ['assign', 'Assign'],
          ['move', 'Move money'],
        ]}
      />
      {mode === 'assign' ? (
        <>
          <Field label={`Assigned in ${monthName(month)}`}>
            <input
              className={cx(inputClass, 'tnum text-[18px] font-bold')}
              inputMode="decimal"
              value={assigned ?? ''}
              onChange={(e) => setAssigned(e.target.value)}
              aria-invalid={newAssigned === null}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <QuickChip label="+ $50" onClick={() => setAssigned(centsToInput((newAssigned ?? c.assigned) + 5000))} />
            {c.lastMonthAssigned > 0 && (
              <QuickChip label={`Last month ${formatCents(c.lastMonthAssigned, { whole: true })}`} onClick={() => setAssigned(centsToInput(c.lastMonthAssigned))} />
            )}
            {target !== null && <QuickChip label={`Target ${formatCents(target, { whole: true })}`} onClick={() => setAssigned(centsToInput(target))} />}
          </div>
          <p className="m-0 text-[12px] text-muted">The difference comes from or goes back to Ready to Assign ({formatCents(c.rta)}).</p>
        </>
      ) : (
        <>
          <Field label="Move to">
            <select className={inputClass} value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {c.moveOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <input className={cx(inputClass, 'tnum text-[18px] font-bold')} inputMode="decimal" placeholder="0.00" value={moveAmt} onChange={(e) => setMoveAmt(e.target.value)} />
          </Field>
          <p className="m-0 text-[12px] text-muted">
            {c.name} would have {formatCents(c.available - (moveCents ?? 0))} left.
          </p>
        </>
      )}
      {err && <ErrorNote error={err} />}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
        <div className="flex flex-col gap-0.5">
          <Label>Target</Label>
          <span className="text-[14px] font-semibold">{c.targetText}</span>
          <span className="text-[12px] text-muted">{c.targetHelp}</span>
        </div>
        <Link
          to={`/budget/category/${c.id}/target`}
          search={{ month }}
          data-track="category.target.edit"
          className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3.5 text-[13px] font-bold text-accent no-underline"
        >
          Edit
        </Link>
      </div>
      <div className="flex flex-col">
        <div className="flex items-center justify-between">
          <Label>Recent</Label>
          {c.recentTotal > 0 && (
            <button type="button" data-track="category.see_all" onClick={() => void navigate({ to: '/activity', search: { q: c.name } })} className="flex min-h-9 items-center text-[13px] font-bold text-accent">
              See all {c.recentTotal}
            </button>
          )}
        </div>
        {c.recent.length === 0 && <p className="m-0 py-3 text-[13px] text-muted">No transactions yet this month.</p>}
        {c.recent.map((r) => (
          <Link key={r.key} to={`/activity/txn/${r.key}`} className="flex min-h-12 items-center justify-between border-t border-divider text-[14px] text-ink no-underline">
            <span className="flex flex-col gap-px">
              <span className="font-semibold">{r.payee}</span>
              <span className="text-[12px] text-muted">{[dayLabel(r.date), r.accountName, r.badge === 'By rule' ? 'by rule' : r.categoryLabel === 'split' ? 'split' : null].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="tnum font-bold">{formatCents(r.amount)}</span>
          </Link>
        ))}
      </div>
    </Sheet>
  );
}

function QuickChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" data-track="category.quick" onClick={onClick} className="hit h-9 rounded-full border border-line-strong bg-surface px-3.5 text-[13px] font-semibold text-ink-2">
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ target

type Kind = 'refill' | 'set_aside' | 'by_date' | 'no_date';
const KINDS: { id: Kind; name: string; desc: string }[] = [
  { id: 'refill', name: 'Refill', desc: 'Have an amount available each month, quarter or year; leftover rolls over' },
  { id: 'set_aside', name: 'Set aside', desc: 'Put the same amount in every month, whatever the balance' },
  { id: 'by_date', name: 'Balance by a date', desc: 'Reach a total by a month, in even steps' },
  { id: 'no_date', name: 'Balance, no date', desc: 'Grow toward a total, optionally a set amount each month' },
];

function monthsBetween(from: string, to: string) {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
}

export function TargetScreen() {
  const { categoryId } = useParams({ strict: false }) as { categoryId: string };
  const { month, current } = useBudgetMonth();
  useScreen('target');
  const q = useCategorySheet(categoryId, month);
  const navigate = useNavigate();
  const back = () => void navigate({ to: `/budget/category/${categoryId}`, search: { month: month === current ? undefined : month } });
  const save = useMoneyMutation((v: { id: string; body: Parameters<typeof api.setTarget>[1] }) => api.setTarget(v.id, v.body));
  const c = q.data;
  const [kind, setKind] = useState<Kind>('refill');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<'1' | '3' | '12'>('1');
  const [due, setDue] = useState('');
  const [byMonth, setByMonth] = useState('');
  const [monthly, setMonthly] = useState('');
  const [asking, setAsking] = useState(false);
  const [init, setInit] = useState(false);

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
    if (t.type === 'refill') {
      setPeriod(t.periodMonths === 1 ? '1' : t.periodMonths === 12 ? '12' : '3');
      setDue(t.anchor);
    }
    if (t.type === 'by_date') setByMonth(t.targetMonth);
    if (t.type === 'no_date' && t.monthly !== null) setMonthly(centsToInput(t.monthly));
  }, [c, init, month]);

  const cents = parseCents(amount);
  const target = useMemo<Target | null>(() => {
    if (cents === null || cents <= 0 || !month) return null;
    if (kind === 'refill') return { type: 'refill', amount: cents, periodMonths: Number(period) as 1 | 3 | 12, anchor: period === '1' ? month : due || addMonths(month, Number(period) - 1) };
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
          return [`Needs ${f(target.amount)} this month`, `You have ${formatCents(c.available)} left, so next month needs ${formatCents(nextNeed)} to refill.`];
        }
        const per = Math.floor(target.amount / target.periodMonths);
        const word = target.periodMonths === 12 ? 'year' : 'quarter';
        return [`Needs ${f(per)} a month`, `${f(target.amount)} per ${word} in ${target.periodMonths === 12 ? 'twelve' : 'three'} monthly steps. Leftover lowers the next ${word}.`];
      }
      case 'set_aside':
        return [`Needs ${f(target.amount)} every month`, 'The balance keeps growing; spending doesn’t change what’s needed.'];
      case 'by_date': {
        const n = monthsBetween(month, target.targetMonth);
        const per = Math.floor(Math.max(0, target.amount - c.available) / n);
        return [`Needs ${f(per)} a month`, `${f(target.amount)} by ${monthLabel(target.targetMonth)} from what you have now, in even steps.`];
      }
      case 'no_date':
        return [target.monthly ? `Needs ${f(target.monthly)} a month` : 'No monthly amount', `Shows progress toward ${f(target.amount)}; stops asking once reached.`];
      default:
        return ['', ''];
    }
  })();
  const submit = async (t: Target) => {
    await save.mutateAsync({ id: c.id, body: { categoryId: c.id, month, target: t } });
    back();
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
        <PrimaryButton mutates track="target.save" disabled={!target} onClick={() => target && void submit(target)}>
          Save target
        </PrimaryButton>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-none p-0">
        <legend className="pb-2 text-[13px] font-bold text-ink-2">What kind of target?</legend>
        {KINDS.map((k) => (
          <OptionCard key={k.id} selected={kind === k.id} onClick={() => setKind(k.id)} title={k.name} desc={k.desc} track={`target.kind.${k.id}`} />
        ))}
      </fieldset>
      <Field label={kind === 'refill' ? 'Have this much available' : kind === 'set_aside' ? 'Set aside every month' : 'Reach a balance of'}>
        <input className={cx(inputClass, 'tnum text-[18px] font-bold')} inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
              <input type="month" className={inputClass} value={due || addMonths(month, Number(period) - 1)} onChange={(e) => setDue(e.target.value)} />
            </Field>
          )}
        </>
      )}
      {kind === 'by_date' && (
        <Field label="By">
          <input type="month" className={inputClass} value={byMonth} min={month} onChange={(e) => setByMonth(e.target.value)} />
        </Field>
      )}
      {kind === 'no_date' && (
        <Field label="Add each month (optional)">
          <input className={cx(inputClass, 'tnum text-[18px]')} inputMode="decimal" placeholder="0.00" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
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
          <div role="alertdialog" aria-label="Remove target" className="flex flex-col gap-2.5 rounded-xl bg-over-bg p-3 text-over-fg">
            <span className="text-[14px] leading-snug">
              Remove the target from {c.name}? The money stays in the category; it just stops showing as underfunded or low.
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setAsking(false)} className="h-11 flex-1 rounded-[10px] border border-line-strong bg-surface text-[14px] font-bold text-ink-2">
                Keep it
              </button>
              <Button mutates track="target.remove.confirm" onClick={() => void submit({ type: 'none' })} className="h-11 flex-1 rounded-[10px] bg-danger text-[14px] font-bold text-on-danger">
                Remove target
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" data-track="target.remove" onClick={() => setAsking(true)} className="min-h-9 self-start text-[14px] font-bold text-over-fg">
            Remove target
          </button>
        ))}
    </Sheet>
  );
}

// ------------------------------------------------------------------ assign sheet

export function AssignSheetScreen() {
  const { month, current } = useBudgetMonth();
  useScreen('assign');
  const q = useAssignView(month);
  const close = useCloseToBudget(month, current);
  const assign = useMoneyMutation(api.assign);
  const { groups } = useCategoryOptions();
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [catId, setCatId] = useState('');
  const [custom, setCustom] = useState('');
  const canWrite = useCanWrite();

  useEffect(() => {
    usage.startTask('assign');
    return () => usage.cancelTask('assign');
  }, []);

  const v = q.data;
  if (!v || !month) {
    return (
      <Sheet label="Assign money" track="assign" onClose={close} gap="large">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  }
  const defaultOn = (s: (typeof v.suggestions)[number]) => s.reason !== 'target' || /^Underfunded/.test(s.detail);
  const isOn = (s: (typeof v.suggestions)[number]) => (off[s.categoryId] === undefined ? defaultOn(s) : !off[s.categoryId]);
  const chosen = v.suggestions.filter(isOn);
  const customCents = parseCents(custom);
  const items = new Map<string, number>();
  for (const s of chosen) items.set(s.categoryId, (items.get(s.categoryId) ?? 0) + s.amount);
  if (catId && customCents) items.set(catId, (items.get(catId) ?? 0) + customCents);
  const sum = [...items.values()].reduce((a, x) => a + x, 0);
  const left = v.rta - sum;
  const apply = async () => {
    if (items.size === 0) return;
    await assign.mutateAsync({ month, items: [...items].map(([categoryId, amount]) => ({ categoryId, amount })) });
    usage.endTask('assign');
    close();
  };
  return (
    <Sheet
      label="Assign money"
      track="assign"
      onClose={close}
      gap="large"
      header={<SheetTitle title={`Assign ${formatCents(v.rta)}`} sub={`Ready to Assign in ${monthName(month)}`} />}
      footer={
        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-[14px]">
            <span className="text-muted">Left to assign after this</span>
            <span className={cx('tnum font-bold', left < 0 ? 'text-over-fg' : 'text-ink')} data-testid="assign-left">
              {formatCents(left)}
            </span>
          </div>
          {left < 0 && (
            <p role="alert" className="m-0 text-[13px] leading-snug text-over-fg">
              That’s {formatCents(-left)} more than you have. Ready to Assign would go negative and show in Needs attention until you take money back from a
              category.
            </p>
          )}
          <PrimaryButton mutates track={left < 0 ? 'assign.anyway' : 'assign.apply'} danger={left < 0} disabled={items.size === 0 || !canWrite} onClick={() => void apply()}>
            {items.size === 0 ? 'Nothing selected' : left < 0 ? 'Assign anyway' : sum >= 0 ? `Assign ${formatCents(sum)}` : `Move ${formatCents(-sum)} back`}
          </PrimaryButton>
          {assign.error && <ErrorNote error={assign.error} />}
        </div>
      }
    >
      {v.suggestions.length > 0 && (
        <>
          <Label>Suggested</Label>
          <div className="shrink-0 overflow-hidden rounded-[14px] border border-line">
            {v.suggestions.map((s) => (
              <label key={s.categoryId} className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-1.5 first:border-t-0">
                <input
                  type="checkbox"
                  className="hit h-[22px] w-[22px] shrink-0 accent-[var(--ll-accent)]"
                  checked={isOn(s)}
                  data-track="assign.suggestion"
                  onChange={() => setOff((o) => ({ ...o, [s.categoryId]: isOn(s) }))}
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold">{s.name}</span>
                  <span className="text-[12px] text-muted">{s.detail}</span>
                </span>
                <span className="tnum text-[15px] font-bold">{formatCents(s.amount)}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <Label>Or assign to any category</Label>
      <div className="flex gap-2">
        <Field label="Category" className="flex-[3] text-[12px]">
          <select className={inputClass} value={catId} onChange={(e) => setCatId(e.target.value)}>
            <option value="">Choose…</option>
            {groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Amount" className="flex-[2] text-[12px]">
          <input className={cx(inputClass, 'tnum')} inputMode="decimal" placeholder="0.00" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}

