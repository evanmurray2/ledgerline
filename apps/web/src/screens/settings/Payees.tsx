// Settings → Payees: every payee with transactions from the budget onward, searchable by name or bank text. A row
// opens the Rename sheet, where renaming to another payee's name joins them (docs/payees.md section 6).
import { useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { usePayees } from '../../api/hooks';
import { Card, EmptyNote, ErrorNote, Loading, SearchField } from '../../components/ui';
import { useScreen } from '../../lib/common';
import { Page } from './common';
import { RenamePayeeSheet as RenamePayeeView, txnCount, usePayeeSave } from '../../components/RenamePayee';

// ------------------------------------------------------------------ payees

export function PayeesScreen() {
  useScreen('settings.payees');
  const q = usePayees();
  const [filter, setFilter] = useState('');
  const v = q.data;
  const needle = filter.trim().toLowerCase();
  const list = (v?.payees ?? [])
    .map((p) => ({
      p,
      // A match on the bank's own text shows under the row.
      bank:
        needle && !p.name.toLowerCase().includes(needle)
          ? p.bankNames.find((b) => b.name.toLowerCase().includes(needle))?.name
          : undefined,
    }))
    .filter(({ p, bank }) => !needle || p.name.toLowerCase().includes(needle) || bank);
  return (
    <Page title="Payees" back="/settings">
      <SearchField
        label="Search payees"
        placeholder="Search payees or bank text"
        value={filter}
        onChange={setFilter}
      />
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && list.length === 0 && <EmptyNote>{filter ? 'No payees match.' : 'No payees yet.'}</EmptyNote>}
      {v && list.length > 0 && (
        <Card>
          {list.map(({ p, bank }) => (
            <Link
              key={p.id}
              to={`/settings/payees/${p.id}`}
              data-track="payees.open"
              aria-label={`Rename ${p.name}`}
              className="flex min-h-14 flex-col justify-center gap-0.5 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
            >
              <span className="text-base font-semibold break-words">{p.name}</span>
              <span className="text-xs text-muted">
                {txnCount(p.transactions)}
                {p.usual ? ` · usually ${p.usual}` : ''}
              </span>
              {bank && <span className="font-mono text-xs text-ink-2 break-words">{bank}</span>}
            </Link>
          ))}
        </Card>
      )}
      <p className="m-0 text-xs leading-snug text-muted">
        To join two payees, give one the other’s name.
      </p>
      <Outlet />
    </Page>
  );
}

export function RenamePayeeSheet() {
  const { payeeId } = useParams({ strict: false }) as { payeeId: string };
  useScreen('settings.payee.rename');
  const q = usePayees();
  const navigate = useNavigate();
  const save = usePayeeSave();
  const close = () => void navigate({ to: '/settings/payees' });
  const p = q.data?.payees.find((x) => x.id === payeeId);
  if (!p || !q.data)
    return (
      <RenamePayeeView
        onClose={close}
        loading={{ error: q.data ? new Error('This payee was joined or removed.') : q.error }}
        name=""
        rawNames={[]}
        onSave={async () => {}}
      />
    );
  const others = [...q.data.payees, ...q.data.others].filter((x) => x.id !== p.id);
  return (
    <RenamePayeeView
      onClose={close}
      name={p.name}
      rawNames={p.bankNames.map((b) => ({ name: b.name, meta: txnCount(b.count) }))}
      others={others.map((x) => ({ id: x.id, name: x.name }))}
      onSave={async (name, into) => {
        await save(p.id, name, into);
        close();
      }}
    />
  );
}
