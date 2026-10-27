// "Unlock with Face ID / fingerprint" (js/passkey.js) in real Chromium.
//   CHROME=... PUPPETEER=... node tests/browser_passkey_test.js <workbook.xlsx> <out dir>
//
// Part 1 replaces navigator.credentials with a stand-in passkey that behaves
// like an iPhone's: it hands out its PRF secret only on sign-in (never at
// creation), only after "Face ID", and the secret is HMAC(passkey key, salt).
// That runs the app's whole flow: setup, unlock after reload, cancel, a
// passkey that no longer matches, password change, Lock off.
// Part 2 uses Chromium's real WebAuthn with a CDP virtual authenticator, to
// prove the browser accepts the app's create() options; Chromium 99 has no
// PRF, so the app must explain instead of turning the switch on.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer');

const [xlsx, outDir] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:8099/';
const PW = 'family-2026', PW2 = 'new-pass-77';
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// the stand-in passkey (installed before the app's own scripts run)
function standIn() {
  const st = () => JSON.parse(localStorage.getItem('mockpk') || '{"keys":{}}');
  const save = (s) => localStorage.setItem('mockpk', JSON.stringify(s));
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  window.__pk = { cancel: false, prfAtCreate: false, calls: [] };
  async function prf(keyB64, salt) {
    const raw = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
    const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', k, salt);
  }
  Object.defineProperty(navigator, 'credentials', { value: {
    async create({ publicKey: o }) {
      window.__pk.calls.push('create:' + o.authenticatorSelection.userVerification + ':' + JSON.stringify(Object.keys(o.extensions || {})));
      if (window.__pk.cancel) throw new DOMException('cancelled', 'NotAllowedError');
      const id = crypto.getRandomValues(new Uint8Array(16)), key = crypto.getRandomValues(new Uint8Array(32));
      const s = st(); s.keys[b64(id)] = b64(key); save(s);
      const results = window.__pk.prfAtCreate ? { first: await prf(b64(key), o.extensions.prf.eval.first) } : undefined;
      return { rawId: id.buffer, getClientExtensionResults: () => ({ prf: results ? { enabled: true, results } : { enabled: true } }) };
    },
    async get({ publicKey: o }) {
      window.__pk.calls.push('get:' + o.userVerification);
      if (window.__pk.cancel) throw new DOMException('cancelled', 'NotAllowedError');
      const key = st().keys[b64(o.allowCredentials[0].id)];
      if (!key) throw new DOMException('no passkey', 'NotAllowedError');
      const first = await prf(key, o.extensions.prf.eval.first);
      return { rawId: o.allowCredentials[0].id, getClientExtensionResults: () => ({ prf: { results: { first } } }) };
    },
  }, configurable: true });
  window.PublicKeyCredential = window.PublicKeyCredential || function () {};
  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
}

