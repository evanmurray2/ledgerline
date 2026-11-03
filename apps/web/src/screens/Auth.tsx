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
  cx,
} from '../components/ui';
import { toast } from '../components/Toast';
import { clearSavedData } from '../state/saved';
import { signIn as copySignIn, signOutHere } from '../copy/copy';

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
    return 'Your browser couldn’t use a passkey. Try again.';
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

export function SignInScreen() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: qk.authStatus, queryFn: api.authStatus, retry: 1 });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: qk.session });
  const supported = browserSupportsWebAuthn();

  if (status.data?.setupOpen) {
    return (
      <Frame title="Set up sign-in">
        <p className="m-0 text-[15px] leading-relaxed text-ink-2">
          Ledgerline signs you in with a passkey: Face ID, Touch ID, Windows Hello or your phone’s screen
          lock. There’s no password. Enter the setup code you saved as the <code>SETUP_CODE</code> secret to
          create your first passkey.
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
          <PrimaryButton type="submit" disabled={busy || !supported || code.trim().length === 0}>
            {busy ? 'Waiting for your passkey…' : 'Create passkey'}
          </PrimaryButton>
        </form>
      </Frame>
    );
  }
  return (
    <Frame title="Sign in">
      <p className="m-0 text-[15px] leading-relaxed text-ink-2">
        Use the passkey on this device. Your session lasts 24 hours.
      </p>
      {!supported && <NoPasskeys />}
      {status.data && !status.data.hasPasskey && (
        <Problem text="Sign-in isn’t set up yet. Set the SETUP_CODE secret on the Worker, then reload this page." />
      )}
      <Problem text={err} />
      <PrimaryButton
        disabled={busy || !supported || status.data?.hasPasskey === false}
        onClick={() => {
          setBusy(true);
          void ceremony(signInWithPasskey).then((m) => {
            setBusy(false);
            setErr(m);
            if (!m) done();
          });
        }}
      >
        {busy ? 'Waiting for your passkey…' : 'Sign in with passkey'}
      </PrimaryButton>
      <p className="m-0 text-[13px] leading-snug text-muted">
        New phone or computer? On a device that’s signed in, go to Settings → Sign-in → Add a device.
      </p>
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
        <p className="m-0 text-[15px] text-ink-2">
          You’re signed in. Next time, sign in with this device’s passkey.
        </p>
        <PrimaryButton onClick={() => window.location.assign('/budget')}>Open Ledgerline</PrimaryButton>
      </Frame>
    );
  return (
    <Frame title="Add this device">
      <p className="m-0 text-[15px] leading-relaxed text-ink-2">
        Create a passkey on this device so you can sign in here. The link works once, for 10 minutes.
      </p>
      {!browserSupportsWebAuthn() && <NoPasskeys />}
      {!token && <Problem text="This link is missing its code. Make a new one in Settings → Sign-in." />}
      <Problem text={err} />
      <PrimaryButton
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
        className="flex w-full max-w-[400px] flex-col gap-3 rounded-2xl bg-surface p-5 shadow-lg"
      >
        <h2 id="reauth-title" className="m-0 text-[19px] font-bold">
          Confirm it’s you
        </h2>
        <p className="m-0 text-[15px] leading-relaxed text-ink-2">
          Linking a bank, exporting your data and changing passkeys need a quick passkey check. Then it
          carries on by itself.
        </p>
        <Problem text={err} />
        <PrimaryButton
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

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : 'never';

/** Settings → Sign-in. */
export function SignInSection() {
  const qc = useQueryClient();
  const sec = useQuery({ queryKey: ['security'], queryFn: api.security });
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
          <span className="text-[15px] font-semibold">Passkeys</span>
          <span className="text-[13px] leading-snug text-muted">
            Sign-in uses a passkey on your device, with no password.
          </span>
        </div>
        {keys.map((k) => (
          <div key={k.id} className="flex flex-col border-t border-divider">
            <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{k.name}</span>
                <span className="text-[12px] text-muted">
                  Added {when(k.createdAt)} · last used {when(k.lastUsedAt)}
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
      {link ? (
        <Card className="flex flex-col gap-2 p-3">
          <span className="text-[15px] font-semibold">Open this link on the new device</span>
          <input
            readOnly
            className={cx(inputClass, 'text-[13px]')}
            value={link.url}
            aria-label="Device link"
          />
          <span className="text-[12px] text-muted">
            It works once, until{' '}
            {new Date(link.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.
            Send it to yourself with AirDrop or a message to yourself, not to anyone else.
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
      {/* One other device has its own Sign out above; this is for several at once. */}
      {(sec.data?.otherSessions ?? 0) > 1 &&
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
            Sign out {sec.data?.otherSessions} other devices? It deletes the budget saved on them. This device
            stays signed in.
          </ConfirmInline>
        ) : (
          <div className="flex flex-col gap-1.5">
            <SecondaryButton
              className="lg:self-start lg:px-6"
              track="settings.sign_out_others"
              onClick={() => setAsking('others')}
            >
              Sign out other devices…
            </SecondaryButton>
            <span className="px-0.5 text-[12px] leading-snug text-muted">
              Signs out {sec.data?.otherSessions} other devices and deletes the budget saved on them. This
              device stays signed in.
            </span>
          </div>
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
                await (import.meta.env.VITE_MOCK === '1' ? api.signOut() : signOutHere());
              },
              () => window.location.assign('/'),
            )
          }
          onCancel={() => setAsking(null)}
        >
          Sign out of this device? It also deletes the budget saved on this device. Your budget stays on the
          server: sign in again with your passkey to get it back.
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
    locked: boolean;
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
        <span className="text-[15px] font-semibold">Signed in</span>
        <span className="text-[13px] leading-snug text-muted">
          Each sign-in lasts 24 hours. A phone with your budget saved on it stays here while it’s locked.
          Signing a device out deletes the budget saved on it.
        </span>
      </div>
      {sorted.map((x) => (
        <div key={x.id} className="flex flex-col border-t border-divider">
          <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{x.name}</span>
              <span className="text-[12px] text-muted">
                {x.locked ? `Locked since ${at(x.signedInAt)}` : `Signed in ${at(x.signedInAt)}`}
                {x.saved ? ' · budget saved' : ''}
              </span>
            </span>
            {x.current ? (
              <span className="shrink-0 px-3 text-[13px] font-semibold text-muted">This device</span>
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
