// Settings → Sign-in and devices (decisions.md D-27): this device, your other devices (sign out one or all, add one)
// and your passkeys. Sign out of this device is the last row of Settings (the phone's Settings home, the computer's
// Settings list), apart from the other devices so the two can't be mixed up.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { Problem } from '../../components/Frame';
import {
  Button,
  Card,
  ConfirmInline,
  DangerLink,
  Icon,
  SecondaryButton,
  SectionTitle,
  inputClass,
} from '../../components/ui';
import { toast } from '../../components/Toast';
import { useScreen } from '../../lib/common';
import { clearSavedData } from '../../state/saved';
import { signOutHere } from '../../copy/copy';
import { SIGNED_OUT_HERE } from '../Auth';
import { RecoveryCodeCard } from '../Signup';
import { DeleteAccountCard } from './People';
import { Page } from './common';

type SignIn = { id: string; name: string; signedInAt: string; current: boolean; saved: boolean };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const at = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const useSecurity = () => useQuery({ queryKey: ['security'], queryFn: api.security });

/** The meta line under "Sign-in and devices" in the Settings list: "2 devices signed in · 1 passkey". */
export function signInMeta(data: ReturnType<typeof useSecurity>['data']): string {
  if (!data) return 'Passkeys and devices';
  return `${plural(data.signIns.length, 'device', 'devices')} signed in · ${plural(data.passkeys.length, 'passkey', 'passkeys')}`;
}

export function SignInSettingsScreen() {
  useScreen('settings.signin');
  const qc = useQueryClient();
  const sec = useSecurity();
  const [err, setErr] = useState<string | null>(null);
  /** The removal being confirmed: 'passkey:<id>', 'session:<id>' or 'others'. */
  const [asking, setAsking] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>, done?: (r: unknown) => void) => {
    setErr(null);
    fn().then(
      (r) => {
        done?.(r);
        void qc.invalidateQueries({ queryKey: ['security'] });
      },
      (e: unknown) => {
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
      },
    );
  };
  const signIns = sec.data?.signIns ?? [];
  const here = signIns.find((x) => x.current);
  return (
    <Page title="Sign-in and devices" back="/settings">
      <Problem text={err} />
      {here && (
        <>
          <SectionTitle>This device</SectionTitle>
          <Card>
            <div className="flex min-h-14 flex-col justify-center gap-0.5 px-3 py-2">
              <span className="text-base font-semibold">{here.name}</span>
              <span className="text-xs text-muted">Signed in {at(here.signedInAt)}</span>
            </div>
          </Card>
        </>
      )}
      <SectionTitle>Other devices</SectionTitle>
      <OtherDevices
        others={signIns.filter((x) => !x.current)}
        hidden={sec.data?.otherSessions ?? 0}
        run={run}
        asking={asking}
        setAsking={setAsking}
      />
      <p className="m-0 px-0.5 text-sm leading-snug text-muted">
        A sign-in ends after 10 idle minutes, or after 24 hours.
      </p>
      <SectionTitle>Passkeys</SectionTitle>
      <Passkeys keys={sec.data?.passkeys ?? []} run={run} asking={asking} setAsking={setAsking} />
      <p className="m-0 px-0.5 text-sm leading-snug text-muted">
        A passkey saved in iCloud Keychain works on all your Apple devices.
      </p>
      {sec.data?.recoveryCode && (
        <>
          <SectionTitle>Account</SectionTitle>
          <RecoveryCodeCard />
          <DeleteAccountCard />
        </>
      )}
    </Page>
  );
}

type Run = (fn: () => Promise<unknown>, done?: (r: unknown) => void) => void;
type Asking = { asking: string | null; setAsking: (v: string | null) => void };

