// Category sheet (Assign / Move money, target, recent) and the Assign sheet.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useAssignView, useBudget, useCategorySheet, useMoneyMutation } from '../api/hooks';
import { CategoryField } from '../components/CategoryPicker';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  cx,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  Segmented,
  STATUS,
  StatusWord,
  TONE,
  useIsDesktop,
  useShortcuts,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel, monthName } from '../lib/dates';
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
  // A fresh sheet per category, so going to the next one doesn't carry the typed amount along.
  return <CategorySheet key={categoryId} categoryId={categoryId} />;
}

/** Desktop: up and down (the arrow buttons or keys) step through the categories in Budget order. */
function useCategorySteps(categoryId: string, month: string | undefined, current: string | undefined) {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const b = useBudget(month).data;
  const ids = b ? b.groups.flatMap((g) => g.categories.map((c) => c.id)) : [];
  const i = ids.indexOf(categoryId);
  const go = (id: string | undefined) =>
    id &&
    void navigate({
      to: `/budget/category/${id}`,
      search: { month: month === current ? undefined : month },
    });
  const prev = i > 0 ? () => go(ids[i - 1]) : undefined;
  const next = i >= 0 && i < ids.length - 1 ? () => go(ids[i + 1]) : undefined;
  useShortcuts({ ArrowUp: () => prev?.(), ArrowDown: () => next?.() }, desktop && i >= 0);
  if (!desktop || i < 0) return null;
  const btn = (label: string, key: string, icon: 'up' | 'down', fn: (() => void) | undefined) => (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={key}
      title={`${label} (${key === 'ArrowUp' ? '↑' : '↓'})`}
      disabled={!fn}
      onClick={fn}
      data-track={`category.${icon === 'up' ? 'prev' : 'next'}`}
      className="flex h-11 w-9 items-center justify-center text-ink-2 disabled:text-line-strong"
    >
      <Icon name={icon} size={18} />
    </button>
  );
  return (
    <span className="flex shrink-0">
      {btn('Previous category', 'ArrowUp', 'up', prev)}
      {btn('Next category', 'ArrowDown', 'down', next)}
    </span>
  );
}

