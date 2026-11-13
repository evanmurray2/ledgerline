// The notices every device of a locked budget shows (docs/privacy.md 5.8; copy/notices.ts): a way in added or
// removed on another device, a change planned on another device, the recovery key signing in, and a planned change on its
// day, with Finish now. Each device dismisses a notice for itself.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, SoftButton, TextButton } from '../components/ui';
import { toast } from '../components/Toast';
import { useSession } from '../api/hooks';
import { isSealed, publicLook, sealedSession, useCopy, withBudgetKey } from '../copy/copy';
import {
  dismissedNotices,
  dismissNotice,
  noticesOf,
  takeRecoveryKeyHere,
  waysRemoved,
  type Notice,
} from '../copy/notices';
import { cancelPlan, finishPlan, WAITS_TEXT, type WayResult } from '../copy/sealed-ways';

const KEY = ['sealed-notices'];
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
const what = (ids: readonly string[]) =>
  ids.every((id) => id.startsWith('r:'))
    ? 'Your old recovery key'
    : ids.length === 1
      ? 'A passkey'
      : 'Some of your ways in';

async function load(): Promise<{ budgetId: string; notices: Notice[] }> {
  const look = await publicLook();
  if (!look) return { budgetId: '', notices: [] };
  const usedAt = look.session.recoveryKeyUsedAt ? Date.parse(look.session.recoveryKeyUsedAt) : null;
  takeRecoveryKeyHere(look.budgetId, usedAt);
  return {
    budgetId: look.budgetId,
    notices: noticesOf({
      entries: look.entries,
      intents: look.state.intents,
      removed: waysRemoved(look.entries),
      deviceIds: look.deviceIds,
      recoveryKeyUsedAt: usedAt,
      now: Date.now(),
      dismissed: dismissedNotices(look.budgetId),
    }),
  };
}

export function SealedNotices() {
  const copy = useCopy();
  const qc = useQueryClient();
  // Read again when the server's session comes (a recovery-key sign-in it reports), not only on open.
  useSession();
  const usedAt = sealedSession()?.recoveryKeyUsedAt ?? null;
  const ready = copy.status === 'ready' && isSealed();
  const q = useQuery({
    queryKey: [...KEY, usedAt],
    queryFn: load,
    enabled: ready,
    staleTime: 5 * 60_000,
  });
  const [busy, setBusy] = useState(false);
  if (!ready || !q.data?.notices.length) return null;
  const { budgetId } = q.data;
  const dismiss = (id: string) => {
    dismissNotice(budgetId, id);
    void qc.invalidateQueries({ queryKey: KEY });
  };
  const act = (fn: Parameters<typeof withBudgetKey>[0], done: string) => {
    setBusy(true);
    withBudgetKey(fn).then(
      (r) => {
        setBusy(false);
        const w = r as WayResult;
        if (!w.ok) toast.show({ text: w.why });
        else if ('waits' in w) toast.show({ text: WAITS_TEXT });
        else toast.show({ text: done });
        void qc.invalidateQueries({ queryKey: KEY });
        void qc.invalidateQueries({ queryKey: ['planned'] });
      },
      (e: unknown) => {
        setBusy(false);
        toast.show({ text: e instanceof Error ? e.message : 'Something went wrong. Try again.' });
      },
    );
  };
  return (
    <div className="flex flex-col gap-2 px-4 pt-3" data-testid="sealed-notices">
      {q.data.notices.map((n) => {
        const wasMe = (
          <SoftButton disabled={busy} onClick={() => dismiss(n.id)}>
            This was me
          </SoftButton>
        );
        switch (n.kind) {
          case 'way-added':
            return (
              <Banner
                key={n.id}
                tone="warn"
                role="alert"
                title={`A way in was added on ${day(n.at)}`}
                action={wasMe}
              >
                Another device added a passkey or a recovery key. If this wasn’t you, remove it in Settings →
                Sign-in and devices.
              </Banner>
            );
          case 'way-removed':
            return (
              <Banner
                key={n.id}
                tone="warn"
                role="alert"
                title={`A way in was removed on ${day(n.at)}`}
                action={wasMe}
              >
                {what(n.slotIds)} no longer opens your budget: another device removed it. If this wasn’t you,
                check your passkeys in Settings → Sign-in and devices.
              </Banner>
            );
          case 'recovery-sign-in':
            return (
              <Banner
                key={n.id}
                tone="warn"
                role="alert"
                title={`Your recovery key signed in on ${day(n.at)}`}
                action={wasMe}
              >
                If this wasn’t you, remove the passkeys you don’t know in Settings → Sign-in and devices. Then
                make a new recovery key.
              </Banner>
            );
          case 'planned':
            return (
              <Banner
                key={n.id}
                tone="warn"
                role="alert"
                title={`A change is planned for ${day(n.notBefore)}`}
                action={
                  <span className="flex flex-col items-end gap-2">
                    {wasMe}
                    <TextButton
                      disabled={busy}
                      onClick={() => act((w, b) => cancelPlan(w, b, n.number), 'Cancelled. Nothing changes.')}
                    >
                      Cancel this change
                    </TextButton>
                  </span>
                }
              >
                {what(n.slotIds)} stops opening your budget then. Another device planned this on {day(n.at)}.
              </Banner>
            );
          case 'due':
            return (
              <Banner
                key={n.id}
                tone="info"
                title="Your planned change is due"
                action={
                  <span className="flex flex-col items-end gap-2">
                    <SoftButton
                      disabled={busy}
                      onClick={() => act((w, b, onKeys) => finishPlan(w, b, n.number, onKeys), 'Done')}
                    >
                      Finish now
                    </SoftButton>
                    <TextButton disabled={busy} onClick={() => dismiss(n.id)}>
                      Not now
                    </TextButton>
                  </span>
                }
              >
                {what(n.slotIds)} stops opening your budget when you finish. To keep it, cancel the change in
                Settings → Sign-in and devices.
              </Banner>
            );
        }
      })}
    </div>
  );
}
