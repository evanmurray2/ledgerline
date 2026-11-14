// Editing a transaction: pending with your estimate and tip shortcuts, posted (a row a rule set before D-60 keeps its chip), income (Save for
// next month), card refund, upcoming / manual.
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAccounts, useMoneyMutation, useSession } from '../api/hooks';
import { Sheet } from '../components/Sheet';
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
import { amountWhy } from '../lib/amount-check';
import { addMonths, dayLabel, monthShort } from '../lib/dates';
import { useCategoryOptions } from '../lib/common';
import { usage } from '../usage/tracker';
import { toast } from '../components/Toast';
import { Why } from '../components/Why';
import { BankSays, TxnHeader, useParentPath } from './TxnCommon';
import { PairedWith } from './TxnPair';
import { RefundOf } from './TxnRefund';
import { CategorySelect, EntryAmount, entryDateWhy, IncomeGoesTo } from './TxnEditParts';
import { useHere } from '../lib/back';

type OwedMode = 'none' | 'half' | 'all' | 'custom';

export function EditTxn({ t, close }: { t: TxnSheet; close: () => void }) {
  const parent = useParentPath();
  const here = useHere();
  const unlink = useMoneyMutation(api.unlink);
  /** What this money in already pays back (its own matches, not a purchase's paybacks). */
  const pays = t.paybacks.filter((p) => p.inflowKey === t.key);
  const paysTotal = pays.reduce((a, p) => a + p.amount, 0);
  const patch = useMoneyMutation((v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) =>
    api.patchTxn(v.key, v.body),
  );
  const del = useMoneyMutation(api.deleteTxn);
  const origCat = t.categoryId ?? (t.categoryLabel === 'Ready to Assign' ? 'rta' : '');
  const [cat, setCat] = useState(origCat);
  // Amounts are typed without a sign; the direction keeps it. Only a transaction you added can change direction.
  const [dir, setDir] = useState<'out' | 'in'>((t.bankAmount ?? t.amount) < 0 ? 'out' : 'in');
  const sign = dir === 'out' ? -1 : 1;
  const estWas = t.estimatedAmount !== null ? centsToInput(Math.abs(t.estimatedAmount)) : '';
  const amtWas = centsToInput(Math.abs(t.amount));
  const [est, setEst] = useState(estWas);
  const [amt, setAmt] = useState(amtWas);
  const [day, setDay] = useState(t.date);
  const today = useSession().data?.budget.today;
  const [owed, setOwed] = useState<OwedMode>(t.owed[0]?.share ?? 'none');
  const [owedAmt, setOwedAmt] = useState(t.owed[0] ? centsToInput(t.owed[0].amount) : '');
  const [expectBy, setExpectBy] = useState(t.owed[0]?.expectBy ?? '');
  const [month, setMonth] = useState(t.budgetMonth);
  const [wont, setWont] = useState(t.wontClear);
  const [memo, setMemo] = useState(t.memo ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Your estimate is rarely needed: one line until you ask for it, or open when one is set.
  const [estOpen, setEstOpen] = useState(t.estimatedAmount !== null);
  // Owed to you, budget month, Won't clear, transfer and the bank's name are rarely changed: behind More options,
  // open by itself when one of the first three is set, so nothing that changes the totals is hidden.
  const [moreOpen, setMoreOpen] = useState(
    t.owed.length > 0 || t.wontClear || t.budgetMonth !== t.date.slice(0, 7),
  );

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
  const amountBad = canSetAmount ? amountWhy(amt) || entryDateWhy(t, day, today) : '';
  /** Your estimate: empty goes back to the bank's amount; anything else must be an amount above $0.00. */
  const estBad = canEstimate && est.trim() !== '' ? amountWhy(est) : '';
  const tips =
    canEstimate && bank < 0
      ? [15, 18, 20]
          .map((p) => ({
            label: `+${p}%`,
            cents: Math.abs(Math.round((bank * (100 + p)) / 100)),
          }))
          .concat([{ label: `Bank ${formatCents(Math.abs(bank))}`, cents: Math.abs(bank) }])
      : [];
  const spendCents = Math.abs(estCents ?? t.amount);
  const owedCents =
    owed === 'half' ? Math.round(spendCents / 2) : owed === 'all' ? spendCents : (parseCents(owedAmt) ?? 0);
  /** More owed than the purchase: the server would save the purchase's amount instead, without a word. */
  const owedOver = sign < 0 && owed === 'custom' && owedCents > spendCents;
  /** A custom amount owed that isn't an amount. */
  const owedBad = sign < 0 && owed === 'custom' ? amountWhy(owedAmt) : '';
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
    if (canSetAmount && day !== t.date) body.date = day;
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
    // A refusal shows above Save (patch.error), not as an uncaught error.
    if (
      !(await patch.mutateAsync({ key: t.key, body }).then(
        () => true,
        () => false,
      ))
    )
      return;
    if (body.categoryId !== undefined || body.toRta) usage.endTask('categorize');
    close();
  };

  return (
    <Sheet
      label={`${t.payee} transaction`}
      track="txn"
      onClose={close}
      gap="auto"
      // Back asks before it drops an amount or estimate typed and not saved.
      unsaved={!patch.isPending && ((canSetAmount && amt !== amtWas) || (canEstimate && est !== estWas))}
      // Your own entry: the header follows the amount and Out / In as you change them.
      header={<TxnHeader t={t} amount={canSetAmount ? (amtCents ?? sign * Math.abs(t.amount)) : t.amount} />}
      footer={
        <div className="flex flex-col gap-2">
          {patch.error && <ErrorNote error={patch.error} />}
          <PrimaryButton
            mutates="offline"
            track="txn.save"
            disabled={!!amountBad || !!estBad || !!owedBad || owedOver}
            why={
              amountBad
                ? amountBad
                : estBad
                  ? estBad.replace('an amount', 'an estimate')
                  : owedBad
                    ? owedBad.replace('an amount', 'the amount owed')
                    : owedOver
                      ? `Enter at most ${formatCents(spendCents)} owed`
                      : ''
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
        <EntryAmount amount={amt} onAmount={setAmt} dir={dir} onDir={turn} date={day} onDate={setDay} />
      )}
      {canEstimate &&
        (estOpen ? (
          <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-line p-3">
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
                  tone={estTyped === tip.cents ? 'soft' : 'outline'}
                  track="txn.tip"
                  aria-pressed={estTyped === tip.cents}
                  onClick={() => setEst(centsToInput(tip.cents))}
                >
                  {tip.label}
                </SoftButton>
              ))}
            </div>
            <span className="text-xs text-muted">When it posts, the bank’s amount wins.</span>
          </div>
        ) : (
          <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 rounded-lg border border-line px-3">
            <span className="text-md text-ink-2">Pending amount can change</span>
            <button
              type="button"
              data-track="txn.estimate"
              onClick={() => setEstOpen(true)}
              className={cx(textLinkClass, 'self-center')}
            >
              Estimate…
            </button>
          </div>
        ))}
      {isRefund && <RefundOf t={t} category={cat} onCategory={setCat} />}
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
            // A deposit that looks like a transfer still waits for a category (D-119): it keeps the choice.
            noNeeds={!outflow && !onCard && origCat !== ''}
            // A category archived since: the list no longer holds it, but this transaction still has it.
            valueName={cat === origCat && !t.split ? t.categoryLabel : null}
          />
        )}
        {/* Only who else set it: your own choice needs no note. */}
        {t.categorizedBy && t.categorizedBy !== 'You' && (
          <span className="text-xs text-muted">
            {cat === origCat
              ? `Set by ${t.categorizedBy}.`
              : `Set by you. ${t.categorizedBy[0]!.toUpperCase()}${t.categorizedBy.slice(1)} won’t change it back.`}
          </span>
        )}
      </div>
      {/* Only money in Ready to Assign has a month to go to: income you gave a category doesn't. */}
      {isIncome && cat === 'rta' && (
        <IncomeGoesTo date={t.date} amount={t.amount} month={month} onMonth={setMonth} />
      )}
      {isRefund && (catName || onCard) && (
        <p className="m-0 text-sm leading-snug text-muted">
          {catName ? `The ${formatCents(t.amount)} goes back to ${catName}.` : ''}
          {catName && onCard ? ' ' : ''}
          {onCard ? `The card payment needs ${formatCents(t.amount)} less.` : ''}
        </p>
      )}
      {/* Any money in can pay back what's owed to you: a card credit too, unless it's linked as a refund, and money in
          you added, pending or not (not a scheduled one: it hasn't come yet). A match moves with your entry's key to the
          bank's row when it posts (D-64). */}
      {/* Money in you added that already pays back something says what (D-105), as the bank's money in does on its
          Paid back sheet. Unlink makes it owed again; Match stays while some of the money is left. */}
      {pays.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label>Pays back</Label>
          {pays.map((p) => (
            <Link
              key={p.itemId}
              to="/owed"
              search={{ back: here }}
              className="flex items-center justify-between gap-2 rounded-lg border border-line p-3 text-ink no-underline"
            >
              <span className="text-md font-semibold">{p.label}</span>
              <span className="tnum font-bold">{formatCents(p.amount)}</span>
            </Link>
          ))}
          <SoftButton
            mutates="offline"
            tone="outline"
            track="txn.manual.unlink"
            disabled={unlink.isPending}
            onClick={() => unlink.mutate(t.key)}
            className="self-start"
          >
            Unlink
          </SoftButton>
          {unlink.error && <ErrorNote error={unlink.error} />}
        </div>
      )}
      {(isIncome ||
        (isRefund && !t.refundOf) ||
        (t.kind === 'manual' && t.amount > 0 && !outflow && paysTotal < t.amount)) && (
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
      <Field label="Memo">
        <input
          className={inputClass}
          placeholder="Add a memo"
          maxLength={500}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </Field>
      <div className="shrink-0 overflow-hidden rounded-lg border border-line">
        <button
          type="button"
          data-track="txn.more"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(!moreOpen)}
          className="hit flex min-h-12 w-full items-center justify-between gap-2 px-3 text-left text-md text-ink"
        >
          More options
          <Icon name="chevD" size={18} className={cx('shrink-0 text-muted', moreOpen && 'rotate-180')} />
        </button>
        {moreOpen && (
          <div className="flex flex-col border-t border-divider">
            {outflow && !isIncome && (
              <div className="flex flex-col border-b border-divider">
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
                          {catName ?? 'The category'} pays only your share. The rest comes out of Ready to
                          Assign until it’s paid back.
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
            <div className="flex flex-col gap-2 p-3">
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
              <BankSays
                t={t}
                extra={
                  t.status === 'posted' && t.kind === 'posted' && t.postedDate
                    ? `Posted ${dayLabel(t.postedDate)}`
                    : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
      {(t.kind === 'manual' || t.kind === 'upcoming') &&
        (confirmDelete ? (
          <>
            {del.error && <ErrorNote error={del.error} />}
            <ConfirmInline
              label={`Delete ${t.payee}`}
              confirmLabel="Delete"
              track="txn.delete"
              mutates="offline"
              busy={del.isPending}
              onCancel={() => setConfirmDelete(false)}
              onConfirm={async () => {
                if (
                  !(await del.mutateAsync(t.key).then(
                    () => true,
                    () => false,
                  ))
                )
                  return;
                toast.show({ text: `${t.payee} deleted` });
                close();
              }}
            >
              Delete {t.payee}?
            </ConfirmInline>
          </>
        ) : (
          <DangerLink mutates="offline" onClick={() => setConfirmDelete(true)}>
            Delete…
          </DangerLink>
        ))}
    </Sheet>
  );
}
