// Market-data relay for the NetWorth web app.
//
// Browsers cannot download AMFI / BSE / NSE / NPS / IBJA files directly (those
// sites send no CORS headers), so the app asks this function to fetch them.
// It is a plain GET relay for an allow-list of PUBLIC data hosts - no user
// data is ever sent here; the app only asks for public price files.
//
//   GET /.netlify/functions/fetch?ping=1
//   GET /.netlify/functions/fetch?url=<encoded https URL>&h=<encoded JSON headers>
//
// The upstream status travels in the x-nw-status header (the function itself
// answers 200), so "the function is missing" (404 from Netlify) can never be
// confused with "the exchange has no file for that day" (upstream 404).

const ALLOWED = new Set([
  'www.amfiindia.com', 'portal.amfiindia.com',
  'www.bseindia.com', 'api.bseindia.com',
  'www.nseindia.com', 'nsearchives.nseindia.com', 'archives.nseindia.com',
  'npstrust.org.in', 'npscra.nsdl.co.in',
  'www.ibjarates.com', 'ibjarates.com',
  'raw.githubusercontent.com', 'api.github.com',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Headers a caller may pass through (the reference fetchers set these).
const PASS = new Set(['accept', 'accept-language', 'referer', 'origin',
  'x-requested-with', 'user-agent']);

// NSE answers only with the cookies its home page sets. Kept for a few
// minutes in the warm function instance so a run's many symbol lookups
// don't each reload the home page.
let nseCookies = '';
let nseCookiesAt = 0;

function cookieHeader(res) {
  const all = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  return all.filter(Boolean).map(c => c.split(';')[0]).join('; ');
}

async function warmNse(force) {
  if (!force && nseCookies && Date.now() - nseCookiesAt < 4 * 60 * 1000) return nseCookies;
  const jar = [];
  for (const page of ['https://www.nseindia.com/', 'https://www.nseindia.com/all-reports']) {
    try {
      const r = await fetch(page, { headers: { ...BROWSER_HEADERS, Cookie: jar.join('; ') },
        signal: AbortSignal.timeout(6000) });
      const c = cookieHeader(r);
      if (c) jar.push(c);
      await r.arrayBuffer();
    } catch (e) { /* best effort - the data request decides */ }
  }
  nseCookies = jar.join('; ');
  nseCookiesAt = Date.now();
  return nseCookies;
}

function reply(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers },
  });
}

export default async (req) => {
  const q = new URL(req.url).searchParams;
  if (q.get('ping')) return reply(200, JSON.stringify({ ok: true, relay: 'networth' }),
    { 'content-type': 'application/json' });

  let target;
  try { target = new URL(q.get('url') || ''); } catch (e) {
    return reply(400, 'bad url');
  }
  if (target.protocol !== 'https:' || !ALLOWED.has(target.hostname)) {
    return reply(403, 'host not allowed');
  }
  let extra = {};
  try { extra = JSON.parse(q.get('h') || '{}'); } catch (e) { extra = {}; }
  const headers = { ...BROWSER_HEADERS };
  for (const [k, v] of Object.entries(extra)) {
    if (PASS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
  }
  const isNse = target.hostname.endsWith('nseindia.com');
  if (target.hostname === 'api.bseindia.com' && !headers.Referer) {
    headers.Referer = 'https://www.bseindia.com/';
  }

  const attempt = async (cookie) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    return fetch(target, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(8500) });
  };
  try {
    let res = await attempt(isNse ? await warmNse(false) : '');
    if (isNse && (res.status === 401 || res.status === 403)) {
      res = await attempt(await warmNse(true));
    }
    const body = new Uint8Array(await res.arrayBuffer());
    return reply(200, body, {
      'content-type': res.headers.get('content-type') || 'application/octet-stream',
      'x-nw-status': String(res.status),
      'x-nw-url': res.url || target.href,
      'access-control-expose-headers': 'x-nw-status, x-nw-url',
    });
  } catch (e) {
    return reply(502, String(e && e.message || e), { 'x-nw-error': '1' });
  }
};
