// Transaction sheet: picks the variant (edit, paid back, paired transfer; TxnEdit.tsx, TxnLinked.tsx). Also
// Rename payee. Split lives in TxnSplit.tsx.
import { useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn, usePayees, qk } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import {
  ErrorNote,
  Field,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  SecondaryButton,
} from '../components/ui';
import { useScreen } from '../lib/common';
import { useClose, useParentPath } from './TxnCommon';
import { EditTxn } from './TxnEdit';
import { PaidBack, PairedTransfer } from './TxnLinked';

export { useParentPath } from './TxnCommon';
export { SplitScreen } from './TxnSplit';

export function TxnSheetScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  const q = useTxn(key);
  const close = useClose();
  const t = q.data;
  useScreen(t ? `txn.${t.kind}` : 'txn');
  if (!t)
    return (
      <Sheet label="Transaction" track="txn" onClose={close} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  if (t.kind === 'transfer') return <PairedTransfer t={t} close={close} />;
  if (t.kind === 'paidBack') return <PaidBack t={t} close={close} />;
  return <EditTxn t={t} close={close} />;
}

// ------------------------------------------------------------------ rename payee (from a transaction)

export function RenamePayeeFromTxn() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('payee.rename');
  const q = useTxn(key);
  const payees = usePayees();
  const navigate = useNavigate();
  const parent = useParentPath();
  const back = () => void navigate({ to: `${parent}/txn/${encodeURIComponent(key)}` });
  const patch = useMoneyMutation(
    (v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) => api.patchTxn(v.key, v.body),
    { invalidate: [qk.payees] },
  );
  const rename = useMoneyMutation(
    (v: { id: string; name: string }) => api.renamePayee(v.id, { name: v.name, remember: true }),
    { invalidate: [qk.payees] },
  );
  const [name, setName] = useState<string | null>(null);
  const t = q.data;
  if (!t)
    return (
      <Sheet label="Rename payee" track="payee.rename" onClose={back} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const value = name ?? t.payee;
  const payee = payees.data?.payees.find((p) => p.name === t.payee);
  const save = async () => {
    if (payee) await rename.mutateAsync({ id: payee.id, name: value.trim() });
    else await patch.mutateAsync({ key: t.key, body: { payeeName: value.trim() } });
    back();
  };
  return (
    <Sheet
      label="Rename payee"
      track="payee.rename"
      onClose={back}
      gap="auto"
      header={<h1 className="m-0 text-[20px] font-bold">Rename payee</h1>}
    >
      <div className="flex flex-col gap-3 pb-4">
        <Field label="Show as">
          <input className={inputClass} value={value} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <Label>Bank names that become this payee</Label>
          <div className="flex items-center justify-between rounded-xl border border-line px-3 py-2.5 text-[14px]">
            <span className="font-semibold">{t.rawName}</span>
            <span className="text-[12px] text-muted">
              {payee ? `${payee.transactions} transactions` : 'this transaction'}
            </span>
          </div>
        </div>
        <p className="m-0 text-[12px] leading-snug text-muted">
          Applies to past and future transactions. Rules follow the new name. The bank’s description stays on
          each transaction.
        </p>
        {(patch.error || rename.error) && <ErrorNote error={patch.error ?? rename.error} />}
        <PrimaryButton mutates track="payee.rename.save" disabled={!value.trim()} onClick={() => void save()}>
          Save
        </PrimaryButton>
        <SecondaryButton onClick={back}>Cancel</SecondaryButton>
      </div>
    </Sheet>
  );
}
