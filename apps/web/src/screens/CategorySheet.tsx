// Category sheet: Assign / Move money, target, recent.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { useBudget, useCategorySheet, useMoneyMutation } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  Card,
  cx,
  EmptyNote,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  Segmented,
  SoftButton,
  SoftLink,
  STATUS,
  StatusWord,
  TextButton,
  TONE,
  useIsDesktop,
  useShortcuts,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel, monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useBudgetMonth } from './Budget';
import { usage } from '../usage/tracker';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
import { useCloseToBudget } from './BudgetSheets';

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
      className="flex h-11 w-11 items-center justify-center text-ink-2 disabled:text-line-strong"
    >
      <Icon name={icon} size={22} />
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
  // Enter (or the keyboard's Go) saves, as the button does when it can.
  const busy = set.isPending || move.isPending;
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!busy && (mode === 'assign' ? changed : moveOk)) void save().catch(() => undefined);
  };
  return (
    <Sheet
      label={c.name}
      track="category"
      onClose={close}
      header={
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <SheetTitle
              title={c.name}
              sub={
                <span className={cx('inline-flex items-center gap-1 font-bold', TONE[st.tone].fg)}>
                  <StatusWord word="" tone={st.tone} icon={st.icon} />
                  {c.statusText}
                </span>
              }
            />
          </div>
          <span className="flex shrink-0">
            <PinButton id={c.id} name={c.name} month={month} />
            {steps}
          </span>
        </div>
      }
      footer={
        <PrimaryButton
          mutates="offline"
          track={mode === 'assign' ? 'category.save' : 'category.move'}
          onClick={save}
          busy={busy}
          disabled={mode === 'assign' ? !changed : !moveOk}
          why={
            mode === 'assign'
              ? newAssigned === null
                ? 'Enter an amount to save'
                : !changed
                  ? 'Change the amount to save'
                  : ''
              : !moveOk
                ? 'Enter an amount to move'
                : ''
          }
        >
          {mode === 'assign'
            ? 'Save'
            : `Move ${moveCents && moveCents > 0 ? formatCents(moveCents) : ''}`.trim()}
        </PrimaryButton>
      }
    >
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-0.5 rounded-lg bg-page p-2.5">
          <span className="text-xs text-muted">Assigned</span>
          <span className="tnum text-lg font-bold">{formatCents(c.assigned)}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg bg-page p-2.5">
          <span className="text-xs text-muted">{c.status === 'invested' ? 'Invested' : 'Spent'}</span>
          <span className="tnum text-lg font-bold">{formatCents(c.spent)}</span>
        </div>
        <div className={cx('flex flex-col gap-0.5 rounded-lg p-2.5', TONE[st.tone].bg)}>
          <span className={cx('text-xs', TONE[st.tone].fg)}>Available</span>
          <span className={cx('tnum text-lg font-bold', TONE[st.tone].fg)} data-testid="category-available">
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
              className={amountInputClass}
              inputMode="decimal"
              value={assigned ?? ''}
              onChange={(e) => setAssigned(e.target.value)}
              onKeyDown={onEnter}
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
          <p className="m-0 text-xs text-muted">Ready to Assign has {formatCents(c.rta)}.</p>
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
              className={amountInputClass}
              inputMode="decimal"
              placeholder="0.00"
              value={moveAmt}
              onChange={(e) => setMoveAmt(e.target.value)}
              onKeyDown={onEnter}
            />
          </Field>
          <p className="m-0 text-xs text-muted">
            {c.available - (moveCents ?? 0) < 0
              ? `${c.name} would be overspent by ${formatCents(moveCents! - c.available)}.`
              : `${c.name} would have ${formatCents(c.available - (moveCents ?? 0))} left.`}
          </p>
        </>
      )}
      {err && <ErrorNote error={err} />}
      <Card className="flex items-center justify-between gap-3 p-3">
        <div className="flex flex-col gap-0.5">
          <Label>Target</Label>
          <span className="text-md font-semibold">{c.targetText}</span>
          <span className="text-xs text-muted">{c.targetHelp}</span>
        </div>
        <SoftLink to={`/budget/category/${c.id}/target`} search={{ month }} track="category.target.edit">
          Edit
        </SoftLink>
      </Card>
      <div className="flex flex-col">
        <div className="flex items-center justify-between">
          <Label>Recent</Label>
          {c.recentTotal > 0 && (
            <TextButton
              track="category.see_all"
              onClick={() => void navigate({ to: '/activity', search: { q: c.name } })}
              className="self-auto"
            >
              See all {c.recentTotal}
            </TextButton>
          )}
        </div>
        {c.recent.length === 0 && <EmptyNote>No transactions in {monthName(month)}.</EmptyNote>}
        {c.recent.map((r) => (
          <Link
            key={r.key}
            to={`/activity/txn/${r.key}`}
            className="flex min-h-12 items-center justify-between border-t border-divider text-md text-ink no-underline"
          >
            <span className="flex flex-col gap-px">
              <span className="font-semibold">{r.payee}</span>
              <span className="text-xs text-muted">
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

/**
 * Pins the category to the top of Budget, or unpins it. Saved with the budget, so every device shows the same pins;
 * with no signal it's kept on the phone and sent later, like an assignment (D-74).
 */
function PinButton({ id, name, month }: { id: string; name: string; month: string }) {
  const saved = !!useBudget(month).data?.pinned.includes(id);
  const canWrite = useCanWrite({ offline: true });
  const pin = useMoneyMutation(api.pinCategory, { money: false, invalidate: [['budget']] });
  // Shows the new state at once, while the change is on its way.
  const pinned = pin.isPending && pin.variables ? pin.variables.pinned : saved;
  const toggle = async () => {
    if (pin.isPending) return;
    try {
      await pin.mutateAsync({ id, pinned: !pinned });
      toast.show({ text: pinned ? `${name} unpinned` : `${name} pinned to the top` });
    } catch (e) {
      toast.show({ text: errorMessage(e) });
    }
  };
  return (
    <button
      type="button"
      aria-label={`Pin ${name} to the top`}
      aria-pressed={pinned}
      title={pinned ? 'Pinned to the top of Budget' : 'Pin to the top of Budget'}
      disabled={!canWrite}
      onClick={() => void toggle()}
      data-track={pinned ? 'category.unpin' : 'category.pin'}
      className={cx(
        'flex h-11 items-center justify-center gap-1 px-2 text-sm font-semibold disabled:text-line-strong',
        pinned ? 'text-accent' : 'text-muted',
      )}
    >
      <Icon name="pin" size={20} stroke={pinned ? 2.6 : 2} />
      {/* A word as well as the icon (a phone has no hover title). It stays "Pin" so it is part of the button's name;
          the accent color and aria-pressed show that it's on. */}
      Pin
    </button>
  );
}

function QuickChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <SoftButton tone="outline" track="category.quick" onClick={onClick}>
      {label}
    </SoftButton>
  );
}
