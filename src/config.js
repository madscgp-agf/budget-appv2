import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isProd = process.env.NODE_ENV === 'production';

function requiredInProd(name, fallback) {
  const value = process.env[name];
  if (value) return value;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return fallback;
}

export const config = {
  rootDir,
  isProd,
  port: Number(process.env.PORT || 3000),
  // Public origin of this app, used to build QR/invite links and the OAuth redirect URI.
  appUrl: (process.env.APP_URL || `http://localhost:${Number(process.env.PORT || 3000)}`).replace(/\/$/, ''),
  databaseFile: process.env.DATABASE_FILE || path.join(rootDir, 'data', 'budget.sqlite'),
  jwt: {
    secret: requiredInProd('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    // Sessions last a week; the cookie and the token expire together.
    ttlSeconds: Number(process.env.JWT_TTL_SECONDS || 60 * 60 * 24 * 7),
    cookieName: 'budget_session',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(this.clientId);
    },
    // The redirect flow additionally needs the secret; One Tap / ID tokens do not.
    get redirectFlowEnabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
  connect: {
    // How long a QR / link connect code stays valid.
    tokenTtlSeconds: Number(process.env.CONNECT_TOKEN_TTL_SECONDS || 60 * 15),
  },
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'USD',
};
