// Budget → Needs attention, when another device showed different numbers at the same point in the budget's log (the
// device check, D-116; apps/worker/src/local/device-check.ts). Each device works out the budget by itself, so this
// says one of them got it wrong. Rebuild makes this device's budget again from the newest checked snapshot.
import { useState } from 'react';
import { Banner, SoftButton } from '../components/ui';
import { toast } from '../components/Toast';
import { rebuildHere, useCopy } from '../copy/copy';
import { monthName } from '../lib/dates';

/** Whether another device showed different numbers: one more item in Needs attention. */
export function useDevicesDiffer(): boolean {
  return !!useCopy().differs;
}

export function DevicesDiffer() {
  const differs = useCopy().differs;
  const [busy, setBusy] = useState(false);
  if (!differs) return null;
  const rebuild = () => {
    setBusy(true);
    rebuildHere().then(
      () => {
        setBusy(false);
        toast.show({ text: 'Done' });
      },
      (e: unknown) => {
        setBusy(false);
        toast.show({ text: e instanceof Error ? e.message : 'Something went wrong. Try again.' });
      },
    );
  };
  return (
    <Banner
      tone="warn"
      role="alert"
      icon="alert"
      title="Your devices show different numbers"
      action={
        <SoftButton mutates track="budget.attention.rebuild" disabled={busy} onClick={rebuild}>
          Rebuild
        </SoftButton>
      }
    >
      Another device got other numbers for {monthName(differs.month)}. Rebuild the budget on this device to
      check again.
    </Banner>
  );
}
