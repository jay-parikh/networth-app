// Small SVG charts - no libraries, so they work offline and stay light.
// Colours come from CSS custom properties (--series-1..8, --grid, --axis,
// --ink-*), defined for light and dark in app.css (validated palette).
// Every chart gets a hover/tap tooltip; >= 2 series always get a legend.

import { esc, compact, money, pct, isMasked } from './fmt.js';

const SERIES = 8;

// Charts are drawn at the width they will be shown at, so text stays at its
// real size (a fixed viewBox scaled down to a phone makes axis labels tiny).
export function chartWidth() {
  const page = document.getElementById('page');
  const w = page ? page.clientWidth - 32 - 34 : 600;
  return Math.max(260, Math.min(Math.round(w), 1000));
}
export const seriesVar = (i) => `var(--series-${(i % SERIES) + 1})`;

// More categories than the palette has slots fold into "Other" (never a
// generated 9th hue).
export function foldOther(items, max = SERIES) {
  if (items.length <= max) return items;
  const head = items.slice(0, max - 1);
  const rest = items.slice(max - 1);
  return [...head, { label: 'Other', value: rest.reduce((s, x) => s + x.value, 0), other: true }];
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function axisLabel(v) {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(a >= 1e8 ? 0 : 1)} Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(a >= 1e6 ? 0 : 1)} L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(Math.round(v));
}

function legend(items) {
  return `<div class="legend">${items.map((it, i) =>
    `<span class="key"><i style="background:${it.color || seriesVar(i)}"></i>${esc(it.label)}</span>`).join('')}</div>`;
}

const hidden = () => `<div class="chart-hidden">Charts are hidden while privacy is on.</div>`;

