// NetWorth web app - controller: boot, routing, saving, actions.
import { Engine } from './engine.js';
import * as store from './store.js';
import * as passkey from './passkey.js';
import { S, toast, openSheet, confirmBox, alertBox, promptBox, busyLayer, icon } from './ui.js';
import * as P from './pages.js';
import { COLLECTIONS } from './fields.js';
import { setMasked, esc, todayIso, money, num, date, price, pct } from './fmt.js';
import { installTooltips } from './charts.js';

const BUILD = document.documentElement.dataset.build || 'dev';
const $page = () => document.getElementById('page');

// ------------------------------------------------------------- persistence --

async function persist(reason = '', backup = false) {
  if (backup) await store.addBackup(reason);
  const text = await S.engine.text('dump_json');
  await store.savePortfolio(text);
  S.hasData = true;
  refreshDataInfo().catch(() => {});
}

let lastDailyBackup = null;
async function dailyBackup() {
  const today = todayIso();
  if (lastDailyBackup === today) return;
  lastDailyBackup = today;
  const ts = await store.lastBackupTs();
  if (!ts || ts.slice(0, 10) !== today) await store.addBackup(`start of ${today}`);
}

async function refreshView() {
  S.view = await S.engine.call('get_view');
  applyMask();
  store.saveViewCache(S.view).catch(() => {});
  render();
}

async function loadMasters() {
  if (S.engineState !== 'ready' || !S.hasData) return;
  S.masters = await S.engine.call('get_masters');
}

function applyMask() {
  const st = S.view && S.view.settings;
  setMasked(!!(st && st.privacy_enabled && st.has_password && !S.revealed));
}

// -------------------------------------------------------------------- engine --

async function startEngine() {
  S.engineState = 'starting';
  S.engine = new Engine('worker.js');
  try {
    await S.engine.start(todayIso());
    S.engineState = 'ready';
  } catch (e) {
    S.engineState = 'error';
    S.engineError = e.message;
    render();
    return;
  }
  const saved = await store.loadPortfolio();
  if (saved) {
    try {
      await S.engine.call('load_json', saved);
      await S.engine.call('recompute');
      S.hasData = true;
      await refreshView();
      loadMasters().catch(() => {});
    } catch (e) {
      S.engineState = 'error';
      S.engineError = `your saved data could not be read (${e.message}) - restore a backup in More → Your data`;
    }
  }
  render();
}

function needEngine() {
  if (S.engineState === 'ready') return true;
  toast(S.engineState === 'error' ? 'The calculator could not start - reload the app.' : 'One moment - the calculator is still starting…');
  return false;
}

// -------------------------------------------------------------------- render --

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').map(decodeURIComponent), query: new URLSearchParams(qs || '') };
}

const NAV = [
  ['home', 'Home', 'home'], ['people', 'People', 'people'], ['holdings', 'Holdings', 'holdings'],
  ['reports', 'Reports', 'reports'], ['more', 'More', 'more'],
];

function navSection(parts) {
  const p = parts[0];
  if (p === 'person') return 'people';
  if (p === 'class') return 'holdings';
  if (['projection', 'history', 'capgains', 'taxrules'].includes(p)) return 'reports';
  if (['settings', 'data', 'guide', 'about', 'masters', 'importmap'].includes(p)) return 'more';
  return p;
}

function renderChrome(parts) {
  const sec = navSection(parts);
  const v = S.view;
  const links = NAV.map(([k, label, ic]) =>
    `<a href="#/${k}" class="${sec === k ? 'on' : ''}" aria-current="${sec === k ? 'page' : 'false'}"><span class="ni">${icon(ic)}</span><span>${label}</span></a>`).join('');
  document.getElementById('tabs').innerHTML = links;
  let side = `<div class="brand">₹ NetWorth</div><nav>${links}</nav>`;
  if (v) {
    const cls = v.settings.classes.filter(c => c.enabled);
    side += `<div class="side-sub"><div class="side-h">Holdings</div>${cls.map(c =>
      `<a href="#/class/${c.key}" class="${parts[0] === 'class' && parts[1] === c.key ? 'on' : ''}">${esc(c.label)}</a>`).join('')}</div>`;
  }
  document.getElementById('side').innerHTML = side;
  const masked = v && v.settings.privacy_enabled && v.settings.has_password;
  document.getElementById('top').innerHTML = `
    <button class="icon-btn back" data-act="back" aria-label="Back" ${parts[0] === 'home' ? 'hidden' : ''}>${icon('back')}</button>
    <div class="top-title">NetWorth</div>
    <div class="top-actions">
      ${masked ? `<button class="icon-btn" data-act="${S.revealed ? 'hide' : 'reveal'}" aria-label="${S.revealed ? 'Hide numbers' : 'Show numbers'}">${icon(S.revealed ? 'eyeoff' : 'eye')}</button>` : ''}
      ${v ? `<button class="btn small primary" data-act="update">${icon('refresh', 16)} Update</button>` : ''}
    </div>`;
}

function render() {
  const { parts, query } = parseRoute();
  const root = document.getElementById('app');
  if (S.lockedOut) {
    root.classList.add('bare');
    $page().innerHTML = P.lockScreen(S.unlockError);
    return;
  }
  if (!S.view) {
    root.classList.add('bare');
    $page().innerHTML = S.hasData && S.engineState !== 'error'
      ? '<div class="welcome"><span class="spinner"></span><p>Opening your portfolio…</p></div>'
      : P.welcome(S.engineState === 'ready');
    return;
  }
  root.classList.remove('bare');
  renderChrome(parts);
  let html;
  try {
    switch (parts[0]) {
      case 'people': html = P.people(); break;
      case 'person': html = P.person(parts[1]); break;
      case 'holdings': html = P.holdings(); break;
      case 'class': html = P.classPage(parts[1], parts[2], query); break;
      case 'reports': html = P.reports(); break;
      case 'projection': html = P.projection(); break;
      case 'history': html = P.history(); break;
      case 'capgains': html = P.capitalGains(); break;
      case 'taxrules': html = P.taxRules(); break;
      case 'more': html = P.more(); break;
      case 'settings': html = P.settings(); break;
      case 'data': html = P.data(S.dataInfo || {}); refreshDataInfo(); break;
      case 'masters':
        if (!S.masters) loadMasters().then(render);
        html = P.masters(parts[1], query.get('q')); break;
      case 'importmap': html = P.importMap(); break;
      case 'guide':
        if (!S.guide && S.engineState === 'ready') S.engine.call('get_guide').then(g => { S.guide = g; render(); });
        html = P.guide(); break;
      case 'about': html = P.about({ build: BUILD }); break;
      default: html = P.dashboard();
    }
  } catch (e) {
    console.error(e);
    html = `<div class="banner error">This page could not be shown: ${esc(e.message)}</div>`;
  }
  $page().innerHTML = html;
  addListSearch();
}

// -------------------------------------------------------------- list search --
// Any page whose lists hold more than SEARCH_MIN entries gets a search box
// above them; typing hides the entries that don't match (every word must
// appear; commas and ₹ are ignored, so "2500" finds "2,500"). The text is kept
// per page, so a redraw after an edit or an update keeps the filter.
const SEARCH_MIN = 8;
const listKey = () => location.hash.split('?')[0] || '#/home';
const norm = (s) => s.toLowerCase().replace(/[,₹]/g, '').replace(/\s+/g, ' ').trim();

