// CPU profiler for local `wrangler dev` (workerd). Wraps one HTTP request in a V8 CPU profile taken through the
// inspector and returns the sampled CPU time, excluding idle samples (time spent waiting on D1 or fetch).
// workerd freezes Date.now() and performance.now() during execution, so in-Worker timers cannot measure CPU.
import WebSocket from 'ws';

export class CpuProfiler {
  constructor(inspectorUrl = 'ws://127.0.0.1:9229/ws') {
    this.url = inspectorUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    // wrangler's inspector proxy only accepts its DevTools origin.
    this.ws = new WebSocket(this.url, { headers: { Origin: 'https://devtools.devprod.cloudflare.dev' } });
    await new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      // The proxy echoes each request back with its id before the real reply.
      if (msg.id && this.pending.has(msg.id) && ('result' in msg || 'error' in msg)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
    // The proxy answers enable/start with an echo that has no result, so those are fire-and-wait.
    this.fire('Profiler.enable');
    this.fire('Profiler.setSamplingInterval', { interval: 25 });
    await new Promise((r) => setTimeout(r, 100));
  }

  fire(method, params = {}) {
    this.ws.send(JSON.stringify({ id: ++this.id, method, params }));
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }

  /** Runs fn() under the profiler. Returns { result, cpuMs, wallMs, top }. */
  async profile(fn) {
    this.fire('Profiler.start');
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const result = await fn();
    const wallMs = performance.now() - t0;
    const { profile } = await this.send('Profiler.stop');
    return { result, wallMs, ...summarize(profile) };
  }

  close() {
    this.ws?.close();
  }
}

// Frames that only exist in local emulation: workerd's native fetch into the in-process D1/R2 simulators and
// wrangler's local tracing. In production those are I/O waits on remote services, not this isolate's CPU.
const LOCAL_ONLY = new Set(['fetch', 'enterSpan', 'set tracing', 'setAttributes', 'get tracing', 'exitSpan']);

export function summarize(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let cpuUs = 0;
  let appUs = 0;
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const dt = profile.timeDeltas[i + 1] ?? 0; // a sample's delta precedes the next sample
    const name = node?.callFrame.functionName || '(anonymous)';
    if (name === '(idle)') continue;
    cpuUs += dt;
    if (!LOCAL_ONLY.has(name)) appUs += dt;
    const key = `${name} ${node?.callFrame.url?.split('/').pop() ?? ''}:${node?.callFrame.lineNumber ?? ''}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([k, v]) => `${(v / 1000).toFixed(2)}ms ${k}`);
  return { cpuMs: cpuUs / 1000, appMs: appUs / 1000, top };
}
