// Page renderers: each returns an HTML string for #page. Interaction is by
// event delegation in app.js (data-act / data-set attributes).

import { S, icon } from './ui.js';
import { money, compact, pct, signedPct, signedMoney, num, price, rate, date, dateShort,
  tone, esc, isMasked, MASK } from './fmt.js';
import { donut, lines, columns, targetBars } from './charts.js';
import { COLLECTIONS, CLASS_PAGES, TAB_LABEL, FLAG_TEXT } from './fields.js';

const V = () => S.view;
const enc = encodeURIComponent;

export function classLabel(key) {
  const c = V().settings.classes.find(x => x.key === key);
  return c ? c.label : key;
}

function deltaHtml(v, p) {
  if (v == null) return '';
  return `<span class="delta ${tone(v)}">${signedMoney(v)}${p != null && !isMasked() ? ` · ${signedPct(p)}` : ''}</span>`;
}

function card(inner, extraClass = '') { return `<section class="card ${extraClass}">${inner}</section>`; }

function emptyState(text, action = '') {
  return `<div class="empty"><p>${text}</p>${action}</div>`;
}

function engineNote() {
  if (S.engineState === 'ready') return '';
  if (S.engineState === 'error') {
    return `<div class="banner error">The engine could not start: ${esc(S.engineError)}. <button class="link" data-act="reload">Reload</button></div>`;
  }
  return `<div class="banner info"><span class="spinner sm"></span> Getting the calculator ready… you can look around; changes open in a moment.</div>`;
}

function noticeBanners() {
  const v = V();
  const out = [];
  if (v.dashboard.hidden_notice.length) {
    out.push(`<div class="banner amber">Hidden, not counted: ${esc(v.dashboard.hidden_notice.join(' · '))} — <a href="#/settings">switch on in Settings</a> to include.</div>`);
  }
  for (const n of v.notices || []) out.push(`<div class="banner amber">${esc(n)} <button class="link" data-act="clear-notices">Dismiss</button></div>`);
  return out.join('');
}

// ---------------------------------------------------------------- dashboard --
export function dashboard() {
  const v = V();
  const d = v.dashboard;
  const last = v.meta.last_update;
  const stamps = v.meta.stamps;
  const xirr = d.portfolio_xirr;
  const allocRows = d.alloc.map((a) => `
    <tr data-act="go" data-href="#/class/${a.key}">
      <td><span class="sw" style="background:var(--series-${Math.min(d.alloc.indexOf(a), 7) + 1})"></span>${esc(a.label)}</td>
      <td class="r">${money(a.value)}</td>
      <td class="r ${tone(a.xirr)}">${a.has_xirr ? pct(a.xirr) : ''}</td>
      <td class="r">${pct(a.actual)}</td>
      <td class="r">${a.target != null ? pct(a.target, 0) : ''}</td>
      <td class="r ${a.on_target == null ? '' : a.on_target ? 'pos' : 'neg'}">${a.drift != null ? signedPct(a.drift) : ''}</td>
      <td class="hint-cell">${a.hint == null ? '' : a.hint === 'On target' ? 'On target' :
        (isMasked() ? MASK : `Move ${money(a.hint.move)} ${a.hint.dir}`)}</td>
    </tr>`).join('');
  const anyTarget = d.alloc.some(a => a.target != null);
  const people = d.matrix.map((m, i) => `
    <tr data-act="go" data-href="#/person/${enc(m.name)}">
      <td>${esc(m.name)}</td>${d.alloc.map(a => `<td class="r">${money(m.values[a.key])}</td>`).join('')}
      <td class="r strong">${money(m.total)}</td><td class="r muted">${money(m.expected)}</td></tr>`).join('');
  const hist = v.history;
  const histXs = hist.map(h => h.date);
  const shown = v.history_classes.filter(c => c.enabled);
  return `${engineNote()}${noticeBanners()}
  <section class="hero">
    <div class="hero-main">
      <div class="eyebrow">Family net worth</div>
      <div class="hero-num">${compact(d.net_worth)}</div>
      <div class="hero-sub">${money(d.net_worth)} · as on ${dateShort(v.meta.today)}</div>
    </div>
    <div class="hero-meta">${last ? `Last update ${date(last)}` : 'Not updated yet - tap Update (top right)'}${stamps.stock ? ` · prices ${esc(stamps.stock)}` : ''}</div>
  </section>
  <div class="tiles">
    <div class="tile"><div class="t-label">Portfolio XIRR</div><div class="t-val ${tone(xirr)}">${xirr == null ? '—' : pct(xirr)}</div>
      <div class="t-sub">your return a year</div></div>
    <div class="tile"><div class="t-label">Real return</div><div class="t-val ${tone(d.real_return)}">${d.real_return == null ? '—' : pct(d.real_return)}</div>
      <div class="t-sub">${d.verdict ? esc(d.verdict) : `after ${rate(d.inflation_pct)} inflation`}</div></div>
    <div class="tile"><div class="t-label">${esc(d.expected_label)}</div><div class="t-val">${d.expected_total == null ? '—' : compact(d.expected_total)}</div>
      <div class="t-sub">estimate at ${rate(d.expected_return_pct)} a year</div></div>
    ${d.dividends_fy != null ? `<div class="tile" data-act="go" data-href="#/class/equity/dividends"><div class="t-label">Dividends FY ${esc(v.meta.fy_now)}</div>
      <div class="t-val">${money(d.dividends_fy)}</div><div class="t-sub">estimated, this year</div></div>` : ''}
  </div>
  ${card(`<h3>Allocation by asset class</h3>
    ${d.alloc.length ? `<div class="split"><div>${donut(d.alloc.map(a => ({ label: a.label, value: a.value })), { centerLabel: 'Total', centerValue: compact(d.net_worth) })}</div>
    <div class="scroll-x"><table class="tbl">
      <thead><tr><th>Asset class</th><th class="r">Value</th><th class="r">XIRR</th><th class="r">Actual</th><th class="r">Target</th><th class="r">Drift</th><th>Rebalance hint</th></tr></thead>
      <tbody>${allocRows}</tbody></table>
      <p class="fine">Targets and the drift band (±${rate(v.settings.drift_tolerance_pct)} points) are set in <a href="#/settings">Settings</a>. Hints are indicative, pre-tax and class-level.</p></div></div>`
      : emptyState('No asset class is switched on - <a href="#/settings">choose what you own</a>.')}`)}
  ${anyTarget ? card(`<h3>Actual vs target</h3>${targetBars(d.alloc.map(a => ({ label: a.label, actual: a.actual, target: a.target })))}`) : ''}
  ${card(`<h3>Family</h3>${d.matrix.length ? `<div class="scroll-x"><table class="tbl">
      <thead><tr><th>Person</th>${d.alloc.map(a => `<th class="r">${esc(a.label)}</th>`).join('')}<th class="r">Total</th><th class="r">${esc(d.expected_label)}</th></tr></thead>
      <tbody>${people}</tbody>
      <tfoot><tr><td>TOTAL</td>${d.alloc.map(a => `<td class="r">${money(d.col_totals[a.key])}</td>`).join('')}<td class="r strong">${money(d.net_worth)}</td><td class="r muted">${money(d.expected_total)}</td></tr></tfoot>
    </table></div>
    ${d.matrix.length > 1 ? columns(d.matrix.map(m => ({ label: m.name, values: [m.total] })), [''], { height: 180 }) : ''}`
    : emptyState('No family members yet.', '<a class="btn" href="#/people">Add a person</a>')}`)}
  ${card(`<h3>Net worth over time</h3>${lines(histXs, [{ label: 'Net worth', values: hist.map(h => h.total) }], { area: true, xFmt: date })}
    <p class="fine">One snapshot per day, taken by Update.</p>`)}
  ${shown.length && hist.length ? card(`<h3>Net worth by class over time</h3>${lines(histXs,
    shown.map(c => ({ label: c.label, values: hist.map(h => h.values[c.key] || 0) })), { area: true, stacked: true, xFmt: date })}`) : ''}
  ${card(`<h3>Assumptions</h3><div class="form-row">
      <label class="fld"><span>Inflation % a year</span><input type="number" inputmode="decimal" step="0.1" data-set="inflation_pct" value="${d.inflation_pct}"></label>
      <label class="fld"><span>Expected return % a year</span><input type="number" inputmode="decimal" step="0.1" data-set="expected_return_pct" value="${d.expected_return_pct}"></label>
    </div><p class="fine">Inflation drives the real return and the projection. Expected return is used only for the FY-end estimate of shares, funds, gold and NPS; fixed income uses each row's own rate.</p>`)}`;
}

