// Settings → About: the release this device runs, as its version, its commit and its build hash, so anyone can
// compare it with a build of the public code (docs/privacy.md 5.9, docs/runbooks/verify-build.md). The page works
// offline: the version and the commit are in the code, and the build hash shows only when the server can be read.
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, softButtonClass } from '../../components/ui';
import { toast } from '../../components/Toast';
import { Why } from '../../components/Why';
import { COMMIT, WEB_VERSION, fetchRelease, shortCommit, type Release } from '../../lib/release';
import { Page, RowLink } from './common';

function Fact({ name, children, action }: { name: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-2 first:border-t-0">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-semibold">{name}</span>
        <span className="text-xs text-muted">{children}</span>
      </span>
      {action}
    </div>
  );
}

function CopyButton({
  value,
  label,
  done,
  track,
}: {
  value: string;
  label: string;
  done: string;
  track: string;
}) {
  return (
    <Button
      track={track}
      aria-label={label}
      className={softButtonClass('outline')}
      onClick={() =>
        void navigator.clipboard?.writeText(value).then(
          () => toast.show({ text: done }),
          () => undefined,
        )
      }
    >
      Copy
    </Button>
  );
}

/** The three facts. `load` is the read of /release.json; `commit` is the commit in this code. */
export function ReleaseFacts({
  commit = COMMIT,
  version = WEB_VERSION,
  load = fetchRelease,
}: {
  commit?: string;
  version?: string;
  load?: () => Promise<Release | null>;
}) {
  // undefined: still reading. null: could not read.
  const [release, setRelease] = useState<Release | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void load().then((r) => live && setRelease(r));
    return () => {
      live = false;
    };
  }, [load]);
  const isRelease = commit !== 'dev';
  // The server can be one release ahead of the code on this device: its hash is then not this code's hash.
  const hash = release && release.commit === commit ? release.hash : null;
  return (
    <Card>
      <Fact name="Version">{version}</Fact>
      <Fact
        name="Commit"
        action={
          isRelease && (
            <CopyButton
              value={commit}
              label="Copy commit"
              done="Commit copied"
              track="settings.about.copy_commit"
            />
          )
        }
      >
        {isRelease ? <span className="font-mono">{shortCommit(commit)}</span> : 'Test build, not a release'}
      </Fact>
      <Fact
        name="Build hash"
        action={
          hash && (
            <CopyButton
              value={hash}
              label="Copy build hash"
              done="Build hash copied"
              track="settings.about.copy_hash"
            />
          )
        }
      >
        {hash ? (
          <span className="break-all font-mono">{hash}</span>
        ) : release === undefined ? (
          'Checking'
        ) : release ? (
          'A newer release is ready. Close Ledgerline and open it again.'
        ) : (
          'Not available now. Connect to the internet and open this page again.'
        )}
      </Fact>
    </Card>
  );
}

export function AboutScreen() {
  return (
    <Page title="About" back="/settings">
      <ReleaseFacts />
      <Why track="settings.about.why">
        Ledgerline’s code is public. Anyone can build this commit and get the same files. The build hash is
        one number for all of those files. If their number is the same, this release came from the public
        code. This covers the app on your device, not the server.
      </Why>
      {/* The claims this check backs, each with its limit (docs/claims.md, the same list). */}
      <Card>
        <RowLink
          to="/settings/privacy/claims"
          name="What Ledgerline claims"
          meta="Each claim, if it is true now, and its limit"
          track="settings.about.claims"
        />
      </Card>
    </Page>
  );
}
