// Move money: from one category (or Ready to Assign) to another, opened from a category sheet. It starts with
// the move you most likely want: money in when the category needs some (Cover, Fund, Add), else money out to
// the category that needs it most, else back to Ready to Assign.
import { useState, type KeyboardEvent } from 'react';
import type { BudgetCategoryRow, BudgetView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useBudget, useMoneyMutation } from '../api/hooks';
import { CategoryField, type PickerGroup } from '../components/CategoryPicker';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  amountInputClass,
  cx,
  ErrorNote,
  Field,
  Icon,
  Loading,
  PrimaryButton,
  SoftButton,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';

const RTA = 'rta';
const RTA_NAME = 'Ready to Assign';

/** What a category needs to be right this month: Cover, Fund or Add (Needs attention's own one-tap amount). */
function needOf(row: BudgetCategoryRow | undefined): number | null {
  const f = row?.fix;
  return f && f.verb !== 'Move' && f.amount > 0 ? f.amount : null;
}

export function MoveMoneySheet({
  month,
  categoryId,
  onClose,
  onMoved,
}: {
  month: string;
  /** The category whose sheet this opened from. */
  categoryId: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const b = useBudget(month).data;
  if (!b) {
    return (
      <Sheet label="Move money" track="move" onClose={onClose} modal>
        <Loading />
      </Sheet>
    );
  }
  return <MoveForm b={b} month={month} categoryId={categoryId} onClose={onClose} onMoved={onMoved} />;
}

function MoveForm({
  b,
  month,
  categoryId,
  onClose,
  onMoved,
}: {
  b: BudgetView;
  month: string;
  categoryId: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const move = useMoneyMutation(api.move);
  const rows = new Map(b.groups.flatMap((g) => g.categories.map((c) => [c.id, c] as const)));
  const groups: PickerGroup[] = b.groups
    .filter((g) => g.categories.length > 0)
    .map((g) => ({
      key: g.id,
      name: g.name,
      categories: g.categories.map((c) => ({ id: c.id, name: c.name, available: c.available })),
    }));
  const nameOf = (id: string) => (id === RTA ? RTA_NAME : (rows.get(id)?.name ?? ''));
  const has = (id: string) => (id === RTA ? b.rta : (rows.get(id)?.available ?? 0));
  // Overspent first, then the rest that need money, in Budget order.
  const needing = [...rows.values()]
    .filter((r) => r.id !== categoryId && needOf(r) !== null)
    .sort((x, y) => Number(y.status === 'overspent') - Number(x.status === 'overspent'));
  /** The amount to start with: what the receiving side needs, up to what the giving side has. */
  const suggest = (from: string, to: string): string => {
    const need = to === RTA ? null : needOf(rows.get(to));
    if (need === null) return '';
    const avail = has(from);
    return centsToInput(avail > 0 ? Math.min(need, avail) : need);
  };

  const [start] = useState(() => {
    if (has(categoryId) > 0 && needOf(rows.get(categoryId)) === null) {
      const to = needing[0]?.id ?? RTA;
      return { from: categoryId, to, amount: suggest(categoryId, to) };
    }
    // It needs money, or has none to give: bring it in, from Ready to Assign or else the category with the most.
    const richest = [...rows.values()]
      .filter((r) => r.id !== categoryId && r.available > 0)
      .sort((x, y) => y.available - x.available)[0];
    const from = b.rta > 0 || !richest ? RTA : richest.id;
    return { from, to: categoryId, amount: suggest(from, categoryId) };
  });
  const [from, setFrom] = useState(start.from);
  const [to, setTo] = useState(start.to);
  const [amount, setAmount] = useState(start.amount);
  // Once you type an amount, picking another place keeps it.
  const [typed, setTyped] = useState(false);
  const pick = (f: string, t: string) => {
    setFrom(f);
    setTo(t);
    if (!typed) setAmount(suggest(f, t));
  };

  const cents = parseCents(amount);
  const same = from === to;
  const ok = cents !== null && cents > 0 && !same;
  const why = same
    ? 'Choose a different place to move it to'
    : cents === null || cents <= 0
      ? 'Enter an amount to move'
      : '';
  const save = async () => {
    if (!ok) return;
    await move.mutateAsync({ month, from, to, amount: cents });
    onMoved();
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (ok && !move.isPending) void save().catch(() => undefined);
  };
  const specials = [{ id: RTA, name: RTA_NAME }];
  const moved = ok ? cents : 0;

  return (
    <Sheet
      label="Move money"
      track="move"
      onClose={onClose}
      modal
      unsaved={typed && amount.trim() !== '' && !move.isPending}
      header={<SheetTitle title="Move money" />}
      footer={
        <PrimaryButton
          mutates="offline"
          track="category.move"
          onClick={() => void save().catch(() => undefined)}
          busy={move.isPending}
          disabled={!ok}
          why={why}
        >
          {`Move ${ok ? formatCents(cents) : ''}`.trim()}
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-1">
        <Field label="From">
          <CategoryField
            value={from}
            onChange={(v) => pick(v, to)}
            specials={specials}
            groups={groups}
            title="Move from"
            track="category.move.from"
          />
        </Field>
        <div className="flex justify-center">
          <SoftButton
            tone="outline"
            track="category.move.swap"
            aria-label="Swap From and To"
            title="Swap From and To"
            onClick={() => pick(to, from)}
            className="w-9 px-0"
          >
            <Icon name="swap" size={20} />
          </SoftButton>
        </div>
        <Field label="To">
          <CategoryField
            value={to}
            onChange={(v) => pick(from, v)}
            specials={specials}
            groups={groups}
            suggested={needing.map((r) => r.id)}
            suggestedTitle="Needs money"
            title="Move to"
            track="category.move.to"
          />
        </Field>
      </div>
      <Field label="Amount">
        <input
          className={amountInputClass}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            setTyped(true);
            setAmount(e.target.value);
          }}
          onKeyDown={onEnter}
        />
      </Field>
      {!same && (
        <dl className="m-0 flex flex-col gap-1 text-md" aria-live="polite">
          <After name={nameOf(from)} before={has(from)} after={has(from) - moved} />
          <After name={nameOf(to)} before={has(to)} after={has(to) + moved} />
        </dl>
      )}
      {move.error && <ErrorNote error={move.error} />}
    </Sheet>
  );
}

/** One side of the move: what it has now and what it will have. */
function After({ name, before, after }: { name: string; before: number; after: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="min-w-0 truncate text-muted">{name}</dt>
      <dd className="tnum m-0 shrink-0">
        {before === after ? (
          formatCents(before)
        ) : (
          <>
            <span className="text-muted">{formatCents(before)}</span>
            <span aria-hidden="true"> → </span>
            <span className="sr-only"> becomes </span>
            <span className={cx('font-bold', after < 0 ? 'text-over-fg' : 'text-ink')}>
              {formatCents(after)}
            </span>
          </>
        )}
      </dd>
    </div>
  );
}