async function launch() {
  return puppeteer.launch({ executablePath: process.env.CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
}

async function importWorkbook(page) {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-act=start]:not([disabled])', { timeout: 180000 });
  const input = await page.$('input[data-act=import-xlsx]');
  await input.uploadFile(xlsx);
  await page.evaluate(() => document.querySelector('input[data-act=import-xlsx]').dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForFunction(() => document.body.innerText.includes('Workbook imported'), { timeout: 180000 });
  await page.click('.modal-foot .primary');
  await page.waitForSelector('.hero-num');
}

const go = async (page, h) => { await page.evaluate(x => { location.hash = x; }, h); await sleep(600); };
const modalOk = async (page) => { await page.waitForSelector('.modal-foot .primary'); await page.click('.modal-foot .primary'); await sleep(500); };
const toggle = (page, sel) => page.$eval(sel, e => e.click());
// unlocked = the lock screen is gone and the calculator has started (the
// Dashboard shows "Getting the calculator ready" until then)
const unlocked = async (page) => {
  const ok = await page.waitForFunction(() => !document.querySelector('[data-act=unlock-form]') && document.querySelector('#top [data-act=update]'),
    { timeout: 60000 }).then(() => true, () => false);
  if (!ok) return false;
  await page.evaluate(() => { location.hash = '#/home'; });
  return page.waitForFunction(() => document.querySelector('.hero-num') && !/Getting the calculator ready/.test(document.body.innerText),
    { timeout: 180000 }).then(() => true, () => false);
};
const typeModal = async (page, ...vals) => {
  await page.waitForSelector('.modal [name=v1]');
  await page.type('.modal [name=v1]', vals[0]);
  if (vals[1]) await page.type('.modal [name=v2]', vals[1]);
};

(async () => {
  // ---------------------------------------------------------------- part 1
  let browser = await launch();
  let page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: IPHONE });
  await page.evaluateOnNewDocument(standIn);
  await importWorkbook(page);

  // the row only shows with the Lock on
  await go(page, '#/settings');
  check('no device-unlock row while the Lock is off', !(await page.$('[data-act=passkey-toggle]')));
  await toggle(page, '[data-act=privacy-lock]');
  await typeModal(page, PW, PW);
  await modalOk(page);
  await page.waitForFunction(() => document.querySelector('[data-act=privacy-lock]') && document.querySelector('[data-act=privacy-lock]').checked, { timeout: 30000 });
  await sleep(500);
  const row = await page.$eval('[data-act=passkey-toggle]', e => e.closest('.set-row').innerText).catch(() => '');
  check('Settings offers "Unlock with Face ID / Touch ID" once the Lock is on', /Unlock with Face ID \/ Touch ID/.test(row), row.split('\n')[0]);
  await page.$eval('[data-act=passkey-toggle]', e => e.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(outDir, '01-settings.png') });

  // turn it on: password, Continue (create), One more step (sign in)
  await toggle(page, '[data-act=passkey-toggle]');
  await typeModal(page, 'wrong-one');
  await page.click('.modal-foot .primary'); await sleep(800);
  check('a wrong password is refused', /doesn't match/.test(await page.$eval('.modal', e => e.innerText)));
  await page.$eval('.modal [name=v1]', e => { e.value = ''; });
  await page.type('.modal [name=v1]', PW);
  await modalOk(page);                                           // password
  await page.waitForFunction(() => /Set up Face ID/.test((document.querySelector('.modal') || {}).innerText || ''), { timeout: 10000 });
  await modalOk(page);                                           // Continue -> create()
  await page.waitForFunction(() => /One more step/.test((document.querySelector('.modal') || {}).innerText || ''), { timeout: 10000 });
  await page.screenshot({ path: path.join(outDir, '02-one-more-step.png') });
  await modalOk(page);                                           // Confirm -> get()
  await sleep(800);
  const calls = await page.evaluate(() => window.__pk.calls);
  check('setup: create needs the device lock and asks for PRF, then one sign-in', calls.length === 2 && calls[0] === 'create:required:["prf"]' && calls[1] === 'get:required', JSON.stringify(calls));
  check('switch is on', await page.$eval('[data-act=passkey-toggle]', e => e.checked));
  const stored = await page.evaluate((pw) => new Promise(res => {
    const r = indexedDB.open('networth');
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('passkey'); g.onsuccess = () => {
      const v = g.result; if (!v) return res('none');
      let plain = ''; try { plain = new TextDecoder().decode(v.data); } catch (e) {}
      res(`${Object.keys(v).join(',')} | plain text: ${plain.includes(pw)}`);
    }; };
  }), PW);
  check('only a sealed copy is stored, not the password', /credId,prfSalt,iv,data/.test(stored) && /plain text: false/.test(stored), stored);

  // reload: lock screen with the device button; tap opens the app
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-act=passkey-unlock]', { timeout: 30000 });
  check('lock screen offers "Unlock with Face ID / Touch ID"', /Unlock with Face ID \/ Touch ID/.test(await page.$eval('[data-act=passkey-unlock]', e => e.innerText)));
  await page.screenshot({ path: path.join(outDir, '03-lock-screen.png') });
  await page.evaluate(() => { window.__pk.cancel = true; });
  await page.click('[data-act=passkey-unlock]'); await sleep(800);
  check('cancelling Face ID keeps it locked, quietly', !!(await page.$('[data-act=passkey-unlock]')) && !(await page.$('.welcome .err')));
  await page.evaluate(() => { window.__pk.cancel = false; });
  await page.click('[data-act=passkey-unlock]');
  check('Face ID unlocks the app', await unlocked(page));

  // change the password: the device unlock follows
  await go(page, '#/settings');
  await page.waitForSelector('[data-act=privacy-change]');
  await page.click('[data-act=privacy-change]');
  await page.waitForSelector('.modal [name=v1]', { timeout: 60000 });
  if (!(await page.$('.modal [name=v2]'))) { await typeModal(page, PW); await modalOk(page); await page.waitForSelector('.modal [name=v2]', { timeout: 60000 }); }
  await typeModal(page, PW2, PW2);
  await modalOk(page);
  await page.waitForFunction(() => /Keep Face ID/.test((document.querySelector('.modal') || {}).innerText || ''), { timeout: 20000 });
  await modalOk(page);
  await sleep(1500);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-act=passkey-unlock]', { timeout: 30000 });
  await page.click('[data-act=passkey-unlock]');
  check('after a password change Face ID still opens it', await unlocked(page));

  // a passkey that no longer matches (e.g. deleted and re-made): clear message, password still works
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('mockpk')); for (const k in s.keys) s.keys[k] = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))); localStorage.setItem('mockpk', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-act=passkey-unlock]', { timeout: 30000 });
  await page.click('[data-act=passkey-unlock]'); await sleep(1000);
  const err = await page.$eval('.welcome .err', e => e.innerText).catch(() => '');
  check('a passkey that no longer matches says so', /does not match/.test(err), err);
  await page.type('[name=pw]', PW2);
  await page.click('.unlock button');
  check('the password still opens it', await unlocked(page));

  // Lock off: the sealed copy is removed, no lock screen
  await go(page, '#/settings');
  await page.waitForSelector('[data-act=privacy-lock]');
  await toggle(page, '[data-act=privacy-lock]');
  await sleep(1500);
  if (await page.$('.modal')) await modalOk(page);
  await page.waitForFunction(() => !document.querySelector('[data-act=privacy-lock]').checked, { timeout: 30000 }).catch(() => {});
  const gone = await page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('networth'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('passkey'); g.onsuccess = () => res(g.result === undefined); };
  }));
  check('turning the Lock off removes the sealed copy', gone);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.hero-num, #top [data-act=update]', { timeout: 120000 }).catch(() => {});
  check('and the app opens without a lock screen', !(await page.$('[data-act=passkey-unlock]')) && !(await page.$('[data-act=unlock-form]')));
  check('no page errors (part 1)', errors.length === 0, errors.join(' || '));
  await browser.close();

  // ---------------------------------------------------------------- part 2
  browser = await launch();
  page = await browser.newPage();
  const errors2 = [];
  page.on('pageerror', e => errors2.push(e.message));
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0 Mobile Safari/537.36' });
  const cdp = await page.target().createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await importWorkbook(page);
  await go(page, '#/settings');
  await toggle(page, '[data-act=privacy-lock]');
  await typeModal(page, PW, PW);
  await modalOk(page);
  await page.waitForFunction(() => document.querySelector('[data-act=privacy-lock]') && document.querySelector('[data-act=privacy-lock]').checked, { timeout: 30000 });
  await sleep(500);
  check('real WebAuthn: platform authenticator detected', !!(await page.$('[data-act=passkey-toggle]')));
  await toggle(page, '[data-act=passkey-toggle]');
  await typeModal(page, PW);
  await modalOk(page);
  await page.waitForFunction(() => /Set up/.test((document.querySelector('.modal') || {}).innerText || ''), { timeout: 10000 });
  await modalOk(page);                               // the real navigator.credentials.create()
  await page.waitForFunction(() => /Could not turn it on/.test((document.querySelector('.modal') || {}).innerText || ''), { timeout: 30000 }).catch(() => {});
  const msg = await page.$eval('.modal', e => e.innerText).catch(() => '');
  check('real WebAuthn accepts the request; without PRF the app explains', /cannot unlock encrypted data/.test(msg), msg.replace(/\n+/g, ' ').slice(0, 140));
  await page.screenshot({ path: path.join(outDir, '04-no-prf.png') });
  if (await page.$('.modal')) await modalOk(page);
  check('switch stays off', !(await page.$eval('[data-act=passkey-toggle]', e => e.checked)));
  check('no page errors (part 2)', errors2.length === 0, errors2.join(' || '));
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
