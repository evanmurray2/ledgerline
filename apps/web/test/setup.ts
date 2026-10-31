// jsdom lacks matchMedia; tests choose phone or desktop by setting window.__desktop.
declare global {
  interface Window {
    __desktop?: boolean;
    __prefersDark?: boolean;
  }
}

const listeners = new Set<() => void>();

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    get matches() {
      if (query.includes('min-width: 1024px')) return !!window.__desktop;
      if (query.includes('prefers-color-scheme: dark')) return !!window.__prefersDark;
      return false;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => false,
  }),
});

Element.prototype.scrollIntoView = function scrollIntoView() {};

export {};
