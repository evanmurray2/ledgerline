// Settings → Backup and export, for a locked budget: the full backup made on this device from its copy
// (docs/privacy.md 5.8), after a fresh passkey prompt. Locked with the recovery key by default, which the person
// types here and which must open the budget from its recovery slot in force; or saved without a lock, with a warning. The server never sees the file, and nothing in the app
// loads it back.
import { useState } from 'react';
import { confirmItsYou, saveFile } from '../../api/client';
import { checkRecoveryKey, copyBytes } from '../../copy/copy';
import { sealedBackupFile } from '../../keys/backup';
import { WayInError } from '../../keys/budget';
import { Problem } from '../../components/Frame';
import { Banner, Card, Checkbox, PrimaryButton, SectionTitle, inputClass } from '../../components/ui';

const today = () => new Date().toISOString().slice(0, 10);

export function DeviceBackup() {
  const [plain, setPlain] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setDone(false);
    try {
      if (!(await confirmItsYou())) return;
      // The typed key must open this budget from its recovery slot in force now (the log's public entries), not
      // only pass its check bytes: a key replaced since, or another budget's, would make a file nothing opens.
      if (!plain) {
        try {
          await checkRecoveryKey(typed);
        } catch (e) {
          if (e instanceof WayInError) {
            setErr(e.message);
            return;
          }
          throw e;
        }
      }
      const bytes = new Uint8Array(await copyBytes());
      if (plain) {
        saveFile(
          new Blob([bytes], { type: 'application/vnd.sqlite3' }),
          `ledgerline-backup-${today()}.sqlite`,
        );
      } else {
        const file = await sealedBackupFile(typed, bytes);
        bytes.fill(0);
        if (!file) {
          setErr('That isn’t your recovery key. Check it and try again.');
          return;
        }
        saveFile(
          new Blob([file as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }),
          `ledgerline-backup-${today()}.locked`,
        );
        setTyped('');
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle>Full backup</SectionTitle>
      <Card>
        <div className="flex flex-col gap-3 px-3 py-3" data-testid="device-backup">
          <span className="text-sm text-muted">
            {done
              ? 'Saved. Keep it somewhere safe.'
              : 'Your whole budget, made on this device. Your passkey is asked first.'}
          </span>
          {plain ? (
            <Banner tone="warn">Without a lock, anyone who gets the file can read your whole budget.</Banner>
          ) : (
            <label className="flex flex-col gap-1.5 text-base text-ink-2">
              <span>Your recovery key. Only it opens the file.</span>
              <textarea
                data-testid="backup-recovery-key"
                className={inputClass}
                rows={3}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </label>
          )}
          <label className="flex items-start gap-2.5 text-base text-ink-2">
            <Checkbox checked={plain} onChange={(e) => setPlain(e.target.checked)} />
            <span>Save it without a lock</span>
          </label>
          <Problem text={err} />
          <PrimaryButton
            track="data.backup"
            busy={busy}
            disabled={busy || (!plain && typed.trim().length === 0)}
            onClick={() => void run()}
          >
            Download
          </PrimaryButton>
        </div>
      </Card>
    </>
  );
}
