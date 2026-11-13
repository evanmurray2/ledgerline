// Open sign-up and recovery codes (D-75, docs/open-signup.md 3–4): Create account and Use a recovery code from the
// Sign in screen, the recovery code shown once, a new code in Settings → Sign-in and devices, and the notice after a recovery.
// The server shows none of this until the SIGNUPS switch is on.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { qk, useSession } from '../api/hooks';
import { Frame, Problem } from '../components/Frame';
import {
  Banner,
  Card,
  Checkbox,
  Field,
  PrimaryButton,
  SecondaryButton,
  SoftButton,
  inputClass,
} from '../components/ui';
import { toast } from '../components/Toast';
import { passkeyName } from '../lib/device-name';

/** Losing both is final: said before the passkey and again with the code (docs/open-signup.md 3.1). */
const NO_WAY_BACK =
  'If you lose every passkey and your recovery code, you can’t get back into your budget. No one can recover it for you.';

/** Cloudflare's Turnstile test site keys pass or fail without loading anything (local runs and e2e). */
const TEST_KEY = /^[123]x0{20}AA$/;
const TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

interface TurnstileApi {
  render(
    el: HTMLElement,
    o: {
      sitekey: string;
      action: string;
      callback: (t: string) => void;
      'error-callback': () => void;
      'expired-callback': () => void;
    },
  ): string;
  remove(id: string): void;
}

/** Said when the check can't load or fails: otherwise the button stays gray with no reason. */
export const CHECK_FAILED = 'The robot check couldn’t load. Check your connection, then try the check again.';
/** How long the check may take to show before the screen says it couldn't load. */
const CHECK_WAIT_MS = 20_000;

/**
 * Cloudflare Turnstile: a token for `action`, or null until the check passes. When its script is blocked or
 * offline, or the check fails, it says so and offers to try again.
 */
function Turnstile({
  siteKey,
  action,
  onToken,
}: {
  siteKey: string;
  action: string;
  onToken: (t: string | null) => void;
}) {
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (TEST_KEY.test(siteKey)) {
      onToken(siteKey.startsWith('1x') ? TEST_TOKEN : 'fails');
      return;
    }
    let id: string | null = null;
    let over = false;
    const fail = () => {
      if (over) return;
      over = true;
      onToken(null);
      setFailed(true);
    };
    const w = window as unknown as { turnstile?: TurnstileApi };
    const draw = () => {
      if (!box.current || !w.turnstile) return fail();
      try {
        id = w.turnstile.render(box.current, {
          sitekey: siteKey,
          action,
          callback: (t) => {
            over = true;
            onToken(t);
          },
          'error-callback': fail,
          'expired-callback': () => onToken(null),
        });
      } catch {
        fail();
      }
    };
    // Blocked or slow: the check never shows, so say so instead of waiting for ever.
    const timer = setTimeout(() => {
      if (!id) fail();
    }, CHECK_WAIT_MS);
    if (w.turnstile) draw();
    else {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = draw;
      s.onerror = () => {
        s.remove();
        fail();
      };
      document.head.appendChild(s);
    }
    return () => {
      over = true;
      clearTimeout(timer);
      if (id && w.turnstile) w.turnstile.remove(id);
    };
  }, [siteKey, action, tries]);
  if (failed)
    return (
      <div className="flex flex-col gap-3">
        <Problem text={CHECK_FAILED} />
        <SecondaryButton
          type="button"
          data-track="signup.check.retry"
          onClick={() => {
            setFailed(false);
            setTries((n) => n + 1);
          }}
        >
          Try the check again
        </SecondaryButton>
      </div>
    );
  return <div ref={box} />;
}

async function register(options: unknown): Promise<string | null> {
  const response = await startRegistration({
    optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
  });
  const r = await api.registerVerify({ response, name: passkeyName() });
  return r.recoveryCode ?? null;
}

function problem(e: unknown): string {
  if (e instanceof ApiError) return errorMessage(e);
  const name = (e as { name?: string }).name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'Cancelled. Try again when you’re ready.';
  if (name === 'InvalidStateError') return 'This device already has a Ledgerline passkey.';
  return 'Couldn’t use your passkey. Try again.';
}

/** The recovery code, shown once, with Copy; Continue waits for the tick. */
export function RecoveryCodeView({
  code,
  onDone,
  done = 'Continue',
}: {
  code: string;
  onDone: () => void;
  done?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        This code lets you add a passkey if you lose yours. It’s shown only now.
      </p>
      <Card>
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <span data-testid="recovery-code" className="text-lg font-bold tracking-wide break-all">
            {code}
          </span>
          <SoftButton
            onClick={() =>
              void navigator.clipboard?.writeText(code).then(
                () => toast.show({ text: 'Copied' }),
                () => undefined,
              )
            }
          >
            Copy
          </SoftButton>
        </div>
      </Card>
      <Banner tone="warn">{NO_WAY_BACK}</Banner>
      <label className="flex items-start gap-2.5 text-base text-ink-2">
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>
          I saved my recovery code. I understand that without it and my passkeys, my budget is lost.
        </span>
      </label>
      <PrimaryButton disabled={!saved} why={saved ? '' : 'Save your code first'} onClick={onDone}>
        {done}
      </PrimaryButton>
    </div>
  );
}

