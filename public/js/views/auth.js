import { api, ApiError } from '../api.js';
import { store } from '../store.js';
import { el, clear, toast, field } from '../ui.js';

/** Loads the Google Identity Services script once, on demand. */
let gsiPromise = null;
function loadGoogleScript() {
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () =>
      window.google?.accounts?.id ? resolve(window.google) : reject(new Error('Google script did not initialise'));
    script.onerror = () => reject(new Error('Could not reach Google'));
    document.head.append(script);
  });
  return gsiPromise;
}

function initGoogle(google, onSuccess) {
  google.accounts.id.initialize({
    client_id: store.authConfig.google.clientId,
    callback: async (response) => {
      try {
        const result = await api.post('/api/auth/google', { credential: response.credential });
        store.user = result.user;
        toast(result.created ? `Welcome, ${result.user.displayName}!` : 'Signed in with Google', 'good');
        onSuccess(result.user);
      } catch (err) {
        toast(err.message || 'Google sign-in failed', 'bad');
      }
    },
    auto_select: false,
    cancel_on_tap_outside: true,
  });
}

/**
 * Renders the Google button into `slot`. When the Google script cannot load
 * (offline, blocked, or no client id) fall back to the server-side redirect,
 * or explain why the button is unavailable.
 */
async function mountGoogleButton(slot, { onSuccess, nextPath }) {
  const { google } = store.authConfig;
  clear(slot);

  if (!google.enabled) {
    slot.append(el('div', { class: 'google-note' }, 'Google sign-in is not configured on this server yet.'));
    return;
  }

  slot.append(el('div', { class: 'spinner' }));

  try {
    await loadGoogleScript();
    initGoogle(window.google, onSuccess);
    clear(slot);
    const holder = el('div');
    slot.append(holder);
    window.google.accounts.id.renderButton(holder, {
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
      size: 'large',
      width: Math.min(slot.clientWidth || 360, 400),
      text: 'continue_with',
      shape: 'rectangular',
      logo_alignment: 'center',
    });
  } catch {
    clear(slot);
    if (google.redirectFlow) {
      slot.append(
        el(
          'a',
          {
            class: 'google-btn',
            href: `/api/auth/google/start?next=${encodeURIComponent(nextPath || '/')}`,
            'data-external': '',
          },
          googleMark(),
          'Continue with Google',
        ),
      );
    } else {
      slot.append(
        el('div', { class: 'google-note' }, 'Google sign-in is unavailable right now. Use your email and password below.'),
      );
    }
  }
}

function googleMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.innerHTML =
    '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.6 24.6c0-1.6-.1-3.2-.4-4.6H24v9.1h12.7c-.6 3-2.3 5.5-4.9 7.2l7.6 5.9c4.4-4.1 7.2-10.2 7.2-17.6z"/>' +
    '<path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.8-6.1z"/>' +
    '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.3 0-11.7-3.7-13.6-9.9l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>';
  return svg;
}

const BENEFITS = [
  ['Every account in one place', 'Track cash, cards and savings together with a running balance.'],
  ['Budgets that keep up', 'Set a monthly limit per category and see what is left at a glance.'],
  ['Share with the people you split with', 'Connect by username or by scanning a QR code, then share an account.'],
];

function errorSlot() {
  return el('div', { class: 'field', style: { display: 'none' } });
}

function showError(slot, message) {
  clear(slot);
  if (!message) {
    slot.style.display = 'none';
    return;
  }
  slot.style.display = 'block';
  slot.append(el('div', { class: 'modal-error' }, message));
}

function signInForm(onSignedIn) {
  const identifier = el('input', {
    type: 'text',
    autocomplete: 'username',
    placeholder: 'you@example.com or your username',
    required: true,
  });
  const password = el('input', { type: 'password', autocomplete: 'current-password', placeholder: '........', required: true });
  const errors = errorSlot();
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');

  return el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        showError(errors, null);
        submit.disabled = true;
        try {
          const { user } = await api.post('/api/auth/login', {
            identifier: identifier.value,
            password: password.value,
          });
          store.user = user;
          onSignedIn(user);
        } catch (err) {
          showError(errors, err.message);
        } finally {
          submit.disabled = false;
        }
      },
    },
    errors,
    field('Email or username', identifier),
    field('Password', password),
    submit,
  );
}

