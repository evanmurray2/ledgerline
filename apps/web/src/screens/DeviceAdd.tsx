// Adding a device with its own passkey to a locked budget (docs/privacy.md 5.2, "A new device"; docs/privacy-keys.md
// section 10). On the signed-in device, Settings → Sign-in and devices → Add a device shows the link, then the
// six digits once the new device answers; on the new device, after the link's sign-in, the same six digits. The
// person compares them and taps "They match" on both; only then does the budget key cross, sealed to the new
// device, which opens the budget, joins from a snapshot and adds its passkey as a way in.
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@ledgerline/contracts';
import { AddError, type Bytes, walkPublic } from '@ledgerline/seal';
import { ApiError, errorMessage } from '../api/client';
import { api } from '../api/endpoints';
import { Frame, Problem } from '../components/Frame';
import { Button, Icon, PrimaryButton, SecondaryButton, TextButton, inputClass } from '../components/ui';
import { toast } from '../components/Toast';
import { openWithAddedKey, withBudgetKey } from '../copy/copy';
import {
  addFromHere,
  type FromStage,
  joinFromOther,
  type JoinTry,
  NOT_SAME,
  type Relay,
} from '../copy/device-add';
import { fetchPublicEntries } from '../copy/sealed';
import { passkeyProblem } from '../copy/passkey';
import { OpenWithRecoveryKey } from './RecoveryKey';

const relay: Relay = {
  state: api.deviceAddState,
  start: api.deviceAddStart,
  send: api.deviceAddSend,
  end: api.deviceAddEnd,
};

const serverFetch = (path: string) =>
  fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });

/** Words for the person: an add that stopped says to start again; anything else as usual. */
function problem(e: unknown): string | null {
  if (e instanceof AddError) return e.why === 'cancelled' ? null : 'This didn’t work. Start again.';
  if (e instanceof ApiError) return errorMessage(e);
  return passkeyProblem(e) ?? (e instanceof Error ? e.message : 'Something went wrong. Try again.');
}

/** The six digits, large, to compare with the other device. */
function Code({ code }: { code: string }) {
  return (
    <span
      data-testid="add-code"
      className="self-center rounded-md bg-sunken px-4 py-2 text-3xl font-bold tracking-widest tabular-nums"
    >
      {code}
    </span>
  );
}

/** The two answers to the code. */
function Compare({ onAnswer }: { onAnswer: (same: boolean) => void }) {
  return (
    <>
      <PrimaryButton onClick={() => onAnswer(true)}>They match</PrimaryButton>
      <SecondaryButton onClick={() => onAnswer(false)}>They’re not the same</SecondaryButton>
    </>
  );
}

