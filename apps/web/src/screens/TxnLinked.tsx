// A paid-back inflow (with Unlink) and a paired transfer (with Unpair).
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, Label, PrimaryButton, SoftButton, SoftLink } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { usage } from '../usage/tracker';
import { BankSays, useParentPath } from './TxnCommon';

export function PaidBack({ t, close }: { t: TxnSheet; close: () => void }) {
  const parent = useParentPath();
  const unlink = useMoneyMutation(api.unlink);
  const match = useMoneyMutation(api.doMatch);
  /** After Unlink: who is owed again ('' when the label has no name). */
  const [unlinked, setUnlinked] = useState<string | null>(null);
  const pb = t.paybacks[0];
  return (
    <Sheet
      label={`${t.payee} paid back`}
      track="txn.paid"
      onClose={close}
      gap="auto"
      header={
        <SheetTitle
          tag={unlinked !== null ? 'Waiting to match' : 'Paid back'}
          tagClass={unlinked !== null ? 'text-funded-fg' : 'text-owed-fg'}
          amount={formatCents(t.amount, { plus: true })}
          amountClass="text-funded-fg"
          sub={`${t.payee} · ${t.accountName} · ${dayLabel(t.date)}`}
        />
      }
      footer={
        <PrimaryButton track="txn.paid.done" onClick={close}>
          Done
        </PrimaryButton>
      }
    >
      {unlinked === null && pb ? (
        <div className="flex flex-col gap-2">
          <Label>Pays back</Label>
          <Link
            to="/owed"
            className="flex items-center justify-between gap-2 rounded-lg border border-line p-3 text-ink no-underline"
          >
            <span className="flex flex-col">
              <span className="text-md font-semibold">{pb.label}</span>
            </span>
            <span className="tnum font-bold">{formatCents(pb.amount)}</span>
          </Link>
          <SoftButton
            mutates
            tone="outline"
            track="txn.paid.unlink"
            onClick={async () => {
              await unlink.mutateAsync(pb.inflowKey);
              usage.suggestion('payback', 'unlinked');
              setUnlinked(pb.label.split(' · ')[0] ?? '');
            }}
            className="self-start"
          >
            Unlink
          </SoftButton>
          <p className="m-0 text-sm leading-snug text-muted">
            It went to Ready to Assign and paid back {formatCents(pb.amount)}.
          </p>
        </div>
      ) : unlinked !== null ? (
        <div className="flex flex-col gap-2">
          <Banner tone="success" title="Unlinked">
            {unlinked ? `${unlinked} is owed again. ` : ''}This {formatCents(t.amount)} is back in Waiting to
            match.
          </Banner>
          <div className="flex gap-2">
            {pb && (
              <SoftButton
                mutates
                tone="outline"
                track="txn.paid.undo"
                onClick={async () => {
                  await match.mutateAsync({
                    inflowKey: pb.inflowKey,
                    items: [{ itemId: pb.itemId, amount: pb.amount }],
                    rest: 'income',
                  });
                  usage.undo('unlink');
                  setUnlinked(null);
                }}
              >
                Undo
              </SoftButton>
            )}
            <SoftLink to={`${parent}/match/${encodeURIComponent(t.key)}`} tone="filled">
              Match to something else
            </SoftLink>
          </div>
        </div>
      ) : null}
      {t.memo && (
        <div className="flex flex-col gap-1">
          <Label>Memo</Label>
          <span className="text-base">{t.memo}</span>
        </div>
      )}
      <BankSays t={t} />
    </Sheet>
  );
}

export function PairedTransfer({ t, close }: { t: TxnSheet; close: () => void }) {
  const unpair = useMoneyMutation(api.unpairTransfer);
  const [unpaired, setUnpaired] = useState(false);
  const other = t.payee.includes('→') ? t.payee.split('→')[1]!.trim() : 'the other account';
  const amt = Math.abs(t.amount);

  return (
    <Sheet
      label="Transfer"
      track="txn.transfer"
      onClose={() => {
        if (!unpaired) usage.suggestion('transfer_pair', 'kept');
        close();
      }}
      gap="auto"
      header={
        <SheetTitle tag="Transfer" amount={formatCents(amt)} sub={`${t.payee} · ${dayLabel(t.date)}`} />
      }
      footer={<PrimaryButton onClick={close}>Done</PrimaryButton>}
    >
      <div className="flex flex-col gap-3">
        {!unpaired ? (
          <>
            <div className="shrink-0 overflow-hidden rounded-lg border border-line">
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-md font-semibold">From {t.accountName}</span>
                  <span className="text-xs text-muted">{t.rawName}</span>
                </span>
                <span className="tnum font-bold">{formatCents(-amt)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-divider px-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-md font-semibold">
                    To {other} · {dayLabel(t.date)}
                  </span>
                  <span className="text-xs text-muted">Deposit</span>
                </span>
                <span className="tnum font-bold text-funded-fg">{formatCents(amt, { plus: true })}</span>
              </div>
            </div>
            <p className="m-0 text-sm leading-snug text-muted">
              It moves money between your accounts. No category changes.
            </p>
            <SoftButton
              mutates
              tone="outline"
              track="txn.transfer.unpair"
              onClick={async () => {
                await unpair.mutateAsync(t.key);
                usage.suggestion('transfer_pair', 'unpaired');
                setUnpaired(true);
              }}
              className="self-start"
            >
              Unpair
            </SoftButton>
          </>
        ) : (
          <Banner tone="warn" title="Unpaired">
            Both halves now need a category.
          </Banner>
        )}
      </div>
    </Sheet>
  );
}