function signUpForm(onSignedIn) {
  const displayName = el('input', { type: 'text', autocomplete: 'name', placeholder: 'Ada Lovelace' });
  const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com', required: true });
  const username = el('input', { type: 'text', autocomplete: 'username', placeholder: 'ada', required: true, id: 'signup-username' });
  const password = el('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: 'At least 8 characters',
    required: true,
    minlength: '8',
  });
  const usernameHint = el('div', { class: 'hint' }, 'Others can find you by this to connect.');
  const errors = errorSlot();
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Create account');

  // Live availability check, debounced so it does not fire on every keystroke.
  let timer;
  username.addEventListener('input', () => {
    clearTimeout(timer);
    const value = username.value.trim();
    if (value.length < 3) {
      usernameHint.className = 'hint';
      usernameHint.textContent = 'Others can find you by this to connect.';
      return;
    }
    timer = setTimeout(async () => {
      try {
        const result = await api.get('/api/auth/username-available', { username: value });
        usernameHint.className = result.available ? 'ok' : 'error';
        usernameHint.textContent = result.available ? `${value} is available` : result.reason;
      } catch {
        /* availability is a nicety; ignore failures */
      }
    }, 350);
  });

  return el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        showError(errors, null);
        submit.disabled = true;
        try {
          const { user } = await api.post('/api/auth/register', {
            email: email.value,
            username: username.value.trim(),
            password: password.value,
            displayName: displayName.value.trim() || undefined,
          });
          store.user = user;
          toast(`Welcome, ${user.displayName}!`, 'good');
          onSignedIn(user);
        } catch (err) {
          showError(errors, err instanceof ApiError ? err.message : 'Could not create your account');
        } finally {
          submit.disabled = false;
        }
      },
    },
    errors,
    field('Name', displayName),
    field('Email', email),
    el('div', { class: 'field' }, el('label', { for: 'signup-username' }, 'Username'), username, usernameHint),
    field('Password', password),
    submit,
  );
}

/** The sign-in / sign-up screen. */
export function renderAuth(root, { mode = 'signin', nextPath = '/', onSignedIn } = {}) {
  clear(root);
  root.className = '';
  let current = mode;

  const card = el('div', { class: 'auth-card' });

  const draw = () => {
    clear(card);
    const isSignUp = current === 'signup';
    const googleSlot = el('div', { class: 'google-slot' });

    card.append(
      el('h1', {}, isSignUp ? 'Create your account' : 'Welcome back'),
      el(
        'p',
        { class: 'sub' },
        isSignUp ? 'Start tracking in under a minute. No card, no import needed.' : 'Sign in to pick up where you left off.',
      ),
      googleSlot,
      el('div', { class: 'divider' }, isSignUp ? 'or sign up with email' : 'or sign in with email'),
      isSignUp ? signUpForm(onSignedIn) : signInForm(onSignedIn),
      el(
        'p',
        { class: 'switch-line' },
        isSignUp ? 'Already have an account? ' : 'Do not have an account yet? ',
        el(
          'button',
          {
            type: 'button',
            onclick: () => {
              current = isSignUp ? 'signin' : 'signup';
              draw();
            },
          },
          isSignUp ? 'Sign in' : 'Create one',
        ),
      ),
    );

    mountGoogleButton(googleSlot, { onSuccess: onSignedIn, nextPath });
  };

  draw();

  root.append(
    el(
      'div',
      { class: 'auth-wrap' },
      el(
        'aside',
        { class: 'auth-aside' },
        el(
          'div',
          {},
          el(
            'div',
            { class: 'brand', style: { color: '#fff', padding: '0 0 34px' } },
            el('span', { class: 'dot' }, '\u{1F4B0}'),
            'Budget',
          ),
          el('h2', {}, 'Know where the money goes.'),
          el(
            'p',
            { style: { opacity: '.9', fontSize: '15px', lineHeight: '1.55' } },
            'A budget you will actually keep using - quick to log, easy to share.',
          ),
          el(
            'ul',
            {},
            BENEFITS.map(([title, body]) =>
              el(
                'li',
                {},
                el('span', { class: 'tick' }, '✓'),
                el(
                  'span',
                  {},
                  el('strong', {}, title),
                  el('div', { style: { opacity: '.85', fontSize: '13.5px', marginTop: '2px' } }, body),
                ),
              ),
            ),
          ),
        ),
        el('div', { style: { opacity: '.75', fontSize: '13px' } }, 'Your data stays on your own server.'),
      ),
      el('main', { class: 'auth-main' }, card),
    ),
  );
}
