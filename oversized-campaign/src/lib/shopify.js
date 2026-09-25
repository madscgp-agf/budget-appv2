// Everything that talks to Shopify, or verifies something Shopify signed.
// The Admin API token and the app secret never leave the server.
import { config } from '../config.js';
import { db } from '../db.js';
import { now, nowIso } from './clock.js';
import { decrypt, encrypt, hmacBase64, hmacHex, safeEqual } from './crypto.js';
import { recordIntegrationError } from './integrationErrors.js';

let fetchImpl = (...args) => globalThis.fetch(...args);
/** Tests replace the network with a fake. */
export function setShopifyFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const isShopDomain = (s) => typeof s === 'string' && SHOP_RE.test(s);

// ---------------------------------------------------------------- webhooks

/**
 * Webhooks are signed with the app's client secret: base64(HMAC-SHA256(rawBody)).
 * The raw bytes must be used -- re-serialised JSON will not match.
 */
export function verifyWebhook(rawBody, hmacHeader, secret = config.shopify.apiSecret) {
  if (!secret || !hmacHeader || !Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  return safeEqual(hmacBase64(secret, rawBody), hmacHeader);
}

// --------------------------------------------------------------- app proxy

/**
 * App proxy requests carry `signature`: hex HMAC-SHA256 of the other query
 * parameters sorted by key and concatenated as key=value with no separator
 * (repeated keys joined by commas). `timestamp` must be recent.
 */
export function verifyAppProxy(query, secret = config.shopify.apiSecret, toleranceSec = 90) {
  if (!secret || !query || typeof query.signature !== 'string') return false;
  const { signature, ...rest } = query;
  for (const k of ['shop', 'timestamp']) if (Array.isArray(rest[k])) return false;
  const message = Object.keys(rest)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('');
  if (!safeEqual(hmacHex(secret, message), signature)) return false;
  const ts = Number(rest.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now() / 1000 - ts) > toleranceSec) return false;
  return true;
}

// ----------------------------------------------------- admin session token

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * App Bridge session tokens are HS256 JWTs signed with the client secret.
 * Returns the payload and the shop domain, or null when anything is off.
 */
export function verifySessionToken(token, { apiKey = config.shopify.apiKey, secret = config.shopify.apiSecret } = {}) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const expected = Buffer.from(hmacBase64(secret, `${parts[0]}.${parts[1]}`), 'base64').toString('base64url');
  if (!safeEqual(expected, parts[2])) return null;
  const t = now() / 1000;
  const leeway = 10;
  if (typeof payload.exp !== 'number' || payload.exp + leeway < t) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - leeway > t) return null;
  if (payload.aud !== apiKey) return null;
  let shop;
  try {
    shop = new URL(payload.dest).hostname;
  } catch {
    return null;
  }
  if (!isShopDomain(shop)) return null;
  if (payload.iss && !String(payload.iss).startsWith(`https://${shop}`)) return null;
  return { payload, shop };
}

// ------------------------------------------------------ access tokens

/**
 * Token exchange: trade the admin's session token for an expiring offline
 * Admin API token (with a refresh token). Runs the first time the embedded
 * admin is opened, and whenever we have no usable token.
 */
export async function exchangeSessionToken(shop, sessionToken) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  saveToken(shop, await res.json());
}

async function refreshAccessToken(shop, refreshToken) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
  saveToken(shop, await res.json());
}

function saveToken(shop, body) {
  const t = now();
  const exp = body.expires_in ? new Date(t + body.expires_in * 1000).toISOString() : null;
  const rexp = body.refresh_token_expires_in ? new Date(t + body.refresh_token_expires_in * 1000).toISOString() : null;
  db.prepare(
    `INSERT INTO shops (shop, access_token_enc, scope, expires_at, refresh_token_enc, refresh_expires_at, installed_at)
     VALUES (@shop, @at, @scope, @exp, @rt, @rexp, @now)
     ON CONFLICT(shop) DO UPDATE SET access_token_enc=@at, scope=@scope, expires_at=@exp,
       refresh_token_enc=COALESCE(@rt, refresh_token_enc), refresh_expires_at=COALESCE(@rexp, refresh_expires_at),
       uninstalled_at=NULL`,
  ).run({
    shop,
    at: encrypt(body.access_token),
    scope: body.scope || null,
    exp,
    rt: body.refresh_token ? encrypt(body.refresh_token) : null,
    rexp,
    now: nowIso(),
  });
}

export function hasUsableToken(shop) {
  if (config.shopify.adminAccessToken) return true;
  const row = db.prepare('SELECT * FROM shops WHERE shop = ? AND uninstalled_at IS NULL').get(shop);
  if (!row?.access_token_enc) return false;
  if (!row.expires_at || row.expires_at > isoSoon()) return true;
  return Boolean(row.refresh_token_enc && (!row.refresh_expires_at || row.refresh_expires_at > nowIso()));
}

