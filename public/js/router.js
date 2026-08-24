/** Minimal history-API router: patterns like '/transactions' or '/connect/:token'. */
const routes = [];
let notFoundHandler = null;
let onNavigate = null;

export function route(pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern
      .replace(/\/$/, '')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:([a-zA-Z]+)/g, (_m, key) => {
        keys.push(key);
        return '/([^/]+)';
      })}/?$`,
  );
  routes.push({ regex, keys, handler });
}

export const setNotFound = (handler) => {
  notFoundHandler = handler;
};

export const onRouteChange = (fn) => {
  onNavigate = fn;
};

export function navigate(path, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  resolve();
}

export function currentPath() {
  return window.location.pathname.replace(/\/$/, '') || '/';
}

export function resolve() {
  const path = currentPath();
  for (const { regex, keys, handler } of routes) {
    const match = path.match(regex);
    if (match) {
      const params = Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      onNavigate?.(path);
      return handler(params);
    }
  }
  onNavigate?.(path);
  return notFoundHandler?.(path);
}

export function startRouter() {
  window.addEventListener('popstate', resolve);
  // Intercept in-app links so navigation stays client side.
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href^="/"]');
    if (!link || link.target === '_blank' || event.metaKey || event.ctrlKey || link.hasAttribute('data-external')) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });
  resolve();
}
