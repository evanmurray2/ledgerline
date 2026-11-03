// The copy's own screens (D-45, src/copy/copy.ts): getting it ready, opening it with no signal (Face ID), and what
// went wrong. Online, the Sign in screen opens it.
import { useState } from 'react';
import type { Session } from '@ledgerline/contracts';
import { Frame, Problem } from '../components/Frame';
import { PrimaryButton } from '../components/ui';
import { type CopyState, type FullWhy, openWithoutSignal, start } from '../copy/copy';

/** Why the whole budget is downloading instead of only what changed (also sent to the server's logs). */
const WHY: Record<FullWhy, string> = {
  memory: 'this browser can’t save your budget.',
  first: 'there’s no saved copy on this device yet.',
  no_prf: 'your passkey didn’t give Ledgerline a key, so nothing is saved on this device.',
  turned_off: 'this device was signed out from another one.',
  unreadable_share: 'the saved copy couldn’t be opened (share).',
  unreadable_key: 'the saved copy couldn’t be opened (key).',
  unreadable_copy: 'the saved copy couldn’t be opened (copy).',
  empty: 'the saved copy was empty.',
  reset: 'your budget was restored on the server.',
};

function cancelled(e: unknown): string {
  const name = (e as { name?: string }).name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Cancelled. Try again when you’re ready.';
  return e instanceof Error ? e.message : 'Something went wrong. Try again.';
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
        <p className="m-0 text-[15px] leading-relaxed text-ink-2" role="status">
          {copy.progress > 0 ? `Downloaded ${copy.progress.toLocaleString()} rows…` : 'One moment…'}
        </p>
        {copy.why && (
          <p className="m-0 text-[13px] leading-snug text-muted">Downloading everything: {WHY[copy.why]}</p>
        )}
      </Frame>
    );
  if (copy.status === 'failed')
    return (
      <Frame title="Couldn’t open your budget">
        <Problem text={copy.error} />
        {session && (
          <PrimaryButton disabled={busy} onClick={() => go(() => start(session))}>
            Try again
          </PrimaryButton>
        )}
      </Frame>
    );
  // No signal: the saved copy opens with Face ID alone (online, Sign in opens it).
  return (
    <Frame title="No signal">
      <p className="m-0 text-[15px] leading-relaxed text-ink-2">
        Your budget is saved on this phone, encrypted. Open it with Face ID to look and make small changes.
        They’re sent when you’re back online.
      </p>
      <Problem text={err} />
      <PrimaryButton disabled={busy} onClick={() => go(() => openWithoutSignal(onOffline))}>
        {busy ? 'Waiting for Face ID…' : 'Open with Face ID'}
      </PrimaryButton>
    </Frame>
  );
}
