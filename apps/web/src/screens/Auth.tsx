// Passkey sign-in (decisions.md D-27): first-time setup with the setup code, signing in, adding a device from a
// single-use link, the "Confirm it's you" check before linking a bank or exporting, and Settings → Sign-in.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, errorMessage, setPasskeyCheck } from '../api/client';
import { api } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Frame, Problem } from '../components/Frame';
import {
  Card,
  ConfirmInline,
  DangerLink,
  Field,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  inputClass,
} from '../components/ui';
import { toast } from '../components/Toast';
import { clearSavedData } from '../state/saved';
import { signIn as copySignIn, signOutHere } from '../copy/copy';
import { CreateAccountScreen, RecoverScreen, RecoveryCodeCard } from './Signup';
import { DeleteAccountCard } from './settings/People';

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

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  return 'This device';
}

const NoPasskeys = () => (
  <Problem text="This browser can’t use passkeys. Open Ledgerline in Safari, Chrome, Edge or Firefox." />
);

/** Set when you sign out of this device, so the Sign in screen that follows doesn't ask for Face ID by itself. */
const SIGNED_OUT_HERE = 'ledgerline-signed-out-here';

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
  /** Open sign-up (D-75): Create account and Use a recovery code, only once the server turns them on. */
  const [mode, setMode] = useState<'signin' | 'create' | 'recover'>('signin');
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
  if (siteKey && mode === 'create')
    return <CreateAccountScreen siteKey={siteKey} onBack={() => setMode('signin')} />;
  if (siteKey && mode === 'recover')
    return <RecoverScreen siteKey={siteKey} onBack={() => setMode('signin')} />;
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
        New device? On a signed-in device, go to Settings → Sign-in → Add a device.
      </p>
      {siteKey && (
        <>
          <SecondaryButton disabled={!supported} onClick={() => setMode('create')}>
            Create account
          </SecondaryButton>
          <SecondaryButton disabled={!supported} onClick={() => setMode('recover')}>
            Use a recovery code
          </SecondaryButton>
        </>
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
      {!token && <Problem text="This link is missing its code. Make a new one in Settings → Sign-in." />}
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

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Settings → Sign-in. */
export function SignInSection() {
  const qc = useQueryClient();
  const sec = useQuery({ queryKey: ['security'], queryFn: api.security });
  const listedOthers = (sec.data?.signIns ?? []).filter((x) => !x.current).length;
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The removal being confirmed: 'passkey:<id>', 'session:<id>', 'others' or 'here'. */
  const [asking, setAsking] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['security'] });
  const run = (fn: () => Promise<unknown>, done?: (r: unknown) => void) => {
    setErr(null);
    fn().then(
      (r) => {
        done?.(r);
        refresh();
      },
      (e: unknown) => {
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
      },
    );
  };
  const keys = sec.data?.passkeys ?? [];
  return (
    <>
      <SectionTitle>Sign-in</SectionTitle>
      <Card>
        <div className="flex flex-col gap-1 px-3 py-3">
          <span className="text-base font-semibold">Passkeys</span>
        </div>
        {keys.map((k) => (
          <div key={k.id} className="flex flex-col border-t border-divider">
            <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold">{k.name}</span>
                <span className="text-xs text-muted">
                  Added {when(k.createdAt)} ·{' '}
                  {k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : 'not used yet'}
                </span>
              </span>
              {keys.length > 1 && asking !== `passkey:${k.id}` && (
                <DangerLink
                  track="settings.passkey.remove"
                  onClick={() => setAsking(`passkey:${k.id}`)}
                  aria-label={`Remove passkey ${k.name}…`}
                  className="shrink-0 self-center"
                >
                  Remove…
                </DangerLink>
              )}
            </div>
            {asking === `passkey:${k.id}` && (
              <ConfirmInline
                label={`Remove passkey ${k.name}`}
                confirmLabel="Remove"
                track="settings.passkey.remove.confirm"
                mutates={false}
                onConfirm={() =>
                  run(
                    () => api.removePasskey(k.id),
                    () => setAsking(null),
                  )
                }
                onCancel={() => setAsking(null)}
                className="mx-3 mb-3"
              >
                Remove the passkey {k.name}? That device can’t sign in with it any more.
              </ConfirmInline>
            )}
          </div>
        ))}
      </Card>
      {sec.data?.recoveryCode && <RecoveryCodeCard />}
      {sec.data?.recoveryCode && <DeleteAccountCard />}
      {link ? (
        <Card className="flex flex-col gap-2 p-3">
          <span className="text-base font-semibold">Open this link on the new device</span>
          <input readOnly className={inputClass} value={link.url} aria-label="Device link" />
          <span className="text-xs text-muted">
            It works once, until{' '}
            {new Date(link.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.
            Send it only to yourself.
          </span>
          <SecondaryButton
            onClick={() =>
              void navigator.clipboard?.writeText(link.url).then(
                () => toast.show({ text: 'Link copied' }),
                () => undefined,
              )
            }
          >
            Copy link
          </SecondaryButton>
        </Card>
      ) : (
        <SecondaryButton
          className="lg:self-start lg:px-6"
          track="settings.passkey.add_device"
          onClick={() => run(api.deviceLink, (r) => setLink(r as { url: string; expiresAt: string }))}
        >
          Add a device
        </SecondaryButton>
      )}
      <Problem text={err} />
      <SignIns signIns={sec.data?.signIns ?? []} run={run} asking={asking} setAsking={setAsking} />
      {/* One other device listed has its own Sign out above; this is for several at once, and for devices that are
          signed out but still have the budget saved (not listed). */}
      {(sec.data?.otherSessions ?? 0) > Math.min(1, listedOthers) &&
        (asking === 'others' ? (
          <ConfirmInline
            label="Sign out other devices"
            confirmLabel="Sign out"
            track="settings.sign_out_others.confirm"
            mutates={false}
            onConfirm={() =>
              run(api.signOutOthers, () => {
                setAsking(null);
                toast.show({ text: 'Your other devices are signed out' });
              })
            }
            onCancel={() => setAsking(null)}
          >
            Sign out your other devices and delete the budget saved on them? This device stays signed in.
          </ConfirmInline>
        ) : (
          <SecondaryButton
            className="lg:self-start lg:px-6"
            track="settings.sign_out_others"
            onClick={() => setAsking('others')}
          >
            Sign out other devices…
          </SecondaryButton>
        ))}
      {asking === 'here' ? (
        <ConfirmInline
          label="Sign out of this device"
          confirmLabel="Sign out"
          track="settings.sign_out.confirm"
          mutates={false}
          onConfirm={() =>
            run(
              async () => {
                // The budget saved on this phone is deleted first (D-45), then the sign-in ends.
                clearSavedData();
                try {
                  sessionStorage.setItem(SIGNED_OUT_HERE, '1');
                } catch {
                  // Without it, the Sign in screen just asks for Face ID by itself.
                }
                await (import.meta.env.VITE_MOCK === '1' ? api.signOut() : signOutHere());
              },
              () => window.location.assign('/'),
            )
          }
          onCancel={() => setAsking(null)}
        >
          Sign out and delete the budget saved on this device? Sign in with your passkey to get it back.
        </ConfirmInline>
      ) : (
        <SecondaryButton
          danger
          className="lg:self-start lg:px-6"
          track="settings.sign_out"
          onClick={() => setAsking('here')}
        >
          Sign out of this device…
        </SecondaryButton>
      )}
    </>
  );
}

/** Where you're signed in, this device first: each other sign-in can be ended here. */
function SignIns({
  signIns,
  run,
  asking,
  setAsking,
}: {
  signIns: {
    id: string;
    name: string;
    signedInAt: string;
    current: boolean;
    saved: boolean;
  }[];
  run: (fn: () => Promise<unknown>, then?: () => void) => void;
  asking: string | null;
  setAsking: (v: string | null) => void;
}) {
  if (!signIns.length) return null;
  const sorted = [...signIns.filter((x) => x.current), ...signIns.filter((x) => !x.current)];
  const at = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  return (
    <Card>
      <div className="flex flex-col gap-1 px-3 py-3">
        <span className="text-base font-semibold">Signed in</span>
        <span className="text-sm leading-snug text-muted">
          A sign-in ends after 10 idle minutes, or after 24 hours.
        </span>
      </div>
      {sorted.map((x) => (
        <div key={x.id} className="flex flex-col border-t border-divider">
          <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-semibold">{x.name}</span>
              <span className="text-xs text-muted">
                {`Signed in ${at(x.signedInAt)}`}
                {x.saved ? ' · budget saved' : ''}
              </span>
            </span>
            {x.current ? (
              <span className="shrink-0 px-3 text-sm font-semibold text-muted">This device</span>
            ) : (
              asking !== `session:${x.id}` && (
                <DangerLink
                  track="settings.sign_in.sign_out"
                  onClick={() => setAsking(`session:${x.id}`)}
                  aria-label={`Sign out ${x.name}…`}
                  className="shrink-0 self-center whitespace-nowrap"
                >
                  Sign out…
                </DangerLink>
              )
            )}
          </div>
          {!x.current && asking === `session:${x.id}` && (
            <ConfirmInline
              label={`Sign out ${x.name}`}
              confirmLabel="Sign out"
              track="settings.sign_in.sign_out.confirm"
              mutates={false}
              onConfirm={() =>
                run(
                  () => api.signOutSession(x.id),
                  () => {
                    setAsking(null);
                    toast.show({ text: `${x.name} is signed out` });
                  },
                )
              }
              onCancel={() => setAsking(null)}
              className="mx-3 mb-3"
            >
              Sign out {x.name}? It also deletes the budget saved on it.
            </ConfirmInline>
          )}
        </div>
      ))}
    </Card>
  );
}
