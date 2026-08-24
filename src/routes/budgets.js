import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute } from '../lib/errors.js';
import { moneySchema, parse, periodSchema } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';
import { requireCategory, visibleAccountIds } from '../lib/access.js';
import { currentPeriod, periodRange, shiftPeriod } from '../lib/dates.js';

export const budgetsRouter = express.Router();
budgetsRouter.use(requireAuth);

/** Spending per category for a period, across every account the user can see. */
function spentByCategory(userId, period) {
  const accountIds = visibleAccountIds(userId);
  if (accountIds.length === 0) return new Map();
  const { start, end } = periodRange(period);
  const rows = db
    .prepare(
      `SELECT category_id, SUM(amount_cents) AS total
         FROM transactions
        WHERE account_id IN (${accountIds.map(() => '?').join(',')})
          AND type != 'transfer' AND occurred_on BETWEEN ? AND ? AND category_id IS NOT NULL
        GROUP BY category_id`,
    )
    .all(...accountIds, start, end);
  return new Map(rows.map((r) => [r.category_id, r.total]));
}

/**
 * Budgets for a period, each with what has actually been spent.
 * Categories without a budget are listed too, so nothing is invisible.
 */
budgetsRouter.get('/', (req, res) => {
  const period = periodSchema.safeParse(String(req.query.period || '')).success
    ? String(req.query.period)
    : currentPeriod();
  const spent = spentByCategory(req.user.id, period);

  const categories = db
    .prepare("SELECT * FROM categories WHERE user_id = ? AND archived = 0 AND kind = 'expense' ORDER BY name COLLATE NOCASE")
    .all(req.user.id);
  const budgets = new Map(
    db.prepare('SELECT * FROM budgets WHERE user_id = ? AND period = ?').all(req.user.id, period).map((b) => [b.category_id, b]),
  );

  const items = categories.map((category) => {
    const budget = budgets.get(category.id);
    const spentCents = Math.abs(Math.min(spent.get(category.id) || 0, 0));
    const limitCents = budget ? budget.amount_cents : 0;
    return {
      categoryId: category.id,
      categoryName: category.name,
      color: category.color,
      budgetId: budget ? budget.id : null,
      limit: limitCents / 100,
      spent: spentCents / 100,
      remaining: (limitCents - spentCents) / 100,
      progress: limitCents > 0 ? Math.min(spentCents / limitCents, 2) : null,
      over: limitCents > 0 && spentCents > limitCents,
    };
  });

  const totals = items.reduce(
    (acc, item) => ({ limit: acc.limit + item.limit, spent: acc.spent + item.spent }),
    { limit: 0, spent: 0 },
  );

  res.json({
    period,
    previousPeriod: shiftPeriod(period, -1),
    nextPeriod: shiftPeriod(period, 1),
    items,
    totals: { ...totals, remaining: totals.limit - totals.spent },
  });
});

const budgetSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  period: periodSchema,
  amount: moneySchema,
});

/** Sets (or clears, when the amount is zero) a category budget for a period. */
budgetsRouter.put(
  '/',
  asyncRoute(async (req, res) => {
    const body = parse(budgetSchema, req.body);
    requireCategory(body.categoryId, req.user.id);
    if (body.amount <= 0) {
      db.prepare('DELETE FROM budgets WHERE user_id = ? AND category_id = ? AND period = ?').run(
        req.user.id,
        body.categoryId,
        body.period,
      );
      return res.json({ ok: true, cleared: true });
    }
    db.prepare(
      `INSERT INTO budgets (user_id, category_id, period, amount_cents) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, category_id, period) DO UPDATE SET amount_cents = excluded.amount_cents`,
    ).run(req.user.id, body.categoryId, body.period, body.amount);
    res.json({ ok: true });
  }),
);

/** Copies every budget from one period into another. */
budgetsRouter.post(
  '/copy',
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ from: periodSchema, to: periodSchema }), req.body);
    const info = db
      .prepare(
        `INSERT INTO budgets (user_id, category_id, period, amount_cents)
         SELECT user_id, category_id, @to, amount_cents FROM budgets WHERE user_id = @user AND period = @from
         ON CONFLICT (user_id, category_id, period) DO UPDATE SET amount_cents = excluded.amount_cents`,
      )
      .run({ user: req.user.id, from: body.from, to: body.to });
    res.json({ copied: info.changes });
  }),
);
