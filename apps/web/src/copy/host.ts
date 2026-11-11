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
/** A changed row, as the engine records it (routes/sync.ts SyncRow). */
export interface RowChange {
  t: string;
  k: unknown[];
  d: Record<string, unknown> | null;
}
/** An edit kept on the device until the server takes it (engine.ts QueuedEdit). */
export interface QueuedEdit {
  id: string;
  at: number;
  method: string;
  path: string;
  body: unknown;
  /** What takes the edit back out of the copy. */
  undo: RowChange[];
  /** The change number the copy held when the edit ran. */
  through: number;
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
  /** Runs an edit and gives what takes it back out of the copy (engine.ts record). */
  record(
    method: string,
    path: string,
    body: unknown,
    edit: { id: string; at: number },
  ): Promise<{ status: number; body: string; undo: RowChange[] }> {
    return this.call('record', { method, path, body, edit });
  }
  /** Takes a refused edit and the ones after it out of the copy, and runs the later ones again (engine.ts). */
  dropEdit(refused: QueuedEdit, later: QueuedEdit[]): Promise<{ kept: QueuedEdit[]; lost: QueuedEdit[] }> {
    return this.call('dropEdit', { refused, later });
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
): Promise<{ pages: number; rows: number; lost: number }> {
  let pages = 0;
  let rows = 0;
  let lost = 0;
  for (let guard = 0; guard < 2000; guard++) {
    const { since, cursor } = await host.nextRequest();
    const page = await fetchPage(since, cursor);
    const r = await host.apply(page, Date.now());
    pages++;
    if (r.reset) onReset?.();
    rows += r.rows;
    lost += r.lost ?? 0;
    if (r.caughtUp) return { pages, rows, lost };
  }
  throw new Error('Your budget didn’t finish downloading. Try again.');
}
