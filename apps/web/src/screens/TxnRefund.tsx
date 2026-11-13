// A card refund's purchase on the transaction sheet (docs/design.md, Credit card refunds). Split from TxnEdit.tsx.
// Linked, the card's payment category gives back what it set aside for that purchase (Money rule 3); "Not this
// purchase" unlinks it. Unlinked, you can pick the purchase: the same payee's purchases on the card come first. Only
// you link a refund: nothing links one by itself.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RefundCandidate, TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { qk, useMoneyMutation } from '../api/hooks';
import { errorMessage } from '../api/client';
import {
  Button,
  cx,
  EmptyNote,
  ErrorNote,
  Label,
  Loading,
  Money,
  SoftButton,
  textLinkClass,
} from '../components/ui';
import { toast } from '../components/Toast';
import { dayLabel } from '../lib/dates';

export function RefundOf({
  t,
  category,
  onCategory,
}: {
  t: TxnSheet;
  /** The category picked on the sheet ('' for none, 'rta' for Ready to Assign). */
  category: string;
  /** Puts the purchase's category in the sheet's Category box (saved with Save). */
  onCategory: (id: string) => void;
}) {
  const link = useMoneyMutation(api.linkRefund);
  const relink = useMoneyMutation(api.linkRefund);
  const [picking, setPicking] = useState(false);
  const r = t.refundOf;
  if (r) {
    const unlink = async () => {
      const ok = await link.mutateAsync({ key: t.key, purchaseKey: null }).then(
        () => true,
        () => false,
      );
      if (!ok) return;
      toast.show({
        text: `Unlinked from ${r.label}`,
        undo: async () => {
          await relink.mutateAsync({ key: t.key, purchaseKey: r.key }).catch((e: unknown) => {
            toast.show({ text: errorMessage(e) });
          });
        },
      });
    };
    return (
      <div className="flex flex-col gap-1.5">
        <Label>Refund of</Label>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-md font-semibold">{r.label}</span>
            <span className="text-xs text-muted">
              {t.categoryLabel ?? 'Needs a category'} · {t.accountName}
            </span>
          </span>
          <SoftButton
            mutates="offline"
            tone="outline"
            track="txn.refund.unlink"
            disabled={link.isPending}
            onClick={() => void unlink()}
            className="shrink-0"
          >
            Not this purchase
          </SoftButton>
        </div>
        {r.categoryId && r.categoryName && category !== r.categoryId && (
          <SoftButton
            tone="soft"
            track="txn.refund.category"
            onClick={() => onCategory(r.categoryId!)}
            className="self-start"
          >
            Put in {r.categoryName}
          </SoftButton>
        )}
        {link.error && <ErrorNote error={link.error} />}
      </div>
    );
  }
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-line">
      <div className="flex min-h-12 items-center justify-between gap-3 px-3">
        <span className="text-md">Refund of a purchase on this card?</span>
        <button
          type="button"
          data-track="txn.refund.pick"
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
          className={cx(textLinkClass, 'shrink-0 self-center')}
        >
          {picking ? 'Close' : 'Pick it'}
        </button>
      </div>
      {picking && (
        <Purchases
          t={t}
          busy={link.isPending}
          onPick={async (p) => {
            const ok = await link.mutateAsync({ key: t.key, purchaseKey: p.key }).then(
              () => true,
              () => false,
            );
            if (ok) setPicking(false);
          }}
        />
      )}
      {link.error && (
        <div className="border-t border-divider p-3">
          <ErrorNote error={link.error} />
        </div>
      )}
    </div>
  );
}

function Purchases({
  t,
  busy,
  onPick,
}: {
  t: TxnSheet;
  busy: boolean;
  onPick: (p: RefundCandidate) => Promise<void>;
}) {
  const q = useQuery({ queryKey: [...qk.txn(t.key), 'refund-of'], queryFn: () => api.refundOf(t.key) });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading />;
  const { suggested, others } = q.data;
  if (!suggested.length && !others.length)
    return <EmptyNote inCard>No purchases on this card in the 90 days before this refund.</EmptyNote>;
  const list = (title: string, rows: RefundCandidate[]) =>
    rows.length > 0 && (
      <div className="flex flex-col border-t border-divider">
        <span className="px-3 pt-3 pb-1">
          <Label>{title}</Label>
        </span>
        {rows.map((p) => (
          <PurchaseRow key={p.key} p={p} busy={busy} onPick={onPick} />
        ))}
      </div>
    );
  return (
    <>
      {list(`From ${t.payee}`, suggested)}
      {list(suggested.length ? 'Other purchases on this card' : 'Purchases on this card', others)}
    </>
  );
}

function PurchaseRow({
  p,
  busy,
  onPick,
}: {
  p: RefundCandidate;
  busy: boolean;
  onPick: (p: RefundCandidate) => Promise<void>;
}) {
  return (
    <Button
      mutates="offline"
      track="txn.refund.purchase"
      disabled={busy}
      onClick={() => void onPick(p)}
      className="hit flex min-h-14 w-full items-center justify-between gap-3 border-t border-divider px-3 text-left text-ink"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-base font-semibold">
          {p.payee} · {dayLabel(p.date)}
        </span>
        <span className="text-xs text-muted">{p.categoryLabel ?? 'Needs a category'}</span>
      </span>
      <Money cents={-p.amount} className="shrink-0 font-bold" />
    </Button>
  );
}
