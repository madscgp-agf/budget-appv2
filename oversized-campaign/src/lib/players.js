import { db, tx } from '../db.js';
import { nowIso } from './clock.js';
import { randomId } from './crypto.js';

const byId = db.prepare('SELECT * FROM players WHERE id = ?');

/** Follows merge pointers to the surviving profile. */
export function resolvePlayer(id) {
  let p = byId.get(id);
  for (let i = 0; p && p.merged_into && i < 10; i++) p = byId.get(p.merged_into);
  return p || null;
}

export function createPlayer() {
  const id = randomId();
  const t = nowIso();
  db.prepare('INSERT INTO players (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(id, t, t);
  return byId.get(id);
}

export function findByEmail(emailLower) {
  const p = db.prepare('SELECT * FROM players WHERE email_lower = ? AND email_verified_at IS NOT NULL').get(emailLower);
  return p ? resolvePlayer(p.id) : null;
}

export function findByCustomer(customerId) {
  const p = db.prepare('SELECT * FROM players WHERE shopify_customer_id = ?').get(String(customerId));
  return p ? resolvePlayer(p.id) : null;
}

export function recomputeStats(playerId) {
  const best = db
    .prepare("SELECT id, score FROM rounds WHERE player_id = ? AND status = 'verified' ORDER BY score DESC, submitted_at ASC LIMIT 1")
    .get(playerId);
  const count = db.prepare("SELECT COUNT(*) FROM rounds WHERE player_id = ? AND status = 'verified'").pluck().get(playerId);
  db.prepare('UPDATE players SET best_score = ?, best_round_id = ?, rounds_played = ? WHERE id = ?').run(
    best?.score || 0,
    best?.id || null,
    count,
    playerId,
  );
}

/**
 * Fold `sourceId` into `targetId`. Only call this after the owner of the
 * target has been verified (email link or Shopify customer login) from the
 * browser holding the source profile. History moves; identities stay unique.
 */
export function mergePlayers(sourceId, targetId) {
  if (sourceId === targetId) return resolvePlayer(targetId);
  return tx(() => {
    const src = byId.get(sourceId);
    const dst = byId.get(targetId);
    if (!src || !dst || src.merged_into) return resolvePlayer(targetId);

    db.prepare('UPDATE rounds SET player_id = ? WHERE player_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE sessions SET player_id = ? WHERE player_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE email_tokens SET player_id = ? WHERE player_id = ?').run(targetId, sourceId);
    // A reward moves only if the target has none for that campaign; otherwise
    // the source's code stays valid but remains attached to the old profile.
    db.prepare(
      `UPDATE rewards SET player_id = ? WHERE player_id = ?
         AND campaign_id NOT IN (SELECT campaign_id FROM rewards WHERE player_id = ?)`,
    ).run(targetId, sourceId, targetId);

    const carry = {};
    if (!dst.alias && src.alias) {
      carry.alias = src.alias;
      carry.alias_lower = src.alias_lower;
      carry.leaderboard_opt_in = src.leaderboard_opt_in;
    }
    if (!dst.shopify_customer_id && src.shopify_customer_id) {
      carry.shopify_customer_id = src.shopify_customer_id;
      carry.customer_verified_at = src.customer_verified_at;
    }
    if (!dst.email_verified_at && src.email_verified_at) {
      carry.email = src.email;
      carry.email_lower = src.email_lower;
      carry.email_verified_at = src.email_verified_at;
    }
    if (src.marketing_opt_in && !dst.marketing_opt_in) {
      carry.marketing_opt_in = 1;
      carry.marketing_opt_in_at = src.marketing_opt_in_at;
    }
    db.prepare(
      `UPDATE players SET alias = NULL, alias_lower = NULL, email_lower = NULL, shopify_customer_id = NULL,
         merged_into = ? WHERE id = ?`,
    ).run(targetId, sourceId);
    db.prepare('UPDATE players SET merged_into = ? WHERE merged_into = ?').run(targetId, sourceId);
    const keys = Object.keys(carry);
    if (keys.length) {
      db.prepare(`UPDATE players SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...carry, id: targetId });
    }
    recomputeStats(targetId);
    return byId.get(targetId);
  });
}

export function isVerified(p) {
  return Boolean(p && (p.email_verified_at || p.shopify_customer_id));
}

export function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, user.length - 1)))}@${domain}`;
}

/** What the player may see about themselves. */
export function selfView(p) {
  return {
    alias: p.alias,
    leaderboardOptIn: Boolean(p.leaderboard_opt_in),
    bestScore: p.best_score,
    roundsPlayed: p.rounds_played,
    verified: isVerified(p),
    email: p.email_verified_at ? maskEmail(p.email) : null,
    shopifyCustomer: Boolean(p.shopify_customer_id),
    marketingOptIn: Boolean(p.marketing_opt_in),
    since: p.created_at,
  };
}

export { byId as playerById };
