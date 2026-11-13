// Transfer: pick the other side. Split from ActivitySheets.tsx.
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueries } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation, useTxn, qk } from '../api/hooks';
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
  const registers = useQueries({
    queries: others.map((a) => ({
      queryKey: qk.register(a.id, 'all'),
      queryFn: () => api.register(a.id, 'all'),
      enabled: !!t,
    })),
  });
  if (!t)
    return (
      <Sheet label="Transfer" track="transfer" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  // The contract has no candidate list: find rows of the opposite amount within 5 days in the other accounts that
  // aren't a transfer already (the route accepts the same ones). From a deposit, the other side is an outflow.
  const sent = t.amount > 0;
  // Filing asked about this row. Any other row gets here from "It's a transfer…": it has no question to answer "no" to.
  const unclear = t.kind === 'transfer' && !t.otherAccountName;
  // Money into checking or savings you call income goes to Ready to Assign (D-85); a credit on a card needs a category.
  const onCard =
    (accounts.data?.groups ?? []).flatMap((g) => g.accounts).find((a) => a.id === t.accountId)?.kind ===
    'credit';
  const day = (d: string) =>
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
  const candidates = registers.flatMap((r, i) =>
    (r.data?.days ?? [])
      .flatMap((d) => d.rows)
      .filter(
        (row) =>
          row.amount === -t.amount &&
          Math.abs(day(row.date) - day(t.date)) <= 5 &&
          row.categoryLabel !== 'Transfer',
      )
      .map((row) => ({ row, account: others[i]! })),
  );
  const loadingCands = registers.some((r) => r.isLoading);
  const n = candidates.length;
  // Deposits still waiting for this answer ("Pick the account"): the ones not picked count as income.
  const waiting = sent ? 0 : candidates.filter((c) => c.row.sheet === 'transfer').length;
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
  const listed = new Set(candidates.map((c) => c.account.id));
  const notYet = others.filter((a) => !listed.has(a.id));
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
            <div className="flex gap-2">
              <SecondaryButton
                mutates="offline"
                track="transfer.undo"
                className="flex-1"
                onClick={async () => {
                  await unpair.mutateAsync(key);
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
            {!loadingCands && (
              <p className="m-0 text-sm leading-snug text-muted">
                {n === 0 ? 'No account' : n === 1 ? '1 account' : `${n} accounts`} {sent ? 'sent' : 'got'}{' '}
                {formatCents(Math.abs(t.amount))} within a few days.
              </p>
            )}
            {loadingCands && <Loading label="Looking for the other account" />}
            <div className="flex flex-col gap-2">
              {candidates.map(({ row, account }) => (
                <Button
                  key={row.key}
                  mutates="offline"
                  track="transfer.pick"
                  onClick={async () => {
                    await pick.mutateAsync({ otherKey: row.key });
                    usage.suggestion('transfer_pick', 'paired');
                    setResult(lines(account.name, row));
                  }}
                  className="flex min-h-14 w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-left"
                >
                  <span className="flex flex-col">
                    <span className="text-base font-semibold">{account.name}</span>
                    <span className="text-xs text-muted">
                      {dayLabel(row.date)} · “{row.payee}”
                    </span>
                  </span>
                  <span className={sent ? 'tnum font-bold' : 'tnum font-bold text-funded-fg'}>
                    {formatCents(row.amount, { plus: true })}
                  </span>
                </Button>
              ))}
              {notYet.length > 0 && !loadingCands && (
                <span className="pt-2 text-sm font-semibold text-muted">
                  {n === 0 ? 'Pick the account' : 'Or another account'}
                </span>
              )}
              {!loadingCands &&
                notYet.map((a) => (
                  <Button
                    key={a.id}
                    mutates="offline"
                    track="transfer.pick_pending"
                    onClick={async () => {
                      await pick.mutateAsync({ otherKey: null, accountId: a.id });
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
                  await pick.mutateAsync({ otherKey: null, unlinked: true });
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
                    await pick.mutateAsync({ otherKey: null });
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
