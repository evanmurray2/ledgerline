// The relay for adding a device with its own passkey (docs/privacy-keys.md section 10), in memory, for the mock API
// and the app's tests. It keeps the server's rules (apps/worker/src/routes/device-add.ts): one add, started by one
// sign-in and joined by one other; each message once and in order; a new commitment clears the offer and the
// reveal; at most 3 offers; 10 minutes from the start; gone once either side ends it. A sign-in is a name here.
import { ADD_ATTEMPTS, ADD_WINDOW_MS } from '@ledgerline/seal';
import type { Relay, RelayState, RelayStep } from '../copy/device-add';

/** What the server answers for a step that is not allowed now: 409, "gone". */
export class RelayGone extends Error {
  constructor() {
    super('This add ended. Start again from the signed-in device.');
  }
}

interface Add {
  from: string;
  to: string | null;
  expiresAt: number;
  offers: number;
  commit: string | null;
  offer: string | null;
  reveal: string | null;
  sealed: string | null;
  confirm: string | null;
}

export class MockRelay {
  #add: Add | null = null;
  /** How many times each sign-in asked where the add stands. */
  readonly asked = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  #live(): Add | null {
    if (this.#add && this.#add.expiresAt <= this.now()) this.#add = null;
    return this.#add;
  }

  state(me: string): RelayState {
    this.asked.set(me, (this.asked.get(me) ?? 0) + 1);
    const a = this.#live();
    if (!a) return { role: null };
    const expiresAt = new Date(a.expiresAt).toISOString();
    if (a.from === me)
      return {
        role: 'from',
        expiresAt,
        offers: a.offers,
        commit: a.commit,
        reveal: a.reveal,
        confirm: a.confirm,
      };
    if (a.to === me) return { role: 'to', expiresAt, offer: a.offer, sealed: a.sealed };
    if (a.to === null && a.sealed === null) return { role: 'waiting', expiresAt };
    return { role: null };
  }

  start(me: string): { expiresAt: string } {
    const expiresAt = this.now() + ADD_WINDOW_MS;
    this.#add = {
      from: me,
      to: null,
      expiresAt,
      offers: 0,
      commit: null,
      offer: null,
      reveal: null,
      sealed: null,
      confirm: null,
    };
    return { expiresAt: new Date(expiresAt).toISOString() };
  }

  send(me: string, step: RelayStep, body: Record<string, string | undefined>): { ok: true } {
    const a = this.#live();
    const v = (k: string) => {
      const x = body[k];
      if (typeof x !== 'string' || !/^[0-9a-f]+$/.test(x)) throw new RangeError(k);
      return x;
    };
    if (!a) throw new RelayGone();
    if (step === 'commit') {
      const commit = v('commit');
      if (a.from === me || (a.to !== null && a.to !== me) || a.sealed !== null || a.offers >= ADD_ATTEMPTS)
        throw new RelayGone();
      Object.assign(a, { to: me, commit, offer: null, reveal: null });
    } else if (step === 'offer') {
      const commit = v('commit');
      const offer = v('offer');
      if (
        a.from !== me ||
        a.commit !== commit ||
        a.offer !== null ||
        a.sealed !== null ||
        a.offers >= ADD_ATTEMPTS
      )
        throw new RelayGone();
      Object.assign(a, { offer, offers: a.offers + 1 });
    } else if (step === 'reveal') {
      const reveal = v('reveal');
      if (a.to !== me || a.offer === null || a.reveal !== null) throw new RelayGone();
      a.reveal = reveal;
    } else if (step === 'sealed') {
      const sealed = v('sealed');
      if (a.from !== me || a.reveal === null || a.sealed !== null) throw new RelayGone();
      a.sealed = sealed;
    } else {
      const confirm = v('confirm');
      if (a.to !== me || a.sealed === null || a.confirm !== null) throw new RelayGone();
      a.confirm = confirm;
    }
    return { ok: true };
  }

  end(me: string): { ok: true } {
    if (this.#add && (this.#add.from === me || this.#add.to === me)) this.#add = null;
    return { ok: true };
  }

  /** The relay as one sign-in sees it (copy/device-add.ts `Relay`). */
  as(me: string): Relay {
    return {
      state: async () => this.state(me),
      start: async () => this.start(me),
      send: async (step, body) => this.send(me, step, body),
      end: async () => this.end(me),
    };
  }
}
