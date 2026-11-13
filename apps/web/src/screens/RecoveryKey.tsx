// The recovery key of a locked budget (docs/privacy.md 5.2, 5.8; docs/privacy-keys.md 4.2, 4.4): signing in with
// it, opening the budget with it when the passkey just used can't, and Settings → Sign-in (the key's sign-in, a
// new key, and the changes that wait 7 days).
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import type { Session } from '@ledgerline/contracts';
import {
  newRecoveryKey,
  readRecoveryKey,
  showRecoveryKey,
  equal,
  zeroize,
  type Bytes,
} from '@ledgerline/seal';
import { ApiError, errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Frame, Problem } from '../components/Frame';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  PrimaryButton,
  SecondaryButton,
  SoftButton,
  TextButton,
  inputClass,
} from '../components/ui';
import { toast } from '../components/Toast';
import { noteRecoveryKeyHere } from '../copy/notices';
import { passkeyProblem } from '../copy/passkey';
import {
  checkRecoveryKey,
  holdRecoveryKey,
  openWithRecovery,
  plannedChanges,
  withBudgetKey,
} from '../copy/copy';
import {
  addRecoveryWay,
  authPubOf,
  cancelPlan,
  finishPlan,
  recoveryKeySignIn,
  removeWays,
  WAITS_TEXT,
  type WayResult,
} from '../copy/sealed-ways';

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

