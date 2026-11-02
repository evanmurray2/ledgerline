// Transaction sheet and its variants: pending with your estimate and tip shortcuts, posted (set by rule),
// income (Save for next month), card refund, paid back with Unlink, paired transfer, upcoming / manual.
// Also Split and Rename payee.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn, usePayees, qk } from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { CategoryField } from '../components/CategoryPicker';
import {
  Button,
  cx,
  ErrorNote,
  Field,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  SecondaryButton,
  Icon,
  Segmented,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { addMonths, dayLabel, monthName, monthShort } from '../lib/dates';
import { useCategoryOptions, useScreen } from '../lib/common';
import { usage } from '../usage/tracker';
import { toast } from '../components/Toast';

/** Path of the screen under a sheet: /activity/txn/x → /activity, /accounts/chk/txn/x/split → /accounts/chk. */
export function useParentPath(): string {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return path.replace(/\/(txn|transfer|match|check|close|add)(\/.*)?$/, '') || '/activity';
}

function useClose() {
  const navigate = useNavigate();
  const parent = useParentPath();
  return () => void navigate({ to: parent });
}

const TAG: Record<TxnSheet['kind'], string> = {
  pending: 'Pending',
  posted: 'Posted',
  income: 'Income · posted',
  refund: 'Refund · posted',
  paidBack: 'Paid back',
  transfer: 'Transfer',
  manual: 'Added by you',
  upcoming: 'Upcoming',
};

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

function Header({ t }: { t: TxnSheet }) {
  const est = t.kind === 'pending' && t.estimatedAmount !== null;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cx(
          'text-[13px] font-bold',
          est ? 'text-info-fg' : t.kind === 'paidBack' ? 'text-owed-fg' : 'text-muted',
        )}
      >
        {est ? 'Pending · your estimate' : t.wontClear ? 'Pending · won’t clear' : TAG[t.kind]}
      </span>
      <h1 className={cx('tnum m-0 text-[28px] font-bold', t.amount > 0 && 'text-funded-fg')}>
        {t.kind === 'transfer' ? formatCents(Math.abs(t.amount)) : formatCents(t.amount, { plus: true })}
      </h1>
      <span className="text-[14px] text-muted">
        {t.payee} · {t.accountName} · {dayLabel(t.date)}
      </span>
    </div>
  );
}

function BankSays({ t, extra, ruleLink }: { t: TxnSheet; extra?: string; ruleLink?: boolean }) {
  const parent = useParentPath();
  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted">
      <span>Bank says: {t.rawName}</span>
      {extra && <span>{extra}</span>}
      <div className="flex gap-4">
        <Link
          to={`${parent}/txn/${encodeURIComponent(t.key)}/rename`}
          data-track="txn.rename"
          className="flex min-h-9 items-center font-bold no-underline"
        >
          Rename payee
        </Link>
        {ruleLink && t.categorizedBy?.startsWith('rule') && (
          <Link
            to="/settings/rules"
            data-track="txn.see_rule"
            className="flex min-h-9 items-center font-bold no-underline"
          >
            See {t.categorizedBy}
          </Link>
        )}
      </div>
    </div>
  );
}

export function TxnSheetScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  const q = useTxn(key);
  const close = useClose();
  const t = q.data;
  useScreen(t ? `txn.${t.kind}` : 'txn');
  if (!t)
    return (
      <Sheet label="Transaction" track="txn" onClose={close} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  if (t.kind === 'transfer') return <PairedTransfer t={t} close={close} />;
  if (t.kind === 'paidBack') return <PaidBack t={t} close={close} />;
  return <EditTxn t={t} close={close} />;
}

