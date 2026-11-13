// Settings → Sign-in and devices (decisions.md D-27): this device and its Sign out, your other devices (sign out
// each one, add one) and your passkeys (rename each one after where it's saved, remove one).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { Problem } from '../../components/Frame';
import {
  Banner,
  Button,
  Card,
  ConfirmInline,
  DangerLink,
  Icon,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  TextButton,
  inputClass,
} from '../../components/ui';
import { toast } from '../../components/Toast';
import { useScreen } from '../../lib/common';
import { clearSavedData } from '../../state/saved';
import { isSealed, signOutHere } from '../../copy/copy';
import { SIGNED_OUT_HERE } from '../Auth';
import { PlannedChanges, RecoveryKeyCard, removeLockedPasskey } from '../RecoveryKey';
import { DeviceLinkShown, SealedAddDevice } from '../DeviceAdd';
import { DeleteAccountCard } from './People';
import { Page } from './common';

type SignIn = { id: string; name: string; signedInAt: string; current: boolean; saved: boolean };
type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
type Run = (fn: () => Promise<unknown>, done?: (r: unknown) => void) => void;
/** The one row being confirmed or edited: 'session:<id>', 'passkey:<id>' or 'rename:<id>'. */
type Asking = { asking: string | null; setAsking: (v: string | null) => void };

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
  const [asking, setAsking] = useState<string | null>(null);
  /** A change that waits 7 days (a locked budget, D-89), said plainly. */
  const [note, setNote] = useState<string | null>(null);
  const run: Run = (fn, done) => {
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
  /** A locked budget: its ways in are in its log too (RecoveryKey.tsx). */
  const locked = import.meta.env.VITE_MOCK !== '1' && isSealed();
  return (
    <Page title="Sign-in and devices" back="/settings">
      <Problem text={err} />
      {note && <Banner tone="info">{note}</Banner>}
      <SectionTitle>This device</SectionTitle>
      {here && (
        <Card>
          <div className="flex min-h-14 flex-col justify-center gap-0.5 px-3 py-2">
            <span className="text-base font-semibold">{here.name}</span>
            <span className="text-xs text-muted">Signed in {at(here.signedInAt)}</span>
          </div>
        </Card>
      )}
      <SignOutHere />
      <SectionTitle>Other devices</SectionTitle>
      <OtherDevices
        others={signIns.filter((x) => !x.current)}
        run={run}
        asking={asking}
        setAsking={setAsking}
        locked={locked}
        onAdded={() => void qc.invalidateQueries({ queryKey: ['security'] })}
      />
      <SectionTitle>Passkeys</SectionTitle>
      <Passkeys
        keys={sec.data?.passkeys ?? []}
        run={run}
        asking={asking}
        setAsking={setAsking}
        locked={locked}
        onNote={setNote}
      />
      <p className="m-0 px-0.5 text-sm leading-snug text-muted">
        Name each passkey after where it’s saved, like Apple Passwords.
      </p>
      {locked && (
        <>
          <PlannedChanges names={new Map((sec.data?.passkeys ?? []).map((k) => [k.id, k.name]))} />
          <SectionTitle>Recovery key</SectionTitle>
          <RecoveryKeyCard />
        </>
      )}
      {sec.data?.ownAccount && (
        <>
          <SectionTitle>Account</SectionTitle>
          <DeleteAccountCard />
        </>
      )}
    </Page>
  );
}