/** Each other device with its own Sign out, one Sign out for all of them, and Add a device. */
function OtherDevices({
  others,
  hidden,
  run,
  asking,
  setAsking,
}: { others: SignIn[]; hidden: number; run: Run } & Asking) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  // "All" is for several at once, and for devices that are signed out but still have the budget saved (not listed).
  const showAll = hidden > Math.min(1, others.length);
  return (
    <Card>
      {others.length === 0 && (
        <p className="m-0 px-3 py-3 text-sm leading-snug text-muted">
          No other devices. Add one to use Ledgerline on a computer or iPad.
        </p>
      )}
      {others.map((x) => (
        <div key={x.id} className="flex flex-col border-t border-divider first:border-t-0">
          <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-semibold">{x.name}</span>
              <span className="text-xs text-muted">
                {`Signed in ${at(x.signedInAt)}`}
                {x.saved ? ' · budget saved' : ''}
              </span>
            </span>
            {asking !== `session:${x.id}` && (
              <DangerLink
                track="settings.sign_in.sign_out"
                onClick={() => setAsking(`session:${x.id}`)}
                aria-label={`Sign out ${x.name}…`}
                className="shrink-0 self-center whitespace-nowrap"
              >
                Sign out…
              </DangerLink>
            )}
          </div>
          {asking === `session:${x.id}` && (
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
      {showAll &&
        (asking === 'others' ? (
          <ConfirmInline
            label="Sign out all other devices"
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
            className="m-3"
          >
            Sign out your other devices and delete the budget saved on them? This device stays signed in.
          </ConfirmInline>
        ) : (
          <div className="flex min-h-12 items-center border-t border-divider px-3 first:border-t-0">
            <DangerLink track="settings.sign_out_others" onClick={() => setAsking('others')}>
              Sign out all other devices…
            </DangerLink>
          </div>
        ))}
      {link ? (
        <div className="flex flex-col gap-2 border-t border-divider p-3 first:border-t-0">
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
        </div>
      ) : (
        <Button
          track="settings.passkey.add_device"
          onClick={() => run(api.deviceLink, (r) => setLink(r as { url: string; expiresAt: string }))}
          className="flex min-h-12 w-full items-center gap-1.5 border-t border-divider px-3 text-left text-md font-bold text-accent first:border-t-0"
        >
          <Icon name="plus" size={16} stroke={2.6} />
          Add a device
        </Button>
      )}
    </Card>
  );
}

function Passkeys({
  keys,
  run,
  asking,
  setAsking,
}: {
  keys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  run: Run;
} & Asking) {
  return (
    <Card>
      {keys.map((k) => (
        <div key={k.id} className="flex flex-col border-t border-divider first:border-t-0">
          <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-semibold">{k.name}</span>
              <span className="text-xs text-muted">
                Added {day(k.createdAt)} · {k.lastUsedAt ? `last used ${day(k.lastUsedAt)}` : 'not used yet'}
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
  );
}

/**
 * Sign out of this device: the last thing in Settings. `compact` fits the computer's Settings list (a red text
 * button); on the phone it is a full-width button under Preferences.
 */
export function SignOutHere({ compact }: { compact?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (asking)
    return (
      <div className="flex flex-col gap-2">
        <ConfirmInline
          label="Sign out of this device"
          confirmLabel="Sign out"
          track="settings.sign_out.confirm"
          mutates={false}
          onConfirm={() => {
            setErr(null);
            // The budget saved on this device is deleted first (D-45), then the sign-in ends.
            clearSavedData();
            try {
              sessionStorage.setItem(SIGNED_OUT_HERE, '1');
            } catch {
              // Without it, the Sign in screen just asks for Face ID by itself.
            }
            (import.meta.env.VITE_MOCK === '1' ? api.signOut() : signOutHere()).then(
              () => window.location.assign('/'),
              (e: unknown) => setErr(errorMessage(e)),
            );
          }}
          onCancel={() => setAsking(false)}
        >
          Sign out and delete the budget saved on this device? Sign in with your passkey to get it back.
        </ConfirmInline>
        <Problem text={err} />
      </div>
    );
  return compact ? (
    <DangerLink track="settings.sign_out" onClick={() => setAsking(true)} className="px-3">
      Sign out…
    </DangerLink>
  ) : (
    <SecondaryButton danger track="settings.sign_out" onClick={() => setAsking(true)} className="mt-2">
      Sign out…
    </SecondaryButton>
  );
}
