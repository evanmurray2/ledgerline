// Settings → Backup and export: the full backup and the usage export (CSV import and the data exports were removed).
import { useState } from 'react';
import { DumpChunk } from '@ledgerline/contracts';
import { download, get, qs, saveFile } from '../../api/client';
import { exportUrls } from '../../api/endpoints';
import { Card, ErrorNote, SectionTitle, SoftButton } from '../../components/ui';
import { useScreen } from '../../lib/common';
import { Page } from './common';
import { Why } from '../../components/Why';
import { useSession } from '../../api/hooks';

// ------------------------------------------------------------------ backup and export

/** The full backup's file name: today's date in the budget's time zone, not UTC (evening in the US is tomorrow there). */
export function backupFileName(now: Date, timeZone: string | undefined): string {
  let day: string;
  try {
    day = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'America/Los_Angeles' }).format(now);
  } catch {
    day = now.toISOString().slice(0, 10);
  }
  return `ledgerline-backup-${day}.ndjson`;
}

export function DataScreen() {
  useScreen('settings.data');
  const exportsList: [string, string, string, string][] = [
    [
      'Usage and notes (JSON)',
      'How you use the app, for reviewing what to change',
      exportUrls.usage,
      'ledgerline-usage.json',
    ],
  ];
  return (
    <Page title="Backup and export" back="/settings">
      <SectionTitle>Export</SectionTitle>
      <Card>
        {exportsList.map(([name, meta, href, filename]) => (
          <ExportRow key={name} name={name} meta={meta} href={href} filename={filename} />
        ))}
      </Card>
      <FullBackup />
      <SectionTitle>Recovery</SectionTitle>
      <Card>
        <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
          <span className="flex flex-col gap-0.5">
            <span className="text-base font-semibold">Undo window</span>
            <span className="text-xs text-muted">Your budget can be rewound to any minute</span>
          </span>
          <span className="text-sm text-ink-2">Last 30 days</span>
        </div>
      </Card>
      <span className="flex flex-col gap-1 text-xs text-muted">
        <span>For a copy older than 30 days, download the full backup above.</span>
        <Why>
          Rewinding isn’t on this screen, so a stolen sign-in can’t wipe your data. The steps are in the
          restore guide.
        </Why>
      </span>
    </Page>
  );
}

/**
 * One export. It downloads through the app rather than a plain link, so the passkey check exports need opens
 * "Confirm it's you" and then downloads, instead of saving the refusal as the file.
 */
function ExportRow({
  name,
  meta,
  href,
  filename,
}: {
  name: string;
  meta: string;
  href: string;
  filename: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await download(href, filename);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-divider first:border-t-0">
      <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
        <span className="flex flex-col gap-0.5">
          <span className="text-base font-semibold">{name}</span>
          <span className="text-xs text-muted">{meta}</span>
        </span>
        <SoftButton
          track="data.export"
          aria-label={`Download ${name}`}
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? 'Saving…' : 'Download'}
        </SoftButton>
      </div>
      {error ? (
        <div className="px-3 pb-2">
          <ErrorNote error={error} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The full backup (docs/multi-user.md 8.7): every row of the budget, downloaded in small pieces and saved as one
 * file. Unlike the JSON export, it can be restored, and it proves on restore that nothing changed.
 */
function FullBackup() {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
  const zone = useSession().data?.budget.timeZone;
  const run = async () => {
    setState('working');
    setError(null);
    try {
      const parts: string[] = [];
      let cursor: string | null = null;
      do {
        const r: DumpChunk = await get(`/api/export/dump${qs({ cursor })}`, DumpChunk);
        if (r.data) parts.push(r.data);
        cursor = r.cursor;
      } while (cursor);
      saveFile(
        new Blob([parts.join('\n') + '\n'], { type: 'application/x-ndjson' }),
        backupFileName(new Date(), zone),
      );
      setState('done');
    } catch (e) {
      setError(e);
      setState('idle');
    }
  };
  return (
    <Card>
      <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
        <span className="flex flex-col gap-0.5">
          <span className="text-base font-semibold">Full backup</span>
          <span className="text-xs text-muted">
            {state === 'done'
              ? 'Saved. Keep it somewhere safe.'
              : 'Your whole budget, in a file that can be restored'}
          </span>
        </span>
        <SoftButton track="data.backup" disabled={state === 'working'} onClick={() => void run()}>
          {state === 'working' ? 'Saving…' : 'Download'}
        </SoftButton>
      </div>
      {error ? (
        <div className="px-3 pb-2">
          <ErrorNote error={error} />
        </div>
      ) : null}
    </Card>
  );
}
