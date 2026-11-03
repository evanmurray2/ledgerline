// Settings → Payees: merge and rename.
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { qk, usePayees } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import {
  Banner,
  Card,
  EmptyNote,
  ErrorNote,
  Field,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  SearchField,
  SoftButton,
  softButtonClass,
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
      <SearchField label="Search payees" placeholder="Search payees" value={filter} onChange={setFilter} />
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
              <SoftButton
                tone="outline"
                track="payees.keep_separate"
                onClick={() => setKept({ ...kept, [s.name]: true })}
                className="flex-1"
              >
                Keep separate
              </SoftButton>
              <SoftButton
                tone="filled"
                mutates
                track="payees.merge"
                onClick={async () => {
                  await api.mergePayees({ ids: s.payeeIds, name: s.name });
                  usage.suggestion('payee_merge', 'merged');
                  setMerged(s.name);
                  void qc.invalidateQueries({ queryKey: qk.payees });
                }}
                className="flex-1"
              >
                Merge {s.rawNames.length}
              </SoftButton>
            </div>
          </section>
        ))}
      {merged && (
        <Banner tone="success" icon="check">
          Merged into {merged}
        </Banner>
      )}
      {v && list.length === 0 && <EmptyNote>{filter ? 'No payee matches.' : 'No payees yet.'}</EmptyNote>}
      {v && list.length > 0 && (
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
              {/* SoftLink takes no aria-label, so its class on a Link. */}
              <Link
                to={`/settings/payees/${p.id}`}
                data-track="payees.rename"
                aria-label={`Rename ${p.name}`}
                className={softButtonClass()}
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
