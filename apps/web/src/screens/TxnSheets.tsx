// Transaction sheet: picks the variant (edit, paid back, paired transfer, before your budget; TxnEdit.tsx,
// TxnLinked.tsx, TxnHistory.tsx). Also Rename payee. Split lives in TxnSplit.tsx.
import { useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn, usePayees, qk } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { ErrorNote, Loading } from '../components/ui';
import { useScreen } from '../lib/common';
import { RenamePayeeSheet } from '../components/RenamePayee';
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
  if (!t)
    return (
      <Sheet label="Transaction" track="txn" onClose={close} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  if (t.kind === 'history') return <HistoryTxn t={t} close={close} />;
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
  const merge = useMoneyMutation((v: { ids: string[]; name: string }) => api.mergePayees(v), {
    invalidate: [qk.payees],
  });
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
  const all = payees.data?.payees ?? [];
  const payee = all.find((p) => p.name === t.payee);
  return (
    <RenamePayeeSheet
      onClose={back}
      name={t.payee}
      rawNames={[
        { name: t.rawName, meta: payee ? `${payee.transactions} transactions` : 'this transaction' },
      ]}
      mergeInto={
        payee ? all.filter((p) => p.id !== payee.id).map((p) => ({ id: p.id, name: p.name })) : undefined
      }
      onSave={async (name, into) => {
        if (payee && into) {
          const target = all.find((p) => p.id === into)!;
          await merge.mutateAsync({ ids: [into, payee.id], name: target.name });
        } else if (payee) await rename.mutateAsync({ id: payee.id, name });
        else await patch.mutateAsync({ key: t.key, body: { payeeName: name } });
        back();
      }}
    />
  );
}
