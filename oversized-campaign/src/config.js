import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const isProd = env.NODE_ENV === 'production';

function requiredInProd(name, fallback) {
  const value = env[name];
  if (value) return value;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return fallback;
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const flag = (v, fallback = false) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const appUrl = (env.APP_URL || `http://localhost:${Number(env.PORT || 4000)}`).replace(/\/$/, '');
const shopifyApiKey = env.SHOPIFY_API_KEY || '';
const shopifyApiSecret = env.SHOPIFY_API_SECRET || '';
const shopDomain = (env.SHOPIFY_SHOP_DOMAIN || '').toLowerCase();

// Demo mode runs everything locally with no Shopify credentials. It is on
// whenever the credentials are missing, and can be forced on explicitly.
// Demo rewards are always labelled as such and never touch a real store.
const demoMode = flag(env.DEMO_MODE, !(shopifyApiKey && shopifyApiSecret && shopDomain));
if (isProd && demoMode && !flag(env.ALLOW_DEMO_IN_PRODUCTION)) {
  throw new Error('DEMO_MODE is on in production. Set the Shopify credentials, or ALLOW_DEMO_IN_PRODUCTION=1 for a public demo.');
}

export const config = {
  rootDir,
  isProd,
  demoMode,
  port: Number(env.PORT || 4000),
  appUrl,
  secureCookies: appUrl.startsWith('https://'),
  databaseFile: env.DATABASE_FILE || path.join(rootDir, 'data', 'campaign.sqlite'),
  // Used to hash session tokens, sign customer assertions and encrypt stored
  // Shopify access tokens. 32+ random bytes.
  appSecret: requiredInProd('APP_SECRET', 'dev-only-insecure-secret-change-me-0123456789'),
  // Storefront origins allowed to call the API with credentials, e.g.
  // https://www.oversizedstudios.com. In demo mode the app's own origin is enough.
  allowedOrigins: [...new Set([appUrl, ...list(env.STOREFRONT_ORIGINS)])],
  // Where the "confirm your email" page sends the player afterwards.
  storefrontReturnUrl: env.STOREFRONT_RETURN_URL || `${appUrl}/play`,
  session: {
    cookieName: appUrl.startsWith('https://') ? '__Host-osg_sid' : 'osg_sid',
    ttlDays: Number(env.SESSION_TTL_DAYS || 180),
    headerTtlHours: 4,
  },
  shopify: {
    apiKey: shopifyApiKey,
    apiSecret: shopifyApiSecret,
    shopDomain,
    apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
    appProxyPrefix: env.SHOPIFY_APP_PROXY_PATH || '/apps/oversized',
    // Optional: a pre-issued Admin API token (for example from the client
    // credentials grant). Normally the token comes from token exchange the
    // first time the embedded admin is opened.
    adminAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN || '',
    get configured() {
      return Boolean(this.apiKey && this.apiSecret && this.shopDomain);
    },
  },
  mail: {
    from: env.MAIL_FROM || 'Oversized Studios <no-reply@example.com>',
    smtpUrl: env.SMTP_URL || '',
  },
  magicLinkTtlMinutes: Number(env.MAGIC_LINK_TTL_MINUTES || 20),
  demoAdmin: flag(env.DEMO_ADMIN, demoMode),
  trustProxy: env.TRUST_PROXY || (isProd ? '1' : 'loopback'),
};
