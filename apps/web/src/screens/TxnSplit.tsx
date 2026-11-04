// Split a transaction into categories; one line takes any difference.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { CategoryField } from '../components/CategoryPicker';
import {
  Banner,
  cx,
  DangerLink,
  ErrorNote,
  Field,
  Icon,
  Loading,
  PrimaryButton,
  TextButton,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useCategoryOptions, useScreen } from '../lib/common';
import { usage } from '../usage/tracker';
import { AMOUNT_INPUT, useParentPath } from './TxnCommon';

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
        <SheetTitle
          title={`Split ${formatCents(t.amount)}`}
          sub={`${t.payee} · ${t.accountName} · ${dayLabel(t.date)}`}
        />
      }
      footer={
        <PrimaryButton
          mutates
          track="split.save"
          disabled={!ok}
          why={
            unchosen
              ? 'Choose a category for each line'
              : neg
                ? 'The lines add up to more than the total'
                : ''
          }
          onClick={() => void save()}
        >
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
                  AMOUNT_INPUT,
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
              <DangerLink
                aria-label={`Remove line ${i + 1}`}
                onClick={() => {
                  const rest = lines.filter((x) => x.id !== l.id);
                  setLines(rest);
                  if (rem === l.id) setRem(rest[rest.length - 1]!.id);
                }}
                className="self-center"
              >
                Remove
              </DangerLink>
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
      <TextButton
        track="split.add_line"
        onClick={() => {
          setLines([...lines, { id: next, categoryId: '', input: '0.00' }]);
          setNext(next + 1);
        }}
        className="min-h-11"
      >
        <Icon name="plus" size={16} stroke={2.4} />
        Add line
      </TextButton>
      <Banner
        tone={neg ? 'danger' : 'success'}
        title={neg ? 'Lines are more than the total by' : 'Lines add up to the total'}
        action={
          <span className="tnum text-[14px] font-bold">
            {neg ? formatCents(-remCents) : formatCents(total)}
          </span>
        }
      />
      {patch.error && <ErrorNote error={patch.error} />}
    </Sheet>
  );
}
