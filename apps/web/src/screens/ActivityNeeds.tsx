// Activity's Needs category: the rows with a suggested category and OK, or Choose (or the chosen category); OK
// all for every strong suggestion; Select several; and the category picker with Split it… and It’s a transfer….
import { Link } from '@tanstack/react-router';
import type { ActivityView } from '@ledgerline/contracts';
import { CategoryPickerSheet } from '../components/CategoryPicker';
import {
  Button,
  Checkbox,
  cx,
  Icon,
  Money,
  SecondaryButton,
  SectionTitle,
  SoftButton,
  TextButton,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { sheetPath, type Chosen, type NeedsRow, type Picking } from './ActivityRows';

export function NeedsCategory({
  needs,
  openNeeds,
  chosen,
  selecting,
  setSelecting,
  sel,
  setSel,
  openPicker,
  onAccept,
  onAcceptAll,
  onJoin,
}: {
  /** The rows to show: under a search, only those it matches. */
  needs: NeedsRow[];
  openNeeds: NeedsRow[];
  chosen: Record<string, Chosen>;
  selecting: boolean;
  setSelecting: (f: (x: boolean) => boolean) => void;
  sel: Record<string, boolean>;
  setSel: (f: Record<string, boolean> | ((s: Record<string, boolean>) => Record<string, boolean>)) => void;
  openPicker: (p: Picking) => void;
  onAccept: (r: NeedsRow) => void;
  onAcceptAll: (rows: NeedsRow[]) => void;
  onJoin: (r: NeedsRow) => void;
}) {
  const online = useCanWrite();
  const open = (r: NeedsRow) =>
    !chosen[r.key] || (chosen[r.key]!.categoryId === null && !chosen[r.key]!.toRta);
  // OK all leaves out "Same as" rows: those wait for you to Join or not (docs/payees.md 4.3), offline too, where
  // the question hides until Join can be sent.
  const strong = needs.filter((r) => open(r) && r.suggestion?.strong && !r.sameAs);
  const note =
    openNeeds.length === 0
      ? undefined
      : `${openNeeds.length} · ${formatCents(openNeeds.reduce((s, r) => s + r.amount, 0))}`;
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <SectionTitle
        note={openNeeds.length > 1 ? undefined : note}
        action={
          openNeeds.length > 1 && (
            // SectionTitle spreads a note and an action apart; here the total sits next to Select.
            <span className="flex items-center gap-3">
              <span className="text-xs text-muted">{note}</span>
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
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {openNeeds.length === 0 && (
          <p className="m-0 px-3 py-3.5 text-md font-semibold text-funded-fg">Everything has a category.</p>
        )}
        {needs.map((r) => {
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
                <Checkbox
                  checked={on}
                  aria-label={`Select ${r.payee} ${formatCents(r.amount)}`}
                  onChange={() => setSel((s) => ({ ...s, [r.key]: !s[r.key] }))}
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <Link
                  to={sheetPath('/activity', r)}
                  className="flex min-h-11 min-w-0 flex-col justify-center gap-[3px] text-ink no-underline"
                >
                  <span className="flex justify-between gap-2">
                    <span className="text-base font-semibold">{r.payee}</span>
                    <Money
                      cents={r.amount}
                      plus
                      className={cx('text-base font-bold', r.amount > 0 ? 'text-funded-fg' : 'text-ink')}
                    />
                  </span>
                  <span className="text-xs text-muted">{rowMeta(r, 'needs')}</span>
                </Link>
                {!label && r.sameAs && online ? (
                  // Outside the row's link: Join is its own action (docs/payees.md 4.3).
                  <span className="flex flex-col gap-0.5 text-xs">
                    <span className="flex flex-wrap items-center gap-x-2 text-ink-2">
                      Same as your {r.sameAs.name}?
                      <TextButton
                        track="activity.payee.join"
                        aria-label={`Join ${r.payee} into your ${r.sameAs.name}`}
                        onClick={() => onJoin(r)}
                      >
                        Join
                      </TextButton>
                    </span>
                    {r.rawName && <span className="font-mono text-muted break-words">{r.rawName}</span>}
                  </span>
                ) : !label && r.newPayee && r.rawName ? (
                  <span className="text-xs text-muted break-words">
                    New payee · <span className="font-mono">{r.rawName}</span>
                  </span>
                ) : null}
                {!selecting && sug && (
                  // The guess reads as text you can tap to change; the button says what it does. Both sit under
                  // the row's text, so the payee and the bank's text keep the full width.
                  <span className="flex items-center justify-between gap-2.5">
                    <Button
                      mutates="offline"
                      track="activity.category.choose"
                      aria-label={`Choose category for ${r.payee} ${formatCents(r.amount)}`}
                      onClick={() => openPicker({ keys: [r.key], row: r })}
                      className="hit inline-flex min-h-9 min-w-0 items-center gap-1.5 text-md font-semibold text-ink-2"
                    >
                      <span className="truncate">{sug.name}</span>
                      <Icon name="pencil" size={16} className="shrink-0 text-muted" />
                    </Button>
                    <SoftButton
                      mutates="offline"
                      tone="filled"
                      track="activity.category.ok"
                      aria-label={`Use ${sug.name} for ${r.payee} ${formatCents(r.amount)}`}
                      onClick={() => onAccept(r)}
                      className="max-w-[60%]"
                    >
                      <span className="truncate">Use {sug.name}</span>
                    </SoftButton>
                  </span>
                )}
              </span>
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
          Use {strong.length} suggestions
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
          : `${picking.keys.length} ${picking.keys.length === 1 ? 'transaction' : 'transactions'}`
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
