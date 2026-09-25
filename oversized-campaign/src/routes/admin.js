import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../db.js';
import { nowIso } from '../lib/clock.js';
import { asyncRoute, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { getCampaign, updateCampaign } from '../lib/campaign.js';
import { recordIntegrationError } from '../lib/integrationErrors.js';
import { exchangeSessionToken, hasUsableToken, verifySessionToken } from '../lib/shopify.js';
import { issue } from '../lib/rewards.js';
import { maskEmail } from '../lib/players.js';

export const adminRouter = Router();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocalRequest(req) {
  return LOOPBACK.has(req.socket.remoteAddress) && !req.get('x-forwarded-for');
}

/**
 * Admin requests must carry an App Bridge session token (a JWT signed with
 * the app secret, issued by Shopify to a logged-in staff member of the shop).
 * In demo mode, and only from the local machine, a labelled demo admin is
 * allowed instead so the admin can be tried without a store.
 */
export const requireAdmin = asyncRoute(async (req, _res, next) => {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ') && !auth.startsWith('Bearer osg_') && config.shopify.apiSecret) {
    const token = auth.slice(7);
    const v = verifySessionToken(token);
    if (!v) throw unauthorized('Ugyldig Shopify-session');
    if (config.shopify.shopDomain && v.shop !== config.shopify.shopDomain) throw forbidden('Forkert butik');
    req.shop = v.shop;
    req.adminUser = v.payload.sub;
    if (!hasUsableToken(v.shop)) {
      try {
        await exchangeSessionToken(v.shop, token);
      } catch (err) {
        recordIntegrationError('auth.token_exchange', err.message);
      }
    }
    return next();
  }
  if (config.demoMode && config.demoAdmin && isLocalRequest(req)) {
    req.shop = 'demo';
    req.demoAdmin = true;
    return next();
  }
  throw unauthorized('Åbn appen fra Shopify admin');
});

adminRouter.use(requireAdmin);

adminRouter.get('/status', (req, res) => {
  res.json({
    demoMode: config.demoMode,
    demoAdmin: Boolean(req.demoAdmin),
    shop: req.shop,
    shopifyConfigured: config.shopify.configured,
    apiVersion: config.shopify.apiVersion,
    adminTokenReady: config.demoMode ? false : hasUsableToken(req.shop),
    unresolvedErrors: db.prepare('SELECT COUNT(*) FROM integration_errors WHERE resolved_at IS NULL').pluck().get(),
  });
});

adminRouter.get('/overview', (_req, res) => {
  const one = (sql, ...a) => db.prepare(sql).pluck().get(...a);
  res.json({
    players: one('SELECT COUNT(*) FROM players WHERE merged_into IS NULL'),
    verifiedPlayers: one('SELECT COUNT(*) FROM players WHERE merged_into IS NULL AND (email_verified_at IS NOT NULL OR shopify_customer_id IS NOT NULL)'),
    rounds: one("SELECT COUNT(*) FROM rounds WHERE status = 'verified'"),
    rejectedRounds: one("SELECT COUNT(*) FROM rounds WHERE status = 'rejected'"),
    flaggedRounds: one("SELECT COUNT(*) FROM rounds WHERE flags IS NOT NULL"),
    bestScore: one("SELECT MAX(score) FROM rounds WHERE status = 'verified'") || 0,
    rewardsIssued: one("SELECT COUNT(*) FROM rewards WHERE status = 'issued' AND demo = 0"),
    demoRewards: one('SELECT COUNT(*) FROM rewards WHERE demo = 1'),
    rewardsFailed: one("SELECT COUNT(*) FROM rewards WHERE status = 'failed'"),
    redeemed: one('SELECT COUNT(DISTINCT reward_id) FROM redemptions'),
    refundedOrders: one('SELECT COUNT(DISTINCT r.shopify_order_id) FROM refunds r JOIN redemptions d ON d.shopify_order_id = r.shopify_order_id'),
  });
});

adminRouter.get('/campaign', (_req, res) => res.json(getCampaign()));
adminRouter.put('/campaign', (req, res) => res.json(updateCampaign(req.body)));

adminRouter.get('/rounds', (req, res) => {
  const status = ['verified', 'rejected', 'open', 'expired'].includes(req.query.status) ? req.query.status : null;
  const rows = db
    .prepare(
      `SELECT r.id, r.player_id, p.alias, r.status, r.started_at, r.submitted_at, r.score, r.approved_reps, r.clean_reps,
              r.top_kg, r.avg_quality, r.reject_reason, r.flags, r.rules_version, r.campaign_id
       FROM rounds r JOIN players p ON p.id = r.player_id
       ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.started_at DESC LIMIT 200`,
    )
    .all(...(status ? [status] : []));
  res.json({ rounds: rows });
});

