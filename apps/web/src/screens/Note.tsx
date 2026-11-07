// Feedback note: a short text saved with the current screen and the last few event names (no amounts or
// payee names are attached).
import { useState } from 'react';
import { api } from '../api/endpoints';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, ErrorNote, PrimaryButton } from '../components/ui';
import { usage } from '../usage/tracker';

const SCREEN_NAMES: Record<string, string> = {
  app: 'Ledgerline',
  welcome: 'Welcome',
  setup: 'Setup',
  'setup.start': 'Setup · Budget start',
  'setup.link': 'Setup · Link a bank',
  'setup.categories': 'Setup · Categories',
  budget: 'Budget',
  'budget.attention': 'Budget · Needs attention',
  'budget.low': 'Budget · Low',
  category: 'Budget · Category',
  assign: 'Budget · Assign',
  target: 'Target',
  targets: 'Set targets',
  owed: 'Owed to you',
  'owed.close': 'Owed to you · Close out',
  activity: 'Activity',
  'activity.attention': 'Activity · Needs attention',
  'activity.pending': 'Activity · Not posted yet',
  add_txn: 'Add a transaction',
  match: 'Match money back',
  check_pending: 'Check not cleared',
  'transfer.pick': 'Transfer to sort out',
  txn: 'Transaction',
  'txn.split': 'Split',
  'payee.rename': 'Rename payee',
  accounts: 'Accounts',
  register: 'Account',
  repair: 'Repair a bank',
  reports: 'Reports',
  'reports.spend': 'Reports · Spending',
  'reports.trend': 'Reports · Trends',
  'reports.worth': 'Reports · Net worth',
  settings: 'Settings',
  'settings.appearance': 'Settings · Appearance',
  'settings.categories': 'Settings · Categories',
  'settings.category.new': 'Settings · New category',
  'settings.category.edit': 'Settings · Edit category',
  'settings.group.new': 'Settings · New group',
  'settings.rules': 'Settings · Rules',
  'settings.payees': 'Settings · Payees',
  'settings.payee.rename': 'Settings · Rename payee',
  'settings.connections': 'Settings · Bank connections',
  'settings.data': 'Settings · Import and export',
};

/** A friendly name for a screen key: its own, else its first part's (txn.posted → Transaction), never the key. */
function screenName(key: string): string {
  return SCREEN_NAMES[key] ?? SCREEN_NAMES[key.split('.')[0] ?? ''] ?? 'Ledgerline';
}

export function NoteSheet({ onClose }: { onClose: () => void }) {
  const [screen] = useState(() => usage.currentScreen());
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.note({ screen, text: text.trim(), recentEvents: usage.recentEvents(20) });
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      label="Note about this screen"
      track="note"
      onClose={onClose}
      gap="auto"
      header={<SheetTitle title="Note about this screen" sub={screenName(screen)} />}
      footer={
        saved ? (
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        ) : (
          <PrimaryButton
            mutates
            track="note.save"
            busy={busy}
            disabled={!text.trim() || busy}
            why={!text.trim() ? 'Write a note to save' : ''}
            onClick={() => void save()}
          >
            Save note
          </PrimaryButton>
        )
      }
    >
      {saved ? (
        <Banner tone="success">Saved.</Banner>
      ) : (
        <div className="flex flex-col gap-3">
          <textarea
            aria-label="Note"
            rows={4}
            maxLength={2000}
            placeholder="What was annoying or missing?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-surface p-3 text-lg text-ink"
          />
          <span className="text-xs leading-snug text-muted">
            It’s saved with your last 20 taps, but no amounts or payee names.
          </span>
          {error ? <ErrorNote error={error} /> : null}
        </div>
      )}
    </Sheet>
  );
}
