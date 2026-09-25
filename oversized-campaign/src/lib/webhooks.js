import { config } from '../config.js';
import { db, tx } from '../db.js';
import { nowIso } from './clock.js';
import { recordIntegrationError } from './integrationErrors.js';
import { markUninstalled, verifyWebhook } from './shopify.js';

const handlers = {
  'orders/paid': onOrderPaid,
  'refunds/create': onRefundCreated,
  'app/uninstalled': (_payload, shop) => markUninstalled(shop),
  'customers/data_request': onDataRequest,
  'customers/redact': onCustomerRedact,
  'shop/redact': onShopRedact,
};

export const WEBHOOK_TOPICS = Object.keys(handlers);

/**
 * Verify, de-duplicate and process one webhook delivery.
 * Returns { status, body } for the HTTP response.
 *
 *  - Signature is checked against the raw request bytes.
 *  - Shopify retries until it gets a 2xx and may deliver the same event more
 *    than once; X-Shopify-Event-Id (stable across retries) is stored in the
 *    same transaction as the side effects, so a duplicate is a no-op.
 *  - If processing throws, the transaction (including the event id) rolls
 *    back and we answer 500 so Shopify retries later.
 */
export function handleWebhook(rawBody, headers) {
  const get = (h) => headers[h.toLowerCase()];
  if (!verifyWebhook(rawBody, get('x-shopify-hmac-sha256'))) return { status: 401, body: { error: 'invalid signature' } };

  const topic = get('x-shopify-topic');
  const shop = get('x-shopify-shop-domain');
  const eventId = get('x-shopify-event-id') || get('x-shopify-webhook-id');
  if (!topic || !eventId) return { status: 400, body: { error: 'missing headers' } };
  if (config.shopify.shopDomain && shop && shop !== config.shopify.shopDomain) {
    return { status: 200, body: { ignored: 'other shop' } };
  }
  const handler = handlers[topic];
  if (!handler) return { status: 200, body: { ignored: 'unhandled topic' } };

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    recordIntegrationError('webhook', `Unparseable ${topic} body`, { eventId });
    return { status: 400, body: { error: 'invalid json' } };
  }

  try {
    const duplicate = tx(() => {
      const ins = db
        .prepare(
          `INSERT INTO webhook_events (event_id, webhook_id, topic, shop, triggered_at, received_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(String(eventId), get('x-shopify-webhook-id') || null, topic, shop || null, get('x-shopify-triggered-at') || null, nowIso());
      if (ins.changes === 0) return true;
      handler(payload, shop);
      return false;
    });
    return { status: 200, body: duplicate ? { duplicate: true } : { ok: true } };
  } catch (err) {
    recordIntegrationError('webhook', `${topic} failed: ${err.message}`, { eventId, orderId: payload?.id });
    return { status: 500, body: { error: 'processing failed' } };
  }
}

const newer = (a, b) => !b || (a && a >= b);

function onOrderPaid(order) {
  const orderId = String(order.id);
  const existing = db.prepare('SELECT * FROM orders WHERE shopify_order_id = ?').get(orderId);
  const updatedAt = order.updated_at ? new Date(order.updated_at).toISOString() : null;
  // Out-of-order safe: only overwrite order details with a newer snapshot.
  if (!existing || newer(updatedAt, existing.shopify_updated_at)) {
    db.prepare(
      `INSERT INTO orders (shopify_order_id, admin_graphql_id, name, financial_status, currency, total_price, customer_id,
         shopify_updated_at, received_at)
       VALUES (@id, @gid, @name, @fs, @cur, @total, @cust, @upd, @now)
       ON CONFLICT(shopify_order_id) DO UPDATE SET admin_graphql_id=@gid, name=@name, financial_status=@fs, currency=@cur,
         total_price=@total, customer_id=@cust, shopify_updated_at=@upd`,
    ).run({
      id: orderId,
      gid: order.admin_graphql_api_id || `gid://shopify/Order/${orderId}`,
      name: order.name || null,
      fs: order.financial_status || 'paid',
      cur: order.currency || null,
      total: order.total_price ?? null,
      cust: order.customer?.id ? String(order.customer.id) : null,
      upd: updatedAt,
      now: nowIso(),
    });
  }

  // Link by code. The player's cookie is not available at checkout, and it
  // does not need to be: the code itself is the link to the reward.
  const findReward = db.prepare('SELECT * FROM rewards WHERE code = ? COLLATE NOCASE AND demo = 0');
  for (const dc of order.discount_codes || []) {
    if (!dc?.code) continue;
    const reward = findReward.get(String(dc.code).trim());
    if (!reward) continue;
    db.prepare(
      `INSERT INTO redemptions (reward_id, shopify_order_id, code, amount, currency, redeemed_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(reward_id, shopify_order_id) DO NOTHING`,
    ).run(
      reward.id,
      orderId,
      reward.code,
      dc.amount ?? null,
      order.currency || null,
      order.processed_at ? new Date(order.processed_at).toISOString() : nowIso(),
    );
  }
}

function onRefundCreated(refund) {
  // Stored on its own and joined to the order by id. It may arrive before the
  // order webhook; the admin view links them whenever both exist. A refund
  // never re-enables a used code.
  const txs = (refund.transactions || []).filter((t) => t.kind === 'refund' && t.status === 'success');
  const amount = txs.length ? txs.reduce((sum, t) => sum + Number(t.amount || 0), 0).toFixed(2) : null;
  db.prepare(
    `INSERT INTO refunds (shopify_refund_id, shopify_order_id, amount, currency, refunded_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(shopify_refund_id) DO NOTHING`,
  ).run(
    String(refund.id),
    String(refund.order_id),
    amount,
    txs[0]?.currency || null,
    refund.created_at ? new Date(refund.created_at).toISOString() : null,
    nowIso(),
  );
}

function onDataRequest(payload) {
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
  recordIntegrationError('compliance', 'customers/data_request received – export player data for this customer', {
    customerId,
    ordersRequested: payload?.orders_requested,
  });
}

function onCustomerRedact(payload) {
  const customerId = payload?.customer?.id ? String(payload.customer.id) : null;
  const email = payload?.customer?.email ? String(payload.customer.email).toLowerCase() : null;
  db.prepare(
    `UPDATE players SET email = NULL, email_lower = NULL, email_verified_at = NULL, shopify_customer_id = NULL,
       alias = NULL, alias_lower = NULL, leaderboard_opt_in = 0, marketing_opt_in = 0
     WHERE (shopify_customer_id IS NOT NULL AND shopify_customer_id = ?) OR (email_lower IS NOT NULL AND email_lower = ?)`,
  ).run(customerId, email);
  db.prepare('UPDATE rewards SET shopify_customer_id = NULL, identity = NULL WHERE shopify_customer_id = ? OR identity = ?').run(
    customerId,
    email ? `email:${email}` : null,
  );
  db.prepare('UPDATE orders SET customer_id = NULL WHERE customer_id = ?').run(customerId);
}

function onShopRedact() {
  db.exec('DELETE FROM redemptions; DELETE FROM refunds; DELETE FROM orders;');
  db.prepare('DELETE FROM shops').run();
}
