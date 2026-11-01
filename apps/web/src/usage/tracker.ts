// First-party usage log (design: "Usage tracking"). Events stay in memory and go to our own Worker in one
// batch every 30 s and when the page is hidden. Only fixed ids are recorded: screens, control ids from
// data-track attributes, task names, error codes and at most one number (a duration, a count or a length).
// Never amounts, payee names, memos, typed names, search text or account numbers.
import { CSRF_HEADER } from '@ledgerline/contracts';

export interface UsageEvent {
  at: number;
  screen: string;
  event: string;
  target: string | null;
  value: number | null;
}

const ID_RE = /^[a-z0-9_.-]+$/;
const MAX_BATCH = 200;
const MAX_BUFFER = 2000;
export const FLUSH_MS = 30_000;

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
    return Math.random().toString(36).slice(2, 18);
  }
}

export interface TrackerDeps {
  fetch: typeof fetch;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
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

  /** Starts or stops collection. Turning it off drops anything not yet sent. */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.timer = this.deps.setInterval(() => void this.flush(), FLUSH_MS);
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
      this.record('rage_tap', null, near.length);
    }
  };

  async flush(): Promise<void> {
    if (!this.enabled || this.buffer.length === 0) return;
    const events = this.buffer.splice(0, this.buffer.length);
    for (let i = 0; i < events.length; i += MAX_BATCH) {
      const chunk = events.slice(i, i + MAX_BATCH);
      try {
        await this.deps.fetch('/api/usage', {
          method: 'POST',
          keepalive: true,
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
          body: JSON.stringify({
            sessionId: this.sessionId,
            appVersion: this.appVersion.slice(0, 20),
            events: chunk,
          }),
        });
      } catch {
        // Usage is lowest priority: a failed batch is dropped, never retried or queued.
      }
    }
  }
}

export const usage = new UsageTracker({
  fetch: (...args) => fetch(...args),
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
