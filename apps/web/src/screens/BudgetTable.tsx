// Budget on a computer: the month as a table with Assigned (typed in place), Spent and Available columns, and
// the pinned categories in a card of their own above it.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useHere } from '../lib/back';
import type { BudgetCategoryRow, BudgetView } from '@ledgerline/contracts';
import { errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Bar, Card, cx, Icon, STATUS, StatusWord, TONE, type Tone } from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { monthLabel } from '../lib/dates';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
import { useBlockedWhy } from '../components/BlockedAction';
import { catTone, isQuiet, OWED_DETAIL, owedTone, pinnedRows, StatusLine } from './BudgetRows';

/** Moves focus to the Assigned field `step` rows away. False when there is none (Tab then leaves the table). */
function focusAssigned(from: HTMLElement, step: number): boolean {
  const table = from.closest('[role="table"]');
  if (!table) return false;
  const all = [...table.querySelectorAll<HTMLInputElement>('input[data-assigned]')];
  const next = all[all.indexOf(from as HTMLInputElement) + step];
  if (!next) return false;
  next.focus();
  return true;
}

/**
 * Assigned, typed straight into the table: click or Tab in, type, Enter or Tab saves. Tab and the arrow keys
 * move between rows; Escape puts the old amount back. It saves the same way the category panel does.
 */
