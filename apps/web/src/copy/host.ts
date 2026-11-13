// Talks to the phone's engine, which runs in a Web Worker (apps/worker/src/local/web-entry.ts; docs/phone-budget.md,
// D-45): opens the copy, feeds it sync pages from the server, and asks it for screens.
// The shapes below mirror apps/worker/src/local/engine.ts and routes/sync.ts (the web app's type check doesn't read
// the Worker's sources, which need Cloudflare's types).

export interface EngineIdentity {
  budgetId: string;
  userId: string;
  email: string;
  /**
   * The account can't link banks (the server said so). The copy answers the session's setup step with it; left
   * out, the copy answers as the budget's owner.
   */
  noBanks?: boolean;
}
export interface EngineState {
  through: number;
  epoch: string | null;
  format: number;
  cursor: string | null;
  serverTime: number | null;
  offset: number;
}
/** An edit kept on the device until the server takes it (engine.ts QueuedEdit, without its undo rows). */
export interface QueuedEdit {
  id: string;
  at: number;
  method: string;
  path: string;
  body: unknown;
  appVersion?: string;
  /** The server may hold it already: it went out once and the answer was lost, or it is being sent. */
  sending?: boolean;
}
export interface ApplyResult {
  reset: boolean;
  rows: number;
  caughtUp: boolean;
  /** Queued edits the engine took out, because they no longer pass on the server's newer rows (engine.ts apply). */
  lost?: number;
}
export interface SyncPage {
  format: number;
  epoch: string;
  serverTime: number;
  through: number;
  more: boolean;
  cursor: string | null;
  rows: { t: string; k: unknown[]; d: Record<string, unknown> | null }[];
  /** The place of the newest bank update the server has finished filing (routes/sync.ts). */
  inbox?: number;
  /** The newest daily scan the server noted (routes/sync.ts). */
  inboxScan?: number;
  /** The server is filing a bank update right now (routes/sync.ts). */
  filing?: boolean;
}
/** One bank update from the server's inbox (store/inbox.ts): the engine files it; the app only passes it on. */
export interface InboxRun {
  fetchSeq: number;
  [more: string]: unknown;
}
/** A daily scan the server ran (store/inbox.ts): the engine runs the same one. */
export interface InboxScan {
  n: number;
  [more: string]: unknown;
}
/** What the device does beside the server in a shadow run (local/shadow.ts ShadowEvent). */
export type ShadowEvent = { run: InboxRun } | { scan: InboxScan };
/** What a shadow run found (local/shadow.ts): names and counts, never a row's content. */
export interface ShadowReport {
  runs: number;
  compared: boolean;
  why?: string;
  differences: { table: string; column: string; rows: number }[];
}

