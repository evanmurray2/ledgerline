// The one Rename payee sheet, opened from a transaction or from Settings → Payees. Renaming a payee to a name
// another payee already has joins them, with Undo (rename = merge, docs/payees.md section 5).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { qk } from '../api/hooks';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';
import { Sheet, SheetTitle } from './Sheet';
import { toast } from './Toast';
import { Card, ErrorNote, Field, inputClass, Label, Loading, PrimaryButton } from './ui';

/** Names compare without case, outer spaces or the curly/straight apostrophe difference (as the server does). */
export const sameName = (a: string, b: string) => norm(a) === norm(b);
const norm = (s: string) => s.trim().replace(/[’‘]/g, "'").toLowerCase();

export interface RenamePayeeProps {
  onClose: () => void;
  /** Still loading, or failed to load. */
  loading?: { error: unknown };
  /** The payee's current name. */
  name: string;
  /** Bank descriptions that become this payee, each with an optional note (e.g. "12 transactions"). */
  rawNames: { name: string; meta?: string }[];
  /** Every other payee, for joining; leave out where joining isn't offered (a manual entry). */
  others?: { id: string; name: string }[];
  /** Save the new name, or join this payee into `into` (another payee's id). Throws to show the error. */
  onSave: (name: string, into: { id: string; name: string } | null) => Promise<void>;
}

export function RenamePayeeSheet({ onClose, loading, name, rawNames, others, onSave }: RenamePayeeProps) {
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const online = useCanWrite();
  const header = <SheetTitle title="Rename payee" />;
  if (loading)
    return (
      <Sheet label="Rename payee" track="payee.rename" onClose={onClose} gap="auto" header={header}>
        {loading.error ? <ErrorNote error={loading.error} /> : <Loading />}
      </Sheet>
    );
  const value = typed ?? name;
  const match = value.trim() ? others?.find((o) => sameName(o.name, value)) : undefined;
  // Up to 3 payees whose names start with what you've typed, so joining doesn't depend on exact spelling.
  const needle = norm(value);
  const chips =
    typed !== null && needle && !match
      ? (others ?? []).filter((o) => norm(o.name).startsWith(needle)).slice(0, 3)
      : [];
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await onSave(value.trim(), match ? { id: match.id, name: match.name } : null);
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
            mutates={match ? true : 'offline'}
            track={match ? 'payee.join' : 'payee.rename.save'}
            busy={busy}
            disabled={busy || !value.trim() || (!match && value.trim() === name) || (!!match && !online)}
            why={
              !value.trim()
                ? 'Enter a name to save'
                : !match && value.trim() === name
                  ? 'Change the name to save'
                  : match && !online
                    ? 'You’re offline'
                    : ''
            }
            onClick={() => void save()}
          >
            {match ? 'Join payees' : 'Save name'}
          </PrimaryButton>
        </div>
      }
    >
      <Field label="Show as">
        <input className={inputClass} value={value} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      {match && (
        <p className="m-0 text-sm leading-snug text-ink-2">
          You have a payee named {match.name}. Saving joins them.
        </p>
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((o) => (
            <button
              key={o.id}
              type="button"
              data-track="payee.rename.chip"
              onClick={() => setTyped(o.name)}
              className="hit flex h-10 items-center rounded-full border border-accent bg-accent-soft px-3.5 text-md font-bold text-accent"
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
      {rawNames.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>Bank names</Label>
          <Card>
            {rawNames.map((r) => (
              <div
                key={r.name}
                className="flex items-center justify-between gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
              >
                <span className="min-w-0 break-words font-mono text-sm">{r.name}</span>
                {r.meta && <span className="shrink-0 text-xs text-muted">{r.meta}</span>}
              </div>
            ))}
          </Card>
        </div>
      )}
      <p className="m-0 text-xs leading-snug text-muted">
        Applies to past and future transactions.
      </p>
    </Sheet>
  );
}

/** Saves a rename, or a join with an Undo toast; refreshes what shows payee names. */
export function usePayeeSave() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.payees });
    void qc.invalidateQueries({ queryKey: ['activity'] });
    void qc.invalidateQueries({ queryKey: ['txn'] });
  };
  return async (payeeId: string, name: string, into: { id: string; name: string } | null) => {
    if (into) {
      const r = await api.mergePayees({ keep: into.id, ids: [into.id, payeeId] });
      refresh();
      toast.show({
        text: `Joined into ${into.name}`,
        undo: async () => {
          try {
            await api.undoMergePayees(r.undoId);
            usage.undo('payee_join');
          } catch (e) {
            toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t undo that. Try again.' });
          }
          refresh();
        },
      });
    } else {
      await api.renamePayee(payeeId, { name });
      refresh();
    }
  };
}

/** "1 transaction", "4 transactions". */
export const txnCount = (n: number) => `${n} ${n === 1 ? 'transaction' : 'transactions'}`;
