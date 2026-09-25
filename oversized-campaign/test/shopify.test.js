import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempEnv, startServer, playRound } from './helpers.js';

const SECRET = 'shpss_test_secret';
const KEY = 'test-api-key';
const SHOP = 'oversized-test.myshopify.com';
useTempEnv('shopify', { SHOPIFY_API_KEY: KEY, SHOPIFY_API_SECRET: SECRET, SHOPIFY_SHOP_DOMAIN: SHOP, DEMO_MODE: '0' });

const { botEvents } = await import('../scripts/simulate.js');
const { setShopifyFetch, verifyWebhook, verifyAppProxy, verifySessionToken, buildDiscountInput } = await import('../src/lib/shopify.js');
const { resetRateLimits } = await import('../src/lib/rateLimit.js');
const { db } = await import('../src/db.js');
const { getCampaign } = await import('../src/lib/campaign.js');
const { mintCustomerAssertion } = await import('../src/lib/assertions.js');
const { now } = await import('../src/lib/clock.js');

let h;
const calls = [];
let discountBehaviour = 'ok';
const created = new Map(); // code -> id, i.e. what exists "in Shopify"

function fakeShopify(url, init) {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url, body, headers: init?.headers });
  const json = (status, data) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }));
  if (url.endsWith('/admin/oauth/access_token')) {
    return json(200, { access_token: 'shpat_exchanged', scope: 'write_discounts,read_orders', expires_in: 3600, refresh_token: 'shprt_1', refresh_token_expires_in: 86400 });
  }
  if (url.includes('/graphql.json')) {
    assert.equal(init.headers['x-shopify-access-token'], 'shpat_exchanged');
    if (body.query.includes('discountCodeBasicCreate')) {
      if (discountBehaviour === 'crash-after-create' && created.has(body.variables.input.code)) return json(503, { errors: 'unavailable' });
      const code = body.variables.input.code;
      if (created.has(code)) return json(200, { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount', 'code'], code: 'TAKEN', message: 'Code must be unique' }] } } });
      created.set(code, `gid://shopify/DiscountCodeNode/${created.size + 1}`);
      if (discountBehaviour === 'crash-after-create') return json(503, { errors: 'unavailable' });
      return new Promise((r) => setTimeout(r, 30)).then(() =>
        json(200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id: created.get(code) }, userErrors: [] } } }),
      );
    }
    if (body.query.includes('codeDiscountNodeByCode')) {
      const id = created.get(body.variables.code);
      return json(200, { data: { codeDiscountNodeByCode: id ? { id } : null } });
    }
  }
  return json(404, {});
}

