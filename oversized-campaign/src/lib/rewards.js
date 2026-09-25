import { config } from '../config.js';
import { db, tx } from '../db.js';
import { now, nowIso } from './clock.js';
import { randomCode, randomId } from './crypto.js';
import { campaignStatus, getCampaign, tierFor } from './campaign.js';
import { conflict, forbidden, HttpError } from './errors.js';
import { isVerified } from './players.js';
import { createDiscountCode, logShopifyError } from './shopify.js';

const LOCK_MS = 30_000;

/** The verified identity a reward is tied to, when there is one. */
export function identityOf(player) {
  if (player.shopify_customer_id) return `customer:${player.shopify_customer_id}`;
  if (player.email_verified_at) return `email:${player.email_lower}`;
  return null;
}

function identitiesOf(player) {
  const out = [];
  if (player.shopify_customer_id) out.push(`customer:${player.shopify_customer_id}`);
  if (player.email_verified_at) out.push(`email:${player.email_lower}`);
  return out;
}

export function bestCampaignRound(playerId, campaign) {
  return db
    .prepare(
      `SELECT * FROM rounds WHERE player_id = ? AND campaign_id = ? AND status = 'verified'
       ORDER BY score DESC, submitted_at ASC LIMIT 1`,
    )
    .get(playerId, campaign.id);
}

export function rewardFor(player, campaign) {
  const ids = identitiesOf(player);
  return db
    .prepare(
      `SELECT * FROM rewards WHERE campaign_id = ? AND (player_id = ? ${ids.length ? `OR identity IN (${ids.map(() => '?').join(',')})` : ''})
       ORDER BY created_at LIMIT 1`,
    )
    .get(campaign.id, player.id, ...ids);
}

export function publicReward(r) {
  if (!r) return null;
  return {
    status: r.status,
    percent: r.percent,
    score: r.score,
    // A code is shown only once it exists in Shopify (or is a labelled demo code).
    code: r.status === 'issued' ? r.code : null,
    demo: Boolean(r.demo),
    endsAt: r.ends_at,
    issuedAt: r.issued_at,
  };
}

/** What the player could claim right now, without claiming it. */
export function eligibility(player, campaign = getCampaign()) {
  const status = campaignStatus(campaign);
  const existing = rewardFor(player, campaign);
  const best = bestCampaignRound(player.id, campaign);
  const tier = best ? tierFor(campaign, best.score) : null;
  const nextTier = campaign.tiers.find((t) => !best || t.minScore > best.score) || null;
  return {
    campaignStatus: status,
    bestCampaignScore: best?.score || 0,
    tier,
    nextTier,
    needsVerification: campaign.requireVerified && !isVerified(player),
    canClaim: status === 'running' && !existing && Boolean(tier) && !(campaign.requireVerified && !isVerified(player)),
    reward: publicReward(existing),
  };
}

/**
 * Claim the player's reward for the current campaign.
 *
 * Idempotency: the (campaign, player) and (campaign, identity) unique indexes
 * mean only one reward row can ever exist, however many requests race. The
 * row is created with its final code *before* Shopify is called, and a short
 * lock stops two requests calling Shopify at once. A retry after a crash
 * reuses the same code, and createDiscountCode() recognises a code that
 * already exists instead of creating another.
 */
export async function claimReward(player) {
  const campaign = getCampaign();
  const status = campaignStatus(campaign);
  if (status !== 'running') throw conflict('Kampagnen er ikke aktiv lige nu', { code: 'campaign_' + status });
  if (campaign.requireVerified && !isVerified(player)) {
    throw forbidden('Bekræft din e-mail eller log ind som kunde for at få en rigtig rabatkode');
  }

  let reward = tx(() => {
    const existing = rewardFor(player, campaign);
    if (existing) return existing;
    const best = bestCampaignRound(player.id, campaign);
    const tier = best ? tierFor(campaign, best.score) : null;
    if (!tier) throw conflict('Din bedste score i kampagnen giver endnu ikke en rabat', { code: 'not_eligible' });
    const startsAt = nowIso();
    const endsAt = new Date(now() + campaign.codeValidDays * 86_400_000).toISOString();
    const code = `${config.demoMode ? 'DEMO' : campaign.codePrefix}-${tier.percent}-${randomCode(8)}`;
    const row = {
      id: randomId(),
      campaign_id: campaign.id,
      player_id: player.id,
      round_id: best.id,
      score: best.score,
      percent: tier.percent,
      code,
      demo: config.demoMode ? 1 : 0,
      status: 'pending',
      shopify_customer_id: player.shopify_customer_id || null,
      identity: identityOf(player),
      starts_at: startsAt,
      ends_at: endsAt,
      created_at: startsAt,
    };
    db.prepare(
      `INSERT INTO rewards (id, campaign_id, player_id, round_id, score, percent, code, demo, status, shopify_customer_id,
         identity, starts_at, ends_at, created_at)
       VALUES (@id, @campaign_id, @player_id, @round_id, @score, @percent, @code, @demo, @status, @shopify_customer_id,
         @identity, @starts_at, @ends_at, @created_at)`,
    ).run(row);
    return db.prepare('SELECT * FROM rewards WHERE id = ?').get(row.id);
  });

  if (reward.status === 'issued') return reward;
  return issue(reward, campaign);
}

/** Push a pending/failed reward to Shopify. Also used by the admin "retry" button. */
export async function issue(reward, campaign = getCampaign()) {
  const t = nowIso();
  const lock = db
    .prepare(
      `UPDATE rewards SET locked_until = ?, attempts = attempts + 1
       WHERE id = ? AND status IN ('pending', 'failed') AND (locked_until IS NULL OR locked_until < ?)`,
    )
    .run(new Date(now() + LOCK_MS).toISOString(), reward.id, t);
  if (lock.changes === 0) {
    // Someone else is issuing it right now (or it is already issued).
    return db.prepare('SELECT * FROM rewards WHERE id = ?').get(reward.id);
  }

  if (reward.demo) {
    // DEMO: nothing is created in Shopify. The code starts with DEMO- and the
    // UI labels it as a demo code that will not work at checkout.
    db.prepare("UPDATE rewards SET status = 'issued', issued_at = ?, locked_until = NULL WHERE id = ?").run(nowIso(), reward.id);
    return db.prepare('SELECT * FROM rewards WHERE id = ?').get(reward.id);
  }

  try {
    const discountId = await createDiscountCode(campaign, reward);
    db.prepare(
      "UPDATE rewards SET status = 'issued', shopify_discount_id = ?, issued_at = ?, locked_until = NULL, last_error = NULL WHERE id = ?",
    ).run(discountId, nowIso(), reward.id);
  } catch (err) {
    db.prepare("UPDATE rewards SET status = 'failed', last_error = ?, locked_until = NULL WHERE id = ?").run(
      String(err.message).slice(0, 500),
      reward.id,
    );
    logShopifyError('discount.create', err);
    throw new HttpError(502, 'Rabatkoden kunne ikke oprettes i butikken lige nu. Prøv igen om lidt.');
  }
  return db.prepare('SELECT * FROM rewards WHERE id = ?').get(reward.id);
}