/** The single-use link for a new device, with Copy link. */
export function DeviceLinkShown({ link }: { link: { url: string; expiresAt: string } }) {
  return (
    <>
      <span className="text-base font-semibold">Open this link on the new device</span>
      <input readOnly className={inputClass} value={link.url} aria-label="Device link" />
      <span className="text-xs text-muted">
        It works once, until{' '}
        {new Date(link.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Send
        it only to yourself.
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
    </>
  );
}

type From =
  { at: 'idle' } | { at: 'link'; link: { url: string; expiresAt: string }; stage: FromStage; code?: string };

/**
 * Settings → Sign-in and devices → Add a device, for a locked budget. One passkey prompt opens the budget key;
 * it stays in hand on this device only until the add is done or the card closes.
 */
export function SealedAddDevice({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = useState<From>({ at: 'idle' });
  const [err, setErr] = useState<string | null>(null);
  const answer = useRef<((same: boolean) => void) | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);

  const begin = () => {
    setErr(null);
    const ctl = new AbortController();
    stop.current = ctl;
    let link: { url: string; expiresAt: string } | null = null;
    withBudgetKey(async (ways, budget) => {
      // The newest entry this device holds: the new device checks it against the log it is given.
      const place = await ways.host.sealedPlace();
      return addFromHere({
        relay,
        budgetId: ways.budgetId,
        keys: budget.keys,
        bk: budget.bk,
        head: { number: place.number, hash: place.hash as Bytes },
        slotIds: async () =>
          new Set((await walkPublic(await fetchPublicEntries(ways.fetch), ways.budgetId)).slots.keys()),
        ready: async () => {
          link = await api.deviceLink();
          setStep({ at: 'link', link, stage: 'waiting' });
        },
        match: (code) =>
          new Promise<boolean>((resolve) => {
            answer.current = resolve;
            setStep({ at: 'link', link: link!, stage: 'code', code });
          }),
        onStage: (stage) => {
          if (stage !== 'code' && link) setStep({ at: 'link', link, stage });
        },
        wait: { signal: ctl.signal },
      });
    }).then(
      () => {
        setStep({ at: 'idle' });
        toast.show({ text: 'The new device can open your budget' });
        onDone?.();
      },
      (e: unknown) => {
        setStep({ at: 'idle' });
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(problem(e));
      },
    );
  };

  const row =
    'flex min-h-12 w-full items-center gap-1.5 border-t border-divider px-3 text-left text-md font-bold text-accent first:border-t-0';
  if (step.at === 'idle')
    return (
      <>
        {err && (
          <div className="border-t border-divider px-3 py-3 first:border-t-0">
            <Problem text={err} />
          </div>
        )}
        <Button track="settings.passkey.add_device" onClick={begin} className={row}>
          <Icon name="plus" size={16} stroke={2.6} />
          Add a device
        </Button>
      </>
    );
  return (
    <div
      className="flex flex-col gap-2 border-t border-divider p-3 first:border-t-0"
      data-testid="add-device"
    >
      {step.stage === 'waiting' && (
        <>
          <DeviceLinkShown link={step.link} />
          <span className="text-sm text-muted" role="status">
            Waiting for the new device…
          </span>
        </>
      )}
      {step.stage === 'code' && step.code && (
        <>
          <span className="text-base leading-relaxed text-ink-2">
            Check that the new device shows the same code.
          </span>
          <Code code={step.code} />
          <Compare
            onAnswer={(same) => {
              answer.current?.(same);
              answer.current = null;
            }}
          />
        </>
      )}
      {(step.stage === 'sealing' || step.stage === 'confirming') && (
        <span className="text-base text-ink-2" role="status">
          Adding the device… Tap They match on the new device too.
        </span>
      )}
      {step.stage !== 'code' && (
        <TextButton onClick={() => stop.current?.abort()} className="self-start">
          Cancel
        </TextButton>
      )}
    </div>
  );
}

type Join =
  | { at: 'look' }
  | { at: 'none' }
  | { at: 'waiting' }
  | { at: 'code'; t: JoinTry }
  | { at: 'opening' }
  | { at: 'failed'; why: string };

/**
 * The new device, signed in with its own passkey, which is no way in to the locked budget yet: the add from a
 * device that opens the budget, or the recovery key instead.
 */
export function JoinThisDevice({ session }: { session: Session }) {
  const [step, setStep] = useState<Join>({ at: 'look' });
  const [withKey, setWithKey] = useState(false);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);

  /** One try. The first starts by itself when an add waits; each one after is the person's choice. */
  const go = () => {
    stop.current?.abort();
    const ctl = new AbortController();
    stop.current = ctl;
    setStep({ at: 'waiting' });
    joinFromOther({
      relay,
      budgetId: session.budget.id,
      fetch: serverFetch,
      wait: { signal: ctl.signal },
    }).then(
      (t) => setStep({ at: 'code', t }),
      (e: unknown) => {
        const why = problem(e);
        if (why) setStep({ at: 'failed', why });
      },
    );
  };
  const look = () => {
    setStep({ at: 'look' });
    api.deviceAddState().then(
      (s) => (s.role === 'waiting' || s.role === 'to' ? go() : setStep({ at: 'none' })),
      (e: unknown) => setStep({ at: 'failed', why: problem(e) ?? NOT_SAME }),
    );
  };
  useEffect(look, []);

  const matched = (t: JoinTry) => {
    setStep({ at: 'opening' });
    void (async () => {
      const { bk, confirm } = await t.open();
      const slotId = await openWithAddedKey(bk as Bytes, session);
      await confirm(slotId);
    })().catch((e: unknown) => {
      // The signed-in device stops waiting for a confirmation that won't come.
      void api.deviceAddEnd().catch(() => undefined);
      setStep({ at: 'failed', why: problem(e) ?? NOT_SAME });
    });
  };

  if (withKey) return <OpenWithRecoveryKey session={session} />;
  const instead = (
    <TextButton onClick={() => setWithKey(true)} className="self-start">
      Type your recovery key instead
    </TextButton>
  );
  return (
    <Frame title="Open your budget on this device">
      {step.at === 'look' && (
        <p className="m-0 text-base text-ink-2" role="status">
          One moment…
        </p>
      )}
      {step.at === 'none' && (
        <>
          <p className="m-0 text-base leading-relaxed text-ink-2">
            This passkey can’t open your budget yet. On a device that opens it, go to Settings → Sign-in and
            devices, and tap Add a device.
          </p>
          <PrimaryButton onClick={look}>Check again</PrimaryButton>
        </>
      )}
      {step.at === 'waiting' && (
        <p className="m-0 text-base text-ink-2" role="status">
          Waiting for your other device…
        </p>
      )}
      {step.at === 'code' && (
        <>
          <p className="m-0 text-base leading-relaxed text-ink-2">
            Check that your other device shows the same code.
          </p>
          <Code code={step.t.code} />
          <Compare
            onAnswer={(same) => {
              if (same) matched(step.t);
              else {
                void api.deviceAddEnd().catch(() => undefined);
                setStep({ at: 'failed', why: NOT_SAME });
              }
            }}
          />
        </>
      )}
      {step.at === 'opening' && (
        <p className="m-0 text-base text-ink-2" role="status">
          Opening your budget…
        </p>
      )}
      {step.at === 'failed' && (
        <>
          <Problem text={step.why} />
          <PrimaryButton onClick={go}>Try again</PrimaryButton>
        </>
      )}
      {instead}
    </Frame>
  );
}
