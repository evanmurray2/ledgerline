// Desktop Activity: each row with a category that is all it needs (TxnListRow.categoryId) carries it as a menu
// button. It opens the category picker; a pick categorizes the row at once, with Undo. A row with no category has its
// Choose under Needs category, and a phone opens the row's sheet.
import { useState } from 'react';
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { useMoneyMutation } from '../api/hooks';
import { CategoryPickerSheet, primeKeyboard } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { Icon, SoftButton, useIsDesktop } from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';

/** The menu button for a row, or undefined when the row has none; and the picker it opens. */
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

  const action = (r: TxnListRow) => {
    if (!desktop || !r.categoryId) return undefined;
    const label = r.categoryLabel ?? nameOf(r.categoryId);
    return (
      <SoftButton
        mutates="offline"
        tone="outline"
        track="activity.row.category"
        aria-label={`Category for ${r.payee} ${formatCents(r.amount)}: ${label}`}
        aria-haspopup="dialog"
        onClick={() => {
          primeKeyboard();
          usage.startTask('categorize');
          setRow(r);
        }}
        className="max-w-[180px] shrink-0"
      >
        <span className="truncate">{label}</span>
        <Icon name="chevD" size={14} className="shrink-0" />
      </SoftButton>
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

  return { action, sheet };
}
