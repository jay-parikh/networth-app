// Client for worker.js: promise-based calls into the Python engine.
// Calls are queued by the worker one at a time (Pyodide is single-threaded).

export class Engine {
  constructor(url = 'worker.js') {
    this.worker = new Worker(url);
    this.seq = 0;
    this.pending = new Map();
    this.logListeners = new Set();
    this.ready = false;
    this.worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.log !== undefined) {
        for (const fn of this.logListeners) fn(m.log);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'engine crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  raw(fn, args = [], transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, fn, args }, transfer);
    });
  }

  async start(today) {
    const r = await this.raw('__init', [{ today }]);
    this.ready = true;
    return r;
  }

  // call a webapp.api function; JSON string results are parsed
  async call(fn, ...args) {
    const r = await this.raw(fn, args);
    if (typeof r === 'string' && (r.startsWith('{') || r.startsWith('['))) {
      return JSON.parse(r);
    }
    return r;
  }

  // call returning the raw string (e.g. dump_json - stored as is)
  text(fn, ...args) { return this.raw(fn, args); }

  writeFile(path, bytes) {
    const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
    return this.raw('__write', [path, copy], [copy.buffer]);
  }

  readFile(path) { return this.raw('__read', [path]); }
  unlink(path) { return this.raw('__unlink', [path]); }
  setProxy(mode) { return this.raw('__proxy', [mode]); }

  onLog(fn) { this.logListeners.add(fn); return () => this.logListeners.delete(fn); }
}
