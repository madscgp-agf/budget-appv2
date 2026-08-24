import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute, notFound } from '../lib/errors.js';
import { dateSchema, moneySchema, parse } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';
import { requireAccount, requireCategory } from '../lib/access.js';
import { advanceDate, today } from '../lib/dates.js';

export const recurringRouter = express.Router();
recurringRouter.use(requireAuth);

const shape = (row) => ({
  id: row.id,
  accountId: row.account_id,
  accountName: row.account_name,
  categoryId: row.category_id,
  categoryName: row.category_name,
  description: row.description,
  amount: row.amount_cents / 100,
  type: row.type,
  cadence: row.cadence,
  nextRunOn: row.next_run_on,
  active: Boolean(row.active),
  due: row.active === 1 && row.next_run_on <= today(),
});

const SELECT_RULE = `
  SELECT r.*, a.name AS account_name, c.name AS category_name
    FROM recurring_rules r
    JOIN accounts a ON a.id = r.account_id
    LEFT JOIN categories c ON c.id = r.category_id
`;

recurringRouter.get('/', (req, res) => {
  const rows = db.prepare(`${SELECT_RULE} WHERE r.user_id = ? ORDER BY r.active DESC, r.next_run_on`).all(req.user.id);
  res.json({ rules: rows.map(shape) });
});

const ruleSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive().nullish(),
  description: z.string().trim().min(1, 'Add a short description').max(120),
  amount: moneySchema,
  type: z.enum(['income', 'expense']),
  cadence: z.enum(['weekly', 'biweekly', 'monthly', 'yearly']),
  nextRunOn: dateSchema,
});

recurringRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = parse(ruleSchema, req.body);
    requireAccount(body.accountId, req.user.id, { write: true });
    if (body.categoryId) requireCategory(body.categoryId, req.user.id);
    const info = db
      .prepare(
        `INSERT INTO recurring_rules (user_id, account_id, category_id, description, amount_cents, type, cadence, next_run_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.user.id,
        body.accountId,
        body.categoryId ?? null,
        body.description,
        Math.abs(body.amount),
        body.type,
        body.cadence,
        body.nextRunOn,
      );
    res.status(201).json({ rule: shape(db.prepare(`${SELECT_RULE} WHERE r.id = ?`).get(info.lastInsertRowid)) });
  }),
);

function ownRule(id, userId) {
  const row = db.prepare(`${SELECT_RULE} WHERE r.id = ? AND r.user_id = ?`).get(Number(id), userId);
  if (!row) throw notFound('Recurring item not found');
  return row;
}

recurringRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const rule = ownRule(req.params.id, req.user.id);
    const body = parse(ruleSchema.partial().extend({ active: z.boolean().optional() }), req.body);
    if (body.accountId) requireAccount(body.accountId, req.user.id, { write: true });
    if (body.categoryId) requireCategory(body.categoryId, req.user.id);
    db.prepare(
      `UPDATE recurring_rules SET account_id = COALESCE(@accountId, account_id),
              category_id = COALESCE(@categoryId, category_id),
              description = COALESCE(@description, description),
              amount_cents = COALESCE(@amount, amount_cents), type = COALESCE(@type, type),
              cadence = COALESCE(@cadence, cadence), next_run_on = COALESCE(@nextRunOn, next_run_on),
              active = COALESCE(@active, active)
        WHERE id = @id`,
    ).run({
      id: rule.id,
      accountId: body.accountId ?? null,
      categoryId: body.categoryId ?? null,
      description: body.description ?? null,
      amount: body.amount === undefined ? null : Math.abs(body.amount),
      type: body.type ?? null,
      cadence: body.cadence ?? null,
      nextRunOn: body.nextRunOn ?? null,
      active: body.active === undefined ? null : body.active ? 1 : 0,
    });
    res.json({ rule: shape(db.prepare(`${SELECT_RULE} WHERE r.id = ?`).get(rule.id)) });
  }),
);

recurringRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const rule = ownRule(req.params.id, req.user.id);
    db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(rule.id);
    res.json({ ok: true });
  }),
);

/**
 * Posts every rule that is due, catching up if the app has not been opened
 * for a while, and moves each rule on to its next date.
 */
export function runDueRecurring(userId, upTo = today()) {
  const due = db
    .prepare("SELECT * FROM recurring_rules WHERE user_id = ? AND active = 1 AND next_run_on <= ?")
    .all(userId, upTo);
  if (due.length === 0) return { posted: 0 };

  const insert = db.prepare(
    `INSERT INTO transactions (account_id, category_id, created_by_id, amount_cents, type, description, notes, occurred_on)
     VALUES (?, ?, ?, ?, ?, ?, 'Posted automatically from a recurring item', ?)`,
  );
  const bump = db.prepare('UPDATE recurring_rules SET next_run_on = ? WHERE id = ?');

  const posted = db.transaction(() => {
    let count = 0;
    for (const rule of due) {
      let runOn = rule.next_run_on;
      // Guard against runaway catch-up on very old rules.
      for (let i = 0; runOn <= upTo && i < 500; i += 1) {
        insert.run(
          rule.account_id,
          rule.category_id,
          rule.user_id,
          rule.type === 'expense' ? -Math.abs(rule.amount_cents) : Math.abs(rule.amount_cents),
          rule.type,
          rule.description,
          runOn,
        );
        count += 1;
        runOn = advanceDate(runOn, rule.cadence);
      }
      bump.run(runOn, rule.id);
    }
    return count;
  })();

  return { posted };
}

recurringRouter.post(
  '/run',
  asyncRoute(async (req, res) => {
    res.json(runDueRecurring(req.user.id));
  }),
);
