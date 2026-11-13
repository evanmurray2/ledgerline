// Split a transaction into categories; one line takes any difference.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { api } from '../api/endpoints';
import { useMoneyMutation, useTxn } from '../api/hooks';
import { Sheet, SheetTitle } from '../components/Sheet';
import { CategoryField } from '../components/CategoryPicker';
import {
  amountInputClass,
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
import { useClose, useParentPath } from './TxnCommon';

const OWED = 'Owed to you';

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
  const back = () => void navigate({ to: `${parent}/txn/${encodeURIComponent(key)}`, search: true });
  // Saved: the sheet is done, so back to where it was opened (the list under it, or another tab).
  const done = useClose();
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
          // A line owed to you; an older save marked it only by its memo (and made no owed item).
          categoryId: s.owed || (!s.categoryId && s.memo === OWED) ? 'owed' : (s.categoryId ?? ''),
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
  // A line typed as something that isn't an amount (or below zero) would be saved as $0.00 without a word.
  const badAmount = (lines ?? []).some((l) => l.id !== rem && (parseCents(l.input) ?? -1) < 0);
  const neg = remCents < 0;
  const ok = !!lines && !neg && !unchosen && !badAmount;
  const opts = useMemo(() => groups, [groups]);

  if (!t || !lines)
    return (
      <Sheet label="Split" track="split" onClose={back} gap="small">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  // Only money going out is split here (the sheet offers Split only then); a link to a deposit says so.
  if (t.amount >= 0 && !t.split?.length)
    return (
      <Sheet label="Split" track="split" onClose={back} gap="small">
        <Banner tone="neutral">Only money going out can be split.</Banner>
      </Sheet>
    );
  const upd = (id: number, p: Partial<Line>) =>
    setLines(lines.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const sign = t.amount < 0 ? -1 : 1;
  const save = async () => {
    // A line owed to you makes an owed item of its amount on the server. A refusal shows below (patch.error).
    const ok = await patch
      .mutateAsync({
        key: t.key,
        body: {
          split: lines.map((l) => ({
            categoryId: l.categoryId === 'owed' ? null : l.categoryId,
            amount: sign * amountOf(l),
            memo: null,
            absorbsRemainder: l.id === rem,
            ...(l.categoryId === 'owed' ? { owed: true } : {}),
          })),
        },
      })
      .then(
        () => true,
        () => false,
      );
    if (!ok) return;
    usage.record('task', 'split');
    done();
  };
  /** Another line takes the difference: every line keeps the amount it shows now. */
  const moveRem = (id: number) => {
    setLines(lines.map((x) => ({ ...x, input: centsToInput(amountOf(x)) })));
    setRem(id);
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
          title={`Split ${formatCents(Math.abs(t.amount))}`}
          sub={`${t.payee} · ${t.accountName} · ${dayLabel(t.date)}`}
        />
      }
      footer={
        <PrimaryButton
          mutates="offline"
          track="split.save"
          disabled={!ok}
          why={
            unchosen
              ? 'Choose a category for every line'
              : badAmount
                ? 'Enter an amount for every line'
                : neg
                  ? 'Lines are over the total'
                  : ''
          }
          onClick={() => void save()}
        >
          Save split
        </PrimaryButton>
      }
    >
      {lines.map((l, i) => (
        <div key={l.id} className="flex shrink-0 flex-col gap-2 rounded-lg border border-line p-3">
          <div className="flex gap-2">
            <Field label="Category" className="flex-[3] text-xs">
              <CategoryField
                ariaLabel={`Category for line ${i + 1}`}
                track="split.category"
                value={l.categoryId}
                onChange={(v) => upd(l.id, { categoryId: v })}
                groups={opts.map((g) => ({ key: g.id, name: g.name, categories: g.categories }))}
                specials={t.amount < 0 ? [{ id: 'owed', name: OWED }] : []}
              />
            </Field>
            <Field label="Amount" className="flex-[2] text-xs">
              <input
                aria-label={`Amount for line ${i + 1}`}
                inputMode="decimal"
                className={cx(
                  amountInputClass,
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
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="radio"
                name="rem"
                className="hit h-5 w-5 accent-accent"
                checked={rem === l.id}
                onChange={() => moveRem(l.id)}
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
        title={neg ? 'Lines are over the total by' : 'Lines add up to the total'}
        action={
          <span className="tnum text-md font-bold">{neg ? formatCents(-remCents) : formatCents(total)}</span>
        }
      />
      {patch.error && <ErrorNote error={patch.error} />}
    </Sheet>
  );
}
