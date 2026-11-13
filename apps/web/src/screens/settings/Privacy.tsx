// Settings → Privacy: what is stored, where, and who can read it, as it is today (docs/privacy.md section 2). The
// page changes with each phase of the privacy design: it never says more than is true on the day.
import { Card, SectionTitle } from '../../components/ui';
import { Why } from '../../components/Why';
import { Page, RowLink } from './common';

function Fact({ name, text }: { name: string; text: string }) {
  return (
    <div className="flex min-h-14 flex-col justify-center gap-0.5 border-t border-divider px-3 py-2 first:border-t-0">
      <span className="text-base font-semibold">{name}</span>
      <span className="text-xs text-muted">{text}</span>
    </div>
  );
}

const inTwoYears = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 2);
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
};

export function PrivacyScreen() {
  // Every budget is locked (D-102), and the readable copy from before the lock is deleted (D-106).
  return (
    <Page title="Privacy" back="/settings">
      <SectionTitle>Your budget</SectionTitle>
      <Card>
        <Fact name="On Ledgerline’s server" text="Locked. Only your devices have the key." />
        <Fact name="On this device" text="A copy, locked with your passkey." />
        <Fact name="The copy from before the lock" text="Deleted from the server." />
        <Fact
          name="Past versions"
          text="Cloudflare keeps 30 days of them. Until 30 days after the deletion, some hold the copy from before the lock."
        />
      </Card>
      <Why label="What can the server still see?">
        The size and time of each change, how many bank updates came in, and which bank links you have. It
        fetches your bank transactions, locks them for your devices at once, and keeps no readable copy.
      </Why>
      <Card>
        <RowLink
          to="/settings/privacy/claims"
          name="What Ledgerline claims"
          meta="Each claim, if it is true now, and its limit"
          track="settings.privacy.claims"
        />
      </Card>
      <SectionTitle>Your banks</SectionTitle>
      <Card>
        <Fact name="Your bank password" text="You type it at Plaid. Ledgerline never gets it." />
        <Fact name="Your transactions" text="Plaid fetches them and keeps them under its own policy." />
        <Fact name="The key to each bank link" text="Stored locked on the server, which uses it to fetch." />
      </Card>
      <SectionTitle>Who else handles your data</SectionTitle>
      <Card>
        <Fact name="Cloudflare" text="Runs the server and stores the budget." />
        <Fact name="Plaid" text="Connects to your banks." />
        <Fact name="Nobody else" text="No ads, no trackers, and no outside code in the app." />
      </Card>
      <SectionTitle>If you stop using Ledgerline</SectionTitle>
      <Card>
        <Fact name="After 90 days away" text="Bank updates stop. They start again when you open the app." />
        <Fact
          name="After 24 months away"
          text={`Your account is deleted, with its bank links at Plaid. Open the app before ${inTwoYears()} to keep it. The admin’s account is never deleted this way.`}
        />
        <Fact
          name="Delete account"
          text="In Settings → Sign-in. It removes your bank links at Plaid, then deletes your budget on the server."
        />
      </Card>
      <SectionTitle>What the server notes about you</SectionTitle>
      <Card>
        <Fact name="Your devices and passkeys" text="Their names, and when each last signed in." />
        <Fact
          name="Each request"
          text="Its address, your IP address and rough location, and your browser. Kept 3 days."
        />
        <Fact
          name="How you use the app"
          text="Taps and timings, only while “Record how I use the app” is on."
        />
      </Card>
    </Page>
  );
}
