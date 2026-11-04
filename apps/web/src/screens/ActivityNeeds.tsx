// Activity's Needs category: the rows with a suggested category and OK, or Choose (or the chosen category); OK
// all for every strong suggestion; Select several; and the category picker with Split it… and It’s a transfer….
import { Link } from '@tanstack/react-router';
import type { ActivityView } from '@ledgerline/contracts';
import { CategoryPickerSheet } from '../components/CategoryPicker';
import { cx, Money, SecondaryButton, SectionTitle, SoftButton, TextButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { sheetPath, type Chosen, type NeedsRow, type Picking } from './ActivityRows';

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
  onAccept,
  onAcceptAll,
}: {
  needs: NeedsRow[];
  openNeeds: NeedsRow[];
  q: string;
  chosen: Record<string, Chosen>;
  selecting: boolean;
  setSelecting: (f: (x: boolean) => boolean) => void;
  sel: Record<string, boolean>;
  setSel: (f: Record<string, boolean> | ((s: Record<string, boolean>) => Record<string, boolean>)) => void;
  openPicker: (p: Picking) => void;
  onAccept: (r: NeedsRow) => void;
  onAcceptAll: (rows: NeedsRow[]) => void;
}) {
  const shown = needs.filter((r) => !q || r.payee.toLowerCase().includes(q.toLowerCase()));
  const open = (r: NeedsRow) =>
    !chosen[r.key] || (chosen[r.key]!.categoryId === null && !chosen[r.key]!.toRta);
  const strong = shown.filter((r) => open(r) && r.suggestion?.strong);
  const note =
    openNeeds.length === 0
      ? 'done'
      : `${openNeeds.length} · ${formatCents(openNeeds.reduce((s, r) => s + r.amount, 0))}`;
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <SectionTitle
        note={openNeeds.length > 1 ? undefined : note}
        action={
          openNeeds.length > 1 && (
            // SectionTitle spreads a note and an action apart; here the total sits next to Select.
            <span className="flex items-center gap-3">
              <span className="text-[12px] text-muted">{note}</span>
              <TextButton
                track="activity.select"
                onClick={() => {
                  setSelecting((x) => !x);
                  setSel({});
                }}
              >
                {selecting ? 'Cancel' : 'Select'}
              </TextButton>
            </span>
          )
        }
      >
        Needs category
      </SectionTitle>
      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
        {openNeeds.length === 0 && (
          <p className="m-0 px-3 py-3.5 text-[14px] font-semibold text-funded-fg">
            Everything has a category.
          </p>
        )}
        {shown.map((r) => {
          const c = chosen[r.key];
          const label = c && (c.categoryId || c.toRta) ? c.name : null;
          const sug = !label && !selecting ? r.suggestion : null;
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
                  <Money
                    cents={r.amount}
                    plus
                    className={cx('text-[15px] font-bold', r.amount > 0 ? 'text-funded-fg' : 'text-ink')}
                  />
                </span>
                <span className="text-[12px] text-muted">{rowMeta(r, 'needs')}</span>
              </Link>
              {!selecting && sug && (
                <span className="flex shrink-0 items-center gap-1.5">
                  <SoftButton
                    mutates="offline"
                    tone="outline"
                    track="activity.category.choose"
                    aria-label={`Choose category for ${r.payee} ${formatCents(r.amount)}`}
                    onClick={() => openPicker({ keys: [r.key], row: r })}
                    className="max-w-[140px]"
                  >
                    <span className="truncate">{sug.name}</span>
                  </SoftButton>
                  <SoftButton
                    mutates="offline"
                    tone="filled"
                    track="activity.category.ok"
                    aria-label={`OK ${sug.name} for ${r.payee} ${formatCents(r.amount)}`}
                    onClick={() => onAccept(r)}
                  >
                    OK
                  </SoftButton>
                </span>
              )}
              {!selecting && !sug && (
                <SoftButton
                  mutates="offline"
                  tone={label ? 'outline' : 'soft'}
                  track="activity.category.choose"
                  aria-label={`${label ? 'Change category for' : 'Choose category for'} ${r.payee} ${formatCents(r.amount)}`}
                  onClick={() => openPicker({ keys: [r.key], row: r })}
                  className="max-w-[112px]"
                >
                  <span className="truncate">{label ?? 'Choose'}</span>
                </SoftButton>
              )}
            </div>
          );
        })}
      </div>
      {!selecting && strong.length >= 2 && (
        <SecondaryButton
          mutates="offline"
          track="activity.category.ok_all"
          onClick={() => onAcceptAll(strong)}
        >
          OK {strong.length} suggestions
        </SecondaryButton>
      )}
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
  const past = row?.history?.categories ?? [];
  const suggested = past.map((c) => c.id);
  const counts = Object.fromEntries(past.map((c) => [c.id, c.count]));
  const canWrite = useCanWrite({ offline: true });
  return (
    <CategoryPickerSheet
      track="activity.picker"
      onClose={onClose}
      onPick={onPick}
      disabled={!canWrite}
      groups={groups.map((g) => ({ key: g.group, name: g.group, categories: g.categories }))}
      suggested={suggested}
      suggestedCounts={counts}
      suggestedTitle={row?.history?.title}
      sub={
        row
          ? `${row.payee} · ${formatCents(row.amount)} · ${rowMeta(row, 'needs')}`
          : `${picking.keys.length} transactions`
      }
    >
      {row && (
        <div className="flex gap-4 pt-1">
          <TextButton track="activity.picker.split" onClick={() => onSplit(row.key)}>
            Split it…
          </TextButton>
          <TextButton track="activity.picker.transfer" onClick={() => onTransfer(row.key)}>
            It’s a transfer…
          </TextButton>
        </div>
      )}
    </CategoryPickerSheet>
  );
}
