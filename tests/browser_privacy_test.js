// Privacy in real Chromium: mask (••• until the password), Lock (device data
// encrypted, lock screen after reload), locked Excel export + re-import.
//   CHROME=... PUPPETEER=... node tests/browser_privacy_test.js <out dir>
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer');

const [outDir] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:8099/';
const PW = 'family-2026';
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ` - ${d}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const shot = (n) => page.screenshot({ path: path.join(outDir, `${n}.png`) });
  const waitText = async (t, timeout = 120000) => {
    try {
      await page.waitForFunction(x => document.body.innerText.includes(x), { timeout }, t);
    } catch (e) {
      await shot('fail');
      console.log('WAITED FOR:', t, '\nPAGE:', (await page.evaluate(() => document.body.innerText)).slice(0, 700), '\nERRORS:', errors.join(' | '));
      throw e;
    }
  };
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  const toggle = async (sel, on) => page.$eval(sel, (e, v) => { e.checked = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, on);
  const fillPw = async (v1, v2) => {
    await page.waitForSelector('.modal [name=v1]');
    await page.type('.modal [name=v1]', v1);
    if (v2 !== undefined) await page.type('.modal [name=v2]', v2);
    await page.click('.modal-foot .primary');
  };

  await page.goto(BASE);
  await page.waitForSelector('[data-act=start]:not([disabled])', { timeout: 180000 });
  await page.click('[data-act=start][data-kind=sample]');
  await page.waitForSelector('.hero-num', { timeout: 60000 });

  // mask on: choose a password (twice)
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('[data-act=privacy-mask]');
  await toggle('[data-act=privacy-mask]', true);
  await fillPw('ab', 'xy');
  await waitText('The two entries differ');
  check('mismatched passwords refused', true);
  await page.click('.modal [name=v1]', { clickCount: 3 }); await page.type('.modal [name=v1]', PW);
  await page.click('.modal [name=v2]', { clickCount: 3 }); await page.type('.modal [name=v2]', PW);
  await page.click('.modal-foot .primary');
  await waitText('Privacy mask on');
  // hide -> numbers masked
  await page.click('[data-act=hide]');
  await page.evaluate(() => { location.hash = '#/home'; });
  await sleep(500);
  const masked = await page.$eval('.hero-num', e => e.textContent);
  check('numbers masked', masked.includes('•••'), masked);
  const chartHidden = await page.evaluate(() => document.body.innerText.includes('Charts are hidden while privacy is on'));
  check('charts hidden while masked', chartHidden);
  await shot('m1-masked');
  // reveal with a wrong then right password
  await page.click('[data-act=reveal]');
  await fillPw('nope');
  await waitText("That password doesn't match");
  check('wrong password does not reveal', true);
  await page.click('.modal [name=v1]', { clickCount: 3 }); await page.type('.modal [name=v1]', PW);
  await page.click('.modal-foot .primary');
  await page.waitForFunction(() => !document.querySelector('.modal'));
  const shown = await page.$eval('.hero-num', e => e.textContent);
  check('right password reveals', /₹[\d.]+ L/.test(shown), shown);

  // lock on: confirm password; device copy gets encrypted
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('[data-act=privacy-lock]');
  await toggle('[data-act=privacy-lock]', true);
  await fillPw(PW);
  await waitText('Locked - your password is needed');
  const sealed = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('networth');
    r.onsuccess = () => {
      const g = r.result.transaction('kv').objectStore('kv').get('portfolio');
      g.onsuccess = () => res(typeof g.result === 'object' && g.result && g.result.sealed === 1);
    };
  }));
  check('device copy encrypted at rest', sealed);

  // export: the file must be an encrypted OOXML container (CFB magic)
  const dl = path.join(outDir, 'dl');
  fs.mkdirSync(dl, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.evaluate(() => { location.hash = '#/data'; });
  await page.waitForSelector('[data-act=export]');
  await page.click('[data-act=export]');
  const xl = path.join(dl, 'Family_Portfolio_Tracker.xlsx');
  for (let i = 0; i < 120 && !fs.existsSync(xl); i++) await sleep(500);
  await sleep(500);
  const head = fs.existsSync(xl) ? fs.readFileSync(xl).subarray(0, 4).toString('hex') : '';
  check('locked export is encrypted (needs the password in Excel)', head === 'd0cf11e0', head);

  // reload -> lock screen; wrong then right password
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.reload();
  await waitText('NetWorth is locked', 30000);
  await shot('m2-lockscreen');
  await page.type('[name=pw]', 'wrong');
  await page.click('form[data-act=unlock-form] button');
  await waitText("That password doesn't open it");
  check('lock screen refuses a wrong password', true);
  await page.click('[name=pw]', { clickCount: 3 });
  await page.type('[name=pw]', PW);
  await page.click('form[data-act=unlock-form] button');
  await page.waitForSelector('.hero-num', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('.banner.info .spinner'), { timeout: 180000 });
  check('unlocks with the right password', true);

  // import the locked export back (asks for its password)
  await page.evaluate(() => { location.hash = '#/data'; });
  await page.waitForSelector('input[data-act=import-xlsx]');
  const input = await page.$('input[data-act=import-xlsx]');
  await input.uploadFile(xl);
  await page.evaluate(() => document.querySelector('input[data-act=import-xlsx]').dispatchEvent(new Event('change', { bubbles: true })));
  await waitText('Import this workbook?');
  await page.click('.modal-foot .primary');
  await waitText('This file is locked');
  await fillPw(PW);
  await waitText('Workbook imported', 120000);
  check('locked workbook re-imports with its password', true);
  await page.click('.modal-foot .primary');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
