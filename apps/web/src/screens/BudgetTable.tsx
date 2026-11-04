// Budget on a computer: the month as a table with Assigned (typed in place), Spent and Available columns.
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { BudgetCategoryRow, BudgetView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Bar, Card, cx, STATUS, StatusWord, TONE, type Tone } from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { monthLabel } from '../lib/dates';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
import { catTone, isQuiet, owedTone } from './BudgetRows';

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
  const canWrite = useCanWrite();
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
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
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
      value={draft ?? formatCents(shown)}
      onFocus={(e) => {
        edit(centsToInput(cents));
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onChange={(e) => edit(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      className="tnum h-9 w-full max-w-[140px] rounded-md border border-transparent bg-surface-2 px-2 text-right text-md text-ink-2 outline-none hover:border-line-strong focus:border-accent focus:bg-surface focus:text-ink disabled:bg-transparent disabled:hover:border-transparent"
    />
  );
}

/**
 * Spent, so spending stands out: nothing spent fades back, money spent reads dark with the share of the
 * month's money it used beneath it (not for overspent rows: their red pill already says it).
 */
function SpentCell({ row }: { row: BudgetCategoryRow }) {
  if (row.status === 'invested') return <span className="text-ink">Invested {formatCents(row.spent)}</span>;
  if (row.spent === 0) return <span className="text-faint">{formatCents(0)}</span>;
  const used = row.leftPercent === null || row.status === 'overspent' ? null : 100 - row.leftPercent;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="font-semibold text-ink">{formatCents(row.spent)}</span>
      {used !== null && <span className="text-xs text-muted">{used}% used</span>}
    </span>
  );
}

export function DesktopTable({ b, month }: { b: BudgetView; month: string }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const selected = /\/budget\/category\/([^/]+)/.exec(path)?.[1];
  // Narrow (a side panel open on a small screen): Spent drops out so Assigned and Available stay in view.
  const head =
    'grid grid-cols-[minmax(130px,2fr)_repeat(2,minmax(108px,1fr))] items-center @[540px]:grid-cols-[minmax(220px,2.2fr)_repeat(3,minmax(110px,1fr))]';
  const spentCls = 'hidden @[540px]:block';
  const cell = 'tnum px-3.5 py-1 text-right text-ink-2';
  const groupRow = (name: string, totals?: { assigned: number; spent: number; available: number }) => (
    <div
      role="row"
      key={`g-${name}`}
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
            {formatCents(totals.assigned)}
          </span>
          <span
            role="cell"
            className={cx('tnum px-3.5 text-right font-semibold tracking-normal text-ink-2', spentCls)}
          >
            {formatCents(totals.spent)}
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
        selected === r.key ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span role="rowheader" className="px-3.5 py-1">
        <button
          type="button"
          data-track={r.track}
          onClick={r.open}
          className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 text-left text-md font-semibold text-ink"
        >
          {r.name}
          <span className="text-sm font-normal text-muted">{r.detail}</span>
        </button>
        {/* The phone's bar: how much of the month's money is left, readable without the numbers. */}
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
  const dash = <span className="px-[9px]">—</span>;
  const t = owedTone(b);
  return (
    <Card className="@container min-w-0 overflow-x-auto">
      <div role="table" aria-label={`Budget for ${monthLabel(month)}`} className="text-md">
        <div
          role="row"
          className={cx(head, 'border-b border-line bg-surface-2 text-xs font-bold text-ink-2')}
        >
          <span role="columnheader" className="px-3.5 py-2.5">
            Category
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
        {b.groups.flatMap((g) => [
          groupRow(g.name, {
            assigned: g.categories.reduce((s, c) => s + c.assigned, 0),
            // Matches the column: invested money shows as "Invested", not as spending.
            spent: g.categories.reduce((s, c) => s + (c.status === 'invested' ? 0 : c.spent), 0),
            available: g.total,
          }),
          ...g.categories.map((c) =>
            row({
              key: c.id,
              name: c.name,
              detail: isQuiet(c.status) ? (
                <>
                  <span className="sr-only">{STATUS[c.status].word} · </span>
                  {c.detail}
                </>
              ) : (
                <>
                  <StatusWord {...STATUS[c.status]} /> · {c.detail}
                </>
              ),
              assigned: <AssignedCell id={c.id} name={c.name} cents={c.assigned} month={month} />,
              spent: <SpentCell row={c} />,
              avail: formatCents(c.available),
              tone: isQuiet(c.status) ? null : STATUS[c.status].tone,
              bar: c.leftPercent === null ? null : { percent: c.leftPercent, tone: catTone(c) },
              open: () => void navigate({ to: `/budget/category/${c.id}`, search: { month } }),
              track: 'budget.category',
            }),
          ),
        ])}
        {b.cards.length > 0 && groupRow('Credit card payments')}
        {b.cards.map((c) =>
          row({
            key: c.accountId,
            name: c.name,
            detail: c.detail,
            assigned: dash,
            spent: '—',
            avail: formatCents(c.available),
            tone: c.status === 'short' ? 'over' : null,
            open: () => void navigate({ to: `/accounts/${c.accountId}` }),
            track: 'budget.card',
          }),
        )}
        {groupRow('Owed to you · not a category')}
        {row({
          key: 'owed',
          name: 'Owed to you',
          detail: `${t.word} · fronted money comes back to Ready to Assign`,
          assigned: dash,
          spent: '—',
          avail: `${formatCents(b.owed.out)} out`,
          tone: b.owed.status === 'late' ? t.tone : null,
          open: () => void navigate({ to: '/owed' }),
          track: 'budget.owed',
        })}
      </div>
    </Card>
  );
}
