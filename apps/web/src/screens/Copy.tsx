// The copy's own screens (D-45, src/copy/copy.ts): getting it ready, opening it with no signal (Face ID), and what
// went wrong. Online, the Sign in screen opens it.
import { useState } from 'react';
import type { Session } from '@ledgerline/contracts';
import { Frame, Problem } from '../components/Frame';
import { PrimaryButton } from '../components/ui';
import { errorMessage } from '../api/client';
import { type CopyState, type FullWhy, openWithoutSignal, start } from '../copy/copy';
import { JoinThisDevice } from './DeviceAdd';
import { passkeyProblem } from '../copy/passkey';

/** Why the whole budget is downloading instead of only what changed (also sent to the server's logs). */
const WHY: Record<FullWhy, string | null> = {
  memory: 'This browser can’t save your budget, so it downloads each time.',
  first: null,
  no_prf: 'Your passkey can’t lock a saved budget, so it downloads each time.',
  turned_off: 'This device was signed out from another one, so it downloads your budget again.',
  unreadable_share: 'The budget saved on this device couldn’t be opened, so it downloads again.',
  unreadable_key: 'The budget saved on this device couldn’t be opened, so it downloads again.',
  unreadable_copy: 'The budget saved on this device couldn’t be opened, so it downloads again.',
  empty: 'The budget saved on this device was empty, so it downloads again.',
  storage: 'This device couldn’t read its saved budget just now, so it downloads this time.',
  reset: 'Your budget was restored, so it downloads again.',
};

function cancelled(e: unknown): string {
  return passkeyProblem(e) ?? errorMessage(e);
}

export function CopyScreen({
  copy,
  session,
  onOffline,
}: {
  copy: CopyState;
  session: Session | null;
  onOffline: (s: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    fn().then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setErr(cancelled(e));
      },
    );
  };
  if (copy.status === 'opening')
    return (
      <Frame title="Getting your budget ready">
        <p className="m-0 text-base leading-relaxed text-ink-2" role="status">
          {copy.progress > 0 ? 'Downloading your budget…' : 'One moment…'}
        </p>
        {copy.why && WHY[copy.why] && <p className="m-0 text-sm leading-snug text-muted">{WHY[copy.why]}</p>}
      </Frame>
    );
  // The server showed this device a different history (a fork or a rollback): the device stops here, and its copy
  // is left as it was (docs/privacy.md 5.3).
  if (copy.status === 'failed' && copy.forked)
    return (
      <Frame title="Your budget stopped on this device">
        <p className="m-0 text-base leading-relaxed text-ink-2" data-testid="forked">
          The server showed this device a different history. Nothing was changed.
        </p>
        <p className="m-0 text-sm leading-snug text-muted">
          Your budget is still saved on this device. Don’t make changes on another device until this is
          solved.
        </p>
        <PrimaryButton onClick={() => window.location.reload()}>Try again</PrimaryButton>
      </Frame>
    );
  // A locked budget this passkey can't open yet: a device that opens it adds this one, or the recovery key opens
  // it; either way the passkey is added.
  if (copy.status === 'failed' && copy.needsRecovery && session) return <JoinThisDevice session={session} />;
  if (copy.status === 'failed')
    return (
      <Frame title="Couldn’t open your budget">
        <Problem text={copy.error} />
        {session ? (
          <PrimaryButton busy={busy} disabled={busy} onClick={() => go(() => start(session))}>
            Try again
          </PrimaryButton>
        ) : (
          // Opened with no signal, so there's no session to start again with: a reload starts over.
          <PrimaryButton onClick={() => window.location.reload()}>Try again</PrimaryButton>
        )}
      </Frame>
    );
  // No signal: the saved copy opens with the passkey alone (online, Sign in opens it).
  return (
    <Frame title="You’re offline">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        Your budget is saved on this device. Open it with your passkey to view it and make small changes.
      </p>
      <Problem text={err} />
      <PrimaryButton busy={busy} disabled={busy} onClick={() => go(() => openWithoutSignal(onOffline))}>
        {busy ? 'Waiting for your passkey…' : 'Open with passkey'}
      </PrimaryButton>
    </Frame>
  );
}