// ------------------------------------------------------------------ donut --
export function donut(items, { centerLabel = '', centerValue = '' } = {}) {
  if (isMasked()) return hidden();
  const data = foldOther(items.filter(x => x.value > 0));
  const total = data.reduce((s, x) => s + x.value, 0);
  if (!total) return '<div class="chart-empty">Nothing to show yet.</div>';
  const R = 70, r = 48, C = 90;
  let a0 = -Math.PI / 2;
  const gap = data.length > 1 ? 0.025 : 0;
  const arcs = data.map((d, i) => {
    const frac = d.value / total;
    const a1 = a0 + frac * 2 * Math.PI;
    const s = a0 + gap / 2, e = Math.max(s + 0.001, a1 - gap / 2);
    a0 = a1;
    if (frac >= 0.9999) {
      return `<circle cx="${C}" cy="${C}" r="${(R + r) / 2}" fill="none" stroke="${seriesVar(i)}" stroke-width="${R - r}"
        data-tip="${esc(d.label)}: ${esc(money(d.value))} (100%)"/>`;
    }
    const large = e - s > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${(C + rad * Math.cos(ang)).toFixed(2)} ${(C + rad * Math.sin(ang)).toFixed(2)}`;
    return `<path d="M ${p(s, R)} A ${R} ${R} 0 ${large} 1 ${p(e, R)} L ${p(e, r)} A ${r} ${r} 0 ${large} 0 ${p(s, r)} Z"
      fill="${seriesVar(i)}" data-tip="${esc(d.label)}: ${esc(money(d.value))} (${(frac * 100).toFixed(1)}%)"/>`;
  }).join('');
  const keys = data.map((d, i) => `<div class="dkey"><i style="background:${seriesVar(i)}"></i>
      <span class="dl">${esc(d.label)}</span><span class="dv">${(d.value / total * 100).toFixed(1)}%</span></div>`).join('');
  return `<div class="donut-wrap"><svg class="chart donut" viewBox="0 0 180 180" role="img" aria-label="Allocation">
    ${arcs}
    <text x="90" y="86" text-anchor="middle" class="c-sub">${esc(centerLabel)}</text>
    <text x="90" y="104" text-anchor="middle" class="c-main">${esc(centerValue)}</text>
  </svg><div class="dkeys">${keys}</div></div>`;
}

// ------------------------------------------------------- line / area -------
// series: [{label, color?, values:[number|null]}], xs: labels (strings)
export function lines(xs, series, { area = false, stacked = false, height = 220, yFmt = axisLabel,
  tipFmt = (v) => money(v), xFmt = (x) => x } = {}) {
  if (isMasked()) return hidden();
  if (!xs.length) return '<div class="chart-empty">No history yet - run an update to start the trend.</div>';
  const W = chartWidth(), H = height, L = 48, Rm = 12, T = 12, B = 26;
  const n = xs.length;
  let tops = xs.map(() => 0);
  const stacks = series.map(s => {
    const lo = tops.slice();
    const hi = s.values.map((v, i) => (stacked ? lo[i] : 0) + (v || 0));
    if (stacked) tops = hi;
    return { lo: stacked ? lo : xs.map(() => 0), hi };
  });
  const all = stacks.flatMap(s => s.hi).concat(stacked ? [] : series.flatMap(s => s.values.filter(v => v != null)));
  const ticks = niceTicks(Math.min(0, ...all), Math.max(...all, 1));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const X = (i) => n === 1 ? (L + W - Rm) / 2 : L + (i * (W - L - Rm)) / (n - 1);
  const Y = (v) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0 || 1));
  const grid = ticks.map(t => `<line x1="${L}" x2="${W - Rm}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/>
    <text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end" class="tick">${esc(yFmt(t))}</text>`).join('');
  const every = Math.max(1, Math.ceil(n / 6));
  const xl = xs.map((x, i) => (i % every === 0 || i === n - 1)
    ? `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="tick">${esc(xFmt(x))}</text>` : '').join('');
  const paths = series.map((s, si) => {
    const col = s.color || seriesVar(si);
    const pts = s.values.map((v, i) => v == null ? null : [X(i), Y(stacks[si].hi[i])]);
    const d = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    let fill = '';
    if (area) {
      const lo = s.values.map((v, i) => [X(i), Y(stacks[si].lo[i])]).reverse();
      fill = `<path d="${d} ${lo.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')} Z" fill="${col}" opacity="${stacked ? 0.55 : 0.10}"/>`;
    }
    const last = pts.filter(Boolean).pop();
    const dot = last && n > 1 ? `<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${col}" class="ring"/>` :
      (last ? `<circle cx="${last[0]}" cy="${last[1]}" r="5" fill="${col}" class="ring"/>` : '');
    return `${fill}<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>${dot}`;
  }).join('');
  // hover columns: one invisible hit band per x, tooltip lists every series
  const band = n > 1 ? (W - L - Rm) / (n - 1) : W - L - Rm;
  const hits = xs.map((x, i) => {
    const lines_ = series.map(s => `${s.label}: ${s.values[i] == null ? '—' : tipFmt(s.values[i])}`);
    if (stacked) lines_.push(`Total: ${tipFmt(stacks[stacks.length - 1].hi[i])}`);
    return `<rect x="${X(i) - band / 2}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"
      data-tip="${esc(xFmt(x))}&#10;${esc(lines_.join('\n'))}" data-x="${X(i)}"/>`;
  }).join('');
  const leg = series.length > 1 ? legend(series.map((s, i) => ({ label: s.label, color: s.color || seriesVar(i) }))) : '';
  return `<svg class="chart xy" viewBox="0 0 ${W} ${H}" role="img">
    ${grid}<line x1="${L}" x2="${W - Rm}" y1="${Y(Math.max(0, y0))}" y2="${Y(Math.max(0, y0))}" class="axis"/>
    ${paths}${xl}<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}"/>${hits}</svg>${leg}`;
}

// ----------------------------------------------------------------- columns --
// groups: [{label, values:[number]}]; series names for the legend
export function columns(groups, seriesNames = [''], { height = 200, tipFmt = (v) => money(v), yFmt = axisLabel, percent = false } = {}) {
  if (isMasked()) return hidden();
  if (!groups.length) return '<div class="chart-empty">Nothing to show yet.</div>';
  const W = chartWidth(), H = height, L = 48, Rm = 8, T = 14, B = 34;
  const vals = groups.flatMap(g => g.values.filter(v => v != null));
  const ticks = niceTicks(Math.min(0, ...vals), Math.max(...vals, percent ? 0.1 : 1));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const Y = (v) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0 || 1));
  const slot = (W - L - Rm) / groups.length;
  const k = seriesNames.length;
  const bw = Math.min(24, (slot * 0.7) / k);
  const grid = ticks.map(t => `<line x1="${L}" x2="${W - Rm}" y1="${Y(t)}" y2="${Y(t)}" class="grid"/>
    <text x="${L - 6}" y="${Y(t) + 4}" text-anchor="end" class="tick">${esc(yFmt(t))}</text>`).join('');
  const bars = groups.map((g, gi) => {
    const cx = L + slot * gi + slot / 2;
    const x0 = cx - (bw * k + 2 * (k - 1)) / 2;
    const rects = g.values.map((v, si) => {
      if (v == null) return '';
      const x = x0 + si * (bw + 2);
      const yv = Y(v), yb = Y(0);
      const top = Math.min(yv, yb), h = Math.max(1, Math.abs(yb - yv));
      const rr = Math.min(4, h / 2, bw / 2);
      // 4px rounded data-end, square at the baseline
      const d = v >= 0
        ? `M${x} ${top + h} V${top + rr} Q${x} ${top} ${x + rr} ${top} H${x + bw - rr} Q${x + bw} ${top} ${x + bw} ${top + rr} V${top + h} Z`
        : `M${x} ${top} V${top + h - rr} Q${x} ${top + h} ${x + rr} ${top + h} H${x + bw - rr} Q${x + bw} ${top + h} ${x + bw} ${top + h - rr} V${top} Z`;
      const name = seriesNames[si] ? `${seriesNames[si]}: ` : '';
      return `<path d="${d}" fill="${seriesVar(si)}"/><rect x="${x - 3}" y="${T}" width="${bw + 6}" height="${H - T - B}" fill="transparent" data-tip="${esc(g.label)}&#10;${esc(name + tipFmt(v))}"/>`;
    }).join('');
    const maxCh = Math.max(4, Math.floor(slot / 7));
    const lab = g.label.length > maxCh ? g.label.slice(0, maxCh - 1) + '…' : g.label;
    return `${rects}<text x="${cx}" y="${H - 14}" text-anchor="middle" class="tick">${esc(lab)}</text>`;
  }).join('');
  const leg = k > 1 ? legend(seriesNames.map((s, i) => ({ label: s }))) : '';
  return `<svg class="chart xy" viewBox="0 0 ${W} ${H}" role="img">${grid}
    <line x1="${L}" x2="${W - Rm}" y1="${Y(0)}" y2="${Y(0)}" class="axis"/>${bars}</svg>${leg}`;
}

