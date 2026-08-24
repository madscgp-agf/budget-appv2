import { store } from './store.js';
import { navigate, onRouteChange, route, setNotFound, startRouter, currentPath } from './router.js';
import { avatar, clear, el, emptyState, icon, toast } from './ui.js';
import { renderAuth } from './views/auth.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTransactions } from './views/transactions.js';
import { renderBudgets } from './views/budgets.js';
import { renderAccounts } from './views/accounts.js';
import { renderGoals } from './views/goals.js';
import { renderPeople, renderConnectToken } from './views/people.js';
import { renderSettings } from './views/settings.js';

const appRoot = document.getElementById('app');
let outlet = null;

const NAV = [
  { path: '/', label: 'Overview', icon: 'home' },
  { path: '/transactions', label: 'Transactions', icon: 'list' },
  { path: '/budgets', label: 'Budgets', icon: 'chart' },
  { path: '/accounts', label: 'Accounts', icon: 'wallet' },
  { path: '/plans', label: 'Plans', icon: 'target' },
  { path: '/people', label: 'People', icon: 'users' },
  { path: '/settings', label: 'Settings', icon: 'gear' },
];

/** Builds the signed-in shell once; views then render into the outlet. */
function mountShell() {
  clear(appRoot);
  appRoot.className = '';

  const sidebarLinks = el('div', { style: { display: 'grid', gap: '2px' } });
  const mobileNav = el('nav', { class: 'mobile-nav' });
  outlet = el('main', { class: 'main' });

  for (const item of NAV) {
    sidebarLinks.append(
      el(
        'button',
        { class: 'nav-link', dataset: { path: item.path }, onclick: () => navigate(item.path) },
        icon(item.icon, 18),
        item.label,
        item.path === '/people' ? el('span', { class: 'badge', style: { display: 'none' } }) : null,
      ),
    );
  }

  for (const item of NAV.filter((entry) => entry.path !== '/settings')) {
    mobileNav.append(
      el('button', { dataset: { path: item.path }, onclick: () => navigate(item.path) }, icon(item.icon, 21), item.label),
    );
  }

  appRoot.append(
    el(
      'div',
      { class: 'shell' },
      el(
        'aside',
        { class: 'sidebar' },
        el('div', { class: 'brand' }, el('span', { class: 'dot' }, '\u{1F4B0}'), 'Budget'),
        sidebarLinks,
        el('div', { class: 'nav-spacer' }),
        el(
          'div',
          { class: 'sidebar-user' },
          avatar(store.user),
          el(
            'div',
            { class: 'who' },
            el('div', { class: 'name' }, store.user.displayName),
            el('div', { class: 'handle' }, `@${store.user.username}`),
          ),
          el('button', { class: 'icon-btn', title: 'Sign out', onclick: () => store.signOut() }, icon('logout', 16)),
        ),
      ),
      outlet,
    ),
    mobileNav,
  );

  refreshBadges();
}

function highlightNav(path) {
  for (const node of document.querySelectorAll('[data-path]')) {
    const target = node.dataset.path;
    node.classList.toggle('active', target === path || (target !== '/' && path.startsWith(target)));
  }
}

/** Shows the pending-request count next to People. */
export function refreshBadges() {
  const count = store.connections.incoming.length;
  const badge = document.querySelector('.nav-link[data-path="/people"] .badge');
  if (!badge) return;
  badge.style.display = count ? 'inline-block' : 'none';
  badge.textContent = String(count);
}

/** Wraps a view so failures surface instead of leaving a blank page. */
const guard = (render) => async (...args) => {
  if (!store.user) return requireSignIn();
  if (!outlet) mountShell();
  try {
    await store.ensureEssentials();
    await render(outlet, ...args);
    refreshBadges();
  } catch (err) {
    clear(outlet);
    outlet.append(
      emptyState('\u{26A0}', 'Something went wrong', err.message || 'Please try again.',
        el('button', { class: 'btn btn-primary', onclick: () => window.location.reload() }, 'Reload')),
    );
  }
};

function requireSignIn(mode = 'signin') {
  outlet = null;
  renderAuth(appRoot, {
    mode,
    nextPath: currentPath(),
    onSignedIn: async () => {
      store.essentialsLoaded = false;
      await Promise.all([store.loadSession(), store.loadConnections().catch(() => {})]);
      mountShell();
      const pending = sessionStorage.getItem('pendingConnect');
      sessionStorage.removeItem('pendingConnect');
      navigate(pending || '/');
    },
  });
}

route('/', guard(renderDashboard));
route('/transactions', guard(renderTransactions));
route('/budgets', guard(renderBudgets));
route('/accounts', guard(renderAccounts));
route('/plans', guard(renderGoals));
route('/people', guard(renderPeople));
route('/settings', guard(renderSettings));

route('/connect/:token', async ({ token }) => {
  if (!store.user) {
    // Remember where they were headed, then sign in and come back.
    sessionStorage.setItem('pendingConnect', `/connect/${token}`);
    toast('Sign in to connect');
    return requireSignIn('signup');
  }
  if (!outlet) mountShell();
  await renderConnectToken(outlet, token);
});

route('/signin', () => requireSignIn('signin'));
route('/signup', () => requireSignIn('signup'));

setNotFound(() => {
  if (!store.user) return requireSignIn();
  if (!outlet) mountShell();
  clear(outlet);
  outlet.append(
    emptyState('\u{1F9ED}', 'Page not found', 'That link does not go anywhere.',
      el('button', { class: 'btn btn-primary', onclick: () => navigate('/') }, 'Back to overview')),
  );
});

onRouteChange(highlightNav);

async function boot() {
  await store.loadAuthConfig().catch(() => {});
  await store.loadSession();
  if (store.user) {
    await store.loadConnections().catch(() => {});
    mountShell();
  }
  startRouter();
}

boot();
