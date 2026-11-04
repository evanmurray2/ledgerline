// The mock API's November copy (apps/worker/src/local/november-copy.ts and november-browser.ts, aliased in
// vite.config.ts). The shapes mirror the engine and sql.js database there, as copy/host.ts does for the Web Worker:
// the web app's type check doesn't read the Worker's code.

interface MockStmt {
  bind(...args: unknown[]): MockStmt;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface MockCopy {
  engine: {
    request(method: string, path: string, body?: unknown): Promise<Response>;
    derive(): Promise<unknown>;
  };
  db: { prepare(sql: string): MockStmt };
}

declare module '#november-browser' {
  export function openNovemberCopy(now: () => number): Promise<MockCopy>;
}

declare module '#november-node' {
  export function novemberCopy(now: () => number): Promise<MockCopy>;
}
