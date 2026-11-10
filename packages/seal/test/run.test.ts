// The Worker's keys and stamps, and a bank run (docs/privacy-keys.md section 9): the Worker seals and signs, a
// device checks and opens, and someone who can write to the database tries everything.
import { describe, expect, it } from 'vitest';
import {
  afterRun,
  type Bytes,
  checkKeyMac,
  checkLinkMac,
  checkReceipts,
  checkRunsMac,
  concat,
  cursorHash,
  type DhPair,
  dhPairFromSeed,
  encodeRunManifest,
  type FilingState,
  fromHex,
  KEY_KIND,
  keyMac,
  linkMac,
  openRun,
  randomBytes,
  readRunManifest,
  RunError,
  runsMac,
  type RunState,
  type SealedRun,
  sealRun,
  serverKeys,
  type ServerKeys,
  sign,
  toHex,
  u8,
  utf8,
  verify,
  WHAT,
  type What,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const CHASE = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const CITI = '01DX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;
const SECRET = fromHex('07'.repeat(32));

describe('the Worker’s keys', () => {
  it('come from the token key’s 32 bytes under their own salt and labels, and are pinned', async () => {
    const k = await serverKeys(SECRET, 1);
    expect(k.mac.extractable).toBe(false);
    expect(k.runSign.privateKey.extractable).toBe(false);
    // The run-signing seed, derived here with WebCrypto's own HKDF.
    const ikm = await crypto.subtle.importKey('raw', SECRET, 'HKDF', false, ['deriveBits']);
    const derive = async (name: string) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: concat(utf8('ledgerline/v1/server'), u8(0)),
            info: concat(utf8(name), u8(0)),
          },
          ikm,
          256,
        ),
      );
    const pkcs8 = concat(
      fromHex('302e020100300506032b657004220420'),
      await derive('ledgerline/v1/server/run-sign'),
    );
    const theirs = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', theirs, utf8('m')));
    expect(await verify(k.runSign.pub, utf8('m'), sig)).toBe(true);
    expect(toHex(k.runSign.pub)).toBe('7a7064a78ad2f233aba1970eca1410d3068d79de7dccab38440d12576d103474');
    // The HMAC key, the same way: a stamp made by hand matches the package's.
    const macKey = await crypto.subtle.importKey(
      'raw',
      await derive('ledgerline/v1/server/mac'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const pub = fromHex('09'.repeat(32));
    const message = concat(
      utf8('ledgerline/v1/mac/key'),
      u8(0),
      Uint8Array.of(0, 0, 0, 26),
      utf8(BUDGET),
      Uint8Array.of(0, 0, 0, 3),
      u8(2),
      pub,
    );
    const byHand = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, message));
    expect(toHex(await keyMac(k, BUDGET, 3, KEY_KIND.inbox, pub))).toBe(toHex(byHand));
    // Another secret or the same bytes used directly give other keys.
    expect(toHex((await serverKeys(fromHex('08'.repeat(32)), 1)).runSign.pub)).not.toBe(toHex(k.runSign.pub));
    await expect(serverKeys(SECRET.subarray(0, 16), 1)).rejects.toThrow(RangeError);
    await expect(serverKeys(SECRET, 0)).rejects.toThrow(RangeError);
  });

  it('a key stamp holds for one budget, one version, one kind and one key', async () => {
    const k = await serverKeys(SECRET, 1);
    const pub = randomBytes(32);
    const mac = await keyMac(k, BUDGET, 2, KEY_KIND.sign, pub);
    expect(await checkKeyMac(k, BUDGET, 2, KEY_KIND.sign, pub, mac)).toBe(true);
    expect(await checkKeyMac(k, OTHER, 2, KEY_KIND.sign, pub, mac)).toBe(false);
    expect(await checkKeyMac(k, BUDGET, 3, KEY_KIND.sign, pub, mac)).toBe(false);
    expect(await checkKeyMac(k, BUDGET, 2, KEY_KIND.inbox, pub, mac)).toBe(false);
    expect(await checkKeyMac(k, BUDGET, 2, KEY_KIND.sign, randomBytes(32), mac)).toBe(false);
    expect(await checkKeyMac(await serverKeys(randomBytes(32), 1), BUDGET, 2, KEY_KIND.sign, pub, mac)).toBe(
      false,
    );
    expect(await checkKeyMac(k, BUDGET, 2, KEY_KIND.sign, pub, mac.subarray(0, 31))).toBe(false);
  });

  it('a link stamp can’t be moved to another budget, link, Item or token', async () => {
    const k = await serverKeys(SECRET, 1);
    const token = randomBytes(80);
    const mac = await linkMac(k, BUDGET, CHASE, 'item-1', token);
    expect(await checkLinkMac(k, BUDGET, CHASE, 'item-1', token, mac)).toBe(true);
    expect(await checkLinkMac(k, OTHER, CHASE, 'item-1', token, mac)).toBe(false);
    expect(await checkLinkMac(k, BUDGET, CITI, 'item-1', token, mac)).toBe(false);
    expect(await checkLinkMac(k, BUDGET, CHASE, 'item-2', token, mac)).toBe(false);
    expect(await checkLinkMac(k, BUDGET, CHASE, 'item-1', randomBytes(80), mac)).toBe(false);
    await expect(linkMac(k, BUDGET, CHASE, '', token)).rejects.toThrow(RangeError);
  });

  it('the run stamp covers the whole run state at once, whatever order the links are given in', async () => {
    const k = await serverKeys(SECRET, 1);
    const state: RunState = {
      run: 12,
      lastManifestHash: randomBytes(32),
      lastRunTime: T0,
      links: [
        { linkId: CITI, cursorHash: await cursorHash('citi-cursor-9') },
        { linkId: CHASE, cursorHash: await cursorHash('chase-cursor-4') },
      ],
    };
    const mac = await runsMac(k, BUDGET, state);
    expect(await checkRunsMac(k, BUDGET, state, mac)).toBe(true);
    expect(await checkRunsMac(k, BUDGET, { ...state, links: [...state.links].reverse() }, mac)).toBe(true);
    // No part can be moved back without the rest: the counter, the last manifest, the time, or one link's cursor.
    expect(await checkRunsMac(k, BUDGET, { ...state, run: 11 }, mac)).toBe(false);
    expect(await checkRunsMac(k, BUDGET, { ...state, lastManifestHash: randomBytes(32) }, mac)).toBe(false);
    expect(await checkRunsMac(k, BUDGET, { ...state, lastRunTime: T0 - 1 }, mac)).toBe(false);
    const rewound = [state.links[0]!, { linkId: CHASE, cursorHash: await cursorHash('chase-cursor-3') }];
    expect(await checkRunsMac(k, BUDGET, { ...state, links: rewound }, mac)).toBe(false);
    expect(await checkRunsMac(k, BUDGET, { ...state, links: [state.links[0]!] }, mac)).toBe(false);
    expect(await checkRunsMac(k, OTHER, state, mac)).toBe(false);
    await expect(runsMac(k, BUDGET, { ...state, links: [state.links[0]!, state.links[0]!] })).rejects.toThrow(
      RangeError,
    );
  });
});