/** A budget's derived keys of one version (`BudgetKeys` in @ledgerline/seal): passed on, never read. */
export type SealedKeys = { version: number } & Record<string, unknown>;
/** Where a public entry the app makes goes (local/device-log.ts `writePlace`). */
export interface WritePlace {
  number: number;
  hash: Uint8Array;
  deviceId: string;
  deviceCounter: number;
  filedThrough: number;
  scanThrough: number;
  /** For the entry: after the one before, by the server's clock as the engine measures it. */
  time: number;
  lastPublic: { number: number; hash: Uint8Array };
  keyVersion: number;
  whole: boolean;
}
/** The log's answer to a write (apps/worker/src/seal/log-store.ts AppendResult). */
export type AppendAnswer =
  { ok: true; number: number } | { ok: false; why: string; detail?: string; number?: number; retry: boolean };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class EngineHost {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, Pending>();
  /** Ready to Assign failed rule 10 on this phone: reported to the server as an alert. */
  onIdentity: ((r: { difference: number; month: string }) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('../../../worker/src/local/web-entry.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id?: number; ok?: boolean; value?: unknown; error?: string; event?: string };
      if (m.event === 'identity') {
        this.onIdentity?.(m as unknown as { difference: number; month: string });
        return;
      }
      const p = m.id ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error ?? 'Something went wrong. Try again.'));
    };
  }

  private call<T>(op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, ...args }, transfer);
    });
  }

  open(who: EngineIdentity, bytes: ArrayBuffer | null): Promise<EngineState> {
    return this.call('open', { who, bytes }, bytes ? [bytes] : []);
  }
  apply(page: SyncPage, receivedAt: number): Promise<ApplyResult> {
    return this.call('apply', { page, receivedAt });
  }
  nextRequest(): Promise<{ since: number; cursor: string | null }> {
    return this.call('next');
  }
  derive(): Promise<{ rta: number } | null> {
    return this.call('derive');
  }
  request(
    method: string,
    path: string,
    body?: unknown,
    /** A change made on this device: its own id and when the person made it (engine.ts request). */
    edit?: { id: string; at: number },
  ): Promise<{ status: number; body: string }> {
    return this.call('request', { method, path, body, edit });
  }
  /** Makes the scratch copy for a shadow run (engine.ts shadowFork); gives its token, or null when it can't. */
  shadowFork(): Promise<number | null> {
    return this.call('shadowFork');
  }
  /** The bank updates to file on the scratch copy: null when ready, or why a comparison would say nothing. */
  shadowBegin(token: number, runs: ShadowEvent[]): Promise<ShadowReport | null> {
    return this.call('shadowBegin', { token, runs });
  }
  /** Files the next update on the scratch copy; false when none is left. */
  shadowStep(token: number): Promise<boolean> {
    return this.call('shadowStep', { token });
  }
  /** Compares and frees the scratch copy. */
  shadowEnd(token: number): Promise<ShadowReport | null> {
    return this.call('shadowEnd', { token });
  }
  /** Runs an edit made with no connection and puts it in the queue, in one step (engine.ts enqueue). */
  enqueue(edit: QueuedEdit): Promise<{ status: number; body: string; queued: number }> {
    return this.call('enqueue', { edit });
  }
  /** The edits waiting for the server, oldest first. */
  queue(): Promise<QueuedEdit[]> {
    return this.call('queue');
  }
  /** The app is about to send this edit (engine.ts queueSending). */
  queueSending(editId: string): Promise<void> {
    return this.call('queueSending', { editId });
  }
  /** The server took this edit; gives how many are left. */
  queueDone(editId: string): Promise<number> {
    return this.call('queueDone', { editId });
  }
  /** The server refused this edit (engine.ts queueRefused). */
  queueRefused(editId: string): Promise<{ redownload: boolean; lost: number; left: number }> {
    return this.call('queueRefused', { editId });
  }
  export(): Promise<ArrayBuffer> {
    return this.call('export');
  }

  // ---- a sealed budget (apps/worker/src/local/web-entry.ts; docs/privacy.md 5.3). The keys are derived keys
  // that can't be read out; they go to the engine's own thread and are held there in memory only.

  /**
   * Gives the engine a sealed budget's keys. `ready` says the copy knows its place in the log; if not, it is a
   * new device or a copy made again, and `sealedJoin` opens a snapshot.
   */
  sealedOpen(
    keys: SealedKeys[],
    deviceId: string,
    workerKeys: [number, Uint8Array][],
  ): Promise<{ ready: boolean; number: number }> {
    return this.call('sealedOpen', { keys, deviceId, workerKeys });
  }
  /** Opens the budget's snapshot into the empty copy and takes the device's place in the log from it. */
  sealedJoin(): Promise<{ number: number }> {
    return this.call('sealedJoin');
  }
  /** Reads the log, files the bank runs that wait, and sends the changes made here. */
  sealedSync(): Promise<{ entries: number; filed: number; waiting: boolean; sent: number; lost: number }> {
    return this.call('sealedSync');
  }
  /** Writes a snapshot of the copy and reads it back. */
  sealedSnapshot(
    snapshotId: string,
  ): Promise<{ written: true; id: string; number: number } | { written: false; why: string }> {
    return this.call('sealedSnapshot', { snapshotId });
  }
  /** Checks the newest snapshot by rebuilding the budget in a second, empty copy. */
  /** Writes a snapshot, or checks the newest one, when either is due (local/web-entry.ts). */
  sealedUpkeep(snapshotId: string): Promise<{ did: 'check' | 'write' | 'nothing'; [k: string]: unknown }> {
    return this.call('sealedUpkeep', { snapshotId });
  }
  sealedCheck(): Promise<{ checked: boolean; why?: string; tables?: string[] }> {
    return this.call('sealedCheck');
  }
  /** Where a public entry the app makes goes: the log is read to its end first (copy/sealed-ways.ts). */
  sealedPlace(): Promise<WritePlace> {
    return this.call('sealedPlace');
  }
  /** Sends public entries the app made; `keys`, the derived keys of the version a key change brings. */
  sealedAppend(entries: Uint8Array[], keys?: SealedKeys[]): Promise<AppendAnswer> {
    return this.call('sealedAppend', { entries, ...(keys ? { keys } : {}) });
  }
  /**
   * Signs one request with the budget's signing key in force (docs/privacy-keys.md 11). The key never leaves
   * the engine: it gives the 64-byte signature over the request's name, the server's challenge and the body.
   */
  sealedSign(action: string, challenge: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
    return this.call('sealedSign', { action, challenge, payload });
  }
  /**
   * Moves a budget that exists to its sealed log (docs/privacy.md section 8 step 6): the keys and the first
   * entry were made by keys/budget.ts. `sealed` with `ok: false` means the budget is sealed and its first
   * snapshot did not read back: take the way back.
   */
  cutover(
    keys: SealedKeys,
    genesis: Uint8Array,
    deviceId: string,
    snapshotId: string,
  ): Promise<{ ok: true; number: number } | { ok: false; why: string; tables?: string[]; sealed?: boolean }> {
    return this.call('cutover', { keys, genesis, deviceId, snapshotId });
  }
  state(): Promise<EngineState> {
    return this.call('state');
  }
  rta(): Promise<{ rta: number; updating: boolean }> {
    return this.call('rta');
  }
  clear(): Promise<void> {
    return this.call('clear');
  }
  get(key: string): Promise<string | null> {
    return this.call('get', { key });
  }
  put(key: string, value: string | null): Promise<void> {
    return this.call('put', { key, value });
  }
  async close(): Promise<void> {
    await this.call('close').catch(() => undefined);
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Something went wrong. Try again.'));
    this.pending.clear();
  }
}

/** Sync pages are read until the copy holds everything; a new epoch starts the download again (section 8). */
export async function syncAll(
  host: EngineHost,
  fetchPage: (since: number, cursor: string | null) => Promise<SyncPage>,
  /** Called when the server's copy changed (a new epoch or format) and the whole budget downloads again. */
  onReset?: () => void,
  /** Called with each page before the copy takes it. */
  beforeApply?: (page: SyncPage) => Promise<void>,
): Promise<{ pages: number; rows: number; lost: number }> {
  let pages = 0;
  let rows = 0;
  let lost = 0;
  for (let guard = 0; guard < 2000; guard++) {
    const { since, cursor } = await host.nextRequest();
    const page = await fetchPage(since, cursor);
    await beforeApply?.(page);
    const r = await host.apply(page, Date.now());
    pages++;
    if (r.reset) onReset?.();
    rows += r.rows;
    lost += r.lost ?? 0;
    if (r.caughtUp) return { pages, rows, lost };
  }
  throw new Error('Your budget didn’t finish downloading. Try again.');
}