function AssignedCell({
  id,
  name,
  cents,
  month,
}: {
  id: string;
  name: string;
  cents: number;
  month: string;
}) {
  const canWrite = useCanWrite({ offline: true });
  const blockedWhy = useBlockedWhy();
  const set = useMoneyMutation(api.setAssigned);
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const edit = (v: string | null) => {
    draftRef.current = v;
    setDraft(v);
  };
  const commit = async () => {
    const v = draftRef.current === null ? null : parseCents(draftRef.current);
    edit(null);
    if (v === null || v === cents) return;
    try {
      await set.mutateAsync({ month, categoryId: id, assigned: v });
    } catch (e) {
      toast.show({ text: errorMessage(e) });
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      // Only undo the typing; the open side panel stays.
      e.stopPropagation();
      edit(null);
      el.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusAssigned(el, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Tab') {
      if (focusAssigned(el, e.shiftKey ? -1 : 1)) e.preventDefault();
    }
  };
  // While a save is on its way, show what was typed rather than flicking back to the old amount.
  const shown = set.isPending && set.variables ? set.variables.assigned : cents;
  return (
    <input
      data-assigned={id}
      data-track="budget.assigned"
      aria-label={`Assigned to ${name}`}
      inputMode="decimal"
      autoComplete="off"
      disabled={!canWrite}
      // A disabled box can't be clicked for a toast: hovering says why.
      title={canWrite ? undefined : blockedWhy}
      value={draft ?? formatCents(shown)}
      onFocus={(e) => {
        edit(centsToInput(cents));
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onChange={(e) => edit(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      // Reads as a plain number; the box shows only on hover and while editing.
      className="tnum h-9 w-full max-w-[max(140px,var(--assigned-w))] rounded-md border border-transparent bg-transparent px-2 text-right text-md font-semibold text-ink outline-none hover:border-line-strong hover:bg-surface-2 focus:border-accent focus:bg-surface disabled:hover:border-transparent disabled:hover:bg-transparent"
    />
  );
}

/** Spent, in the same dark ink as every amount. The bar under the name already shows the share used. */
function SpentCell({ row }: { row: BudgetCategoryRow }) {
  if (row.status === 'invested') return <span className="text-ink">Invested {formatCents(row.spent)}</span>;
  return <span className="font-semibold text-ink">{formatCents(row.spent)}</span>;
}

/**
 * The Assigned box's width for the longest amount in the month (text, its padding and border), as `--assigned-w`.
 * Digits are tabular: 8.8 text pixels a character covers the widest, up to "−$99,999,999.99" (the amount limit).
 */
function assignedWidth(b: BudgetView): CSSProperties {
  let longest = 0;
  for (const c of [...b.groups.flatMap((g) => g.categories), ...b.archived])
    longest = Math.max(longest, formatCents(c.assigned).length);
  return { '--assigned-w': `calc(${longest} * 8.8 * var(--ll-u) + 18px)` } as CSSProperties;
}

export function DesktopTable({ b, month }: { b: BudgetView; month: string }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // An account or Owed to you opened from here comes back here (lib/back.ts).
  const here = useHere();
  const selected = /\/budget\/category\/([^/]+)/.exec(path)?.[1];
  // Narrow (a side panel open on a small screen): Spent drops out so Assigned and Available stay in view. The
  // amount columns are never narrower than the longest Assigned amount (--assigned-w), so none is cut off.
  const head =
    'grid grid-cols-[minmax(130px,2fr)_repeat(2,minmax(max(108px,calc(var(--assigned-w)_+_12px)),1fr))] items-center @[540px]:grid-cols-[minmax(220px,2.2fr)_repeat(3,minmax(max(110px,calc(var(--assigned-w)_+_12px)),1fr))]';
  const widths = assignedWidth(b);
  const spentCls = 'hidden @[540px]:block';
  const cell = 'tnum px-3.5 py-1 text-right text-ink-2';
  /** A group's bar. Card payments has only an Available total: its rows have no Assigned or Spent of their own. */
  const groupRow = (
    key: string,
    name: string,
    totals?: { assigned?: number; spent?: number; available: number },
  ) => (
    <div
      role="row"
      // By id, not name: two groups may share a name.
      key={key}
      className={cx(
        head,
        'border-t border-line-strong bg-sunken py-2 text-xs font-bold uppercase tracking-caps text-ink',
      )}
    >
      <span role="rowheader" className="px-3.5">
        {name}
      </span>
      {totals && (
        <>
          {/* 15px: the Assigned field's own padding and border, so the totals line up with its amount. */}
          <span
            role="cell"
            className="tnum pl-3.5 pr-[15px] text-right font-semibold tracking-normal text-ink-2"
          >
            {totals.assigned === undefined ? '' : formatCents(totals.assigned)}
          </span>
          <span
            role="cell"
            className={cx('tnum px-3.5 text-right font-semibold tracking-normal text-ink-2', spentCls)}
          >
            {totals.spent === undefined ? '' : formatCents(totals.spent)}
          </span>
          <span role="cell" className="tnum px-6 text-right tracking-normal">
            {formatCents(totals.available)}
          </span>
        </>
      )}
    </div>
  );
  const row = (r: {
    key: string;
    id?: string;
    name: string;
    detail: ReactNode;
    assigned: ReactNode;
    spent: ReactNode;
    avail: string;
    bar?: { percent: number; tone: Tone } | null;
    tone: Tone | null;
    open: () => void;
    track: string;
  }) => (
    <div
      role="row"
      key={r.key}
      // The whole row opens it; the name stays the keyboard and screen-reader way in.
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('input, button, a')) r.open();
      }}
      className={cx(
        head,
        'cursor-pointer border-t border-divider',
        selected === (r.id ?? r.key) ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span role="rowheader" className="min-w-0 px-3.5 py-1">
        <button
          type="button"
          data-track={r.track}
          onClick={r.open}
          className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 text-left text-md font-semibold text-ink wrap-anywhere"
        >
          {r.name}
          <span className="text-sm font-normal text-muted">{r.detail}</span>
        </button>
        {/* The phone's bar: how much of the month's money is spent, readable without the numbers (D-117). */}
        {r.bar && (
          <div className="mb-1.5 max-w-[320px]">
            <Bar percent={r.bar.percent} tone={r.bar.tone} />
          </div>
        )}
      </span>
      <span role="cell" className="tnum flex justify-end px-1.5 py-1 text-right text-ink-2">
        {r.assigned}
      </span>
      <span role="cell" className={cx(cell, spentCls)}>
        {r.spent}
      </span>
      <span role="cell" className="px-3.5 py-1 text-right">
        {/* Healthy rows stay plain so the pills mark only what needs you. */}
        <span
          className={cx(
            'tnum inline-block whitespace-nowrap rounded-full px-2.5 py-[3px] font-bold',
            r.tone ? [TONE[r.tone].bg, TONE[r.tone].fg].join(' ') : 'text-ink',
          )}
        >
          {r.avail}
        </span>
      </span>
    </div>
  );
  const categoryRow = (c: BudgetCategoryRow, key = c.id) =>
    row({
      key,
      id: c.id,
      name: c.name,
      detail: isQuiet(c.status) ? (
        <>
          <span className="sr-only">{STATUS[c.status].word} · </span>
          {c.detail}
        </>
      ) : (
        <StatusLine {...STATUS[c.status]} detail={c.detail} />
      ),
      assigned: <AssignedCell id={c.id} name={c.name} cents={c.assigned} month={month} />,
      spent: <SpentCell row={c} />,
      avail: formatCents(c.available),
      tone: isQuiet(c.status) ? null : STATUS[c.status].tone,
      bar: c.leftPercent === null ? null : { percent: 100 - c.leftPercent, tone: catTone(c) },
      open: () => void navigate({ to: `/budget/category/${c.id}`, search: { month } }),
      track: 'budget.category',
    });
  const pinned = pinnedRows(b);
  /** The column names; the first names the card (Category, or Pinned with its icon). */
  const columns = (first: ReactNode) => (
    <div role="row" className={cx(head, 'border-b border-line bg-surface-2 text-xs font-bold text-ink-2')}>
      <span role="columnheader" className="flex items-center gap-1.5 px-3.5 py-2.5">
        {first}
      </span>
      <span role="columnheader" className="py-2.5 pl-3.5 pr-[15px] text-right">
        Assigned
      </span>
      <span role="columnheader" className={cx('px-3.5 py-2.5 text-right', spentCls)}>
        Spent
      </span>
      <span role="columnheader" className="px-6 py-2.5 text-right">
        Available
      </span>
    </div>
  );
  const dash = <span className="px-[9px]">—</span>;
  const t = owedTone(b);
  const totalsOf = (cats: BudgetCategoryRow[]) => ({
    assigned: cats.reduce((s, c) => s + c.assigned, 0),
    // Matches the column: invested money shows as "Invested", not as spending.
    spent: cats.reduce((s, c) => s + (c.status === 'invested' ? 0 : c.spent), 0),
    available: cats.reduce((s, c) => s + c.available, 0),
  });
  return (
    <>
      {/* Pinned categories in a card of their own, above the budget: they're counted in their groups below, so
          this card has no totals. */}
      {pinned.length > 0 && (
        <Card className="@container min-w-0 overflow-x-auto">
          <div role="table" aria-label="Pinned categories" className="text-md" style={widths}>
            {columns(
              <>
                <Icon name="pin" size={14} stroke={2.4} />
                Pinned
              </>,
            )}
            {pinned.map((c) => categoryRow(c, `pin-${c.id}`))}
          </div>
        </Card>
      )}
      <Card className="@container min-w-0 overflow-x-auto">
        <div role="table" aria-label={`Budget for ${monthLabel(month)}`} className="text-md" style={widths}>
          {columns(<>Category</>)}
          {b.groups.flatMap((g) => [
            groupRow(`g-${g.id}`, g.name, { ...totalsOf(g.categories), available: g.total }),
            ...g.categories.map((c) => categoryRow(c)),
          ])}
          {/* Archived categories that still hold money or had activity this month, as on a phone: their money is
              still counted, so it stays in sight. */}
          {b.archived.length > 0 && [
            groupRow('x-archived', 'Archived', totalsOf(b.archived)),
            ...b.archived.map((c) => categoryRow(c, `archived-${c.id}`)),
          ]}
          {b.cards.length > 0 &&
            groupRow('x-cards', 'Card payments', { available: b.cards.reduce((s, c) => s + c.available, 0) })}
          {b.cards.map((c) =>
            row({
              key: c.accountId,
              name: c.name,
              detail:
                c.status === 'short' ? (
                  <>
                    <StatusWord word="Short" tone="over" icon="alert" /> · {c.detail}
                  </>
                ) : (
                  // Covered cards stay quiet, as on a phone; a screen reader still hears the word.
                  <>
                    <span className="sr-only">Covered · </span>
                    {c.detail}
                  </>
                ),
              assigned: dash,
              spent: '—',
              avail: formatCents(c.available),
              tone: c.status === 'short' ? 'over' : null,
              open: () => void navigate({ to: `/accounts/${c.accountId}`, search: { back: here } }),
              track: 'budget.card',
            }),
          )}
          {groupRow('x-owed', 'Owed to you')}
          {row({
            key: 'owed',
            name: 'Owed to you',
            detail: t.word ? (
              <>
                <StatusWord word={t.word} tone={t.tone} icon={t.icon} /> · {OWED_DETAIL}
              </>
            ) : (
              OWED_DETAIL
            ),
            assigned: dash,
            spent: '—',
            avail: `${formatCents(b.owed.out)} out`,
            tone: b.owed.status === 'late' ? t.tone : null,
            open: () => void navigate({ to: '/owed', search: { back: here } }),
            track: 'budget.owed',
          })}
        </div>
      </Card>
    </>
  );
}
