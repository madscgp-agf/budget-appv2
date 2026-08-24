import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute, conflict } from '../lib/errors.js';
import { parse, usernameSchema } from '../lib/validate.js';
import { requireAuth, selfUser } from '../lib/auth.js';
import { findById, findByUsername } from '../lib/users.js';
import { runDueRecurring } from './recurring.js';

export const usersRouter = express.Router();
usersRouter.use(requireAuth);

usersRouter.get('/me', (req, res) => {
  // Opening the app is a good moment to post anything that has fallen due.
  const { posted } = runDueRecurring(req.user.id);
  res.json({ user: selfUser(findById(req.user.id)), recurringPosted: posted });
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  username: usernameSchema.optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  discoverable: z.boolean().optional(),
});

usersRouter.patch(
  '/me',
  asyncRoute(async (req, res) => {
    const body = parse(profileSchema, req.body);
    if (body.username) {
      const existing = findByUsername(body.username);
      if (existing && existing.id !== req.user.id) throw conflict('That username is already taken');
    }
    db.prepare(
      `UPDATE users SET display_name = COALESCE(@displayName, display_name),
              username = COALESCE(@username, username),
              username_lower = COALESCE(@usernameLower, username_lower),
              currency = COALESCE(@currency, currency),
              discoverable = COALESCE(@discoverable, discoverable),
              updated_at = datetime('now')
        WHERE id = @id`,
    ).run({
      id: req.user.id,
      displayName: body.displayName ?? null,
      username: body.username ?? null,
      usernameLower: body.username ? body.username.toLowerCase() : null,
      currency: body.currency ?? null,
      discoverable: body.discoverable === undefined ? null : body.discoverable ? 1 : 0,
    });
    res.json({ user: selfUser(findById(req.user.id)) });
  }),
);

/** Deletes the account and, by cascade, everything in it. */
usersRouter.delete(
  '/me',
  asyncRoute(async (req, res) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.json({ ok: true });
  }),
);
