// On a transaction's sheet: the other row of a pair (your entry's cover of a bank row, the posted charge that took your
// entry, or the posted charge that took the bank's pending row without the bank's link), with Not the same, which
// undoes the pair and remembers No (docs/payee-names.md 9.1).
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { toast } from '../components/Toast';
import { ErrorNote, Icon, Label, SoftButton } from '../components/ui';

export function PairedWith({ t, close }: { t: TxnSheet; close: () => void }) {
  const undo = useMoneyMutation(api.notSame);
  if (!t.pairedWith) return null;
  const other = t.pairedWith.label;
  const notSame = (
    <SoftButton
      mutates="offline"
      tone="outline"
      track="txn.not_same"
      aria-label={`Not the same: ${t.payee} and ${other}`}
      disabled={undo.isPending}
      onClick={async () => {
        await undo.mutateAsync(t.key);
        toast.show({ text: 'Kept as two purchases' });
        close();
      }}
    >
      Not the same
    </SoftButton>
  );
  // Your own entry: say plainly that the bank's pending row is now this purchase.
  const yours = t.kind === 'manual' || t.kind === 'upcoming';
  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {yours ? (
        <div className="flex flex-col gap-1 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-md font-bold">
              <Icon name="check" size={16} />
              Matched to the bank
            </span>
            {notSame}
          </div>
          <span className="text-xs text-muted">{other}</span>
        </div>
      ) : (
        <>
          <Label>Same purchase as</Label>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
            <span className="min-w-0 text-md font-semibold">{other}</span>
            {notSame}
          </div>
        </>
      )}
      {undo.error && <ErrorNote error={undo.error} />}
    </div>
  );
}
