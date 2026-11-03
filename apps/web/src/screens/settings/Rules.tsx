// Settings → Rules: the list and the rule editor with live preview.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { type RuleBody } from '@ledgerline/contracts';
import { api } from '../../api/endpoints';
import { qk, useRules } from '../../api/hooks';
import { CategoryField } from '../../components/CategoryPicker';
import { toast } from '../../components/Toast';
import {
  Card,
  ConfirmInline,
  cx,
  DangerLink,
  EmptyNote,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Loading,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  Segmented,
  TextButton,
  Toggle,
  HeaderAction,
} from '../../components/ui';
import { formatCents, parseCents, centsToInput } from '../../lib/money';
import { dayLabel } from '../../lib/dates';
import { rowMeta, useScreen } from '../../lib/common';
import { useCanWrite } from '../../state/connectivity';
import { Page } from './common';

// ------------------------------------------------------------------ rules

export function RulesScreen() {
  useScreen('settings.rules');
  const q = useRules();
  const v = q.data;
  return (
    <Page
      title="Rules"
      back="/settings"
      right={<HeaderAction to="/settings/rules/new" track="rules.new" icon="plus" label="Add rule" />}
    >
      <p className="m-0 text-[13px] leading-snug text-muted">
        Rules run top to bottom on each new transaction; the first match wins. They never change a category
        you set yourself.
      </p>
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && (
        <Card>
          {v.rules.length === 0 && <EmptyNote inCard>No rules yet.</EmptyNote>}
          {v.rules.map((r, i) => {
            const [when, then] = r.summary.includes(' → ') ? r.summary.split(' → ') : [r.summary, ''];
            return (
              <Link
                key={r.id}
                to={`/settings/rules/${r.id}`}
                data-track="rules.open"
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sunken text-[12px] font-bold text-ink-2"
                >
                  {i + 1}
                </span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[14px] font-semibold">{when}</span>
                  {then && <span className="text-[13px] text-ink-2">→ {then}</span>}
                  <span className="text-[12px] text-muted">
                    {r.enabled
                      ? `Used ${r.matches90d} ${r.matches90d === 1 ? 'time' : 'times'} in 90 days`
                      : 'Turned off'}
                  </span>
                </span>
                <Icon name="chevR" size={18} className="text-faint" />
              </Link>
            );
          })}
        </Card>
      )}
      <span className="text-[12px] text-muted">
        To make a rule quickly, categorize a payee the same way twice; Activity will offer “Always”.
      </span>
    </Page>
  );
}

type CondField = 'payee' | 'description' | 'amount';
interface Cond {
  id: number;
  field: CondField;
  value: string;
  min: string;
  max: string;
}
type OwedOpt = 'none' | 'half' | 'all' | 'fixed';

function condsFromRule(r: RuleBody): Cond[] {
  let id = 0;
  const out: Cond[] = [];
  for (const c of r.conditions.all) {
    id += 1;
    if (c.field === 'payee' || c.field === 'description')
      out.push({ id, field: c.field, value: c.value, min: '', max: '' });
    else if (c.field === 'amount' && c.op === 'between')
      out.push({
        id,
        field: 'amount',
        value: '',
        min: centsToInput(Math.abs(c.max)),
        max: centsToInput(Math.abs(c.min)),
      });
  }
  const anyPayees = (r.conditions.any ?? []).flat().filter((c) => c.field === 'payee');
  if (anyPayees.length)
    out.unshift({
      id: 99,
      field: 'payee',
      value: anyPayees.map((c) => ('value' in c ? String(c.value) : '')).join(' or '),
      min: '',
      max: '',
    });
  return out.length ? out : [{ id: 1, field: 'payee', value: '', min: '', max: '' }];
}

