// List search and the draggable + button, in real Chromium.
//   CHROME=... PUPPETEER=... node tests/browser_search_fab_test.js <workbook.xlsx> <out dir>
// The workbook should have at least one list longer than 8 entries; the test
// adds FDs until the Fixed deposits list is long enough if needed.
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const go = async (h) => { await page.evaluate(x => { location.hash = x; }, h); await sleep(500); };
  const visible = () => page.$$eval('.list > .row-card', cs => cs.filter(c => !c.hidden).length);

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-act=start]:not([disabled])', { timeout: 180000 });
  const input = await page.$('input[data-act=import-xlsx]');
  await input.uploadFile(xlsx);
  await page.evaluate(() => document.querySelector('input[data-act=import-xlsx]').dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForFunction(() => document.body.innerText.includes('Workbook imported'), { timeout: 180000 });
  await page.click('.modal-foot .primary');
  await page.waitForSelector('.hero-num');

  // which lists show a search box
  const lists = ['people', 'person/Amit', 'class/equity', 'class/equity/by_scrip', 'class/equity/dividends',
    'class/equity/corporate_actions', 'class/mutual_funds', 'class/mutual_funds/sip', 'class/fixed_deposits',
    'class/ppf/ppf_ledger', 'taxrules', 'more', 'reports'];
  for (const l of lists) {
    await go('#/' + l);
    const r = await page.evaluate(() => ({ n: document.querySelectorAll('.list > .row-card').length,
      box: !!document.querySelector('.list-search') }));
    check(`search box only on long lists: ${l}`, r.box === (r.n > 8), `${r.n} entries, box ${r.box}`);
  }

  // make the FD list long: add FDs through the floating + button
  await go('#/class/fixed_deposits');
  let n = await page.$$eval('.list > .row-card', cs => cs.length);
  for (let i = n; i < 11; i++) {
    await page.click('.fab');
    await page.waitForSelector('.modal [name=principal]');
    await page.select('.modal [name=owner]', 'Amit');
    await page.type('.modal [name=bank]', i % 2 ? 'Axis Bank' : 'ICICI Bank');
    await page.type('.modal [name=principal]', String(10000 * (i + 1)));
    await page.type('.modal [name=rate]', '7');
    await page.$eval('.modal [name=start]', e => { e.value = '2025-04-01'; });
    await page.$eval('.modal [name=maturity]', e => { e.value = '2028-04-01'; });
    await page.click('.modal-foot .primary');
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 });
    await sleep(300);
  }
  await go('#/class/fixed_deposits');
  n = await page.$$eval('.list > .row-card', cs => cs.length);
  check('FD list is long enough to test', n > 8, `${n} FDs`);
  check('search box on the long FD list', !!(await page.$('.list-search')));

  // type: every word must match; commas ignored
  await page.type('[data-act=list-search]', 'axis');
  await sleep(200);
  const axis = await page.$$eval('.list > .row-card', cs => cs.filter(c => !c.hidden).map(c => c.textContent));
  check('search filters the list', axis.length > 0 && axis.length < n && axis.every(t => /axis/i.test(t)), `${axis.length} of ${n}`);
  check('count shows "x of y"', (await page.$eval('.ls-count', e => e.textContent)) === `${axis.length} of ${n}`);
  await shot('01-search-axis');
  await page.click('[data-act=list-search]', { clickCount: 3 });
  await page.type('[data-act=list-search]', '30000 amit');
  await sleep(200);
  const amt = await page.$$eval('.list > .row-card', cs => cs.filter(c => !c.hidden).map(c => c.textContent));
  check('numbers match without commas ("30000" finds "30,000")', amt.length >= 1 && amt.every(t => /30,000/.test(t)), `${amt.length} shown`);
  await page.click('[data-act=list-search]', { clickCount: 3 });
  await page.type('[data-act=list-search]', 'zzzz');
  await sleep(200);
  check('no matches message', (await page.$eval('.ls-count', e => e.textContent)) === 'No matches' && (await visible()) === 0);

  // one tap on the ✕ empties the box: everything back, ✕ hidden, still typing
  check('✕ shows while there is text', await page.$eval('.search-clear', e => !e.hidden));
  await page.click('[data-act=list-search]', { clickCount: 3 });
  await page.type('[data-act=list-search]', 'axis');
  await sleep(200);
  await shot('01b-clear-button');
  await page.tap('.search-clear');
  await sleep(300);
  const cleared = await page.evaluate(() => ({ v: document.querySelector('[data-act=list-search]').value,
    hidden: document.querySelector('.search-clear').hidden, focus: document.activeElement === document.querySelector('[data-act=list-search]'),
    count: document.querySelector('.ls-count').textContent }));
  check('one tap on ✕ clears the search', cleared.v === '' && (await visible()) === n && cleared.count === '', JSON.stringify(cleared));
  check('✕ hides itself and the cursor stays in the box', cleared.hidden && cleared.focus);

  // the reference lists search has the ✕ too
  await go('#/masters/stock?q=reliance');
  await page.waitForSelector('[data-act=master-search]', { timeout: 30000 });
  await sleep(600);
  const mBefore = await page.$$eval('#page .pick, #page .row-card, #page tr', l => l.length);
  await page.tap('.search-clear');
  await sleep(1200);
  const m = await page.evaluate(() => ({ v: document.querySelector('[data-act=master-search]').value, hidden: document.querySelector('.search-clear').hidden,
    q: location.hash, focus: document.activeElement === document.querySelector('[data-act=master-search]') }));
  check('reference lists: ✕ clears the search', m.v === '' && m.hidden && !/q=reliance/.test(m.q) && m.focus, JSON.stringify(m));
  await go('#/class/fixed_deposits');

  // the filter survives leaving and coming back, and a redraw
  await page.click('[data-act=list-search]', { clickCount: 3 });
  await page.type('[data-act=list-search]', 'axis');
  await go('#/home'); await go('#/class/fixed_deposits');
  check('search kept when coming back', (await page.$eval('[data-act=list-search]', e => e.value)) === 'axis' && (await visible()) === axis.length);
  // search box stays on screen while scrolling
  await page.click('[data-act=list-search]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await sleep(200);
  check('clearing shows everything again', (await visible()) === n);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(200);
  const sticky = await page.$eval('.list-search', e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom < innerHeight; });
  check('search box stays in view when scrolled', sticky);
  await shot('02-search-sticky');

  // drag the + button with a finger
  const cdp = await page.target().createCDPSession();
  const fab = await page.$eval('.fab', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fab.x, y: fab.y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fab.x + (60 - fab.x) * i / 10, y: fab.y + (420 - fab.y) * i / 10 }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  const moved = await page.$eval('.fab', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  check('dragging moves the + button', Math.abs(moved.x - 60) < 6 && Math.abs(moved.y - 420) < 6, JSON.stringify(moved));
  check('a drag does not open the form', !(await page.$('.modal')));
  await shot('03-fab-moved');

  // dragged past the edge: pulled back on screen, above the tab bar
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: moved.x, y: moved.y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: moved.x - 200 * i / 10, y: moved.y + 900 * i / 10 }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  const edge = await page.evaluate(() => {
    const r = document.querySelector('.fab').getBoundingClientRect();
    const t = document.getElementById('tabs').getBoundingClientRect();
    return { left: r.left, bottom: r.bottom, tabsTop: t.top };
  });
  check('kept on screen, above the tab bar', edge.left >= 8 && edge.bottom <= edge.tabsTop - 7, JSON.stringify(edge));

  // a tap still adds; the spot is kept on other pages and after a reload
  await sleep(400);
  await page.tap('.fab');
  await page.waitForSelector('.modal', { timeout: 5000 }).catch(() => {});
  check('tap still opens Add', !!(await page.$('.modal')));
  await page.keyboard.press('Escape'); await sleep(300);
  if (await page.$('.modal [data-act=close], .modal .close')) await page.click('.modal [data-act=close], .modal .close').catch(() => {});
  await sleep(300);
  await go('#/class/equity');
  const other = await page.$eval('.fab', e => Math.round(e.getBoundingClientRect().left));
  check('same spot on another page', Math.abs(other - edge.left) < 2, `${other}`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#top [data-act=update]', { timeout: 180000 });
  await go('#/class/fixed_deposits');
  await sleep(500);
  const after = await page.$eval('.fab', e => Math.round(e.getBoundingClientRect().left));
  check('spot kept after reload', Math.abs(after - edge.left) < 2, `${after}`);

  // turning the phone: still on screen
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(500);
  const land = await page.$eval('.fab', e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; });
  check('on screen after rotating', land);
  await shot('04-landscape');

  check('no page errors', errors.length === 0, errors.join(' || '));
  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