function addListSearch() {
  const page = $page();
  if (page.querySelector('[data-act=master-search]')) return;    // has its own
  const cards = page.querySelectorAll('.list > .row-card');
  if (cards.length <= SEARCH_MIN) return;
  const top = document.getElementById('top');
  if (top) document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`);
  const box = document.createElement('div');
  box.className = 'list-search';
  const q = (S.listQ || {})[listKey()] || '';
  box.innerHTML = `<div class="search-box"><input class="search" type="search" enterkeyhint="search" data-act="list-search"
      placeholder="Search ${cards.length.toLocaleString('en-IN')} entries" aria-label="Search this list" value="${esc(q)}">
      ${clearButton(q)}</div>
    <span class="ls-count" aria-live="polite"></span>`;
  cards[0].closest('.list').before(box);
  if (q) applyListSearch(q);
}

// the ✕ inside a search box: one tap empties it (shown only when there is text)
function clearButton(q) {
  return `<button class="search-clear" data-act="search-clear" aria-label="Clear search" ${q ? '' : 'hidden'}>${icon('close', 18)}</button>`;
}

function applyListSearch(q) {
  const page = $page();
  const words = norm(q).split(' ').filter(Boolean);
  const cards = page.querySelectorAll('.list > .row-card');
  let shown = 0;
  cards.forEach((c) => {
    if (c._text === undefined) c._text = norm(c.textContent);
    const ok = words.every(w => c._text.includes(w));
    c.hidden = !ok;
    if (ok) shown++;
  });
  // a list (and its heading) with nothing left disappears
  page.querySelectorAll('.list').forEach((l) => {
    if (!l.querySelector(':scope > .row-card')) return;
    const empty = !l.querySelector(':scope > .row-card:not([hidden])');
    l.hidden = empty;
    const h = l.previousElementSibling;
    if (h && h.classList.contains('block-title')) h.hidden = empty;
  });
  const count = page.querySelector('.ls-count');
  if (count) {
    count.textContent = !words.length ? '' : shown ? `${shown} of ${cards.length}` : 'No matches';
    count.classList.toggle('none', !!words.length && !shown);
  }
}

// ------------------------------------------------------------- floating Add --
// The + button can be dragged anywhere (on some screens something else sits
// in the corner); a tap still adds. The spot is kept on the device as a share
// of the screen, so it survives rotation, and is always pulled back on screen.
const FAB_SIZE = 56;

function fabBounds() {
  const top = document.getElementById('top');
  const tabs = document.getElementById('tabs');
  const minY = (top ? top.getBoundingClientRect().bottom : 0) + 8;
  const tabsTop = tabs && getComputedStyle(tabs).display !== 'none' ? tabs.getBoundingClientRect().top : innerHeight;
  return { minX: 8, maxX: innerWidth - FAB_SIZE - 8, minY, maxY: tabsTop - FAB_SIZE - 8 };
}

function placeFab(pos) {
  const root = document.documentElement;
  if (!pos) { root.classList.remove('fab-placed'); return; }
  const b = fabBounds();
  const x = Math.min(b.maxX, Math.max(b.minX, pos.fx * innerWidth));
  const y = Math.min(b.maxY, Math.max(b.minY, pos.fy * innerHeight));
  root.style.setProperty('--fab-x', `${x}px`);
  root.style.setProperty('--fab-y', `${y}px`);
  root.classList.add('fab-placed');
}

let fabDrag = null;
document.addEventListener('pointerdown', (e) => {
  const f = e.target.closest('.fab');
  if (!f || e.button > 0) return;
  const r = f.getBoundingClientRect();
  fabDrag = { f, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: r.left, y: r.top, moved: false };
  f.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!fabDrag || e.pointerId !== fabDrag.id) return;
  const dx = e.clientX - fabDrag.sx, dy = e.clientY - fabDrag.sy;
  if (!fabDrag.moved && Math.hypot(dx, dy) < 8) return;     // still a tap
  fabDrag.moved = true;
  fabDrag.f.classList.add('dragging');
  S.fabPos = { fx: (fabDrag.x + dx) / innerWidth, fy: (fabDrag.y + dy) / innerHeight };
  placeFab(S.fabPos);
});
const fabDrop = (e, tap) => {
  if (!fabDrag || e.pointerId !== fabDrag.id) return;
  const { f, moved } = fabDrag;
  fabDrag = null;
  // the browser's own click is ignored either way: after a drag some
  // browsers send none, others send one; a tap is handled right here
  S.fabDropped = Date.now();
  if (moved) {
    f.classList.remove('dragging');
    store.setPref('fabPos', S.fabPos).catch(() => {});
  } else if (tap) {
    onAction(f, e).catch(err => toast(err.message, 'error'));
  }
};
document.addEventListener('pointerup', (e) => fabDrop(e, true));
document.addEventListener('pointercancel', (e) => fabDrop(e, false));
addEventListener('resize', () => { if (S.fabPos) placeFab(S.fabPos); });
store.getPref('fabPos', null).then((p) => { if (p) { S.fabPos = p; placeFab(p); } }).catch(() => {});

async function refreshDataInfo() {
  const info = {
    backups: await store.listBackups(),
    lastExport: await store.getPref('lastExport', null),
    persisted: navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false,
  };
  const changed = JSON.stringify(info) !== JSON.stringify(S.dataInfo);
  S.dataInfo = info;
  // redraw only when something changed and nothing is open on top
  if (changed && parseRoute().parts[0] === 'data' && !document.querySelector('.modal, .busy-layer')) {
    $page().innerHTML = P.data(info);
  }
}

// -------------------------------------------------------------------- edits --

async function mutate(op, { quiet = false } = {}) {
  if (!needEngine()) return false;
  await dailyBackup();
  const r = await S.engine.call('edit', JSON.stringify(op));
  if (!r.ok) { toast(r.error, 'error'); return false; }
  await persist();
  await refreshView();
  if (!quiet) toast('Saved');
  return true;
}

function parseNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function fieldInput(f, value, row) {
  const v = value ?? (row ? '' : (f.dflt ?? ''));
  const id = `f-${f.k}`;
  const help = f.help ? `<small class="help">${esc(f.help)}</small>` : '';
  const req = f.req ? ' <b class="req" aria-hidden="true">*</b>' : '';
  const lab = `<span>${esc(f.label)}${req}</span>`;
  const persons = S.view.meta.persons;
  switch (f.type) {
    case 'owner': {
      const opts = persons.slice();
      if (v && !opts.some(p => p.toLowerCase() === String(v).toLowerCase())) opts.push(v);
      return `<label class="fld" for="${id}">${lab}<select id="${id}" name="${f.k}">
        <option value="">—</option>${opts.map(p => `<option ${String(p) === String(v) ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>${help}</label>`;
    }
    case 'select':
      return `<label class="fld" for="${id}">${lab}<select id="${id}" name="${f.k}">${f.opts.map(o =>
        `<option value="${esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${esc(o || '(blank)')}</option>`).join('')}
        ${v && !f.opts.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select>${help}</label>`;
    case 'date':
      return `<label class="fld" for="${id}">${lab}<input id="${id}" type="date" name="${f.k}" value="${esc(v)}">${help}</label>`;
    case 'number': case 'money': case 'price': case 'rate':
      return `<label class="fld" for="${id}">${lab}<input id="${id}" type="text" inputmode="decimal" name="${f.k}" data-num="1" value="${v === '' || v === null ? '' : esc(v)}">${help}</label>`;
    case 'stock': case 'mf': case 'nps': case 'bank':
      return `<label class="fld picker" for="${id}">${lab}<input id="${id}" type="text" name="${f.k}" data-picker="${f.type}" value="${esc(v)}" autocomplete="off" spellcheck="false">
        <div class="pick-list" hidden></div><small class="pick-note"></small>${help}</label>`;
    case 'ppfacct': {
      const accts = [...new Set(S.view.sheets.ppf.map(p => p.account_no).filter(Boolean))];
      return `<label class="fld" for="${id}">${lab}<input id="${id}" type="text" name="${f.k}" list="${id}-dl" value="${esc(v)}">
        <datalist id="${id}-dl">${accts.map(a => `<option value="${esc(a)}">`).join('')}</datalist>${help}</label>`;
    }
    default:
      return `<label class="fld" for="${id}">${lab}<input id="${id}" type="text" name="${f.k}" value="${esc(v)}">${help}</label>`;
  }
}

// type-ahead over the reference lists: begins-with first, then contains
function searchMaster(kind, q) {
  const m = S.masters;
  if (!m) return [];
  const rows = kind === 'stock' ? m.stock : kind === 'mf' ? m.mf : kind === 'nps' ? m.nps : m.banks;
  const nameIdx = kind === 'bank' ? 0 : 1;
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const starts = [], has = [];
  for (const r of rows) {
    const name = String(r[nameIdx]).toLowerCase();
    const hay = (name + ' ' + (r[0] || '') + ' ' + (r[2] || '')).toLowerCase();
    if (name.startsWith(needle) || String(r[0]).toLowerCase() === needle) starts.push(r);
    else if (words.every(w => hay.includes(w))) has.push(r);
    if (starts.length >= 40) break;
  }
  return starts.concat(has).slice(0, 40);
}

function masterNote(kind, value) {
  const m = S.masters;
  if (!m || !value) return '';
  if (kind === 'stock') {
    const r = m.stock.find(x => x[1] === value);
    return r ? `ISIN ${r[2]}${r[0] ? ` · ${r[0]}` : ''}${r[3] && r[3] !== 'Active' ? ` · ${r[3]}` : ''}` : 'Not in the stock list - fill the ISIN under "More fields" if it is delisted or unlisted.';
  }
  if (kind === 'mf') {
    const r = m.mf.find(x => x[1] === value);
    return r ? `${r[0]} · ISIN ${r[2]}` : 'Not in the fund list - fill the ISIN under "More fields".';
  }
  if (kind === 'nps') {
    const r = m.nps.find(x => x[1] === value);
    return r ? `Scheme code ${r[0]} · ${r[2]}` : 'Not in the NPS list - fill the scheme code under "More fields".';
  }
  return '';
}

function wirePickers(el) {
  el.querySelectorAll('[data-picker]').forEach(inp => {
    const kind = inp.dataset.picker;
    const list = inp.parentElement.querySelector('.pick-list');
    const note = inp.parentElement.querySelector('.pick-note');
    const showNote = () => { note.textContent = masterNote(kind, inp.value); };
    showNote();
    inp.addEventListener('input', () => {
      if (!S.masters) { list.hidden = false; list.innerHTML = '<div class="pick-empty">Loading lists…</div>'; loadMasters().then(() => inp.dispatchEvent(new Event('input'))); return; }
      const hits = searchMaster(kind, inp.value);
      list.innerHTML = hits.map((r, i) => {
        const name = kind === 'bank' ? r[0] : r[1];
        const sub = kind === 'stock' ? [r[0], r[2], r[3] && r[3] !== 'Active' ? r[3] : ''].filter(Boolean).join(' · ')
          : kind === 'mf' ? r[0] : kind === 'nps' ? `${r[0]} · ${r[2]}` : r[1];
        return `<button type="button" class="pick" data-v="${esc(name)}" data-idx="${i}"><span>${esc(name)}</span><small>${esc(sub)}</small></button>`;
      }).join('') || (inp.value.trim() ? '<div class="pick-empty">No match - you can keep what you typed.</div>' : '');
      list.hidden = !list.innerHTML;
      showNote();
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.pick');
      if (!b) return;
      inp.value = b.dataset.v;
      list.hidden = true;
      showNote();
    });
    inp.addEventListener('blur', () => setTimeout(() => { list.hidden = true; showNote(); }, 200));
  });
}

function readForm(el, def) {
  const values = {};
  for (const f of def.fields) {
    const inp = el.querySelector(`[name="${f.k}"]`);
    if (!inp) continue;
    let v = inp.value;
    if (inp.dataset.num) {
      v = parseNum(v);
      if (Number.isNaN(v)) throw new Error(`${f.label}: "${inp.value}" is not a number`);
    } else if (f.type === 'date') {
      v = v || null;
    } else {
      v = (v || '').trim();
    }
    if (f.req && (v === null || v === '')) throw new Error(`Please fill ${f.label}.`);
    values[f.k] = v;
  }
  return values;
}

async function openEditor(coll, i, preset = {}) {
  if (!needEngine()) return;
  if (!S.masters) loadMasters().catch(() => {});
  const def = COLLECTIONS[coll];
  const isNew = i == null;
  const row = isNew ? null : S.view.sheets[coll].find(r => r.i === Number(i));
  const values = row || preset;
  const main = def.fields.filter(f => !f.adv).map(f => fieldInput(f, values[f.k], row)).join('');
  const adv = def.fields.filter(f => f.adv);
  const advHtml = adv.length ? `<details class="adv" ${adv.some(f => row && row[f.k]) ? 'open' : ''}><summary>More fields</summary>${adv.map(f => fieldInput(f, values[f.k], row)).join('')}</details>` : '';
  const ro = row && def.readonly ? def.readonly.filter(x => row[x.k] !== null && row[x.k] !== undefined && row[x.k] !== '')
    .map(x => `<div class="ro"><span>${esc(x.label)}</span><b>${x.fmt(row[x.k])}</b></div>`).join('') : '';
  const flags = row ? P.rowFlags(row) : '';
  const autoRow = row && (row.source === 'Auto' || row.source === 'Curated');
  const autoNote = autoRow ? `<p class="banner info">This row was filled in ${row.source === 'Auto' ? 'automatically by the update' : 'from the curated merger list'}. Saving a change turns it into your own (Manual) row, which the update keeps and which replaces the automatic one.</p>` : '';
  const actions = [];
  if (!isNew && coll !== 'history') actions.push({ label: 'Delete', kind: 'danger left', value: 'delete' });
  if (def.fields.length) actions.push({ label: 'Cancel', value: null }, { label: isNew ? 'Add' : 'Save', kind: 'primary', value: 'save' });
  else actions.push({ label: 'Close', value: null });
  const result = await openSheet({
    title: `${isNew ? 'Add' : 'Edit'} ${def.singular}`,
    wide: true,
    body: `<form class="editor" onsubmit="return false">${autoNote}${flags ? `<div class="flags">${flags}</div>` : ''}${main}${advHtml}${ro ? `<div class="ro-box">${ro}</div>` : ''}<p class="err" hidden></p></form>`,
    actions: actions.map(a => a.value === 'save' ? {
      ...a, handler: async (el, close) => {
        const err = el.querySelector('.err');
        let vals;
        try { vals = readForm(el, def); } catch (e) { err.hidden = false; err.textContent = e.message; return; }
        if (autoRow) vals.source = 'Manual';
        el.querySelectorAll('.modal-foot button').forEach(b => { b.disabled = true; });
        const ok = await mutate(isNew ? { op: 'add', coll, values: vals } : { op: 'set', coll, i: Number(i), values: vals });
        el.querySelectorAll('.modal-foot button').forEach(b => { b.disabled = false; });
        if (ok) close('saved');
      },
    } : a),
    onMount: (el) => wirePickers(el),
  });
  if (result === 'delete') {
    const title = def.card(row).title;
    if (await confirmBox('Delete?', `Delete <b>${esc(title)}</b>? A backup from today is kept on this device.`, 'Delete', true)) {
      await mutate({ op: 'delete', coll, i: Number(i) });
    }
  }
}

async function saveTaxRule(idx) {
  const t = idx == null ? null : S.view.tax_rules[Number(idx)];
  const def = {
    fields: [
      { k: 'asset', label: 'Asset', type: 'select', opts: ['equity', 'mf_equity', 'mf_debt', 'mf_other'], req: true },
      { k: 'effective_from', label: 'Applies from', type: 'date', req: true },
      { k: 'lt_days', label: 'Long-term after (days)', type: 'number', req: true },
      { k: 'stcg_pct', label: 'STCG % (blank = at your slab)', type: 'rate' },
      { k: 'ltcg_pct', label: 'LTCG %', type: 'rate' },
      { k: 'ltcg_exempt', label: 'Tax-free allowance ₹/yr', type: 'money' },
      { k: 'notes', label: 'Notes', type: 'text' },
    ],
  };
  const vals0 = t || { asset: 'equity', effective_from: todayIso(), lt_days: 365, ltcg_exempt: 0 };
  const res = await openSheet({
    title: t ? 'Edit tax rule' : 'Add tax rule', wide: true,
    body: `<form class="editor" onsubmit="return false">${def.fields.map(f => fieldInput(f, vals0[f.k], t || {})).join('')}
      <p class="fine">For each sale, the newest row on or before its sell date wins - that is how a mid-year change is handled.</p><p class="err" hidden></p></form>`,
    actions: [...(t ? [{ label: 'Delete', kind: 'danger left', value: 'delete' }] : []), { label: 'Cancel', value: null },
      { label: 'Save', kind: 'primary', handler: async (el, close) => {
        let vals;
        try { vals = readForm(el, def); } catch (e) { const er = el.querySelector('.err'); er.hidden = false; er.textContent = e.message; return; }
        if (vals.ltcg_exempt == null) vals.ltcg_exempt = 0;
        if (await mutate({ op: 'tax_rule', old: t ? [t.asset, t.effective_from] : null, values: vals })) close('saved');
      } }],
  });
  if (res === 'delete') {
    await mutate({ op: 'tax_rule', old: [t.asset, t.effective_from], values: null });
    toast('Removed. A rule that ships with the app comes back with its default values.');
  }
}

// ------------------------------------------------------------------- update --

async function detectProxy() {
  try {
    const r = await fetch('.netlify/functions/fetch?ping=1', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && j.relay === 'networth') return 'fn';
    }
  } catch (e) { /* offline or no function */ }
  return 'px';
}

const SUMMARY_ROWS = (s) => {
  const rows = [];
  if (s.price_source) rows.push(['📈', 'Prices', `${s.equity_matched}/${s.equity_total} stocks matched (${s.price_source}${s.nse_only_matched ? `, ${s.nse_only_matched} NSE-only` : ''}) · ${s.bonds_matched} bond(s) priced`]);
  if (s.mf_matched !== undefined) rows.push(['📊', 'Fund NAVs', `${s.mf_matched}/${s.mf_total} funds matched (AMFI)`]);
  if (s.bullion) rows.push(['🪙', 'Gold/Silver', s.bullion]);
  if (s.nps_matched !== undefined) rows.push(['🏛️', 'NPS NAVs', `${s.nps_matched}/${s.nps_total} scheme(s) matched (NPS Trust)`]);
  if (s.split_bonus_off) rows.push(['🔀', 'Splits & bonuses', 'off in Settings - quantities used as entered']);
  else if (s.ca_rows != null) rows.push(['🔀', 'Corporate actions', `${s.ca_rows} action(s) on file · ${s.ca_adjusted_rows} holding(s) adjusted · ${(s.ca_unverified || []).length ? `${s.ca_unverified.length} stock(s) UNVERIFIED` : 'all held stocks verified'}`]);
  if (s.curated_added) rows.push(['🆕', 'Merger list', `${s.curated_added} newly published merger/demerger event(s) picked up`]);
  if (s.restructure_children) rows.push(['🧬', 'Restructure', `${s.restructure_children} new holding row(s) from a demerger (cost & dates inherited)`]);
  if (s.dividends_off) rows.push(['💸', 'Dividends', 'off in Settings - not fetched']);
  else if (s.dividend_rows != null) rows.push(['💸', 'Dividends', `${money(s.dividends_fy_total || 0)} declared this financial year (${s.dividend_rows} row(s) refreshed)`]);
  if (s.fmv_filled) rows.push(['🕰️', 'FMV filled', `${s.fmv_filled} old row(s) got the 31-01-2018 grandfathering cost`]);
  if (s.suspended) rows.push(['⚠️', 'Suspended', `${s.suspended} held stock(s) not traded for 21+ days`]);
  if (s.ppf_ledgered) rows.push(['🏦', 'PPF', `${s.ppf_ledgered} account(s) computed from the deposit ledger (exact interest)`]);
  rows.push(['🎯', 'Return', s.portfolio_xirr != null ? `portfolio XIRR ${pct(s.portfolio_xirr, 2)} a year` : 'not enough dated cashflows yet']);
  if (s.fy_expected_total) rows.push(['🔮', 'FY-end estimate', `${money(s.fy_expected_total)} (family total)`]);
  const rep = s.import_report;
  if (rep) {
    const bits = [];
    if (rep.sip_added) bits.push(`${rep.sip_added} fund transaction(s) filled in`);
    if (rep.sip_replaced) bits.push(`${rep.sip_replaced} typed row(s) replaced by the statement's exact history`);
    if (rep.eq_added) bits.push(`${rep.eq_added} share lot(s) added`);
    if (rep.sells_added) bits.push(`${rep.sells_added} sale(s) recorded`);
    if (rep.eq_reduced) bits.push(`${rep.eq_reduced} holding(s) reduced by imported sales`);
    const skipped = (rep.sip_skipped || 0) + (rep.eq_skipped || 0);
    if (skipped) bits.push(`${skipped} already on your lists`);
    rows.push(['📥', 'Imported', bits.join(' · ') || 'nothing new - everything was already there']);
    for (const ln of [...(rep.funds || []), ...(rep.stocks || [])]) {
      rows.push([ln.ok ? '✓' : '✗', ln.scheme || ln.isin, ln.ok ? `${ln.added} added${ln.skipped ? `, ${ln.skipped} already there` : ''}${ln.replaced ? `, ${ln.replaced} replaced` : ''}${ln.reconciled ? ' · matches the statement ✓' : ''}` : ln.reason]);
    }
  }
  if (s.capgains) rows.push(['🧾', 'Capital gains', s.capgains]);
  return rows;
};

function summaryHtml(s) {
  const rows = SUMMARY_ROWS(s).map(([i, l, t]) => `<div class="sum-row ${i === '✗' ? 'bad' : ''}"><span class="sl">${i === '✓' || i === '✗' ? `${i} ` : ''}${esc(l)}</span><span class="st">${esc(t)}</span></div>`).join('');
  const warns = (s.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
  return `${s.net_worth != null ? `<div class="sum-hero">Family net worth: <b>${money(s.net_worth)}</b><small>${s.history_points || 0} day(s) of history</small></div>` : ''}
    <div class="sum-rows">${rows}</div>${warns ? `<h4>Please note</h4><ul class="warn-list">${warns}</ul>` : ''}`;
}

async function runUpdate() {
  if (!needEngine()) return;
  if (!navigator.onLine) {
    await alertBox('No internet', '<p>Updating prices needs an internet connection. Everything else works offline - try again when you are online.</p>');
    return;
  }
  const busy = busyLayer('Updating your portfolio');
  const off = S.engine.onLog(line => busy.line(line));
  try {
    await S.engine.setProxy(await detectProxy());
    await store.addBackup('before update');
    const r = await S.engine.call('run_update');
    off(); busy.close();
    if (!r.ok) { await alertBox('The update stopped', `<p>${esc(r.error)}</p><p class="fine">Nothing was changed.</p>`); return; }
    await persist();
    await refreshView();
    loadMasters().catch(() => {});
    await openSheet({ title: 'Update finished', wide: true, body: summaryHtml(r.summary), actions: [{ label: 'Done', kind: 'primary', value: true }] });
  } catch (e) {
    off(); busy.close();
    await alertBox('The update failed', `<p>${esc(e.message)}</p><p class="fine">Nothing was changed.</p>`);
  }
}

// ------------------------------------------------------------- excel in/out --

async function importXlsx(file) {
  if (!needEngine()) return;
  if (S.hasData && !(await confirmBox('Import this workbook?', `<b>${esc(file.name)}</b> replaces all the data in the app. Your current data is kept as a backup on this device.`, 'Import'))) return;
  const busy = busyLayer('Reading your workbook');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await S.engine.writeFile('/tmp/in/import.xlsx', bytes);
    let password = '';
    let r = await S.engine.call('import_xlsx', '/tmp/in/import.xlsx', '');
    while (!r.ok && r.needs_password) {
      busy.close();
      password = await promptBox({ title: 'This file is locked', text: r.error || 'Type the password the workbook was locked with.', label: 'Password', type: 'password' });
      if (password === null) return;
      document.body.appendChild(busy.el);
      busy.line('Unlocking…');
      r = await S.engine.call('import_xlsx', '/tmp/in/import.xlsx', password);
    }
    busy.close();
    if (!r.ok) { await alertBox('Could not import', `<p>${esc(r.error)}</p>`); return; }
    if (S.hasData) await store.addBackup('before Excel import');
    await persist('', false);
    if (r.privacy.lock && password) await store.setLock(password);
    S.revealed = !!password;
    await refreshView();
    loadMasters().catch(() => {});
    const c = r.counts;
    const bits = [['equity', 'share lots'], ['mutual_funds', 'funds'], ['sip', 'fund transactions'], ['fixed_deposits', 'FDs'], ['ppf', 'PPF accounts'],
      ['epf', 'EPF accounts'], ['bonds', 'bonds'], ['bullion', 'gold/silver items'], ['nps', 'NPS schemes'], ['manual_assets', 'other assets'], ['history', 'history days']]
      .filter(([k]) => c[k]).map(([k, l]) => `${c[k]} ${l}`);
    await alertBox('Workbook imported', `<p>People: <b>${esc(r.persons.join(', ') || '—')}</b></p><p>${bits.join(' · ') || 'No holdings yet.'}</p>
      ${r.warnings.length ? `<h4>Please note</h4><ul class="warn-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="fine">Tap <b>Update</b> to refresh prices.</p>`);
    location.hash = '#/home';
  } catch (e) {
    busy.close();
    await alertBox('Could not import', `<p>${esc(e.message)}</p>`);
  } finally {
    await S.engine.unlink('/tmp/in/import.xlsx').catch(() => {});
  }
}

async function exportXlsx(unmasked = false) {
  if (!needEngine()) return;
  const st = S.view.settings;
  if (unmasked && !S.revealed) {
    if (!(await askPrivacyPassword('Type your password to export without the mask.'))) return;
  }
  void st;
  const busy = busyLayer('Building your Excel workbook');
  try {
    let r = await S.engine.call('export_xlsx', '/tmp/out/export.xlsx', unmasked);
    if (!r.ok && r.needs_password) {
      // the Lock encrypts the file with your password - asked only when
      // this session doesn't already know it
      busy.close();
      if (!(await ensurePasswordInEngine())) return;
      busy.line('Encrypting…');
      document.body.appendChild(busy.el);
      r = await S.engine.call('export_xlsx', '/tmp/out/export.xlsx', unmasked);
    }
    if (!r.ok) { busy.close(); await alertBox('Could not export', `<p>${esc(r.error)}</p>`); return; }
    const bytes = await S.engine.readFile('/tmp/out/export.xlsx');
    busy.close();
    await deliverFile(bytes, 'Family_Portfolio_Tracker.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await store.setPref('lastExport', new Date().toISOString());
    refreshDataInfo();
  } catch (e) {
    busy.close();
    await alertBox('Could not export', `<p>${esc(e.message)}</p>`);
  }
}

async function deliverFile(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const file = new File([blob], name, { type });
  // iPhone/iPad: the share sheet offers "Save to Files", AirDrop, mail…
  // (everywhere else a normal download is simplest)
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${name}`);
}

// ------------------------------------------------------- statement import --

async function importStatements(files) {
  if (!needEngine()) return;
  if (!S.view.meta.persons.length) { await alertBox('Add a person first', '<p>Imports need to know whose folio or account each line belongs to. Add your family members in People first.</p>'); return; }
  const list = [];
  for (const [n, f] of [...files].entries()) {
    const path = `/tmp/imports/${n}-${f.name.replace(/[^\w.\-]/g, '_')}`;
    await S.engine.writeFile(path, new Uint8Array(await f.arrayBuffer()));
    list.push({ path, name: f.name, password: '' });
  }
  let res;
  for (;;) {
    const busy = busyLayer('Reading the files');
    try { res = await S.engine.call('parse_imports', JSON.stringify(list)); } finally { busy.close(); }
    const locked = res.files.filter(f => f.needs_password);
    if (!locked.length) break;
    let retry = false;
    for (const f of locked) {
      const pw = await promptBox({ title: 'Password-protected PDF', text: `${esc(f.name)}${f.error ? ` - ${esc(f.error)}` : ''}. Type the password you chose when you requested the statement (often your PAN).`, label: 'PDF password', type: 'password' });
      if (pw) { list.find(x => x.name === f.name).password = pw; retry = true; }
      else list.splice(list.findIndex(x => x.name === f.name), 1);
    }
    if (!retry || !list.length) { if (!list.length) return; }
    if (!retry) break;
  }
  const ok = res.files.filter(f => f.ok);
  const fileHtml = res.files.map(f => {
    if (!f.ok) return `<div class="imp-file bad"><b>${esc(f.name)}</b><p>✗ ${esc(f.error || 'could not be read')}</p></div>`;
    const funds = (f.funds || []).map(l => `<li class="${l.ok ? 'ok' : 'bad'}">${l.ok ? '✓' : '✗'} ${esc(l.name)} — ${l.ok
      ? `${l.txns} transaction(s), ${money(l.invested)} in, ${num(l.units)} units · ${l.checked ? 'matches the statement\'s closing balance ✓' : 'read ✓'}`
      : `left out: ${esc(l.reason)}`}</li>`).join('');
    const tr = f.trades.buys + f.trades.sells ? `<li>• ${f.trades.buys} buy(s) and ${f.trades.sells} sale(s) across ${f.trades.stocks} stock(s)</li>` : '';
    const ho = f.holdings.shares + f.holdings.funds ? `<li>• ${[f.holdings.shares ? `${f.holdings.shares} share holding(s)` : '', f.holdings.funds ? `${f.holdings.funds} fund holding(s)` : ''].filter(Boolean).join(' and ')} (cross-checked against your lists)</li>` : '';
    const w = (f.warnings || []).map(x => `<li class="warn">⚠ ${esc(x)}</li>`).join('');
    return `<div class="imp-file"><b>${esc(f.name)}</b>${f.already ? ' <span class="flag info">read before</span>' : ''}<ul>${funds}${tr}${ho}${w}</ul></div>`;
  }).join('');
  if (!ok.length) { await alertBox('Nothing to import', fileHtml); return; }
  const persons = res.persons;
  const acctHtml = res.accounts.map((a, i) => `<label class="fld"><span>Who owns ${esc(a.account)}${a.hint ? ` (${esc(a.hint)})` : ''}?</span>
    <select name="owner-${i}"><option value="">— leave out —</option>${persons.map(p => `<option ${p === a.owner ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>`).join('');
  const openHtml = res.openings.map((o, i) => `<label class="check"><input type="checkbox" name="open-${i}" checked>
    <span><b>${esc(o.name)}</b>: ${o.kind === 'uncovered_sell' ? `the file sells ${num(o.qty)} more than it buys` : `the broker has no buy price for these ${num(o.qty)} share(s)`}. Bought before Feb 2018 (old paper/demat holding)? Ticked = the official 2018 value stands in as the cost.</span></label>`).join('');
  const answers = await openSheet({
    title: 'Import these?', wide: true,
    body: `${fileHtml}
      ${acctHtml ? `<h4>Whose account is it?</h4>${acctHtml}` : ''}
      ${openHtml ? `<h4>Older shares</h4>${openHtml}` : ''}
      ${res.may_overflow ? `<label class="check"><input type="checkbox" name="condense" checked><span>Your fund ledger holds ${res.sip_used} lines and the statement adds ${res.sip_new} - more than the ${res.sip_cap} the Excel sheet can hold. If it doesn't all fit, may the oldest years be rolled into one opening line per fund? Totals and closing balances still match.</span></label>` : ''}
      <h4>How to write it</h4>
      <label class="check"><input type="radio" name="mode" value="replace" checked><span><b>Use the statement's history</b> - if a fund here is already typed on your lists, the statement's exact history replaces those rows.</span></label>
      <label class="check"><input type="radio" name="mode" value="append"><span><b>Only add new entries</b> - keep everything already typed.</span></label>
      <p class="fine">A backup is kept on this device first.</p>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Import', kind: 'primary', handler: (el, close) => {
        const owners = {};
        res.accounts.forEach((a, i) => { owners[a.account] = el.querySelector(`[name=owner-${i}]`).value; });
        const openings = res.openings.filter((o, i) => el.querySelector(`[name=open-${i}]`).checked);
        close({ owners, openings, mode: el.querySelector('[name=mode]:checked').value,
          condense: !!(el.querySelector('[name=condense]') || {}).checked });
      },
    }],
  });
  if (!answers) return;
  const busy = busyLayer('Importing');
  const off = S.engine.onLog(l => busy.line(l));
  try {
    await store.addBackup('before statement import');
    const r = await S.engine.call('commit_imports', JSON.stringify({ ...answers, online: false }));
    off(); busy.close();
    if (!r.ok) { await alertBox('The import stopped', `<p>${esc(r.error)}</p><p class="fine">Nothing was changed.</p>`); return; }
    await persist();
    await refreshView();
    await openSheet({ title: 'Import finished', wide: true, body: summaryHtml(r.summary) + '<p class="fine">Tap <b>Update</b> to refresh prices for what came in.</p>', actions: [{ label: 'Done', kind: 'primary', value: true }] });
  } catch (e) {
    off(); busy.close();
    await alertBox('The import failed', `<p>${esc(e.message)}</p>`);
  } finally {
    for (const f of list) S.engine.unlink(f.path).catch(() => {});
  }
}

// ------------------------------------------------------------------ privacy --

async function askPrivacyPassword(text = 'Type your password to show the numbers.') {
  const pw = await promptBox({
    title: 'Password', text, label: 'Password', type: 'password',
    validate: async (v) => ((await S.engine.call('privacy_verify', v)).ok ? '' : 'That password doesn\'t match.'),
  });
  if (pw === null) return false;
  S.revealed = true;
  applyMask();
  render();
  return true;
}

async function ensurePasswordInEngine() {
  return askPrivacyPassword('Type your password - it is needed to lock the exported file.');
}

async function setNewPassword(forLock) {
  return promptBox({
    title: 'Choose a password', twice: true, type: 'password', label: 'Password',
    text: forLock ? '<b>There is no way to recover a forgotten Lock password.</b> Write it down somewhere safe. The same password opens exported Excel files.'
      : 'Numbers will show as ••• until this password is typed. The same password works in the desktop app.',
    validate: async (v) => (v.length < 4 ? 'Use at least 4 characters.' : ''),
  });
}

async function togglePrivacy(kind, on) {
  if (!needEngine()) return render();
  const st = S.view.settings;
  let mask = st.privacy_enabled, lock = st.lock_enabled;
  if (kind === 'mask') mask = on; else lock = on;
  let lockPw = null;
  if ((mask || lock) && !st.has_password) {
    const pw = await setNewPassword(lock);
    if (!pw) return render();
    await S.engine.call('privacy_set_password', pw);
    S.revealed = true;
    lockPw = pw;
  } else if (lock && !st.lock_enabled) {
    const pw = await promptBox({ title: 'Confirm your password', text: 'Type your password to turn the Lock on. <b>There is no recovery if it is forgotten.</b>', type: 'password', label: 'Password',
      validate: async (v) => ((await S.engine.call('privacy_verify', v)).ok ? '' : 'That password doesn\'t match.') });
    if (!pw) return render();
    lockPw = pw;
  }
  const r = await S.engine.call('privacy_set', mask, lock);
  if (!r.ok) { toast(r.error, 'error'); return render(); }
  // the at-rest lock of THIS device's storage follows the switch
  if (lock && !st.lock_enabled) {
    await store.setLock(lockPw);
  } else if (!lock && st.lock_enabled) {
    await store.setLock(null);
    await passkey.disable();             // nothing left to unlock
    S.passkeyRec = null;
  }
  await persist();
  await refreshView();
  toast(kind === 'mask' ? (mask ? 'Privacy mask on' : 'Privacy mask off') : (lock ? 'Locked - your password is needed to open the app' : 'Lock off'));
}

// ------------------------------------------------------------------ backups --

async function restoreBackup(id) {
  if (!needEngine()) return;
  if (!(await confirmBox('Restore this backup?', 'The app goes back to this copy. Your current data is backed up first.', 'Restore'))) return;
  const payload = await store.backupPayload(Number(id));
  if (!payload) { toast('That backup could not be read.', 'error'); return; }
  await store.addBackup('before restore');
  await S.engine.call('load_json', payload);
  await S.engine.call('recompute');
  await persist();
  await refreshView();
  toast('Restored');
}

async function startOver(kind) {
  if (!needEngine()) return;
  if (S.hasData && !(await confirmBox(kind === 'sample' ? 'Load the sample family?' : 'Start empty?',
    'This replaces the data in the app. Your current data is kept as a backup on this device.', 'Continue'))) return;
  if (S.hasData) await store.addBackup(`before ${kind === 'sample' ? 'loading the sample' : 'starting empty'}`);
  await S.engine.call('new_portfolio', kind);
  await persist();
  S.revealed = false;
  await refreshView();
  loadMasters().catch(() => {});
  location.hash = kind === 'empty' ? '#/people' : '#/home';
  if (kind === 'empty') toast('Add your family members, then your holdings.');
}

async function wipe() {
  if (!(await confirmBox('Erase everything?', 'This deletes the app\'s data and every backup <b>on this device</b>. Export your Excel file first if you want to keep it.', 'Erase', true))) return;
  await store.wipeAll();
  location.hash = '';
  location.reload();
}

// ------------------------------------------------------------------ events --

async function onAction(el, e) {
  const act = el.dataset.act;
  switch (act) {
    case 'go': location.hash = el.dataset.href.replace(/^#/, ''); break;
    case 'back': history.length > 1 ? history.back() : (location.hash = '#/home'); break;
    case 'reload': location.reload(); break;
    case 'update': runUpdate(); break;
    case 'reveal': if (needEngine()) askPrivacyPassword(); break;
    case 'hide': S.revealed = false; S.engine && S.engine.call('privacy_forget'); applyMask(); render(); break;
    case 'add': openEditor(el.dataset.coll, null, JSON.parse(el.dataset.preset || '{}')); break;
    case 'edit': openEditor(el.dataset.coll, el.dataset.i); break;
    case 'tax-add': saveTaxRule(null); break;
    case 'tax-edit': saveTaxRule(el.dataset.i); break;
    case 'owner': {
      S.ownerFilter = el.dataset.owner;
      const { parts } = parseRoute();
      location.hash = `#/${parts.join('/')}${S.ownerFilter ? `?owner=${encodeURIComponent(S.ownerFilter)}` : ''}`;
      break;
    }
    case 'person-add': {
      if (!needEngine()) break;
      const name = await promptBox({ title: 'Add a person', label: 'Name', text: 'Use the same name in the Owner of their holdings.' });
      if (name) await mutate({ op: 'person_add', name });
      break;
    }
    case 'person-rename': {
      const old = el.dataset.name;
      const name = await promptBox({ title: `Rename ${old}`, label: 'New name', value: old });
      if (name && name !== old) await mutate({ op: 'person_rename', old, new: name });
      break;
    }
    case 'person-del': {
      const name = el.dataset.name;
      if (await confirmBox(`Remove ${name}?`, `${esc(name)} leaves the family list. Their holdings stay saved but are counted for no one until you add them back or change the Owner.`, 'Remove', true)) {
        await mutate({ op: 'person_delete', name });
      }
      break;
    }
    case 'person-up': {
      const name = el.dataset.name;
      const i = S.view.meta.persons.indexOf(name);
      if (i > 0) await mutate({ op: 'person_move', name, to: i - 1 }, { quiet: true });
      break;
    }
    case 'export': exportXlsx(false); break;
    case 'export-unmasked': exportXlsx(true); break;
    case 'backup-restore': restoreBackup(el.dataset.id); break;
    case 'start': startOver(el.dataset.kind); break;
    case 'wipe': wipe(); break;
    case 'passkey-unlock': unlockWithDevice(); break;
    case 'search-clear': {
      const inp = el.closest('.search-box').querySelector('input');
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));   // same path as typing
      inp.focus();
      break;
    }
    case 'clear-notices': await S.engine.call('clear_notices'); await refreshView(); break;
    case 'privacy-change': {
      if (!needEngine()) break;          // the password check needs the calculator
      if (!S.revealed && !(await askPrivacyPassword('Type your current password first.'))) break;
      const pw = await setNewPassword(S.view.settings.lock_enabled);
      if (!pw) break;
      await S.engine.call('privacy_set_password', pw);
      if (S.view.settings.lock_enabled) { await store.setLock(pw); await resealPasskey(pw); }
      await persist(); await refreshView(); toast('Password changed');
      break;
    }
    case 'privacy-reset': {
      if (await confirmBox('Reset the privacy mask?', 'The mask is switched off and the password forgotten. Your data is not touched.', 'Reset')) {
        const r = await S.engine.call('privacy_reset');
        if (!r.ok) toast(r.error, 'error'); else { await persist(); await refreshView(); toast('Mask reset'); }
      }
      break;
    }
    case 'install':
      if (S.installPrompt) { S.installPrompt.prompt(); S.installPrompt = null; }
      break;
    default: return false;
  }
  return true;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'FORM') return;
  if (el.closest('.modal')) return;
  if (el.classList.contains('fab') && Date.now() - (S.fabDropped || 0) < 600) { e.preventDefault(); return; }
  e.preventDefault();
  onAction(el, e).catch(err => toast(err.message, 'error'));
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  try {
    if (el.dataset.act === 'import-xlsx' && el.files.length) { const f = el.files[0]; el.value = ''; await importXlsx(f); return; }
    if (el.dataset.act === 'import-files' && el.files.length) { const fs = [...el.files]; el.value = ''; await importStatements(fs); return; }
    if (el.closest('.modal')) return;
    if (el.dataset.act === 'class-toggle') { await mutate({ op: 'class', key: el.dataset.key, enabled: el.checked }, { quiet: true }); return; }
    if (el.dataset.act === 'flag') { await mutate({ op: 'settings', values: { [el.dataset.key]: el.checked } }, { quiet: true }); return; }
    if (el.dataset.act === 'privacy-mask') { await togglePrivacy('mask', el.checked); return; }
    if (el.dataset.act === 'privacy-lock') { await togglePrivacy('lock', el.checked); return; }
    if (el.dataset.act === 'passkey-toggle') { await togglePasskey(el.checked); return; }
    if (el.dataset.target) {
      const v = parseNum(el.value);
      if (Number.isNaN(v)) { toast('Type a number', 'error'); return; }
      await mutate({ op: 'class', key: el.dataset.target, target: v }, { quiet: true });
      return;
    }
    if (el.dataset.set) {
      const v = parseNum(el.value);
      if (v === null || Number.isNaN(v)) { toast('Type a number', 'error'); render(); return; }
      await mutate({ op: 'settings', values: { [el.dataset.set]: v } }, { quiet: true });
    }
  } catch (err) { toast(err.message, 'error'); }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const clear = el.closest('.search-box') && el.closest('.search-box').querySelector('.search-clear');
  if (clear) clear.hidden = !el.value;
  if (el.dataset.act === 'list-search') {
    (S.listQ = S.listQ || {})[listKey()] = el.value;
    applyListSearch(el.value);
    return;
  }
  if (el.dataset.act === 'master-search') {
    clearTimeout(S.searchT);
    S.searchT = setTimeout(() => {
      const { parts } = parseRoute();
      history.replaceState(null, '', `#/masters/${parts[1] || 'stock'}?q=${encodeURIComponent(el.value)}`);
      const pos = el.selectionStart;
      render();
      const n = document.querySelector('[data-act=master-search]');
      if (n) { n.focus(); n.setSelectionRange(pos, pos); }
    }, 250);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.dataset.act !== 'unlock-form') return;
  e.preventDefault();
  const pw = form.querySelector('[name=pw]').value;
  if (!(await openWith(pw))) {
    S.unlockError = 'That password doesn\'t open it.';
    render();
  }
});

