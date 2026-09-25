import { Router } from 'express';
import { asyncRoute } from '../lib/errors.js';
import { limit } from '../lib/rateLimit.js';
import { requirePlayer } from '../lib/sessions.js';
import { claimReward, eligibility, publicReward } from '../lib/rewards.js';

export const rewardsRouter = Router();

rewardsRouter.get('/', requirePlayer, (req, res) => {
  res.json(eligibility(req.player));
});

// The client only says "claim"; the server decides the level from the
// player's best verified round.
rewardsRouter.post(
  '/claim',
  requirePlayer,
  asyncRoute(async (req, res) => {
    limit(`claim:${req.player.id}`, 10, 10 * 60_000);
    const reward = await claimReward(req.player);
    res.status(reward.status === 'issued' ? 200 : 202).json({ reward: publicReward(reward), eligibility: eligibility(req.player) });
  }),
);