function problem(e: unknown): string {
  if (e instanceof ApiError) return errorMessage(e);
  return passkeyProblem(e) ?? (e instanceof Error ? e.message : 'Something went wrong. Try again.');
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

/** The recovery key as the person types it. */
function KeyField({
  value,
  onChange,
  label = 'Recovery key',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink-2">
      {label}
      <textarea
        data-testid="recovery-key-typed"
        className={inputClass}
        rows={3}
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Sign in → Use your recovery key: the key proves who you are, then this device makes a new passkey. */
export function RecoveryKeySignInScreen({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Frame title="Use your recovery key">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        For a locked budget. Type your recovery key. Then make a passkey on this device, and your budget
        opens.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          void (async () => {
            const options = await recoveryKeySignIn(typed, {
              options: api.recoverKeyOptions,
              verify: api.recoverKeyVerify,
            });
            const response = await startRegistration({
              optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
            });
            await api.registerVerify({ response, name: deviceName() });
            // This sign-in is this device's own: its notice shows on the other devices only.
            noteRecoveryKeyHere();
            // The budget opens next: the new passkey is no way in yet, so the key opens it once more.
            holdRecoveryKey(typed);
          })().then(
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
        <KeyField value={typed} onChange={setTyped} />
        <Problem text={err} />
        <PrimaryButton type="submit" busy={busy} disabled={busy || typed.trim().length === 0}>
          {busy ? 'Waiting for your passkey…' : 'Continue'}
        </PrimaryButton>
        <SecondaryButton type="button" onClick={onBack}>
          Back
        </SecondaryButton>
      </form>
    </Frame>
  );
}

/** The passkey just used can't open the locked budget: the recovery key opens it, and the passkey is added. */
export function OpenWithRecoveryKey({ session }: { session: Session }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Frame title="Open your budget with your recovery key">
      <p className="m-0 text-base leading-relaxed text-ink-2">
        This passkey can’t open your budget yet. Type your recovery key. After that, this passkey opens it.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          openWithRecovery(typed, session).then(
            () => setBusy(false),
            (x: unknown) => {
              setBusy(false);
              setErr(problem(x));
            },
          );
        }}
      >
        <KeyField value={typed} onChange={setTyped} />
        <Problem text={err} />
        <PrimaryButton type="submit" busy={busy} disabled={busy || typed.trim().length === 0}>
          Open my budget
        </PrimaryButton>
      </form>
    </Frame>
  );
}

/** What a change came to: null when it is done (a toast says so), or the words for one that waits 7 days. */
function said(r: WayResult, done: string): string | null {
  if (!r.ok) throw new Error(r.why);
  if ('waits' in r) return `${WAITS_TEXT} It takes effect on ${day(r.waits)}.`;
  toast.show({ text: done });
  return null;
}

/** Removes a passkey of a locked budget: its way in goes with a key change, then its sign-in. */
export async function removeLockedPasskey(id: string): Promise<string | null> {
  const r = await withBudgetKey((w, b, onKeys) => removeWays(w, b, [`p:${id}`], onKeys));
  await api.removePasskey(id);
  if (!r.ok) throw new Error(r.why);
  return 'waits' in r
    ? `The passkey can’t sign in any more. ${WAITS_TEXT} It stops opening your budget on ${day(r.waits)}.`
    : null;
}

type NewKey = { at: 'show' | 'type'; key: Bytes; text: string };

/** Settings → Sign-in for a locked budget: the recovery key's sign-in, and a new recovery key. */
export function RecoveryKeyCard() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ['recovery-key'], queryFn: api.recoveryKey });
  const [step, setStep] = useState<'idle' | 'set' | NewKey>('idle');
  const [typed, setTyped] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A new key in hand is zeroed when it is done with, or when the card closes.
  const inHand = useRef<Bytes | null>(null);
  useEffect(() => () => void (inHand.current && zeroize(inHand.current)), []);
  const reset = () => {
    if (inHand.current) zeroize(inHand.current);
    inHand.current = null;
    setStep('idle');
    setTyped('');
    setSaved(false);
    setErr(null);
  };
  const run = (fn: () => Promise<string | null | undefined>) => {
    setBusy(true);
    setErr(null);
    fn().then(
      (n) => {
        setBusy(false);
        reset();
        setNote(n ?? null);
        void qc.invalidateQueries({ queryKey: ['recovery-key'] });
        void qc.invalidateQueries({ queryKey: ['planned'] });
      },
      (e: unknown) => {
        setBusy(false);
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(problem(e));
      },
    );
  };
  // The two actions are rows at the foot of the card, like Add a device (settings/SignIn.tsx).
  const actionRow =
    'flex min-h-12 w-full items-center border-t border-divider px-3 text-left text-md font-bold text-accent first:border-t-0';
  if (step === 'idle')
    return (
      <Card>
        <div data-testid="recovery-key-card">
          <div className="flex flex-col gap-2 px-3 py-3 empty:hidden">
            {st.data && !st.data.set && (
              <Banner tone="warn">
                Your recovery key can’t sign in yet. Set it up, so you can get back in if you lose every
                passkey.
              </Banner>
            )}
            {st.data?.set && (
              <span className="text-sm leading-snug text-muted">
                It opens your budget and signs you in if you lose every passkey.
              </span>
            )}
            {note && <Banner tone="info">{note}</Banner>}
            <Problem text={err} />
          </div>
          {st.data && !st.data.set && (
            <Button className={actionRow} onClick={() => setStep('set')}>
              Set up sign-in with it
            </Button>
          )}
          <Button
            className={actionRow}
            onClick={() => {
              const key = newRecoveryKey();
              inHand.current = key;
              void showRecoveryKey(key).then((text) => setStep({ at: 'show', key, text }));
            }}
          >
            Make a new recovery key
          </Button>
        </div>
      </Card>
    );
  return (
    <Card>
      <div className="flex flex-col gap-2 px-3 py-3" data-testid="recovery-key-card">
        {step === 'set' && (
          <>
            <KeyField value={typed} onChange={setTyped} label="Type your recovery key" />
            <Problem text={err} />
            <PrimaryButton
              busy={busy}
              disabled={busy || !typed.trim()}
              onClick={() =>
                run(async () => {
                  await api.setRecoveryKey(await checkRecoveryKey(typed));
                  toast.show({ text: 'Your recovery key signs in now' });
                  return null;
                })
              }
            >
              Set up
            </PrimaryButton>
            <SecondaryButton disabled={busy} onClick={reset}>
              Cancel
            </SecondaryButton>
          </>
        )}

        {typeof step === 'object' && step.at === 'show' && (
          <>
            <span className="text-base leading-relaxed text-ink-2">
              This is your new recovery key. It’s shown only now. Your old key stops working.
            </span>
            <div className="flex items-start justify-between gap-2 rounded-md bg-sunken px-3 py-3">
              <span data-testid="recovery-key" className="text-base font-bold tracking-wide break-all">
                {step.text}
              </span>
              <SoftButton
                onClick={() =>
                  void navigator.clipboard?.writeText(step.text).then(
                    () => toast.show({ text: 'Copied' }),
                    () => undefined,
                  )
                }
              >
                Copy
              </SoftButton>
            </div>
            <label className="flex items-start gap-2.5 text-base text-ink-2">
              <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>I saved my new recovery key outside this device.</span>
            </label>
            <PrimaryButton
              disabled={!saved}
              why={saved ? '' : 'Save your key first'}
              onClick={() => setStep({ ...step, at: 'type' })}
            >
              Continue
            </PrimaryButton>
            <SecondaryButton onClick={reset}>Cancel</SecondaryButton>
          </>
        )}

        {typeof step === 'object' && step.at === 'type' && (
          <>
            <KeyField value={typed} onChange={setTyped} label="Type your new recovery key" />
            <span className="text-sm text-muted">Next, your passkey is asked.</span>
            <Problem text={err} />
            <PrimaryButton
              busy={busy}
              disabled={busy || !typed.trim()}
              onClick={() =>
                run(async () => {
                  const back = await readRecoveryKey(typed);
                  const same = back !== null && equal(back, step.key);
                  if (back) zeroize(back);
                  if (!same) throw new Error('That is not the recovery key shown. Check it and try again.');
                  const authPub = (await authPubOf(step.key))!;
                  return withBudgetKey(async (w, b, onKeys) => {
                    const added = await addRecoveryWay(w, b, step.key);
                    if (!added.ok) throw new Error(added.why);
                    await api.setRecoveryKey(authPub);
                    return said(
                      await removeWays(w, b, added.replaces, onKeys),
                      'Your new recovery key is ready',
                    );
                  });
                })
              }
            >
              Use the new key
            </PrimaryButton>
            <SecondaryButton disabled={busy} onClick={() => setStep({ ...step, at: 'show' })}>
              Show the key again
            </SecondaryButton>
          </>
        )}
      </div>
    </Card>
  );
}

