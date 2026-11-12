// Talks to the phone's engine, which runs in a Web Worker (apps/worker/src/local/web-entry.ts; docs/phone-budget.md,
// D-45): opens the copy, feeds it sync pages from the server, and asks it for screens.
// The shapes below mirror apps/worker/src/local/engine.ts and routes/sync.ts (the web app's type check doesn't read
// the Worker's sources, which need Cloudflare's types).

export interface EngineIdentity {
  budgetId: string;
  userId: string;
  email: string;
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
  /** The server is filing a bank update right now (routes/sync.ts). */
  filing?: boolean;
}
/** One bank update from the server's inbox (store/inbox.ts): the engine files it; the app only passes it on. */
export interface InboxRun {
  fetchSeq: number;
  [more: string]: unknown;
}
/** What a shadow run found (local/shadow.ts): names and counts, never a row's content. */
export interface ShadowReport {
  runs: number;
  compared: boolean;
  why?: string;
  differences: { table: string; column: string; rows: number }[];
}

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
  shadowBegin(token: number, runs: InboxRun[]): Promise<ShadowReport | null> {
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
