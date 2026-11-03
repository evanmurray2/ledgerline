// Activity's Needs category: the rows with Choose (or the chosen category), Select several, and the category
// picker with Split it… and It’s a transfer….
import { Link } from '@tanstack/react-router';
import type { ActivityView } from '@ledgerline/contracts';
import { CategoryPickerSheet } from '../components/CategoryPicker';
import { Button, cx } from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { sheetPath, type NeedsRow, type Picking } from './ActivityRows';

export function NeedsCategory({
  needs,
  openNeeds,
  q,
  chosen,
  selecting,
  setSelecting,
  sel,
  setSel,
  openPicker,
}: {
  needs: NeedsRow[];
  openNeeds: NeedsRow[];
  q: string;
  chosen: Record<string, { row: NeedsRow; categoryId: string | null; name: string }>;
  selecting: boolean;
  setSelecting: (f: (x: boolean) => boolean) => void;
  sel: Record<string, boolean>;
  setSel: (f: Record<string, boolean> | ((s: Record<string, boolean>) => Record<string, boolean>)) => void;
  openPicker: (p: Picking) => void;
}) {
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <div className="flex min-h-9 items-center justify-between px-0.5">
        <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
          Needs category{' '}
          <span className="font-semibold normal-case tracking-normal text-muted">
            ·{' '}
            {openNeeds.length === 0
              ? 'done'
              : `${openNeeds.length} · ${formatCents(openNeeds.reduce((s, r) => s + r.amount, 0))}`}
          </span>
        </h2>
        {openNeeds.length > 1 && (
          <button
            type="button"
            data-track="activity.select"
            onClick={() => {
              setSelecting((x) => !x);
              setSel({});
            }}
            className="hit h-9 px-2.5 text-[14px] font-bold text-accent"
          >
            {selecting ? 'Cancel' : 'Select'}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
        {openNeeds.length === 0 && (
          <p className="m-0 px-3 py-3.5 text-[14px] font-semibold text-funded-fg">
            Everything has a category.
          </p>
        )}
        {needs
          .filter((r) => !q || r.payee.toLowerCase().includes(q.toLowerCase()))
          .map((r) => {
            const c = chosen[r.key];
            const label = c && c.categoryId ? c.name : null;
            const on = !!sel[r.key];
            return (
              <div
                key={r.key}
                className={cx(
                  'flex items-center gap-2.5 border-t border-divider px-3 py-2 first:border-t-0',
                  selecting && on ? 'bg-accent-soft' : 'bg-surface',
                )}
              >
                {selecting && !label && (
                  <input
                    type="checkbox"
                    className="hit h-[22px] w-[22px] shrink-0 accent-[var(--ll-accent)]"
                    checked={on}
                    aria-label={`Select ${r.payee} ${formatCents(r.amount)}`}
                    onChange={() => setSel((s) => ({ ...s, [r.key]: !s[r.key] }))}
                  />
                )}
                <Link
                  to={sheetPath('/activity', r)}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px] text-ink no-underline"
                >
                  <span className="flex justify-between gap-2">
                    <span className="text-[15px] font-semibold">{r.payee}</span>
                    <span className="tnum text-[15px] font-bold">{formatCents(r.amount)}</span>
                  </span>
                  <span className="text-[12px] text-muted">{rowMeta(r, 'needs')}</span>
                </Link>
                {!selecting && (
                  <Button
                    mutates="offline"
                    track="activity.category.choose"
                    aria-label={`${label ? 'Change category for' : 'Choose category for'} ${r.payee} ${formatCents(r.amount)}`}
                    onClick={() => openPicker({ keys: [r.key], row: r })}
                    className={cx(
                      'hit h-9 max-w-[112px] shrink-0 truncate whitespace-nowrap rounded-full px-3 text-[13px] font-bold disabled:opacity-50',
                      label ? 'bg-sunken text-none-fg' : 'bg-accent-soft text-accent',
                    )}
                  >
                    {label ?? 'Choose'}
                  </Button>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
}

export function ActivityCategoryPicker({
  picking,
  groups,
  onPick,
  onClose,
  onSplit,
  onTransfer,
}: {
  picking: Picking;
  groups: ActivityView['categoryPicker'];
  onPick: (id: string) => void;
  onClose: () => void;
  onSplit: (key: string) => void;
  onTransfer: (key: string) => void;
}) {
  const row = picking.row;
  const byName = new Map(groups.flatMap((g) => g.categories.map((c) => [c.name, c.id] as const)));
  const suggested = (row?.history?.categories ?? []).flatMap((n) => {
    const id = byName.get(n);
    return id ? [id] : [];
  });
  const canWrite = useCanWrite({ offline: true });
  return (
    <CategoryPickerSheet
      track="activity.picker"
      onClose={onClose}
      onPick={onPick}
      disabled={!canWrite}
      groups={groups.map((g) => ({ key: g.group, name: g.group, categories: g.categories }))}
      suggested={suggested}
      suggestedTitle={row?.history?.title}
      sub={
        row
          ? `${row.payee} · ${formatCents(row.amount)} · ${rowMeta(row, 'needs')}`
          : `${picking.keys.length} transactions`
      }
    >
      {row && (
        <div className="flex gap-4 pt-1">
          <button
            type="button"
            data-track="activity.picker.split"
            onClick={() => onSplit(row.key)}
            className="hit flex h-10 items-center text-[14px] font-bold text-accent"
          >
            Split it…
          </button>
          <button
            type="button"
            data-track="activity.picker.transfer"
            onClick={() => onTransfer(row.key)}
            className="hit flex h-10 items-center text-[14px] font-bold text-accent"
          >
            It’s a transfer…
          </button>
        </div>
      )}
    </CategoryPickerSheet>
  );
}
