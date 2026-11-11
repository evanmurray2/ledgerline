// Hosted Link in the app (docs/privacy.md 5.7): a tab on Plaid's site, and the link finished by asking the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linkToken = vi.fn();
const linkFinish = vi.fn();
const exchange = vi.fn();
vi.mock('../src/api/endpoints', () => ({ api: { linkToken, linkFinish, exchange } }));

const { resumeHostedLink, runPlaidLink } = await import('../src/lib/plaid');

const PENDING = 'ledgerline.link';
const tab = { closed: false, location: { href: '' }, close: vi.fn(() => (tab.closed = true)) };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  tab.closed = false;
  tab.location.href = '';
  tab.close.mockClear();
  linkToken
    .mockReset()
    .mockResolvedValue({ linkToken: 'link-1', hostedUrl: 'https://secure.plaid.test/hl/abc' });
  linkFinish.mockReset();
  exchange.mockReset();
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hosted Link', () => {
  it('opens the tab before anything is awaited, sends it to Plaid’s page, and asks the server until it is linked', async () => {
    linkFinish
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValueOnce({ status: 'linked', connectionId: 'con_1' });
    const run = runPlaidLink('new', undefined, true);
    // Still inside the tap: the tab is open before the link token has come.
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');

    await vi.advanceTimersByTimeAsync(0);
    expect(linkToken).toHaveBeenCalledWith({
      mode: 'new',
      connectionId: undefined,
      confirmSlot: true,
      hosted: true,
    });
    expect(tab.location.href).toBe('https://secure.plaid.test/hl/abc');
    expect(JSON.parse(localStorage.getItem(PENDING)!)).toMatchObject({ linkToken: 'link-1', mode: 'new' });

    await vi.advanceTimersByTimeAsync(2500);
    expect(linkFinish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(run).resolves.toEqual({ status: 'linked', connectionId: 'con_1' });
    expect(linkFinish).toHaveBeenLastCalledWith({ linkToken: 'link-1', mode: 'new' });
    expect(tab.close).toHaveBeenCalled();
    expect(localStorage.getItem(PENDING)).toBeNull();
    // No Plaid script, and no public token ever in the app.
    expect(exchange).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="plaid"]')).toBeNull();
  });

  it('a repair ends as "repaired"', async () => {
    linkFinish.mockResolvedValue({ status: 'repaired' });
    const run = runPlaidLink('repair', 'con_9', true);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(run).resolves.toEqual({ status: 'repaired' });
    expect(linkToken).toHaveBeenCalledWith({
      mode: 'repair',
      connectionId: 'con_9',
      confirmSlot: undefined,
      hosted: true,
    });
  });

  it('ends as "exited" when the person closes the tab and Plaid has nothing', async () => {
    linkFinish.mockResolvedValue({ status: 'waiting' });
    const run = runPlaidLink('new', undefined, true);
    await vi.advanceTimersByTimeAsync(2500);
    tab.closed = true;
    await vi.advanceTimersByTimeAsync(2500 * 3);
    await expect(run).resolves.toEqual({ status: 'exited' });
    expect(localStorage.getItem(PENDING)).toBeNull();
  });

  it('closes the tab and fails when the server gives no page', async () => {
    linkToken.mockRejectedValue(new Error('All 10 bank links are used.'));
    await expect(runPlaidLink('new', undefined, true)).rejects.toThrow('All 10 bank links are used.');
    expect(tab.close).toHaveBeenCalled();
    expect(localStorage.getItem(PENDING)).toBeNull();
  });

  it('while this page waits on its own session, a resume leaves it alone', async () => {
    linkFinish.mockResolvedValue({ status: 'waiting' });
    const run = runPlaidLink('new', undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await resumeHostedLink()).toBeNull();
    expect(linkFinish).not.toHaveBeenCalled();
    tab.closed = true;
    await vi.advanceTimersByTimeAsync(2500 * 4);
    await run;
  });
});

describe('coming back to a hosted Link session', () => {
  const pending = (over: object = {}) =>
    localStorage.setItem(
      PENDING,
      JSON.stringify({ linkToken: 'link-2', mode: 'new', at: Date.now(), ...over }),
    );

  it('asks the server once and says what it came to', async () => {
    pending();
    linkFinish.mockResolvedValue({ status: 'linked', connectionId: 'con_2' });
    expect(await resumeHostedLink()).toEqual({ status: 'linked', connectionId: 'con_2' });
    expect(linkFinish).toHaveBeenCalledWith({ linkToken: 'link-2', mode: 'new' });
    expect(localStorage.getItem(PENDING)).toBeNull();
    // Nothing is left to ask about.
    expect(await resumeHostedLink()).toBeNull();
    expect(linkFinish).toHaveBeenCalledTimes(1);
  });

  it('names the bank of a repair', async () => {
    pending({ mode: 'repair', connectionId: 'con_9' });
    linkFinish.mockResolvedValue({ status: 'repaired' });
    expect(await resumeHostedLink()).toEqual({ status: 'repaired', connectionId: 'con_9' });
  });

  it('keeps waiting while the person is still at Plaid', async () => {
    pending();
    linkFinish.mockResolvedValue({ status: 'waiting' });
    expect(await resumeHostedLink()).toBeNull();
    expect(localStorage.getItem(PENDING)).not.toBeNull();
  });

  it('forgets a session older than its link token, and one it can’t read', async () => {
    pending({ at: Date.now() - 31 * 60 * 1000 });
    expect(await resumeHostedLink()).toBeNull();
    localStorage.setItem(PENDING, '{not json');
    expect(await resumeHostedLink()).toBeNull();
    expect(linkFinish).not.toHaveBeenCalled();
  });
});
