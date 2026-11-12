// Category sheet: what's available, the month's assigned amount, Move money, target, recent.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { useBudget, useCategorySheet, useMoneyMutation } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  Bar,
  cx,
  EmptyNote,
  ErrorNote,
  Field,
  Icon,
  Label,
  Loading,
  PrimaryButton,
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
import { useHere } from '../lib/back';
import { useBudgetMonth } from './Budget';
import { usage } from '../usage/tracker';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
import { useCloseToBudget } from './BudgetSheets';
import { isQuiet } from './BudgetRows';
import { MoveMoneySheet } from './MoveMoneySheet';

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
  const [assigned, setAssigned] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const set = useMoneyMutation(api.setAssigned);
  const steps = useCategorySteps(categoryId, month, current);
  // A transaction or the category's list opened from this sheet comes back to it (lib/back.ts).
  const here = useHere();
  const row = useBudget(month)
    .data?.groups.flatMap((g) => g.categories)
    .find((x) => x.id === categoryId);
  const c = q.data;

  useEffect(() => {
    usage.startTask('assign');
    return () => usage.cancelTask('assign');
  }, []);
  useEffect(() => {
    if (c && assigned === null) setAssigned(centsToInput(c.assigned));
  }, [c, assigned]);

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
  const delta = changed ? newAssigned - c.assigned : 0;
  const available = c.available + delta;
  const rtaAfter = c.rta - delta;
  const save = async () => {
    if (newAssigned === null) return;
    await set.mutateAsync({ month, categoryId: c.id, assigned: newAssigned });
    usage.endTask('assign');
    close();
  };
  // Enter (or the keyboard's Go) saves, as the button does when it can.
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!set.isPending && changed) void save().catch(() => undefined);
  };

  // Amounts one tap away, each shown only when it would change the box: what Needs attention would do (Cover,
  // Fund, Add), the target, and last month's amount.
  const fix = row?.fix && row.fix.verb !== 'Move' && row.fix.amount > 0 ? row.fix : null;
  const target = c.target.type === 'refill' || c.target.type === 'set_aside' ? c.target.amount : null;
  const presets: { label: string; value: number; track: string }[] = [];
  const offer = (label: string, value: number, track: string) => {
    if (value !== newAssigned && !presets.some((p) => p.value === value))
      presets.push({ label, value, track });
  };
  if (fix) offer(`${fix.verb} ${formatCents(fix.amount)}`, c.assigned + fix.amount, 'category.quick.fix');
  if (target !== null)
    offer(`Target ${formatCents(target, { whole: true })}`, target, 'category.quick.target');
  if (c.lastMonthAssigned > 0)
    offer(
      `Last month ${formatCents(c.lastMonthAssigned, { whole: true })}`,
      c.lastMonthAssigned,
      'category.quick.last',
    );

  // The bar follows the Budget row's rule (no bar where the row has none) and moves as you type.
  const total = c.spent + available;
  const leftPercent = total > 0 ? Math.max(0, Math.min(100, Math.round((available * 100) / total))) : 0;
  const tone = available < 0 ? 'over' : st.tone;
  const spentWord = c.status === 'invested' ? 'invested' : 'spent';

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
          track="category.save"
          onClick={save}
          busy={set.isPending}
          disabled={!changed}
          why={newAssigned === null ? 'Enter an amount to save' : !changed ? 'Change the amount to save' : ''}
        >
          Save
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-muted">Available</span>
        <span
          className={cx(
            'tnum text-4xl leading-tight font-bold',
            isQuiet(c.status) && available >= 0 ? 'text-ink' : TONE[tone].fg,
          )}
          data-testid="category-available"
        >
          {formatCents(available)}
        </span>
        {row?.leftPercent !== null && row?.leftPercent !== undefined && (
          <Bar percent={leftPercent} tone={tone} />
        )}
        <span className="text-sm text-muted">
          {c.spent > 0
            ? `${formatCents(c.spent)} ${spentWord} in ${monthName(month)}`
            : `Nothing ${spentWord} in ${monthName(month)}`}
        </span>
      </div>
      <div className="flex flex-col gap-2">
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
        <p className={cx('m-0 text-sm', rtaAfter < 0 ? 'text-over-fg' : 'text-muted')} aria-live="polite">
          {!changed
            ? `Ready to Assign has ${formatCents(c.rta)}.`
            : rtaAfter < 0
              ? `That’s ${formatCents(-rtaAfter)} more than Ready to Assign has.`
              : `Ready to Assign goes from ${formatCents(c.rta)} to ${formatCents(rtaAfter)}.`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <SoftButton
            key={p.track}
            tone="outline"
            track={p.track}
            onClick={() => setAssigned(centsToInput(p.value))}
          >
            {p.label}
          </SoftButton>
        ))}
        <SoftButton track="category.move.open" onClick={() => setMoving(true)}>
          <Icon name="swap" size={16} />
          Move money
        </SoftButton>
      </div>
      {set.error && <ErrorNote error={set.error} />}
      <div className="flex items-center justify-between gap-3 border-t border-divider pt-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-md font-semibold">{c.targetText}</span>
          <span className="text-xs text-muted">{c.targetHelp}</span>
        </div>
        <SoftLink to={`/budget/category/${c.id}/target`} search={{ month }} track="category.target.edit">
          {c.target.type === 'none' ? 'Add' : 'Edit'}
        </SoftLink>
      </div>
      <div className="flex flex-col">
        <div className="flex items-center justify-between">
          <Label>Recent</Label>
          {c.recentTotal > 0 && (
            <TextButton
              track="category.see_all"
              onClick={() => void navigate({ to: '/activity', search: { category: c.id, back: here } })}
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
            search={{ close: here }}
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
      {moving && (
        <MoveMoneySheet
          month={month}
          categoryId={c.id}
          onClose={() => setMoving(false)}
          onMoved={() => {
            usage.endTask('assign');
            close();
          }}
        />
      )}
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
