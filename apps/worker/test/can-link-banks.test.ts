// Who may link a new bank (docs/open-signup.md 5, D-75).
import { describe, expect, it } from 'vitest';
import { canLinkBanks, type Ctx } from '../src/http/context.js';

const ctx = (isAdmin: boolean | undefined, OTHER_USERS_BANKS?: string) =>
  ({ get: () => isAdmin, env: { OTHER_USERS_BANKS } }) as unknown as Ctx;

describe('canLinkBanks', () => {
  it('admins may; other users only once OTHER_USERS_BANKS is on', () => {
    expect(canLinkBanks(ctx(true))).toBe(true);
    expect(canLinkBanks(ctx(false))).toBe(false);
    expect(canLinkBanks(ctx(false, 'off'))).toBe(false);
    expect(canLinkBanks(ctx(false, 'yes'))).toBe(false);
    expect(canLinkBanks(ctx(false, 'on'))).toBe(true);
  });

  it('the phone’s engine sets no admin flag: its screens leave the decision to the server', () => {
    expect(canLinkBanks(ctx(undefined))).toBe(true);
  });
});