/** A Worker and a device, with one inbox key. */
async function world() {
  const k = await serverKeys(SECRET, 1);
  const inbox = await dhPairFromSeed(randomBytes(32));
  const inboxes = new Map<number, DhPair>([[1, inbox]]);
  const state: FilingState = {
    budgetId: BUDGET,
    workerKeys: new Map([[1, k.runSign.pub]]),
    filedThrough: 0,
    lastManifestHash: new Uint8Array(32),
    lastRunTime: 0,
    lastInboxVersion: 0,
    cursors: new Map(),
    inboxVersion: 1,
    lastOldRun: 0,
    inbox: async (v) => inboxes.get(v) ?? null,
    now: T0 + 60_000,
  };
  return { k, inbox, inboxes, state };
}

const txns = (text: string): { what: What; payload: Uint8Array } => ({
  what: WHAT.transactions,
  payload: utf8(text),
});

async function nextRun(
  k: ServerKeys,
  inboxPub: Uint8Array,
  s: FilingState,
  linkId: string,
  cursorAfter: string,
  pages = [txns('{"added":[]}')],
  over: Partial<Parameters<typeof sealRun>[2]> = {},
): Promise<SealedRun> {
  return sealRun(
    k,
    inboxPub,
    {
      budgetId: BUDGET,
      linkId,
      run: s.filedThrough + 1,
      restart: 0,
      inboxVersion: s.inboxVersion,
      runTime: s.lastRunTime === 0 ? T0 : s.lastRunTime + 1000,
      prevRunTime: s.lastRunTime,
      cursorBefore: (s.cursors.get(linkId) ?? (await cursorHash(''))) as Bytes,
      cursorAfter: await cursorHash(cursorAfter),
      added: 1,
      modified: 0,
      removed: 0,
      prevManifestHash: s.lastManifestHash as Bytes,
      ...over,
    },
    pages,
  );
}

