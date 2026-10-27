// Runs the app's Python side (the same bundle the browser loads) under Node,
// for tests. Network: nwHttp() is implemented with curl here; in the browser
// the worker implements it with a synchronous XHR to the site's proxy.
//
//   const host = await require('./pyhost').boot({pyodideDir, bundle, online})
//   host.call('get_view')  -> parsed JSON
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function curlGet(url, headersJson, timeoutMs, viaProxy) {
  const tmp = path.join(os.tmpdir(), `nwhttp-${process.pid}-${Date.now()}`);
  const target = viaProxy ? viaProxy(url) : url;
  const args = ['-sS', '-L', '--compressed', '-m', String(Math.ceil(timeoutMs / 1000)),
    '-o', tmp, '-w', '%{http_code} %{url_effective}'];
  if (!viaProxy) {
    const h = JSON.parse(headersJson || '{}');
    if (!Object.keys(h).some(k => k.toLowerCase() === 'user-agent')) args.push('-A', UA);
    for (const [k, v] of Object.entries(h)) args.push('-H', `${k}: ${v}`);
  }
  args.push(target);
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const [code, eff] = out.trim().split(' ');
    const body = fs.existsSync(tmp) ? fs.readFileSync(tmp) : Buffer.alloc(0);
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    return { status: Number(code), body: new Uint8Array(body), url: eff || url, error: '' };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return { status: 0, body: null, url, error: String(e.stderr || e.message || e) };
  }
}

async function boot(opts) {
  const { loadPyodide } = require(path.join(opts.pyodideDir, 'pyodide.js'));
  const t0 = Date.now();
  const py = await loadPyodide({ indexURL: opts.pyodideDir + '/' });
  const tBoot = Date.now() - t0;
  const tPk = Date.now() - t0;
  py.unpackArchive(new Uint8Array(fs.readFileSync(opts.bundle)), 'zip', { extractDir: '/home/pyodide/nw' });
  globalThis.nwHttp = (url, headersJson, timeoutMs) => {
    if (opts.log) opts.log(`GET ${url}`);
    return curlGet(url, headersJson, timeoutMs, opts.viaProxy);
  };
  py.runPython(`
import sys
sys.path[:0] = ["/home/pyodide/nw/src", "/home/pyodide/nw/lib"]
import warnings; warnings.filterwarnings("ignore")
from webapp import api
`);
  const tImp = Date.now() - t0;
  const api = py.globals.get('api');
  // like worker.js ensureCrypto(): packages after import, then reload hashlib
  await py.loadPackage(['hashlib', 'cryptography'], { messageCallback: () => {} });
  py.runPython('import importlib, hashlib; importlib.reload(hashlib); assert hasattr(hashlib, "pbkdf2_hmac")');
  const call = (name, ...args) => {
    const fn = api[name];
    const res = fn(...args);
    if (typeof res === 'string') {
      try { return JSON.parse(res); } catch (e) { return res; }
    }
    return res;
  };
  return { py, api, call, timings: { boot: tBoot, packages: tPk, import: tImp } };
}

module.exports = { boot, curlGet };
