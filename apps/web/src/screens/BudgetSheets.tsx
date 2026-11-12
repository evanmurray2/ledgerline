// The Assign sheet. The category sheet is in CategorySheet.tsx.
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useAssignView, useMoneyMutation } from '../api/hooks';
import { CategoryField } from '../components/CategoryPicker';
import { Sheet, SheetTitle } from '../components/Sheet';
import {
  Card,
  Checkbox,
  cx,
  ErrorNote,
  Field,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  TextButton,
} from '../components/ui';
import { formatCents, parseCents } from '../lib/money';
import { monthName } from '../lib/dates';
import { useCategoryOptions, useScreen } from '../lib/common';
import { useBudgetMonth } from './Budget';
import { usage } from '../usage/tracker';
import { useCanWrite } from '../state/connectivity';

export function useCloseToBudget(month: string | undefined, current: string | undefined) {
  const navigate = useNavigate();
  return () => void navigate({ to: '/budget', search: { month: month === current ? undefined : month } });
}

// ------------------------------------------------------------------ assign sheet

export function AssignSheetScreen() {
  const { month, current } = useBudgetMonth();
  useScreen('assign');
  const q = useAssignView(month);
  const close = useCloseToBudget(month, current);
  const assign = useMoneyMutation(api.assign);
  const { groups } = useCategoryOptions();
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [catId, setCatId] = useState('');
  const [custom, setCustom] = useState('');
  const canWrite = useCanWrite({ offline: true });

  useEffect(() => {
    usage.startTask('assign');
    return () => usage.cancelTask('assign');
  }, []);

  const v = q.data;
  if (!v || !month) {
    return (
      <Sheet label="Assign money" track="assign" onClose={close} gap="large">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  }
  const defaultOn = (s: (typeof v.suggestions)[number]) => s.preselected;
  const isOn = (s: (typeof v.suggestions)[number]) =>
    off[s.categoryId] === undefined ? defaultOn(s) : !off[s.categoryId];
  const chosen = v.suggestions.filter(isOn);
  const customCents = parseCents(custom);
  const items = new Map<string, number>();
  for (const s of chosen) items.set(s.categoryId, (items.get(s.categoryId) ?? 0) + s.amount);
  if (catId && customCents) items.set(catId, (items.get(catId) ?? 0) + customCents);
  const sum = [...items.values()].reduce((a, x) => a + x, 0);
  const left = v.rta - sum;
  const apply = async () => {
    if (items.size === 0) return;
    await assign.mutateAsync({
      month,
      items: [...items].map(([categoryId, amount]) => ({ categoryId, amount })),
    });
    usage.endTask('assign');
    close();
  };
  return (
    <Sheet
      label="Assign money"
      track="assign"
      onClose={close}
      gap="large"
      header={
        <SheetTitle
          title={v.rta > 0 ? `Assign ${formatCents(v.rta)}` : 'Assign money'}
          sub={`Ready to Assign in ${monthName(month)}`}
        />
      }
      footer={
        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-md">
            <span className="text-muted">Left to assign after this</span>
            <span
              className={cx('tnum font-bold', left < 0 ? 'text-over-fg' : 'text-ink')}
              data-testid="assign-left"
            >
              {formatCents(left)}
            </span>
          </div>
          {left < 0 && (
            <p role="alert" className="m-0 text-sm leading-snug text-over-fg">
              That’s {formatCents(-left)} more than you have.
            </p>
          )}
          <PrimaryButton
            mutates="offline"
            track={left < 0 ? 'assign.anyway' : 'assign.apply'}
            danger={left < 0}
            disabled={items.size === 0 || !canWrite}
            why={items.size === 0 ? (catId ? 'Enter an amount to assign' : 'Pick a category to assign') : ''}
            onClick={() => void apply()}
          >
            {items.size === 0
              ? 'Assign'
              : left < 0
                ? 'Assign anyway'
                : sum >= 0
                  ? `Assign ${formatCents(sum)}`
                  : `Move ${formatCents(-sum)} back`}
          </PrimaryButton>
          {assign.error && <ErrorNote error={assign.error} />}
        </div>
      }
    >
      {v.suggestions.length > 0 && (
        <>
          <div className="flex min-h-9 items-center justify-between">
            <Label>Suggested</Label>
            {v.suggestions.length > 1 && (
              // Clearing or picking every suggestion one checkbox at a time took dozens of taps.
              <TextButton
                track={chosen.length > 0 ? 'assign.clear_all' : 'assign.select_all'}
                onClick={() => {
                  const clear = chosen.length > 0;
                  setOff(Object.fromEntries(v.suggestions.map((x) => [x.categoryId, clear])));
                }}
                className="self-auto px-1"
              >
                {chosen.length > 0 ? 'Clear all' : 'Select all'}
              </TextButton>
            )}
          </div>
          <Card>
            {v.suggestions.map((s) => (
              <label
                key={s.categoryId}
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-1.5 first:border-t-0"
              >
                <Checkbox
                  checked={isOn(s)}
                  data-track="assign.suggestion"
                  onChange={() => setOff((o) => ({ ...o, [s.categoryId]: isOn(s) }))}
                />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-base font-semibold">{s.name}</span>
                  <span className="text-xs text-muted">{s.detail}</span>
                </span>
                <span className="tnum text-base font-bold">{formatCents(s.amount)}</span>
              </label>
            ))}
          </Card>
        </>
      )}
      <Label>Or assign to any category</Label>
      <div className="flex gap-2">
        <Field label="Category" className="flex-[3] text-xs">
          <CategoryField
            track="assign.category"
            value={catId}
            onChange={setCatId}
            groups={groups.map((g) => ({ key: g.id, name: g.name, categories: g.categories }))}
          />
        </Field>
        <Field label="Amount" className="flex-[2] text-xs">
          <input
            className={cx(inputClass, 'tnum')}
            inputMode="decimal"
            placeholder="0.00"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}

/** Every category and its target on one list: tap one, save, and you're back here for the next. */
