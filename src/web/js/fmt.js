// Number/date formatting. Indian digit grouping (12,34,567), dates as
// dd-mm-yyyy like the workbook. While the privacy mask is on, every number
// renders as ••• (dates stay visible - same rule as the workbook's mask).

export const MASK = '•••';
let masked = false;
export function setMasked(on) { masked = !!on; }
export function isMasked() { return masked; }

const nf = new Map();
function f(min, max) {
  const k = `${min}-${max}`;
  if (!nf.has(k)) {
    nf.set(k, new Intl.NumberFormat('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max }));
  }
  return nf.get(k);
}

const blank = (v) => v === null || v === undefined || v === '' || Number.isNaN(v);

export function money(v, dp = 0) {
  if (blank(v)) return '';
  if (masked) return MASK;
  const s = f(dp, dp).format(Math.abs(v));
  return (v < 0 ? '−₹' : '₹') + s;
}

export function signedMoney(v) {
  if (blank(v)) return '';
  if (masked) return MASK;
  if (Math.abs(v) < 0.5) return '₹0';
  return (v > 0 ? '+' : '') + money(v);
}

// ₹38.1 L / ₹1.24 Cr - for headline figures
export function compact(v) {
  if (blank(v)) return '';
  if (masked) return MASK;
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}₹${f(2, 2).format(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${f(2, 2).format(a / 1e5)} L`;
  return money(v);
}

export function num(v, dp = 3) {
  if (blank(v)) return '';
  if (masked) return MASK;
  return f(0, dp).format(v);
}

export function price(v) {
  if (blank(v)) return '';
  if (masked) return MASK;
  return '₹' + f(2, 2).format(v);
}

export function pct(v, dp = 1) {
  if (blank(v)) return '';
  if (masked) return MASK;
  return `${(v * 100).toFixed(dp)}%`;
}

export function signedPct(v, dp = 1) {
  if (blank(v)) return '';
  if (masked) return MASK;
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`;
}

// a percentage typed as a number (7.1 = 7.1 %)
export function rate(v) {
  if (blank(v)) return '';
  return `${f(0, 2).format(v)}%`;
}

export function date(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateShort(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function tone(v) {
  if (blank(v) || masked) return '';
  return v > 0 ? 'pos' : v < 0 ? 'neg' : '';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysBetween(aIso, bIso) {
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / 86400000);
}
