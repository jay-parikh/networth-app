// On-device storage (IndexedDB). Nothing here ever leaves the device.
//
//   kv store      'portfolio'  the portfolio (JSON from the engine)
//                 'viewcache'  last computed screen data, for an instant start
//                 'lock'       {salt, check} when the Lock is on
//   backups store {ts, reason, payload} - the newest KEEP_BACKUPS copies
//
// When the Lock is on, 'portfolio', 'viewcache' and every backup are
// AES-GCM encrypted with a key derived from the password (PBKDF2-SHA256).
// The password itself is never stored.

const DB_NAME = 'networth';
const DB_VERSION = 1;
export const KEEP_BACKUPS = 10;
const PBKDF2_ITER = 310000;

let dbp = null;
let key = null;          // CryptoKey while unlocked
let lockSalt = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('backups')) {
          d.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(r => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage aborted'));
  }));
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const kvGet = (k) => tx('kv', 'readonly', s => reqP(s.get(k)));
export const kvSet = (k, v) => tx('kv', 'readwrite', s => { s.put(v, k); });
export const kvDel = (k) => tx('kv', 'readwrite', s => { s.delete(k); });

// ------------------------------------------------------------ encryption ---

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(text) {
  if (!key) return text;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { sealed: 1, iv, data: new Uint8Array(data) };
}

async function open(v) {
  if (v == null || typeof v === 'string') return v;
  if (!v.sealed) return v;
  if (!key) throw new Error('locked');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.iv }, key, v.data);
  return dec.decode(plain);
}

export async function lockInfo() {
  return kvGet('lock');
}

export function isUnlocked() { return !!key; }

// Unlock with a password; false when it is wrong.
export async function unlock(password) {
  const info = await kvGet('lock');
  if (!info) return true;
  const k = await deriveKey(password, info.salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: info.check.iv }, k, info.check.data);
    if (dec.decode(plain) !== 'networth') return false;
  } catch (e) {
    return false;
  }
  key = k;
  lockSalt = info.salt;
  return true;
}

// Turn the at-rest lock on (re-encrypting everything) or off (decrypting).
export async function setLock(password) {
  const portfolio = await loadPortfolio();
  const view = await loadViewCache();
  const backups = await listBackups(true);
  if (password) {
    lockSalt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(password, lockSalt);
    const check = await seal('networth');
    await kvSet('lock', { salt: lockSalt, check });
  } else {
    key = null;
    lockSalt = null;
    await kvDel('lock');
  }
  if (portfolio != null) await savePortfolio(portfolio);
  if (view != null) await saveViewCache(view);
  for (const b of backups) {
    const sealed = await seal(b.payload);
    await tx('backups', 'readwrite', s => { s.put({ ...b, payload: sealed }); });
  }
}

export function forgetKey() { key = null; }

// ------------------------------------------------------------- portfolio ---

export async function loadPortfolio() { return open(await kvGet('portfolio')); }
export async function savePortfolio(text) {
  await kvSet('portfolio', await seal(text));
  await kvSet('savedAt', new Date().toISOString());
}

export async function loadViewCache() {
  const v = await open(await kvGet('viewcache'));
  return v ? JSON.parse(v) : null;
}
export async function saveViewCache(view) {
  const text = typeof view === 'string' ? view : JSON.stringify(view);
  await kvSet('viewcache', await seal(text));
}

// --------------------------------------------------------------- backups ---

export async function addBackup(reason) {
  const current = await kvGet('portfolio');     // stored form (sealed or not)
  if (current == null) return;
  await tx('backups', 'readwrite', s => { s.add({ ts: new Date().toISOString(), reason, payload: current }); });
  const all = await tx('backups', 'readonly', s => reqP(s.getAll()));
  all.sort((a, b) => a.id - b.id);
  const extra = all.slice(0, Math.max(0, all.length - KEEP_BACKUPS));
  if (extra.length) {
    await tx('backups', 'readwrite', s => { for (const b of extra) s.delete(b.id); });
  }
}

export async function listBackups(withPayload = false) {
  const all = await tx('backups', 'readonly', s => reqP(s.getAll()));
  all.sort((a, b) => b.id - a.id);
  if (withPayload) {
    const out = [];
    for (const b of all) out.push({ ...b, payload: await open(b.payload) });
    return out;
  }
  return all.map(({ id, ts, reason }) => ({ id, ts, reason }));
}

export async function backupPayload(id) {
  const b = await tx('backups', 'readonly', s => reqP(s.get(id)));
  return b ? open(b.payload) : null;
}

export async function lastBackupTs() {
  const list = await listBackups();
  return list.length ? list[0].ts : null;
}

// ------------------------------------------------------------ prefs ------

export async function getPref(name, dflt) {
  const p = (await kvGet('prefs')) || {};
  return name in p ? p[name] : dflt;
}
export async function setPref(name, value) {
  const p = (await kvGet('prefs')) || {};
  p[name] = value;
  await kvSet('prefs', p);
}

export async function wipeAll() {
  key = null;
  const d = await db();
  d.close();
  dbp = null;
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

export async function persistStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch (e) { /* not supported */ }
  return false;
}
