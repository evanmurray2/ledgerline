// First-party usage log (design: "Usage tracking"). Events stay in memory and are written to this device's browser
// storage every 30 s and when the page is hidden; nothing is sent (a locked budget's server keeps none, D-102 and
// docs/privacy.md 5.8, D-120). Settings → Backup and export saves them as a file the owner can hand to a review. Only fixed
// ids are recorded: screens, control ids from data-track attributes, task names, error codes and at most one number
// (a duration, a count or a length). Never amounts, payee names, memos, typed names, search text or account numbers.

export interface UsageEvent {
  at: number;
  /** Which app session (one page load) it came from, and that release: to tell visits and versions apart. */
  session?: string;
  version?: string;
  screen: string;
  event: string;
  target: string | null;
  value: number | null;
}

const ID_RE = /^[a-z0-9_.-]+$/;
const MAX_BUFFER = 2000;
export const FLUSH_MS = 30_000;
/** What the device keeps: the newest events of the last 90 days, at most this many. */
export const KEEP_DAYS = 90;
export const KEEP_MAX = 10_000; // about 1 MB of the origin's 5 MB
export const STORE_KEY = 'ledgerline.usage.v1';

/** Ids are fixed strings from code. Anything that doesn't look like one is dropped, never sent. */
export function cleanId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 60);
  return ID_RE.test(s) ? s : null;
}

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  } catch {
    // randomUUID needs a secure context; getRandomValues doesn't.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

/** Where the device keeps its events. Reads and writes may throw (private mode, full storage): the tracker drops. */
export interface UsageStore {
  load(): UsageEvent[];
  save(events: UsageEvent[]): void;
  clear(): void;
}

export interface TrackerDeps {
  store: UsageStore;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}

/**
 * What a rage tap hit, by structure only (never text, names or amounts), so it can be found later:
 * "sheet." when inside a sheet, "disabled." when a disabled control is under the finger, then the tag names
 * of the element and two parents, e.g. "sheet.span.div.label".
 */
export function describeTapped(el: Element, x: number, y: number): string {
  const parts: string[] = [];
  if (el.closest('[role="dialog"]')) parts.push('sheet');
  const under = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
  if (under.some((u) => u.matches(':disabled'))) parts.push('disabled');
  let n: Element | null = el;
  for (let i = 0; i < 3 && n; i++, n = n.parentElement) parts.push(n.tagName.toLowerCase());
  return parts
    .join('.')
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 60);
}

const CONTROL_SELECTOR =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="radio"],[data-track]';

export class UsageTracker {
  private buffer: UsageEvent[] = [];
  private recent: string[] = [];
  private enabled = false;
  private timer: unknown = null;
  private screen = 'app';
  private tasks = new Map<string, number>();
  private taps: { t: number; x: number; y: number }[] = [];
  private rageReported = 0;
  readonly sessionId = randomId();
  appVersion = '0.0.0';

  constructor(private deps: TrackerDeps) {}

