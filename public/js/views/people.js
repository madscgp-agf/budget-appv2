import { api } from '../api.js';
import { store } from '../store.js';
import { avatar, clear, confirmDialog, el, emptyState, icon, toast } from '../ui.js';
import { navigate } from '../router.js';

/** Pulls the connect token out of a scanned value: a full URL or a bare code. */
export function tokenFromScan(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/\/connect\/([A-Za-z0-9_-]{10,})/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

async function acceptToken(token, { onDone } = {}) {
  const preview = await api.get(`/api/connections/qr/${encodeURIComponent(token)}`);
  if (preview.isSelf) {
    toast('That is your own code', 'bad');
    return;
  }
  await api.post(`/api/connections/qr/${encodeURIComponent(token)}/accept`);
  toast(`You are now connected with ${preview.user.displayName}`, 'good');
  await store.loadConnections();
  onDone?.();
}

/* --------------------------------------------------------- QR: show mine */

function myCodePanel(container) {
  const panel = el('div', { class: 'qr-panel' }, el('div', { class: 'spinner' }));
  container.append(panel);

  let countdown;

  const load = async () => {
    clear(panel);
    panel.append(el('div', { class: 'spinner' }));
    try {
      const code = await api.post('/api/connections/qr');
      clear(panel);

      const expiry = el('div', { class: 'qr-expiry' });
      const tick = () => {
        const left = Math.max(0, Math.round((new Date(code.expiresAt).getTime() - Date.now()) / 1000));
        if (left === 0) {
          expiry.textContent = 'This code has expired.';
          clearInterval(countdown);
          return;
        }
        expiry.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      };
      clearInterval(countdown);
      countdown = setInterval(tick, 1000);
      tick();

      panel.append(
        el('p', { style: { fontSize: '14px', color: 'var(--muted)', maxWidth: '340px' } },
          'Let the other person scan this with their camera, or send them the link. It connects you both straight away.'),
        el('div', { class: 'qr-frame' }, el('img', { src: code.qr, alt: 'QR code to connect with you', width: '232', height: '232' })),
        expiry,
        el('div', { class: 'qr-code-text' }, code.url),
        el(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } },
          el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                try {
                  if (navigator.share) await navigator.share({ title: 'Connect with me on Budget', url: code.url });
                  else {
                    await navigator.clipboard.writeText(code.url);
                    toast('Link copied', 'good');
                  }
                } catch {
                  /* the user dismissed the share sheet */
                }
              },
            },
            icon('link', 15),
            navigator.share ? 'Share link' : 'Copy link',
          ),
          el('button', { class: 'btn btn-sm', onclick: load }, 'New code'),
        ),
      );
    } catch (err) {
      clear(panel);
      panel.append(el('div', { class: 'modal-error' }, err.message));
    }
  };

  load();
  // Stop the countdown when this panel is torn out of the page.
  return () => clearInterval(countdown);
}

/* ------------------------------------------------------------ QR: scan */

