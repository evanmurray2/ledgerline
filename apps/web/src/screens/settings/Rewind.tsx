// Settings → Import and export → Rewind (runbooks/restore.md): puts the budget back as it was at a minute in the
// last 30 days, with Cloudflare's point-in-time recovery, and undoes the last rewind. A rewind is never final: the
// Directory keeps the bookmark that undoes it, so a rewind by mistake (or by someone with your passkey) can be taken
// back from the same screen.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { useSession } from '../../api/hooks';
import { Problem } from '../../components/Frame';
import {
  Banner,
  Card,
  ConfirmInline,
  Field,
  SecondaryButton,
  SoftButton,
  inputClass,
} from '../../components/ui';
import { serverNow, syncNow } from '../../copy/copy';
import { useCanWrite } from '../../state/connectivity';

const DAY = 86_400_000;

/** A time as the person reads it, in this device's time zone. */
const shown = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** `datetime-local` text for a time, in this device's time zone. */
function localInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function RewindCard() {
  const session = useSession();
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const last = useQuery({ queryKey: ['rewind'], queryFn: () => api.lastRewind() });
  const [mode, setMode] = useState<'closed' | 'rewind' | 'undo'>('closed');
  const [when, setWhen] = useState(() => localInput(serverNow() - 3600_000));
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const name = session.data?.budget.name ?? '';
  const at = Date.parse(when);
  // The server checks the 30 days with its own clock.
  const now = serverNow();
  const inWindow = Number.isFinite(at) && at < now && at > now - 30 * DAY;
  const named = !!name && typed.trim() === name.trim();
  const lastRewind = last.data?.last ?? null;

  const close = () => {
    setMode('closed');
    setTyped('');
    setAsking(false);
    setErr(null);
  };
  const run = () => {
    setBusy(true);
    setErr(null);
    const body =
      mode === 'undo'
        ? ({ undo: true, confirm: typed } as const)
        : { before: new Date(at).toISOString(), confirm: typed };
    api.rewind(body).then(
      async () => {
        setDone(
          mode === 'undo'
            ? 'Rewind undone. Your budget is downloading again.'
            : `Rewound to ${shown(new Date(at).toISOString())}. Your budget is downloading again.`,
        );
        setBusy(false);
        close();
        // The rewind gave the budget a new sync epoch: the next sync downloads the whole copy again.
        await syncNow().catch(() => undefined);
        void qc.invalidateQueries();
      },
      (e: unknown) => {
        setBusy(false);
        setAsking(false);
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
      },
    );
  };

  return (
    <Card>
      <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
        <span className="flex flex-col gap-0.5">
          <span className="text-base font-semibold">Rewind</span>
          <span className="text-xs text-muted">
            {lastRewind
              ? `Last rewind ${shown(lastRewind.at)}${lastRewind.to ? `, to ${shown(lastRewind.to)}` : ', undone'}`
              : 'Put your budget back as it was, up to 30 days ago'}
          </span>
        </span>
        {mode === 'closed' && (
          <SoftButton track="data.rewind" disabled={!canWrite} onClick={() => setMode('rewind')}>
            Rewind
          </SoftButton>
        )}
      </div>
      {mode === 'closed' && lastRewind && (
        <div className="px-3 pb-2">
          <SoftButton track="data.rewind.undo" disabled={!canWrite} onClick={() => setMode('undo')}>
            Undo last rewind
          </SoftButton>
        </div>
      )}
      {done && mode === 'closed' && (
        <div className="px-3 pb-2">
          <Banner tone="success" icon="check">
            {done}
          </Banner>
        </div>
      )}
      {mode !== 'closed' && (
        <div className="flex flex-col gap-3 border-t border-divider px-3 py-3">
          <span className="text-sm leading-snug text-ink-2">
            {mode === 'undo'
              ? 'Your budget goes back to how it was just before the last rewind.'
              : 'Your budget goes back to how it was at this time. Changes you made after it are lost. Bank transactions after it come back on the next sync.'}
          </span>
          {mode === 'rewind' && (
            <Field label="Rewind to">
              <input
                type="datetime-local"
                className={inputClass}
                value={when}
                min={localInput(now - 30 * DAY + 60_000)}
                max={localInput(now)}
                onChange={(e) => setWhen(e.target.value)}
              />
            </Field>
          )}
          <Field label={`Type “${name}” to confirm`}>
            <input
              className={inputClass}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {mode === 'rewind' && !inWindow && <Problem text="Pick a time in the last 30 days." />}
          <Problem text={err} />
          {asking ? (
            <ConfirmInline
              label={mode === 'undo' ? 'Undo last rewind' : 'Rewind budget'}
              confirmLabel={mode === 'undo' ? 'Undo rewind' : 'Rewind'}
              track={mode === 'undo' ? 'data.rewind.undo.confirm' : 'data.rewind.confirm'}
              busy={busy}
              onCancel={() => setAsking(false)}
              onConfirm={run}
            >
              {mode === 'undo'
                ? 'Undo the last rewind?'
                : `Rewind your budget to ${shown(new Date(at).toISOString())}?`}
            </ConfirmInline>
          ) : (
            <div className="flex gap-2">
              <SecondaryButton className="flex-1" onClick={close}>
                Cancel
              </SecondaryButton>
              <SecondaryButton
                danger
                className="flex-1"
                disabled={!named || (mode === 'rewind' && !inWindow)}
                onClick={() => setAsking(true)}
              >
                {mode === 'undo' ? 'Undo rewind' : 'Rewind'}
              </SecondaryButton>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
