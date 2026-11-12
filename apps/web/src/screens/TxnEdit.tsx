// Editing a transaction: pending with your estimate and tip shortcuts, posted (a row a rule set before D-60 keeps its chip), income (Save for
// next month), card refund, upcoming / manual.
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { CategoryField } from '../components/CategoryPicker';
import {
  amountInputClass,
  Banner,
  Checkbox,
  ConfirmInline,
  cx,
  DangerLink,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Label,
  PrimaryButton,
  Segmented,
  SoftButton,
  textLinkClass,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { addMonths, dayLabel, monthName, monthShort } from '../lib/dates';
import { useCategoryOptions } from '../lib/common';
import { usage } from '../usage/tracker';
import { toast } from '../components/Toast';
import { Why } from '../components/Why';
import { BankSays, TxnHeader, useParentPath } from './TxnCommon';
import { PairedWith } from './TxnPair';

type OwedMode = 'none' | 'half' | 'all' | 'custom';

function CategorySelect({
  value,
  onChange,
  id,
  allowRta,
  noNeeds,
  valueName,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
  allowRta?: boolean;
  /** Money into checking or savings that is in Ready to Assign with no category: "Needs a category" isn't a choice. */
  noNeeds?: boolean;
  valueName?: string | null;
}) {
  const specials = noNeeds ? [] : [{ id: '', name: 'Needs a category' }];
  if (allowRta) specials.push({ id: 'rta', name: 'Ready to Assign' });
  return (
    <CategoryField
      id={id}
      track="txn.category"
      value={value}
      onChange={onChange}
      specials={specials}
      valueName={valueName}
    />
  );
}

export function EditTxn({ t, close }: { t: TxnSheet; close: () => void }) {
  const parent = useParentPath();
  const patch = useMoneyMutation((v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) =>
    api.patchTxn(v.key, v.body),
  );
  const del = useMoneyMutation(api.deleteTxn);
  const origCat = t.categoryId ?? (t.categoryLabel === 'Ready to Assign' ? 'rta' : '');
  const [cat, setCat] = useState(origCat);
  // Amounts are typed without a sign; the direction keeps it. Only a transaction you added can change direction.
  const [dir, setDir] = useState<'out' | 'in'>((t.bankAmount ?? t.amount) < 0 ? 'out' : 'in');
  const sign = dir === 'out' ? -1 : 1;
  const [est, setEst] = useState(t.estimatedAmount !== null ? centsToInput(Math.abs(t.estimatedAmount)) : '');
  const [amt, setAmt] = useState(centsToInput(Math.abs(t.amount)));
  const [owed, setOwed] = useState<OwedMode>(t.owed[0]?.share ?? 'none');
  const [owedAmt, setOwedAmt] = useState(t.owed[0] ? centsToInput(t.owed[0].amount) : '');
  const [expectBy, setExpectBy] = useState(t.owed[0]?.expectBy ?? '');
  const [month, setMonth] = useState(t.budgetMonth);
  const [wont, setWont] = useState(t.wontClear);
  const [memo, setMemo] = useState(t.memo ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Owed to you, budget month and Won't clear are rarely changed: folded into one row unless one is set.

  useEffect(() => {
    usage.startTask('categorize');
    return () => usage.cancelTask('categorize');
  }, []);

  const estTyped = parseCents(est);
  const estCents = estTyped === null ? null : sign * Math.abs(estTyped);
  const amtTyped = parseCents(amt);
  const amtCents = amtTyped === null || amtTyped === 0 ? null : sign * Math.abs(amtTyped);
  const bank = t.bankAmount;
  /** A bank pending row: you can set your own amount (an estimate) until it posts. */
  const canEstimate = t.status === 'pending' && bank !== null;
  /** A transaction you added: its amount is yours to change. */
  const canSetAmount = t.kind === 'manual' || t.kind === 'upcoming';
  /** What's typed in the amount box isn't an amount: Save would drop it without a word. */
  const amountBad = canSetAmount && amtCents === null;
  const tips =
    canEstimate && bank < 0
      ? [15, 18, 20]
          .map((p) => ({
            label: `+${p}% · ${formatCents(Math.abs(Math.round((bank * (100 + p)) / 100)))}`,
            cents: Math.abs(Math.round((bank * (100 + p)) / 100)),
          }))
          .concat([{ label: `Bank ${formatCents(Math.abs(bank))}`, cents: Math.abs(bank) }])
      : [];
  const spendCents = Math.abs(estCents ?? t.amount);
  const owedCents =
    owed === 'half' ? Math.round(spendCents / 2) : owed === 'all' ? spendCents : (parseCents(owedAmt) ?? 0);
  /** More owed than the purchase: the server would save the purchase's amount instead, without a word. */
  const owedOver = sign < 0 && owed === 'custom' && owedCents > spendCents;
  const catName = useCategoryOptions().byId.get(cat) ?? null;
  const onCard =
    useAccounts()
      .data?.groups.flatMap((g) => g.accounts)
      .find((a) => a.id === t.accountId)?.kind === 'credit';
  const months = [addMonths(t.date.slice(0, 7), -1), t.date.slice(0, 7), addMonths(t.date.slice(0, 7), 1)];
  const isIncome = t.kind === 'income';
  const isRefund = t.kind === 'refund';
  const outflow = sign < 0;
  /** Out to In or back. Money in starts in Ready to Assign; money out can't be there, or be owed to you. */
  const turn = (d: 'out' | 'in') => {
    setDir(d);
    if (d === 'in') {
      if (!cat) setCat('rta');
      setOwed('none');
    } else if (cat === 'rta') setCat('');
  };

  const save = async () => {
    const body: Parameters<typeof api.patchTxn>[1] = {};
    if (cat !== origCat) {
      if (cat === 'rta') body.toRta = true;
      else body.categoryId = cat || null;
    }
    if (canEstimate) {
      // Back to the bank's amount: an empty box, or the bank amount itself.
      const next = estCents === null || estCents === bank ? null : estCents;
      if (next !== t.estimatedAmount) body.estimatedAmount = next;
    }
    if (canSetAmount && amtCents !== null && amtCents !== t.amount) body.amount = amtCents;
    if (memo !== (t.memo ?? '')) body.memo = memo || null;
    if (wont !== t.wontClear) body.wontClear = wont;
    if (month !== t.budgetMonth) body.budgetMonth = month;
    const hadOwed = t.owed.length > 0;
    // Turned to In: the server takes what's owed off with the direction.
    if (
      outflow &&
      ((owed !== 'none') !== hadOwed ||
        (owed !== 'none' &&
          (owed !== (t.owed[0]?.share ?? 'none') ||
            (owed === 'custom' && owedCents !== t.owed[0]?.amount) ||
            expectBy !== (t.owed[0]?.expectBy ?? ''))))
    ) {
      body.markOwed =
        owed === 'none'
          ? null
          : owed === 'custom'
            ? { mode: 'fixed', amount: owedCents, expectBy: expectBy || null }
            : { mode: owed, expectBy: expectBy || null };
    }
    if (Object.keys(body).length === 0) return close();
    await patch.mutateAsync({ key: t.key, body });
    if (body.categoryId !== undefined || body.toRta) usage.endTask('categorize');
    close();
  };

  return (
    <Sheet
      label={`${t.payee} transaction`}
      track="txn"
      onClose={close}
      gap="auto"
      // Your own entry: the header follows the amount and Out / In as you change them.
      header={<TxnHeader t={t} amount={canSetAmount ? (amtCents ?? sign * Math.abs(t.amount)) : t.amount} />}
      footer={
        <div className="flex flex-col gap-2">
          {patch.error && <ErrorNote error={patch.error} />}
          <PrimaryButton
            mutates="offline"
            track="txn.save"
            disabled={amountBad || owedOver}
            why={
              amountBad ? 'Enter an amount' : owedOver ? `Enter at most ${formatCents(spendCents)} owed` : ''
            }
            onClick={() => void save()}
          >
            Save
          </PrimaryButton>
        </div>
      }
    >
      {t.alerts.map((a) => (
        <Banner key={a} tone="warn" icon="alert">
          {a}
        </Banner>
      ))}
      <PairedWith t={t} close={close} />
      {canSetAmount && (
        <div className="flex shrink-0 items-end gap-2">
          <Field label="Amount" className="min-w-0 flex-1">
            <input
              inputMode="decimal"
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              className={amountInputClass}
            />
          </Field>
          <div className="w-[140px]">
            <Segmented
              label="Direction"
              track="txn.direction"
              value={dir}
              onChange={turn}
              options={[
                ['out', 'Out'],
                ['in', 'In'],
              ]}
            />
          </div>
        </div>
      )}
      {canEstimate && (
        <div className="flex shrink-0 flex-col gap-2 rounded-lg bg-page p-3">
          <div className="flex justify-between text-md">
            <span className="text-muted">Bank amount</span>
            <span className="tnum font-bold">{formatCents(Math.abs(bank))}</span>
          </div>
          <label className="flex items-center justify-between gap-3 text-md font-semibold text-ink-2">
            Your estimate
            <span className="w-[120px] shrink-0">
              <input
                inputMode="decimal"
                placeholder={centsToInput(Math.abs(bank))}
                value={est}
                onChange={(e) => setEst(e.target.value)}
                className={cx(amountInputClass, 'text-right')}
              />
            </span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {tips.map((tip) => (
              <SoftButton
                key={tip.label}
                tone="outline"
                track="txn.tip"
                onClick={() => setEst(centsToInput(tip.cents))}
              >
                {tip.label}
              </SoftButton>
            ))}
          </div>
          <span className="text-xs text-muted">
            When it posts, the bank’s amount wins. You’ll see an alert if they differ.
          </span>
        </div>
      )}
      {isRefund && t.refundOf && (
        <div className="flex flex-col gap-1.5">
          <Label>Refund of</Label>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
            <span className="flex flex-col">
              <span className="text-md font-semibold">{t.refundOf.label}</span>
              <span className="text-xs text-muted">
                {t.categoryLabel} · {t.accountName}
              </span>
            </span>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex min-h-9 items-center justify-between">
          <label htmlFor="txn-cat" className="text-sm font-semibold text-ink-2">
            Category
          </label>
          {outflow && t.amount < 0 && (
            <Link
              to={`${parent}/txn/${encodeURIComponent(t.key)}/split`}
              search
              data-track="txn.split"
              className={cx(textLinkClass, 'self-center')}
            >
              Split into categories
            </Link>
          )}
        </div>
        {t.split && t.amount < 0 === outflow ? (
          <Link
            to={`${parent}/txn/${encodeURIComponent(t.key)}/split`}
            search
            data-track="txn.split.open"
            className={cx(inputClass, 'flex items-center justify-between gap-2 no-underline')}
          >
            <span className="truncate">{t.categoryLabel ?? 'Split'}</span>
            <Icon name="chevR" size={18} className="shrink-0 text-muted" />
          </Link>
        ) : (
          <CategorySelect
            id="txn-cat"
            value={cat}
            onChange={setCat}
            allowRta={isRefund || !outflow}
            // A deposit that looks like a transfer still waits for a category (D-85): it keeps the choice.
            noNeeds={!outflow && !onCard && origCat !== ''}
            // A category archived since: the list no longer holds it, but this transaction still has it.
            valueName={cat === origCat && !t.split ? t.categoryLabel : null}
          />
        )}
        {/* Any bank row can be a transfer, also one whose name didn't look like one (it never asks by itself). */}
        {(t.kind === 'posted' || t.kind === 'pending' || t.kind === 'income' || t.kind === 'refund') &&
          t.categoryLabel !== 'Transfer' && (
            <Link
              to={`${parent}/transfer/${encodeURIComponent(t.key)}`}
              search
              data-track="txn.transfer"
              className={cx(textLinkClass, 'flex min-h-9 items-center self-start')}
            >
              It’s a transfer…
            </Link>
          )}
        {t.categorizedBy && (cat === origCat || t.categorizedBy !== 'You') && (
          <span className="text-xs text-muted">
            {cat === origCat
              ? `Set by ${t.categorizedBy === 'You' ? 'you' : t.categorizedBy}.`
              : `Set by you. ${t.categorizedBy} won’t change it back.`}
          </span>
        )}
      </div>
      {/* Only money in Ready to Assign has a month to go to: income you gave a category doesn't. */}
      {isIncome && cat === 'rta' && (
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <span className="text-base font-semibold">Goes to</span>
          <Segmented
            label="Goes to"
            track="txn.income.month"
            // The same test as the help line below: the month the income is dated in, or a later one.
            value={month === t.date.slice(0, 7) ? 'now' : 'next'}
            onChange={(v) => setMonth(v === 'now' ? t.date.slice(0, 7) : addMonths(t.date.slice(0, 7), 1))}
            options={[
              ['now', 'Ready to Assign now'],
              ['next', `Save for ${monthName(addMonths(t.date.slice(0, 7), 1))}`],
            ]}
          />
          <span className="text-xs text-muted">
            {month === t.date.slice(0, 7)
              ? `Adds ${formatCents(t.amount)} to Ready to Assign in ${monthName(month)}.`
              : `Adds ${formatCents(t.amount)} to Ready to Assign on ${monthName(month)} 1.`}
          </span>
        </div>
      )}
      {isRefund && (catName || onCard) && (
        <p className="m-0 text-sm leading-snug text-muted">
          {catName ? `The ${formatCents(t.amount)} goes back to ${catName}.` : ''}
          {catName && onCard ? ' ' : ''}
          {onCard ? `The card payment needs ${formatCents(t.amount)} less.` : ''}
        </p>
      )}
      {/* Any money in can pay back what's owed to you: a card credit too, unless it's linked as a refund. */}
      {(isIncome || (isRefund && !t.refundOf)) && (
        <Link
          to={`${parent}/match/${encodeURIComponent(t.key)}`}
          search
          data-track="txn.income.match"
          className="flex min-h-12 shrink-0 items-center justify-between gap-3 rounded-lg border border-line px-3 text-ink no-underline"
        >
          <span className="text-md">Money back for something owed to you?</span>
          <span className="flex shrink-0 items-center text-md font-bold text-accent">
            Match
            <Icon name="chevR" size={18} />
          </span>
        </Link>
      )}
      {/* Owed to you and the budget month change the totals, so they always show (no More to open). */}
      {outflow && !isIncome && (
        <div className="shrink-0 overflow-hidden rounded-lg border border-line">
          <div className="flex flex-col gap-2 p-3">
            <span className="flex flex-col gap-px text-base font-semibold">
              Owed to you
              <span className="text-xs font-normal text-muted">Part you’ll get back from someone</span>
            </span>
            <Segmented
              label="Owed to you"
              track="txn.owed"
              value={owed}
              onChange={(v) => {
                setOwed(v);
                if (v !== 'none') setWont(false);
              }}
              options={[
                ['none', 'None'],
                ['half', 'Half'],
                ['all', 'All'],
                ['custom', 'Custom'],
              ]}
            />
            {owed !== 'none' && (
              <>
                <div className="flex gap-2">
                  <Field label="Amount owed" className="flex-1 text-xs">
                    <input
                      className={amountInputClass}
                      inputMode="decimal"
                      value={owed === 'custom' ? owedAmt : centsToInput(owedCents)}
                      readOnly={owed !== 'custom'}
                      onChange={(e) => setOwedAmt(e.target.value)}
                    />
                  </Field>
                  <Field label="Expect by" className="flex-1 text-xs">
                    <input
                      type="date"
                      className={inputClass}
                      value={expectBy}
                      onChange={(e) => setExpectBy(e.target.value)}
                    />
                  </Field>
                </div>
                <span className="flex flex-col gap-1 text-xs leading-snug text-muted">
                  <span>
                    {catName ?? 'The category'} pays only your share. The rest comes out of Ready to Assign
                    until it’s paid back.
                  </span>
                  {(onCard || owed !== 'custom') && (
                    <Why>
                      {onCard ? 'The card payment still covers the full amount. ' : ''}
                      {owed === 'half'
                        ? 'It stays half if the amount changes when it posts.'
                        : owed === 'all'
                          ? 'It stays all of it if the amount changes when it posts.'
                          : ''}
                    </Why>
                  )}
                </span>
              </>
            )}
          </div>
          <div className="flex min-h-14 items-center justify-between border-t border-divider px-3 text-base font-semibold">
            <span className="flex flex-col gap-px">
              Counts in<span className="text-xs font-normal text-muted">Budget month</span>
            </span>
            <div role="group" aria-label="Counts in" className="flex gap-1">
              {months.map((m) => (
                <button
                  key={m}
                  type="button"
                  data-track="txn.month"
                  aria-pressed={month === m}
                  onClick={() => setMonth(m)}
                  className={cx(
                    'hit h-9 rounded-md border px-2.5 text-sm font-bold',
                    month === m
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line-strong bg-surface text-ink-2',
                  )}
                >
                  {monthShort(m)}
                </button>
              ))}
            </div>
          </div>
          {t.status === 'pending' && (
            <label className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 text-base font-semibold">
              <span className="flex flex-col gap-px">
                Won’t clear
                <span className="text-xs font-normal text-muted">
                  {owed !== 'none' ? 'Turning this on removes what’s owed' : 'Stop counting this hold'}
                </span>
              </span>
              <Checkbox
                checked={wont}
                data-track="txn.wont_clear"
                onChange={() => {
                  setWont(!wont);
                  if (!wont) setOwed('none');
                }}
              />
            </label>
          )}
        </div>
      )}
      <Field label="Memo">
        <input
          className={inputClass}
          placeholder="Add a memo"
          maxLength={500}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </Field>
      <BankSays
        t={t}
        extra={
          t.status === 'posted' && t.kind === 'posted' && t.postedDate
            ? `Posted ${dayLabel(t.postedDate)}`
            : undefined
        }
      />
      {(t.kind === 'manual' || t.kind === 'upcoming') &&
        (confirmDelete ? (
          <ConfirmInline
            label={`Delete ${t.payee}`}
            confirmLabel="Delete"
            track="txn.delete"
            mutates="offline"
            busy={del.isPending}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => {
              await del.mutateAsync(t.key);
              toast.show({ text: `${t.payee} deleted` });
              close();
            }}
          >
            Delete {t.payee}?
          </ConfirmInline>
        ) : (
          <DangerLink mutates="offline" onClick={() => setConfirmDelete(true)}>
            Delete…
          </DangerLink>
        ))}
    </Sheet>
  );
}
