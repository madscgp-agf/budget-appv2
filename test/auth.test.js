import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startServer, signUp } from './helpers.js';

useTempDatabase('auth');
const harness = await startServer();
test.after(() => harness.close());

test('registers a user and returns a session', async () => {
  const { client, user } = await signUp(harness, { username: 'ada' });
  assert.equal(user.username, 'ada');
  assert.equal(user.hasPassword, true);
  assert.equal(user.linkedGoogle, false);

  const me = await client.get('/api/users/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'ada');
});

test('rejects a duplicate email or username', async () => {
  const client = harness.client();
  const dupeEmail = await client.post('/api/auth/register', {
    username: 'ada2',
    email: 'ada@example.com',
    password: 'password123',
  });
  assert.equal(dupeEmail.status, 409);

  const dupeUsername = await client.post('/api/auth/register', {
    username: 'ada',
    email: 'other@example.com',
    password: 'password123',
  });
  assert.equal(dupeUsername.status, 409);
});

test('validates weak input', async () => {
  const client = harness.client();
  const short = await client.post('/api/auth/register', { username: 'bo', email: 'bo@example.com', password: 'password123' });
  assert.equal(short.status, 400);

  const weak = await client.post('/api/auth/register', { username: 'bobby', email: 'bo@example.com', password: 'short' });
  assert.equal(weak.status, 400);
});

test('signs in with either email or username, and rejects a bad password', async () => {
  const byEmail = harness.client();
  assert.equal((await byEmail.post('/api/auth/login', { identifier: 'ada@example.com', password: 'password123' })).status, 200);

  const byUsername = harness.client();
  assert.equal((await byUsername.post('/api/auth/login', { identifier: 'ada', password: 'password123' })).status, 200);

  const wrong = harness.client();
  assert.equal((await wrong.post('/api/auth/login', { identifier: 'ada', password: 'nope-nope-nope' })).status, 401);
});

test('signing out clears the session', async () => {
  const { client } = await signUp(harness, { username: 'grace' });
  await client.post('/api/auth/logout');
  assert.equal((await client.get('/api/users/me')).status, 401);
});

test('username availability reflects what is taken', async () => {
  const client = harness.client();
  assert.equal((await client.get('/api/auth/username-available?username=ada')).body.available, false);
  assert.equal((await client.get('/api/auth/username-available?username=freename')).body.available, true);
  assert.equal((await client.get('/api/auth/username-available?username=no')).body.available, false);
});

test('new users start with categories and an account', async () => {
  const { client } = await signUp(harness, { username: 'linus' });
  const categories = await client.get('/api/categories');
  assert.ok(categories.body.categories.length > 4);
  const accounts = await client.get('/api/accounts');
  assert.equal(accounts.body.accounts.length, 1);
  assert.equal(accounts.body.accounts[0].role, 'owner');
});

test('protected endpoints require a session', async () => {
  const anon = harness.client();
  for (const path of ['/api/users/me', '/api/accounts', '/api/transactions', '/api/budgets', '/api/connections']) {
    assert.equal((await anon.get(path)).status, 401, `${path} should require auth`);
  }
});

test('a password can be set and changed', async () => {
  const { client } = await signUp(harness, { username: 'katherine' });
  const wrongCurrent = await client.post('/api/auth/password', { currentPassword: 'wrong-one', newPassword: 'brand-new-pass' });
  assert.equal(wrongCurrent.status, 401);

  const changed = await client.post('/api/auth/password', { currentPassword: 'password123', newPassword: 'brand-new-pass' });
  assert.equal(changed.status, 200);

  const fresh = harness.client();
  assert.equal((await fresh.post('/api/auth/login', { identifier: 'katherine', password: 'brand-new-pass' })).status, 200);
});
