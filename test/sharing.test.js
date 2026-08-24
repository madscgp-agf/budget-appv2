import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startServer, signUp } from './helpers.js';

useTempDatabase('sharing');
const harness = await startServer();
test.after(() => harness.close());

const owner = await signUp(harness, { username: 'owner' });
const editor = await signUp(harness, { username: 'editor' });
const viewer = await signUp(harness, { username: 'viewer' });
const stranger = await signUp(harness, { username: 'stranger' });

const accountId = (await owner.client.get('/api/accounts')).body.accounts[0].id;

// Connect through QR so both directions are exercised.
for (const person of [editor, viewer]) {
  const code = await owner.client.post('/api/connections/qr');
  await person.client.post(`/api/connections/qr/${code.body.token}/accept`);
}

test('the owner can share an account at two access levels', async () => {
  assert.equal((await owner.client.post(`/api/accounts/${accountId}/shares`, { username: 'editor', role: 'editor' })).status, 201);
  const shares = await owner.client.post(`/api/accounts/${accountId}/shares`, { username: 'viewer', role: 'viewer' });
  assert.equal(shares.status, 201);
  assert.equal(shares.body.shares.length, 2);
});

test('shared accounts show up for the people they were shared with', async () => {
  const shared = (await editor.client.get('/api/accounts')).body.accounts.find((a) => a.id === accountId);
  assert.equal(shared.role, 'editor');
  assert.equal(shared.owner.username, 'owner');
});

test('an editor can add transactions to a shared account', async () => {
  const created = await editor.client.post('/api/transactions', {
    accountId,
    amount: 20,
    type: 'expense',
    description: 'Shared lunch',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.transaction.createdBy, 'editor');

  // The owner sees it, attributed to whoever entered it.
  const ownerSees = (await owner.client.get('/api/transactions?q=Shared lunch')).body.transactions;
  assert.equal(ownerSees.length, 1);
  assert.equal(ownerSees[0].createdBy, 'editor');
});

test('a viewer can read but not write', async () => {
  assert.equal((await viewer.client.get('/api/transactions?q=Shared lunch')).body.transactions.length, 1);

  const blocked = await viewer.client.post('/api/transactions', {
    accountId,
    amount: 5,
    type: 'expense',
    description: 'Not allowed',
  });
  assert.equal(blocked.status, 403);
});

test('only the owner can rename, delete or re-share the account', async () => {
  assert.equal((await editor.client.patch(`/api/accounts/${accountId}`, { name: 'Hijacked' })).status, 403);
  assert.equal((await editor.client.del(`/api/accounts/${accountId}`)).status, 403);
  assert.equal((await editor.client.post(`/api/accounts/${accountId}/shares`, { username: 'stranger' })).status, 403);
});

test('someone with no share cannot see the account at all', async () => {
  assert.equal((await stranger.client.get('/api/accounts')).body.accounts.length, 1);
  assert.equal((await stranger.client.get(`/api/accounts/${accountId}`)).status, 404);
  assert.equal((await stranger.client.get('/api/transactions?q=Shared lunch')).body.transactions.length, 0);
  assert.equal(
    (await stranger.client.post('/api/transactions', { accountId, amount: 5, type: 'expense', description: 'Nope' })).status,
    404,
  );
});

test('a shared account cannot be edited through another user category', async () => {
  const strangersCategory = (await stranger.client.get('/api/categories')).body.categories[0];
  const res = await editor.client.post('/api/transactions', {
    accountId,
    categoryId: strangersCategory.id,
    amount: 5,
    type: 'expense',
    description: 'Wrong category',
  });
  assert.equal(res.status, 404);
});

test('a recipient can leave a shared account themselves', async () => {
  assert.equal((await viewer.client.del(`/api/accounts/${accountId}/shares/viewer`)).status, 200);
  assert.equal((await viewer.client.get('/api/accounts')).body.accounts.length, 1);
});

test('the owner can revoke a share', async () => {
  assert.equal((await owner.client.del(`/api/accounts/${accountId}/shares/editor`)).status, 200);
  assert.equal((await editor.client.get('/api/accounts')).body.accounts.length, 1);
  assert.equal((await editor.client.get('/api/transactions?q=Shared lunch')).body.transactions.length, 0);
});

test('deleting a user removes their data', async () => {
  const doomed = await signUp(harness, { username: 'doomed' });
  await doomed.client.post('/api/goals', { name: 'Gone soon', target: 10 });
  assert.equal((await doomed.client.del('/api/users/me')).status, 200);
  assert.equal((await doomed.client.get('/api/users/me')).status, 401);

  const reuse = harness.client();
  assert.equal((await reuse.post('/api/auth/register', { username: 'doomed', email: 'doomed@example.com', password: 'password123' })).status, 201);
});
