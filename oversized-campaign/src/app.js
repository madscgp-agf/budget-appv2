import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError, forbidden } from './lib/errors.js';
import { limitByIp } from './lib/rateLimit.js';
import { playerRouter } from './routes/player.js';
import { roundsRouter } from './routes/rounds.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { rewardsRouter } from './routes/rewards.js';
import { adminRouter } from './routes/admin.js';
import { proxyRouter } from './routes/proxy.js';
import { webhooksRouter } from './routes/webhooks.js';

const pub = (...p) => path.join(config.rootDir, 'public', ...p);

// Storefront origins may call /api with credentials. Everything that changes
// state must come from an allowed origin (or carry no Origin at all, which
// browsers never do for cross-site fetches) and be JSON, which forces a CORS
// preflight. Together with SameSite=Lax this closes the CSRF door.
function apiCors(req, res, next) {
  const origin = req.get('origin');
  const allowed = origin && config.allowedOrigins.includes(origin);
  if (allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'content-type, authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.set('Access-Control-Max-Age', '600');
  }
  res.vary('Origin');
  if (req.method === 'OPTIONS') return res.status(allowed ? 204 : 403).end();
  if (req.method !== 'GET') {
    if (origin && !allowed) return next(forbidden('Origin ikke tilladt'));
    if (!req.is('application/json')) return next(new HttpError(415, 'Forventer JSON'));
  }
  res.set('Cache-Control', 'no-store');
  next();
}

function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

function page(file, { frameAncestors = "'none'", extraScript = '', replace = {} } = {}) {
  return (_req, res) => {
    let html = fs.readFileSync(pub(file), 'utf8');
    for (const [k, v] of Object.entries(replace)) html = html.replaceAll(k, v);
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self'${extraScript}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'" + (extraScript ? ' https://*.shopify.com https://*.myshopify.com' : ''),
        "worker-src 'self' blob:",
        `frame-ancestors ${frameAncestors}`,
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    );
    res.type('html').send(html);
  };
}

const escapeAttr = (s) => String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  app.get('/health', (_req, res) => res.json({ ok: true, demoMode: config.demoMode }));

  // Webhooks first: they need the raw body, not parsed JSON.
  app.use('/webhooks', webhooksRouter);
  app.use('/proxy', proxyRouter);

  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());

  app.use('/api', apiCors, limitByIp('api', 240, 60_000));
  app.use('/api', playerRouter);
  app.use('/api/rounds', roundsRouter);
  app.use('/api/leaderboard', leaderboardRouter);
  app.use('/api/rewards', rewardsRouter);
  app.use('/admin/api', adminRouter);

  // Pages
  app.get('/', (_req, res) => res.redirect('/play'));
  app.get('/play', page('play.html'));
  app.get('/verify', (req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    page('verify.html', { replace: { '%%RETURN_URL%%': escapeAttr(config.storefrontReturnUrl) } })(req, res, next);
  });
  const shopAncestors = config.shopify.shopDomain ? `https://${config.shopify.shopDomain} https://admin.shopify.com` : 'https://admin.shopify.com';
  app.get(
    '/admin',
    page('admin/index.html', {
      frameAncestors: config.demoMode ? "'self'" : shopAncestors,
      extraScript: ' https://cdn.shopify.com',
      replace: {
        '%%SHOPIFY_API_KEY%%': escapeAttr(config.shopify.apiKey || 'demo'),
        '%%DEMO%%': config.demoMode ? '1' : '0',
        // App Bridge must be the first script, loaded synchronously from Shopify's CDN.
        '%%APP_BRIDGE%%': config.demoMode ? '' : '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>',
      },
    }),
  );

  // Static files. The game bundle is the same file the theme extension ships.
  app.use('/assets', express.static(path.join(config.rootDir, 'extensions', 'oversized-game', 'assets'), { maxAge: config.isProd ? '1h' : 0 }));
  app.use(express.static(pub(), { index: false, extensions: [] }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ukendt endpoint' }));

  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message || 'Ugyldige data', details: err.issues });
    }
    if (err instanceof HttpError) {
      if (err.status === 429 && err.details?.retryAfterSeconds) res.set('Retry-After', String(err.details.retryAfterSeconds));
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ugyldig JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'For stor forespørgsel' });
    console.error(err);
    res.status(500).json({ error: 'Noget gik galt hos os' });
  });

  return app;
}