// ----------------------------------------------------------- tooltip layer --
let tipEl = null;
export function installTooltips(root = document) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    document.body.appendChild(tipEl);
  }
  const show = (target, x, y) => {
    const t = target.getAttribute('data-tip');
    if (!t) return;
    tipEl.textContent = t;
    tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    let left = x + 12, top = y - r.height - 10;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 12;
    if (top < 8) top = y + 16;
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${top}px`;
    const svg = target.closest('svg');
    const xh = svg && svg.querySelector('.xhair');
    if (xh && target.dataset.x) {
      xh.setAttribute('x1', target.dataset.x); xh.setAttribute('x2', target.dataset.x);
      xh.style.display = 'block';
    }
  };
  const hide = () => {
    if (tipEl) tipEl.style.display = 'none';
    root.querySelectorAll('.xhair').forEach(x => { x.style.display = 'none'; });
  };
  root.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t.closest('svg')) show(t, e.clientX, e.clientY); else hide();
  });
  root.addEventListener('pointerdown', (e) => {
    const t = e.target.closest && e.target.closest('svg [data-tip]');
    if (t) show(t, e.clientX, e.clientY); else hide();
  });
  root.addEventListener('scroll', hide, true);
  return hide;
}

export { axisLabel, compact, pct };

// ------------------------------------------------- actual-vs-target bars ---
// rows: [{label, actual (0..1), target (0..1|null)}]. One horizontal bar per
// class (the actual share) with a tick at the target - reads well on a phone
// even with every class switched on.
export function targetBars(rows) {
  if (isMasked()) return hidden();
  const W = chartWidth(), L = Math.min(118, Math.round(W * 0.32)), Rm = 46, rowH = 26, T = 4;
  const H = T + rows.length * rowH + 4;
  const max = Math.max(0.0001, ...rows.map(r => Math.max(r.actual || 0, r.target || 0)));
  const X = (v) => L + (W - L - Rm) * (v / max);
  const bars = rows.map((r, i) => {
    const y = T + i * rowH + 7;
    const a = r.actual || 0;
    const w = Math.max(2, X(a) - L);
    const tip = `${r.label}&#10;Actual ${(a * 100).toFixed(1)}%${r.target != null ? ` · target ${(r.target * 100).toFixed(1)}%` : ''}`;
    return `<text x="${L - 8}" y="${y + 9}" text-anchor="end" class="tick lbl">${esc(r.label.length > 16 ? r.label.slice(0, 15) + '…' : r.label)}</text>
      <path d="M${L} ${y} H${L + w - 4} Q${L + w} ${y} ${L + w} ${y + 4} V${y + 8} Q${L + w} ${y + 12} ${L + w - 4} ${y + 12} H${L} Z" fill="var(--series-1)"/>
      ${r.target != null ? `<line x1="${X(r.target)}" x2="${X(r.target)}" y1="${y - 4}" y2="${y + 16}" class="target-mark"/>` : ''}
      <text x="${L + w + 5}" y="${y + 10}" class="tick val">${(a * 100).toFixed(0)}%</text>
      <rect x="0" y="${y - 6}" width="${W}" height="${rowH}" fill="transparent" data-tip="${tip}"/>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Actual versus target">
    <line x1="${L}" x2="${L}" y1="0" y2="${H}" class="axis"/>${bars}</svg>
    <div class="legend"><span class="key"><i style="background:var(--series-1)"></i>Actual share</span>
    <span class="key"><i class="tick-key"></i>Target</span></div>`;
}