// ------------------------------------------------------------------ people --
export function people() {
  const v = V();
  const rows = v.people.map(p => `
    <a class="row-card" href="#/person/${enc(p.name)}">
      <div class="rc-main"><div class="rc-title">${esc(p.name)}</div>
      <div class="rc-sub">${p.count} holding${p.count === 1 ? '' : 's'}${p.dividends_fy ? ` · dividends ${money(p.dividends_fy)}` : ''}</div></div>
      <div class="rc-val">${money(p.total)}</div></a>`).join('');
  return `${engineNote()}<div class="page-head"><h1>People</h1>
    <button class="btn" data-act="person-add">+ Add person</button></div>
    ${v.people.length ? `<div class="list">${rows}</div>` : emptyState('Add the people whose money you track. Their names go in the Owner of each holding.')}
    <p class="fine">Up to 10 people. Rename, reorder or remove them in <a href="#/settings">Settings</a>.</p>`;
}

export function person(name) {
  const v = V();
  const p = v.people.find(x => x.name === name);
  if (!p) return emptyState('This person is not in the family list.', '<a class="btn" href="#/people">People</a>');
  const blocks = p.classes.filter(c => c.count).map(c => {
    const page = CLASS_PAGES[c.key];
    const coll = page.tabs[0];
    const def = COLLECTIONS[coll];
    let rows = v.sheets[coll].filter(r => (r.owner || '').toLowerCase() === name.toLowerCase());
    if (page.filter) rows = rows.filter(r => r.asset_class === page.filter);
    return `<h3 class="block-title"><a href="#/class/${c.key}?owner=${enc(name)}">${esc(c.label)}</a><span>${money(c.value)}</span></h3>
      <div class="list">${rows.map(r => rowCard(coll, def, r)).join('')}</div>`;
  }).join('');
  return `${engineNote()}<div class="page-head"><h1>${esc(name)}</h1></div>
    <section class="hero small"><div class="hero-main"><div class="eyebrow">Net worth</div><div class="hero-num">${compact(p.total)}</div>
      <div class="hero-sub">${money(p.total)}${p.dividends_fy != null ? ` · dividends FY ${esc(v.meta.fy_now)} ${money(p.dividends_fy)}` : ''}</div></div></section>
    ${card(`<h3>Allocation</h3><div class="split"><div>${donut(p.classes.map(c => ({ label: c.label, value: c.value })), { centerLabel: name, centerValue: compact(p.total) })}</div>
      <table class="tbl"><thead><tr><th>Asset class</th><th class="r">Value</th><th class="r"># holdings</th></tr></thead>
      <tbody>${p.classes.map(c => `<tr data-act="go" data-href="#/class/${c.key}?owner=${enc(name)}"><td>${esc(c.label)}</td><td class="r">${money(c.value)}</td><td class="r">${c.count}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="r strong">${money(p.total)}</td><td class="r">${p.count}</td></tr></tfoot></table></div>`)}
    ${blocks || emptyState(`Nothing recorded for ${esc(name)} yet.`)}`;
}

// ---------------------------------------------------------------- holdings --
export function holdings() {
  const v = V();
  const alloc = Object.fromEntries(v.dashboard.alloc.map(a => [a.key, a]));
  const tiles = v.settings.classes.filter(c => c.enabled).map(c => {
    const a = alloc[c.key] || {};
    return `<a class="class-tile" href="#/class/${c.key}"><div class="ct-label">${esc(c.label)}</div>
      <div class="ct-val">${money(a.value || 0)}</div>
      <div class="ct-sub">${a.has_xirr && a.xirr != null ? `<span class="${tone(a.xirr)}">XIRR ${pct(a.xirr)}</span>` : ''}${a.actual != null ? ` · ${pct(a.actual)} of total` : ''}</div></a>`;
  }).join('');
  const off = v.settings.classes.filter(c => !c.enabled);
  return `${engineNote()}<div class="page-head"><h1>Holdings</h1></div>
    <div class="class-grid">${tiles || emptyState('No asset class is switched on.')}</div>
    ${off.length ? `<p class="fine">Also available: ${off.map(c => esc(c.label) + (c.has_data ? ' (has rows, hidden)' : '')).join(' · ')} - switch them on in <a href="#/settings">Settings</a>.</p>` : ''}`;
}

export function rowFlags(r) {
  return (r.flags || []).filter(f => FLAG_TEXT[f]).map(f => `<span class="flag ${f === 'matured' || f === 'override' || f === 'unlisted' ? 'info' : 'amber'}">${esc(FLAG_TEXT[f])}</span>`).join('');
}

export function rowCard(coll, def, r) {
  const c = def.card(r);
  const extra = (c.extra || []).filter(Boolean).map(x => `<span>${x}</span>`).join('');
  return `<button class="row-card" data-act="edit" data-coll="${coll}" data-i="${r.i}">
    <div class="rc-main"><div class="rc-title">${esc(c.title || '—')}</div>
      <div class="rc-sub">${esc(c.sub || '')}</div>
      ${extra ? `<div class="rc-extra">${extra}</div>` : ''}${rowFlags(r)}</div>
    <div class="rc-right"><div class="rc-val ${c.tone || ''}">${c.value || ''}</div>${deltaHtml(c.delta, c.deltaPct)}</div></button>`;
}

function tabVisible(coll) {
  const v = V();
  if (coll === 'equity_sells') return v.settings.show_capital_gains || v.sheets.equity_sells.length;
  return true;      // corporate actions always: they explain why quantities change
}

export function classPage(key, tab, query) {
  const v = V();
  const page = CLASS_PAGES[key];
  if (!page) return emptyState('Unknown page.');
  const tabs = page.tabs.filter(tabVisible);
  const coll = tabs.includes(tab) ? tab : tabs[0];
  const def = COLLECTIONS[coll];
  const owner = query.get('owner') || S.ownerFilter || '';
  let rows = v.sheets[coll] || [];
  if (page.filter) rows = rows.filter(r => r.asset_class === page.filter);
  const ownerField = def.fields.some(f => f.k === 'owner');
  if (owner && ownerField) rows = rows.filter(r => (r.owner || '').toLowerCase() === owner.toLowerCase());
  const a = v.dashboard.alloc.find(x => x.key === key);
  const cls = v.settings.classes.find(c => c.key === key);
  const t = v.totals[coll] || {};
  const head = page.filter ? classLabel(key) : page.title;
  const summary = [];
  if (a) summary.push(`<div><span>Value</span><b>${money(a.value)}</b></div>`);
  if (t.invested) summary.push(`<div><span>Invested</span><b>${money(t.invested)}</b></div>`);
  if (t.net_chg != null && t.invested) summary.push(`<div><span>Gain</span><b class="${tone(t.net_chg)}">${signedMoney(t.net_chg)}</b></div>`);
  if (t.day_chg) summary.push(`<div><span>Today</span><b class="${tone(t.day_chg)}">${signedMoney(t.day_chg)}</b></div>`);
  if (a && a.has_xirr && a.xirr != null) summary.push(`<div><span>XIRR</span><b class="${tone(a.xirr)}">${pct(a.xirr)}</b></div>`);
  const chips = ownerField && v.meta.persons.length > 1 ? `<div class="chips">
      <button class="chip ${owner ? '' : 'on'}" data-act="owner" data-owner="">All</button>
      ${v.meta.persons.map(p => `<button class="chip ${owner.toLowerCase() === p.toLowerCase() ? 'on' : ''}" data-act="owner" data-owner="${esc(p)}">${esc(p)}</button>`).join('')}</div>` : '';
  const tabBar = tabs.length > 1 ? `<div class="tabs-inline" role="tablist">${tabs.map(tb =>
    `<a role="tab" class="${tb === coll ? 'on' : ''}" href="#/class/${key}/${tb}${owner ? `?owner=${enc(owner)}` : ''}">${esc(TAB_LABEL[tb] || COLLECTIONS[tb].title)}</a>`).join('')}</div>` : '';
  const cap = v.meta.capacity[coll];
  const total = (v.sheets[coll] || []).length;
  let body;
  if (coll === 'dividends') body = dividendsBody(rows);
  else body = rows.length ? `<div class="list">${rows.map(r => rowCard(coll, def, r)).join('')}</div>`
    : emptyState(`No ${def.singular}s ${owner ? `for ${esc(owner)} ` : ''}yet.`);
  const preset = page.filter ? { asset_class: page.filter } : {};
  if (owner) preset.owner = owner;
  return `${engineNote()}<div class="page-head"><h1>${esc(head)}</h1></div>
    ${cls && !cls.enabled ? `<div class="banner amber">${esc(cls.label)} is switched off - these rows are kept but not counted. <a href="#/settings">Settings</a></div>` : ''}
    ${summary.length ? `<div class="summary">${summary.join('')}</div>` : ''}
    ${tabBar}${chips}${offNote(coll)}<p class="hint">${esc(def.hint)}</p>${body}
    ${cap ? `<p class="fine">${total} of ${cap} rows used (the Excel sheet's limit).</p>` : ''}
    ${def.noAdd ? '' : `<button class="fab" data-act="add" data-coll="${coll}" data-preset="${esc(JSON.stringify(preset))}" aria-label="Add ${esc(def.singular)}">${icon('plus', 26)}</button>`}`;
}

// what the Settings "When you tap Update" switches mean for this tab
function offNote(coll) {
  const st = V().settings;
  if (coll === 'corporate_actions' && !st.apply_split_bonus)
    return `<div class="banner amber">Splits & bonuses are off: these rows are kept as a record and do not change any quantity. <a href="#/settings">Settings</a></div>`;
  if (coll === 'dividends' && !st.fetch_dividends)
    return `<div class="banner amber">Dividends are off: Update leaves this list as it is. <a href="#/settings">Settings</a></div>`;
  return '';
}

function dividendsBody(rows) {
  const v = V();
  const fy = v.meta.fy_now;
  const thisYear = rows.filter(r => r.fy === fy);
  const older = rows.filter(r => r.fy !== fy);
  const def = COLLECTIONS.dividends;
  const total = thisYear.reduce((s, r) => s + (r.c.amount || 0), 0);
  return `${card(`<h3>Dividends by month — FY ${esc(fy)}</h3>
      ${columns(v.dividends_by_month.map(m => ({ label: m.m, values: [m.v] })), [''], { height: 180 })}
      <p class="fine">Estimated ${money(total)} this year. Amounts are rate × your estimated holding on the ex-date; the exact credit is on your bank statement.</p>`)}
    ${thisYear.length ? `<div class="list">${thisYear.map(r => rowCard('dividends', def, r)).join('')}</div>` : emptyState('No dividends recorded this year yet - they appear after an update.')}
    ${older.length ? `<h3 class="block-title">Earlier years</h3><div class="list">${older.map(r => rowCard('dividends', def, r)).join('')}</div>` : ''}`;
}

// ----------------------------------------------------------------- reports --
export function reports() {
  const v = V();
  const items = [
    ['#/projection', 'Projection', '20-year corpus at your return vs inflation'],
    ['#/history', 'History', `${v.history.length} daily snapshot${v.history.length === 1 ? '' : 's'}`],
  ];
  if (v.settings.classes.find(c => c.key === 'equity' && c.enabled)) {
    items.push(['#/class/equity/dividends', 'Dividends', `FY ${v.meta.fy_now}: ${money(v.dashboard.dividends_fy || 0)}`]);
    items.push(['#/class/equity/by_scrip', 'By stock', 'Family exposure per stock, split by person']);
  }
  if (v.settings.show_capital_gains || v.sheets.equity_sells.length) {
    items.push(['#/capgains', 'Capital gains', 'STCG / LTCG per year, what is still tax-free']);
    items.push(['#/taxrules', 'Tax rules', 'The rates the capital-gains view uses']);
  } else {
    items.push(['#/settings', 'Capital gains report', 'Switch it on in Settings']);
  }
  return `${engineNote()}<div class="page-head"><h1>Reports</h1></div><div class="list">${items.map(([h, t, s]) =>
    `<a class="row-card" href="${h}"><div class="rc-main"><div class="rc-title">${esc(t)}</div><div class="rc-sub">${s}</div></div><div class="rc-right chev">›</div></a>`).join('')}</div>`;
}

export function projection() {
  const v = V();
  const p = v.projection;
  const d = v.dashboard;
  return `<div class="page-head"><h1>Projection — next 20 years</h1></div>
    <p class="hint">Today's total compounding at the portfolio XIRR (${d.portfolio_xirr == null ? 'not known yet' : pct(d.portfolio_xirr)}) against plain inflation (${rate(d.inflation_pct)}). Assumes a constant return and no new money. Change inflation on the <a href="#/home">Dashboard</a>.</p>
    ${card(lines(p.map(x => String(x.year)), [
      { label: 'At portfolio XIRR', values: p.map(x => x.at_xirr) },
      { label: 'Growing at inflation', values: p.map(x => x.at_inflation) },
      { label: "Real (today's money)", values: p.map(x => x.real) }]))}
    ${card(`<div class="scroll-x"><table class="tbl"><thead><tr><th>Year</th><th class="r">At portfolio XIRR</th><th class="r">At inflation</th><th class="r">Real (today's money)</th></tr></thead>
      <tbody>${p.map(x => `<tr><td>${x.year}</td><td class="r">${money(x.at_xirr)}</td><td class="r">${money(x.at_inflation)}</td><td class="r">${money(x.real)}</td></tr>`).join('')}</tbody></table></div>`)}`;
}

export function history() {
  const v = V();
  const h = v.history;
  const cls = v.history_classes;
  return `<div class="page-head"><h1>History</h1></div>
    <p class="hint">One snapshot per day, written by Update. Switched-off classes record 0 (not counted).</p>
    ${card(lines(h.map(x => x.date), [{ label: 'Net worth', values: h.map(x => x.total) }], { area: true, xFmt: date }))}
    ${h.length ? card(`<div class="scroll-x"><table class="tbl"><thead><tr><th>Date</th>${cls.map(c => `<th class="r">${esc(c.label)}</th>`).join('')}<th class="r">Total</th></tr></thead>
      <tbody>${h.slice().reverse().map(x => `<tr><td>${date(x.date)}</td>${cls.map(c => `<td class="r">${money(x.values[c.key])}</td>`).join('')}<td class="r strong">${money(x.total)}</td></tr>`).join('')}</tbody></table></div>`) : ''}`;
}

export function capitalGains() {
  const v = V();
  const cg = v.capital_gains;
  const head = `<div class="page-head"><h1>Capital gains</h1><a class="btn" href="#/class/equity/equity_sells">Sales</a></div>
    <p class="hint">Worked out from your recorded sales and fund transactions. Indicative only - for planning, not for filing. Losses net across your investments the way the law allows (Sec 70); carry-forward to later years is not modelled.</p>`;
  if (!cg) return head + emptyState('Nothing recorded yet - sales you add appear here.', '<a class="btn" href="#/class/equity/equity_sells">Record a sale</a>');
  const fyEnd = `31-03-${Number(cg.fy_now.split('-')[0]) + 1}`;
  const t = (x) => x == null ? '—' : money(x);
  return `${head}
    <section class="hero small"><div class="hero-main"><div class="eyebrow">LTCG still tax-free this year (sell before ${fyEnd})</div>
      <div class="hero-num">${cg.headroom_now == null ? '—' : money(cg.headroom_now)}</div></div></section>
    ${card(`<h3>By financial year</h3>${cg.summaries.length ? `<div class="scroll-x"><table class="tbl"><thead><tr>
      <th>FY</th><th class="r">STCG</th><th class="r">LTCG</th><th class="r">Allowance</th><th class="r">Used</th><th class="r">Still tax-free</th>
      <th class="r">Tax (STCG)</th><th class="r">Tax (LTCG)</th><th class="r">At your slab</th><th class="r">Non-equity funds</th><th class="r">Intraday</th><th class="r">Losses used vs LTCG</th></tr></thead>
      <tbody>${cg.summaries.map(s => `<tr><td>${esc(s.fy)}</td><td class="r ${tone(s.stcg)}">${money(s.stcg)}</td><td class="r ${tone(s.ltcg)}">${money(s.ltcg)}</td>
        <td class="r">${money(s.exemption)}</td><td class="r">${money(s.exemption_used)}</td><td class="r">${money(s.headroom)}</td>
        <td class="r">${t(s.tax_stcg)}</td><td class="r">${t(s.tax_ltcg)}</td><td class="r">${money(s.slab_gain)}</td><td class="r">${money(s.debt_gain)}</td>
        <td class="r">${money(s.spec_gain)}</td><td class="r">${s.st_setoff ? money(s.st_setoff) : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Nothing sold yet.</p>'}`)}
    ${card(`<h3>What you sold</h3>${cg.realised.length ? `<div class="scroll-x"><table class="tbl"><thead><tr><th>FY</th><th>Owner</th><th>What</th><th>Tax bucket</th>
      <th class="r">Qty</th><th>Bought</th><th>Sold</th><th class="r">Days</th><th>Term</th><th class="r">Proceeds</th><th class="r">Taxable cost</th><th class="r">Gain</th><th>Note</th></tr></thead>
      <tbody>${cg.realised.map(r => `<tr><td>${esc(r.fy)}</td><td>${esc(r.owner)}</td><td>${esc(r.name)}</td><td>${esc(r.bucket)}</td><td class="r">${num(r.qty)}</td>
        <td>${date(r.buy_date)}</td><td>${date(r.sell_date)}</td><td class="r">${r.held_days}</td><td>${esc(r.term)}</td><td class="r">${money(r.proceeds)}</td>
        <td class="r">${money(r.taxable_cost)}</td><td class="r ${tone(r.gain)}">${money(r.gain)}</td><td class="note">${esc(r.note)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No sales recorded yet.</p>'}`)}
    ${card(`<h3>What you still hold (if sold today)</h3>${cg.unrealised.length ? `<div class="scroll-x"><table class="tbl"><thead><tr><th>Owner</th><th>What</th><th>Tax bucket</th>
      <th class="r">Qty / units</th><th class="r">Value today</th><th class="r">Gain if sold</th><th>Term</th><th>Long-term on</th><th>Note</th></tr></thead>
      <tbody>${cg.unrealised.map(r => `<tr><td>${esc(r.owner)}</td><td>${esc(r.name)}</td><td>${esc(r.bucket)}</td><td class="r">${num(r.qty)}</td>
        <td class="r">${money(r.value_today)}</td><td class="r ${tone(r.gain_today)}">${money(r.gain_today)}</td><td>${esc(r.term)}</td><td>${date(r.lt_on)}</td><td class="note">${esc(r.note)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Nothing held.</p>'}`)}
    ${cg.warnings.length ? card(`<h3>Please check</h3><ul class="warn-list">${cg.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`) : ''}`;
}

export function taxRules() {
  const v = V();
  return `<div class="page-head"><h1>Tax rules</h1></div>
    <button class="fab" data-act="tax-add" aria-label="Add rule">${icon('plus', 26)}</button>
    <p class="hint">Ships filled in with the current law. When the government changes a rate or the allowance, edit the number here - or add a row from the date the change applies. Blank STCG % = taxed at your slab. Shipped rules come back if deleted, so edit them instead.</p>
    <div class="list">${v.tax_rules.map((t, i) => `<button class="row-card" data-act="tax-edit" data-i="${i}">
      <div class="rc-main"><div class="rc-title">${esc(t.asset)} · from ${date(t.effective_from)}</div>
      <div class="rc-sub">Long-term after ${t.lt_days} days · STCG ${t.stcg_pct == null ? 'at your slab' : rate(t.stcg_pct)} · LTCG ${t.ltcg_pct == null ? '—' : rate(t.ltcg_pct)} · tax-free ${money(t.ltcg_exempt)}/yr</div>
      ${t.notes ? `<div class="rc-extra"><span>${esc(t.notes)}</span></div>` : ''}${t.valid ? '' : '<span class="flag amber">Not used - check this row</span>'}</div></button>`).join('')}</div>`;
}

// --------------------------------------------------------------------- more --
export function more() {
  const v = V();
  const ref = v.settings.show_references;
  const items = [
    ['#/settings', 'Settings', 'People, what you own, targets, privacy'],
    ['#/data', 'Your data', 'Import / export Excel, statements, backups'],
    ['#/guide', 'Guide', 'How everything works, in plain words'],
  ];
  items.push(['#/class/equity/corporate_actions', 'Corporate actions', 'Splits, bonuses, mergers, demergers']);
  if (ref) {
    items.push(['#/importmap', 'Import: who owns what', 'Folio / account → person']);
    items.push(['#/masters', 'Reference lists', 'Stocks, funds, NPS schemes, banks']);
  }
  items.push(['#/about', 'About & install', 'Add to your home screen, offline use, privacy']);
  return `<div class="page-head"><h1>More</h1></div><div class="list">${items.map(([h, t, s]) =>
    `<a class="row-card" href="${h}"><div class="rc-main"><div class="rc-title">${esc(t)}</div><div class="rc-sub">${esc(s)}</div></div><div class="rc-right chev">›</div></a>`).join('')}</div>`;
}

// Settings row: unlock the Lock with the device's own screen lock
function passkeyRow() {
  const name = esc(S.passkeyName || 'device lock');
  if (!S.passkeyAvailable && !S.passkeyRec) {
    return `<div class="set-row"><span class="grow">Unlock with ${name}<small>Not available in this browser. On iPhone and iPad it needs iOS / iPadOS 18 or newer, with the app opened from its home-screen icon.</small></span></div>`;
  }
  return `<div class="set-row"><label class="switch"><input type="checkbox" data-act="passkey-toggle" ${S.passkeyRec ? 'checked' : ''}><span></span></label>
    <span class="grow">Unlock with ${name}<small>Open the locked app with this device's ${name}, PIN or pattern instead of typing the password. The password keeps working, and is still needed on other devices and for exported Excel files.</small></span></div>`;
}

export function settings() {
  const v = V();
  const st = v.settings;
  const tt = st.targets_total;
  const persons = v.meta.persons.map((p, i) => `<div class="set-row">
      <span class="grow">${esc(p)}</span>
      <button class="icon-btn" data-act="person-up" data-name="${esc(p)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon('up')}</button>
      <button class="icon-btn" data-act="person-rename" data-name="${esc(p)}" aria-label="Rename">${icon('edit')}</button>
      <button class="icon-btn" data-act="person-del" data-name="${esc(p)}" aria-label="Remove">${icon('trash')}</button></div>`).join('');
  const classes = st.classes.map(c => `<div class="set-row">
      <label class="switch"><input type="checkbox" data-act="class-toggle" data-key="${c.key}" ${c.enabled ? 'checked' : ''}><span></span></label>
      <span class="grow">${esc(c.label)}<small>${c.enabled ? '' : c.has_data ? 'Hidden - has rows (not counted)' : 'Hidden'}</small></span>
      <label class="target"><input type="number" inputmode="decimal" min="0" max="100" step="1" placeholder="—" data-target="${c.key}" value="${c.target ?? ''}"><span>%</span></label></div>`).join('');
  return `<div class="page-head"><h1>Settings</h1></div>
    ${card(`<h3>People</h3>${persons || '<p class="muted">No one yet.</p>'}
      <button class="btn" data-act="person-add">+ Add person</button>
      <p class="fine">Renaming a person renames them on every holding too.</p>`)}
    ${card(`<h3>What you own</h3><p class="hint">On shows the class and counts it everywhere. Off hides it and leaves it out of every total - its rows stay saved. Target % is optional: your target share of the family total.</p>
      <div class="set-head"><span></span><span class="grow">Asset class</span><span>Target</span></div>${classes}
      <div class="set-row"><span class="grow">Targets total</span><b class="${tt > 0 && Math.abs(tt - 100) > 1e-9 ? 'amber-text' : ''}">${num(tt, 2)}%</b></div>
      <div class="set-row"><span class="grow">Drift tolerance (± % points)<small>How far a class may drift from its target before it is flagged.</small></span>
        <input class="small-in" type="number" inputmode="decimal" step="0.5" data-set="drift_tolerance_pct" value="${st.drift_tolerance_pct}"></div>`)}
    ${card(`<h3>Extra views</h3>
      <div class="set-row"><label class="switch"><input type="checkbox" data-act="flag" data-key="show_capital_gains" ${st.show_capital_gains ? 'checked' : ''}><span></span></label>
        <span class="grow">Capital gains report<small>STCG & LTCG per year, what is still tax-free, and when a holding turns long-term. Adds Sales and Tax rules.</small></span></div>
      <div class="set-row"><label class="switch"><input type="checkbox" data-act="flag" data-key="show_references" ${st.show_references ? 'checked' : ''}><span></span></label>
        <span class="grow">Reference lists<small>The stock, fund, bank and pension name lists and the import map (under More).</small></span></div>`)}
    ${card(`<h3>When you tap Update</h3>
      <div class="set-row"><label class="switch"><input type="checkbox" data-act="flag" data-key="apply_split_bonus" ${st.apply_split_bonus ? 'checked' : ''}><span></span></label>
        <span class="grow">Splits & bonuses<small>On: enter shares as you bought them, and Update adds the split and bonus shares. Off: quantities are used exactly as entered - choose Off if your rows already include the split and bonus shares, the way your broker's breakdown lists them.</small></span></div>
      <div class="set-row"><label class="switch"><input type="checkbox" data-act="flag" data-key="fetch_dividends" ${st.fetch_dividends ? 'checked' : ''}><span></span></label>
        <span class="grow">Dividends<small>On: Update fills in this year's dividends from NSE and BSE. Off: the Dividends list is left as it is.</small></span></div>`)}
    ${card(`<h3>Privacy</h3>
      <div class="set-row"><label class="switch"><input type="checkbox" data-act="privacy-mask" ${st.privacy_enabled ? 'checked' : ''}><span></span></label>
        <span class="grow">Privacy mask<small>Numbers show as ••• until you type your password. A curtain against onlookers, not a safe. Exported Excel files are masked too.</small></span></div>
      <div class="set-row"><label class="switch"><input type="checkbox" data-act="privacy-lock" ${st.lock_enabled ? 'checked' : ''}><span></span></label>
        <span class="grow">Lock (encryption)<small>The app's data on this device and exported Excel files need the password to open. A forgotten password cannot be recovered - write it down somewhere safe.</small></span></div>
      ${st.lock_enabled ? passkeyRow() : ''}
      ${st.has_password ? `<div class="btn-row"><button class="btn" data-act="privacy-change">Change password</button>
        ${st.lock_enabled ? '' : '<button class="btn" data-act="privacy-reset">Forgot it? Reset the mask</button>'}</div>` : ''}`)}`;
}

export function data(info) {
  const v = V();
  const backups = (info.backups || []).map(b => `<div class="set-row"><span class="grow">${esc(new Date(b.ts).toLocaleString('en-IN'))}<small>${esc(b.reason)}</small></span>
      <button class="btn small" data-act="backup-restore" data-id="${b.id}">Restore</button></div>`).join('');
  return `<div class="page-head"><h1>Your data</h1></div>
    <p class="hint">Everything stays on this device - nothing is uploaded anywhere. Only public prices are downloaded when you update.</p>
    ${card(`<h3>Excel workbook</h3>
      <p>Bring in your <b>Family_Portfolio_Tracker.xlsx</b> (any NetWorth version), or save the app's data as that same workbook - it opens in Excel and works with the desktop <i>Update Portfolio</i> app.</p>
      <div class="btn-row"><label class="btn primary file-btn">Import Excel file<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-act="import-xlsx" hidden></label>
      <button class="btn" data-act="export">Export to Excel</button></div>
      ${v.settings.privacy_enabled ? '<p class="fine">The exported file is masked (•••) like the desktop app writes it. <button class="link" data-act="export-unmasked">Export once without the mask</button></p>' : ''}
      ${info.lastExport ? `<p class="fine">Last exported ${esc(new Date(info.lastExport).toLocaleString('en-IN'))}.</p>` : '<p class="fine">Tip: export now and then and keep the file safe (e.g. in Files / Drive) - it is your backup if this device is lost.</p>'}`)}
    ${card(`<h3>Import statements</h3>
      <p>Your CAMS/KFintech <b>fund statement (CAS PDF</b> - "Detailed", "Since inception") or your broker's <b>tradebook / holdings file</b> (CSV or Excel). Every fund is checked against the statement's own closing balance before anything is written.</p>
      <label class="btn primary file-btn">Choose statement files<input type="file" multiple accept=".pdf,.csv,.txt,.tsv,.xlsx,.xlsm" data-act="import-files" hidden></label>`)}
    ${card(`<h3>Backups on this device</h3><p class="hint">A copy is kept automatically before every update, import and restore (newest 10).</p>
      ${backups || '<p class="muted">No backups yet.</p>'}`)}
    ${card(`<h3>Start over</h3><div class="btn-row">
      <button class="btn" data-act="start" data-kind="sample">Load the sample family</button>
      <button class="btn" data-act="start" data-kind="empty">Start empty</button>
      <button class="btn danger" data-act="wipe">Erase everything on this device</button></div>`)}
    <p class="fine">Storage: ${info.persisted ? 'protected from automatic clean-up' : 'the browser may clear it if space runs low - add the app to your home screen and export regularly'}.</p>`;
}

export function masters(kind, q) {
  const m = S.masters;
  if (!m) return '<p class="muted">Loading…</p>';
  const kinds = { stock: 'Stocks', mf: 'Mutual funds', nps: 'NPS schemes', banks: 'Banks' };
  const k = kinds[kind] ? kind : 'stock';
  const rows = m[k];
  const needle = (q || '').toLowerCase();
  const hit = needle ? rows.filter(r => r.join(' ').toLowerCase().includes(needle)) : rows;
  const cols = { stock: [1, 0, 2, 3], mf: [1, 0, 2], nps: [1, 0, 2], banks: [0, 1] }[k];
  return `<div class="page-head"><h1>Reference lists</h1></div>
    <div class="tabs-inline">${Object.entries(kinds).map(([kk, l]) => `<a class="${kk === k ? 'on' : ''}" href="#/masters/${kk}">${l}</a>`).join('')}</div>
    <p class="hint">${rows.length.toLocaleString('en-IN')} entries${m.refreshed[k] ? ` · refreshed ${esc(m.refreshed[k])}` : ''}. Refreshed by Update; kept sorted by name.</p>
    <div class="search-box"><input class="search" type="search" placeholder="Search…" data-act="master-search" value="${esc(q || '')}">
      <button class="search-clear" data-act="search-clear" aria-label="Clear search" ${q ? '' : 'hidden'}>${icon('close', 18)}</button></div>
    <div class="list compact">${hit.slice(0, 200).map(r => `<div class="row-card static"><div class="rc-main"><div class="rc-title">${esc(r[cols[0]])}</div>
      <div class="rc-sub">${cols.slice(1).map(c => esc(r[c] || '')).filter(Boolean).join(' · ')}</div></div></div>`).join('')}</div>
    ${hit.length > 200 ? `<p class="fine">Showing 200 of ${hit.length.toLocaleString('en-IN')} - search to narrow.</p>` : ''}`;
}

export function importMap() {
  const v = V();
  const a = v.sheets.import_map;
  const f = v.sheets.imported_files;
  return `<div class="page-head"><h1>Import: who owns what</h1></div>
    <button class="fab" data-act="add" data-coll="import_map" data-preset="{}" aria-label="Add">${icon('plus', 26)}</button>
    <p class="hint">${esc(COLLECTIONS.import_map.hint)}</p>
    <div class="list">${a.map(r => rowCard('import_map', COLLECTIONS.import_map, r)).join('') || emptyState('Nothing imported yet.')}</div>
    <h3 class="block-title">Files already read</h3><p class="hint">${esc(COLLECTIONS.imported_files.hint)}</p>
    <div class="list">${f.map(r => rowCard('imported_files', COLLECTIONS.imported_files, r)).join('') || '<p class="muted">None.</p>'}</div>`;
}

export function guide() {
  const g = S.guide;
  if (!g) return '<p class="muted">Loading…</p>';
  const out = [];
  let open = false;
  const close = () => { if (open) { out.push('</section>'); open = false; } };
  for (const row of g) {
    const [kind, a, b] = row;
    if (kind === 'title') { out.push(`<div class="guide-title"><h1>${esc(a)}</h1><p>${esc(b)}</p></div>`); }
    else if (kind === 'section') { close(); out.push(`<section class="card guide-sec"><h3>${esc(a)} ${esc(b)}</h3>`); open = true; }
    else if (kind === 'legend') {
      out.push(`<p><span class="sw" style="background:#FFF2CC"></span> In Excel you type into the blue / yellow cells; in the app, tap any row to edit it.</p>
        <p><span class="sw" style="background:#F2F2F2"></span> Grey cells are worked out for you.</p>
        <p><b class="pos">Green</b> = gain · <b class="neg">Red</b> = loss · <b class="amber-text">Amber</b> = take a look</p>`);
    }
    else if (kind === 'step') out.push(`<p class="step"><span class="badge">${esc(a)}</span>${esc(b)}</p>`);
    else if (kind === 'kv') out.push(`<p><b>${esc(a)}</b> — ${esc(b)}</p>`);
    else if (kind === 'bullet') out.push(`<p class="bul">• ${esc(a)}</p>`);
    else if (kind === 'tip') out.push(`<p class="tip">Tip · ${esc(a)}</p>`);
    else if (kind === 'text') out.push(`<p>${esc(a)}</p>`);
    else if (kind === 'footer') { close(); out.push(`<p class="fine">${esc(a)}</p>`); }
  }
  close();
  return `<div class="guide">
    <section class="card"><h3>Using the app</h3>
      <p class="bul">• <b>Update</b> (top right, on every page) does what the desktop <i>Update Portfolio</i> does: fetches share prices, fund NAVs, NPS NAVs, the gold/silver rate, corporate actions and dividends, then recomputes every return. <i>More → Settings → When you tap Update</i> can leave out splits & bonuses or dividends. It needs internet; everything else works offline.</p>
      <p class="bul">• Where the Guide below says "tab" or "sheet", the app has a page: <i>Holdings</i> for the data lists, <i>Reports</i> for projection, history, dividends and capital gains, <i>More → Settings</i> for the Settings tab.</p>
      <p class="bul">• Where it says "type the first letters, press Enter, reopen the dropdown" - in the app just start typing; matching names appear as you type.</p>
      <p class="bul">• <i>More → Your data</i> imports your Excel file or statements and exports the workbook.</p></section>
    ${out.join('')}</div>`;
}

export function about(info) {
  const v = V();
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `<div class="page-head"><h1>About & install</h1></div>
    ${card(`<h3>Put it on your home screen</h3>
      ${standalone ? '<p>✓ Installed - it opens like an app and works offline.</p>' : isIos
        ? '<p>On iPhone / iPad (Safari): tap <b>Share</b> <span aria-hidden="true">⎙</span> → <b>Add to Home Screen</b>. It then opens full-screen and works offline.</p>'
        : (S.installPrompt ? '<button class="btn primary" data-act="install">Install the app</button>' : '<p>In Chrome: menu ⋮ → <b>Install app</b> / <b>Add to Home screen</b>.</p>')}
      <p class="fine">After the first visit, everything the app needs is stored on the device. Only <b>Update</b> needs internet.</p>`)}
    ${card(`<h3>Privacy</h3><p>Your portfolio lives only on this device (browser storage). It is never uploaded. Updating prices downloads public data only: AMFI fund NAVs, BSE/NSE prices and announcements, NPS Trust NAVs and the IBJA bullion rate - through this site's relay, without any of your data.</p>`)}
    ${card(`<h3>Version</h3><p>NetWorth web app · engine ${esc(v ? v.meta.app_version : '')} (the same calculation code as the desktop <i>Update Portfolio</i>) · ${esc(info.build || '')}</p>
      <p class="fine">Project home: <a href="https://github.com/jay-parikh/NetWorth" target="_blank" rel="noopener">github.com/jay-parikh/NetWorth</a></p>`)}`;
}

export function welcome(engineReady) {
  return `<div class="welcome">
    <div class="w-logo" aria-hidden="true">₹</div>
    <h1>NetWorth</h1>
    <p class="lead">Your family's whole net worth - shares, mutual funds, FDs, PPF, EPF, NPS, gold, bonds, property and more - with one-tap price updates and real returns (XIRR).</p>
    <p class="muted">Everything stays on this device. Works offline.</p>
    <div class="w-actions">
      <label class="btn primary big file-btn ${engineReady ? '' : 'disabled'}">Import my Excel file<input type="file" accept=".xlsx" data-act="import-xlsx" hidden ${engineReady ? '' : 'disabled'}></label>
      <button class="btn big" data-act="start" data-kind="sample" ${engineReady ? '' : 'disabled'}>Try it with a sample family</button>
      <button class="btn big ghost" data-act="start" data-kind="empty" ${engineReady ? '' : 'disabled'}>Start empty</button>
    </div>
    ${engineReady ? '' : '<p class="muted"><span class="spinner sm"></span> Getting ready (first time takes a little longer)…</p>'}
    ${S.engineState === 'error' ? `<p class="banner error">The engine could not start: ${esc(S.engineError)}</p>` : ''}
    <p class="fine">Already use the Excel tracker? Import your <b>Family_Portfolio_Tracker.xlsx</b> - every holding, setting and history comes across.</p>
  </div>`;
}

export function lockScreen(err) {
  const dev = S.passkeyRec ? `<button class="btn primary big" data-act="passkey-unlock">${icon('lock', 20)} Unlock with ${esc(S.passkeyName)}</button>
    <p class="muted or">or type your password</p>` : '<p>Type your password to open your data.</p>';
  return `<div class="welcome"><div class="w-logo" aria-hidden="true">🔒</div><h1>NetWorth is locked</h1>
    ${dev}
    <form data-act="unlock-form" class="unlock"><input type="password" name="pw" autocomplete="current-password" aria-label="Password" ${S.passkeyRec ? '' : 'autofocus'}>
      <button class="btn ${S.passkeyRec ? '' : 'primary'}">Unlock</button></form>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <p class="fine">Forgot it? There is no recovery for the Lock. <button class="link" data-act="wipe">Erase this device's copy</button> and import your Excel file again.</p></div>`;
}
