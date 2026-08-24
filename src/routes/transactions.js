import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute, badRequest, notFound } from '../lib/errors.js';
import { dateSchema, moneySchema, parse } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';
import { requireAccount, requireCategory, visibleAccountIds } from '../lib/access.js';
import { today } from '../lib/dates.js';

export const transactionsRouter = express.Router();
transactionsRouter.use(requireAuth);

const SELECT_TX = `
  SELECT t.*, a.name AS account_name, a.currency AS currency, c.name AS category_name,
         c.color AS category_color, c.kind AS category_kind, u.username AS created_by_username
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    JOIN users u ON u.id = t.created_by_id
`;

const shape = (row) => ({
  id: row.id,
  accountId: row.account_id,
  accountName: row.account_name,
  categoryId: row.category_id,
  categoryName: row.category_name,
  categoryColor: row.category_color,
  amount: row.amount_cents / 100,
  type: row.type,
  currency: row.currency,
  description: row.description,
  notes: row.notes,
  date: row.occurred_on,
  transferGroup: row.transfer_group,
  createdBy: row.created_by_username,
  createdAt: row.created_at,
});

/** List with filters: account, category, type, date range, text search. */
transactionsRouter.get('/', (req, res) => {
  const accountIds = visibleAccountIds(req.user.id);
  if (accountIds.length === 0) return res.json({ transactions: [], total: 0 });

  const filters = [`t.account_id IN (${accountIds.map(() => '?').join(',')})`];
  const params = [...accountIds];

  if (req.query.accountId) {
    filters.push('t.account_id = ?');
    params.push(Number(req.query.accountId));
  }
  if (req.query.categoryId) {
    filters.push('t.category_id = ?');
    params.push(Number(req.query.categoryId));
  }
  if (req.query.type) {
    filters.push('t.type = ?');
    params.push(String(req.query.type));
  }
  if (req.query.from) {
    filters.push('t.occurred_on >= ?');
    params.push(String(req.query.from));
  }
  if (req.query.to) {
    filters.push('t.occurred_on <= ?');
    params.push(String(req.query.to));
  }
  if (req.query.q) {
    filters.push('(t.description LIKE ? OR t.notes LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }

  const where = `WHERE ${filters.join(' AND ')}`;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const rows = db
    .prepare(`${SELECT_TX} ${where} ORDER BY t.occurred_on DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM transactions t ${where}`).get(...params);

  res.json({ transactions: rows.map(shape), total, limit, offset });
});

const txSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive().nullish(),
  amount: moneySchema,
  type: z.enum(['income', 'expense']),
  description: z.string().trim().min(1, 'Add a short description').max(120),
  notes: z.string().trim().max(500).nullish(),
  date: dateSchema.optional(),
});

/** Amount is stored signed: income positive, expense negative. */
const signedCents = (type, cents) => (type === 'expense' ? -Math.abs(cents) : Math.abs(cents));

transactionsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = parse(txSchema, req.body);
    requireAccount(body.accountId, req.user.id, { write: true });
    if (body.categoryId) requireCategory(body.categoryId, req.user.id);

    const info = db
      .prepare(
        `INSERT INTO transactions (account_id, category_id, created_by_id, amount_cents, type, description, notes, occurred_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.accountId,
        body.categoryId ?? null,
        req.user.id,
        signedCents(body.type, body.amount),
        body.type,
        body.description,
        body.notes ?? null,
        body.date || today(),
      );
    res.status(201).json({ transaction: shape(db.prepare(`${SELECT_TX} WHERE t.id = ?`).get(info.lastInsertRowid)) });
  }),
);

function loadTransaction(id, userId, { write = false } = {}) {
  const row = db.prepare(`${SELECT_TX} WHERE t.id = ?`).get(Number(id));
  if (!row) throw notFound('Transaction not found');
  requireAccount(row.account_id, userId, { write });
  return row;
}

transactionsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json({ transaction: shape(loadTransaction(req.params.id, req.user.id)) });
  }),
);

transactionsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const existing = loadTransaction(req.params.id, req.user.id, { write: true });
    if (existing.type === 'transfer') throw badRequest('Delete the transfer and create a new one to change it');
    const body = parse(txSchema.partial(), req.body);
    if (body.accountId) requireAccount(body.accountId, req.user.id, { write: true });
    if (body.categoryId) requireCategory(body.categoryId, req.user.id);

    const type = body.type || existing.type;
    const amountCents = body.amount === undefined ? Math.abs(existing.amount_cents) : body.amount;

    db.prepare(
      `UPDATE transactions SET account_id = COALESCE(@accountId, account_id),
              category_id = CASE WHEN @clearCategory = 1 THEN NULL ELSE COALESCE(@categoryId, category_id) END,
              amount_cents = @amountCents, type = @type,
              description = COALESCE(@description, description),
              notes = COALESCE(@notes, notes),
              occurred_on = COALESCE(@date, occurred_on),
              updated_at = datetime('now')
        WHERE id = @id`,
    ).run({
      id: existing.id,
      accountId: body.accountId ?? null,
      categoryId: body.categoryId ?? null,
      clearCategory: body.categoryId === null ? 1 : 0,
      amountCents: signedCents(type, amountCents),
      type,
      description: body.description ?? null,
      notes: body.notes ?? null,
      date: body.date ?? null,
    });
    res.json({ transaction: shape(db.prepare(`${SELECT_TX} WHERE t.id = ?`).get(existing.id)) });
  }),
);

transactionsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const existing = loadTransaction(req.params.id, req.user.id, { write: true });
    if (existing.transfer_group) {
      // Both legs of a transfer disappear together.
      db.prepare('DELETE FROM transactions WHERE transfer_group = ?').run(existing.transfer_group);
    } else {
      db.prepare('DELETE FROM transactions WHERE id = ?').run(existing.id);
    }
    res.json({ ok: true });
  }),
);

const transferSchema = z.object({
  fromAccountId: z.coerce.number().int().positive(),
  toAccountId: z.coerce.number().int().positive(),
  amount: moneySchema,
  description: z.string().trim().max(120).optional(),
  date: dateSchema.optional(),
});

/** A transfer is two linked rows so both account balances stay correct. */
transactionsRouter.post(
  '/transfer',
  asyncRoute(async (req, res) => {
    const body = parse(transferSchema, req.body);
    if (body.fromAccountId === body.toAccountId) throw badRequest('Pick two different accounts');
    if (body.amount <= 0) throw badRequest('Enter an amount greater than zero');
    const from = requireAccount(body.fromAccountId, req.user.id, { write: true });
    const to = requireAccount(body.toAccountId, req.user.id, { write: true });

    const group = crypto.randomUUID();
    const date = body.date || today();
    const description = body.description || `Transfer: ${from.name} to ${to.name}`;
    const insert = db.prepare(
      `INSERT INTO transactions (account_id, category_id, created_by_id, amount_cents, type, description, notes, occurred_on, transfer_group)
       VALUES (?, NULL, ?, ?, 'transfer', ?, NULL, ?, ?)`,
    );
    const ids = db.transaction(() => [
      insert.run(from.id, req.user.id, -Math.abs(body.amount), description, date, group).lastInsertRowid,
      insert.run(to.id, req.user.id, Math.abs(body.amount), description, date, group).lastInsertRowid,
    ])();

    res.status(201).json({
      transfer: { group, transactions: ids.map((id) => shape(db.prepare(`${SELECT_TX} WHERE t.id = ?`).get(id))) },
    });
  }),
);