/** Sign out of this device, right under it. The budget saved here is deleted first (D-45), then the sign-in ends. */
function SignOutHere() {
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!asking)
    return (
      <SecondaryButton
        danger
        track="settings.sign_out"
        onClick={() => setAsking(true)}
        className="lg:self-start lg:px-6"
      >
        Sign out…
      </SecondaryButton>
    );
  return (
    <>
      <ConfirmInline
        label="Sign out of this device"
        confirmLabel="Sign out"
        track="settings.sign_out.confirm"
        mutates={false}
        onConfirm={() => {
          setErr(null);
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
    </>
  );
}

/**
 * Devices that read the same ("Linux · Chrome") get a number in the order they signed in, "Linux · Chrome 1" first,
 * so each Sign out names one device.
 */
export function tellApart(list: SignIn[]): SignIn[] {
  const count = new Map<string, number>();
  for (const x of list) count.set(x.name, (count.get(x.name) ?? 0) + 1);
  const oldestFirst = [...list].sort((a, b) => a.signedInAt.localeCompare(b.signedInAt));
  const seen = new Map<string, number>();
  const number = new Map<string, number>();
  for (const x of oldestFirst) {
    if ((count.get(x.name) ?? 0) < 2) continue;
    const n = (seen.get(x.name) ?? 0) + 1;
    seen.set(x.name, n);
    number.set(x.id, n);
  }
  return list.map((x) => (number.has(x.id) ? { ...x, name: `${x.name} ${number.get(x.id)}` } : x));
}

/** Each other device with its own Sign out, then Add a device. */
function OtherDevices({
  others: listed,
  run,
  asking,
  setAsking,
  locked,
  onAdded,
}: { others: SignIn[]; run: Run; locked: boolean; onAdded: () => void } & Asking) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const others = tellApart(listed);
  return (
    <Card>
      {others.length === 0 && !link && (
        <p className="m-0 px-3 py-3 text-sm leading-snug text-muted">
          No other devices. Add one to use Ledgerline on a computer or iPad.
        </p>
      )}
      {others.map((x) => (
        <div key={x.id} className="flex flex-col border-t border-divider first:border-t-0">
          <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-semibold">{x.name}</span>
              <span className="text-xs text-muted">Signed in {at(x.signedInAt)}</span>
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
      {locked ? (
        // A locked budget: the new device's passkey can't open it until this device hands it the key.
        <SealedAddDevice onDone={onAdded} />
      ) : link ? (
        <div className="flex flex-col gap-2 border-t border-divider p-3 first:border-t-0">
          <DeviceLinkShown link={link} />
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

/** Each passkey with Rename, and Remove when there is more than one (never the last: you'd be locked out). */
function Passkeys({
  keys,
  run,
  asking,
  setAsking,
  locked,
  onNote,
}: { keys: Passkey[]; run: Run; locked: boolean; onNote: (n: string | null) => void } & Asking) {
  return (
    <Card>
      {keys.map((k) => (
        <div key={k.id} className="flex flex-col border-t border-divider first:border-t-0">
          {asking === `rename:${k.id}` ? (
            <RenamePasskey k={k} run={run} done={() => setAsking(null)} />
          ) : (
            <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-base font-semibold">{k.name}</span>
                <span className="text-xs text-muted">
                  Added {day(k.createdAt)} ·{' '}
                  {k.lastUsedAt ? `last used ${day(k.lastUsedAt)}` : 'not used yet'}
                </span>
              </span>
              {asking !== `passkey:${k.id}` && (
                <span className="flex shrink-0 items-center gap-4">
                  <TextButton
                    track="settings.passkey.rename"
                    onClick={() => setAsking(`rename:${k.id}`)}
                    aria-label={`Rename passkey ${k.name}`}
                    className="self-center"
                  >
                    Rename
                  </TextButton>
                  {keys.length > 1 && (
                    <DangerLink
                      track="settings.passkey.remove"
                      onClick={() => setAsking(`passkey:${k.id}`)}
                      aria-label={`Remove passkey ${k.name}…`}
                      className="self-center"
                    >
                      Remove…
                    </DangerLink>
                  )}
                </span>
              )}
            </div>
          )}
          {asking === `passkey:${k.id}` && (
            <ConfirmInline
              label={`Remove passkey ${k.name}`}
              confirmLabel="Remove"
              track="settings.passkey.remove.confirm"
              mutates={false}
              onConfirm={() =>
                run(
                  // A locked budget: the passkey's way in goes too, so it can't open the budget.
                  () => (locked ? removeLockedPasskey(k.id) : api.removePasskey(k.id)),
                  (r) => {
                    setAsking(null);
                    if (typeof r === 'string') onNote(r);
                  },
                )
              }
              onCancel={() => setAsking(null)}
              className="mx-3 mb-3"
            >
              Remove the passkey {k.name}? You can’t sign in with it any more
              {locked ? ', and it can’t open your budget' : ''}.
            </ConfirmInline>
          )}
        </div>
      ))}
    </Card>
  );
}

function RenamePasskey({ k, run, done }: { k: Passkey; run: Run; done: () => void }) {
  const [name, setName] = useState(k.name);
  const trimmed = name.trim();
  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        run(() => api.renamePasskey(k.id, trimmed), done);
      }}
    >
      <input
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={60}
        aria-label="Passkey name"
        placeholder="Apple Passwords"
        autoFocus
        autoComplete="off"
      />
      <div className="flex gap-2">
        <SecondaryButton type="button" className="flex-1" onClick={done}>
          Cancel
        </SecondaryButton>
        <PrimaryButton type="submit" className="flex-1" mutates={false} disabled={!trimmed}>
          Save
        </PrimaryButton>
      </div>
    </form>
  );
}
