// The owner's Storage card (docs/multi-user.md 8.1, 8.6): where the data lives, the move to the new databases and
// the way back, started and watched from the phone. Hidden from anyone who isn't the owner.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoveInfo } from '@ledgerline/contracts';
import { ApiError, get, post } from '../api/client';
import { Card, ErrorNote, PrimaryButton, SecondaryButton } from '../components/ui';

const PHASE_TEXT: Record<MoveInfo['phase'], string> = {
  none: 'One shared database (D1)',
  frozen: 'Moving to the new databases…',
  moved: 'Its own database for each budget',
  restoring: 'Moving back to the shared database…',
};

const STATE_TEXT: Record<string, string> = {
  starting: 'Starting',
  copying: 'Copying',
  verifying: 'Checking every row',
  recomputing: 'Checking month totals',
  verified: 'Checked',
  waiting: 'Waiting for the budget’s copy',
  switching: 'Switching over',
  emptying: 'Clearing the old copy',
};

export function moveProgress(info: MoveInfo): string | null {
  const s = info.status;
  if (!s) return null;
  if (s.state === 'failed')
    return `The last move stopped and nothing changed: ${s.reason ?? 'unknown reason'}.`;
  if (info.phase === 'frozen' || info.phase === 'restoring') {
    const what = STATE_TEXT[s.state] ?? 'Working';
    return s.table ? `${what}: ${s.table.replace(/_/g, ' ')}` : what;
  }
  if (s.state === 'moved' && info.phase === 'moved') return 'Moved. Every row was copied and checked.';
  if (s.state === 'back' && info.phase === 'none') return 'Moved back. Every row was copied and checked.';
  return null;
}

export function StorageCard() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ['move'],
    queryFn: () => get('/api/move', MoveInfo),
    retry: false,
    // Every 2 seconds while a move runs; the screens are read-only then and the owner is watching.
    refetchInterval: (query) => {
      const p = query.state.data?.phase;
      return p === 'frozen' || p === 'restoring' ? 2000 : false;
    },
  });
  const phase = q.data?.phase;
  // When a move ends, everything on screen may come from a different database: refetch it all.
  const last = useRef(phase);
  useEffect(() => {
    if (last.current && phase && last.current !== phase) void qc.invalidateQueries();
    last.current = phase;
  }, [phase, qc]);
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : null;
  const info = q.data;
  const running = info.phase === 'frozen' || info.phase === 'restoring';
  const progress = moveProgress(info);
  const start = async (path: '/api/move' | '/api/move/back') => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['move'], await post(path, MoveInfo));
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['session'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Storage</h2>
      <Card>
        <div className="flex flex-col gap-2 px-3 py-3" aria-live="polite">
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Where your data lives</span>
            <span className="text-[13px] text-ink-2" data-testid="move-phase">
              {PHASE_TEXT[info.phase]}
            </span>
          </span>
          {progress && (
            <span
              role="status"
              className={
                info.status?.state === 'failed' ? 'text-[13px] text-under-fg' : 'text-[13px] text-muted'
              }
            >
              {progress}
            </span>
          )}
          {running && (
            <span className="text-[12px] text-muted">
              Screens are read-only for a few minutes. Bank updates wait and arrive after.
            </span>
          )}
          {!running && !confirming && (info.phase === 'none' || info.phase === 'moved') && (
            <SecondaryButton
              className="h-10 self-start text-[14px]"
              track={info.phase === 'none' ? 'storage.move' : 'storage.back'}
              onClick={() => setConfirming(true)}
            >
              {info.phase === 'none' ? 'Move to the new databases' : 'Move back to D1'}
            </SecondaryButton>
          )}
          {confirming && (
            <div className="flex flex-col gap-2 rounded-xl bg-sunken p-3">
              <span className="text-[13px] leading-snug text-ink-2">
                {info.phase === 'none'
                  ? 'Every row is copied and checked. If anything differs, the move stops and nothing changes. The app is read-only for a few minutes.'
                  : 'Every row, including changes since the move, is copied back and checked. The app is read-only for a few minutes.'}
              </span>
              <div className="flex gap-2">
                <SecondaryButton className="h-10 flex-1" onClick={() => setConfirming(false)}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton
                  className="h-10 flex-[2]"
                  track={info.phase === 'none' ? 'storage.move.start' : 'storage.back.start'}
                  disabled={busy}
                  onClick={() => void start(info.phase === 'none' ? '/api/move' : '/api/move/back')}
                >
                  {busy ? 'Starting…' : 'Start'}
                </PrimaryButton>
              </div>
            </div>
          )}
          {error ? <ErrorNote error={error} /> : null}
        </div>
      </Card>
    </>
  );
}
