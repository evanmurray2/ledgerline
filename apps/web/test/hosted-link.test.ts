// Hosted Link in the app (docs/privacy.md 5.7): this page goes to Plaid's site, and the link is finished by asking
// the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linkToken = vi.fn();
const linkFinish = vi.fn();
const exchange = vi.fn();
vi.mock('../src/api/endpoints', () => ({ api: { linkToken, linkFinish, exchange } }));

const { leave, LEFT_HERE_KEY, resumeHostedLink, runPlaidLink } = await import('../src/lib/plaid');

const PENDING = 'ledgerline.link';
let went: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  went = [];
  linkToken
    .mockReset()
    .mockResolvedValue({ linkToken: 'link-1', hostedUrl: 'https://secure.plaid.test/hl/abc' });
  linkFinish.mockReset();
  exchange.mockReset();
  vi.spyOn(leave, 'to').mockImplementation((url) => void went.push(url));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hosted Link', () => {
  it('goes to Plaid’s page only after the link token came, and remembers the session', async () => {
    linkFinish.mockResolvedValue({ status: 'waiting' });
    void runPlaidLink('new', undefined, true);
    expect(went).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(linkToken).toHaveBeenCalledWith({
      mode: 'new',
      connectionId: undefined,
      confirmSlot: true,
      hosted: true,
    });
    expect(went).toEqual(['https://secure.plaid.test/hl/abc']);
    expect(JSON.parse(localStorage.getItem(PENDING)!)).toMatchObject({ linkToken: 'link-1', mode: 'new' });
    expect(sessionStorage.getItem(LEFT_HERE_KEY)).toBe('1');
  });

  it('a page that lives on (the Home Screen app) asks the server until the bank is linked', async () => {
    linkFinish
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValueOnce({ status: 'linked', connectionId: 'con_1' });
    const run = runPlaidLink('new', undefined, true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(linkFinish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(run).resolves.toEqual({ status: 'linked', connectionId: 'con_1' });
    expect(linkFinish).toHaveBeenLastCalledWith({ linkToken: 'link-1', mode: 'new' });
    expect(localStorage.getItem(PENDING)).toBeNull();
    expect(sessionStorage.getItem(LEFT_HERE_KEY)).toBeNull();
    // No Plaid script, and no public token ever in the app.
    expect(exchange).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="plaid"]')).toBeNull();
  });

  it('a repair ends as "repaired", and a session the person left as "exited"', async () => {
    linkFinish.mockResolvedValueOnce({ status: 'repaired' });
    const repair = runPlaidLink('repair', 'con_9', true);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(repair).resolves.toEqual({ status: 'repaired' });
    expect(linkToken).toHaveBeenCalledWith({
      mode: 'repair',
      connectionId: 'con_9',
      confirmSlot: undefined,
      hosted: true,
    });
    linkFinish.mockResolvedValueOnce({ status: 'exited' });
    const left = runPlaidLink('new', undefined, true);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(left).resolves.toEqual({ status: 'exited' });
  });

  it('gives up after 30 minutes with no answer', async () => {
    linkFinish.mockResolvedValue({ status: 'waiting' });
    const run = runPlaidLink('new', undefined, true);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    await expect(run).resolves.toEqual({ status: 'exited' });
    expect(localStorage.getItem(PENDING)).toBeNull();
  });

  it('goes nowhere when the server gives no page', async () => {
    linkToken.mockRejectedValue(new Error('All 10 bank links are used.'));
    await expect(runPlaidLink('new', undefined, true)).rejects.toThrow('All 10 bank links are used.');
    expect(went).toEqual([]);
    expect(localStorage.getItem(PENDING)).toBeNull();
    expect(sessionStorage.getItem(LEFT_HERE_KEY)).toBeNull();
  });

  it('while this page waits on its own session, a resume leaves it alone', async () => {
    linkFinish.mockResolvedValue({ status: 'waiting' });
    const run = runPlaidLink('new', undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await resumeHostedLink()).toBeNull();
    expect(linkFinish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
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
