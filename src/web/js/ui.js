// Shared app state + small UI primitives (modal sheet, confirm, prompt, toast).
import { esc } from './fmt.js';

export const S = {
  engine: null,
  engineState: 'off',      // off | starting | ready | error
  engineError: '',
  view: null,              // build_view() output
  masters: null,           // {mf, stock, nps, banks}
  guide: null,
  revealed: false,         // privacy mask lifted for this session
  hasData: false,
  busy: '',                // a long operation is running (text shown)
  ownerFilter: '',
  installPrompt: null,
};

// ------------------------------------------------------------------ toast --
let toastTimer = null;
export function toast(msg, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6000 : 3000);
}

// ------------------------------------------------------------------ modal --
// openSheet({title, body (html), actions:[{label, kind, value}], wide})
// resolves with the clicked action's value (or null when dismissed). The
// optional onMount(el, close) wires custom behaviour.
export function openSheet({ title, body, actions = [], wide = false, onMount, dismissable = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2>${dismissable ? `<button class="icon-btn" data-close aria-label="Close">${icon('close')}</button>` : ''}</div>
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-foot">${actions.map((a, i) =>
        `<button class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    root.appendChild(wrap);
    document.body.classList.add('modal-open');
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      wrap.remove();
      if (!root.children.length) document.body.classList.remove('modal-open');
      resolve(v);
    };
    wrap.addEventListener('click', (e) => {
      if (dismissable && (e.target === wrap || e.target.closest('[data-close]'))) close(null);
      const b = e.target.closest('.modal-foot [data-i]');
      if (b) {
        const a = actions[Number(b.dataset.i)];
        if (a.handler) {
          Promise.resolve(a.handler(wrap, close)).catch(err => toast(err.message, 'error'));
        } else close(a.value !== undefined ? a.value : a.label);
      }
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dismissable) close(null); });
    if (onMount) onMount(wrap, close);
    const first = wrap.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
  });
}

export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return openSheet({
    title, body: `<p>${text}</p>`,
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, kind: danger ? 'danger' : 'primary', value: true }],
  }).then(v => v === true);
}

export function alertBox(title, html) {
  return openSheet({ title, body: html, actions: [{ label: 'OK', kind: 'primary', value: true }] });
}

// password / text prompt. validate(value) -> error string | '' (async ok)
export function promptBox({ title, text = '', label = '', type = 'text', okLabel = 'OK', validate, twice = false, value = '' }) {
  return new Promise((resolve) => {
    openSheet({
      title,
      body: `${text ? `<p>${text}</p>` : ''}
        <label class="fld"><span>${esc(label)}</span><input name="v1" type="${type}" value="${esc(value)}" autocomplete="${type === 'password' ? 'current-password' : 'off'}"></label>
        ${twice ? `<label class="fld"><span>Type it again</span><input name="v2" type="${type}" autocomplete="new-password"></label>` : ''}
        <p class="err" hidden></p>`,
      actions: [
        { label: 'Cancel', handler: (_el, close) => { close(null); resolve(null); } },
        {
          label: okLabel, kind: 'primary',
          handler: async (el, close) => {
            const v1 = el.querySelector('[name=v1]').value;
            const err = el.querySelector('.err');
            if (twice && v1 !== el.querySelector('[name=v2]').value) {
              err.hidden = false; err.textContent = 'The two entries differ.'; return;
            }
            const btns = el.querySelectorAll('.modal-foot button');
            btns.forEach(b => { b.disabled = true; });
            const msg = validate ? await validate(v1) : '';
            btns.forEach(b => { b.disabled = false; });
            if (msg) { err.hidden = false; err.textContent = msg; return; }
            close(v1); resolve(v1);
          },
        },
      ],
      onMount: (el) => {
        el.querySelector('form, .modal-body').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); el.querySelector('.modal-foot .primary').click(); }
        });
      },
    }).then(v => { if (v === null) resolve(null); });
  });
}

// a full-screen "please wait" layer with a live log (used by long jobs)
export function busyLayer(title) {
  const el = document.createElement('div');
  el.className = 'busy-layer';
  el.innerHTML = `<div class="busy-card"><div class="spinner" aria-hidden="true"></div>
    <h2>${esc(title)}</h2><div class="busy-log" aria-live="polite"></div></div>`;
  document.body.appendChild(el);
  const log = el.querySelector('.busy-log');
  return {
    el,
    line(text) {
      const t = String(text).replace(/^\s*[⏳]\s*/, '').trim();
      if (!t) return;
      const p = document.createElement('div');
      p.textContent = t;
      log.appendChild(p);
      while (log.children.length > 6) log.firstChild.remove();
    },
    close() { el.remove(); },
  };
}

// Inline SVG icons (stroke = currentColor) - identical on every device,
// unlike emoji, which some systems lack.
const ICON_PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 13.6c2.6.2 5 2 5 5.4"/>',
  holdings: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9.5h16M4 14.5h16"/>',
  reports: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="m7 15 4-4 3 3 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.7C3.8 8.5 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.4-1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};
export function icon(name, size = 20) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}
