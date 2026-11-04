// A row from before the account's budget start ("Before your budget", D-?): shown for reference, never changed.
import type { TxnSheet } from '@ledgerline/contracts';
import { Sheet } from '../components/Sheet';
import { Banner, Label, PrimaryButton } from '../components/ui';
import { TxnHeader } from './TxnCommon';

export function HistoryTxn({ t, close }: { t: TxnSheet; close: () => void }) {
  return (
    <Sheet
      label={`${t.payee}, before your budget`}
      track="txn.history"
      onClose={close}
      gap="auto"
      header={<TxnHeader t={t} />}
      footer={
        <PrimaryButton track="txn.history.done" onClick={close}>
          Done
        </PrimaryButton>
      }
    >
      <Banner tone="neutral" title="Not counted">
        This posted before this account’s budget start. Your budget doesn’t count it, so it can’t be changed.
      </Banner>
      <div className="flex flex-col gap-1">
        <Label>Bank says</Label>
        <span className="text-[14px] text-ink">{t.rawName}</span>
      </div>
      {t.categoryId && t.categoryLabel && (
        <div className="flex flex-col gap-1">
          <Label>Category</Label>
          <span className="text-[14px] text-ink">{t.categoryLabel}</span>
        </div>
      )}
      {t.memo && (
        <div className="flex flex-col gap-1">
          <Label>Note</Label>
          <span className="text-[14px] text-ink">{t.memo}</span>
        </div>
      )}
    </Sheet>
  );
}