function scanPanel(container, { onConnected }) {
  const panel = el('div', {});
  container.append(panel);

  let stream = null;
  let raf = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const manualEntry = () =>
    el(
      'form',
      {
        style: { marginTop: '16px' },
        onsubmit: async (event) => {
          event.preventDefault();
          const token = tokenFromScan(event.target.code.value);
          if (!token) return toast('That does not look like a connect code', 'bad');
          try {
            await acceptToken(token, { onDone: onConnected });
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      },
      el('label', { class: 'hint', style: { display: 'block', marginBottom: '6px' } }, 'Or paste the invite link or code'),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        el('input', { type: 'text', name: 'code', placeholder: 'https://.../connect/abc123', style: { flex: '1' } }),
        el('button', { class: 'btn btn-primary', type: 'submit' }, 'Connect'),
      ),
    );

  const start = async () => {
    clear(panel);

    const supported =
      'BarcodeDetector' in window &&
      (await window.BarcodeDetector.getSupportedFormats().catch(() => [])).includes('qr_code');

    if (!supported) {
      panel.append(
        el(
          'div',
          { class: 'card', style: { background: 'var(--surface-2)', boxShadow: 'none' } },
          el('p', { style: { fontSize: '14px', lineHeight: '1.5' } },
            'This browser cannot scan QR codes directly. Open the invite link the other person sent you, or paste it below.'),
        ),
        manualEntry(),
      );
      return;
    }

    const video = el('video', { playsinline: true, muted: true, autoplay: true });
    const status = el('p', { style: { fontSize: '13.5px', color: 'var(--muted)', textAlign: 'center', marginTop: '12px' } }, 'Point the camera at their QR code.');
    panel.append(el('div', { class: 'scanner' }, video, el('div', { class: 'scanner-frame' })), status, manualEntry());

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
    } catch {
      clear(panel);
      panel.append(
        el(
          'div',
          { class: 'card', style: { background: 'var(--surface-2)', boxShadow: 'none' } },
          el('p', { style: { fontSize: '14px', lineHeight: '1.5' } }, 'The camera is not available. You can still paste their invite link.'),
        ),
        manualEntry(),
      );
      return;
    }

    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    let busy = false;

    const loop = async () => {
      if (stopped) return;
      if (!busy && video.readyState === video.HAVE_ENOUGH_DATA) {
        busy = true;
        try {
          const [found] = await detector.detect(video);
          const token = found && tokenFromScan(found.rawValue);
          if (token) {
            stop();
            status.textContent = 'Connecting...';
            try {
              await acceptToken(token, { onDone: onConnected });
            } catch (err) {
              toast(err.message, 'bad');
              stopped = false;
              start();
            }
            return;
          }
        } catch {
          /* a frame that fails to decode is normal */
        }
        busy = false;
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  };

  start();
  return stop;
}

/* --------------------------------------------------- username search */

function usernamePanel(container, { onConnected }) {
  const results = el('div', {});
  const input = el('input', { type: 'search', placeholder: 'Search by username or name', autocomplete: 'off' });

  let timer;
  const search = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      clear(results);
      results.append(el('p', { class: 'hint', style: { padding: '10px 0' } }, 'Type at least two characters.'));
      return;
    }
    try {
      const { results: people } = await api.get('/api/connections/search', { q });
      clear(results);
      if (people.length === 0) {
        results.append(emptyState('\u{1F50D}', 'No one found', `No account matches "${q}".`));
        return;
      }
      for (const person of people) results.append(personRow(person, { onConnected }));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 280);
  });

  container.append(
    el('p', { style: { fontSize: '14px', color: 'var(--muted)', marginBottom: '14px' } },
      'Find someone by their username and send them a request. They will see it next time they open the app.'),
    input,
    results,
  );
  search();
  return () => clearTimeout(timer);
}

function personRow(person, { onConnected }) {
  const action = el('div', { class: 'person-actions' });

  const setAction = () => {
    clear(action);
    if (person.connectionStatus === 'accepted') {
      action.append(el('span', { class: 'pill good' }, 'Connected'));
    } else if (person.connectionStatus === 'pending' && person.connectionDirection === 'outgoing') {
      action.append(el('span', { class: 'pill' }, 'Requested'));
    } else if (person.connectionStatus === 'pending') {
      action.append(
        el(
          'button',
          {
            class: 'btn btn-sm btn-primary',
            onclick: async () => {
              await api.post('/api/connections/requests', { username: person.username });
              person.connectionStatus = 'accepted';
              toast(`Connected with ${person.displayName}`, 'good');
              await store.loadConnections();
              setAction();
              onConnected?.();
            },
          },
          'Accept',
        ),
      );
    } else {
      action.append(
        el(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              try {
                await api.post('/api/connections/requests', { username: person.username });
                person.connectionStatus = 'pending';
                person.connectionDirection = 'outgoing';
                toast(`Request sent to ${person.displayName}`, 'good');
                await store.loadConnections();
                setAction();
                onConnected?.();
              } catch (err) {
                toast(err.message, 'bad');
                event.currentTarget.disabled = false;
              }
            },
          },
          'Connect',
        ),
      );
    }
  };
  setAction();

  return el(
    'div',
    { class: 'person-row' },
    avatar(person),
    el('div', { class: 'who' }, el('div', { class: 'name' }, person.displayName), el('div', { class: 'handle' }, `@${person.username}`)),
    action,
  );
}