// Open the locked app with the Lock password (typed, or from the device lock).
async function openWith(pw) {
  if (!(await store.unlock(pw))) return false;
  S.lockedOut = false;
  S.unlockError = '';
  S.view = await store.loadViewCache();
  S.hasData = !!(await store.loadPortfolio());
  if (S.view) applyMask();
  render();
  startEngine().then(async () => {
    if (S.engineState === 'ready' && S.hasData) {
      await S.engine.call('privacy_verify', pw);
    }
  });
  return true;
}

// "Unlock with Face ID": the passkey record is already in memory, so the
// Face ID request is the first thing this tap does (iPhone/iPad insist).
async function unlockWithDevice() {
  const rec = S.passkeyRec;
  if (!rec) return;
  try {
    const pw = await passkey.openPassword(rec, await passkey.secret(rec));
    if (!(await openWith(pw))) {
      S.unlockError = 'The saved password no longer opens it - type your password, then turn the device unlock on again in Settings.';
      render();
    }
  } catch (e) {
    if (e.kind === 'cancelled') return;
    S.unlockError = e.message;
    render();
  }
}

// Settings switch "Unlock with Face ID / fingerprint" (needs the Lock).
async function togglePasskey(on) {
  if (!on) {
    await passkey.disable();
    S.passkeyRec = null;
    toast(`${passkey.lockName()} unlock off - use your password`);
    return render();
  }
  if (!needEngine() || !S.view.settings.lock_enabled) { toast('Turn the Lock on first', 'error'); return render(); }
  const pw = await promptBox({
    title: 'Confirm your password', type: 'password', label: 'Password', okLabel: 'Continue',
    text: `Type your Lock password once. After that, ${esc(passkey.lockName())} opens the app on this device; the password keeps working too.`,
    validate: async (v) => ((await S.engine.call('privacy_verify', v)).ok ? '' : 'That password doesn\'t match.'),
  });
  if (pw === null) return render();
  if (!(await confirmBox(`Set up ${passkey.lockName()}`, `Your phone will now ask to save a <b>passkey</b> for NetWorth and check your ${esc(passkey.lockName())}.`, 'Continue'))) return render();
  try {
    const made = await passkey.create();
    let sec = made.secret;
    if (!sec) {
      // iPhone/iPad hand out the secret only when the passkey is used: one more tap
      if (!(await confirmBox('One more step', `Tap Confirm and use ${esc(passkey.lockName())} once more to finish.`, 'Confirm'))) return render();
      sec = await passkey.secret(made);
    }
    S.passkeyRec = await passkey.sealPassword(made, sec, pw);
    toast(`${passkey.lockName()} unlock on`);
  } catch (e) {
    if (e.kind !== 'cancelled') await alertBox('Could not turn it on', `<p>${esc(e.message)}</p>`);
  }
  render();
}

