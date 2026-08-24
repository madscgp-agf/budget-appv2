import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startServer, signUp } from './helpers.js';

useTempDatabase('connections');
const harness = await startServer();
test.after(() => harness.close());

const ada = await signUp(harness, { username: 'ada' });
const grace = await signUp(harness, { username: 'grace' });
const linus = await signUp(harness, { username: 'linus' });

test('finds people by username, excluding yourself', async () => {
  const found = await ada.client.get('/api/connections/search?q=grace');
  assert.equal(found.body.results.length, 1);
  assert.equal(found.body.results[0].username, 'grace');

  const self = await ada.client.get('/api/connections/search?q=ada');
  assert.equal(self.body.results.length, 0);
});

test('connects two people by username, with an accept step', async () => {
  const sent = await ada.client.post('/api/connections/requests', { username: 'grace' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.connection.status, 'pending');
  assert.equal(sent.body.connection.direction, 'outgoing');

  const gracesView = await grace.client.get('/api/connections');
  assert.equal(gracesView.body.incoming.length, 1);
  assert.equal(gracesView.body.incoming[0].user.username, 'ada');

  const accepted = await grace.client.post(`/api/connections/${gracesView.body.incoming[0].id}/accept`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.connection.status, 'accepted');

  const adasView = await ada.client.get('/api/connections');
  assert.equal(adasView.body.connected.length, 1);
  assert.equal(adasView.body.connected[0].user.username, 'grace');
  assert.equal(adasView.body.connected[0].origin, 'username');
});

test('rejects duplicate, self and unknown requests', async () => {
  assert.equal((await ada.client.post('/api/connections/requests', { username: 'grace' })).status, 409);
  assert.equal((await ada.client.post('/api/connections/requests', { username: 'ada' })).status, 400);
  assert.equal((await ada.client.post('/api/connections/requests', { username: 'nobody' })).status, 404);
});

test('a request in the other direction is accepted rather than duplicated', async () => {
  await linus.client.post('/api/connections/requests', { username: 'ada' });
  const mirrored = await ada.client.post('/api/connections/requests', { username: 'linus' });
  assert.equal(mirrored.status, 200);
  assert.equal(mirrored.body.connection.status, 'accepted');
});

test('connects instantly through a QR token', async () => {
  const alan = await signUp(harness, { username: 'alan' });
  const code = await alan.client.post('/api/connections/qr');
  assert.equal(code.status, 201);
  assert.match(code.body.qr, /^data:image\/png;base64,/);
  assert.match(code.body.url, /\/connect\/[A-Za-z0-9_-]+$/);
  assert.equal(code.body.username, 'alan');

  const preview = await grace.client.get(`/api/connections/qr/${code.body.token}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.user.username, 'alan');
  assert.equal(preview.body.isSelf, false);
  assert.equal(preview.body.alreadyConnected, false);

  const connected = await grace.client.post(`/api/connections/qr/${code.body.token}/accept`);
  assert.equal(connected.status, 201);
  assert.equal(connected.body.connection.status, 'accepted');
  assert.equal(connected.body.connection.origin, 'qr');

  const alansView = await alan.client.get('/api/connections');
  assert.ok(alansView.body.connected.some((c) => c.user.username === 'grace'));
});

test('a QR token is single use, and cannot be redeemed by its owner', async () => {
  const mary = await signUp(harness, { username: 'mary' });
  const code = await mary.client.post('/api/connections/qr');

  assert.equal((await mary.client.get(`/api/connections/qr/${code.body.token}`)).body.isSelf, true);
  assert.equal((await mary.client.post(`/api/connections/qr/${code.body.token}/accept`)).status, 400);

  assert.equal((await linus.client.post(`/api/connections/qr/${code.body.token}/accept`)).status, 201);
  assert.equal((await ada.client.post(`/api/connections/qr/${code.body.token}/accept`)).status, 400);
});

test('an unknown QR token is rejected', async () => {
  assert.equal((await ada.client.get('/api/connections/qr/not-a-real-token')).status, 404);
});

test('declining leaves no connection, and it can be re-sent later', async () => {
  const bob = await signUp(harness, { username: 'bob' });
  await bob.client.post('/api/connections/requests', { username: 'ada' });
  const incoming = (await ada.client.get('/api/connections')).body.incoming.find((c) => c.user.username === 'bob');
  await ada.client.post(`/api/connections/${incoming.id}/decline`);

  const after = await ada.client.get('/api/connections');
  assert.equal(after.body.incoming.filter((c) => c.user.username === 'bob').length, 0);

  const resent = await bob.client.post('/api/connections/requests', { username: 'ada' });
  assert.equal(resent.status, 201);
});

test('removing a connection also revokes shared accounts', async () => {
  const owner = await signUp(harness, { username: 'owner' });
  const guest = await signUp(harness, { username: 'guest' });

  const code = await owner.client.post('/api/connections/qr');
  await guest.client.post(`/api/connections/qr/${code.body.token}/accept`);

  const account = (await owner.client.get('/api/accounts')).body.accounts[0];
  assert.equal((await owner.client.post(`/api/accounts/${account.id}/shares`, { username: 'guest', role: 'editor' })).status, 201);
  assert.equal((await guest.client.get('/api/accounts')).body.accounts.length, 2);

  const connection = (await owner.client.get('/api/connections')).body.connected.find((c) => c.user.username === 'guest');
  await owner.client.del(`/api/connections/${connection.id}`);

  assert.equal((await guest.client.get('/api/accounts')).body.accounts.length, 1);
});

test('sharing requires an existing connection', async () => {
  const solo = await signUp(harness, { username: 'solo' });
  const account = (await solo.client.get('/api/accounts')).body.accounts[0];
  const res = await solo.client.post(`/api/accounts/${account.id}/shares`, { username: 'ada', role: 'viewer' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Connect with them first/);
});

test('people who opt out of discovery stay out of search but keep QR', async () => {
  const hidden = await signUp(harness, { username: 'hidden' });
  await hidden.client.patch('/api/users/me', { discoverable: false });

  assert.equal((await ada.client.get('/api/connections/search?q=hidden')).body.results.length, 0);

  const code = await hidden.client.post('/api/connections/qr');
  assert.equal((await ada.client.post(`/api/connections/qr/${code.body.token}/accept`)).status, 201);
});
