// Delete account (your own) and Settings → Users (admins), D-75 and docs/open-signup.md 10, 12.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../api/client';
import { api, type UsersView } from '../../api/endpoints';
import { useSession } from '../../api/hooks';
import { Problem } from '../../components/Frame';
import {
  Card,
  ConfirmInline,
  DangerLink,
  EmptyNote,
  Field,
  Loading,
  ErrorNote,
  SecondaryButton,
  SoftButton,
  inputClass,
} from '../../components/ui';
import { wipe } from '../../copy/copy';
import { clearSavedData } from '../../state/saved';
import { Page, RowLink } from './common';

/** Settings → Sign-in: delete your own account (users who aren't admins). */
export function DeleteAccountCard() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = session.data?.budget.name ?? '';
  if (!open)
    return (
      <DangerLink className="self-start" onClick={() => setOpen(true)}>
        Delete account
      </DangerLink>
    );
  return (
    <Card>
      <div className="flex flex-col gap-3 px-3 py-3">
        <span className="text-base font-semibold">Delete account</span>
        <span className="text-sm leading-snug text-ink-2">
          Your budget and everything in it is deleted, and can’t be brought back. Download the full backup
          first if you want a copy.
        </span>
        <RowLink
          to="/settings/data"
          search={{ back: '/settings/users' }}
          name="Backup and export"
          meta="Full backup"
          track="delete.backup"
        />
        <Field label={`Type “${name}” to confirm`}>
          <input
            className={inputClass}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Problem text={err} />
        {asking ? (
          <ConfirmInline
            label="Delete account"
            confirmLabel="Delete account"
            busy={busy}
            onCancel={() => setAsking(false)}
            onConfirm={() => {
              setBusy(true);
              setErr(null);
              api.deleteAccount(typed).then(
                async () => {
                  await wipe(true).catch(() => undefined);
                  clearSavedData();
                  window.location.assign('/');
                },
                (e: unknown) => {
                  setBusy(false);
                  setAsking(false);
                  if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
                },
              );
            }}
          >
            Delete your account and budget for good?
          </ConfirmInline>
        ) : (
          <div className="flex gap-2">
            <SecondaryButton className="flex-1" onClick={() => setOpen(false)}>
              Keep account
            </SecondaryButton>
            <SecondaryButton
              danger
              className="flex-1"
              disabled={typed.trim() !== name.trim() || !name}
              onClick={() => setAsking(true)}
            >
              Delete account
            </SecondaryButton>
          </div>
        )}
      </div>
    </Card>
  );
}

const STATUS: Record<string, string> = { active: 'Active', disabled: 'Turned off', deleting: 'Deleting' };

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Admin" for the admin with no name of its own (the server's stand-in), not "Admin · Admin". */
export function userName(u: { name: string; admin: boolean }): string {
  if (!u.admin || u.name === 'Admin') return u.name;
  return `${u.name} · Admin`;
}

/** "1 of 50 users", and the day's sign-ups only while sign-up is on. */
export function usersLine(v: {
  users: number;
  maxUsers: number;
  signupsToday: number;
  signupsPerDay: number;
  signupsOpen: boolean;
}): string {
  const users = `${v.users} of ${v.maxUsers} ${v.maxUsers === 1 ? 'user' : 'users'}`;
  if (!v.signupsOpen) return `${users} · Sign-up is off`;
  return `${users} · ${v.signupsToday} of ${v.signupsPerDay} sign-ups today · Sign-up is on`;
}

/** Settings → Users: who has an account, and turning one off or on (admins only). */
export function UsersScreen() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  /** The account whose Turn off waits for a yes. */
  const [askOff, setAskOff] = useState<string | null>(null);
  const first = useQuery({ queryKey: ['users'], queryFn: () => api.users() });
  /** Pages after the first, and where the next one starts (undefined: from the first page). */
  const [extra, setExtra] = useState<UsersView['list']>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const v = first.data;
  const act = (id: string, action: 'turn-off' | 'turn-on' | 'retry-delete') => {
    setErr(null);
    setAskOff(null);
    api.userAction(id, action).then(
      () => {
        setExtra([]);
        setCursor(undefined);
        void qc.invalidateQueries({ queryKey: ['users'] });
      },
      (e: unknown) => {
        if (!(e instanceof ApiError && e.code === 'reauth')) setErr(errorMessage(e));
      },
    );
  };
  const list = [...(v?.list ?? []), ...extra];
  const next = cursor === undefined ? v?.next : cursor;
  return (
    <Page title="Users" back="/settings">
      {!v && (first.error ? <ErrorNote error={first.error} /> : <Loading />)}
      {v && (
        <>
          <span className="text-sm text-muted">{usersLine(v)}</span>
          <Problem text={err} />
          <Card>
            {list.length === 0 && <EmptyNote inCard>No users yet.</EmptyNote>}
            {list.map((u) => (
              <div key={u.id} className="flex flex-col border-t border-divider first:border-t-0">
                <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-base font-semibold">{userName(u)}</span>
                    <span className="text-xs text-muted">
                      {STATUS[u.status] ?? u.status} · joined {when(u.joinedAt)} · last seen{' '}
                      {when(u.lastSeenAt)}
                    </span>
                  </span>
                  {!u.admin && u.status === 'active' && askOff !== u.id && (
                    <SoftButton onClick={() => setAskOff(u.id)}>Turn off</SoftButton>
                  )}
                  {!u.admin && u.status === 'disabled' && (
                    <SoftButton onClick={() => act(u.id, 'turn-on')}>Turn on</SoftButton>
                  )}
                  {u.stuck && <SoftButton onClick={() => act(u.id, 'retry-delete')}>Try again</SoftButton>}
                </div>
                {askOff === u.id && (
                  <ConfirmInline
                    className="mx-3 mb-3"
                    label={`Turn off ${userName(u)}`}
                    confirmLabel="Turn off"
                    track="users.turn-off"
                    onCancel={() => setAskOff(null)}
                    onConfirm={() => act(u.id, 'turn-off')}
                  >
                    Turn off this account? It can’t sign in until you turn it on again.
                  </ConfirmInline>
                )}
              </div>
            ))}
          </Card>
          {next && (
            <SecondaryButton
              className="self-start"
              onClick={() =>
                void api.users({ before: next }).then(
                  (r) => {
                    setExtra((x) => [...x, ...r.list]);
                    setCursor(r.next);
                  },
                  (e: unknown) => setErr(errorMessage(e)),
                )
              }
            >
              Show more
            </SecondaryButton>
          )}
        </>
      )}
    </Page>
  );
}
