// Settings → Usage file, its own screen apart from the full backup: what "Record how I use the app" kept on this device (usage/tracker.ts),
// saved as a JSON file the owner can hand to a review. Fixed ids and numbers only: no amounts, names or memos.
// It stays on this device; each device keeps its own.
import { useEffect, useState } from 'react';
import { saveFile } from '../../api/client';
import { usage } from '../../usage/tracker';
import { Card } from '../../components/ui';
import { useScreen } from '../../lib/common';
import { Page } from './common';
import { SecondaryButton } from '../../components/buttons';

const today = () => new Date().toISOString().slice(0, 10);

export function UsageScreen() {
  useScreen('settings.usage');
  const [count, setCount] = useState<number | null>(null);
  const [done, setDone] = useState<'saved' | 'deleted' | null>(null);
  useEffect(() => {
    void usage.kept().then((e) => setCount(e.length));
  }, []);
  const save = async () => {
    saveFile(
      new Blob([await usage.file()], { type: 'application/json' }),
      `ledgerline-usage-${today()}.json`,
    );
    setDone('saved');
  };
  const forget = () => {
    usage.forget();
    setCount(0);
    setDone('deleted');
  };
  const empty = count === 0;
  return (
    <Page title="Usage file" back="/settings">
      <Card>
        <div className="flex flex-col gap-3 px-3 py-3" data-testid="usage-file">
          <span className="text-sm text-muted">
            {done === 'saved'
              ? 'Saved.'
              : done === 'deleted'
                ? 'Deleted from this device.'
                : empty
                  ? 'Nothing recorded on this device yet.'
                  : `Taps and timings this device recorded in the last 90 days${count === null ? '' : `: ${count} ${count === 1 ? 'event' : 'events'}`}. No amounts or names.`}
          </span>
          <SecondaryButton track="data.usage_file" disabled={empty} onClick={() => void save()}>
            Download usage file
          </SecondaryButton>
          <SecondaryButton track="data.usage_delete" danger disabled={empty} onClick={forget}>
            Delete it from this device
          </SecondaryButton>
        </div>
      </Card>
      <span className="text-xs text-muted">
        Turn recording on or off in Appearance and preferences. Each device keeps its own file.
      </span>
    </Page>
  );
}