/** Create account: the check, then a passkey and nothing else (no name, no email: D-85); then the recovery code. */
export function CreateAccountScreen({ siteKey, onBack }: { siteKey: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  if (code)
    return (
      <Frame title="Save your recovery code">
        <RecoveryCodeView code={code} onDone={() => void qc.invalidateQueries({ queryKey: qk.session })} />
      </Frame>
    );
  return (
    <Frame title="Create account">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        Ledgerline uses a passkey, not a password. {NO_WAY_BACK}
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!token) return;
          setBusy(true);
          setErr(null);
          api
            .signupOptions({ turnstileToken: token })
            .then(register)
            .then(
              (c) => {
                setBusy(false);
                if (c) setCode(c);
                else void qc.invalidateQueries({ queryKey: qk.session });
              },
              (x: unknown) => {
                setBusy(false);
                setErr(problem(x));
              },
            );
        }}
      >
        <Turnstile siteKey={siteKey} action="signup" onToken={setToken} />
        <Problem text={err} />
        <PrimaryButton type="submit" busy={busy} disabled={busy || !token}>
          {busy ? 'Waiting for your passkey…' : 'Create passkey'}
        </PrimaryButton>
        <SecondaryButton type="button" onClick={onBack}>
          Back
        </SecondaryButton>
      </form>
    </Frame>
  );
}

/** Use a recovery code: the code and the check, then a new passkey; then the new code. */
export function RecoverScreen({ siteKey, onBack }: { siteKey: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  if (code)
    return (
      <Frame title="Save your new recovery code">
        <p className="m-0 text-base leading-relaxed text-ink-2">Your old code no longer works.</p>
        <RecoveryCodeView code={code} onDone={() => void qc.invalidateQueries({ queryKey: qk.session })} />
      </Frame>
    );
  return (
    <Frame title="Use a recovery code">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        Enter your code to add a passkey on this device.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!token) return;
          setBusy(true);
          setErr(null);
          api
            .recoverOptions({ code: typed, turnstileToken: token })
            .then(register)
            .then(
              (c) => {
                setBusy(false);
                if (c) setCode(c);
              },
              (x: unknown) => {
                setBusy(false);
                setErr(problem(x));
              },
            );
        }}
      >
        <Field label="Recovery code">
          <input
            className={inputClass}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
          />
        </Field>
        <Turnstile siteKey={siteKey} action="recover" onToken={setToken} />
        <Problem text={err} />
        <PrimaryButton type="submit" busy={busy} disabled={busy || !token || typed.trim().length === 0}>
          {busy ? 'Waiting for your passkey…' : 'Create passkey'}
        </PrimaryButton>
        <SecondaryButton type="button" onClick={onBack}>
          Back
        </SecondaryButton>
      </form>
    </Frame>
  );
}

/** Settings → Sign-in and devices: a new recovery code (users who aren't admins). */
export function RecoveryCodeCard() {
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card>
      <div className="flex flex-col gap-2 px-3 py-3">
        <span className="text-base font-semibold">Recovery code</span>
        {code ? (
          <RecoveryCodeView code={code} done="Done" onDone={() => setCode(null)} />
        ) : (
          <>
            <span className="text-sm text-muted">A new code replaces your old one.</span>
            <Problem text={err} />
            <SecondaryButton
              className="self-start"
              onClick={() => {
                setErr(null);
                api.newRecoveryCode().then(
                  (r) => setCode(r.code),
                  (e: unknown) => {
                    if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
                  },
                );
              }}
            >
              New recovery code
            </SecondaryButton>
          </>
        )}
      </div>
    </Card>
  );
}

/** For 14 days after a recovery code was used, every sign-in shows this until dismissed. */
export function RecoveryNotice() {
  const session = useSession();
  const qc = useQueryClient();
  const at = session.data?.recoveryNoticeAt;
  if (!at) return null;
  const day = new Date(at).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  return (
    <Banner
      tone="warn"
      role="alert"
      className="mx-4 mt-3"
      title={`Your recovery code was used on ${day}`}
      action={
        <SoftButton
          onClick={() =>
            void api.dismissRecoveryNotice().then(() => qc.invalidateQueries({ queryKey: qk.session }))
          }
        >
          This was me
        </SoftButton>
      }
    >
      If this wasn’t you, remove the passkeys you don’t know in Settings → Sign-in and devices.
    </Banner>
  );
}
