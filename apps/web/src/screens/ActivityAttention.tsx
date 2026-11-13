// Activity's Needs attention sections with a button on each row: Transfers to sort out (Pick) and Check these
// (Accept, OK or Review). Split from Activity.tsx.
import { Link } from '@tanstack/react-router';
import type { ActivityView } from '@ledgerline/contracts';
import { SoftButton, softButtonClass } from '../components/ui';
import { formatCents } from '../lib/money';
import { sheetPath, Section, TxnRow } from './ActivityRows';

export function TransfersToSort({ rows }: { rows: ActivityView['transfersToSort'] }) {
  return (
    <Section title="Transfers to sort out">
      {rows.map((r) => (
        <TxnRow
          key={r.key}
          r={r}
          base="/activity"
          action={
            <Link
              to={sheetPath('/activity', r)}
              search={true}
              data-track="activity.transfer.pick"
              aria-label={`Pick ${r.payee}`}
              className={softButtonClass()}
            >
              Pick
            </Link>
          }
        />
      ))}
    </Section>
  );
}

export type CheckRow = ActivityView['checkThese'][number];

export function CheckThese({ rows, onDismiss }: { rows: CheckRow[]; onDismiss: (r: CheckRow) => void }) {
  return (
    <Section title="Check these">
      {rows.map((r) => (
        <TxnRow
          key={r.key}
          r={r}
          base="/activity"
          action={
            r.action === 'accept' ? (
              // It cleared at another amount than your estimate: the bank's amount already counts.
              <SoftButton
                mutates="offline"
                track="activity.check.accept"
                aria-label={`Accept ${r.payee} at ${formatCents(Math.abs(r.amount))}`}
                onClick={() => onDismiss(r)}
              >
                Accept
              </SoftButton>
            ) : r.action === 'dismiss' ? (
              <SoftButton
                mutates="offline"
                track="activity.check.ok"
                aria-label={`OK ${r.payee}`}
                onClick={() => onDismiss(r)}
              >
                OK
              </SoftButton>
            ) : (
              <Link
                to={sheetPath('/activity', r)}
                search={true}
                data-track="activity.check.review"
                aria-label={`Review ${r.payee}`}
                className={softButtonClass()}
              >
                Review
              </Link>
            )
          }
        />
      ))}
    </Section>
  );
}
