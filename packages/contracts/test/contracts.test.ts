// A few round trips through the contracts: what the Worker sends parses as the app reads it.
import { describe, expect, it } from 'vitest';
import {
  Badges,
  LinkFinishResult,
  OkIdResult,
  PasskeyCreateOptions,
  PasskeyGetOptions,
  SecurityView,
  Target,
  TxnPatch,
  UnpairResult,
  payeeName,
} from '../src/index';

describe('contracts', () => {
  it('passkey options keep every field the browser needs', () => {
    const create = {
      challenge: 'abc',
      rp: { name: 'Ledgerline', id: 'ledgerline.test' },
      user: { id: 'dXNlcg', name: 'Ledgerline', displayName: 'Ledgerline' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: {} },
    };
    expect(PasskeyCreateOptions.parse(create)).toEqual(create);
    const get = {
      challenge: 'xyz',
      rpId: 'ledgerline.test',
      userVerification: 'required',
      allowCredentials: [],
    };
    expect(PasskeyGetOptions.parse(get)).toEqual(get);
    expect(PasskeyCreateOptions.safeParse({ challenge: 'abc' }).success).toBe(false);
  });

  it('small answers', () => {
    expect(OkIdResult.parse({ ok: true, id: 'c1' })).toEqual({ ok: true, id: 'c1' });
    expect(UnpairResult.parse({ ok: true, rta: 0, rtaUpdating: false })).not.toHaveProperty('otherKey');
    expect(UnpairResult.parse({ ok: true, rta: 5, rtaUpdating: false, otherKey: 'k' }).otherKey).toBe('k');
    expect(Badges.safeParse({ activity: 1.5, accounts: 0, rta: 0, rtaUpdating: false }).success).toBe(false);
  });

  it('defaults fill in what an older Worker leaves out', () => {
    const v = SecurityView.parse({ passkeys: [], sessions: 1 });
    expect(v.otherSessions).toBe(0);
    expect(v.signIns).toEqual([]);
  });

  it('unions and requests', () => {
    expect(LinkFinishResult.parse({ status: 'linked', connectionId: 'c' })).toEqual({
      status: 'linked',
      connectionId: 'c',
    });
    expect(LinkFinishResult.safeParse({ status: 'linked' }).success).toBe(false);
    expect(Target.parse({ type: 'none' })).toEqual({ type: 'none' });
    expect(Target.safeParse({ type: 'refill', amount: 1, periodMonths: 2, anchor: '2026-11' }).success).toBe(
      false,
    );
    expect(TxnPatch.safeParse({ date: '2026-02-30' }).success).toBe(false);
    expect(TxnPatch.parse({ date: '2026-02-28' })).toEqual({ date: '2026-02-28' });
    expect(payeeName.parse('  Corner shop ')).toBe('Corner shop');
    expect(payeeName.safeParse(`a${String.fromCharCode(0x202e)}b`).success).toBe(false);
  });
});
