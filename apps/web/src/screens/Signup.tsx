// Open sign-up (D-75, docs/open-signup.md 3): Create account from the Sign in screen. The new account's budget is
// then made on this device, locked, with its recovery key (the lock screen, Setup.tsx; D-102). The server shows
// none of this until the SIGNUPS switch is on.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Frame, Problem } from '../components/Frame';
import { PrimaryButton, SecondaryButton } from '../components/ui';
import { passkeyName } from '../lib/device-name';
import { passkeyProblem } from '../copy/passkey';

/** Losing both is final: said before the passkey, and again with the recovery key (docs/open-signup.md 3.1). */
const NO_WAY_BACK =
  'If you lose every passkey and your recovery key, you can’t get back into your budget. No one can recover it for you.';

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

async function register(options: unknown): Promise<void> {
  const response = await startRegistration({
    optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
  });
  await api.registerVerify({ response, name: passkeyName() });
}

function problem(e: unknown): string {
  if (e instanceof ApiError) return errorMessage(e);
  return passkeyProblem(e) ?? 'Couldn’t use your passkey. Try again.';
}

/** Create account: the check, then a passkey and nothing else (no name, no email: D-85). */
export function CreateAccountScreen({ siteKey, onBack }: { siteKey: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
              () => {
                setBusy(false);
                void qc.invalidateQueries({ queryKey: qk.session });
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
