// Activity's Needs attention sections with a button on each row: Transfers to sort out (Pick) and Check these
// (OK or Review). Split from Activity.tsx.
import { Link } from '@tanstack/react-router';
import type { ActivityView } from '@ledgerline/contracts';
import { SoftButton, softButtonClass } from '../components/ui';
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

type CheckRow = ActivityView['checkThese'][number];

export function CheckThese({ rows, onDismiss }: { rows: CheckRow[]; onDismiss: (r: CheckRow) => void }) {
  return (
    <Section title="Check these">
      {rows.map((r) => (
        <TxnRow
          key={r.key}
          r={r}
          base="/activity"
          action={
            r.action === 'dismiss' ? (
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
