// Close account and Reopen account, from an account's ⋯ menu (D-73). Close works only at $0; the register says why
// when it can't yet. Pending transactions don't block it: they stay and stop waiting for the bank (D-93). A closed account leaves Accounts and the Add list, keeps its rows, and opens again on a new row.
// A card held back only by money in its payment category gets "Move $X to Ready to Assign" here (the owner's choice:
// card payment categories stay out of Move money), and then closes in the same sheet.
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AccountRow, RegisterView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation, useSession } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, ErrorNote, PrimaryButton, SecondaryButton } from '../components/ui';
import { formatCents } from '../lib/money';

export function CloseAccountSheet({
  account,
  block,
  move = null,
  close,
}: {
  account: AccountRow;
  block: string | null;
  move?: RegisterView['closeMove'];
  close: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const credit = account.kind === 'credit';
  const month = useSession().data?.budget.currentMonth;
  const mover = useMoneyMutation(api.move);
  const [moved, setMoved] = useState<number | null>(null);
  const moveOut = async () => {
    if (!move || !month) return;
    setError(null);
    try {
      await mover.mutateAsync({ month, from: move.categoryId, to: 'rta', amount: move.amount });
      setMoved(move.amount);
      // The register works out the block again: with the category at $0, Close opens.
      await qc.invalidateQueries();
    } catch (e) {
      setError(e);
    }
  };
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
      {move && block !== null && (
        <SecondaryButton
          mutates
          track="account.close.move"
          disabled={mover.isPending || !month}
          onClick={() => void moveOut()}
        >
          Move {formatCents(move.amount)} to Ready to Assign
        </SecondaryButton>
      )}
      {moved !== null && block === null && (
        <Banner tone="success" icon="check">
          Moved {formatCents(moved)} to Ready to Assign. You can close the card now.
        </Banner>
      )}
      {block === null && account.pending !== 0 && (
        <p className="m-0 text-sm leading-snug text-muted">
          The pending transactions here stay and still count. They stop waiting for the bank.
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
