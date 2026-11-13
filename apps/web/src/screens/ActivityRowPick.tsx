// Desktop Activity: each row with a category that is all it needs (TxnListRow.categoryId) shows its category tag
// as a menu, where the tag would be, so the amounts stay lined up at the right. It opens the category picker; a pick categorizes the row at once, with Undo. A row with no category has its
// Choose under Needs category, and a phone opens the row's sheet.
import { useState } from 'react';
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { useMoneyMutation } from '../api/hooks';
import { CategoryPickerSheet, primeKeyboard } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { Button, cx, Icon, useIsDesktop } from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';

/** The category menu for a row (TxnRow's categoryMenu), or undefined when the row has none; and the picker it opens. */
export function useRowPicker(groups: ActivityView['categoryPicker'] | undefined) {
  const desktop = useIsDesktop();
  const canWrite = useCanWrite({ offline: true });
  const categorize = useMoneyMutation(api.categorize);
  const [row, setRow] = useState<TxnListRow | null>(null);
  const nameOf = (id: string) =>
    (groups ?? []).flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'category';

  const pick = async (r: TxnListRow, categoryId: string) => {
    setRow(null);
    const before = r.categoryId ?? null;
    if (before === categoryId) return;
    try {
      await categorize.mutateAsync({ keys: [r.key], categoryId });
    } catch (e) {
      toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t categorize that. Try again.' });
      return;
    }
    usage.endTask('categorize');
    toast.show({
      text: `${r.payee} → ${nameOf(categoryId)}`,
      undo: async () => {
        try {
          await categorize.mutateAsync({ keys: [r.key], categoryId: before });
          usage.undo('categorize');
        } catch (e) {
          toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t undo that. Try again.' });
        }
      },
    });
  };

  const menu = (r: TxnListRow) => {
    if (!desktop || !r.categoryId) return undefined;
    const label = r.categoryLabel ?? nameOf(r.categoryId);
    return (
      // Drawn like the category tag it replaces, with a chevron; above the row's stretched link (TxnRow).
      <Button
        mutates="offline"
        track="activity.row.category"
        aria-label={`Category for ${r.payee} ${formatCents(r.amount)}: ${label}`}
        aria-haspopup="dialog"
        onClick={() => {
          primeKeyboard();
          usage.startTask('categorize');
          setRow(r);
        }}
        className={cx(
          'group relative z-10 inline-flex max-w-[220px] items-center gap-1 rounded-sm border border-line bg-surface px-2 py-[1px] text-xs font-semibold text-ink-2',
          'not-disabled:hover:border-accent not-disabled:hover:text-accent disabled:pointer-events-none',
        )}
      >
        <span className="truncate">{label}</span>
        <Icon
          name="chevD"
          size={12}
          className="shrink-0 text-muted group-hover:text-accent group-disabled:hidden"
        />
      </Button>
    );
  };

  const sheet = row && groups && (
    <CategoryPickerSheet
      track="activity.row.picker"
      groups={groups.map((g) => ({ key: g.group, name: g.group, categories: g.categories }))}
      value={row.categoryId ?? undefined}
      disabled={!canWrite}
      sub={`${row.payee} · ${formatCents(row.amount)} · ${rowMeta(row, 'needs')}`}
      onPick={(id) => void pick(row, id)}
      onClose={() => {
        usage.cancelTask('categorize');
        setRow(null);
      }}
    />
  );

  return { menu, sheet };
}
