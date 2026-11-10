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
  FormatError,
  fromHex,
  hpke,
  KEY_KIND,
  keyMac,
  linkMac,
  openRun,
  randomBytes,
  readRunManifest,
  RestartRun,
  RunError,
  type RunManifest,
  runsMac,
  type RunState,
  type SealedRun,
  sealPage,
  serverKeys,
  type ServerKeys,
  sign,
  signRun,
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
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as Bytes));
const be = (n: number, bytes: number) => fromHex(n.toString(16).padStart(bytes * 2, '0'));
const ulid = (id: string) => concat(be(26, 4), utf8(id));

/** A key derived from the Worker's secret with WebCrypto's own HKDF, written out apart from the package's. */
async function derive(name: string): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await crypto.subtle.importKey('raw', SECRET, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
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
}

async function macByHand(message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await derive('ledgerline/v1/server/mac'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, message as Bytes)));
}

describe('the Worker’s keys', () => {
  it('come from the token key’s 32 bytes under their own salt and labels, and are pinned', async () => {
    const k = await serverKeys(SECRET, 1);
    expect(k.mac.extractable).toBe(false);
    expect(k.runSign.privateKey.extractable).toBe(false);
    const pkcs8 = concat(
      fromHex('302e020100300506032b657004220420'),
      await derive('ledgerline/v1/server/run-sign'),
    );
    const theirs = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', theirs, utf8('m')));
    expect(await verify(k.runSign.pub, utf8('m'), sig)).toBe(true);
    expect(toHex(k.runSign.pub)).toBe('7a7064a78ad2f233aba1970eca1410d3068d79de7dccab38440d12576d103474');
    // Another secret gives other keys, and the secret itself is not the signing seed.
    expect(toHex((await serverKeys(fromHex('08'.repeat(32)), 1)).runSign.pub)).not.toBe(toHex(k.runSign.pub));
    const direct = await crypto.subtle.importKey(
      'pkcs8',
      concat(fromHex('302e020100300506032b657004220420'), SECRET),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const directSig = new Uint8Array(await crypto.subtle.sign('Ed25519', direct, utf8('m')));
    expect(await verify(k.runSign.pub, utf8('m'), directSig)).toBe(false);
    await expect(serverKeys(SECRET.subarray(0, 16), 1)).rejects.toThrow(RangeError);
    await expect(serverKeys(SECRET, 0)).rejects.toThrow(RangeError);
  });

  it('each stamp is exactly the HMAC the formats give, written out by hand', async () => {
    const k = await serverKeys(SECRET, 1);
    const pub = fromHex('09'.repeat(32));
    expect(toHex(await keyMac(k, BUDGET, 3, KEY_KIND.inbox, pub))).toBe(
      await macByHand(concat(utf8('ledgerline/v1/mac/key'), u8(0), ulid(BUDGET), be(3, 4), u8(2), pub)),
    );
    const token = utf8('dG9rZW4gY2lwaGVydGV4dA==');
    expect(toHex(await linkMac(k, BUDGET, CHASE, 'item-abc', token))).toBe(
      await macByHand(
        concat(
          utf8('ledgerline/v1/mac/link'),
          u8(0),
          ulid(BUDGET),
          ulid(CHASE),
          be(8, 4),
          utf8('item-abc'),
          be(token.length, 4),
          token,
        ),
      ),
    );
    const last = fromHex('aa'.repeat(32));
    const [c1, c2] = [await cursorHash('chase-4'), await cursorHash('citi-9')];
    const state: RunState = {
      run: 12,
      lastManifestHash: last,
      lastRunTime: T0,
      links: [
        { linkId: CITI, cursorHash: c2 },
        { linkId: CHASE, cursorHash: c1 },
      ],
    };
    // The links are written in ascending order of id, whatever order they were given in.
    expect(toHex(await runsMac(k, BUDGET, state))).toBe(
      await macByHand(
        concat(
          utf8('ledgerline/v1/mac/runs'),
          u8(0),
          ulid(BUDGET),
          be(12, 8),
          last,
          be(T0, 8),
          be(2, 2),
          ulid(CHASE),
          c1,
          ulid(CITI),
          c2,
        ),
      ),
    );
    // A cursor's hash is the SHA-256 of its text; a link that has never run has the empty cursor.
    expect(toHex(await cursorHash('chase-4'))).toBe(toHex(await sha(utf8('chase-4'))));
    expect(toHex(await cursorHash(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
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
    // An Item id is printable ASCII: text that isn't well formed would turn into the same bytes as other text.
    for (const id of ['', 'item 1', 'item\ud800', 'ítem', 'x'.repeat(256)])
      await expect(linkMac(k, BUDGET, CHASE, id, token), JSON.stringify(id)).rejects.toThrow(RangeError);
  });

  it('checking a stamp on values that could never have been stamped says no, and doesn’t crash', async () => {
    const k = await serverKeys(SECRET, 1);
    const mac = randomBytes(32);
    const token = randomBytes(80);
    expect(await checkKeyMac(k, 'not-a-budget', 1, KEY_KIND.sign, randomBytes(32), mac)).toBe(false);
    expect(await checkKeyMac(k, BUDGET, 0, KEY_KIND.sign, randomBytes(32), mac)).toBe(false);
    expect(await checkKeyMac(k, BUDGET, 1, KEY_KIND.sign, randomBytes(31), mac)).toBe(false);
    expect(await checkLinkMac(k, BUDGET, 'not-a-link', 'item-1', token, mac)).toBe(false);
    expect(await checkLinkMac(k, BUDGET, CHASE, '', token, mac)).toBe(false);
    const state: RunState = { run: 0, lastManifestHash: new Uint8Array(32), lastRunTime: 0, links: [] };
    const twice = { linkId: CHASE, cursorHash: randomBytes(32) };
    expect(await checkRunsMac(k, BUDGET, { ...state, links: [twice, twice] }, mac)).toBe(false);
    expect(await checkRunsMac(k, BUDGET, { ...state, run: 3 }, mac)).toBe(false);
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
    // Before any run there is no last manifest and no last time; a state that says otherwise is not stamped.
    const empty: RunState = { run: 0, lastManifestHash: new Uint8Array(32), lastRunTime: 0, links: [] };
    expect((await runsMac(k, BUDGET, empty)).length).toBe(32);
    await expect(runsMac(k, BUDGET, { ...empty, lastRunTime: 5 })).rejects.toThrow(RangeError);
    await expect(runsMac(k, BUDGET, { ...state, run: 0 })).rejects.toThrow(RangeError);
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
    retiredAt: new Map(),
    inbox: async (v) => inboxes.get(v) ?? null,
    now: T0 + 60_000,
  };
  return { k, inbox, inboxes, state };
}

type PageIn = { what: What; payload: Uint8Array };
const txns = (text: string): PageIn => ({ what: WHAT.transactions, payload: utf8(text) });
const link = (text = 'the link'): PageIn => ({ what: WHAT.link, payload: utf8(text) });

/** The Worker's two steps for the next run of `s`: seal each page, then sign. A link's first run describes the link. */
async function nextRun(
  k: ServerKeys,
  inboxPub: Uint8Array,
  s: FilingState,
  linkId: string,
  cursorAfter: string,
  pages?: PageIn[],
  over: Partial<RunManifest> = {},
  inForce?: { inboxVersion: number; lastRunForOld: number },
): Promise<SealedRun> {
  const list = pages ?? (s.cursors.has(linkId) ? [txns('{"added":[]}')] : [link(), txns('{"added":[]}')]);
  const fields = {
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
  };
  const sealed: Bytes[] = [];
  const named: RunManifest['pages'] = [];
  for (let p = 0; p < list.length; p++) {
    const r = await sealPage(k, inboxPub, { ...fields, page: p }, list[p]!.what, list[p]!.payload);
    sealed.push(r.sealed);
    named.push(r.page);
  }
  const signed = await signRun(
    k,
    inboxPub,
    { ...fields, pages: named },
    inForce ?? { inboxVersion: fields.inboxVersion, lastRunForOld: 0 },
  );
  return { ...signed, pages: sealed };
}

const refused = async (p: Promise<unknown>, why: string, retry = false) => {
  await expect(p).rejects.toBeInstanceOf(RunError);
  await expect(p).rejects.toMatchObject({ why, retry });
};

describe('a bank run', () => {
  it('is sealed by the Worker and opened by the device, page by page', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [
      link('the link'),
      txns('page one'),
      txns('page two'),
      { what: WHAT.balances, payload: utf8('balances') },
    ]);
    const filed = await openRun(state, run);
    expect(filed.pages.map((p) => [p.what, new TextDecoder().decode(p.payload)])).toEqual([
      [3, 'the link'],
      [0, 'page one'],
      [0, 'page two'],
      [1, 'balances'],
    ]);
    expect(filed.manifest).toMatchObject({ run: 1, linkId: CHASE, flags: 5, inboxVersion: 1, n: 1 });
    // The receipt is what the filing entry shows; the Worker kept only its hash.
    expect(await checkReceipts([filed.receipt], [filed.manifest.receiptHash])).toBe(true);
    expect(await checkReceipts([randomBytes(32)], [filed.manifest.receiptHash])).toBe(false);
    expect(await checkReceipts([], [filed.manifest.receiptHash])).toBe(false);
    expect(await checkReceipts([], [])).toBe(false);
    const many = Array.from({ length: 257 }, () => filed.receipt);
    expect(
      await checkReceipts(
        many,
        many.map(() => filed.manifest.receiptHash),
      ),
    ).toBe(false);
    // A sealed page is 32 + 32 + payload + 16 bytes, and nothing in it is readable.
    expect(run.pages[1]!.length).toBe(32 + 32 + 8 + 16);
    expect(toHex(run.pages[1]!)).not.toContain(toHex(utf8('page one')));
  });

  it('a page, the receipt, the manifest and its signature are exactly what the formats give', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [link('L'), txns('rows')], {
      restart: 2,
      added: 7,
      modified: 1,
      removed: 3,
    });
    // Page 1, opened by hand: the HPKE info and associated data written out.
    const info = concat(utf8('ledgerline/v1/hpke/inbox'), u8(0), ulid(BUDGET), ulid(CHASE), be(1, 4));
    const aad = (p: number, what: number) => concat(be(1, 8), be(2, 4), be(p, 2), u8(what));
    const plain1 = await hpke.open(inbox, info, aad(1, 0), run.pages[1]!);
    expect(toHex(plain1.subarray(32))).toBe(toHex(utf8('rows')));
    const plain0 = await hpke.open(inbox, info, aad(0, 3), run.pages[0]!);
    // Each page starts with HMAC(K_mac, label || str(budgetId) || str(linkId) || u64(run) || u32(restart) || u16(p)).
    const part = (p: number) =>
      macByHand(
        concat(
          utf8('ledgerline/v1/receipt-part'),
          u8(0),
          ulid(BUDGET),
          ulid(CHASE),
          be(1, 8),
          be(2, 4),
          be(p, 2),
        ),
      );
    expect(toHex(plain0.subarray(0, 32))).toBe(await part(0));
    expect(toHex(plain1.subarray(0, 32))).toBe(await part(1));
    // The receipt is H(label || r_0 || r_1), and the manifest holds its hash.
    const receipt = await sha(
      concat(utf8('ledgerline/v1/receipt'), u8(0), plain0.subarray(0, 32), plain1.subarray(0, 32)),
    );
    expect(toHex((await openRun(state, run)).receipt)).toBe(toHex(receipt));
    // The manifest, field by field.
    const expected =
      toHex(utf8('LLR1')) +
      toHex(ulid(BUDGET)) +
      toHex(ulid(CHASE)) +
      '0000000000000001' +
      '00000002' +
      '00000001' +
      toHex(await sha(inbox.pub)) +
      toHex(be(T0, 8)) +
      '0000000000000000' +
      toHex(await sha(utf8(''))) +
      toHex(await sha(utf8('c1'))) +
      '04' +
      '00000007' +
      '00000001' +
      '00000003' +
      '0002' +
      '03' +
      toHex(await sha(run.pages[0]!)) +
      '00' +
      toHex(await sha(run.pages[1]!)) +
      toHex(await sha(receipt)) +
      '00'.repeat(32) +
      '00000001';
    expect(toHex(run.manifest)).toBe(expected);
    // The signature is over label || 0x00 || H(manifest).
    const message = concat(utf8('ledgerline/v1/run'), u8(0), await sha(run.manifest));
    expect(await verify(k.runSign.pub, message, run.signature)).toBe(true);
  });

  it('runs are filed in order, each chained to the one before, each link’s cursor continuing', async () => {
    const { k, inbox, state } = await world();
    let s = state;
    const r1 = await nextRun(k, inbox.pub, s, CHASE, 'chase-1');
    s = afterRun(s, await openRun(s, r1));
    // A link's first run comes after another link has run: its cursor starts from nothing.
    const r2 = await nextRun(k, inbox.pub, s, CITI, 'citi-1');
    s = afterRun(s, await openRun(s, r2));
    const r3 = await nextRun(k, inbox.pub, s, CHASE, 'chase-2');
    const before3 = s;
    s = afterRun(s, await openRun(s, r3));
    expect(s.filedThrough).toBe(3);

    // The same run again, a run skipped, and an old run replayed.
    await refused(openRun(s, r3), 'not the next run');
    await refused(openRun(state, r2), 'not the next run');
    await refused(openRun(afterRun(state, await openRun(state, r1)), r3), 'not the next run');
    // A run the Worker signed for the right number but chained to another past.
    const fork = await nextRun(k, inbox.pub, { ...s, lastManifestHash: randomBytes(32) }, CHASE, 'chase-3');
    await refused(openRun(s, fork), 'not chained to the run before');
    // A link rewound: the Worker, given an older cursor by a database writer, signs a run that starts from it.
    const old = { ...s, cursors: new Map([[CHASE, await cursorHash('chase-1')]]) };
    await refused(openRun(s, await nextRun(k, inbox.pub, old, CHASE, 'x')), 'cursor does not continue');
    // A previous run time that isn't the last run's.
    const skew = await nextRun(k, inbox.pub, s, CITI, 'c', undefined, { prevRunTime: s.lastRunTime - 1 });
    await refused(openRun(s, skew), 'run time does not follow the run before');
    // Another budget's run.
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CITI, 'c', undefined, { budgetId: OTHER })),
      'another budget',
    );
    // The state after a run is only ever made from the run that follows it.
    const filed3 = await openRun(before3, r3);
    expect(() => afterRun(s, filed3)).toThrow(RangeError);
    expect(() => afterRun(state, filed3)).toThrow(RangeError);
  });

  it('a link’s first run, and only that one, describes the link', async () => {
    const { k, inbox, state } = await world();
    await refused(
      openRun(state, await nextRun(k, inbox.pub, state, CHASE, 'c1', [txns('x')])),
      'link description',
    );
    const s = afterRun(state, await openRun(state, await nextRun(k, inbox.pub, state, CHASE, 'c1')));
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CHASE, 'c2', [link(), txns('x')])),
      'link description',
    );
  });

  it('a run’s time is later than the run before, and not in the device’s future', async () => {
    const { k, inbox, state } = await world();
    const s = afterRun(state, await openRun(state, await nextRun(k, inbox.pub, state, CHASE, 'c1')));
    // The Worker can't sign a run that no device would ever file: a time that doesn't move forward.
    await expect(
      nextRun(k, inbox.pub, s, CHASE, 'c2', undefined, { runTime: s.lastRunTime }),
    ).rejects.toThrow(RangeError);
    await expect(nextRun(k, inbox.pub, state, CHASE, 'c1', undefined, { runTime: 0 })).rejects.toThrow(
      RangeError,
    );
    // Ten minutes ahead of the device's clock is taken; a millisecond more waits, and may be the device's own clock.
    const edge = s.now + 10 * 60_000;
    await openRun(s, await nextRun(k, inbox.pub, s, CHASE, 'c2', undefined, { runTime: edge }));
    await refused(
      openRun(s, await nextRun(k, inbox.pub, s, CHASE, 'c2', undefined, { runTime: edge + 1 })),
      'dated in the future',
      true,
    );
  });

  it('someone who can write to the database can’t invent, change, cut or mix a run', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [link(), txns('one'), txns('two')]);
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
    // Pages dropped, added, swapped or changed.
    const [p0, p1, p2] = run.pages as [Bytes, Bytes, Bytes];
    await refused(openRun(state, { ...run, pages: [p0, p1] }), 'page count');
    await refused(openRun(state, { ...run, pages: [p0, p1, p2, p2] }), 'page count');
    await refused(openRun(state, { ...run, pages: [p0, p2, p1] }), 'page hash');
    const bad = p2.slice();
    bad[50]! ^= 1;
    await refused(openRun(state, { ...run, pages: [p0, p1, bad] }), 'page hash');
    // A manifest with a byte too many.
    await refused(
      openRun(state, { ...run, manifest: concat(run.manifest, u8(0)) }),
      'manifest: format: bytes left over',
    );
  });

  it('a page opens only in its own place: its budget, link, inbox version, run, attempt and page number', async () => {
    const { k, inbox, state } = await world();
    const base = await nextRun(k, inbox.pub, state, CHASE, 'c1', [link(), txns('one')]);
    const m = readRunManifest(base.manifest);
    // The Worker itself signs a manifest that names a page from somewhere else: the hash matches, the seal doesn't.
    const moved = async (from: SealedRun, page: number) => {
      const stray = from.pages[page]!;
      const pages = [base.pages[0]!, stray];
      const manifest = encodeRunManifest({ ...m, pages: [m.pages[0]!, { what: 0, hash: await sha(stray) }] });
      const signature = await sign(
        k.runSign.privateKey,
        concat(utf8('ledgerline/v1/run'), u8(0), await sha(manifest)),
      );
      return { manifest, signature, pages };
    };
    const others: [string, SealedRun, number][] = [
      [
        'another attempt',
        await nextRun(k, inbox.pub, state, CHASE, 'c1', [link(), txns('one')], { restart: 1 }),
        1,
      ],
      ['another link', await nextRun(k, inbox.pub, state, CITI, 'c1', [link(), txns('one')]), 1],
      [
        'another budget',
        await nextRun(k, inbox.pub, state, CHASE, 'c1', [link(), txns('one')], { budgetId: OTHER }),
        1,
      ],
      [
        'another run',
        await nextRun(
          k,
          inbox.pub,
          { ...state, filedThrough: 4, lastRunTime: T0, lastManifestHash: randomBytes(32) },
          CHASE,
          'c1',
          [link(), txns('one')],
        ),
        1,
      ],
      [
        'another page number',
        await nextRun(k, inbox.pub, state, CHASE, 'c1', [link(), txns('zero'), txns('one')]),
        2,
      ],
    ];
    for (const [name, from, page] of others)
      await expect(openRun(state, await moved(from, page)), name).rejects.toMatchObject({
        why: 'a page does not open',
      });
    // A page named as another kind than it was sealed as doesn't open either.
    const asBalances = encodeRunManifest({
      ...m,
      flags: 5,
      pages: [m.pages[0]!, { ...m.pages[1]!, what: 1 }],
    });
    const signature = await sign(
      k.runSign.privateKey,
      concat(utf8('ledgerline/v1/run'), u8(0), await sha(asBalances)),
    );
    await refused(
      openRun(state, { manifest: asBalances, signature, pages: base.pages }),
      'a page does not open',
    );
  });

  it('a run is sealed to the inbox key that is right for its number, across two key changes', async () => {
    const { k, inbox, inboxes, state } = await world();
    let s = state;
    for (let i = 0; i < 5; i++)
      s = afterRun(s, await openRun(s, await nextRun(k, inbox.pub, s, CHASE, `c${i}`)));
    // Key change 1: inbox key 2 is in force. Runs up to 6 existed when it was written, so run 6 may still use key 1.
    const inbox2 = await dhPairFromSeed(randomBytes(32));
    inboxes.set(2, inbox2);
    s = { ...s, inboxVersion: 2, retiredAt: new Map([[1, 6]]) };
    const old6 = await nextRun(
      k,
      inbox.pub,
      s,
      CHASE,
      'c6',
      undefined,
      { inboxVersion: 1 },
      { inboxVersion: 2, lastRunForOld: 6 },
    );
    // Key change 2, before run 6 is filed: inbox key 3 is in force; runs up to 8 existed; the log still carries key 1.
    const inbox3 = await dhPairFromSeed(randomBytes(32));
    inboxes.set(3, inbox3);
    const two = {
      ...s,
      inboxVersion: 3,
      retiredAt: new Map([
        [1, 6],
        [2, 8],
      ]),
    };
    const afterSix = afterRun(two, await openRun(two, old6));
    // Run 7 sealed to key 1: it didn't exist when key 1 was replaced. A database writer who put key 1 back, with its
    // valid stamp, gets nothing a device will file.
    const forged7 = await nextRun(
      k,
      inbox.pub,
      afterSix,
      CHASE,
      'c7',
      undefined,
      { inboxVersion: 1 },
      { inboxVersion: 3, lastRunForOld: 9 },
    );
    await refused(openRun(afterSix, forged7), 'sealed to a replaced inbox key');
    // The boundaries of key 2: run 8 may use it, run 9 may not.
    const s7 = afterRun(
      afterSix,
      await openRun(
        afterSix,
        await nextRun(
          k,
          inbox2.pub,
          afterSix,
          CHASE,
          'c7',
          undefined,
          { inboxVersion: 2 },
          { inboxVersion: 3, lastRunForOld: 8 },
        ),
      ),
    );
    const s8 = afterRun(
      s7,
      await openRun(
        s7,
        await nextRun(
          k,
          inbox2.pub,
          s7,
          CHASE,
          'c8',
          undefined,
          { inboxVersion: 2 },
          { inboxVersion: 3, lastRunForOld: 8 },
        ),
      ),
    );
    const nine = await nextRun(
      k,
      inbox2.pub,
      s8,
      CHASE,
      'c9',
      undefined,
      { inboxVersion: 2 },
      { inboxVersion: 3, lastRunForOld: 9 },
    );
    await refused(openRun(s8, nine), 'sealed to a replaced inbox key');
    const s9 = afterRun(s8, await openRun(s8, await nextRun(k, inbox3.pub, s8, CHASE, 'c9')));
    // Once a run used key 3, none goes back.
    const back = await nextRun(
      k,
      inbox2.pub,
      s9,
      CHASE,
      'c10',
      undefined,
      { inboxVersion: 2 },
      { inboxVersion: 3, lastRunForOld: 99 },
    );
    await refused(openRun(s9, back), 'sealed to an older inbox key than the run before');
    // A key that isn't the one the log names for that version.
    inboxes.set(3, inbox2);
    await refused(
      openRun(s9, await nextRun(k, inbox3.pub, s9, CHASE, 'c10')),
      'not the inbox key the log names',
    );
    inboxes.set(3, inbox3);
    // Not the server's lie but the device's state: it hasn't taken the key change yet, or doesn't hold the key.
    const ahead = await nextRun(k, inbox3.pub, { ...s9, inboxVersion: 4 }, CHASE, 'c10');
    await refused(openRun(s9, ahead), 'sealed to an inbox key this device has not reached', true);
    inboxes.delete(3);
    await refused(
      openRun(s9, await nextRun(k, inbox3.pub, s9, CHASE, 'c10')),
      'no inbox key for this run',
      true,
    );
  });

  it('the Worker throws a run back to be fetched again when a key change landed under it', async () => {
    const { k, inbox, state } = await world();
    // The run's pages were sealed to inbox key 1; by the time it completes, key 2 is in force and this run's number is
    // past the last one that may use key 1.
    const late = nextRun(
      k,
      inbox.pub,
      state,
      CHASE,
      'c1',
      undefined,
      {},
      { inboxVersion: 2, lastRunForOld: 0 },
    );
    await expect(late).rejects.toThrow(RestartRun);
    // A run that existed when the key was replaced is signed.
    await nextRun(k, inbox.pub, state, CHASE, 'c1', undefined, {}, { inboxVersion: 2, lastRunForOld: 1 });
    // A run can't be sealed to a key newer than the one in force.
    await expect(
      nextRun(
        k,
        inbox.pub,
        state,
        CHASE,
        'c1',
        undefined,
        { inboxVersion: 2 },
        { inboxVersion: 1, lastRunForOld: 0 },
      ),
    ).rejects.toThrow(RangeError);
  });

  it('a manifest that breaks the format is refused by writers and by readers', async () => {
    const { k, inbox, state } = await world();
    const run = await nextRun(k, inbox.pub, state, CHASE, 'c1', [link(), txns('one')]);
    const m = readRunManifest(run.manifest);
    expect(toHex(encodeRunManifest(m))).toBe(toHex(run.manifest));
    for (const change of [
      { run: 0 },
      { flags: 1 },
      { pages: [] },
      { pages: [{ what: 9 as 0, hash: m.pages[0]!.hash }] },
      { prevManifestHash: randomBytes(32) },
      { prevRunTime: 7 },
      { runTime: 0 },
      { budgetId: 'nope' },
      { n: 0 },
    ])
      expect(() => encodeRunManifest({ ...m, ...change }), JSON.stringify(Object.keys(change))).toThrow(
        RangeError,
      );
    // Readers, on bytes built by hand. Offsets: magic 4, two ids 30 each, run 8, restart 4, inbox version 4, hash 32,
    // run time 8, previous run time 8, two cursor hashes 64, flags 1, three counts 12, page count 2.
    const at = (offset: number, ...bytes: number[]) => {
      const x = run.manifest.slice();
      x.set(bytes, offset);
      return x;
    };
    const RUN = 64;
    const FLAGS = RUN + 8 + 4 + 4 + 32 + 8 + 8 + 64;
    const PAGES = FLAGS + 1 + 12;
    expect(() => readRunManifest(at(RUN, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(FormatError);
    expect(() => readRunManifest(at(RUN + 7, 2))).toThrow('previous manifest');
    expect(() => readRunManifest(at(FLAGS, 1))).toThrow('flags');
    expect(() => readRunManifest(at(PAGES, 0, 0))).toThrow('page count');
    expect(() => readRunManifest(at(PAGES, 0x10, 0x01))).toThrow('page count');
    expect(() => readRunManifest(at(PAGES + 2, 9))).toThrow('what');
    expect(() => readRunManifest(at(0, 0x4c, 0x4c, 0x52, 0x32))).toThrow(FormatError);
    expect(() => readRunManifest(run.manifest.subarray(1))).toThrow(FormatError);
    expect(() => readRunManifest(concat(run.manifest, u8(0)))).toThrow(FormatError);
    // A page is sealed only at a place that makes sense.
    await expect(
      sealPage(
        k,
        inbox.pub,
        { budgetId: BUDGET, linkId: CHASE, inboxVersion: 1, run: 0, restart: 0, page: 0 },
        0,
        utf8('x'),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      sealPage(
        k,
        inbox.pub,
        { budgetId: BUDGET, linkId: CHASE, inboxVersion: 1, run: 1, restart: 0, page: 4096 },
        0,
        utf8('x'),
      ),
    ).rejects.toThrow(RangeError);
  });
});
