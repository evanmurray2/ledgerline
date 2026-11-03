// Feedback note: a short text saved with the current screen and the last few event names (no amounts or
// payee names are attached).
import { useState } from 'react';
import { api } from '../api/endpoints';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Banner, ErrorNote, PrimaryButton } from '../components/ui';
import { usage } from '../usage/tracker';

const SCREEN_NAMES: Record<string, string> = {
  budget: 'Budget',
  'budget.attention': 'Budget · Needs attention',
  'budget.low': 'Budget · Low',
  activity: 'Activity',
  'activity.attention': 'Activity · Needs attention',
  'activity.pending': 'Activity · Not posted yet',
  accounts: 'Accounts',
  reports: 'Reports',
  settings: 'Settings',
};

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
      header={<SheetTitle title="Note about this screen" sub={SCREEN_NAMES[screen] ?? screen} />}
      footer={
        saved ? (
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        ) : (
          <PrimaryButton
            mutates
            track="note.save"
            disabled={!text.trim() || busy}
            onClick={() => void save()}
          >
            Save note
          </PrimaryButton>
        )
      }
    >
      {saved ? (
        <Banner tone="success">Saved. Notes are included in Export usage (Import and export).</Banner>
      ) : (
        <div className="flex flex-col gap-3">
          <textarea
            aria-label="Note"
            rows={4}
            maxLength={2000}
            placeholder="What was annoying or missing?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-xl border border-line-strong bg-surface p-3 text-[16px] text-ink"
          />
          <span className="text-[12px] leading-snug text-muted">
            Saved with the screen name and your last 20 taps, so it’s clear what you were doing. No amounts or
            payee names are attached.
          </span>
          {error ? <ErrorNote error={error} /> : null}
        </div>
      )}
    </Sheet>
  );
}
