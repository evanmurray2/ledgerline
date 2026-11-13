import { describe, expect, it, vi } from 'vitest';
import { shownFields, type ShownHost } from '../src/copy/shown';

function host(views: Record<string, unknown>, through = 42): ShownHost & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    request: async (_m, path) => {
      paths.push(path);
      const v = views[path];
      return v === undefined ? { status: 404, body: '{}' } : { status: 200, body: JSON.stringify(v) };
    },
    state: async () => ({ through }),
  };
}

describe('shownFields', () => {
  it('Close account sends the working balance, the card available and the change number', async () => {
    const h = host({ '/api/accounts/card1/register': { account: { working: 0 }, cardAvailable: 0 } });
    const sync = vi.fn(async () => undefined);
    expect(await shownFields(h, 'POST', '/api/accounts/card1/close', {}, sync)).toEqual({
      working: 0,
      available: 0,
      through: 42,
    });
    expect(sync).toHaveBeenCalledOnce();
  });

  it('a cash account has no payment category: available is 0', async () => {
    const h = host({ '/api/accounts/boa/register': { account: { working: 0 }, cardAvailable: null } });
    expect(await shownFields(h, 'POST', '/api/accounts/boa/close', {}, async () => undefined)).toEqual({
      working: 0,
      available: 0,
      through: 42,
    });
  });

  it('archiving a category sends its available; a restore sends nothing', async () => {
    const h = host({ '/api/categories/food/sheet': { available: 1250 } });
    const sync = async () => undefined;
    expect(
      await shownFields(h, 'POST', '/api/settings/categories/food/archive', { archived: true }, sync),
    ).toEqual({ available: 1250, through: 42 });
    expect(await shownFields(h, 'POST', '/api/settings/categories/food/remove', undefined, sync)).toEqual({
      available: 1250,
      through: 42,
    });
    expect(
      await shownFields(h, 'POST', '/api/settings/categories/food/archive', { archived: false }, sync),
    ).toBeNull();
  });

  it('a failed sync still sends what the copy shows; other edits need nothing', async () => {
    const h = host({ '/api/accounts/a/register': { account: { working: 500 }, cardAvailable: null } });
    const fail = async () => {
      throw new Error('offline');
    };
    expect(await shownFields(h, 'POST', '/api/accounts/a/close', {}, fail)).toEqual({
      working: 500,
      available: 0,
      through: 42,
    });
    expect(await shownFields(h, 'POST', '/api/accounts/a/reopen', {}, fail)).toBeNull();
    expect(await shownFields(h, 'PATCH', '/api/transactions/t', {}, fail)).toBeNull();
  });
});
