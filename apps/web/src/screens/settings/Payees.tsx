// Settings → Payees: merge and rename.
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { qk, usePayees } from '../../api/hooks';
import {
  Banner,
  Card,
  EmptyNote,
  ErrorNote,
  Loading,
  SearchField,
  SoftButton,
  softButtonClass,
} from '../../components/ui';
import { useScreen } from '../../lib/common';
import { usage } from '../../usage/tracker';
import { Page } from './common';
import { RenamePayeeSheet as RenamePayeeView } from '../../components/RenamePayee';

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
  if (!p || !q.data)
    return (
      <RenamePayeeView
        onClose={close}
        loading={{ error: q.error }}
        name=""
        rawNames={[]}
        onSave={async () => {}}
      />
    );
  const raw = q.data.suggestions.find((s) => s.payeeIds.includes(payeeId))?.rawNames ?? [];
  const others = q.data.payees.filter((x) => x.id !== p.id);
  return (
    <RenamePayeeView
      onClose={close}
      name={p.name}
      rawNames={raw.map((name) => ({ name }))}
      mergeInto={others.map((x) => ({ id: x.id, name: x.name }))}
      onSave={async (name, into) => {
        if (into) {
          const target = others.find((x) => x.id === into)!;
          await api.mergePayees({ ids: [into, p.id], name: target.name });
        } else await api.renamePayee(p.id, { name, remember: p.remember });
        await qc.invalidateQueries({ queryKey: qk.payees });
        void qc.invalidateQueries({ queryKey: ['activity'] });
        close();
      }}
    />
  );
}
