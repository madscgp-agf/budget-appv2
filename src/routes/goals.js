import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute, notFound } from '../lib/errors.js';
import { dateSchema, moneySchema, parse } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';

export const goalsRouter = express.Router();
goalsRouter.use(requireAuth);

const shape = (row) => ({
  id: row.id,
  name: row.name,
  target: row.target_cents / 100,
  saved: row.saved_cents / 100,
  remaining: Math.max(row.target_cents - row.saved_cents, 0) / 100,
  progress: row.target_cents > 0 ? Math.min(row.saved_cents / row.target_cents, 1) : 0,
  targetDate: row.target_date,
  archived: Boolean(row.archived),
});

goalsRouter.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM goals WHERE user_id = ? AND (? = 1 OR archived = 0) ORDER BY archived, target_date IS NULL, target_date')
    .all(req.user.id, req.query.includeArchived === 'true' ? 1 : 0);
  res.json({ goals: rows.map(shape) });
});

const goalSchema = z.object({
  name: z.string().trim().min(1, 'Name the goal').max(60),
  target: moneySchema,
  saved: moneySchema.optional(),
  targetDate: dateSchema.nullish(),
});

goalsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = parse(goalSchema, req.body);
    const info = db
      .prepare('INSERT INTO goals (user_id, name, target_cents, saved_cents, target_date) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, body.name, body.target, body.saved ?? 0, body.targetDate ?? null);
    res.status(201).json({ goal: shape(db.prepare('SELECT * FROM goals WHERE id = ?').get(info.lastInsertRowid)) });
  }),
);

function ownGoal(id, userId) {
  const row = db.prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw notFound('Goal not found');
  return row;
}

goalsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const goal = ownGoal(req.params.id, req.user.id);
    const body = parse(goalSchema.partial().extend({ archived: z.boolean().optional() }), req.body);
    db.prepare(
      `UPDATE goals SET name = COALESCE(@name, name), target_cents = COALESCE(@target, target_cents),
              saved_cents = COALESCE(@saved, saved_cents), target_date = COALESCE(@targetDate, target_date),
              archived = COALESCE(@archived, archived)
        WHERE id = @id`,
    ).run({
      id: goal.id,
      name: body.name ?? null,
      target: body.target ?? null,
      saved: body.saved ?? null,
      targetDate: body.targetDate ?? null,
      archived: body.archived === undefined ? null : body.archived ? 1 : 0,
    });
    res.json({ goal: shape(db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id)) });
  }),
);

/** Adds (or with a negative amount, removes) money from a goal. */
goalsRouter.post(
  '/:id/contribute',
  asyncRoute(async (req, res) => {
    const goal = ownGoal(req.params.id, req.user.id);
    const body = parse(z.object({ amount: moneySchema }), req.body);
    const next = Math.max(goal.saved_cents + body.amount, 0);
    db.prepare('UPDATE goals SET saved_cents = ? WHERE id = ?').run(next, goal.id);
    res.json({ goal: shape(db.prepare('SELECT * FROM goals WHERE id = ?').get(goal.id)) });
  }),
);

goalsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const goal = ownGoal(req.params.id, req.user.id);
    db.prepare('DELETE FROM goals WHERE id = ?').run(goal.id);
    res.json({ ok: true });
  }),
);
