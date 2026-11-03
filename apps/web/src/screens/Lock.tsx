// The copy's own screens (D-44, src/copy/copy.ts): getting it ready, locked (Face ID to open), opening with no
// signal, and what went wrong.
import { useState } from 'react';
import type { Session } from '@ledgerline/contracts';
import { PrimaryButton, SecondaryButton } from '../components/ui';
import { type CopyState, start, unlockOnline, unlockWithoutSignal, wipe } from '../copy/copy';

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="flex w-full max-w-[400px] flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-bold uppercase tracking-[0.5px] text-accent">Ledgerline</span>
          <h1 className="m-0 text-[26px] font-bold text-ink">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

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
      </Frame>
    );
  if (copy.status === 'failed')
    return (
      <Frame title="Couldn’t open your budget">
        <p role="alert" className="m-0 rounded-xl bg-over-bg p-3 text-[14px] text-over-fg">
          {copy.error}
        </p>
        {session && (
          <PrimaryButton disabled={busy} onClick={() => go(() => start(session))}>
            Try again
          </PrimaryButton>
        )}
      </Frame>
    );
  const offline = !session;
  return (
    <Frame title="Ledgerline is locked">
      <p className="m-0 text-[15px] leading-relaxed text-ink-2">
        {offline
          ? 'No signal. Your budget is saved on this phone, encrypted: unlock it with Face ID to look and make small changes. They’re sent when you’re back online.'
          : 'Your budget is saved on this phone, encrypted. Unlock it with Face ID.'}
      </p>
      {err && (
        <p role="alert" className="m-0 rounded-xl bg-over-bg p-3 text-[14px] text-over-fg">
          {err}
        </p>
      )}
      <PrimaryButton
        disabled={busy}
        onClick={() => go(() => (offline ? unlockWithoutSignal().then(onOffline) : unlockOnline(session)))}
      >
        {busy ? 'Waiting for Face ID…' : 'Unlock'}
      </PrimaryButton>
      {!offline && (
        <SecondaryButton
          disabled={busy}
          onClick={() => go(() => wipe().then(() => window.location.assign('/')))}
        >
          Remove the copy from this phone
        </SecondaryButton>
      )}
    </Frame>
  );
}
