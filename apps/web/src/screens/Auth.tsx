// Passkey sign-in (decisions.md D-27): first-time setup with the setup code, signing in, adding a device from a
// single-use link, the "Confirm it's you" check before linking a bank or exporting.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, errorMessage, setPasskeyCheck } from '../api/client';
import { api } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Frame, Problem } from '../components/Frame';
import { Field, PrimaryButton, SecondaryButton, inputClass } from '../components/ui';
import { signIn as copySignIn } from '../copy/copy';
import { CreateAccountScreen } from './Signup';
import { passkeyName } from '../lib/device-name';
import { RecoveryKeySignInScreen } from './RecoveryKey';

/** Runs a WebAuthn ceremony and turns the browser's errors into plain sentences. */
async function ceremony(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof ApiError) return errorMessage(e);
    const name = (e as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'AbortError') return 'Cancelled. Try again when you’re ready.';
    if (name === 'InvalidStateError') return 'This device already has a Ledgerline passkey.';
    return 'Couldn’t use your passkey. Try again.';
  }
}

/**
 * Passkey sign-in. Outside the mock it goes through the copy (src/copy/copy.ts), which asks the passkey for its PRF
 * output in the same Face ID prompt so the saved copy opens without a second one (D-45).
 */
export async function signInWithPasskey(): Promise<void> {
  if (import.meta.env.VITE_MOCK !== '1') return copySignIn();
  const optionsJSON = (await api.loginOptions()) as Parameters<typeof startAuthentication>[0]['optionsJSON'];
  const response = await startAuthentication({ optionsJSON });
  await api.loginVerify({ response });
}

async function addPasskey(start: { setupCode?: string; deviceToken?: string }, name: string): Promise<void> {
  const optionsJSON = (await api.registerOptions(start)) as Parameters<
    typeof startRegistration
  >[0]['optionsJSON'];
  const response = await startRegistration({ optionsJSON });
  await api.registerVerify({ response, name });
}

const deviceName = () => passkeyName();

const NoPasskeys = () => (
  <Problem text="This browser can’t use passkeys. Open Ledgerline in Safari, Chrome, Edge or Firefox." />
);

/** Set when you sign out of this device, so the Sign in screen that follows doesn't ask for Face ID by itself. */
export const SIGNED_OUT_HERE = 'ledgerline-signed-out-here';

function takeSignedOutHere(): boolean {
  try {
    const was = sessionStorage.getItem(SIGNED_OUT_HERE) === '1';
    sessionStorage.removeItem(SIGNED_OUT_HERE);
    return was;
  } catch {
    return false;
  }
}

export function SignInScreen() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: qk.authStatus, queryFn: api.authStatus, retry: 1 });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Open sign-up (D-75): Create account, only once the server turns it on. */
  const [mode, setMode] = useState<'signin' | 'create' | 'recovery-key'>('signin');
  const done = () => void qc.invalidateQueries({ queryKey: qk.session });
  const supported = browserSupportsWebAuthn();
  const siteKey = status.data?.signupOpen ? (status.data.turnstileSiteKey ?? null) : null;
  const signIn = (auto: boolean) => {
    setBusy(true);
    void ceremony(signInWithPasskey).then((m) => {
      setBusy(false);
      // Face ID that opened by itself and was cancelled isn't a problem: the button is there.
      setErr(auto && m?.startsWith('Cancelled') ? null : m);
      if (!m) done();
    });
  };
  // The passkey prompt opens by itself once per visit to this screen, as soon as the page is in front (Safari lets a
  // page start it without a tap since iOS 17.4). Not after signing out here: that would ask again at once.
  const asked = useRef(false);
  const ready = supported && status.data?.hasPasskey === true && !status.data.setupOpen;
  useEffect(() => {
    if (!ready || asked.current) return;
    const go = () => {
      if (asked.current || document.visibilityState !== 'visible') return;
      asked.current = true;
      if (!takeSignedOutHere()) signIn(true);
    };
    go();
    document.addEventListener('visibilitychange', go);
    return () => document.removeEventListener('visibilitychange', go);
  }, [ready]);

  if (status.data?.setupOpen) {
    return (
      <Frame title="Set up sign-in">
        <p className="m-0 text-base leading-relaxed text-ink-2">
          Ledgerline uses a passkey, not a password. Enter your setup code.
        </p>
        {!supported && <NoPasskeys />}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void ceremony(() => addPasskey({ setupCode: code.trim() }, deviceName())).then((m) => {
              setBusy(false);
              setErr(m);
              if (!m) done();
            });
          }}
        >
          <Field label="Setup code">
            <input
              className={inputClass}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <Problem text={err} />
          <PrimaryButton type="submit" busy={busy} disabled={busy || !supported || code.trim().length === 0}>
            {busy ? 'Waiting for your passkey…' : 'Create passkey'}
          </PrimaryButton>
        </form>
      </Frame>
    );
  }
  // A locked budget's recovery key (docs/privacy-keys.md 4.2): open to every account, with or without sign-up.
  if (mode === 'recovery-key') return <RecoveryKeySignInScreen onBack={() => setMode('signin')} />;
  if (siteKey && mode === 'create')
    return <CreateAccountScreen siteKey={siteKey} onBack={() => setMode('signin')} />;
  return (
    <Frame title="Sign in">
      <p className="m-0 text-base leading-relaxed text-ink-2">Use the passkey on this device.</p>
      {!supported && <NoPasskeys />}
      {status.data && !status.data.hasPasskey && (
        <Problem text="Sign-in isn’t set up yet. Add a setup code, then reload this page." />
      )}
      <Problem text={err} />
      <PrimaryButton
        busy={busy}
        disabled={busy || !supported || status.data?.hasPasskey === false}
        onClick={() => signIn(false)}
      >
        {busy ? 'Waiting for your passkey…' : 'Sign in with passkey'}
      </PrimaryButton>
      <p className="m-0 text-sm leading-snug text-muted">
        New device? On a signed-in device, go to Settings → Sign-in and devices → Add a device.
      </p>
      {siteKey && (
        <SecondaryButton disabled={!supported} onClick={() => setMode('create')}>
          Create account
        </SecondaryButton>
      )}
      {status.data?.hasPasskey && (
        <SecondaryButton disabled={!supported} onClick={() => setMode('recovery-key')}>
          Use your recovery key
        </SecondaryButton>
      )}
    </Frame>
  );
}

