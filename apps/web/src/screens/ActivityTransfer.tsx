// Transfer: pick the other side. Split from ActivitySheets.tsx.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation, useTxn } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, Button, ErrorNote, Loading, PrimaryButton, SecondaryButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useClose } from './TxnCommon';
import { usage } from '../usage/tracker';

export function TransferScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('transfer.pick');
  const q = useTxn(key);
  const close = useClose();
  const accounts = useAccounts();
  const pick = useMoneyMutation((v: { otherKey: string | null; unlinked?: boolean; accountId?: string }) =>
    api.pickTransfer(key, v),
  );
  const unpair = useMoneyMutation(api.unpairTransfer);
  const [result, setResult] = useState<string | null>(null);
  const t = q.data;
  const others = (accounts.data?.groups ?? [])
    .flatMap((g) => g.accounts)
    .filter((a) => t && a.id !== t.accountId);
  if (!t)
    return (
      <Sheet label="Transfer" track="transfer" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  // From a deposit, the other side is an outflow.
  const sent = t.amount > 0;
  // Filing asked about this row. Any other row gets here from "It's a transfer…": it has no question to answer "no" to.
  const unclear = t.kind === 'transfer' && !t.otherAccountName;
  // Money into checking or savings you call income goes to Ready to Assign (D-117); a credit on a card needs a category.
  const onCard =
    (accounts.data?.groups ?? []).flatMap((g) => g.accounts).find((a) => a.id === t.accountId)?.kind ===
    'credit';
  // The other sides Pick takes: rows of the opposite amount within 5 days in the other accounts that aren't a
  // transfer already (TxnSheet.candidates).
  const candidates = t.candidates ?? [];
  const n = candidates.length;
  // Deposits still waiting for this answer ("Pick the account"): the ones not picked count as income.
  const waiting = sent ? 0 : candidates.filter((row) => row.sheet === 'transfer').length;
  const income = (left: number) =>
    left <= 0
      ? ''
      : left === 1
        ? ' The other deposit counts as income.'
        : ' The other deposits count as income.';
  const lines = (name: string | null, picked?: { sheet: string }) =>
    name === null
      ? sent
        ? onCard
          ? 'Kept as income. It needs a category.'
          : 'Kept as income. It’s in Ready to Assign.'
        : `Kept as spending. It needs a category.${income(waiting)}`
      : `Paired with ${name}. It needs no category.${income(waiting - (picked?.sheet === 'transfer' ? 1 : 0))}`;
  const question = sent ? 'Which account sent this money?' : 'Which account got this money?';
  // Accounts whose side hasn't arrived yet (D-83): picking one adds a pending entry there, paired with this row.
  const listed = new Set(candidates.map((row) => row.accountId));
  const notYet = others.filter((a) => !listed.has(a.id));
  // A refusal shows in the sheet (pick.error, unpair.error), not as an uncaught error.
  const tried = (p: Promise<unknown>) =>
    p.then(
      () => true,
      () => false,
    );
  // Already paired: picking again would be refused. Unpair first; the sheet then asks again.
  const paired = t.kind === 'transfer' && !!t.otherAccountName;
  if (paired && !result)
    return (
      <Sheet
        label="Transfer"
        track="transfer"
        onClose={close}
        gap="auto"
        header={
          <SheetTitle
            tag="Transfer"
            tagClass="text-transfer-fg"
            amount={formatCents(Math.abs(t.amount))}
            sub={`${t.accountName} · ${dayLabel(t.date)} · “${t.rawName}”`}
          />
        }
      >
        <div className="flex flex-col gap-3 pb-4">
          <Banner tone="neutral">Paired with {t.otherAccountName}.</Banner>
          {unpair.error && <ErrorNote error={unpair.error} />}
          <div className="flex gap-2">
            <SecondaryButton
              mutates="offline"
              track="transfer.unpair"
              className="flex-1"
              onClick={() => void tried(unpair.mutateAsync(key))}
            >
              Unpair
            </SecondaryButton>
            <PrimaryButton className="flex-[2]" onClick={close}>
              Done
            </PrimaryButton>
          </div>
        </div>
      </Sheet>
    );
  return (
    <Sheet
      label={question}
      track="transfer"
      onClose={close}
      gap="auto"
      header={
        <SheetTitle
          tag={unclear ? 'Transfer to sort out' : 'Transfer'}
          amount={formatCents(Math.abs(t.amount))}
          sub={`${t.accountName} · ${dayLabel(t.date)} · “${t.rawName}”`}
        />
      }
    >
      <div className="flex flex-col gap-3 pb-4">
        {result ? (
          <>
            <Banner tone="success">{result}</Banner>
            {unpair.error && <ErrorNote error={unpair.error} />}
            <div className="flex gap-2">
              <SecondaryButton
                mutates="offline"
                track="transfer.undo"
                className="flex-1"
                onClick={async () => {
                  if (!(await tried(unpair.mutateAsync(key)))) return;
                  usage.undo('transfer_pick');
                  setResult(null);
                }}
              >
                Undo
              </SecondaryButton>
              <PrimaryButton className="flex-[2]" onClick={close}>
                Done
              </PrimaryButton>
            </div>
          </>
        ) : (
          <>
            <span className="text-base font-bold">{question}</span>
            <p className="m-0 text-sm leading-snug text-muted">
              {n === 0 ? 'No account' : n === 1 ? '1 account' : `${n} accounts`} {sent ? 'sent' : 'got'}{' '}
              {formatCents(Math.abs(t.amount))} within a few days.
            </p>
            <div className="flex flex-col gap-2">
              {candidates.map((row) => (
                <Button
                  key={row.key}
                  mutates="offline"
                  track="transfer.pick"
                  onClick={async () => {
                    if (!(await tried(pick.mutateAsync({ otherKey: row.key })))) return;
                    usage.suggestion('transfer_pick', 'paired');
                    setResult(lines(row.accountName, row));
                  }}
                  className="flex min-h-14 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="flex flex-col">
                    <span className="text-base font-semibold">{row.accountName}</span>
                    <span className="text-xs text-muted">
                      {dayLabel(row.date)} · “{row.payee}”
                    </span>
                  </span>
                  <span className={sent ? 'tnum font-bold' : 'tnum font-bold text-funded-fg'}>
                    {formatCents(row.amount, { plus: true })}
                  </span>
                </Button>
              ))}
              {notYet.length > 0 && (
                <span className="pt-2 text-sm font-semibold text-muted">
                  {n === 0 ? 'Pick the account' : 'Or another account'}
                </span>
              )}
              {notYet.map((a) => (
                <Button
                  key={a.id}
                  mutates="offline"
                  track="transfer.pick_pending"
                  onClick={async () => {
                    if (!(await tried(pick.mutateAsync({ otherKey: null, accountId: a.id })))) return;
                    usage.suggestion('transfer_pick', 'pending');
                    setResult(
                      `Paired with ${a.name}. It’s pending there until the bank sends it.${income(waiting)}`,
                    );
                  }}
                  className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="text-base font-semibold">{a.name}</span>
                  <span className="text-xs text-muted">Pending until the bank sends it</span>
                </Button>
              ))}
              <Button
                mutates="offline"
                track="transfer.unlinked"
                onClick={async () => {
                  if (!(await tried(pick.mutateAsync({ otherKey: null, unlinked: true })))) return;
                  usage.suggestion('transfer_pick', 'unlinked');
                  setResult(
                    sent
                      ? 'Marked as a transfer in. It goes into Ready to Assign.'
                      : `Marked as a transfer out. It comes out of Ready to Assign.${income(waiting)}`,
                  );
                }}
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
              >
                <span className="text-base font-semibold">An account that isn’t linked</span>
                <span className="text-xs text-muted">
                  Like Venmo. It {sent ? 'goes into' : 'comes out of'} Ready to Assign.
                </span>
              </Button>
              {unclear && (
                <Button
                  mutates="offline"
                  track="transfer.none"
                  onClick={async () => {
                    if (!(await tried(pick.mutateAsync({ otherKey: null })))) return;
                    setResult(lines(null));
                  }}
                  className="flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="text-base font-semibold">
                    {sent ? 'It was income' : 'It was a payment'}
                  </span>
                  <span className="text-xs text-muted">
                    {sent && !onCard
                      ? 'It goes to Ready to Assign'
                      : `Give it a category like other ${sent ? 'income' : 'spending'}`}
                  </span>
                </Button>
              )}
            </div>
            {pick.error && <ErrorNote error={pick.error} />}
          </>
        )}
      </div>
    </Sheet>
  );
}
