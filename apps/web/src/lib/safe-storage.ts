// localStorage and sessionStorage for per-device conveniences: a browser that blocks them (private mode, site data
// off) throws, and then a read gives nothing and a write is skipped.
type Area = 'local' | 'session';
const area = (a: Area): Storage => (a === 'local' ? window.localStorage : window.sessionStorage);

export const safeStorage = {
  /** The stored text, or null (none, or storage blocked). */
  get(key: string, where: Area = 'local'): string | null {
    try {
      return area(where).getItem(key);
    } catch {
      return null;
    }
  },
  /** The stored JSON, or `fallback` (none, not JSON, or storage blocked). Not checked: the caller checks it. */
  getJson<T>(key: string, fallback: T, where: Area = 'local'): T {
    try {
      const text = area(where).getItem(key);
      return text === null ? fallback : (JSON.parse(text) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string, where: Area = 'local'): void {
    try {
      area(where).setItem(key, value);
    } catch {
      // Storage blocked or full: a convenience only.
    }
  },
  remove(key: string, where: Area = 'local'): void {
    try {
      area(where).removeItem(key);
    } catch {
      // Storage blocked: nothing to remove.
    }
  },
};