/* ------------------------------------------------------------- the page */

export async function renderPeople(root, { tab = 'people' } = {}) {
  clear(root);
  await store.loadConnections();
  const { connected, incoming, outgoing } = store.connections;

  let teardown = null;
  const refresh = () => {
    teardown?.();
    renderPeople(root, { tab: current });
  };

  let current = tab;
  const panelHost = el('div', { class: 'card' });

  const drawPanel = () => {
    teardown?.();
    teardown = null;
    clear(panelHost);
    if (current === 'people') return drawPeople();
    if (current === 'username') return (teardown = usernamePanel(panelHost, { onConnected: null }));
    if (current === 'mycode') return (teardown = myCodePanel(panelHost));
    if (current === 'scan') return (teardown = scanPanel(panelHost, { onConnected: refresh }));
  };

  const drawPeople = () => {
    if (incoming.length === 0 && outgoing.length === 0 && connected.length === 0) {
      panelHost.append(
        emptyState(
          '\u{1F91D}',
          'No connections yet',
          'Connect with the people you share money with, then share an account with them.',
          el(
            'div',
            { style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
            el('button', { class: 'btn btn-primary', onclick: () => { current = 'username'; drawTabs(); drawPanel(); } }, 'Find by username'),
            el('button', { class: 'btn', onclick: () => { current = 'mycode'; drawTabs(); drawPanel(); } }, 'Show my QR'),
          ),
        ),
      );
      return;
    }

    if (incoming.length) {
      panelHost.append(el('div', { class: 'card-head' }, el('h3', {}, `Requests for you (${incoming.length})`)));
      for (const item of incoming) {
        panelHost.append(
          el(
            'div',
            { class: 'person-row' },
            avatar(item.user),
            el('div', { class: 'who' }, el('div', { class: 'name' }, item.user.displayName), el('div', { class: 'handle' }, `@${item.user.username}`)),
            el(
              'div',
              { class: 'person-actions' },
              el(
                'button',
                {
                  class: 'btn btn-sm btn-primary',
                  onclick: async () => {
                    await api.post(`/api/connections/${item.id}/accept`);
                    toast(`Connected with ${item.user.displayName}`, 'good');
                    refresh();
                  },
                },
                'Accept',
              ),
              el(
                'button',
                {
                  class: 'btn btn-sm',
                  onclick: async () => {
                    await api.post(`/api/connections/${item.id}/decline`);
                    refresh();
                  },
                },
                'Decline',
              ),
            ),
          ),
        );
      }
    }

    if (connected.length) {
      panelHost.append(el('div', { class: 'card-head', style: { marginTop: incoming.length ? '22px' : '0' } }, el('h3', {}, `Connected (${connected.length})`)));
      for (const item of connected) {
        panelHost.append(
          el(
            'div',
            { class: 'person-row' },
            avatar(item.user),
            el(
              'div',
              { class: 'who' },
              el('div', { class: 'name' }, item.user.displayName),
              el('div', { class: 'handle' }, `@${item.user.username} · connected by ${item.origin === 'qr' ? 'QR code' : 'username'}`),
            ),
            el(
              'div',
              { class: 'person-actions' },
              el('button', { class: 'btn btn-sm', onclick: () => navigate('/accounts') }, 'Share an account'),
              el(
                'button',
                {
                  class: 'icon-btn',
                  title: 'Remove connection',
                  onclick: async () => {
                    const ok = await confirmDialog({
                      title: 'Remove connection?',
                      message: `${item.user.displayName} will lose access to anything you shared with them.`,
                      confirmLabel: 'Remove',
                    });
                    if (!ok) return;
                    await api.del(`/api/connections/${item.id}`);
                    toast('Connection removed');
                    refresh();
                  },
                },
                icon('trash', 16),
              ),
            ),
          ),
        );
      }
    }

    if (outgoing.length) {
      panelHost.append(el('div', { class: 'card-head', style: { marginTop: '22px' } }, el('h3', {}, `Waiting for a reply (${outgoing.length})`)));
      for (const item of outgoing) {
        panelHost.append(
          el(
            'div',
            { class: 'person-row' },
            avatar(item.user),
            el('div', { class: 'who' }, el('div', { class: 'name' }, item.user.displayName), el('div', { class: 'handle' }, `@${item.user.username}`)),
            el(
              'div',
              { class: 'person-actions' },
              el('span', { class: 'pill' }, 'Pending'),
              el(
                'button',
                {
                  class: 'icon-btn',
                  title: 'Cancel request',
                  onclick: async () => {
                    await api.del(`/api/connections/${item.id}`);
                    refresh();
                  },
                },
                icon('x', 16),
              ),
            ),
          ),
        );
      }
    }
  };

  const TABS = [
    ['people', `People${incoming.length ? ` (${incoming.length})` : ''}`],
    ['username', 'By username'],
    ['mycode', 'My QR code'],
    ['scan', 'Scan'],
  ];
  const tabsBar = el('div', { class: 'tabs' });
  const drawTabs = () => {
    clear(tabsBar);
    for (const [key, label] of TABS) {
      tabsBar.append(
        el(
          'button',
          {
            class: current === key ? 'active' : '',
            onclick: () => {
              current = key;
              // The People tab shows live lists, so re-read them on the way in.
              if (key === 'people') return refresh();
              drawTabs();
              drawPanel();
            },
          },
          label,
        ),
      );
    }
  };
  drawTabs();

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, 'People'),
        el('p', { class: 'sub' }, 'Connect by username or QR code, then share accounts with each other.'),
      ),
    ),
    tabsBar,
    panelHost,
  );
  drawPanel();
}

