// The app shell and the pages around it: sign-up's robot check, the privacy policy, screens that load later, and small texts.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { takeCheckToken } from '../src/screens/Signup';
import { userName, usersLine } from '../src/screens/settings/People';
import { tellApart } from '../src/screens/settings/SignIn';
import { passkeyName } from '../src/lib/device-name';
import { createMemoryHistory } from '@tanstack/react-router';
import { closingSheet, sheetAwareHistory } from '../src/lib/back';
import { monthParam } from '../src/lib/month-param';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';

describe('Repair a bank: a link that isn’t there', () => {
  it('says it wasn’t found, not that it doesn’t need a sign-in', async () => {
    window.__desktop = false;
    connectivity.setOnline(true);
    connectivity.reportOk();
    installMock('default', 0, (now) => novemberCopy(now));
    const history = createMemoryHistory({ initialEntries: ['/accounts/repair/BOGUS'] });
    render(<App history={history} queryClient={makeQueryClient()} />);
    expect(
      await screen.findByText('This bank link wasn’t found. It may have been removed.', undefined, {
        timeout: 4000,
      }),
    ).toBeTruthy();
  });
});

describe('?month= in a link', () => {
  const now = new Date(2026, 10, 14);
  it('drops a month the app can’t show, so the address says the month on screen', () => {
    expect(monthParam('2026-10', {}, now)).toBe('2026-10');
    expect(monthParam('2026-13', {}, now)).toBeUndefined();
    // Ten years and more away: out of the budget's reach.
    expect(monthParam('2036-12', {}, now)).toBeUndefined();
    expect(monthParam('2016-01', {}, now)).toBeUndefined();
    // Activity never shows a month after this one.
    expect(monthParam('2040-05', { notAfterNow: true }, now)).toBeUndefined();
    expect(monthParam('2027-03', { notAfterNow: true }, now)).toBeUndefined();
    expect(monthParam('2026-09', { notAfterNow: true }, now)).toBe('2026-09');
  });
});

describe('Closing a sheet', () => {
  it('goes back to the screen under it instead of adding a page, so Back doesn’t open it again', () => {
    const h = sheetAwareHistory(createMemoryHistory({ initialEntries: ['/budget'] }));
    h.push('/budget/category/rent');
    closingSheet(() => h.push('/budget'));
    expect(h.location.pathname).toBe('/budget');
    expect(h.canGoBack()).toBe(false);
  });

  it('replaces the sheet’s page when the page before is another one (a deep link)', () => {
    const h = sheetAwareHistory(createMemoryHistory({ initialEntries: ['/activity'] }));
    h.push('/budget/category/rent');
    closingSheet(() => h.push('/budget'));
    expect(h.location.pathname).toBe('/budget');
    h.back();
    expect(h.location.pathname).toBe('/activity');
  });

  it('leaves other navigation alone', () => {
    const h = sheetAwareHistory(createMemoryHistory({ initialEntries: ['/budget'] }));
    h.push('/activity');
    h.push('/budget');
    h.back();
    expect(h.location.pathname).toBe('/activity');
  });
});

describe('Settings texts', () => {
  it('Users: users, not accounts; "Admin" once; no sign-up count while sign-up is off', () => {
    const v = { users: 1, maxUsers: 1, signupsToday: 1, signupsPerDay: 50, signupsOpen: false };
    expect(usersLine(v)).toBe('1 of 1 user · Sign-up is off');
    expect(usersLine({ ...v, maxUsers: 50, signupsOpen: true })).toBe(
      '1 of 50 users · 1 of 50 sign-ups today · Sign-up is on',
    );
    expect(userName({ name: 'Admin', admin: true })).toBe('Admin');
    expect(userName({ name: 'Sam', admin: true })).toBe('Sam · Admin');
    expect(userName({ name: 'Account', admin: false })).toBe('Account');
  });

  it('Sign-in: two devices that read the same get a number, oldest first', () => {
    const row = (id: string, name: string, at: string) => ({
      id,
      name,
      signedInAt: at,
      current: false,
      saved: false,
    });
    const out = tellApart([
      row('b', 'Linux · Chrome', '2026-11-14T10:00:00Z'),
      row('a', 'Linux · Chrome', '2026-11-14T09:00:00Z'),
      row('c', 'iPhone · Safari', '2026-11-14T08:00:00Z'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['Linux · Chrome 2', 'Linux · Chrome 1', 'iPhone · Safari']);
  });

  it('a new passkey is named after the device and the day, never "This device"', () => {
    const at = new Date('2026-11-14T12:00:00Z');
    expect(passkeyName(at, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0')).toBe('Linux computer, Nov 14');
    expect(passkeyName(at, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone, Nov 14');
  });
});

afterEach(() => cleanup());

describe('Create account: the robot check on its own address', () => {
  it('takes the token from the address once, and leaves nothing of it there', () => {
    history.replaceState(null, '', '/budget?x=1#check=abc.DEF-1');
    expect(takeCheckToken()).toBe('abc.DEF-1');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
    expect(takeCheckToken()).toBeNull();
    history.replaceState(null, '', '/budget#other');
    expect(takeCheckToken()).toBeNull();
    expect(window.location.hash).toBe('#other');
    history.replaceState(null, '', '/');
  });
});

describe('The privacy policy page', () => {
  it('opens with no sign-in and shows the policy without the owner’s review marks', async () => {
    window.__desktop = false;
    installMock('default', 0, (now) => novemberCopy(now));
    const history = createMemoryHistory({ initialEntries: ['/privacy-policy?back=/settings'] });
    render(<App history={history} queryClient={makeQueryClient()} />);
    expect(await screen.findByRole('heading', { name: 'The short version' }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Privacy policy' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('owner reads');
    expect(document.body.textContent).not.toContain('(later)');
    expect(screen.getByRole('link', { name: 'https://my.plaid.com' }).getAttribute('rel')).toContain(
      'noopener',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    await waitFor(() => expect(history.location.pathname).toBe('/settings'));
  });
});
