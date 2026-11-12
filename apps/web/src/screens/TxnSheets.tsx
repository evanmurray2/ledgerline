// Transaction sheet: picks the variant (edit, paid back, paired transfer, before your budget; TxnEdit.tsx,
// TxnLinked.tsx, TxnHistory.tsx). Also Rename payee. Split lives in TxnSplit.tsx.
import { useRef } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn, usePayees, qk } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { ErrorNote, Loading } from '../components/ui';
import { useScreen } from '../lib/common';
import { RenamePayeeSheet, txnCount, usePayeeSave } from '../components/RenamePayee';
import { useClose, useParentPath } from './TxnCommon';
import { EditTxn } from './TxnEdit';
import { PaidBack, PairedTransfer } from './TxnLinked';
import { HistoryTxn } from './TxnHistory';

export { useParentPath } from './TxnCommon';
export { SplitScreen } from './TxnSplit';

export function TxnSheetScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  const q = useTxn(key);
  const close = useClose();
  const t = q.data;
  useScreen(t ? `txn.${t.kind}` : 'txn');
  // Unpair and Unlink change the transaction's kind; the sheet stays the one they were tapped on, so its
  // "Unpaired" or "Unlinked" note (and Undo) shows instead of the sheet switching under your finger.
  const linked = useRef<{ key: string; kind: 'transfer' | 'paidBack' } | null>(null);
  if (t && (t.kind === 'transfer' || t.kind === 'paidBack') && linked.current?.key !== key)
    linked.current = { key, kind: t.kind };
  const stuck = linked.current?.key === key ? linked.current.kind : null;
  if (!t)
    return (
      <Sheet label="Transaction" track="txn" onClose={close} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  if (t.kind === 'history') return <HistoryTxn t={t} close={close} />;
  if (stuck === 'transfer') return <PairedTransfer t={t} close={close} />;
  if (stuck === 'paidBack') return <PaidBack t={t} close={close} />;
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
  const back = () => void navigate({ to: `${parent}/txn/${encodeURIComponent(key)}`, search: true });
  const save = usePayeeSave();
  const patch = useMoneyMutation(
    (v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) => api.patchTxn(v.key, v.body),
    { invalidate: [qk.payees] },
  );
  const t = q.data;
  if (!t)
    return (
      <RenamePayeeSheet
        onClose={back}
        loading={{ error: q.error }}
        name=""
        rawNames={[]}
        onSave={async () => {}}
      />
    );
  const v = payees.data;
  const payee = t.payeeId ? v?.payees.find((p) => p.id === t.payeeId) : undefined;
  const others = t.payeeId && v ? [...v.payees, ...v.others].filter((p) => p.id !== t.payeeId) : undefined;
  return (
    <RenamePayeeSheet
      onClose={back}
      name={t.payee}
      rawNames={
        payee?.bankNames.length
          ? payee.bankNames.map((b) => ({ name: b.name, meta: txnCount(b.count) }))
          : [{ name: t.rawName, meta: 'this transaction' }]
      }
      others={others?.map((p) => ({ id: p.id, name: p.name }))}
      onSave={async (name, into) => {
        // A bank row renames (or joins) its payee by id; a manual entry has only a name.
        if (t.payeeId) await save(t.payeeId, name, into);
        else await patch.mutateAsync({ key: t.key, body: { payeeName: name } });
        back();
      }}
    />
  );
}
