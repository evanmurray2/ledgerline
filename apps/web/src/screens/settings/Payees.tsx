// Settings → Payees: merge and rename.
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { qk, usePayees } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
} from '../../components/ui';
import { useScreen } from '../../lib/common';
import { usage } from '../../usage/tracker';
import { Page } from './common';

// ------------------------------------------------------------------ payees

export function PayeesScreen() {
  useScreen('settings.payees');
  const q = usePayees();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const [merged, setMerged] = useState<string | null>(null);
  const v = q.data;
  const list = (v?.payees ?? []).filter(
    (p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Page title="Payees" back="/settings">
      <label className="flex min-h-11 items-center gap-2 rounded-xl bg-sunken px-3 text-muted">
        <Icon name="search" size={18} />
        <input
          aria-label="Search payees"
          placeholder="Search payees"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="min-h-10 flex-1 border-none bg-transparent text-[16px] text-ink outline-none"
        />
      </label>
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v?.suggestions
        .filter((s) => !kept[s.name])
        .map((s) => (
          <section
            key={s.name}
            className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-accent bg-accent-soft p-3"
          >
            <span className="text-[12px] font-bold uppercase tracking-[0.4px] text-accent">
              Looks like the same payee
            </span>
            <div className="flex flex-wrap gap-1.5">
              {s.rawNames.map((r) => (
                <span key={r} className="rounded-md bg-surface px-2 py-1 font-mono text-[12px] text-ink-2">
                  {r}
                </span>
              ))}
            </div>
            <span className="text-[13px] text-ink-2">
              Merge into <strong>{s.name}</strong>? Rules and past transactions follow.
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-track="payees.keep_separate"
                onClick={() => setKept({ ...kept, [s.name]: true })}
                className="hit h-9 flex-1 rounded-full border border-line-strong bg-surface text-[13px] font-bold text-ink-2"
              >
                Keep separate
              </button>
              <Button
                mutates
                track="payees.merge"
                onClick={async () => {
                  await api.mergePayees({ ids: s.payeeIds, name: s.name });
                  usage.suggestion('payee_merge', 'merged');
                  setMerged(s.name);
                  void qc.invalidateQueries({ queryKey: qk.payees });
                }}
                className="hit h-9 flex-1 rounded-full bg-accent text-[13px] font-bold text-on-accent"
              >
                Merge {s.rawNames.length}
              </Button>
            </div>
          </section>
        ))}
      {merged && (
        <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[14px] text-funded-fg">
          Merged into {merged}
        </p>
      )}
      {v && (
        <Card>
          {list.map((p) => (
            <div
              key={p.id}
              className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 first:border-t-0"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{p.name}</span>
                <span className="text-[12px] text-muted">
                  {p.transactions} {p.transactions === 1 ? 'transaction' : 'transactions'}
                  {p.defaultCategory ? ` · usually ${p.defaultCategory}` : ''}
                </span>
              </span>
              <Link
                to={`/settings/payees/${p.id}`}
                data-track="payees.rename"
                aria-label={`Rename ${p.name}`}
                className="hit flex h-9 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
              >
                Rename
              </Link>
            </div>
          ))}
        </Card>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted">
        Renames and merges only change how payees are shown and matched. The bank’s original description is
        always kept on each transaction.
      </p>
      <Outlet />
    </Page>
  );
}

export function RenamePayeeSheet() {
  const { payeeId } = useParams({ strict: false }) as { payeeId: string };
  useScreen('settings.payee.rename');
  const q = usePayees();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const close = () => void navigate({ to: '/settings/payees' });
  const p = q.data?.payees.find((x) => x.id === payeeId);
  const [name, setName] = useState<string | null>(null);
  const [into, setInto] = useState('');
  const [error, setError] = useState<unknown>(null);
  const raw = q.data?.suggestions.find((s) => s.payeeIds.includes(payeeId))?.rawNames ?? [];
  if (!p)
    return (
      <Sheet label="Rename payee" track="payee.rename" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const value = name ?? p.name;
  const save = async () => {
    setError(null);
    try {
      if (into) {
        const target = q.data!.payees.find((x) => x.id === into)!;
        await api.mergePayees({ ids: [into, p.id], name: target.name });
      } else await api.renamePayee(p.id, { name: value.trim(), remember: p.remember });
      await qc.invalidateQueries({ queryKey: qk.payees });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      close();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Sheet
      label="Rename payee"
      track="payee.rename"
      onClose={close}
      gap="auto"
      header={<h1 className="m-0 text-[20px] font-bold">Rename payee</h1>}
    >
      <div className="flex flex-col gap-3 pb-4">
        <Field label="Show as">
          <input
            className={inputClass}
            value={value}
            disabled={!!into}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {raw.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>Bank names that become this payee</Label>
            <Card>
              {raw.map((r) => (
                <div
                  key={r}
                  className="border-t border-divider px-3 py-2.5 font-mono text-[13px] first:border-t-0"
                >
                  {r}
                </div>
              ))}
            </Card>
          </div>
        )}
        <Field label="Or merge into an existing payee">
          <select className={inputClass} value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Don’t merge</option>
            {q
              .data!.payees.filter((x) => x.id !== p.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </Field>
        <p className="m-0 text-[12px] leading-snug text-muted">
          Applies to past and future transactions. Rules follow the new name. The bank’s description stays on
          each transaction.
        </p>
        {error ? <ErrorNote error={error} /> : null}
        <PrimaryButton mutates track="payee.rename.save" disabled={!value.trim()} onClick={() => void save()}>
          Save
        </PrimaryButton>
      </div>
    </Sheet>
  );
}
