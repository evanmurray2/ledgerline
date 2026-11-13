// Activity's "Removed by the bank" rows: a pending charge the bank took away with nothing posted after 5 days, usually
// a released hold. It no longer counts; OK clears the row.
import type { ActivityView } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { useMoneyMutation } from '../api/hooks';
import { toast } from '../components/Toast';
import { cx, SoftButton, useIsDesktop } from '../components/ui';
import { dayLabel } from '../lib/dates';
import { formatCents } from '../lib/money';
import { Section } from './ActivityRows';

type Removed = ActivityView['removedByBank'][number];

export function RemovedByBank({ rows }: { rows: Removed[] }) {
  const desktop = useIsDesktop();
  const ok = useMoneyMutation(api.dismissAlert, { money: false, invalidate: [['activity']] });
  const undo = useMoneyMutation(api.undismissAlert, { money: false, invalidate: [['activity']] });
  const failed = (e: unknown): void => {
    toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t save that. Try again.' });
  };
  const dismiss = async (r: Removed) => {
    try {
      await ok.mutateAsync(r.id);
      toast.show({
        text: `${r.payee} · marked OK`,
        undo: () => undo.mutateAsync(r.id).then(() => {}, failed),
      });
    } catch (e) {
      failed(e);
    }
  };
  return (
    <Section title="Removed by the bank" note="likely released holds · not counted">
      {rows.map((r) => {
        const meta = [r.accountName, r.date ? dayLabel(r.date) : null].filter(Boolean).join(' · ');
        return (
          <div
            key={r.id}
            data-testid="removed-by-bank"
            className="flex min-h-11 items-center gap-2.5 border-t border-divider px-3 py-2 first:border-t-0"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-base font-semibold text-ink">{r.payee}</span>
              {meta && <span className={cx('text-muted', desktop ? 'text-sm' : 'text-xs')}>{meta}</span>}
            </span>
            <span className="tnum shrink-0 text-base font-bold text-faint line-through">
              {formatCents(r.amount, { plus: true })}
            </span>
            <SoftButton
              mutates="offline"
              track="activity.removed.ok"
              aria-label={`OK, ${r.payee} ${formatCents(Math.abs(r.amount))} was removed by the bank`}
              disabled={ok.isPending}
              onClick={() => void dismiss(r)}
            >
              OK
            </SoftButton>
          </div>
        );
      })}
    </Section>
  );
}
