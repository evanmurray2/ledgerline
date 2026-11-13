// Settings → Privacy → What Ledgerline claims: phase 8 of docs/privacy.md. Each claim of section 1.1, whether it is
// true today for a locked budget, its limit, and whether anyone can check it or it rests on Ledgerline's word.
// docs/claims.md is the same list with the code behind each answer: change both together, and only when the code
// changes what is true.
import { isSealed } from '../../copy/copy';
import { Banner, Card, SectionTitle } from '../../components/ui';
import { Why } from '../../components/Why';
import { Page, RowLink } from './common';

export type ClaimState = 'true' | 'partly' | 'not_yet';

export interface Claim {
  id: string;
  /** The claim, as it would be published. */
  text: string;
  state: ClaimState;
  /** How anyone can check it; null when it rests on Ledgerline's word. */
  check: string | null;
  /** What it does not cover, or what is still to be built. */
  limit: string;
}

export const STATE_WORD: Record<ClaimState, string> = {
  true: 'True now',
  partly: 'Partly true now',
  not_yet: 'Not true yet',
};

const WORD = 'Ledgerline’s word: nobody outside can check it.';

/** docs/privacy.md 1.1, in its order. True for a locked budget as of Nov 13, 2026. */
export const CLAIMS: Claim[] = [
  {
    id: 'key',
    text: 'Your budget is locked on your devices with a key Ledgerline never holds.',
    state: 'true',
    check: 'You can check it: the app’s code is public, and About shows which build you run.',
    limit:
      'Like every web app, this depends on the code Ledgerline sends your browser. That code is public. Code sent to one person once can’t be seen by anyone else.',
  },
  {
    id: 'no-copy',
    text: 'Ledgerline keeps no readable copy of your budget.',
    state: 'partly',
    check: null,
    limit:
      'The copy from before the lock is deleted from the server. Cloudflare keeps 30 days of the server’s past versions, so they hold that copy until 30 days after it was deleted.',
  },
  {
    id: 'bank-data',
    text: 'Ledgerline fetches your bank data from Plaid and locks it for your devices at once. It keeps no readable copy of it.',
    state: 'partly',
    check: null,
    limit:
      'What your banks sent before the lock was in the copy from before the lock: it is deleted, and Cloudflare’s past versions hold it 30 days more. Plaid sees your bank data, and the server could change it before it locks it.',
  },
  {
    id: 'bank-key',
    text: 'Ledgerline keeps the key to each bank link, and uses it only to fetch, sign in again or remove the link. So it could fetch your bank data again.',
    state: 'true',
    check: null,
    limit: 'Removing a bank from a locked budget isn’t built yet.',
  },
  {
    id: 'no-trackers',
    text: 'No ads, no trackers and no analytics. No outside code runs in the app. You link a bank on Plaid’s own site.',
    state: 'true',
    check:
      'You can check it: every page of the app sends a Content Security Policy that allows only its own code.',
    limit:
      '“Record how I use the app” is Ledgerline’s own. For a locked budget the server keeps none of it. Sign-up is closed. Its robot check from Cloudflare needs a page of its own, which isn’t built yet.',
  },
  {
    id: 'sign-up',
    text: 'Sign-up asks for a passkey and nothing else: no name, no email address, no phone number.',
    state: 'true',
    check: 'You can check it: the sign-up screen’s code is public.',
    limit:
      'Sign-up is closed for now. The first account, the owner’s, has an email address from before sign-up stopped asking.',
  },
  {
    id: 'delete',
    text: 'When you delete your account, Ledgerline deletes what it holds and removes your bank links at Plaid. Cloudflare’s past versions keep a copy up to 30 days, locked with your keys.',
    state: 'not_yet',
    check: null,
    limit:
      'An account with a bank link can’t be deleted yet, because removing a bank at Plaid isn’t built. Whether Cloudflare keeps a deleted budget for those 30 days is not checked yet.',
  },
  {
    id: 'idle',
    text: 'An account nobody opens for 24 months is deleted the same way. Ledgerline stops fetching its bank data after 90 days.',
    state: 'not_yet',
    check: null,
    limit: 'Neither is built yet. Today nothing is deleted because an account is idle.',
  },
  {
    id: 'public-code',
    text: 'The app’s code is public, and every release is built from it in public.',
    state: 'true',
    check:
      'You can check it: build the release’s commit and compare the build hash with About. GitHub keeps a record of each build.',
    limit:
      'This covers the app on your device, not the code the server runs. A check of a release against GitHub’s record is still to do.',
  },
];

/** Not in section 1.1, but asked about: ways in and banks that a locked budget doesn't have yet. */
export const NOT_BUILT: { name: string; text: string }[] = [
  { name: 'Sign in with your recovery key', text: 'Not built yet. Keep the key: it opens your budget.' },
  { name: 'Link a new bank', text: 'Not built yet for a locked budget.' },
  { name: 'Remove a bank', text: 'Not built yet for a locked budget.' },
  { name: 'A full backup', text: 'Not built yet for a locked budget. Your devices hold the budget.' },
];

function ClaimCard({ claim }: { claim: Claim }) {
  return (
    <Card>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <span className="text-base font-semibold">{claim.text}</span>
        <span className="text-xs text-muted">
          <span className="font-bold text-ink-2">{STATE_WORD[claim.state]}.</span> {claim.check ?? WORD}
        </span>
        <Why label="What is the limit?" track={`settings.claims.limit.${claim.id}`}>
          {claim.limit}
        </Why>
      </div>
    </Card>
  );
}

/** The list, apart from the page frame, so a test can render it. `locked`: this budget is locked now. */
export function ClaimList({ locked }: { locked: boolean }) {
  return (
    <>
      {!locked && (
        <Banner tone="info" title="Your budget isn’t locked yet">
          These claims are about a locked budget.
        </Banner>
      )}
      <Why track="settings.claims.why">
        Each claim says if it is true now, and its limit. “You can check it” means anyone can. “Ledgerline’s
        word” means it depends on the server running the public code, which nobody outside can see.
      </Why>
      {CLAIMS.map((c) => (
        <ClaimCard key={c.id} claim={c} />
      ))}
      <SectionTitle>Still being built</SectionTitle>
      <Card>
        {NOT_BUILT.map((n) => (
          <div
            key={n.name}
            className="flex min-h-14 flex-col justify-center gap-0.5 border-t border-divider px-3 py-2 first:border-t-0"
          >
            <span className="text-base font-semibold">{n.name}</span>
            <span className="text-xs text-muted">{n.text}</span>
          </div>
        ))}
      </Card>
    </>
  );
}

export function ClaimsScreen() {
  const locked = isSealed();
  return (
    <Page title="What Ledgerline claims" back="/settings/privacy">
      <ClaimList locked={locked} />
      <Card>
        <RowLink
          to="/settings/about"
          name="About"
          meta="This release, and how to check it"
          track="settings.claims.about"
        />
      </Card>
    </Page>
  );
}
