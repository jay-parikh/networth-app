// Local stand-in for Netlify: serves dist/public, runs the REAL relay function
// (dist/netlify/functions/fetch.mjs) at /.netlify/functions/fetch, and
// emulates the _redirects /px/ proxy rules.
//
//   node tests/devserver.mjs [port] [--no-fn]     (--no-fn = a Drop-style deploy)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const pub = path.join(dist, 'public');
const port = Number(process.argv[2]) || 8099;
const withFn = !process.argv.includes('--no-fn');
const fn = withFn ? (await import(pathToFileURL(path.join(dist, 'netlify/functions/fetch.mjs')).href)).default : null;

const rules = fs.readFileSync(path.join(pub, '_redirects'), 'utf8').split('\n')
  .filter(l => l.startsWith('/px/')).map(l => l.trim().split(/\s+/))
  .map(([from, to]) => ({ prefix: from.replace('*', ''), target: to.replace(':splat', '') }));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.zip': 'application/zip', '.whl': 'application/zip' };

const log = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  log.push(url.pathname + url.search);
  try {
    if (url.pathname === '/.netlify/functions/fetch') {
      if (!fn) { res.writeHead(404); res.end('no functions on this deploy'); return; }
      const r = await fn(new Request(url.href));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const rule = rules.find(r => url.pathname.startsWith(r.prefix));
    if (rule) {
      const target = rule.target + url.pathname.slice(rule.prefix.length) + url.search;
      const up = await fetch(target, { headers: { 'user-agent': req.headers['user-agent'] || 'Mozilla/5.0' } });
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/octet-stream' });
      res.end(Buffer.from(await up.arrayBuffer()));
      return;
    }
    let p = path.join(pub, decodeURIComponent(url.pathname));
    if (!p.startsWith(pub)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    res.writeHead(502); res.end(String(e));
  }
});
server.listen(port, () => console.log(`devserver http://localhost:${port} (function ${withFn ? 'on' : 'off'})`));
process.on('SIGUSR2', () => { console.log(log.join('\n')); });
