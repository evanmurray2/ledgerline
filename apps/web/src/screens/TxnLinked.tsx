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
  // As the sheet opened: Unlink empties t.paybacks, and Undo puts these back.
  const [paybacks] = useState(t.paybacks);
  const moneyIn = t.amount > 0;
  const pb = paybacks[0];
  /** Unlink undoes every payback of one money in: this one, or (on a purchase) the one that paid it. */
  const inflowKey = moneyIn ? t.key : pb?.inflowKey;
  const undone = paybacks.filter((p) => p.inflowKey === inflowKey);
  const total = undone.reduce((a, p) => a + p.amount, 0);
  return (
    <Sheet
      label={`${t.payee} paid back`}
      track="txn.paid"
      onClose={close}
      gap="auto"
      header={
        <SheetTitle
          tag={unlinked !== null ? (moneyIn ? 'Waiting to match' : 'Owed to you') : 'Paid back'}
          tagClass={unlinked !== null ? 'text-funded-fg' : 'text-owed-fg'}
          amount={formatCents(t.amount, { plus: true })}
          amountClass={moneyIn ? 'text-funded-fg' : undefined}
          sub={`${t.payee} · ${t.accountName} · ${dayLabel(t.date)}`}
        />
      }
      footer={
        <PrimaryButton track="txn.paid.done" onClick={close}>
          Done
        </PrimaryButton>
      }
    >
      {unlinked === null && pb && inflowKey ? (
        <div className="flex flex-col gap-2">
          <Label>{moneyIn ? 'Pays back' : 'Paid back by'}</Label>
          {undone.map((p) => (
            <Link
              key={`${p.inflowKey}:${p.itemId}`}
              to="/owed"
              className="flex items-center justify-between gap-2 rounded-lg border border-line p-3 text-ink no-underline"
            >
              <span className="flex flex-col">
                <span className="text-md font-semibold">{p.label}</span>
              </span>
              <span className="tnum font-bold">{formatCents(p.amount)}</span>
            </Link>
          ))}
          <SoftButton
            mutates="offline"
            tone="outline"
            track="txn.paid.unlink"
            disabled={unlink.isPending}
            onClick={async () => {
              await unlink.mutateAsync(inflowKey);
              usage.suggestion('payback', 'unlinked');
              setUnlinked(moneyIn && undone.length === 1 ? (pb.label.split(' · ')[0] ?? '') : '');
            }}
            className="self-start"
          >
            Unlink
          </SoftButton>
          {moneyIn && (
            <p className="m-0 text-sm leading-snug text-muted">
              It went to Ready to Assign and paid back {formatCents(total)}.
            </p>
          )}
        </div>
      ) : unlinked !== null ? (
        <div className="flex flex-col gap-2">
          <Banner tone="success" title="Unlinked">
            {moneyIn
              ? `${unlinked ? `${unlinked} is owed again. ` : ''}This ${formatCents(t.amount)} is back in Waiting to match.`
              : `${formatCents(total)} is owed to you again.`}
          </Banner>
          <div className="flex gap-2">
            {inflowKey && undone.length > 0 && (
              <SoftButton
                mutates="offline"
                tone="outline"
                track="txn.paid.undo"
                disabled={match.isPending}
                onClick={async () => {
                  await match.mutateAsync({
                    inflowKey,
                    items: undone.map((p) => ({ itemId: p.itemId, amount: p.amount })),
                    rest: 'income',
                  });
                  usage.undo('unlink');
                  setUnlinked(null);
                }}
              >
                Undo
              </SoftButton>
            )}
            {moneyIn && (
              <SoftLink to={`${parent}/match/${encodeURIComponent(t.key)}`} tone="filled">
                Match to something else
              </SoftLink>
            )}
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
  const other = t.otherAccountName ?? 'the other account';
  const amt = Math.abs(t.amount);
  // This row is the money leaving its account, or (on the other side) the deposit arriving in it.
  const out = t.amount < 0;
  const from = out ? t.accountName : other;
  const to = out ? other : t.accountName;

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
                  <span className="text-md font-semibold">From {from}</span>
                  {out && <span className="text-xs text-muted">{t.rawName}</span>}
                </span>
                <span className="tnum font-bold">{formatCents(-amt)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-divider px-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-md font-semibold">
                    To {to} · {dayLabel(t.date)}
                  </span>
                  <span className="text-xs text-muted">{out ? 'Deposit' : t.rawName}</span>
                </span>
                <span className="tnum font-bold text-funded-fg">{formatCents(amt, { plus: true })}</span>
              </div>
            </div>
            <p className="m-0 text-sm leading-snug text-muted">
              It moves money between your accounts. No category changes.
            </p>
            <SoftButton
              mutates="offline"
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