// After a password change the sealed copy must be the new password.
async function resealPasskey(pw) {
  if (!S.passkeyRec) return;
  const keep = await confirmBox(`Keep ${passkey.lockName()} unlock?`, `Confirm with ${esc(passkey.lockName())} so it opens the app with your new password.`, 'Confirm');
  try {
    if (!keep) throw new Error('declined');
    const rec = S.passkeyRec;
    S.passkeyRec = await passkey.sealPassword(rec, await passkey.secret(rec), pw);
  } catch (e) {
    await passkey.disable();
    S.passkeyRec = null;
    toast(`${passkey.lockName()} unlock turned off - turn it on again in Settings`, 'error');
  }
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
// charts are drawn at the on-screen width: redraw after a rotation/resize
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  clearTimeout(S.resizeT);
  S.resizeT = setTimeout(() => {
    if (Math.abs(window.innerWidth - lastW) < 40 || document.querySelector('.modal')) return;
    lastW = window.innerWidth;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }, 250);
});
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; });

// ---------------------------------------------------------------------- boot --

async function boot() {
  installTooltips(document);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  store.persistStorage();
  S.passkeyRec = await passkey.load();
  S.passkeyName = passkey.lockName();
  passkey.available().then((ok) => { S.passkeyAvailable = ok; });
  const lock = await store.lockInfo();
  if (lock) {
    S.lockedOut = true;
    render();
    return;
  }
  S.view = await store.loadViewCache();
  S.hasData = !!(await store.loadPortfolio());
  if (S.view && S.view.meta && S.view.meta.today !== todayIso()) {
    // yesterday's screen is fine to show while the engine recomputes today's
  }
  applyMask();
  await refreshDataInfo().catch(() => {});
  render();
  startEngine();
}

boot().catch(e => {
  console.error(e);
  $page().innerHTML = `<div class="banner error">The app could not start: ${esc(e.message)}</div>`;
});

export { S, date, price };