/** Opened from a single-use link made in Settings on a signed-in device. */
export function AddDeviceScreen() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    // Keep the token out of history once read.
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }, []);
  if (ok)
    return (
      <Frame title="This device is set up">
        <p className="m-0 text-base text-ink-2">
          You’re signed in. Next time, sign in with this device’s passkey.
        </p>
        <PrimaryButton onClick={() => window.location.assign('/budget')}>Open Ledgerline</PrimaryButton>
      </Frame>
    );
  return (
    <Frame title="Add this device">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        Create a passkey to sign in on this device. The link works once, for 10 minutes.
      </p>
      {!browserSupportsWebAuthn() && <NoPasskeys />}
      {!token && (
        <Problem text="This link is missing its code. Make a new one in Settings → Sign-in and devices." />
      )}
      <Problem text={err} />
      <PrimaryButton
        busy={busy}
        disabled={busy || !token}
        onClick={() => {
          setBusy(true);
          void ceremony(() => addPasskey({ deviceToken: token }, deviceName())).then((m) => {
            setBusy(false);
            setErr(m);
            if (!m) setOk(true);
          });
        }}
      >
        {busy ? 'Waiting for your passkey…' : 'Create passkey'}
      </PrimaryButton>
    </Frame>
  );
}

/**
 * "Confirm it's you": linking a bank, exporting and changing passkeys need a passkey check within 15 minutes. The
 * refused request waits here (api/client.ts setPasskeyCheck) and goes ahead by itself once the passkey is used.
 */
export function ReauthDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);
  const close = (ok: boolean) => {
    setOpen(false);
    answer.current?.(ok);
    answer.current = null;
  };
  useEffect(() => {
    const ask = () =>
      new Promise<boolean>((resolve) => {
        answer.current?.(false);
        answer.current = resolve;
        setErr(null);
        setBusy(false);
        setOpen(true);
      });
    setPasskeyCheck(ask);
    return () => {
      setPasskeyCheck(null);
      answer.current?.(false);
      answer.current = null;
    };
  }, []);
  if (!open) return null;
  return (
    <div className="ll-scrim fixed inset-0 z-50 flex items-end justify-center bg-scrim p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reauth-title"
        className="flex w-full max-w-[400px] flex-col gap-3 rounded-lg bg-surface p-5 shadow-overlay"
      >
        <h2 id="reauth-title" className="m-0 text-2xl font-bold">
          Confirm it’s you
        </h2>
        <p className="m-0 text-base leading-relaxed text-ink-2">Use your passkey to continue.</p>
        <Problem text={err} />
        <PrimaryButton
          busy={busy}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void ceremony(signInWithPasskey).then((m) => {
              setBusy(false);
              setErr(m);
              if (!m) close(true);
            });
          }}
        >
          {busy ? 'Waiting for your passkey…' : 'Use passkey'}
        </PrimaryButton>
        <SecondaryButton disabled={busy} onClick={() => close(false)}>
          Not now
        </SecondaryButton>
      </div>
    </div>
  );
}
