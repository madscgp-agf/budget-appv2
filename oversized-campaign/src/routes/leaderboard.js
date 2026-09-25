import { Router } from 'express';
import { db } from '../db.js';
import { getCampaign } from '../lib/campaign.js';
import { currentPlayer } from '../lib/sessions.js';

export const leaderboardRouter = Router();

// Only self-chosen aliases of players who opted in. Never email, customer data
// or internal ids.
leaderboardRouter.get('/', (req, res) => {
  const campaign = getCampaign();
  if (!campaign.leaderboardEnabled) return res.json({ enabled: false, entries: [] });
  const rows = db
    .prepare(
      `SELECT id, alias, best_score FROM players
       WHERE merged_into IS NULL AND leaderboard_opt_in = 1 AND alias IS NOT NULL AND alias_hidden = 0 AND best_score > 0
       ORDER BY best_score DESC, created_at ASC LIMIT 20`,
    )
    .all();
  const me = currentPlayer(req, res);
  res.json({
    enabled: true,
    entries: rows.map((r, i) => ({ rank: i + 1, alias: r.alias, score: r.best_score, you: me?.id === r.id })),
  });
});
