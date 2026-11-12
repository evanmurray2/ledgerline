// Close account and Reopen account, from an account's ⋯ menu (D-73). Close works only at $0; the register says why
// when it can't yet. Pending transactions you added don't block it: they stay and stop waiting for the bank (D-93). A closed account leaves Accounts and the Add list, keeps its rows, and opens again on a new row.
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountRow } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, ErrorNote, PrimaryButton } from '../components/ui';

export function CloseAccountSheet({
  account,
  block,
  close,
}: {
  account: AccountRow;
  block: string | null;
  close: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const credit = account.kind === 'credit';
  const save = async () => {
    setBusy(true);
    try {
      await api.closeAccount(account.id);
      // The account leaves Accounts, the Add list and (a card) the Budget.
      await qc.invalidateQueries();
      close();
      void navigate({ to: '/accounts' });
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Sheet
      label="Close account"
      track="account.close"
      onClose={close}
      gap="auto"
      closeLabel="Cancel"
      header={<SheetTitle title={`Close ${account.name}`} />}
      footer={
        <div className="flex flex-col gap-2">
          {error !== null && <ErrorNote error={error} />}
          <PrimaryButton
            mutates
            danger
            track="account.close.save"
            busy={busy}
            disabled={busy || block !== null}
            onClick={() => void save()}
          >
            Close account
          </PrimaryButton>
        </div>
      }
    >
      {block !== null && <Banner tone="warn">{block}</Banner>}
      {block === null && account.pending !== 0 && (
        <p className="m-0 text-sm leading-snug text-muted">
          The pending transactions you added here stay and still count. They stop waiting for the bank.
        </p>
      )}
      <p className="m-0 text-sm leading-snug text-muted">
        The account leaves Accounts and the Add list. Its transactions stay, so past months don’t change.
        {credit && ' Its payment category leaves the Budget.'}
      </p>
      <p className="m-0 text-sm leading-snug text-muted">
        If the bank sends a new transaction, the account opens again. The bank link stays.
      </p>
    </Sheet>
  );
}