function CategorySheet({ categoryId }: { categoryId: string }) {
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
  const steps = useCategorySteps(categoryId, month, current);
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
        <div className="flex items-start justify-between gap-1">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="m-0 text-[20px] font-bold">{c.name}</h1>
            <span className={cx('inline-flex items-center gap-1 text-[13px] font-bold', TONE[st.tone].fg)}>
              <StatusWord word="" tone={st.tone} icon={st.icon} />
              {c.statusText}
            </span>
          </div>
          {steps}
        </div>
      }
      footer={
        <PrimaryButton
          mutates
          track={mode === 'assign' ? 'category.save' : 'category.move'}
          onClick={save}
          disabled={mode === 'assign' ? !changed : !moveOk}
        >
          {mode === 'assign'
            ? 'Save'
            : `Move ${moveCents && moveCents > 0 ? formatCents(moveCents) : ''}`.trim()}
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
          <span className="tnum text-[16px] font-bold">{formatCents(c.spent)}</span>
        </div>
        <div className={cx('flex flex-col gap-0.5 rounded-xl p-2.5', TONE[st.tone].bg)}>
          <span className={cx('text-[12px]', TONE[st.tone].fg)}>Available</span>
          <span
            className={cx('tnum text-[16px] font-bold', TONE[st.tone].fg)}
            data-testid="category-available"
          >
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
            <QuickChip
              label="+ $50"
              onClick={() => setAssigned(centsToInput((newAssigned ?? c.assigned) + 5000))}
            />
            {c.lastMonthAssigned > 0 && (
              <QuickChip
                label={`Last month ${formatCents(c.lastMonthAssigned, { whole: true })}`}
                onClick={() => setAssigned(centsToInput(c.lastMonthAssigned))}
              />
            )}
            {target !== null && (
              <QuickChip
                label={`Target ${formatCents(target, { whole: true })}`}
                onClick={() => setAssigned(centsToInput(target))}
              />
            )}
          </div>
          <p className="m-0 text-[12px] text-muted">
            The difference comes from or goes back to Ready to Assign ({formatCents(c.rta)}).
          </p>
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
            <input
              className={cx(inputClass, 'tnum text-[18px] font-bold')}
              inputMode="decimal"
              placeholder="0.00"
              value={moveAmt}
              onChange={(e) => setMoveAmt(e.target.value)}
            />
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
            <button
              type="button"
              data-track="category.see_all"
              onClick={() => void navigate({ to: '/activity', search: { q: c.name } })}
              className="flex min-h-9 items-center text-[13px] font-bold text-accent"
            >
              See all {c.recentTotal}
            </button>
          )}
        </div>
        {c.recent.length === 0 && (
          <p className="m-0 py-3 text-[13px] text-muted">No transactions yet this month.</p>
        )}
        {c.recent.map((r) => (
          <Link
            key={r.key}
            to={`/activity/txn/${r.key}`}
            className="flex min-h-12 items-center justify-between border-t border-divider text-[14px] text-ink no-underline"
          >
            <span className="flex flex-col gap-px">
              <span className="font-semibold">{r.payee}</span>
              <span className="text-[12px] text-muted">
                {[
                  dayLabel(r.date),
                  r.accountName,
                  r.badge === 'By rule' ? 'by rule' : r.categoryLabel === 'split' ? 'split' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
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
    <button
      type="button"
      data-track="category.quick"
      onClick={onClick}
      className="hit h-9 rounded-full border border-line-strong bg-surface px-3.5 text-[13px] font-semibold text-ink-2"
    >
      {label}
    </button>
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
  const canWrite = useCanWrite({ offline: true });

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
  const defaultOn = (s: (typeof v.suggestions)[number]) =>
    s.reason !== 'target' || /^Underfunded/.test(s.detail);
  const isOn = (s: (typeof v.suggestions)[number]) =>
    off[s.categoryId] === undefined ? defaultOn(s) : !off[s.categoryId];
  const chosen = v.suggestions.filter(isOn);
  const customCents = parseCents(custom);
  const items = new Map<string, number>();
  for (const s of chosen) items.set(s.categoryId, (items.get(s.categoryId) ?? 0) + s.amount);
  if (catId && customCents) items.set(catId, (items.get(catId) ?? 0) + customCents);
  const sum = [...items.values()].reduce((a, x) => a + x, 0);
  const left = v.rta - sum;
  const apply = async () => {
    if (items.size === 0) return;
    await assign.mutateAsync({
      month,
      items: [...items].map(([categoryId, amount]) => ({ categoryId, amount })),
    });
    usage.endTask('assign');
    close();
  };
  return (
    <Sheet
      label="Assign money"
      track="assign"
      onClose={close}
      gap="large"
      header={
        <SheetTitle title={`Assign ${formatCents(v.rta)}`} sub={`Ready to Assign in ${monthName(month)}`} />
      }
      footer={
        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-[14px]">
            <span className="text-muted">Left to assign after this</span>
            <span
              className={cx('tnum font-bold', left < 0 ? 'text-over-fg' : 'text-ink')}
              data-testid="assign-left"
            >
              {formatCents(left)}
            </span>
          </div>
          {left < 0 && (
            <p role="alert" className="m-0 text-[13px] leading-snug text-over-fg">
              That’s {formatCents(-left)} more than you have. Ready to Assign would go negative and show in
              Needs attention until you take money back from a category.
            </p>
          )}
          <PrimaryButton
            mutates="offline"
            track={left < 0 ? 'assign.anyway' : 'assign.apply'}
            danger={left < 0}
            disabled={items.size === 0 || !canWrite}
            onClick={() => void apply()}
          >
            {items.size === 0
              ? 'Nothing selected'
              : left < 0
                ? 'Assign anyway'
                : sum >= 0
                  ? `Assign ${formatCents(sum)}`
                  : `Move ${formatCents(-sum)} back`}
          </PrimaryButton>
          {assign.error && <ErrorNote error={assign.error} />}
        </div>
      }
    >
      {v.suggestions.length > 0 && (
        <>
          <div className="flex min-h-9 items-center justify-between">
            <Label>Suggested</Label>
            {v.suggestions.length > 1 && (
              // Clearing or picking every suggestion one checkbox at a time took dozens of taps.
              <button
                type="button"
                data-track={chosen.length > 0 ? 'assign.clear_all' : 'assign.select_all'}
                onClick={() => {
                  const clear = chosen.length > 0;
                  setOff(Object.fromEntries(v.suggestions.map((x) => [x.categoryId, clear])));
                }}
                className="hit h-9 px-1 text-[14px] font-bold text-accent"
              >
                {chosen.length > 0 ? 'Clear all' : 'Select all'}
              </button>
            )}
          </div>
          <div className="shrink-0 overflow-hidden rounded-[14px] border border-line">
            {v.suggestions.map((s) => (
              <label
                key={s.categoryId}
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-1.5 first:border-t-0"
              >
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
          <CategoryField
            track="assign.category"
            value={catId}
            onChange={setCatId}
            groups={groups.map((g) => ({ key: g.id, name: g.name, categories: g.categories }))}
          />
        </Field>
        <Field label="Amount" className="flex-[2] text-[12px]">
          <input
            className={cx(inputClass, 'tnum')}
            inputMode="decimal"
            placeholder="0.00"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}

/** Every category and its target on one list: tap one, save, and you're back here for the next. */
