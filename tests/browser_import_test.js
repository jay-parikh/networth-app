// Statement import in real Chromium: a password-protected CAS PDF + a
// Zerodha tradebook, through the app's file picker, password prompt,
// preview, owner question and summary.
//   CHROME=... PUPPETEER=... node tests/browser_import_test.js <fixtures dir> <out dir>
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer');

const [fixtures, outDir] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:8099/';
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ` - ${d}` : ''}`); };

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const shot = (n) => page.screenshot({ path: path.join(outDir, `${n}.png`), fullPage: false });
  const waitText = (t, timeout = 120000) => page.waitForFunction(x => document.body.innerText.includes(x), { timeout }, t);

  await page.goto(BASE);
  await page.waitForSelector('[data-act=start]:not([disabled])', { timeout: 180000 });
  await page.click('[data-act=start][data-kind=sample]');
  await page.waitForSelector('.hero-num', { timeout: 60000 });
  const sipBefore = await page.evaluate(async () => { location.hash = '#/class/mutual_funds/sip'; await new Promise(r => setTimeout(r, 400)); return document.querySelectorAll('.row-card').length; });

  await page.evaluate(() => { location.hash = '#/data'; });
  await page.waitForSelector('input[data-act=import-files]');
  const input = await page.$('input[data-act=import-files]');
  await input.uploadFile(path.join(fixtures, 'CAS_locked.pdf'), path.join(fixtures, 'tradebook.csv'));
  await page.evaluate(() => document.querySelector('input[data-act=import-files]').dispatchEvent(new Event('change', { bubbles: true })));

  await waitText('Password-protected PDF');
  await shot('i1-password');
  await page.type('.modal [name=v1]', 'wrong-pass');
  await page.click('.modal-foot .primary');
  await waitText("that password doesn't open it");
  check('wrong PDF password is refused', true);
  await page.click('.modal [name=v1]', { clickCount: 3 });
  await page.type('.modal [name=v1]', 'ABCDE1234F');
  await page.click('.modal-foot .primary');
  await waitText('Import these?');
  const preview = await page.$eval('.modal-body', e => e.innerText);
  check('CAS fund reconciles in the preview', /matches the statement's closing balance/.test(preview), preview.split('\n').find(l => l.includes('Parag')) || '');
  check('tradebook read', /3 buy\(s\) and 1 sale|2 buy\(s\) and 1 sale|1 buy\(s\) and 1 sale/.test(preview) || /buy\(s\) and 1 sale/.test(preview));
  await shot('i2-preview');
  // owners: the CAS is guessed as Amit (statement name); give it to Rahul,
  // who has no typed rows in that fund (Amit's typed ₹60,000 would be kept
  // by the engine's missing-folio guard). Tradebook -> Priya.
  const selects = await page.$$('.modal select');
  check('asks who owns each account', selects.length === 2, `${selects.length} question(s)`);
  const guessed = await page.$eval('.modal select', s => s.value);
  check('owner guessed from the statement name', guessed === 'Amit', guessed);
  await page.select('.modal select[name=owner-0]', 'Rahul');   // no typed rows in that fund
  await page.select('.modal select[name=owner-1]', 'Priya');
  await page.click('.modal-foot .primary');
  await waitText('Import finished', 120000);
  const sum = await page.$eval('.modal-body', e => e.innerText);
  fs.writeFileSync(path.join(outDir, 'import-summary.txt'), sum);
  check('fund transactions filled in', /fund transaction\(s\) filled in/.test(sum), (sum.match(/Imported[^\n]*\n[^\n]*/) || [''])[0].replace(/\n/g, ' '));
  check('share lots added', /share lot\(s\) added/.test(sum));
  await shot('i3-summary');
  await page.click('.modal-foot .primary');

  const sipAfter = await page.evaluate(async () => { location.hash = '#/class/mutual_funds/sip'; await new Promise(r => setTimeout(r, 400)); return document.querySelectorAll('.row-card').length; });
  check('MF ledger grew by the statement rows', sipAfter >= sipBefore + 3, `${sipBefore} -> ${sipAfter}`);
  const eq = await page.evaluate(async () => { location.hash = '#/class/equity?owner=Priya'; await new Promise(r => setTimeout(r, 400)); return document.body.innerText; });
  check('imported INFY lot for Priya', /INFOSYS[\s\S]*Priya · 6 sh/.test(eq));
  await shot('i4-equity');

  // importing the same files again adds nothing (idempotent)
  await page.evaluate(() => { location.hash = '#/data'; });
  await page.waitForSelector('input[data-act=import-files]');
  const input2 = await page.$('input[data-act=import-files]');
  await input2.uploadFile(path.join(fixtures, 'tradebook.csv'));
  await page.evaluate(() => document.querySelector('input[data-act=import-files]').dispatchEvent(new Event('change', { bubbles: true })));
  await waitText('Import these?');
  const pre2 = await page.$eval('.modal-body', e => e.innerText);
  check('second import is flagged "read before"', /read before/.test(pre2));
  await page.click('.modal-foot .primary');
  await waitText('Import finished', 120000);
  const sum2 = await page.$eval('.modal-body', e => e.innerText);
  check('second import adds nothing', !/share lot\(s\) added/.test(sum2), (sum2.match(/Imported[^\n]*\n[^\n]*/) || [''])[0].replace(/\n/g, ' '));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
