// Settings → Privacy: deleting the readable copy that the server kept from before the lock (docs/privacy.md
// section 8, steps 8 and 9; the Worker's seal/purge.ts). Shown to the budget's admin once the way back has closed.
// Deleting can't be undone, so the person confirms, and the server asks for the passkey again. The card then
// shows how far the deleting has come, and 31 days after it ended, what the server's check found.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api, type PurgeView } from '../../api/endpoints';
import { Problem } from '../../components/Frame';
import { Card, ConfirmInline, DangerLink, SectionTitle } from '../../components/ui';
import { Why } from '../../components/Why';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/** What the Privacy screen says about the copy from before the lock, at each stage. */
export function oldCopyText(p: PurgeView | null | undefined, backUntil: string | null): string {
  switch (p?.stage) {
    case 'ready':
    case 'stopped':
      return 'Still readable on the server. You can delete it below.';
    case 'running':
      return 'Being deleted now.';
    case 'done':
      return `Deleted on ${day(p.doneAt!)}.`;
    case 'checked':
      return p.clean
        ? `Deleted. A check on ${day(p.checkAt!)} found nothing readable left.`
        : `Deleted, but a check on ${day(p.checkAt!)} found some still there.`;
    default:
      return backUntil
        ? `Still readable on the server, for the way back until ${day(backUntil)}. You can delete it after that.`
        : 'Still readable on the server, for the way back. You can delete it after that.';
  }
}

/** What the Privacy screen says about the server's past versions, at each stage. */
export function pastVersionsText(p: PurgeView | null | undefined): string {
  if (p?.stage === 'checked' && p.clean)
    return 'The server keeps 30 days of them. None holds the readable copy.';
  if (p?.stage === 'done' || p?.stage === 'checked')
    return `The server keeps 30 days of them. Until ${day(p.checkAt!)}, some hold the readable copy.`;
  return 'The server keeps 30 days of them, the older ones readable.';
}

export function PurgeCard({ purge }: { purge: PurgeView | null | undefined }) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!purge || purge.stage === 'none' || purge.stage === 'waiting') return null;

  const start = () => {
    setBusy(true);
    setErr(null);
    api.cutoverPurge().then(
      async () => {
        setBusy(false);
        setAsking(false);
        await qc.invalidateQueries({ queryKey: ['cutover'] });
      },
      (e: unknown) => {
        setBusy(false);
        setAsking(false);
        // A passkey check the app asks for by itself is not a problem to show.
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
      },
    );
  };

  return (
    <>
      <SectionTitle>The copy from before the lock</SectionTitle>
      <Card>
        <div className="flex flex-col gap-3 px-3 py-3" data-testid="purge-card">
          {(purge.stage === 'ready' || purge.stage === 'stopped') && (
            <>
              <span className="text-sm text-muted">
                {purge.stage === 'stopped'
                  ? 'Deleting stopped before the end. Try again.'
                  : 'The server still holds your budget as it was before the lock, readable. It is kept only for the way back.'}
              </span>
              <Why label="What happens?">
                The server deletes it in small steps, over a few days. Your locked budget and your bank links
                stay. Past versions still hold the copy for 30 days. Then the server checks that nothing
                readable is left.
              </Why>
              <Problem text={err} />
              {asking ? (
                <ConfirmInline
                  label="Delete the readable copy"
                  confirmLabel="Delete it"
                  busy={busy}
                  onConfirm={start}
                  onCancel={() => setAsking(false)}
                >
                  Delete the readable copy? This can’t be undone, and the way back ends. Your passkey is asked
                  next.
                </ConfirmInline>
              ) : (
                <DangerLink className="self-start" onClick={() => setAsking(true)}>
                  Delete the readable copy…
                </DangerLink>
              )}
            </>
          )}
          {purge.stage === 'running' && (
            <span className="text-base text-ink-2" role="status">
              Deleting: {purge.done} of {purge.tables || '…'} parts done. This takes a few days. You can close
              the app.
            </span>
          )}
          {purge.stage === 'done' && (
            <span className="text-base text-ink-2">
              Deleted on {day(purge.doneAt!)}. Past versions still hold it until {day(purge.checkAt!)}. Then
              the server checks that nothing readable is left.
            </span>
          )}
          {purge.stage === 'checked' && (
            <span className="text-base text-ink-2" role="status">
              {purge.clean
                ? `Checked on ${day(purge.checkAt!)}: nothing readable is left on the server.`
                : `Checked on ${day(purge.checkAt!)}: some of the copy is still there.`}
            </span>
          )}
        </div>
      </Card>
    </>
  );
}
