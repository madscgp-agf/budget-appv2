import { Router } from 'express';
import { db, tx } from '../db.js';
import { now, nowIso } from '../lib/clock.js';
import { keyedHash, randomId, randomSeed } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { limit } from '../lib/rateLimit.js';
import { requirePlayer } from '../lib/sessions.js';
import { campaignStatus, getCampaign, tierFor } from '../lib/campaign.js';
import { recomputeStats, playerById } from '../lib/players.js';
import { eligibility } from '../lib/rewards.js';
import { ROUND_MS, RULES_VERSION, scoreRound, suspicionFlags } from '../../shared/rules.js';

export const roundsRouter = Router();

// A round may be submitted from shortly before the server thinks 45 s have
// passed (the start response took time to reach the client) until it expires.
export const START_TOLERANCE_MS = 1500;
export const EXPIRY_GRACE_MS = 60_000;
const MAX_OPEN_PER_IP = 6;

roundsRouter.post('/', requirePlayer, (req, res) => {
  const player = req.player;
  limit(`round:player:${player.id}`, 15, 10 * 60_000);
  limit(`round:ip:${req.ip}`, 40, 10 * 60_000);
  const ipHash = keyedHash(req.ip || '');
  const t = nowIso();

  const round = tx(() => {
    db.prepare("UPDATE rounds SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").run(t);
    // One live round per player: starting again abandons the previous one.
    db.prepare("UPDATE rounds SET status = 'expired', reject_reason = 'abandoned' WHERE player_id = ? AND status = 'open'").run(player.id);
    const openFromIp = db.prepare("SELECT COUNT(*) FROM rounds WHERE status = 'open' AND ip_hash = ?").pluck().get(ipHash);
    if (openFromIp >= MAX_OPEN_PER_IP) throw new HttpError(429, 'For mange samtidige runder fra dit netværk');

    const campaign = getCampaign();
    const row = {
      id: randomId(),
      player_id: player.id,
      campaign_id: campaignStatus(campaign) === 'running' ? campaign.id : null,
      seed: randomSeed(),
      rules_version: RULES_VERSION,
      status: 'open',
      started_at: t,
      expires_at: new Date(now() + ROUND_MS + EXPIRY_GRACE_MS).toISOString(),
      ip_hash: ipHash,
    };
    db.prepare(
      `INSERT INTO rounds (id, player_id, campaign_id, seed, rules_version, status, started_at, expires_at, ip_hash)
       VALUES (@id, @player_id, @campaign_id, @seed, @rules_version, @status, @started_at, @expires_at, @ip_hash)`,
    ).run(row);
    return row;
  });

  res.status(201).json({
    roundId: round.id,
    seed: round.seed,
    rulesVersion: round.rules_version,
    durationMs: ROUND_MS,
    startedAt: round.started_at,
    expiresAt: round.expires_at,
    countsForCampaign: Boolean(round.campaign_id),
  });
});

function resultPayload(round, player) {
  const r = JSON.parse(round.result_json);
  const campaign = getCampaign();
  return {
    roundId: round.id,
    verified: true,
    score: round.score,
    approvedReps: round.approved_reps,
    cleanReps: round.clean_reps,
    topKg: round.top_kg,
    avgQuality: round.avg_quality,
    reps: r.reps,
    personalBest: player.best_score,
    newRecord: player.best_round_id === round.id,
    countsForCampaign: Boolean(round.campaign_id),
    tier: round.campaign_id ? tierFor(campaign, round.score) : null,
    eligibility: eligibility(player, campaign),
  };
}

roundsRouter.post('/:id/submit', requirePlayer, (req, res) => {
  limit(`submit:player:${req.player.id}`, 30, 10 * 60_000);
  const events = req.body?.events;
  if (req.body?.rulesVersion !== undefined && req.body.rulesVersion !== RULES_VERSION) {
    throw conflict('Spillet er blevet opdateret – genindlæs siden', { code: 'rules_version' });
  }
  const eventsJson = JSON.stringify(events ?? null);
  if (eventsJson.length > 20_000) throw badRequest('For mange data');

  const outcome = tx(() => {
    const round = db.prepare('SELECT * FROM rounds WHERE id = ? AND player_id = ?').get(req.params.id, req.player.id);
    if (!round) throw notFound('Runden findes ikke');

    if (round.status === 'verified') {
      // Retrying the exact same submission (e.g. after a network hiccup)
      // returns the stored result; anything else is a second submission.
      if (round.events_json === eventsJson) return { round, replay: true };
      throw conflict('Runden er allerede indsendt', { code: 'already_submitted' });
    }
    if (round.status !== 'open') throw conflict('Runden er ikke længere åben', { code: round.status });

    const t = now();
    const elapsed = t - Date.parse(round.started_at);
    const reject = (reason) => {
      db.prepare("UPDATE rounds SET status = 'rejected', reject_reason = ?, submitted_at = ?, events_json = ? WHERE id = ?").run(
        reason,
        nowIso(),
        eventsJson,
        round.id,
      );
      return { rejected: reason };
    };
    if (t > Date.parse(round.expires_at)) {
      db.prepare("UPDATE rounds SET status = 'expired' WHERE id = ?").run(round.id);
      return { expired: true };
    }
    if (round.rules_version !== RULES_VERSION) return reject('rules version changed');
    // The clock in the browser cannot run faster than the server's.
    if (elapsed < ROUND_MS - START_TOLERANCE_MS) return reject('submitted before the round could have ended');

    const result = scoreRound(round.seed, events);
    if (!result.valid) return reject(result.reason);
    if (result.lastEventMs > elapsed + 500) return reject('events later than real time');

    const flags = suspicionFlags(result, events);
    db.prepare(
      `UPDATE rounds SET status = 'verified', submitted_at = ?, score = ?, approved_reps = ?, clean_reps = ?, top_kg = ?,
         avg_quality = ?, events_json = ?, result_json = ?, flags = ? WHERE id = ?`,
    ).run(
      nowIso(),
      result.score,
      result.approvedReps,
      result.cleanReps,
      result.topKg,
      result.avgQuality,
      eventsJson,
      JSON.stringify(result),
      flags.length ? flags.join(',') : null,
      round.id,
    );
    recomputeStats(req.player.id);
    return { round: db.prepare('SELECT * FROM rounds WHERE id = ?').get(round.id) };
  });

  if (outcome.expired) throw new HttpError(410, 'Runden er udløbet');
  if (outcome.rejected) throw new HttpError(422, 'Runden kunne ikke godkendes', { reason: outcome.rejected });
  const player = playerById.get(req.player.id);
  res.json({ ...resultPayload(outcome.round, player), replay: Boolean(outcome.replay) });
});

roundsRouter.get('/history', requirePlayer, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, status, started_at, score, approved_reps, clean_reps, top_kg FROM rounds
       WHERE player_id = ? AND status IN ('verified', 'rejected') ORDER BY started_at DESC LIMIT 20`,
    )
    .all(req.player.id);
  res.json({
    rounds: rows.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.started_at,
      score: r.score,
      approvedReps: r.approved_reps,
      cleanReps: r.clean_reps,
      topKg: r.top_kg,
    })),
  });
});