/** Landing page for a scanned/opened invite link: /connect/:token */
export async function renderConnectToken(root, token) {
  clear(root);
  const card = el('div', { class: 'card', style: { maxWidth: '440px', margin: '40px auto' } }, el('div', { class: 'spinner' }));
  root.append(card);

  try {
    const preview = await api.get(`/api/connections/qr/${encodeURIComponent(token)}`);
    clear(card);

    if (preview.isSelf) {
      card.append(emptyState('\u{1FA9E}', 'That is your own code', 'Show it to someone else so they can scan it.',
        el('button', { class: 'btn btn-primary', onclick: () => navigate('/people') }, 'Back to people')));
      return;
    }

    card.append(
      el(
        'div',
        { style: { textAlign: 'center', display: 'grid', gap: '14px', justifyItems: 'center' } },
        avatar(preview.user, { large: true }),
        el(
          'div',
          {},
          el('h2', { style: { fontSize: '19px' } }, preview.user.displayName),
          el('p', { style: { color: 'var(--muted)', fontSize: '14px', marginTop: '4px' } }, `@${preview.user.username}`),
        ),
        preview.alreadyConnected
          ? el('p', { style: { fontSize: '14px', color: 'var(--muted)' } }, 'You are already connected.')
          : el('p', { style: { fontSize: '14px', color: 'var(--muted)' } }, 'Connect so you can share accounts and budgets with each other.'),
        el(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          el('button', { class: 'btn', onclick: () => navigate('/people') }, 'Not now'),
          el(
            'button',
            {
              class: 'btn btn-primary',
              onclick: async (event) => {
                event.currentTarget.disabled = true;
                try {
                  await api.post(`/api/connections/qr/${encodeURIComponent(token)}/accept`);
                  await store.loadConnections();
                  toast(`Connected with ${preview.user.displayName}`, 'good');
                  navigate('/people');
                } catch (err) {
                  toast(err.message, 'bad');
                  event.currentTarget.disabled = false;
                }
              },
            },
            preview.alreadyConnected ? 'Confirm' : 'Connect',
          ),
        ),
      ),
    );
  } catch (err) {
    clear(card);
    card.append(
      emptyState('\u{23F1}', 'That code did not work', err.message,
        el('button', { class: 'btn btn-primary', onclick: () => navigate('/people') }, 'Go to people')),
    );
  }
}
