// The 2026-10-27 changes in real Chromium: one Update button, the Settings
// "When you tap Update" switches (Splits & bonuses, Dividends), the always-
// visible Actions tab, and the floating Add button on every list page.
//   CHROME=... PUPPETEER=... node tests/browser_settings_test.js <workbook.xlsx> <out dir>
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer');

const [xlsx, outDir] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:8099/';
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });
  const go = async (h) => { await page.evaluate(x => { location.hash = x; }, h); await new Promise(r => setTimeout(r, 500)); };
  const text = () => page.evaluate(() => document.getElementById('page').innerText);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-act=start]:not([disabled])', { timeout: 180000 });
  const input = await page.$('input[data-act=import-xlsx]');
  await input.uploadFile(xlsx);
  await page.evaluate(() => document.querySelector('input[data-act=import-xlsx]').dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForFunction(() => document.body.innerText.includes('Workbook imported'), { timeout: 180000 });
  await page.click('.modal-foot .primary');
  await page.waitForSelector('.hero-num');

  // one Update button, in the top bar
  const upd = await page.$$eval('[data-act=update]', els => els.map(e => e.closest('#top') ? 'top' : 'page'));
  check('one Update button, in the top bar', upd.length === 1 && upd[0] === 'top', JSON.stringify(upd));
  check('no "Update prices" wording left', !/Update prices/.test(await page.evaluate(() => document.body.innerText)));

  // the switches, both on by default
  await go('#/settings');
  const sw = await page.$$eval('input[data-act=flag]', els => Object.fromEntries(els.map(e => [e.dataset.key, e.checked])));
  check('Settings has both switches, on', sw.apply_split_bonus === true && sw.fetch_dividends === true, JSON.stringify(sw));
  await page.$eval('input[data-key=apply_split_bonus]', e => e.scrollIntoView({ block: 'center' }));
  await shot('01-settings-switches');

  // Actions tab is shown even with Reference lists off
  await go('#/class/equity');
  const tabs = await page.$$eval('.tabs-inline a', as => as.map(a => a.textContent));
  check('Actions tab always shown', tabs.includes('Actions'), tabs.join(' | '));

  // switch splits & bonuses off: note on the Actions tab, quantities as typed
  await go('#/settings');
  await page.$eval('input[data-key=apply_split_bonus]', e => e.click());
  await page.waitForFunction(() => !document.querySelector('input[data-key=apply_split_bonus]').checked, { timeout: 20000 });
  await go('#/class/equity/corporate_actions');
  check('Actions tab says splits & bonuses are off', /Splits & bonuses are off/.test(await text()));
  await shot('02-actions-off');
  await go('#/settings');
  await page.$eval('input[data-key=fetch_dividends]', e => e.click());
  await page.waitForFunction(() => !document.querySelector('input[data-key=fetch_dividends]').checked, { timeout: 20000 });
  await go('#/class/equity/dividends');
  check('Dividends tab says dividends are off', /Dividends are off/.test(await text()));

  // an update reports both switches
  await go('#/home');
  await page.click('#top [data-act=update]');
  await page.waitForFunction(() => document.body.innerText.includes('Update finished'), { timeout: 300000 });
  const sum = await page.$eval('.modal-body', e => e.innerText);
  check('update summary: splits & bonuses off', /Splits & bonuses\s+off in Settings/.test(sum));
  check('update summary: dividends off', /Dividends\s+off in Settings/.test(sum));
  await shot('03-update-summary');
  await page.click('.modal-foot .primary');

  // switches survive a reload (device data)
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.hero-num', { timeout: 180000 });
  await go('#/settings');
  const sw2 = await page.$$eval('input[data-act=flag]', els => Object.fromEntries(els.map(e => [e.dataset.key, e.checked])));
  check('switches kept after reload', sw2.apply_split_bonus === false && sw2.fetch_dividends === false, JSON.stringify(sw2));

  // floating Add on every list page, in view after scrolling to the bottom
  const lists = ['class/equity', 'class/equity/corporate_actions', 'class/mutual_funds', 'class/mutual_funds/sip',
    'class/fixed_deposits', 'class/ppf', 'class/ppf/ppf_ledger', 'class/bonds', 'class/epf', 'class/gold_silver',
    'class/nps', 'class/real_estate', 'class/cash', 'taxrules'];
  for (const l of lists) {
    await go('#/' + l);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 200));
    const r = await page.evaluate(() => {
      const f = document.querySelectorAll('.fab');
      const tops = document.querySelectorAll('.page-head .btn.primary[data-act=add]');
      if (f.length !== 1) return `fab x${f.length}`;
      const b = f[0].getBoundingClientRect();
      const nav = document.getElementById('tabs').getBoundingClientRect();
      if (b.bottom > innerHeight || b.top < 0) return 'off screen';
      if (b.bottom > nav.top + 1 && getComputedStyle(document.getElementById('tabs')).display !== 'none') return 'under the tab bar';
      return tops.length ? 'top button still there' : 'ok';
    });
    check(`floating Add on ${l}`, r === 'ok', r);
  }
  await go('#/class/fixed_deposits');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot('04-fab-fd');
  await page.click('.fab');
  await page.waitForSelector('.modal', { timeout: 10000 });
  check('floating Add opens the form', /Add/.test(await page.$eval('.modal', e => e.innerText)));
  await shot('05-fab-form');

  check('no page errors', errors.length === 0, errors.join(' || '));
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
