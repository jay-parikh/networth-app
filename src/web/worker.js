/* NetWorth engine worker: runs the NetWorth Python reference implementation
   (Pyodide) off the main thread.

   Protocol (postMessage):
     in : {id, fn, args}            call webapp.api.<fn>(...args)
          {id, fn:'__init', args:[{today}]}
          {id, fn:'__proxy', args:[mode]}      'fn' | 'px' | 'direct'
          {id, fn:'__write', args:[path, Uint8Array]}
          {id, fn:'__read',  args:[path]}
     out: {id, ok:true, result} | {id, ok:false, error}
          {log: text}  - console lines from the updater ("Fetching ...")
*/
'use strict';

let py = null;
let api = null;
let proxyMode = 'fn';
let cryptoLoaded = false;
const BASE = self.location.href.replace(/\/[^/]*$/, '');

function log(text) {
  self.postMessage({ log: String(text) });
}

/* Called by the Python requests shim for every GET (see lib/requests).
   Synchronous on purpose: Python's fetchers are synchronous, and a worker
   may block on XHR without freezing the page. */
self.nwHttp = function (url, headersJson, timeoutMs) {
  let target;
  if (proxyMode === 'fn') {
    target = `${BASE}/.netlify/functions/fetch?url=${encodeURIComponent(url)}` +
      `&h=${encodeURIComponent(headersJson || '{}')}`;
  } else if (proxyMode === 'px') {
    const u = new URL(url);
    target = `${BASE}/px/${u.hostname}${u.pathname}${u.search}`;
  } else {
    target = url;
  }
  const xhr = new XMLHttpRequest();
  try {
    xhr.open('GET', target, false);
    xhr.responseType = 'arraybuffer';
    if (timeoutMs) xhr.timeout = timeoutMs;
    xhr.send();
  } catch (e) {
    return { status: 0, body: null, url, error: String((e && e.message) || e || 'network error') };
  }
  let status = xhr.status;
  let finalUrl = url;
  if (proxyMode === 'fn') {
    const up = xhr.getResponseHeader('x-nw-status');
    if (up) {
      status = Number(up);
      finalUrl = xhr.getResponseHeader('x-nw-url') || url;
    } else if (status !== 200) {
      return { status: 0, body: null, url, error: `relay answered ${status}` };
    }
  }
  if (status === 0) return { status: 0, body: null, url, error: 'network error' };
  return { status, body: new Uint8Array(xhr.response || new ArrayBuffer(0)), url: finalUrl, error: '' };
};

async function ensureCrypto() {
  if (cryptoLoaded) return;
  log('Loading encryption support…');
  await py.loadPackage(['hashlib', 'cryptography'], { messageCallback: () => {} });
  // hashlib was imported at start-up WITHOUT OpenSSL (no pbkdf2_hmac);
  // reload it in place so every module that imported it sees the full one
  py.runPython(`
import importlib, hashlib
importlib.reload(hashlib)
assert hasattr(hashlib, "pbkdf2_hmac"), "hashlib without OpenSSL"
`);
  cryptoLoaded = true;
}

// API calls that may need hashlib.pbkdf2 / cryptography (privacy, locked
// files, AES-protected statement PDFs).
const NEEDS_CRYPTO = new Set(['import_xlsx', 'export_xlsx', 'parse_imports',
  'privacy_set_password', 'privacy_verify', 'run_update', 'commit_imports']);

async function init(opts) {
  importScripts('pyodide/pyodide.js');
  log('Starting the engine…');
  py = await loadPyodide({ indexURL: `${BASE}/pyodide/` });
  py.setStdout({ batched: (s) => log(s) });
  py.setStderr({ batched: (s) => log(s) });
  const res = await fetch(`${BASE}/py/nw-bundle.zip`);
  if (!res.ok) throw new Error(`could not load the engine files (${res.status})`);
  py.unpackArchive(new Uint8Array(await res.arrayBuffer()), 'zip', { extractDir: '/home/pyodide/nw' });
  py.runPython(`
import sys
sys.path[:0] = ["/home/pyodide/nw/src", "/home/pyodide/nw/lib"]
import warnings; warnings.filterwarnings("ignore")
from webapp import api
`);
  api = py.globals.get('api');
  if (opts && opts.today) api.set_today(opts.today);
  return { python: py.runPython('import sys; sys.version.split()[0]') };
}

self.onmessage = async (ev) => {
  const { id, fn, args } = ev.data || {};
  try {
    let result;
    if (fn === '__init') {
      result = await init(args && args[0]);
    } else if (fn === '__proxy') {
      proxyMode = args[0];
      result = proxyMode;
    } else if (fn === '__write') {
      const [path, bytes] = args;
      const dir = path.replace(/\/[^/]*$/, '');
      if (dir) py.FS.mkdirTree(dir);
      py.FS.writeFile(path, bytes);
      result = true;
    } else if (fn === '__read') {
      const bytes = py.FS.readFile(args[0]);
      self.postMessage({ id, ok: true, result: bytes }, [bytes.buffer]);
      return;
    } else if (fn === '__unlink') {
      try { py.FS.unlink(args[0]); } catch (e) { /* already gone */ }
      result = true;
    } else {
      if (!api) throw new Error('engine not started');
      if (NEEDS_CRYPTO.has(fn)) await ensureCrypto();
      const f = api[fn];
      if (!f) throw new Error(`unknown call ${fn}`);
      result = f(...(args || []));
      if (result && typeof result.toJs === 'function') {
        const r = result.toJs();
        result.destroy();
        result = r;
      }
    }
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    let msg = String((e && e.message) || e);
    // a Python traceback: keep its last line (the actual error) up front
    const lines = msg.trim().split('\n');
    if (lines.length > 3) msg = lines[lines.length - 1] + '\n\n' + msg;
    self.postMessage({ id, ok: false, error: msg });
  }
};
