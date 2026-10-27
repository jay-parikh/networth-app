// End-to-end test in real (headless) Chromium against tests/devserver.mjs.
//
//   CHROME=<chrome binary> PUPPETEER=<puppeteer module dir> \
//   node tests/browser_test.js <workbook.xlsx> <out dir> [--no-update]
//
// Imports the workbook, walks every page at phone size, edits a row, runs a
// live update through the relay, exports Excel, reopens OFFLINE, and takes
// iPad screenshots. Exits 1 on any failed check or page error.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer');

const [xlsx, outDir] = process.argv.slice(2);
const doUpdate = !process.argv.includes('--no-update');
const BASE = process.env.BASE || 'http://localhost:8099/';
fs.mkdirSync(outDir, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    // a Drop-style deploy has no function: the app's ping 404s, by design
    if (m.type() === 'error' && !(m.text().includes('404') && m.location() && /functions\/fetch/.test(m.location().url || ''))) {
      errors.push(`console: ${m.text()}`);
    }
  });
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0 Mobile Safari/537.36',
  });
  const shot = (name) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  const waitText = (text, timeout = 120000) => page.waitForFunction(
    t => document.body.innerText.includes(t), { timeout }, text);

  let t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-act=start]:not([disabled])', { timeout: 180000 });
  check('engine starts', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await shot('01-welcome');

  // import the user's workbook through the real file input
  const input = await page.$('input[data-act=import-xlsx]');
  await input.uploadFile(xlsx);
  await page.evaluate(() => {
    const i = document.querySelector('input[data-act=import-xlsx]');
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  t0 = Date.now();
  await waitText('Workbook imported', 180000);
  check('excel import', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await shot('02-imported');
  await page.click('.modal-foot .primary');
  await page.waitForSelector('.hero-num');
  const nw = await page.$eval('.hero-sub', e => e.textContent);
  check('dashboard shows net worth', /₹[\d,]+/.test(nw), nw.trim());
  await shot('03-dashboard');

  const pages = ['people', 'person/Amit', 'holdings', 'class/equity', 'class/equity/by_scrip', 'class/equity/dividends',
    'class/mutual_funds', 'class/mutual_funds/sip', 'class/fixed_deposits', 'class/ppf', 'class/ppf/ppf_ledger', 'class/bonds',
    'reports', 'projection', 'history', 'more', 'settings', 'data', 'guide', 'about'];
  for (const p of pages) {
    await page.evaluate(h => { location.hash = h; }, `#/${p}`);
    await new Promise(r => setTimeout(r, 400));
    if (p === 'guide') await waitText('Words you', 20000).catch(() => {});
    const bad = await page.$('.banner.error');
    check(`page ${p}`, !bad, bad ? await page.$eval('.banner.error', e => e.textContent) : '');
    await shot(`p-${p.replace(/\//g, '_')}`);
  }

  // switch on every class + capital gains, check new pages render
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForSelector('[data-act=class-toggle]');
  const toggles = await page.$$('[data-act=class-toggle]');
  for (let i = 0; i < toggles.length; i++) {
    const el = (await page.$$('[data-act=class-toggle]'))[i];
    const on = await el.evaluate(e => e.checked);
    if (!on) {
      await el.evaluate(e => { e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); });
      await new Promise(r => setTimeout(r, 900));
    }
  }
  const cg = await page.$('[data-act=flag][data-key=show_capital_gains]');
  await cg.evaluate(e => { e.checked = true; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await new Promise(r => setTimeout(r, 1200));
  await shot('p-settings-all-on');
  for (const p of ['class/epf', 'class/gold_silver', 'class/nps', 'class/real_estate', 'class/cash', 'capgains', 'taxrules', 'class/equity/equity_sells', 'home']) {
    await page.evaluate(h => { location.hash = h; }, `#/${p}`);
    await new Promise(r => setTimeout(r, 400));
    const bad = await page.$('.banner.error');
    check(`page ${p}`, !bad);
    await shot(`q-${p.replace(/\//g, '_')}`);
  }

  // add a fixed deposit through the form
  await page.evaluate(() => { location.hash = '#/class/fixed_deposits'; });
  await page.waitForSelector('[data-act=add]');
  const before = await page.$$eval('.row-card', l => l.length);
  await page.click('[data-act=add]');
  await page.waitForSelector('.modal [name=principal]');
  await page.select('.modal [name=owner]', 'Priya');
  await page.type('.modal [name=bank]', 'Punjab Nat');
  await new Promise(r => setTimeout(r, 600));
  const picks = await page.$$('.modal .pick');
  check('bank type-ahead suggests', picks.length > 0, `${picks.length} suggestions`);
  if (picks.length) await picks[0].click();
  await page.type('.modal [name=principal]', '1,00,000');
  await page.type('.modal [name=rate]', '7');
  await page.$eval('.modal [name=start]', e => { e.value = '2025-04-01'; });
  await page.$eval('.modal [name=maturity]', e => { e.value = '2028-04-01'; });
  await shot('r-fd-form');
  await page.click('.modal-foot .primary');
  await page.waitForFunction(n => document.querySelectorAll('.row-card').length > n && !document.querySelector('.modal'), { timeout: 30000 }, before);
  const fdText = await page.$$eval('.row-card', l => l.map(e => e.innerText).join('\n'));
  check('FD added with computed value', /Punjab National Bank[\s\S]*₹1,0\d,\d{3}/.test(fdText), fdText.split('\n').slice(-6).join(' | '));
  await shot('r-fd-added');

  // edit a stock via the stock picker
  await page.evaluate(() => { location.hash = '#/class/equity'; });
  await page.waitForSelector('[data-act=add]');
  await page.click('[data-act=add]');
  await page.waitForSelector('.modal [name=scrip]');
  await page.select('.modal [name=owner]', 'Rahul');
  await page.type('.modal [name=scrip]', 'itc');
  await new Promise(r => setTimeout(r, 800));
  const sp = await page.$$eval('.modal .pick', l => l.map(e => e.innerText.split('\n')[0]).slice(0, 5));
  check('stock type-ahead suggests', sp.length > 0, sp.join(' / '));
  await page.click('.modal .pick');
  await page.type('.modal [name=qty]', '50');
  await page.type('.modal [name=avg_cost]', '410');
  await page.$eval('.modal [name=cost_date]', e => { e.value = '2024-06-03'; });
  const note = await page.$eval('.modal .pick-note', e => e.textContent);
  check('stock ISIN resolves', /ISIN IN/.test(note), note);
  await page.click('.modal-foot .primary');
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 30000 });
  await shot('r-equity-added');

  if (doUpdate) {
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForSelector('#top [data-act="update"]');
    t0 = Date.now();
    await page.click('#top [data-act="update"]');
    await page.waitForSelector('.busy-layer');
    await new Promise(r => setTimeout(r, 1500));
    await shot('s-updating');
    await waitText('Update finished', 300000);
    const sum = await page.$eval('.modal-body', e => e.innerText);
    check('live update finished', /Prices/.test(sum), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check('fund NAVs matched', /Fund NAVs\s+\d+\/\d+ funds matched/.test(sum) && !/AMFI fetch failed/.test(sum),
      (sum.match(/Fund NAVs[^\n]*\n?[^\n]*/) || [''])[0]);
    fs.writeFileSync(path.join(outDir, 'update-summary.txt'), sum);
    await shot('s-update-summary');
    await page.click('.modal-foot .primary');
  }

  // export to Excel (download)
  const dl = path.join(outDir, 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.evaluate(() => { location.hash = '#/data'; });
  await page.waitForSelector('[data-act=export]');
  await page.click('[data-act=export]');
  const xl = path.join(dl, 'Family_Portfolio_Tracker.xlsx');
  for (let i = 0; i < 120 && !fs.existsSync(xl); i++) await new Promise(r => setTimeout(r, 500));
  check('excel export downloads', fs.existsSync(xl), fs.existsSync(xl) ? `${fs.statSync(xl).size} bytes`
    : (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\s+/g, ' '));
  await shot('t-export');
  await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(m => m.remove()));

  // offline: reload with the network cut - served by the service worker
  await page.evaluate(() => navigator.serviceWorker.ready);
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.setOfflineMode(true);
  t0 = Date.now();
  await page.reload({ waitUntil: 'load' });
  try {
    await page.waitForSelector('.hero-num', { timeout: 60000 });
  } catch (e) {
    await shot('t-offline-fail');
    console.log('offline page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 600));
    console.log('errors:', errors.join(' || '));
    throw e;
  }
  await page.waitForFunction(() => !document.querySelector('.banner.info .spinner'), { timeout: 180000 });
  check('works offline after reload', true, `${((Date.now() - t0) / 1000).toFixed(1)} s to ready`);
  const fdOff = await page.evaluate(async () => { location.hash = '#/class/fixed_deposits'; await new Promise(r => setTimeout(r, 500)); return document.body.innerText; });
  check('data persisted across reload', /Punjab National Bank/.test(fdOff));
  await shot('t-offline');
  await page.setOfflineMode(false);

  // iPad
  await page.setViewport({ width: 1024, height: 1366, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  for (const p of ['home', 'class/equity', 'settings']) {
    await page.evaluate(h => { location.hash = h; }, `#/${p}`);
    await new Promise(r => setTimeout(r, 500));
    await shot(`u-ipad-${p.replace(/\//g, '_')}`);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' || '));
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
