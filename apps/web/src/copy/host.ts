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
}
/** A budget's derived keys of one version (`BudgetKeys` in @ledgerline/seal): passed on, never read. */
export type SealedKeys = { version: number } & Record<string, unknown>;
/** Another device that showed different numbers at the same log entry (local/device-check.ts). */
export interface DevicesDiffer {
  deviceId: string;
  number: number;
  month: string;
}
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

/** Shown when the engine's thread can't run in this browser. */
export const ENGINE_FAILED = 'Your budget couldn’t start in this browser. Reload the page to try again.';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class EngineHost {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, Pending>();
  /** Set once the engine's thread fails to start or stops: every call then fails at once instead of waiting. */
  private broken: Error | null = null;
  /** Ready to Assign failed rule 10 on this phone: reported to the server as an alert. */
  onIdentity: ((r: { difference: number; month: string }) => void) | null = null;
  /** The engine is making the copy again from a snapshot (local/rebuild.ts); `sealedSync` answers when it is done. */
  onRebuilding: (() => void) | null = null;
  /** The copy was made again outside `sealedSync` (a public entry's place or write found it below the floor). */
  onRebuilt: (() => void) | null = null;

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
      if (m.event === 'rebuilding') {
        this.onRebuilding?.();
        return;
      }
      if (m.event === 'rebuilt') {
        this.onRebuilt?.();
        return;
      }
      const p = m.id ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error ?? 'Something went wrong. Try again.'));
    };
    // A thread that can't load (a blocked or broken script, sql.js's WebAssembly refused) or a message it can't
    // read never answers: without these, the app waits on "One moment…" forever.
    this.worker.onerror = (e: ErrorEvent | Event) => {
      e.preventDefault();
      const detail = 'message' in e && e.message ? e.message : 'the engine did not start';
      this.fail(detail);
    };
    this.worker.onmessageerror = () => this.fail('a message could not be read');
  }

  private fail(detail: string): void {
    console.warn(JSON.stringify({ event: 'engine_failed', detail }));
    this.broken = new Error(ENGINE_FAILED);
    for (const p of this.pending.values()) p.reject(this.broken);
    this.pending.clear();
  }

  private call<T>(op: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    if (this.broken) return Promise.reject(this.broken);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, ...args }, transfer);
    });
  }

  open(who: EngineIdentity, bytes: ArrayBuffer | null): Promise<EngineState> {
    return this.call('open', { who, bytes }, bytes ? [bytes] : []);
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
  /** Runs an edit made on this device and puts it in the queue, in one step (engine.ts enqueue). */
  enqueue(edit: QueuedEdit): Promise<{ status: number; body: string; queued: number }> {
    return this.call('enqueue', { edit });
  }
  /** The edits waiting to go out as entries of the log, oldest first. */
  queue(): Promise<QueuedEdit[]> {
    return this.call('queue');
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
  /**
   * Reads the log, files the bank runs and the daily scans that wait (in time order), and sends the changes made
   * here. `rebuilt`: the copy was made again from a snapshot first; `kept` waiting changes went with it.
   * `differs`: another device showed different numbers at the same entry (the device check, D-116); `own`, the
   * other ids this device wrote the log as, are not another device.
   */
  sealedSync(own: string[] = []): Promise<{
    entries: number;
    filed: number;
    waiting: boolean;
    sent: number;
    lost: number;
    rebuilt?: { kept: number; lost: number };
    differs?: DevicesDiffer | null;
  }> {
    return this.call('sealedSync', { own });
  }
  /** Makes the copy again from the budget's newest trusted snapshot, when the person asks (D-116). */
  sealedRebuild(): Promise<{ kept: number; lost: number }> {
    return this.call('sealedRebuild');
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
   * Starts a new budget locked (D-102): the keys and the first entry were made by keys/new-budget.ts. The copy is
   * made empty, holds the budget's own row, and stands at the first entry.
   */
  startBudget(
    keys: SealedKeys,
    genesis: Uint8Array,
    deviceId: string,
    snapshotId: string,
  ): Promise<{ ok: true; number: number } | { ok: false; why: string }> {
    return this.call('start', { keys, genesis, deviceId, snapshotId });
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
