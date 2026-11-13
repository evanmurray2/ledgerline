// Parts of the transaction sheet (TxnEdit.tsx): your own entry's amount and direction, and where income in Ready to
// Assign goes (this month or the next).
import { amountInputClass, Field, Segmented } from '../components/ui';
import { formatCents } from '../lib/money';
import { addMonths, monthName } from '../lib/dates';

/** A transaction you added: its amount, typed without a sign, and Out or In. */
export function EntryAmount({
  amount,
  onAmount,
  dir,
  onDir,
}: {
  amount: string;
  onAmount: (v: string) => void;
  dir: 'out' | 'in';
  onDir: (d: 'out' | 'in') => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-2">
      <Field label="Amount" className="min-w-0 flex-1">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          className={amountInputClass}
        />
      </Field>
      <div className="w-[140px]">
        <Segmented
          label="Direction"
          track="txn.direction"
          value={dir}
          onChange={onDir}
          options={[
            ['out', 'Out'],
            ['in', 'In'],
          ]}
        />
      </div>
    </div>
  );
}

/** Income in Ready to Assign: the month it's dated in, or saved for the next one. */
export function IncomeGoesTo({
  date,
  amount,
  month,
  onMonth,
}: {
  /** The income's date. */
  date: string;
  amount: number;
  /** The budget month it counts in now. */
  month: string;
  onMonth: (m: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <span className="text-base font-semibold">Goes to</span>
      <Segmented
        label="Goes to"
        track="txn.income.month"
        // The same test as the help line below: the month the income is dated in, or a later one.
        value={month === date.slice(0, 7) ? 'now' : 'next'}
        onChange={(v) => onMonth(v === 'now' ? date.slice(0, 7) : addMonths(date.slice(0, 7), 1))}
        options={[
          ['now', 'Ready to Assign now'],
          ['next', `Save for ${monthName(addMonths(date.slice(0, 7), 1))}`],
        ]}
      />
      <span className="text-xs text-muted">
        {month === date.slice(0, 7)
          ? `Adds ${formatCents(amount)} to Ready to Assign in ${monthName(month)}.`
          : `Adds ${formatCents(amount)} to Ready to Assign on ${monthName(month)} 1.`}
      </span>
    </div>
  );
}
