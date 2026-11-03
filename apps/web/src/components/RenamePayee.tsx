// The one Rename payee sheet, opened from a transaction or from Settings → Payees. Each caller loads its payee and
// saves its own way; this draws the sheet the same for both.
import { useState } from 'react';
import { Sheet, SheetTitle } from './Sheet';
import { Card, ErrorNote, Field, inputClass, Label, Loading, PrimaryButton } from './ui';

export interface RenamePayeeProps {
  onClose: () => void;
  /** Still loading, or failed to load. */
  loading?: { error: unknown };
  /** The payee's current name. */
  name: string;
  /** Bank descriptions that become this payee, each with an optional note (e.g. "12 transactions"). */
  rawNames: { name: string; meta?: string }[];
  /** Other payees this one can be merged into; leave out where merging isn't offered. */
  mergeInto?: { id: string; name: string }[];
  /** Save the new name, or merge into the payee `into`. Throws to show the error. */
  onSave: (name: string, into: string) => Promise<void>;
}

export function RenamePayeeSheet({ onClose, loading, name, rawNames, mergeInto, onSave }: RenamePayeeProps) {
  const [typed, setTyped] = useState<string | null>(null);
  const [into, setInto] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const header = <SheetTitle title="Rename payee" />;
  if (loading)
    return (
      <Sheet label="Rename payee" track="payee.rename" onClose={onClose} gap="auto" header={header}>
        {loading.error ? <ErrorNote error={loading.error} /> : <Loading />}
      </Sheet>
    );
  const value = typed ?? name;
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await onSave(value.trim(), into);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      label="Rename payee"
      track="payee.rename"
      onClose={onClose}
      gap="auto"
      header={header}
      footer={
        <div className="flex flex-col gap-2">
          {error ? <ErrorNote error={error} /> : null}
          <PrimaryButton
            mutates
            track="payee.rename.save"
            disabled={busy || (!into && !value.trim())}
            onClick={() => void save()}
          >
            {into ? 'Merge' : 'Save name'}
          </PrimaryButton>
        </div>
      }
    >
      <Field label="Show as">
        <input
          className={inputClass}
          value={value}
          disabled={!!into}
          onChange={(e) => setTyped(e.target.value)}
        />
      </Field>
      {rawNames.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>Bank names that become this payee</Label>
          <Card>
            {rawNames.map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
              >
                <span className="min-w-0 break-words font-mono text-[13px]">{r.name}</span>
                {r.meta && <span className="shrink-0 text-[12px] text-muted">{r.meta}</span>}
              </div>
            ))}
          </Card>
        </div>
      )}
      {mergeInto && mergeInto.length > 0 && (
        <Field label="Or merge into an existing payee">
          <select className={inputClass} value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Don’t merge</option>
            {mergeInto.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted">
        Applies to past and future transactions. Rules follow the new name. The bank’s description stays on
        each transaction.
      </p>
    </Sheet>
  );
}