  /** Starts or stops collection. Turning it off drops anything not yet written; what's kept stays (KEEP_DAYS). */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.timer = this.deps.setInterval(() => void this.flush(), FLUSH_MS);
      // The first screen usually shows before the session turns recording on: record the view it missed.
      if (this.screen !== 'app') this.record('view');
    } else {
      if (this.timer !== null) this.deps.clearInterval(this.timer);
      this.timer = null;
      this.buffer = [];
      this.tasks.clear();
    }
  }

  isEnabled() {
    return this.enabled;
  }

  get pending(): readonly UsageEvent[] {
    return this.buffer;
  }

  /** The last few event names, for a feedback note. Kept even when tracking is off. */
  recentEvents(n = 20): string[] {
    return this.recent.slice(-n);
  }

  currentScreen() {
    return this.screen;
  }

  record(event: string, target: string | null = null, value: number | null = null) {
    const ev = cleanId(event);
    if (!ev) return;
    const tg = target === null ? null : cleanId(target);
    const name = tg ? `${ev}:${tg}` : ev;
    this.recent.push(`${this.screen} ${name}`.slice(0, 80));
    if (this.recent.length > 40) this.recent.splice(0, this.recent.length - 40);
    if (!this.enabled) return;
    if (this.buffer.length >= MAX_BUFFER) return;
    this.buffer.push({
      at: this.deps.now(),
      session: this.sessionId.slice(0, 8),
      version: this.appVersion.slice(0, 20),
      screen: this.screen,
      event: ev,
      target: tg,
      value: value === null || !Number.isFinite(value) ? null : Math.round(value),
    });
  }

  view(screen: string) {
    const s = cleanId(screen);
    if (!s || s === this.screen) return;
    this.screen = s;
    this.record('view');
  }

  tap(target: string) {
    this.record('tap', target);
  }

  startTask(name: string) {
    this.tasks.set(name, this.deps.now());
  }

  /** Records the task with its duration in ms, if it was started. */
  endTask(name: string) {
    const start = this.tasks.get(name);
    if (start === undefined) return;
    this.tasks.delete(name);
    this.record('task', name, this.deps.now() - start);
  }

  cancelTask(name: string) {
    this.tasks.delete(name);
  }

  undo(what: string) {
    this.record('undo', `undo.${what}`);
  }

  backOut(sheet: string) {
    this.record('back_out', sheet);
  }

  /** Only the count and the query's length: never the text. */
  searchNoResults(queryLength: number) {
    this.record('search_empty', null, queryLength);
  }

  error(code: string) {
    this.record('error', code);
  }

  suggestion(kind: string, outcome: string) {
    this.record('suggestion', `${kind}.${outcome}`);
  }

  /** Document-level click handler: named controls, and 3+ taps within 1 s on something that isn't one. */
  onClick = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const tracked = el.closest('[data-track]');
    if (tracked) {
      const id = tracked.getAttribute('data-track');
      if (id) this.tap(id);
      return;
    }
    if (el.closest(CONTROL_SELECTOR)) return;
    const now = this.deps.now();
    this.taps = this.taps.filter((t) => now - t.t <= 1000);
    this.taps.push({ t: now, x: e.clientX, y: e.clientY });
    const near = this.taps.filter((t) => Math.abs(t.x - e.clientX) < 40 && Math.abs(t.y - e.clientY) < 40);
    if (near.length >= 3 && now - this.rageReported > 1000) {
      this.rageReported = now;
      this.record('rage_tap', describeTapped(el, e.clientX, e.clientY), near.length);
    }
  };

  /** Moves the buffer into the device's store, dropping what's older than KEEP_DAYS or past KEEP_MAX. */
  async flush(): Promise<void> {
    if (!this.enabled || this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    try {
      this.deps.store.save(keep([...this.deps.store.load(), ...events], this.deps.now()));
    } catch {
      // Usage is lowest priority: a failed write is dropped, never retried.
    }
  }

  /** Everything kept on this device, oldest first, after a flush of what's in memory. */
  async kept(): Promise<UsageEvent[]> {
    await this.flush();
    try {
      return keep(this.deps.store.load(), this.deps.now());
    } catch {
      return [];
    }
  }

  /** Deletes what this device kept (and what's in memory). */
  forget() {
    this.buffer = [];
    try {
      this.deps.store.clear();
    } catch {
      // Nothing more to do.
    }
  }

  /** The file Settings → Backup and export saves: fixed ids and numbers only, as recorded. */
  async file(): Promise<string> {
    const events = await this.kept();
    return JSON.stringify({
      kind: 'ledgerline-usage',
      version: 1,
      savedAt: new Date(this.deps.now()).toISOString(),
      events,
    });
  }
}

function keep(events: UsageEvent[], now: number): UsageEvent[] {
  const since = now - KEEP_DAYS * 86_400_000;
  const fresh = events.filter((e) => typeof e?.at === 'number' && e.at >= since);
  return fresh.length > KEEP_MAX ? fresh.slice(fresh.length - KEEP_MAX) : fresh;
}

/** The browser's localStorage, as one JSON list. */
export const browserStore: UsageStore = {
  load() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as UsageEvent[]) : [];
  },
  save(events) {
    localStorage.setItem(STORE_KEY, JSON.stringify(events));
  },
  clear() {
    localStorage.removeItem(STORE_KEY);
  },
};

export const usage = new UsageTracker({
  store: browserStore,
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
});

let installed = false;
export function installUsageListeners() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', usage.onClick, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void usage.flush();
  });
  window.addEventListener('pagehide', () => void usage.flush());
}