function sessionToken(overrides = {}) {
  const t = Math.floor(now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const payload = enc({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: KEY, sub: '42', exp: t + 60, nbf: t - 5, iat: t, jti: 'x', sid: 'y', ...overrides });
  const sig = crypto.createHmac('sha256', overrides._secret || SECRET).update(`${head}.${payload}`).digest('base64url');
  return `${head}.${payload}.${sig}`;
}

const sign = (raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

async function sendWebhook(topic, payload, { eventId = crypto.randomUUID(), secret = SECRET, rawOverride } = {}) {
  const raw = rawOverride ?? JSON.stringify(payload);
  const res = await fetch(`${h.base}/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': SHOP,
      'x-shopify-hmac-sha256': sign(raw, secret),
      'x-shopify-event-id': eventId,
      'x-shopify-webhook-id': crypto.randomUUID(),
      'x-shopify-api-version': '2026-07',
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  setShopifyFetch(fakeShopify);
  h = await startServer();
  // The first admin request exchanges the session token for an Admin API token.
  const admin = h.client({ bearer: sessionToken() });
  const s = await admin.get('/admin/api/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.adminTokenReady, true);
});
after(() => h.close());
beforeEach(() => resetRateLimits());

async function verifiedWinner(customerId = String(Math.floor(Math.random() * 1e9))) {
  const c = h.client();
  await c.post('/api/session');
  await playRound(c, (seed) => botEvents(seed, 0.95, () => 0.5));
  const link = await c.post('/api/link-customer', { assertion: mintCustomerAssertion(SHOP, customerId) });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  return { c, customerId };
}

test('webhook HMAC is computed over the raw body', () => {
  const raw = Buffer.from('{"id":1,  "note":"spacing matters"}');
  assert.equal(verifyWebhook(raw, sign(raw)), true);
  assert.equal(verifyWebhook(Buffer.from(JSON.stringify(JSON.parse(raw))), sign(raw)), false);
  assert.equal(verifyWebhook(raw, sign(raw, 'wrong')), false);
  assert.equal(verifyWebhook(raw, undefined), false);
});

test('app proxy signature: sorted params, no separator, fresh timestamp', () => {
  const ts = String(Math.floor(now() / 1000));
  const q = { shop: SHOP, path_prefix: '/apps/oversized', timestamp: ts, logged_in_customer_id: '77' };
  const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('');
  const signature = crypto.createHmac('sha256', SECRET).update(msg).digest('hex');
  assert.equal(verifyAppProxy({ ...q, signature }), true);
  assert.equal(verifyAppProxy({ ...q, logged_in_customer_id: '78', signature }), false, 'tampered customer id');
  const old = { ...q, timestamp: String(Number(ts) - 3600) };
  const oldSig = crypto.createHmac('sha256', SECRET).update(Object.keys(old).sort().map((k) => `${k}=${old[k]}`).join('')).digest('hex');
  assert.equal(verifyAppProxy({ ...old, signature: oldSig }), false, 'stale');
});

test('app proxy endpoint mints a customer assertion only for signed requests', async () => {
  const ts = String(Math.floor(now() / 1000));
  const q = { shop: SHOP, path_prefix: '/apps/oversized', timestamp: ts, logged_in_customer_id: '555' };
  const signature = crypto.createHmac('sha256', SECRET).update(Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('')).digest('hex');
  const ok = await fetch(`${h.base}/proxy/customer-assertion?${new URLSearchParams({ ...q, signature })}`);
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.ok(body.assertion);
  const bad = await fetch(`${h.base}/proxy/customer-assertion?${new URLSearchParams({ ...q, signature: '00' })}`);
  assert.equal(bad.status, 401);
  // The assertion works once.
  const c = h.client();
  await c.post('/api/session');
  assert.equal((await c.post('/api/link-customer', { assertion: body.assertion })).status, 200);
  assert.equal((await c.post('/api/link-customer', { assertion: body.assertion })).status, 400);
});

test('admin API requires a valid Shopify session token', async () => {
  assert.equal((await h.client().get('/admin/api/status')).status, 401, 'no token, and no demo admin outside demo mode');
  assert.equal((await h.client({ bearer: sessionToken({ _secret: 'nope' }) }).get('/admin/api/status')).status, 401);
  assert.equal((await h.client({ bearer: sessionToken({ exp: 1 }) }).get('/admin/api/status')).status, 401);
  assert.equal((await h.client({ bearer: sessionToken({ aud: 'other-app' }) }).get('/admin/api/status')).status, 401);
  const other = 'someone-else.myshopify.com';
  assert.equal((await h.client({ bearer: sessionToken({ dest: `https://${other}`, iss: `https://${other}/admin` }) }).get('/admin/api/status')).status, 403);
  assert.ok(verifySessionToken(sessionToken()));
  const exch = calls.find((c) => c.url.endsWith('/admin/oauth/access_token'));
  assert.equal(exch.body.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(exch.body.requested_token_type, 'urn:shopify:params:oauth:token-type:offline-access-token');
  // Stored encrypted, not in clear text.
  const row = db.prepare('SELECT access_token_enc FROM shops').get();
  assert.ok(!row.access_token_enc.includes('shpat_'));
});

test('discount input: one use in total, customer-bound, rules from campaign', () => {
  const campaign = { ...getCampaign(), minimumSubtotal: '300.00', productIds: ['gid://shopify/Product/1'], collectionIds: [], restrictToCustomer: true, combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true } };
  const input = buildDiscountInput(campaign, { code: 'OVS-10-ABC', percent: 10, starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-01-15T00:00:00Z', shopify_customer_id: '9' });
  assert.equal(input.usageLimit, 1);
  assert.equal(input.appliesOncePerCustomer, true);
  assert.deepEqual(input.context, { customers: { add: ['gid://shopify/Customer/9'] } });
  assert.equal(input.customerGets.value.percentage, 0.1);
  assert.deepEqual(input.customerGets.items, { products: { productsToAdd: ['gid://shopify/Product/1'] } });
  assert.deepEqual(input.minimumRequirement, { subtotal: { greaterThanOrEqualToSubtotal: '300.00' } });
  assert.equal(input.combinesWith.shippingDiscounts, true);
  assert.equal(input.endsAt, '2026-01-15T00:00:00Z');
  const open = buildDiscountInput({ ...campaign, productIds: [], restrictToCustomer: false, minimumSubtotal: null }, { code: 'X', percent: 5, starts_at: 'a', ends_at: 'b' });
  assert.deepEqual(open.context, { all: 'ALL' });
  assert.deepEqual(open.customerGets.items, { all: true });
  assert.equal(open.minimumRequirement, undefined);
});

test('concurrent claims create exactly one real discount code', async () => {
  const { c, customerId } = await verifiedWinner();
  const before = calls.filter((x) => x.body?.query?.includes('discountCodeBasicCreate')).length;
  const results = await Promise.all(Array.from({ length: 5 }, () => c.post('/api/rewards/claim')));
  const after = calls.filter((x) => x.body?.query?.includes('discountCodeBasicCreate')).length;
  assert.equal(after - before, 1, 'Shopify called once');
  const rows = db.prepare('SELECT * FROM rewards WHERE shopify_customer_id = ?').all(customerId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'issued');
  assert.match(rows[0].code, /^OVS-/);
  assert.equal(rows[0].demo, 0);
  const call = calls.filter((x) => x.body?.query?.includes('discountCodeBasicCreate')).at(-1);
  assert.equal(call.body.variables.input.usageLimit, 1);
  assert.equal(call.body.variables.input.code, rows[0].code);
  assert.ok(results.every((r) => [200, 202].includes(r.status)));
  const me = await c.get('/api/me');
  assert.equal(me.body.eligibility.reward.code, rows[0].code);
  assert.equal(me.body.eligibility.reward.demo, false);
});

test('a crash after Shopify created the code is recovered without a second code', async () => {
  const { c } = await verifiedWinner();
  discountBehaviour = 'crash-after-create';
  const first = await c.post('/api/rewards/claim');
  assert.equal(first.status, 502);
  const failed = db.prepare("SELECT * FROM rewards WHERE status = 'failed'").get();
  assert.ok(failed);
  assert.ok(db.prepare("SELECT COUNT(*) FROM integration_errors WHERE source = 'discount.create'").pluck().get() >= 1);
  discountBehaviour = 'ok';
  const second = await c.post('/api/rewards/claim');
  assert.equal(second.status, 200);
  const row = db.prepare('SELECT * FROM rewards WHERE id = ?').get(failed.id);
  assert.equal(row.status, 'issued');
  assert.equal(row.shopify_discount_id, created.get(row.code));
});

test('one reward per verified customer, even from a second anonymous profile', async () => {
  const { c, customerId } = await verifiedWinner();
  await c.post('/api/rewards/claim');
  const again = await verifiedWinner(customerId); // new browser, same Shopify customer: merged
  const r = await again.c.post('/api/rewards/claim');
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) FROM rewards WHERE identity = ?').pluck().get(`customer:${customerId}`), 1);
});

test('orders/paid links the redemption by code; redelivery is idempotent; refunds are separate', async () => {
  const { c } = await verifiedWinner();
  const claim = await c.post('/api/rewards/claim');
  const code = claim.body.reward.code;
  const order = {
    id: 820982911946154500,
    admin_graphql_api_id: 'gid://shopify/Order/820982911946154500',
    name: '#1001',
    financial_status: 'paid',
    currency: 'DKK',
    total_price: '449.00',
    updated_at: '2026-09-20T10:00:00+02:00',
    processed_at: '2026-09-20T09:59:00+02:00',
    discount_codes: [{ code: code.toLowerCase(), amount: '49.00', type: 'percentage' }],
    customer: { id: 1 },
  };
  // Refund arrives first (out of order).
  const refund = { id: 999, order_id: order.id, created_at: '2026-09-21T10:00:00+02:00', transactions: [{ kind: 'refund', status: 'success', amount: '100.00', currency: 'DKK' }] };
  assert.equal((await sendWebhook('refunds/create', refund)).status, 200);

  const eventId = crypto.randomUUID();
  assert.deepEqual((await sendWebhook('orders/paid', order, { eventId })).body, { ok: true });
  assert.deepEqual((await sendWebhook('orders/paid', order, { eventId })).body, { duplicate: true });
  // A different delivery of the same order (new event id) still does not double count.
  assert.equal((await sendWebhook('orders/paid', order)).status, 200);

  const reward = db.prepare('SELECT * FROM rewards WHERE code = ?').get(code);
  assert.equal(db.prepare('SELECT COUNT(*) FROM redemptions WHERE reward_id = ?').pluck().get(reward.id), 1);
  const list = await h.client({ bearer: sessionToken() }).get('/admin/api/rewards');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const row = list.body.rewards.find((x) => x.code === code);
  assert.equal(row.redeemed, true);
  assert.equal(row.refunded, true);
  assert.equal(row.redemptions[0].orderName, '#1001');
  assert.equal(row.redemptions[0].refunds[0].amount, '100.00');
  assert.equal(row.status, 'issued', 'refund does not re-activate or change the code');
});

test('an older order snapshot does not overwrite a newer one', async () => {
  const base = { id: 5551, name: '#2001', currency: 'DKK', discount_codes: [] };
  await sendWebhook('orders/paid', { ...base, financial_status: 'partially_refunded', updated_at: '2026-09-22T12:00:00Z' });
  await sendWebhook('orders/paid', { ...base, financial_status: 'paid', updated_at: '2026-09-22T10:00:00Z' });
  assert.equal(db.prepare('SELECT financial_status FROM orders WHERE shopify_order_id = ?').pluck().get('5551'), 'partially_refunded');
});

test('webhooks with a bad signature are rejected and change nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) FROM webhook_events').pluck().get();
  assert.equal((await sendWebhook('orders/paid', { id: 1 }, { secret: 'forged' })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) FROM webhook_events').pluck().get(), before);
});

test('a failing webhook is not marked processed, so Shopify can retry it', async () => {
  const eventId = crypto.randomUUID();
  // A payload the handler cannot process throws inside the transaction.
  const bad = await sendWebhook('refunds/create', { id: 12345, order_id: 5551, transactions: 'garbage' }, { eventId });
  assert.equal(bad.status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) FROM webhook_events WHERE event_id = ?').pluck().get(eventId), 0);
  const errs = await h.client({ bearer: sessionToken() }).get('/admin/api/errors');
  assert.ok(errs.body.errors.some((e) => e.source === 'webhook'));
  const ok = await sendWebhook('refunds/create', { id: 12345, order_id: 5551 }, { eventId });
  assert.equal(ok.status, 200);
});

test('customers/redact removes personal data', async () => {
  const { customerId } = await verifiedWinner();
  await sendWebhook('customers/redact', { shop_domain: SHOP, customer: { id: Number(customerId), email: 'x@example.com' } });
  assert.equal(db.prepare('SELECT COUNT(*) FROM players WHERE shopify_customer_id = ?').pluck().get(customerId), 0);
});
