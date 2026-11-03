// A paid-back inflow (with Unlink) and a paired transfer (with Unpair).
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { Button, cx, Label, PrimaryButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { usage } from '../usage/tracker';
import { BankSays, useParentPath } from './TxnCommon';

export function PaidBack({ t, close }: { t: TxnSheet; close: () => void }) {
  const parent = useParentPath();
  const unlink = useMoneyMutation(api.unlink);
  const match = useMoneyMutation(api.doMatch);
  const [unlinked, setUnlinked] = useState(false);
  const pb = t.paybacks[0];
  return (
    <Sheet
      label={`${t.payee} paid back`}
      track="txn.paid"
      onClose={close}
      gap="auto"
      header={
        <div className="flex flex-col gap-0.5">
          <span className={cx('text-[13px] font-bold', unlinked ? 'text-funded-fg' : 'text-owed-fg')}>
            {unlinked ? 'Waiting to match' : 'Paid back'}
          </span>
          <h1 className="tnum m-0 text-[28px] font-bold text-funded-fg">
            {formatCents(t.amount, { plus: true })}
          </h1>
          <span className="text-[14px] text-muted">
            {t.payee} · {t.accountName} · {dayLabel(t.date)}
          </span>
        </div>
      }
      footer={
        <PrimaryButton track="txn.paid.done" onClick={close}>
          Done
        </PrimaryButton>
      }
    >
      {!unlinked && pb ? (
        <div className="flex flex-col gap-2">
          <Label>Pays back</Label>
          <Link
            to="/owed"
            className="flex items-center justify-between gap-2 rounded-xl border border-line p-3 text-ink no-underline"
          >
            <span className="flex flex-col">
              <span className="text-[14px] font-semibold">{pb.label}</span>
              <span className="text-[12px] text-muted">{formatCents(pb.amount)} matched</span>
            </span>
            <span className="tnum font-bold">{formatCents(pb.amount)}</span>
          </Link>
          <Button
            mutates
            track="txn.paid.unlink"
            onClick={async () => {
              await unlink.mutateAsync(pb.inflowKey);
              usage.suggestion('payback', 'unlinked');
              setUnlinked(true);
            }}
            className="hit h-9 self-start rounded-full border border-line-strong px-3 text-[13px] font-bold text-ink-2"
          >
            Unlink
          </Button>
          <p className="m-0 text-[13px] leading-snug text-muted">
            It went to Ready to Assign and settled {formatCents(pb.amount, { whole: true })} of what was owed
            for {pb.label.split(' · ')[0]}.
          </p>
        </div>
      ) : (
        <div role="status" className="flex flex-col gap-2 rounded-xl bg-success-soft p-3 text-funded-fg">
          <span className="text-[14px] font-bold">Unlinked</span>
          <span className="text-[13px] leading-snug">
            {pb?.label.split(' · ')[0]} is owed again. This {formatCents(t.amount)} is back in Waiting to
            match, outside Ready to Assign, until you match it again or call it income.
          </span>
          <div className="flex gap-2">
            {pb && (
              <Button
                mutates
                track="txn.paid.undo"
                onClick={async () => {
                  await match.mutateAsync({
                    inflowKey: pb.inflowKey,
                    items: [{ itemId: pb.itemId, amount: pb.amount }],
                    rest: 'income',
                  });
                  usage.undo('unlink');
                  setUnlinked(false);
                }}
                className="hit h-9 rounded-full border border-success-border bg-surface px-3 text-[13px] font-bold text-funded-fg"
              >
                Undo
              </Button>
            )}
            <Link
              to={`${parent}/match/${encodeURIComponent(t.key)}`}
              className="hit flex h-9 items-center rounded-full bg-accent px-3 text-[13px] font-bold text-on-accent no-underline"
            >
              Match to something else
            </Link>
          </div>
        </div>
      )}
      {t.memo && (
        <div className="flex flex-col gap-1">
          <Label>Memo</Label>
          <span className="text-[15px]">{t.memo}</span>
        </div>
      )}
      <BankSays t={t} extra={`Matched by you on ${dayLabel(t.date)}`} />
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
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-bold text-muted">Transfer · {dayLabel(t.date)}</span>
          <h1 className="tnum m-0 text-[28px] font-bold">{formatCents(amt)}</h1>
        </div>
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        {!unpaired ? (
          <>
            <div className="shrink-0 overflow-hidden rounded-[14px] border border-line">
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-[14px] font-semibold">From {t.accountName}</span>
                  <span className="text-[12px] text-muted">{t.rawName}</span>
                </span>
                <span className="tnum font-bold">{formatCents(-amt)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-divider px-3 py-2.5">
                <span className="flex flex-col">
                  <span className="text-[14px] font-semibold">
                    To {other} · {dayLabel(t.date)}
                  </span>
                  <span className="text-[12px] text-muted">Deposit</span>
                </span>
                <span className="tnum font-bold text-funded-fg">{formatCents(amt, { plus: true })}</span>
              </div>
            </div>
            <p className="m-0 text-[13px] leading-snug text-muted">
              Paired automatically: same amount, opposite sides, within 5 days, and no other account had a
              match. Both accounts are in your budget, so this moves money without changing any category.
            </p>
            <Button
              mutates
              track="txn.transfer.unpair"
              onClick={async () => {
                await unpair.mutateAsync(t.key);
                usage.suggestion('transfer_pair', 'unpaired');
                setUnpaired(true);
              }}
              className="hit h-9 self-start rounded-full border border-line-strong px-3 text-[13px] font-bold text-ink-2"
            >
              Not a transfer? Unpair
            </Button>
          </>
        ) : (
          <p role="status" className="m-0 rounded-xl bg-under-bg p-3 text-[13px] leading-snug text-under-fg">
            Unpaired. Both halves now need a category and show in Activity under Needs category.
          </p>
        )}
        <PrimaryButton onClick={close}>Done</PrimaryButton>
      </div>
    </Sheet>
  );
}
