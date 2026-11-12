// Settings → Privacy: moving a budget that exists to its locked form (docs/privacy.md section 8, steps 6 and 7).
// The card shows only while the server says the move is open for this budget. The steps: a passkey prompt makes
// the budget's key and its recovery key on this device; the person writes the recovery key down and types it
// back; a second passkey prompt proves the passkey opens the key; only then is anything sent. For 7 days after,
// the same card offers the way back.
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { Problem } from '../../components/Frame';
import {
  Banner,
  Card,
  Checkbox,
  ConfirmInline,
  DangerLink,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  SoftButton,
  inputClass,
} from '../../components/ui';
import { toast } from '../../components/Toast';
import { Why } from '../../components/Why';
import {
  isSealed,
  moveAgain,
  moveBack,
  moveBackStart,
  moveFinish,
  moveGiveUp,
  moveStart,
  type MoveInHand,
} from '../../copy/copy';

/** Where the reason of a move that failed waits while the app starts again. */
const MOVE_NOTE = 'ledgerline.move-note';
const takeNote = (): string | null => {
  try {
    const n = sessionStorage.getItem(MOVE_NOTE);
    if (n) sessionStorage.removeItem(MOVE_NOTE);
    return n;
  } catch {
    return null;
  }
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

type Step =
  | { at: 'idle' }
  | { at: 'key'; move: MoveInHand }
  | { at: 'type'; move: MoveInHand }
  | { at: 'moving' }
  | { at: 'done' };

export function MoveCard() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ['cutover'], queryFn: api.cutoverState, retry: false });
  const [step, setStep] = useState<Step>({ at: 'idle' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(takeNote);
  const [blocks, setBlocks] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);

  // Leaving the screen with a key in hand gives the key up.
  const inHand = useRef<MoveInHand | null>(null);
  inHand.current = step.at === 'key' || step.at === 'type' ? step.move : null;
  useEffect(
    () => () => {
      if (inHand.current) moveGiveUp(inHand.current);
    },
    [],
  );

  // With no signal the server can't say: a budget this device holds as sealed is sealed.
  const s = state.data ?? (isSealed() ? { open: false, sealed: true, backUntil: null } : undefined);
  if (!s || (!s.open && !s.backUntil && step.at !== 'done')) return null;

  const fail = (e: unknown) => {
    // A passkey check the app asks for by itself is not a problem to show.
    if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
  };
  const run = (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    fn()
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const start = () =>
    run(async () => {
      // The server says what stands in the way (a bank update that runs, a bank to reconnect) before any key is made.
      const ready = await api.cutoverReady();
      setBlocks(ready.blocks);
      if (ready.blocks.length) return;
      setSaved(false);
      setTyped('');
      setStep({ at: 'key', move: await moveStart() });
    });

  /** A move that stopped after it began: the copy is deleted, the app starts again and shows why here. */
  const again = async (why: string) => {
    try {
      sessionStorage.setItem(MOVE_NOTE, why);
    } catch {
      // No storage: the page starts again without the note.
    }
    await moveAgain();
  };

  const finish = (move: MoveInHand) =>
    run(async () => {
      // The server asks for a passkey check moments before the move: made now, not in the middle of it.
      const ready = await api.cutoverReady(true);
      if (ready.blocks.length) {
        moveGiveUp(move);
        setBlocks(ready.blocks);
        setStep({ at: 'idle' });
        return;
      }
      setStep({ at: 'moving' });
      let r: Awaited<ReturnType<typeof moveFinish>>;
      try {
        r = await moveFinish(move, typed);
      } catch (e) {
        setStep({ at: 'idle' });
        await qc.invalidateQueries({ queryKey: ['cutover'] });
        throw e;
      }
      if (r.ok) {
        setTyped('');
        setStep({ at: 'done' });
        await qc.invalidateQueries({ queryKey: ['cutover'] });
        return;
      }
      if (r.retype) {
        setStep({ at: 'type', move });
        setErr(r.why);
        return;
      }
      if (r.again) return again(r.why);
      setTyped('');
      setStep({ at: 'idle' });
      setErr(r.why);
      await qc.invalidateQueries({ queryKey: ['cutover'] });
    });

  const giveUp = (move: MoveInHand) => {
    moveGiveUp(move);
    setErr(null);
    setStep({ at: 'idle' });
  };

  return (
    <>
      <SectionTitle>Lock your budget</SectionTitle>
      <Card>
        <div className="flex flex-col gap-3 px-3 py-3" data-testid="move-card">
          {step.at === 'idle' && s.open && !s.sealed && (
            <>
              <span className="text-sm text-muted">
                Only your devices will be able to read your budget. The server keeps it locked.
              </span>
              <Why label="What happens?">
                This device makes a key and a recovery key. You write the recovery key down and type it back.
                Then your budget is locked and sent again. It takes a few minutes. Keep the app open.
              </Why>
              {blocks.length > 0 && (
                <Banner tone="warn" title="Not yet">
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
                    {blocks.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </Banner>
              )}
              <Problem text={err} />
              <PrimaryButton busy={busy} disabled={busy} onClick={start}>
                Lock my budget
              </PrimaryButton>
            </>
          )}

          {step.at === 'key' && (
            <>
              <span className="text-base leading-relaxed text-ink-2">
                This is your recovery key. It opens your budget if you lose every passkey. It’s shown only
                now.
              </span>
              <div className="flex items-start justify-between gap-2 rounded-md bg-sunken px-3 py-3">
                <span data-testid="recovery-key" className="text-base font-bold tracking-wide break-all">
                  {step.move.recoveryText}
                </span>
                <SoftButton
                  onClick={() =>
                    void navigator.clipboard?.writeText(step.move.recoveryText).then(
                      () => toast.show({ text: 'Copied' }),
                      () => undefined,
                    )
                  }
                >
                  Copy
                </SoftButton>
              </div>
              <Banner tone="warn">
                Nobody can make this key again. Without it and your passkeys, your budget is lost.
              </Banner>
              <label className="flex items-start gap-2.5 text-base text-ink-2">
                <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                <span>I saved my recovery key outside this device.</span>
              </label>
              <PrimaryButton
                disabled={!saved}
                why={saved ? '' : 'Save your key first'}
                onClick={() => setStep({ at: 'type', move: step.move })}
              >
                Continue
              </PrimaryButton>
              <SecondaryButton onClick={() => giveUp(step.move)}>Cancel</SecondaryButton>
            </>
          )}

          {step.at === 'type' && (
            <>
              <label className="flex flex-col gap-1.5 text-base text-ink-2">
                <span>Type your recovery key from where you saved it.</span>
                <textarea
                  data-testid="recovery-key-typed"
                  className={inputClass}
                  rows={3}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
              <span className="text-sm text-muted">
                Next, your passkey is asked once more. Then your budget is locked.
              </span>
              <Problem text={err} />
              <PrimaryButton
                busy={busy}
                disabled={busy || typed.trim().length === 0}
                onClick={() => finish(step.move)}
              >
                Lock my budget
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={() => setStep({ at: 'key', move: step.move })}>
                Show the key again
              </SecondaryButton>
            </>
          )}

          {step.at === 'moving' && (
            <span className="text-base text-ink-2" role="status">
              Locking your budget. Keep the app open.
            </span>
          )}

          {(step.at === 'done' || (step.at === 'idle' && s.sealed)) && (
            <>
              <span className="text-base font-semibold">Your budget is locked.</span>
              <span className="text-sm text-muted">Only your devices can read it.</span>
              {s.backUntil && (
                <>
                  <span className="text-sm text-muted">
                    Until {day(s.backUntil)} you can go back to how it was. Changes made since the lock are
                    lost then.
                  </span>
                  <Problem text={err} />
                  {asking ? (
                    <ConfirmInline
                      label="Go back to how it was"
                      confirmLabel="Go back"
                      busy={busy}
                      onConfirm={() =>
                        run(async () => {
                          // Forgotten on this device first: if the app closes before the last step, it
                          // still opens the budget as the server has it.
                          moveBackStart();
                          await api.cutoverBack();
                          await moveBack();
                        })
                      }
                      onCancel={() => setAsking(false)}
                    >
                      Go back? Changes made since the lock are lost.
                    </ConfirmInline>
                  ) : (
                    <DangerLink onClick={() => setAsking(true)}>Go back to how it was…</DangerLink>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </Card>
    </>
  );
}
