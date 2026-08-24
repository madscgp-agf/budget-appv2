/** Tiny DOM helpers -- enough structure to build views without a framework. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/* ---------------------------------------------------------- formatting */
export function money(amount, currency = 'USD', { sign = false } = {}) {
  const formatted = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Math.abs(Number(amount) || 0));
  if (!sign) return Number(amount) < 0 ? `-${formatted}` : formatted;
  return `${Number(amount) < 0 ? '-' : '+'}${formatted}`;
}

export function shortDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function dayHeading(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return 'Today';
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === yesterday) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export function periodLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';

export function avatar(user, { large = false } = {}) {
  const cls = `avatar${large ? ' avatar-lg' : ''}`;
  if (user?.avatarUrl) return el('img', { class: cls, src: user.avatarUrl, alt: '', referrerpolicy: 'no-referrer' });
  return el('div', { class: cls }, initials(user?.displayName || user?.username || ''));
}

/* -------------------------------------------------------------- toasts */
export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  // Keep the stack short so a burst of updates does not cover the page.
  while (host.children.length >= 3) host.firstChild.remove();
  const node = el('div', { class: `toast ${kind}` }, message);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 200);
  }, 3200);
}

/* -------------------------------------------------------------- modals */
export function openModal({ title, body, actions = [], onClose } = {}) {
  const root = document.getElementById('modal-root');
  const errorSlot = el('div');

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  const modal = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    el(
      'div',
      { class: 'modal-head' },
      el('h3', {}, title || ''),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x')),
    ),
    el('div', { class: 'modal-body' }, errorSlot, body),
    actions.length ? el('div', { class: 'modal-foot' }, actions) : null,
  );

  const backdrop = el(
    'div',
    {
      class: 'modal-backdrop',
      onclick: (event) => {
        if (event.target === backdrop) close();
      },
    },
    modal,
  );

  // The footer sits outside the form, so submit buttons there need an explicit
  // association or clicking them would do nothing.
  const form = modal.querySelector('.modal-body form');
  if (form) {
    if (!form.id) form.id = `form-${Math.random().toString(36).slice(2, 9)}`;
    for (const button of modal.querySelectorAll('.modal-foot button[type="submit"]')) {
      button.setAttribute('form', form.id);
    }
  }

  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  setTimeout(() => modal.querySelector('input, select, textarea, button')?.focus(), 40);

  return {
    close,
    showError: (message) => {
      clear(errorSlot);
      if (message) errorSlot.append(el('div', { class: 'modal-error' }, message));
    },
  };
}

export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const dialog = openModal({
      title,
      body: el('p', { style: { fontSize: '14px', color: 'var(--muted)', lineHeight: '1.5' } }, message),
      actions: [
        el('button', { class: 'btn', onclick: () => { finish(false); dialog.close(); } }, 'Cancel'),
        el(
          'button',
          { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { finish(true); dialog.close(); } },
          confirmLabel,
        ),
      ],
      onClose: () => finish(false),
    });
  });
}

/* --------------------------------------------------------------- forms */
export function field(label, input, { hint } = {}) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return el(
    'div',
    { class: 'field' },
    el('label', { for: id }, label),
    input,
    hint ? el('div', { class: 'hint' }, hint) : null,
  );
}

export function select(options, { value, ...attrs } = {}) {
  const node = el('select', attrs);
  for (const option of options) {
    node.append(el('option', { value: option.value, selected: String(option.value) === String(value) }, option.label));
  }
  return node;
}

/** Wires a submit button so it disables while the promise is in flight. */
export function submitting(button, fn) {
  return async (...args) => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      await fn(...args);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };
}

/* --------------------------------------------------------------- icons */
const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M16 12h4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 5.5a3.2 3.2 0 0 1 0 6"/><path d="M18.5 14.4A6.5 6.5 0 0 1 22 20"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7 5.6 5.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pencil: '<path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.5-3.5"/>',
  camera: '<path d="M3 8.5A2 2 0 0 1 5 6.5h2.2l1.3-2h7l1.3 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.4"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 7"/>',
  repeat: '<path d="M4 9V7a2 2 0 0 1 2-2h12l-3-3M20 15v2a2 2 0 0 1-2 2H6l3 3"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.4"/><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  logout: '<path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/>',
};

export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = PATHS[name] || PATHS.list;
  return svg;
}

export function emptyState(emoji, title, message, action) {
  return el(
    'div',
    { class: 'empty' },
    el('span', { class: 'emoji' }, emoji),
    el('h3', { style: { fontSize: '15px', marginBottom: '6px' } }, title),
    message ? el('p', {}, message) : null,
    action || null,
  );
}