/** The changes that wait 7 days (D-89), each with Finish once it is due, and Cancel. */
export function PlannedChanges({ names }: { names: Map<string, string> }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['planned'], queryFn: plannedChanges });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!plans.data?.length) return null;
  const what = (id: string) =>
    id.startsWith('r:') ? 'your old recovery key' : `the passkey ${names.get(id.slice(2)) ?? 'you removed'}`;
  const act = (fn: Parameters<typeof withBudgetKey>[0], done: string) => {
    setBusy(true);
    setErr(null);
    withBudgetKey(fn).then(
      (r) => {
        setBusy(false);
        const w = r as WayResult;
        if (!w.ok) setErr(w.why);
        else if ('waits' in w) setErr(`${WAITS_TEXT} It takes effect on ${day(w.waits)}.`);
        else toast.show({ text: done });
        void qc.invalidateQueries({ queryKey: ['planned'] });
      },
      (e: unknown) => {
        setBusy(false);
        setErr(problem(e));
      },
    );
  };
  return (
    <Card>
      {plans.data.map((p) => (
        <div
          key={p.number}
          className="flex flex-col gap-2 border-t border-divider px-3 py-3 first:border-t-0"
        >
          <span className="text-base leading-snug text-ink-2">
            {p.slotIds.map(what).join(' and ')} stops opening your budget on {day(p.notBefore)}.
          </span>
          <span className="flex items-center gap-4">
            {p.notBefore <= Date.now() && (
              <TextButton
                disabled={busy}
                onClick={() => act((w, b, onKeys) => finishPlan(w, b, p.number, onKeys), 'Done')}
              >
                Finish now
              </TextButton>
            )}
            <TextButton
              disabled={busy}
              onClick={() => act((w, b) => cancelPlan(w, b, p.number), 'Cancelled. Nothing changes.')}
            >
              Cancel this change
            </TextButton>
          </span>
        </div>
      ))}
      <div className="px-3 pb-3">
        <Problem text={err} />
      </div>
    </Card>
  );
}