function EditTxn({ t, close }: { t: TxnSheet; close: () => void }) {
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
      header={<Header t={t} />}
      footer={
        <div className="flex flex-col gap-2">
          {patch.error && <ErrorNote error={patch.error} />}
          <PrimaryButton mutates track="txn.save" onClick={() => void save()}>
            Save
          </PrimaryButton>
        </div>
      }
    >
      {t.alerts.map((a) => (
        <p key={a} className="m-0 rounded-xl bg-under-bg px-3 py-2 text-[13px] text-under-fg">
          {a}
        </p>
      ))}
      {canSetAmount && (
        <label className="flex shrink-0 items-center justify-between gap-3 rounded-[14px] bg-page p-3 text-[14px] font-semibold text-ink-2">
          {t.amount < 0 ? 'Amount out' : 'Amount in'}
          <input
            inputMode="decimal"
            aria-label="Amount"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            className="tnum h-11 w-[120px] rounded-[10px] border border-line-strong bg-surface px-2.5 text-right text-[17px] font-bold text-ink"
          />
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
            <input
              inputMode="decimal"
              placeholder={centsToInput(Math.abs(bank))}
              value={est}
              onChange={(e) => setEst(e.target.value)}
              className="tnum h-11 w-[120px] rounded-[10px] border border-line-strong bg-surface px-2.5 text-right text-[17px] font-bold text-ink"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {tips.map((tip) => (
              <button
                key={tip.label}
                type="button"
                data-track="txn.tip"
                onClick={() => setEst(centsToInput(tip.cents))}
                className="hit h-9 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink-2"
              >
                {tip.label}
              </button>
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
              <button
                type="button"
                data-track="txn.refund.unlink"
                onClick={() => setLinked(false)}
                className="hit h-9 shrink-0 rounded-full border border-line-strong px-3 text-[13px] font-bold text-ink-2"
              >
                Not this purchase
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-page p-3 text-[13px] text-muted">
              <span>Not linked. It still counts as {t.categoryLabel} money back.</span>
              <button
                type="button"
                onClick={() => setLinked(true)}
                className="hit h-9 shrink-0 text-[13px] font-bold text-accent"
              >
                Link to {t.refundOf.label}
              </button>
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
          <div className="flex h-6 items-center justify-between">
            <label htmlFor="txn-cat" className="text-[13px] font-semibold text-ink-2">
              Category
            </label>
            {outflow && (
              <Link
                to={`${parent}/txn/${encodeURIComponent(t.key)}/split`}
                data-track="txn.split"
                className="hit flex h-6 items-center text-[13px] font-bold text-accent no-underline"
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
            <Icon name="chevR" size={16} />
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
                      className={cx(inputClass, 'tnum')}
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
        ruleLink
        extra={
          t.status === 'posted' && t.kind === 'posted' && t.postedDate
            ? `Posted ${dayLabel(t.postedDate)}`
            : t.categorizedBy && isIncome
              ? `Set by ${t.categorizedBy}`
              : undefined
        }
      />
      {(t.kind === 'manual' || t.kind === 'upcoming') && (
        <Button
          mutates
          track="txn.delete"
          onClick={async () => {
            await del.mutateAsync(t.key);
            toast.show({ text: `${t.payee} deleted` });
            close();
          }}
          className="min-h-9 self-start text-[14px] font-bold text-over-fg"
        >
          Delete
        </Button>
      )}
    </Sheet>
  );
}

function PaidBack({ t, close }: { t: TxnSheet; close: () => void }) {
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

function PairedTransfer({ t, close }: { t: TxnSheet; close: () => void }) {
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

// ------------------------------------------------------------------ split

interface Line {
  id: number;
  categoryId: string;
  input: string;
}

export function SplitScreen() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('txn.split');
  const q = useTxn(key);
  const navigate = useNavigate();
  const parent = useParentPath();
  const back = () => void navigate({ to: `${parent}/txn/${encodeURIComponent(key)}` });
  const patch = useMoneyMutation((v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) =>
    api.patchTxn(v.key, v.body),
  );
  const { groups } = useCategoryOptions();
  const t = q.data;
  const [lines, setLines] = useState<Line[] | null>(null);
  const [rem, setRem] = useState(0);
  const [next, setNext] = useState(3);

  useEffect(() => {
    if (!t || lines) return;
    const total = Math.abs(t.amount);
    if (t.split && t.split.length) {
      setLines(
        t.split.map((s, i) => ({
          id: i + 1,
          categoryId: s.categoryId ?? '',
          input: centsToInput(Math.abs(s.amount)),
        })),
      );
      setRem(t.split.findIndex((s) => s.absorbsRemainder) + 1 || t.split.length);
      setNext(t.split.length + 1);
    } else {
      setLines([
        { id: 1, categoryId: t.categoryId ?? '', input: centsToInput(total) },
        { id: 2, categoryId: '', input: '0.00' },
      ]);
      setRem(2);
    }
  }, [t, lines]);

  const total = t ? Math.abs(t.amount) : 0;
  const others = (lines ?? [])
    .filter((l) => l.id !== rem)
    .reduce((s, l) => s + (parseCents(l.input) ?? 0), 0);
  const remCents = total - others;
  const amountOf = (l: Line) => (l.id === rem ? remCents : (parseCents(l.input) ?? 0));
  const unchosen = (lines ?? []).some((l) => !l.categoryId);
  const neg = remCents < 0;
  const ok = !!lines && !neg && !unchosen;
  const opts = useMemo(() => groups, [groups]);

  if (!t || !lines)
    return (
      <Sheet label="Split" track="split" onClose={back} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const upd = (id: number, p: Partial<Line>) =>
    setLines(lines.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const sign = t.amount < 0 ? -1 : 1;
  const save = async () => {
    await patch.mutateAsync({
      key: t.key,
      body: {
        split: lines.map((l) => ({
          categoryId: l.categoryId === 'owed' ? null : l.categoryId,
          amount: sign * amountOf(l),
          memo: l.categoryId === 'owed' ? 'Owed to you' : null,
          absorbsRemainder: l.id === rem,
        })),
      },
    });
    usage.record('task', 'split');
    void navigate({ to: parent });
  };
  return (
    <Sheet
      label="Split"
      track="split"
      onClose={back}
      gap="small"
      closeLabel="Back to transaction"
      header={
        <div className="flex flex-col">
          <h1 className="m-0 text-[19px] font-bold">Split {formatCents(t.amount)}</h1>
          <span className="text-[13px] text-muted">
            {t.payee} · {t.accountName} · {dayLabel(t.date)}
          </span>
        </div>
      }
      footer={
        <PrimaryButton mutates track="split.save" disabled={!ok} onClick={() => void save()}>
          {ok ? 'Save split' : neg ? 'Lines are over the total' : 'Choose a category for every line'}
        </PrimaryButton>
      }
    >
      {lines.map((l, i) => (
        <div key={l.id} className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line p-3">
          <div className="flex gap-2">
            <Field label="Category" className="flex-[3] text-[12px]">
              <CategoryField
                ariaLabel={`Category for line ${i + 1}`}
                track="split.category"
                value={l.categoryId}
                onChange={(v) => upd(l.id, { categoryId: v })}
                groups={opts.map((g) => ({ key: g.id, name: g.name, categories: g.categories }))}
                specials={[{ id: 'owed', name: 'Owed to you' }]}
              />
            </Field>
            <Field label="Amount" className="flex-[2] text-[12px]">
              <input
                aria-label={`Amount for line ${i + 1}`}
                inputMode="decimal"
                className={cx(
                  inputClass,
                  'tnum',
                  l.id === rem && 'bg-sunken',
                  l.id === rem && neg && 'border-over-fg',
                )}
                value={l.id === rem ? centsToInput(remCents) : l.input}
                readOnly={l.id === rem}
                onChange={(e) => upd(l.id, { input: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <input
                type="radio"
                name="rem"
                className="hit h-5 w-5 accent-[var(--ll-accent)]"
                checked={rem === l.id}
                onChange={() => setRem(l.id)}
              />
              Takes any difference
            </label>
            {lines.length > 2 && (
              <button
                type="button"
                aria-label={`Remove line ${i + 1}`}
                onClick={() => {
                  const rest = lines.filter((x) => x.id !== l.id);
                  setLines(rest);
                  if (rem === l.id) setRem(rest[rest.length - 1]!.id);
                }}
                className="hit h-9 text-[13px] font-bold text-over-fg"
              >
                Remove
              </button>
            )}
          </div>
          {l.categoryId === 'owed' && (
            <span className="text-[12px] text-owed-fg">This line is owed to you.</span>
          )}
          {rem === l.id && (
            <span className="text-[12px] text-muted">
              Fills in automatically with whatever the other lines leave.
            </span>
          )}
        </div>
      ))}
      <button
        type="button"
        data-track="split.add_line"
        onClick={() => {
          setLines([...lines, { id: next, categoryId: '', input: '0.00' }]);
          setNext(next + 1);
        }}
        className="h-11 self-start text-[14px] font-bold text-accent"
      >
        + Add a line
      </button>
      <div
        className={cx(
          'flex justify-between rounded-xl px-3 py-2.5 text-[14px] font-semibold',
          neg ? 'bg-over-bg text-over-fg' : 'bg-success-soft text-funded-fg',
        )}
      >
        <span>{neg ? 'Lines are more than the total by' : 'Lines add up to the total'}</span>
        <span className="tnum">{neg ? formatCents(-remCents) : formatCents(total)}</span>
      </div>
      {patch.error && <ErrorNote error={patch.error} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ rename payee (from a transaction)

export function RenamePayeeFromTxn() {
  const { key } = useParams({ strict: false }) as { key: string };
  useScreen('payee.rename');
  const q = useTxn(key);
  const payees = usePayees();
  const navigate = useNavigate();
  const parent = useParentPath();
  const back = () => void navigate({ to: `${parent}/txn/${encodeURIComponent(key)}` });
  const patch = useMoneyMutation(
    (v: { key: string; body: Parameters<typeof api.patchTxn>[1] }) => api.patchTxn(v.key, v.body),
    { invalidate: [qk.payees] },
  );
  const rename = useMoneyMutation(
    (v: { id: string; name: string }) => api.renamePayee(v.id, { name: v.name, remember: true }),
    { invalidate: [qk.payees] },
  );
  const [name, setName] = useState<string | null>(null);
  const t = q.data;
  if (!t)
    return (
      <Sheet label="Rename payee" track="payee.rename" onClose={back} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const value = name ?? t.payee;
  const payee = payees.data?.payees.find((p) => p.name === t.payee);
  const save = async () => {
    if (payee) await rename.mutateAsync({ id: payee.id, name: value.trim() });
    else await patch.mutateAsync({ key: t.key, body: { payeeName: value.trim() } });
    back();
  };
  return (
    <Sheet
      label="Rename payee"
      track="payee.rename"
      onClose={back}
      gap="auto"
      header={<h1 className="m-0 text-[20px] font-bold">Rename payee</h1>}
    >
      <div className="flex flex-col gap-3 pb-4">
        <Field label="Show as">
          <input className={inputClass} value={value} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1.5">
          <Label>Bank names that become this payee</Label>
          <div className="flex items-center justify-between rounded-xl border border-line px-3 py-2.5 text-[14px]">
            <span className="font-semibold">{t.rawName}</span>
            <span className="text-[12px] text-muted">
              {payee ? `${payee.transactions} transactions` : 'this transaction'}
            </span>
          </div>
        </div>
        <p className="m-0 text-[12px] leading-snug text-muted">
          Applies to past and future transactions. Rules follow the new name. The bank’s description stays on
          each transaction.
        </p>
        {(patch.error || rename.error) && <ErrorNote error={patch.error ?? rename.error} />}
        <PrimaryButton mutates track="payee.rename.save" disabled={!value.trim()} onClick={() => void save()}>
          Save
        </PrimaryButton>
        <SecondaryButton onClick={back}>Cancel</SecondaryButton>
      </div>
    </Sheet>
  );
}