export function RuleEditScreen() {
  const { ruleId } = useParams({ strict: false }) as { ruleId: string };
  const isNew = ruleId === 'new';
  useScreen(isNew ? 'settings.rule.new' : 'settings.rule.edit');
  const q = useRules();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const back = () => void navigate({ to: '/settings/rules' });
  const rule = q.data?.rules.find((r) => r.id === ruleId);
  const idx = q.data?.rules.findIndex((r) => r.id === ruleId) ?? -1;
  const [conds, setConds] = useState<Cond[] | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [owed, setOwed] = useState<OwedOpt>('none');
  const [owedFixed, setOwedFixed] = useState('');
  const [prev, setPrev] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    n: number;
    rows: { key: string; date: string; payee: string; amount: number; meta: string }[];
    uncategorized: number;
  } | null>(null);
  const canWrite = useCanWrite();

  useEffect(() => {
    if (conds || (!isNew && !rule)) return;
    if (!rule) {
      setConds([{ id: 1, field: 'payee', value: '', min: '', max: '' }]);
      return;
    }
    setConds(condsFromRule(rule));
    const sc = rule.actions.find((a) => a.type === 'set_category');
    setCat(sc && sc.type === 'set_category' ? sc.categoryId : '');
    const mo = rule.actions.find((a) => a.type === 'mark_owed');
    if (mo && mo.type === 'mark_owed') {
      if (mo.fixed) {
        setOwed('fixed');
        setOwedFixed(centsToInput(mo.fixed));
      } else setOwed(mo.num === mo.den ? 'all' : 'half');
    }
    setPrev(rule.actions.some((a) => a.type === 'previous_month_if_within_days'));
  }, [rule, isNew, conds]);

  const body = useMemo<RuleBody | null>(() => {
    if (!conds) return null;
    const all: RuleBody['conditions']['all'] = [];
    const any: RuleBody['conditions']['all'][] = [];
    for (const c of conds) {
      if (c.field === 'payee' && c.value.trim()) {
        const names = c.value
          .split(/\s+or\s+/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (names.length > 1)
          any.push(...names.map((n) => [{ field: 'payee' as const, op: 'is' as const, value: n }]));
        else all.push({ field: 'payee', op: 'is', value: names[0]! });
      } else if (c.field === 'description' && c.value.trim())
        all.push({ field: 'description', op: 'contains', value: c.value.trim() });
      else if (c.field === 'amount') {
        const lo = parseCents(c.min);
        const hi = parseCents(c.max);
        if (lo !== null && hi !== null) all.push({ field: 'amount', op: 'between', min: -hi, max: -lo });
      }
    }
    if (all.length === 0 && any.length === 0) return null;
    const actions: RuleBody['actions'] = [];
    if (cat) actions.push({ type: 'set_category', categoryId: cat });
    if (owed === 'half') actions.push({ type: 'mark_owed', num: 1, den: 2 });
    if (owed === 'all') actions.push({ type: 'mark_owed', num: 1, den: 1 });
    const fixed = parseCents(owedFixed);
    if (owed === 'fixed' && fixed) actions.push({ type: 'mark_owed', fixed });
    if (prev) actions.push({ type: 'previous_month_if_within_days', days: 5 });
    if (actions.length === 0) actions.push({ type: 'flag_review' });
    const nameFrom = conds.find((c) => c.value.trim())?.value.trim() ?? 'Rule';
    return {
      id: isNew ? undefined : ruleId,
      name: rule?.name ?? nameFrom.slice(0, 80),
      conditions: any.length ? { all, any } : { all },
      actions,
      applyToPending: rule?.applyToPending ?? true,
      stopAfter: rule?.stopAfter ?? true,
      enabled: rule?.enabled ?? true,
    };
  }, [conds, cat, owed, owedFixed, prev, isNew, ruleId, rule]);

  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!body) {
      setPreview(null);
      return;
    }
    const id = setTimeout(() => {
      api
        .previewRule(body)
        .then((p) =>
          setPreview({
            n: p.matches.length,
            uncategorized: p.uncategorizedMatches,
            rows: p.matches
              .slice(0, 5)
              .map((m) => ({ key: m.key, date: m.date, payee: m.payee, amount: m.amount, meta: rowMeta(m) })),
          }),
        )
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(id);
    // bodyKey captures every field of body
  }, [bodyKey]);

  if (!conds)
    return (
      <Page title="Rule" back="/settings/rules">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Page>
    );
  const upd = (id: number, p: Partial<Cond>) =>
    setConds(conds.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const save = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveRule(body);
      await qc.invalidateQueries({ queryKey: qk.rules });
      back();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api.deleteRule(ruleId);
    await qc.invalidateQueries({ queryKey: qk.rules });
    back();
  };
  const title = isNew ? 'New rule' : `Rule ${idx + 1} · ${rule?.name ?? ''}`;
  return (
    <Page
      title={title}
      back="/settings/rules"
      footer={
        <div className="flex flex-col gap-2">
          {error ? <ErrorNote error={error} /> : null}
          <PrimaryButton
            mutates
            track="rule.save"
            disabled={!body || busy || !canWrite}
            onClick={() => void save()}
          >
            Save rule
          </PrimaryButton>
        </div>
      }
    >
      <section className="flex flex-col gap-2">
        <SectionTitle>When all of these match</SectionTitle>
        {conds.map((c, i) => (
          <div key={c.id} className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-3">
            <select
              aria-label={`Field for condition ${i + 1}`}
              className={inputClass}
              value={c.field}
              onChange={(e) => upd(c.id, { field: e.target.value as CondField })}
            >
              <option value="payee">Payee is</option>
              <option value="description">Description contains</option>
              <option value="amount">Amount is between</option>
            </select>
            {c.field === 'amount' ? (
              <span className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <input
                  aria-label={`Lowest amount for condition ${i + 1}`}
                  inputMode="decimal"
                  className={cx(inputClass, 'tnum')}
                  placeholder="0.00"
                  value={c.min}
                  onChange={(e) => upd(c.id, { min: e.target.value })}
                />
                <span className="text-[14px] text-muted">and</span>
                <input
                  aria-label={`Highest amount for condition ${i + 1}`}
                  inputMode="decimal"
                  className={cx(inputClass, 'tnum')}
                  placeholder="0.00"
                  value={c.max}
                  onChange={(e) => upd(c.id, { max: e.target.value })}
                />
              </span>
            ) : (
              <input
                aria-label={`Value for condition ${i + 1}`}
                className={inputClass}
                value={c.value}
                onChange={(e) => upd(c.id, { value: e.target.value })}
              />
            )}
            {conds.length > 1 && (
              <button
                type="button"
                aria-label={`Remove condition ${i + 1}`}
                onClick={() => setConds(conds.filter((x) => x.id !== c.id))}
                className="hit h-8 self-end text-[14px] font-semibold text-muted"
              >
                Remove condition
              </button>
            )}
          </div>
        ))}
        <TextButton
          track="rule.add_condition"
          onClick={() =>
            setConds([
              ...conds,
              {
                id: Math.max(0, ...conds.map((c) => c.id)) + 1,
                field: 'description',
                value: '',
                min: '',
                max: '',
              },
            ])
          }
        >
          <Icon name="plus" size={16} stroke={2.6} />
          Add condition
        </TextButton>
      </section>
      <section className="flex flex-col gap-3">
        <SectionTitle>Then</SectionTitle>
        <Field label="Category">
          <CategoryField
            track="rule.category"
            value={cat ?? ''}
            onChange={setCat}
            specials={[{ id: '', name: 'Don’t set a category' }]}
          />
        </Field>
        <Card className="flex flex-col gap-2 p-3">
          <span className="flex flex-col gap-px text-[15px] font-semibold">
            Owed to you
            <span className="text-[12px] font-normal text-muted">
              {owed === 'none'
                ? 'Nothing owed'
                : owed === 'half'
                  ? 'Half of each payment'
                  : owed === 'all'
                    ? 'All of it'
                    : `${owedFixed ? formatCents(parseCents(owedFixed) ?? 0) : 'A set amount'} of each payment`}
            </span>
          </span>
          <Segmented
            label="Owed to you"
            value={owed}
            onChange={setOwed}
            options={[
              ['none', 'None'],
              ['half', 'Half'],
              ['all', 'All'],
              ['fixed', 'Amount'],
            ]}
          />
          {owed === 'fixed' && (
            <input
              aria-label="Amount owed"
              inputMode="decimal"
              className={cx(inputClass, 'tnum')}
              placeholder="0.00"
              value={owedFixed}
              onChange={(e) => setOwedFixed(e.target.value)}
            />
          )}
        </Card>
        <Card>
          <Toggle
            label="Count in the previous month"
            help="If it posts on day 1–5 of a month"
            checked={prev}
            onChange={setPrev}
          />
        </Card>
      </section>
      <section className="flex flex-col gap-1.5">
        <SectionTitle note={preview ? preview.n : '…'}>Matches in the last 90 days</SectionTitle>
        {preview && preview.rows.length > 0 && (
          <Card>
            {preview.rows.map((m) => (
              <div
                key={m.key}
                className="flex items-center justify-between gap-2 border-t border-divider px-3 py-2 text-[14px] first:border-t-0"
              >
                <span className="flex flex-col">
                  <span className="font-semibold">
                    {dayLabel(m.date)} · {m.payee}
                  </span>
                  <span className="text-[12px] text-muted">{m.meta}</span>
                </span>
                <span className="tnum font-bold">{formatCents(m.amount)}</span>
              </div>
            ))}
          </Card>
        )}
        <span className="text-[12px] text-muted">
          Already-categorized matches keep their category. Changes apply to new transactions.
          {preview && preview.uncategorized > 0
            ? ` ${preview.uncategorized} uncategorized ${preview.uncategorized === 1 ? 'match' : 'matches'} can be categorized after saving.`
            : ''}
        </span>
        {!isNew && preview && preview.uncategorized > 0 && (
          <SecondaryButton
            mutates
            track="rule.apply"
            onClick={async () => {
              await api.applyRule(ruleId);
              void qc.invalidateQueries({ queryKey: ['activity'] });
              void qc.invalidateQueries({ queryKey: ['budget'] });
              toast.show({ text: 'Rule applied to uncategorized transactions' });
            }}
          >
            Apply to {preview.uncategorized} uncategorized
          </SecondaryButton>
        )}
      </section>
      {!isNew &&
        (asking ? (
          <ConfirmInline
            label="Delete rule"
            confirmLabel="Delete rule"
            track="rule.delete.confirm"
            onConfirm={() => void remove()}
            onCancel={() => setAsking(false)}
          >
            Delete this rule? Transactions it already categorized keep their categories; new ones from this
            payee will need a category.
          </ConfirmInline>
        ) : (
          <DangerLink track="rule.delete" onClick={() => setAsking(true)} className="mt-4">
            Delete rule…
          </DangerLink>
        ))}
    </Page>
  );
}
