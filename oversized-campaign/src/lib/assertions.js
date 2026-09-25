import { db } from '../db.js';
import { now, nowIso } from './clock.js';
import { hmacHex, randomToken, safeEqual } from './crypto.js';
import { config } from '../config.js';

// A short-lived statement "the storefront visitor is logged in as Shopify
// customer N", minted by the app proxy route after verifying Shopify's
// signature. The browser carries it from the shop domain to the API; it is
// single-use and expires after two minutes.
const TTL_MS = 120_000;

export function mintCustomerAssertion(shop, customerId) {
  const body = Buffer.from(JSON.stringify({ shop, cid: String(customerId), exp: now() + TTL_MS, n: randomToken(12) })).toString('base64url');
  return `${body}.${hmacHex(config.appSecret, `ca:${body}`)}`;
}

/** Returns { shop, customerId } once, or null. */
export function consumeCustomerAssertion(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(hmacHex(config.appSecret, `ca:${body}`), sig)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < now()) return null;
  const ins = db.prepare('INSERT INTO used_nonces (nonce, used_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING').run(data.n, nowIso());
  if (ins.changes === 0) return null;
  return { shop: data.shop, customerId: data.cid };
}
