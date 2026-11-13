// Open sign-up (D-75, docs/open-signup.md 3): Create account from the Sign in screen. The robot check runs on its
// own address (docs/privacy.md 5.6, D-113), then a passkey makes the account. The new account's budget is then made
// on this device, locked, with its recovery key (the lock screen, Setup.tsx; D-102). The server shows none of this
// until the SIGNUPS switch is on.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Frame, Problem } from '../components/Frame';
import { PrimaryButton, SecondaryButton } from '../components/ui';
import { passkeyName } from '../lib/device-name';
import { passkeyProblem } from '../copy/passkey';
import { PolicyLink } from './PolicyLink';

/** Losing both is final: said before the passkey, and again with the recovery key (docs/open-signup.md 3.1). */
const NO_WAY_BACK =
  'If you lose every passkey and your recovery key, you can’t get back into your budget. No one can recover it for you.';

/**
 * The robot check runs on its own address (docs/privacy.md 5.6): this app never loads an outside script. Create
 * account goes there, and the check sends the browser back to sign-in with a one-use token in the address's
 * fragment (`#check=…`), which no server sees. Read once, then taken out of the address.
 */
export function takeCheckToken(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith('#check=')) return null;
  history.replaceState(history.state, '', window.location.pathname + window.location.search);
  const t = new URLSearchParams(hash.slice(1)).get('check');
  return t && t.length <= 2048 ? t : null;
}

/** Go to the robot check's address. */
export function goToCheck(checkUrl: string): void {
  window.location.assign(checkUrl);
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

/**
 * Create account, back from the robot check with its token: a passkey and nothing else (no name, no email: D-85).
 * Cloudflare takes a token once, so after a try that fails the check is done again.
 */
export function CreateAccountScreen({
  checkUrl,
  token: first,
  onBack,
}: {
  checkUrl: string;
  token: string | null;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(first);
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
          setToken(null);
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
        <Problem text={err} />
        {token || busy ? (
          <PrimaryButton type="submit" busy={busy} disabled={busy}>
            {busy ? 'Waiting for your passkey…' : 'Create passkey'}
          </PrimaryButton>
        ) : (
          <PrimaryButton type="button" data-track="signup.check.again" onClick={() => goToCheck(checkUrl)}>
            Do the robot check again
          </PrimaryButton>
        )}
        <SecondaryButton type="button" onClick={onBack}>
          Back
        </SecondaryButton>
      </form>
      <PolicyLink from="/budget" />
    </Frame>
  );
}
