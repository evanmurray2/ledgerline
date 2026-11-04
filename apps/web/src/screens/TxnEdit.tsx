// Editing a transaction: pending with your estimate and tip shortcuts, posted (set by rule), income (Save for
// next month), card refund, upcoming / manual.
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { CategoryField } from '../components/CategoryPicker';
import {
  Banner,
  ConfirmInline,
  cx,
  DangerLink,
  ErrorNote,
  Field,
  inputClass,
  Label,
  PrimaryButton,
  Icon,
  Segmented,
  SoftButton,
  TextButton,
  textLinkClass,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { addMonths, dayLabel, monthName, monthShort } from '../lib/dates';
import { useCategoryOptions } from '../lib/common';
import { usage } from '../usage/tracker';
import { toast } from '../components/Toast';
import { AMOUNT_INPUT, BankSays, TxnHeader, useParentPath } from './TxnCommon';

type OwedMode = 'none' | 'half' | 'all' | 'custom';

function CategorySelect({
  value,
  onChange,
  id,
  allowRta,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
  allowRta?: boolean;
}) {
  const specials = [{ id: '', name: 'Needs a category' }];
  if (allowRta) specials.push({ id: 'rta', name: 'Ready to Assign' });
  return <CategoryField id={id} track="txn.category" value={value} onChange={onChange} specials={specials} />;
}

export function EditTxn({ t, close }: { t: TxnSheet; close: () => void }) {
  const parent = useParentPath();
  const patch = useMoneyMutation((v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) =>
    api.patchTxn(v.key, v.body),
  );
  const del = useMoneyMutation(api.deleteTxn);
  const [cat, setCat] = useState(t.categoryId ?? (t.categoryLabel === 'Ready to Assign' ? 'rta' : ''));
  // Amounts are typed without a sign; the transaction's direction keeps it.
  const sign = (t.bankAmount ?? t.amount) < 0 ? -1 : 1;
  const [est, setEst] = useState(t.estimatedAmount !== null ? centsToInput(Math.abs(t.estimatedAmount)) : '');
  const [amt, setAmt] = useState(centsToInput(Math.abs(t.amount)));
  const [owed, setOwed] = useState<OwedMode>(t.owed.length ? 'half' : 'none');
  const [owedAmt, setOwedAmt] = useState(t.owed[0] ? centsToInput(t.owed[0].amount) : '');
  const [expectBy, setExpectBy] = useState(t.owed[0]?.expectBy ?? '');
  const [month, setMonth] = useState(t.budgetMonth);
  const [wont, setWont] = useState(t.wontClear);
  const [memo, setMemo] = useState(t.memo ?? '');
  const [linked, setLinked] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Owed to you, budget month and Won't clear are rarely changed: folded into one row unless one is set.
  const [more, setMore] = useState(t.owed.length > 0 || t.wontClear || t.budgetMonth !== t.date.slice(0, 7));

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
  const catName = useCategoryOptions().byId.get(cat) ?? 'The category';
  const months = [addMonths(t.date.slice(0, 7), -1), t.date.slice(0, 7), addMonths(t.date.slice(0, 7), 1)];
  const isIncome = t.kind === 'income';
  const isRefund = t.kind === 'refund';
  const outflow = t.amount < 0;

  const save = async () => {
    const body: Parameters<typeof api.patchTxn>[1] = {};
    const origCat = t.categoryId ?? (t.categoryLabel === 'Ready to Assign' ? 'rta' : '');
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
    if (
      (outflow && (owed !== 'none') !== hadOwed) ||
      (owed !== 'none' && owed !== (hadOwed ? 'half' : 'none'))
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
      header={<TxnHeader t={t} />}
      footer={
        <div className="flex flex-col gap-2">
          {patch.error && <ErrorNote error={patch.error} />}
          <PrimaryButton mutates="offline" track="txn.save" onClick={() => void save()}>
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
      {canSetAmount && (
        <label className="flex shrink-0 items-center justify-between gap-3 rounded-[14px] bg-page p-3 text-[14px] font-semibold text-ink-2">
          {t.amount < 0 ? 'Amount out' : 'Amount in'}
          <span className="w-[120px] shrink-0">
            <input
              inputMode="decimal"
              aria-label="Amount"
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              className={cx(AMOUNT_INPUT, 'text-right')}
            />
          </span>
        </label>
      )}
      {canEstimate && (
        <div className="flex shrink-0 flex-col gap-2 rounded-[14px] bg-page p-3">
          <div className="flex justify-between text-[14px]">
            <span className="text-muted">Bank amount</span>
            <span className="tnum font-bold">{formatCents(Math.abs(bank))}</span>
          </div>
          <label className="flex items-center justify-between gap-3 text-[14px] font-semibold text-ink-2">
            Your estimate
            <span className="w-[120px] shrink-0">
              <input
                inputMode="decimal"
                placeholder={centsToInput(Math.abs(bank))}
                value={est}
                onChange={(e) => setEst(e.target.value)}
                className={cx(AMOUNT_INPUT, 'text-right')}
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
          <span className="text-[12px] text-muted">
            When it posts, the bank amount replaces yours and you’ll see an alert if they differ.
          </span>
        </div>
      )}
      {isRefund && t.refundOf && (
        <div className="flex flex-col gap-1.5">
          <Label>Refund of</Label>
          {linked ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-line p-3">
              <span className="flex flex-col">
                <span className="text-[14px] font-semibold">{t.refundOf.label}</span>
                <span className="text-[12px] text-muted">
                  {t.categoryLabel} · {t.accountName}
                </span>
              </span>
              <SoftButton tone="outline" track="txn.refund.unlink" onClick={() => setLinked(false)}>
                Not this purchase
              </SoftButton>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-page p-3 text-[13px] text-muted">
              <span>Not linked. It still counts as {t.categoryLabel} money back.</span>
              <TextButton onClick={() => setLinked(true)} className="self-center">
                Link to {t.refundOf.label}
              </TextButton>
            </div>
          )}
        </div>
      )}
      {isIncome ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-line p-3">
          <span className="text-[15px] font-semibold">Goes to</span>
          <Segmented
            label="Goes to"
            track="txn.income.month"
            value={month === t.budgetMonth && !t.budgetMonthOverridden ? 'now' : 'next'}
            onChange={(v) => setMonth(v === 'now' ? t.date.slice(0, 7) : addMonths(t.date.slice(0, 7), 1))}
            options={[
              ['now', 'Ready to Assign now'],
              ['next', `Save for ${monthName(addMonths(t.date.slice(0, 7), 1))}`],
            ]}
          />
          <span className="text-[12px] text-muted">
            {month === t.date.slice(0, 7)
              ? `Adds ${formatCents(t.amount)} to Ready to Assign in ${monthName(month)}.`
              : `Holds it until ${monthName(month)} 1, so next month starts already funded.`}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex min-h-9 items-center justify-between">
            <label htmlFor="txn-cat" className="text-[13px] font-semibold text-ink-2">
              Category
            </label>
            {outflow && (
              <Link
                to={`${parent}/txn/${encodeURIComponent(t.key)}/split`}
                data-track="txn.split"
                className={cx(textLinkClass, 'self-center')}
              >
                Split into categories
              </Link>
            )}
          </div>
          {t.split ? (
            <Link
              to={`${parent}/txn/${encodeURIComponent(t.key)}/split`}
              className="flex min-h-11 items-center rounded-[10px] border border-line-strong px-3 text-[15px] text-ink no-underline"
            >
              {t.categoryLabel ?? 'Split'}
            </Link>
          ) : (
            <CategorySelect id="txn-cat" value={cat} onChange={setCat} allowRta={isRefund || t.amount > 0} />
          )}
          {t.categorizedBy && (
            <span className="text-[12px] text-muted">
              {cat === (t.categoryId ?? '')
                ? `Set by ${t.categorizedBy}.`
                : `Set by you. ${t.categorizedBy.replace(/^r/, 'R')} won’t change it back.`}
            </span>
          )}
        </div>
      )}
      {isRefund && (
        <p className="m-0 text-[13px] leading-snug text-muted">
          The {formatCents(t.amount)} goes back to {catName}, the category that paid for it. On a card it also
          lowers what you owe, so the card’s payment category needs {formatCents(t.amount)} less.
        </p>
      )}
      {isIncome && (
        <Link
          to="/owed"
          data-track="txn.income.match"
          className="flex min-h-12 shrink-0 items-center justify-between gap-3 rounded-[14px] border border-line px-3 text-ink no-underline"
        >
          <span className="text-[14px]">Part of this is money back for something you fronted?</span>
          <span className="flex shrink-0 items-center text-[14px] font-bold text-accent">
            Match
            <Icon name="chevR" size={18} />
          </span>
        </Link>
      )}
      {outflow && !isIncome && !more && (
        <button
          type="button"
          data-track="txn.more"
          aria-expanded={false}
          onClick={() => setMore(true)}
          className="flex min-h-14 shrink-0 items-center justify-between gap-3 rounded-[14px] border border-line px-3 py-2 text-left"
        >
          <span className="flex flex-col gap-px">
            <span className="text-[15px] font-semibold">More</span>
            <span className="text-[12px] text-muted">
              Owed to you, budget month{t.status === 'pending' ? ', won’t clear' : ''}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[14px] text-muted">
            Not owed · {monthShort(month)}
            <Icon name="chevD" size={18} />
          </span>
        </button>
      )}
      {outflow && !isIncome && more && (
        <div className="shrink-0 overflow-hidden rounded-[14px] border border-line">
          <div className="flex flex-col gap-2 p-3">
            <span className="flex flex-col gap-px text-[15px] font-semibold">
              Owed to you
              <span className="text-[12px] font-normal text-muted">Part you’ll get back from someone</span>
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
                  <Field label="Amount owed" className="flex-1 text-[12px]">
                    <input
                      className={AMOUNT_INPUT}
                      inputMode="decimal"
                      value={owed === 'custom' ? owedAmt : centsToInput(owedCents)}
                      readOnly={owed !== 'custom'}
                      onChange={(e) => setOwedAmt(e.target.value)}
                    />
                  </Field>
                  <Field label="Expect by" className="flex-1 text-[12px]">
                    <input
                      type="date"
                      className={inputClass}
                      value={expectBy}
                      onChange={(e) => setExpectBy(e.target.value)}
                    />
                  </Field>
                </div>
                <span className="text-[12px] leading-snug text-muted">
                  {catName} is charged only your share. The rest comes out of Ready to Assign until it’s paid
                  back
                  {t.accountName.match(/Sapphire|Freedom|card/i)
                    ? `, and still covers the ${t.accountName.split(' ')[0]} payment`
                    : ''}
                  . Half stays half if the amount changes when it posts.
                </span>
              </>
            )}
          </div>
          <div className="flex min-h-14 items-center justify-between border-t border-divider px-3 text-[15px] font-semibold">
            <span className="flex flex-col gap-px">
              Counts in<span className="text-[12px] font-normal text-muted">Budget month</span>
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
                    'hit h-9 rounded-lg border px-2.5 text-[13px] font-bold',
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
            <label className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 text-[15px] font-semibold">
              <span className="flex flex-col gap-px">
                Won’t clear
                <span className="text-[12px] font-normal text-muted">
                  {owed !== 'none' ? 'Turning this on removes what’s owed' : 'Stop counting this hold'}
                </span>
              </span>
              <input
                type="checkbox"
                className="hit h-6 w-6 accent-[var(--ll-accent)]"
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
          placeholder="Add a note"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </Field>
      <BankSays
        t={t}
        extra={
          t.status === 'posted' && t.kind === 'posted' && t.postedDate
            ? `Posted ${dayLabel(t.postedDate)}`
            : t.categorizedBy && isIncome
              ? `Set by ${t.categorizedBy}`
              : undefined
        }
      />
      {(t.kind === 'manual' || t.kind === 'upcoming') &&
        (confirmDelete ? (
          <ConfirmInline
            label={`Delete ${t.payee}`}
            confirmLabel="Delete"
            track="txn.delete"
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
          <DangerLink mutates onClick={() => setConfirmDelete(true)}>
            Delete…
          </DangerLink>
        ))}
    </Sheet>
  );
}