const refused = async (p: Promise<unknown>, why: string) => {
  await expect(p).rejects.toThrow(RunError);
  await expect(p).rejects.toThrow(why);
};

describe('a bank run', () => {
  it('is sealed by the Worker and opened by the device, page by page', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [
      txns('page one'),
      txns('page two'),
      { what: WHAT.balances, payload: utf8('balances') },
    ]);
    const filed = await openRun(state, run);
    expect(filed.pages.map((p) => [p.what, new TextDecoder().decode(p.payload)])).toEqual([
      [0, 'page one'],
      [0, 'page two'],
      [1, 'balances'],
    ]);
    expect(filed.manifest).toMatchObject({ run: 1, linkId: CHASE, flags: 1, inboxVersion: 1, n: 1 });
    // The receipt is what the filing entry shows; the Worker kept only its hash.
    expect(await checkReceipts([filed.receipt], [filed.manifest.receiptHash])).toBe(true);
    expect(await checkReceipts([randomBytes(32)], [filed.manifest.receiptHash])).toBe(false);
    expect(await checkReceipts([], [filed.manifest.receiptHash])).toBe(false);
    // A sealed page is 32 + 32 + payload + 16 bytes, and nothing in it is readable.
    expect(run.pages[0]!.length).toBe(32 + 32 + 8 + 16);
    expect(toHex(run.pages[0]!)).not.toContain(toHex(utf8('page one')));
    // The manifest reads back exactly.
    expect(toHex(encodeRunManifest(readRunManifest(run.manifest)))).toBe(toHex(run.manifest));
  });

  it('runs are filed in order, each chained to the one before, each link’s cursor continuing', async () => {
    const { k, inbox, state } = await world();
    let s = state;
    const r1 = await nextRun(k, inbox.pub, s, CHASE, 'chase-1');
    s = afterRun(s, await openRun(s, r1));
    const r2 = await nextRun(k, inbox.pub, s, CITI, 'citi-1');
    s = afterRun(s, await openRun(s, r2));
    const r3 = await nextRun(k, inbox.pub, s, CHASE, 'chase-2');
    s = afterRun(s, await openRun(s, r3));
    expect(s.filedThrough).toBe(3);

    // The same run again, a run skipped, and an old run replayed.
    await refused(openRun(s, r3), 'not the next run');
    await refused(openRun(state, r2), 'not the next run');
    await refused(openRun(afterRun(state, await openRun(state, r1)), r3), 'not the next run');
    // A run the Worker signed for the right number but chained to another past.
    const fork = await nextRun(k, inbox.pub, { ...s, lastManifestHash: randomBytes(32) }, CHASE, 'chase-3');
    await refused(openRun(s, fork), 'not chained');
    // A link rewound: the Worker, given an older cursor by a database writer, signs a run that starts from it.
    const rewound = await nextRun(
      k,
      inbox.pub,
      { ...s, cursors: new Map([[CHASE, await cursorHash('chase-1')]]) },
      CHASE,
      'x',
    );
    await refused(openRun(s, rewound), 'cursor does not continue');
    // A run time that doesn't follow, or is in the device's future.
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CITI, 'c', undefined, { runTime: s.lastRunTime })),
      'run time',
    );
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CITI, 'c', undefined, { prevRunTime: 5 })),
      'run time',
    );
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CITI, 'c', undefined, { runTime: s.now + 11 * 60_000 })),
      'dated in the future',
    );
    // Another budget's run.
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CITI, 'c', undefined, { budgetId: OTHER })),
      'another budget',
    );
  });

  it('someone who can write to the database can’t invent, change, cut or mix a run', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [txns('one'), txns('two')]);
    // No Worker secret: a run signed by another key, or by a key number the app doesn't list.
    const stranger = await serverKeys(randomBytes(32), 1);
    await refused(openRun(state, await nextRun(stranger, inbox.pub, state, CHASE, 'c1')), 'signature');
    const k2 = await serverKeys(SECRET, 2);
    await refused(openRun(state, await nextRun(k2, inbox.pub, state, CHASE, 'c1')), 'signature');
    // A manifest changed after signing, a signature that isn't this manifest's.
    const changed = run.manifest.slice();
    changed[changed.length - 40]! ^= 1;
    await refused(openRun(state, { ...run, manifest: changed }), 'signature');
    await refused(openRun(state, { ...run, signature: randomBytes(64) }), 'signature');
    // Pages dropped, swapped, changed, or added.
    await refused(openRun(state, { ...run, pages: [run.pages[0]!] }), 'page count');
    await refused(openRun(state, { ...run, pages: [run.pages[1]!, run.pages[0]!] }), 'page hash');
    const bad = run.pages[1]!.slice();
    bad[50]! ^= 1;
    await refused(openRun(state, { ...run, pages: [run.pages[0]!, bad] }), 'page hash');
    // A manifest with junk bytes, signed by nobody.
    await refused(openRun(state, { ...run, manifest: concat(run.manifest, u8(0)) }), 'manifest');
    // A page from an earlier attempt of the same run (a restart) can't stand in: it is sealed with its attempt.
    const retry = await nextRun(k, inbox.pub, state, CHASE, 'c1', [txns('one'), txns('two')], { restart: 1 });
    const mixed = readRunManifest(retry.manifest);
    const forged = encodeRunManifest({
      ...mixed,
      pages: [
        { what: 0, hash: new Uint8Array(await crypto.subtle.digest('SHA-256', run.pages[0]!)) },
        mixed.pages[1]!,
      ],
    });
    const signed = {
      manifest: forged,
      signature: await sign(
        k.runSign.privateKey,
        concat(
          utf8('ledgerline/v1/run'),
          u8(0),
          new Uint8Array(await crypto.subtle.digest('SHA-256', forged)),
        ),
      ),
      pages: [run.pages[0]!, retry.pages[1]!],
    };
    // Even signed by the Worker itself, the old attempt's page doesn't open as part of the new attempt.
    await refused(openRun(state, signed), 'a page does not open');
  });

  it('a run is sealed to the inbox key that is right for its number', async () => {
    const { k, inbox, inboxes, state } = await world();
    let s = state;
    s = afterRun(s, await openRun(s, await nextRun(k, inbox.pub, s, CHASE, 'c1')));
    // A key change: inbox key 2 is in force; runs up to 3 existed when it was written and may still use key 1.
    const inbox2 = await dhPairFromSeed(randomBytes(32));
    inboxes.set(2, inbox2);
    s = { ...s, inboxVersion: 2, lastOldRun: 3 };
    const old2 = await nextRun(k, inbox.pub, s, CHASE, 'c2', undefined, { inboxVersion: 1 });
    s = afterRun(s, await openRun(s, old2));
    const new3 = await nextRun(k, inbox2.pub, s, CITI, 'd1');
    s = afterRun(s, await openRun(s, new3));
    // Once a run used key 2, none may go back to key 1...
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CHASE, 'c3', undefined, { inboxVersion: 1 })),
      'inbox version',
    );
    // ...and past the last old run, key 1 is refused even if no run has used key 2 yet: a database writer who put
    // the old inbox key back would otherwise get new bank data sealed to a key a removed way in holds.
    const t = { ...s, filedThrough: 3, lastInboxVersion: 1 };
    const after = await nextRun(k, inbox.pub, t, CHASE, 'c3', undefined, { inboxVersion: 1 });
    await refused(openRun(t, after), 'sealed to a replaced inbox key');
    // A version the log hasn't reached, a key this device no longer holds, and a key that isn't the one named.
    await refused(
      openRun(s, await nextRun(k, inbox2.pub, s, CHASE, 'c3', undefined, { inboxVersion: 3 })),
      'inbox version',
    );
    inboxes.delete(2);
    await refused(openRun(s, await nextRun(k, inbox2.pub, s, CHASE, 'c3')), 'no inbox key');
    inboxes.set(2, inbox);
    await refused(openRun(s, await nextRun(k, inbox2.pub, s, CHASE, 'c3')), 'inbox key');
  });

  it('a manifest that breaks the format is refused by writers and readers', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [
      txns('one'),
      { what: WHAT.link, payload: utf8('the link') },
    ]);
    const m = readRunManifest(run.manifest);
    expect(m.flags).toBe(4);
    for (const change of [
      { run: 0 },
      { flags: 1 },
      { pages: [] },
      { pages: [{ what: 9 as 0, hash: m.pages[0]!.hash }] },
      { prevManifestHash: randomBytes(32) },
      { prevRunTime: 7 },
      { budgetId: 'nope' },
      { n: 0 },
    ])
      expect(() => encodeRunManifest({ ...m, ...change }), JSON.stringify(Object.keys(change))).toThrow();
    expect(() => readRunManifest(run.manifest.subarray(1))).toThrow();
    expect(() => readRunManifest(concat(run.manifest, u8(0)))).toThrow();
    await expect(sealRun(k, inbox.pub, { ...m }, [])).rejects.toThrow(RangeError);
  });
});
