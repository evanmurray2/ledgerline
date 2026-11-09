// Settings → Sign-in: passkeys, adding a device, where you're signed in and signing out (decisions.md D-27).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { Problem } from '../../components/Frame';
import {
  Card,
  ConfirmInline,
  DangerLink,
  SecondaryButton,
  SectionTitle,
  inputClass,
} from '../../components/ui';
import { toast } from '../../components/Toast';
import { clearSavedData } from '../../state/saved';
import { signOutHere } from '../../copy/copy';
import { SIGNED_OUT_HERE } from '../Auth';
import { RecoveryCodeCard } from '../Signup';
import { DeleteAccountCard } from './People';

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
