// On a transaction's sheet: the other row of a pair made by your entry and a bank row (a cover, or the posted charge
// that took your entry), with Not the same, which undoes the pair and remembers No (docs/payee-names.md 9.1).
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { toast } from '../components/Toast';
import { ErrorNote, Label, SoftButton } from '../components/ui';

export function PairedWith({ t, close }: { t: TxnSheet; close: () => void }) {
  const undo = useMoneyMutation(api.notSame);
  if (!t.pairedWith) return null;
  const other = t.pairedWith.label;
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      <Label>Same purchase as</Label>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
        <span className="min-w-0 text-md font-semibold">{other}</span>
        <SoftButton
          mutates
          tone="outline"
          track="txn.not_same"
          aria-label={`Not the same: ${t.payee} and ${other}`}
          disabled={undo.isPending}
          onClick={async () => {
            await undo.mutateAsync(t.key);
            toast.show({ text: 'Not the same: both count now' });
            close();
          }}
        >
          Not the same
        </SoftButton>
      </div>
      {undo.error && <ErrorNote error={undo.error} />}
    </div>
  );
}
