import test from 'node:test';
import assert from 'node:assert/strict';

// The router is browser code, so stand up the globals it reaches for.
const location = { pathname: '/' };
globalThis.window = { location, addEventListener() {}, history: { pushState() {}, replaceState() {} } };
globalThis.document = { addEventListener() {} };

const { route, resolve, setNotFound } = await import('../public/js/router.js');

const seen = [];
route('/', () => seen.push(['home']));
route('/transactions', () => seen.push(['transactions']));
route('/connect/:token', ({ token }) => seen.push(['connect', token]));
setNotFound((path) => seen.push(['notfound', path]));

const go = (path) => {
  seen.length = 0;
  location.pathname = path;
  resolve();
  return seen[0];
};

test('matches static routes', () => {
  assert.deepEqual(go('/'), ['home']);
  assert.deepEqual(go('/transactions'), ['transactions']);
  assert.deepEqual(go('/transactions/'), ['transactions'], 'a trailing slash still matches');
});

test('matches a parameter route and decodes the value', () => {
  assert.deepEqual(go('/connect/abc123'), ['connect', 'abc123']);
  assert.deepEqual(go('/connect/a-token_with-symbols'), ['connect', 'a-token_with-symbols']);
  assert.deepEqual(go('/connect/a%20b'), ['connect', 'a b']);
});

test('a parameter matches exactly one segment', () => {
  assert.deepEqual(go('/connect'), ['notfound', '/connect']);
  assert.deepEqual(go('/connect/a/b'), ['notfound', '/connect/a/b']);
});

test('unknown paths fall through to the not-found handler', () => {
  assert.deepEqual(go('/nope'), ['notfound', '/nope']);
});