adminRouter.get('/players', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, alias, alias_hidden, leaderboard_opt_in, email, email_verified_at, shopify_customer_id, marketing_opt_in,
              best_score, rounds_played, created_at, last_seen_at
       FROM players WHERE merged_into IS NULL ORDER BY last_seen_at DESC LIMIT 200`,
    )
    .all();
  res.json({
    players: rows.map((p) => ({
      id: p.id,
      alias: p.alias,
      aliasHidden: Boolean(p.alias_hidden),
      leaderboardOptIn: Boolean(p.leaderboard_opt_in),
      // Staff see a masked address; the full address is in the database for
      // support and is never exposed publicly.
      email: p.email_verified_at ? maskEmail(p.email) : null,
      shopifyCustomerId: p.shopify_customer_id,
      marketingOptIn: Boolean(p.marketing_opt_in),
      bestScore: p.best_score,
      roundsPlayed: p.rounds_played,
      createdAt: p.created_at,
      lastSeenAt: p.last_seen_at,
    })),
  });
});

adminRouter.post('/players/:id/alias-hidden', (req, res) => {
  const r = db.prepare('UPDATE players SET alias_hidden = ? WHERE id = ?').run(req.body?.hidden ? 1 : 0, req.params.id);
  if (!r.changes) throw notFound();
  res.json({ ok: true });
});

adminRouter.get('/rewards', (_req, res) => {
  const rewards = db
    .prepare(
      `SELECT w.*, p.alias FROM rewards w JOIN players p ON p.id = w.player_id ORDER BY w.created_at DESC LIMIT 300`,
    )
    .all();
  const redemptions = db.prepare(
    `SELECT d.*, o.name AS order_name, o.admin_graphql_id, o.financial_status, o.total_price
     FROM redemptions d LEFT JOIN orders o ON o.shopify_order_id = d.shopify_order_id WHERE d.reward_id = ?`,
  );
  const refunds = db.prepare('SELECT * FROM refunds WHERE shopify_order_id = ? ORDER BY refunded_at');
  res.json({
    rewards: rewards.map((w) => {
      const reds = redemptions.all(w.id).map((d) => ({
        orderId: d.shopify_order_id,
        orderName: d.order_name,
        orderGid: d.admin_graphql_id,
        financialStatus: d.financial_status,
        total: d.total_price,
        discountAmount: d.amount,
        currency: d.currency,
        redeemedAt: d.redeemed_at,
        refunds: refunds.all(d.shopify_order_id).map((r) => ({ id: r.shopify_refund_id, amount: r.amount, currency: r.currency, at: r.refunded_at })),
      }));
      return {
        id: w.id,
        code: w.code,
        demo: Boolean(w.demo),
        percent: w.percent,
        score: w.score,
        status: w.status,
        alias: w.alias,
        playerId: w.player_id,
        identity: w.identity ? w.identity.split(':')[0] : null,
        shopifyDiscountId: w.shopify_discount_id,
        endsAt: w.ends_at,
        createdAt: w.created_at,
        issuedAt: w.issued_at,
        attempts: w.attempts,
        lastError: w.last_error,
        redemptions: reds,
        redeemed: reds.length > 0,
        refunded: reds.some((d) => d.refunds.length > 0),
      };
    }),
  });
});

adminRouter.post(
  '/rewards/:id/retry',
  asyncRoute(async (req, res) => {
    const reward = db.prepare('SELECT * FROM rewards WHERE id = ?').get(req.params.id);
    if (!reward) throw notFound();
    const out = await issue(reward);
    res.json({ status: out.status });
  }),
);

adminRouter.get('/errors', (_req, res) => {
  const rows = db.prepare('SELECT * FROM integration_errors ORDER BY created_at DESC LIMIT 200').all();
  res.json({
    errors: rows.map((e) => ({
      id: e.id,
      source: e.source,
      message: e.message,
      details: e.details_json ? JSON.parse(e.details_json) : null,
      createdAt: e.created_at,
      resolvedAt: e.resolved_at,
    })),
  });
});

adminRouter.post('/errors/:id/resolve', (req, res) => {
  db.prepare('UPDATE integration_errors SET resolved_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  res.json({ ok: true });
});
