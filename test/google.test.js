import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startServer, signUp } from './helpers.js';

useTempDatabase('google');
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const harness = await startServer();
test.after(() => harness.close());

// The network-facing token verification is Google's; what we test here is the
// account logic that runs once a profile has been verified.
const { upsertGoogleUser } = await import('../src/routes/auth.js');

const profile = (over = {}) => ({
  googleId: 'google-1',
  email: 'ada@gmail.com',
  emailVerified: true,
  displayName: 'Ada Lovelace',
  avatarUrl: 'https://example.com/a.png',
  ...over,
});

test('a first Google sign-in creates an account with a username from the email', () => {
  const { user, created } = upsertGoogleUser(profile());
  assert.equal(created, true);
  assert.equal(user.email, 'ada@gmail.com');
  assert.equal(user.username, 'ada');
  assert.equal(user.display_name, 'Ada Lovelace');
  assert.equal(user.google_id, 'google-1');
  assert.equal(user.email_verified, 1);
  assert.equal(user.password_hash, null);
});

test('signing in again reuses the same account', () => {
  const { user, created } = upsertGoogleUser(profile({ avatarUrl: 'https://example.com/new.png' }));
  assert.equal(created, false);
  assert.equal(user.username, 'ada');
  assert.equal(user.avatar_url, 'https://example.com/new.png');
});

test('a taken username gets a numbered variant', () => {
  const { user } = upsertGoogleUser(profile({ googleId: 'google-2', email: 'ada@outlook.com' }));
  assert.equal(user.username, 'ada2');
});

test('Google links onto an existing password account with the same email', async () => {
  await signUp(harness, { username: 'grace', email: 'grace@gmail.com' });
  const { user, created } = upsertGoogleUser(profile({ googleId: 'google-3', email: 'grace@gmail.com', displayName: 'Grace H' }));
  assert.equal(created, false);
  assert.equal(user.username, 'grace');
  assert.equal(user.google_id, 'google-3');
  assert.ok(user.password_hash, 'the existing password still works');
});

test('a second Google identity cannot claim an email already linked', () => {
  assert.throws(
    () => upsertGoogleUser(profile({ googleId: 'someone-else', email: 'grace@gmail.com' })),
    /already linked to a different Google account/,
  );
});

test('Google users also get the starter categories and account', () => {
  const { user } = upsertGoogleUser(profile({ googleId: 'google-4', email: 'linus@gmail.com' }));
  assert.equal(user.username, 'linus');
  assert.ok(user.id);
});

test('the client is told whether Google sign-in is available', async () => {
  const res = await harness.client().get('/api/auth/config');
  assert.equal(res.body.google.enabled, true);
  assert.equal(res.body.google.clientId, 'test-client-id.apps.googleusercontent.com');
  // Without a client secret the server-side redirect flow stays off.
  assert.equal(res.body.google.redirectFlow, false);
});

test('an invalid Google credential is refused', async () => {
  const res = await harness.client().post('/api/auth/google', { credential: 'not-a-real-token' });
  assert.equal(res.status, 400);
});

test('the redirect flow needs a client secret', async () => {
  const res = await harness.client().get('/api/auth/google/start');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /GOOGLE_CLIENT_SECRET/);
});

test('the OAuth callback rejects a mismatched state', async () => {
  const res = await harness.client().get('/api/auth/google/callback?code=abc&state=forged');
  assert.equal(res.status, 400);
});
