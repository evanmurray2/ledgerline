// Settings → Import and export: CSV import, exports and the full backup.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DumpChunk } from '@ledgerline/contracts';
import { get, qs } from '../../api/client';
import { api, exportUrls } from '../../api/endpoints';
import { qk, useAccounts } from '../../api/hooks';
import { Card, cx, ErrorNote, Field, inputClass, PrimaryButton, SecondaryButton } from '../../components/ui';
import { useScreen } from '../../lib/common';
import { useCanWrite } from '../../state/connectivity';
import { Page } from './common';

// ------------------------------------------------------------------ import and export

export function DataScreen() {
  useScreen('settings.data');
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = useCanWrite();
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const acct = accountId || accts[0]?.id || '';
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setFile({
      name: f.name,
      text,
      rows: Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1),
    });
    setResult(null);
  };
  const doImport = async () => {
    if (!file || !acct) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importCsv({ accountId: acct, csv: file.text });
      setResult(
        `Imported ${r.imported.toLocaleString('en-US')} transactions as history. ${r.skipped.toLocaleString('en-US')} overlap your linked accounts and were skipped. Payee names were added to Payees.`,
      );
      setFile(null);
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: qk.payees });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const exportsList: [string, string, string][] = [
    ['Transactions (CSV)', 'Every transaction with category, memo and owed amounts', exportUrls.csv],
    ['Everything (JSON)', 'Full export, including rules and payee merges', exportUrls.json],
    ['Rules (JSON)', 'Your rules, in order', exportUrls.rules],
    ['Usage and notes (JSON)', 'How you use the app, for reviewing what to change', exportUrls.usage],
  ];
  return (
    <Page title="Import and export" back="/settings">
      <section className="flex shrink-0 flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-3">
        <span className="text-[15px] font-bold">Import past transactions</span>
        {!file ? (
          <>
            <span className="text-[13px] leading-snug text-muted">
              Upload a CSV export from your old budgeting app or bank. Its transactions become history:
              searchable and in reports, never in a budget month.
            </span>
            <label
              className={cx(
                'hit flex h-11 cursor-pointer items-center justify-center self-start rounded-full px-4 text-[14px] font-bold',
                canWrite ? 'bg-accent-soft text-accent' : 'bg-sunken text-disabled',
              )}
            >
              Choose file
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={!canWrite}
                data-track="data.import.choose"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </label>
          </>
        ) : (
          <>
            <span className="font-mono text-[13px]">{file.name}</span>
            <div className="flex justify-between text-[14px]">
              <span className="text-muted">Rows</span>
              <span className="tnum font-bold">{file.rows.toLocaleString('en-US')}</span>
            </div>
            <Field label="Account it came from">
              <select className={inputClass} value={acct} onChange={(e) => setAccountId(e.target.value)}>
                {accts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2">
              <SecondaryButton className="h-10 flex-1" onClick={() => setFile(null)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton
                mutates
                track="data.import"
                className="h-10 flex-[2]"
                disabled={busy}
                onClick={() => void doImport()}
              >
                Import {file.rows.toLocaleString('en-US')}
              </PrimaryButton>
            </div>
          </>
        )}
        {result && (
          <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[13px] text-funded-fg">
            {result}
          </p>
        )}
        {error ? <ErrorNote error={error} /> : null}
      </section>
      <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Export</h2>
      <Card>
        {exportsList.map(([name, meta, href]) => (
          <div
            key={name}
            className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 first:border-t-0"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{name}</span>
              <span className="text-[12px] text-muted">{meta}</span>
            </span>
            <a
              href={href}
              download
              data-track="data.export"
              aria-label={`Download ${name}`}
              className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
            >
              Download
            </a>
          </div>
        ))}
      </Card>
      <FullBackup />
      <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
        Recovery
      </h2>
      <Card>
        <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Undo window</span>
            <span className="text-[12px] text-muted">The database can be rewound to any minute</span>
          </span>
          <span className="text-[13px] text-ink-2">Last 30 days</span>
        </div>
      </Card>
      <span className="text-[12px] text-muted">
        Rewinding is done in Cloudflare, not from this screen, so a stolen session can’t wipe your data. For a
        copy older than 30 days, download the full backup above and keep it somewhere safe.
      </span>
    </Page>
  );
}

/**
 * The full backup (docs/multi-user.md 8.7): every row of the budget, downloaded in small pieces and saved as one
 * file. Unlike the JSON export, it can be restored, and it proves on restore that nothing changed.
 */
function FullBackup() {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
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
      const url = URL.createObjectURL(new Blob([parts.join('\n') + '\n'], { type: 'application/x-ndjson' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `ledgerline-backup-${new Date().toISOString().slice(0, 10)}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
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
          <span className="text-[15px] font-semibold">Full backup</span>
          <span className="text-[12px] text-muted">
            {state === 'done'
              ? 'Saved. Keep it somewhere safe.'
              : 'Every row of your budget, in a file that can be restored'}
          </span>
        </span>
        <button
          type="button"
          data-track="data.backup"
          disabled={state === 'working'}
          onClick={() => void run()}
          className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent disabled:opacity-60"
        >
          {state === 'working' ? 'Saving…' : 'Download'}
        </button>
      </div>
      {error ? (
        <div className="px-3 pb-2">
          <ErrorNote error={error} />
        </div>
      ) : null}
    </Card>
  );
}
