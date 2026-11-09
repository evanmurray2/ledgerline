// Settings → Import and export: CSV import, exports and the full backup.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DumpChunk, type ImportResult } from '@ledgerline/contracts';
import { download, get, qs, saveFile } from '../../api/client';
import { api, exportUrls } from '../../api/endpoints';
import { qk, useAccounts } from '../../api/hooks';
import {
  Banner,
  Card,
  cx,
  ErrorNote,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  softButtonClass,
  SoftButton,
} from '../../components/ui';
import { useScreen } from '../../lib/common';
import { useCanWrite } from '../../state/connectivity';
import { Page } from './common';
import { Why } from '../../components/Why';

// ------------------------------------------------------------------ import and export

const count = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'transaction' : 'transactions'}`;

/** The server's limit on a file (contracts ImportCsvRequest). */
const MAX_CHARS = 5_000_000;

/** A file's text: UTF-8, or the Windows encoding many banks still export in when it isn't valid UTF-8. */
async function fileText(f: File): Promise<string> {
  const bytes = await f.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Lines with something on them after the header, not counting line breaks inside quotes. */
function csvRows(text: string): number {
  let rows = 0;
  let filled = false;
  let quoted = false;
  for (const ch of text.replace(/^\ufeff/, '')) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (filled) rows++;
      filled = false;
    } else if (!/[\s,;"]/.test(ch)) filled = true;
  }
  if (filled) rows++;
  return Math.max(0, rows - 1);
}

/** What an import did, in one or two short sentences. */
function importMessage(r: ImportResult): string {
  const parts = [r.imported > 0 ? `Imported ${count(r.imported)} as history.` : 'Nothing new to import.'];
  if (r.duplicates > 0) parts.push(`Skipped ${count(r.duplicates)} already imported.`);
  if (r.skipped > 0) parts.push(`Skipped ${count(r.skipped)} already in your linked accounts.`);
  if (r.unreadable > 0)
    parts.push(
      `Couldn’t read the date or amount on ${r.unreadable.toLocaleString('en-US')} ${r.unreadable === 1 ? 'line' : 'lines'}.`,
    );
  return parts.join(' ');
}

export function DataScreen() {
  useScreen('settings.data');
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = useCanWrite();
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const acct = accountId || accts[0]?.id || '';
  const pick = async (input: HTMLInputElement) => {
    const f = input.files?.[0];
    // Cleared, so choosing the same file again (after fixing it) is a change too.
    input.value = '';
    if (!f) return;
    setResult(null);
    setError(null);
    setNotice(null);
    const text = await fileText(f);
    if (text.length > MAX_CHARS) return setNotice('This file is too big. Import one year at a time.');
    const rows = csvRows(text);
    if (rows === 0) return setNotice('This file has no transactions. Choose another file.');
    setFile({ name: f.name, text, rows });
  };
  const doImport = async () => {
    if (!file || !acct) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importCsv({ accountId: acct, csv: file.text });
      setResult(importMessage(r));
      setFile(null);
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: qk.payees });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const exportsList: [string, string, string, string][] = [
    [
      'Transactions (CSV)',
      'Every transaction with category, memo and owed amounts',
      exportUrls.csv,
      'ledgerline-transactions.csv',
    ],
    ['Everything (JSON)', 'Full export, including joined payees', exportUrls.json, 'ledgerline-export.json'],
    [
      'Usage and notes (JSON)',
      'How you use the app, for reviewing what to change',
      exportUrls.usage,
      'ledgerline-usage.json',
    ],
  ];
  return (
    <Page title="Import and export" back="/settings">
      <section className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-line bg-surface p-3">
        <span className="text-base font-bold">Import past transactions</span>
        {accts.length === 0 && accounts.data ? (
          // An import goes into one of your accounts: with none, there's nothing to pick.
          <span className="text-sm leading-snug text-muted">
            Link a bank first. Imports go into one of its accounts.
          </span>
        ) : !file ? (
          <>
            <span className="text-sm leading-snug text-muted">
              Upload a CSV file from your bank or another app. It becomes history for search and reports, not
              your budget.
            </span>
            <label
              // The pill look on a label (the file input inside it is the control); the shared disabled look
              // follows the input.
              className={cx(
                softButtonClass(),
                'cursor-pointer self-start has-[:disabled]:cursor-not-allowed has-[:disabled]:bg-sunken has-[:disabled]:text-disabled',
              )}
            >
              Choose file
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={!canWrite}
                data-track="data.import.choose"
                onChange={(e) => void pick(e.target)}
              />
            </label>
          </>
        ) : (
          <>
            <span className="font-mono text-sm">{file.name}</span>
            <div className="flex justify-between text-md">
              <span className="text-muted">Transactions</span>
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
              <SecondaryButton className="flex-1" onClick={() => setFile(null)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton
                mutates
                track="data.import"
                className="flex-[2]"
                busy={busy}
                disabled={busy}
                onClick={() => void doImport()}
              >
                Import {count(file.rows)}
              </PrimaryButton>
            </div>
          </>
        )}
        {result && (
          <Banner tone="success" icon="check">
            {result}
          </Banner>
        )}
        {notice && (
          <Banner tone="warn" icon="alert">
            {notice}
          </Banner>
        )}
        {error ? <ErrorNote error={error} /> : null}
      </section>
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
        `ledgerline-backup-${new Date().toISOString().slice(0, 10)}.ndjson`,
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
