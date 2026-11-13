// A card refund's purchase on the transaction sheet (docs/design.md, Credit card refunds). Split from TxnEdit.tsx.
import type { TxnSheet } from '@ledgerline/contracts';
import { Label } from '../components/ui';

export function RefundOf({ t }: { t: TxnSheet }) {
  if (!t.refundOf) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Refund of</Label>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
        <span className="flex flex-col">
          <span className="text-md font-semibold">{t.refundOf.label}</span>
          <span className="text-xs text-muted">
            {t.categoryLabel} · {t.accountName}
          </span>
        </span>
      </div>
    </div>
  );
}
