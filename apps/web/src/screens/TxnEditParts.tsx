// Parts of the transaction sheet (TxnEdit.tsx): the category field, your own entry's amount and direction, and where
// income in Ready to Assign goes (this month or the next).
import { CategoryField } from '../components/CategoryPicker';
import { amountInputClass, Field, Segmented } from '../components/ui';
import { formatCents } from '../lib/money';
import { addMonths, monthName } from '../lib/dates';

export function CategorySelect({
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
  const dated = date.slice(0, 7);
  // One test for the toggle and its help line: a month after the one it's dated in is saved for later. Income moved
  // further on (or back) says so on both: the toggle names that month.
  const later = month > dated;
  const saveFor = later ? month : addMonths(dated, 1);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <span className="text-base font-semibold">Goes to</span>
      <Segmented
        label="Goes to"
        track="txn.income.month"
        value={later ? 'next' : 'now'}
        onChange={(v) => onMonth(v === 'now' ? dated : saveFor)}
        options={[
          ['now', 'Ready to Assign now'],
          ['next', `Save for ${monthName(saveFor)}`],
        ]}
      />
      <span className="text-xs text-muted">
        {later
          ? `Adds ${formatCents(amount)} to Ready to Assign on ${monthName(month)} 1.`
          : `Adds ${formatCents(amount)} to Ready to Assign in ${monthName(month)}.`}
      </span>
    </div>
  );
}