const isoSoon = () => new Date(now() + 60_000).toISOString();

export async function getAdminToken(shop = config.shopify.shopDomain) {
  const row = db.prepare('SELECT * FROM shops WHERE shop = ? AND uninstalled_at IS NULL').get(shop);
  if (row?.access_token_enc && (!row.expires_at || row.expires_at > isoSoon())) return decrypt(row.access_token_enc);
  if (row?.refresh_token_enc && (!row.refresh_expires_at || row.refresh_expires_at > nowIso())) {
    await refreshAccessToken(shop, decrypt(row.refresh_token_enc));
    return decrypt(db.prepare('SELECT access_token_enc FROM shops WHERE shop = ?').pluck().get(shop));
  }
  if (config.shopify.adminAccessToken) return config.shopify.adminAccessToken;
  throw new Error('No Admin API token yet: open the app once in Shopify admin to authorise it');
}

export function markUninstalled(shop) {
  db.prepare('UPDATE shops SET uninstalled_at = ?, access_token_enc = NULL, refresh_token_enc = NULL WHERE shop = ?').run(nowIso(), shop);
}

// ---------------------------------------------------------------- GraphQL

export class ShopifyGraphQLError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

/** POST to the Admin GraphQL API, retrying politely when throttled. */
export async function adminGraphql(query, variables, { shop = config.shopify.shopDomain, retries = 3 } = {}) {
  const token = await getAdminToken(shop);
  const url = `https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),
    });
    const retryable = res.status === 429 || res.status >= 500;
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const throttled = body?.errors?.some?.((e) => e?.extensions?.code === 'THROTTLED');
    if ((retryable || throttled) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new ShopifyGraphQLError(`Admin API HTTP ${res.status}`, body);
    if (body?.errors?.length) throw new ShopifyGraphQLError(body.errors.map((e) => e.message).join('; '), body.errors);
    return body.data;
  }
}

// --------------------------------------------------------------- discounts

const CREATE_DISCOUNT = `
mutation CreateCampaignDiscount($input: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $input) {
    codeDiscountNode { id }
    userErrors { field code message }
  }
}`;

const FIND_DISCOUNT = `
query FindCampaignDiscount($code: String!) {
  codeDiscountNodeByCode(code: $code) { id }
}`;

/** Builds DiscountCodeBasicInput from campaign rules and the reward. */
export function buildDiscountInput(campaign, reward) {
  const items =
    campaign.productIds.length || campaign.collectionIds.length
      ? {
          ...(campaign.productIds.length ? { products: { productsToAdd: campaign.productIds } } : {}),
          ...(campaign.collectionIds.length ? { collections: { add: campaign.collectionIds } } : {}),
        }
      : { all: true };
  const input = {
    title: `Oversized Bench ${reward.percent}% – ${reward.code}`,
    code: reward.code,
    startsAt: reward.starts_at,
    endsAt: reward.ends_at,
    // Exactly one redemption in total, by anyone.
    usageLimit: 1,
    appliesOncePerCustomer: true,
    context:
      campaign.restrictToCustomer && reward.shopify_customer_id
        ? { customers: { add: [`gid://shopify/Customer/${reward.shopify_customer_id}`] } }
        : { all: 'ALL' },
    customerGets: {
      value: { percentage: reward.percent / 100 },
      items,
    },
    combinesWith: campaign.combinesWith,
  };
  if (campaign.minimumSubtotal) {
    input.minimumRequirement = { subtotal: { greaterThanOrEqualToSubtotal: campaign.minimumSubtotal } };
  }
  return input;
}

/**
 * Creates the code in Shopify. Safe to call again for the same reward: if a
 * previous attempt already created the code (and we crashed before saving the
 * id), we look it up instead of creating a second one.
 */
export async function createDiscountCode(campaign, reward) {
  const input = buildDiscountInput(campaign, reward);
  const data = await adminGraphql(CREATE_DISCOUNT, { input });
  const result = data?.discountCodeBasicCreate;
  if (result?.codeDiscountNode?.id) return result.codeDiscountNode.id;
  const errors = result?.userErrors || [];
  const taken = errors.some((e) => e.code === 'TAKEN' || /already|taken|unique/i.test(e.message || ''));
  if (taken) {
    const found = await adminGraphql(FIND_DISCOUNT, { code: reward.code });
    if (found?.codeDiscountNodeByCode?.id) return found.codeDiscountNodeByCode.id;
  }
  throw new ShopifyGraphQLError(errors.map((e) => e.message).join('; ') || 'Discount was not created', errors);
}

export function logShopifyError(source, err) {
  recordIntegrationError(source, err.message, err.details);
}
