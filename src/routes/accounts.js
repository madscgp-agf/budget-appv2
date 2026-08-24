import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute, badRequest, forbidden, notFound } from '../lib/errors.js';
import { moneySchema, parse, usernameSchema } from '../lib/validate.js';
import { publicUser, requireAuth } from '../lib/auth.js';
import { accountBalanceCents, requireAccount, visibleAccounts } from '../lib/access.js';
import { areConnected } from '../lib/connections.js';
import { findByUsername } from '../lib/users.js';

export const accountsRouter = express.Router();
accountsRouter.use(requireAuth);

const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'credit', 'investment'];

function shapeAccount(row, userId) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    openingBalance: row.opening_balance_cents / 100,
    balance: accountBalanceCents(row.id) / 100,
    archived: Boolean(row.archived),
    role: row.role,
    owner: row.user_id === userId ? null : { username: row.owner_username, displayName: row.owner_name },
    shares: row.user_id === userId ? listShares(row.id) : undefined,
  };
}

function listShares(accountId) {
  return db
    .prepare(
      `SELECT s.role, u.* FROM account_shares s JOIN users u ON u.id = s.user_id WHERE s.account_id = ?`,
    )
    .all(accountId)
    .map((row) => ({ ...publicUser(row), role: row.role }));
}

accountsRouter.get('/', (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  res.json({ accounts: visibleAccounts(req.user.id, { includeArchived }).map((a) => shapeAccount(a, req.user.id)) });
});

const accountSchema = z.object({
  name: z.string().trim().min(1, 'Give the account a name').max(60),
  type: z.enum(ACCOUNT_TYPES),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  openingBalance: moneySchema.optional(),
});

accountsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = parse(accountSchema, req.body);
    const info = db
      .prepare('INSERT INTO accounts (user_id, name, type, currency, opening_balance_cents) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, body.name, body.type, body.currency || req.user.currency, body.openingBalance ?? 0);
    const row = requireAccount(info.lastInsertRowid, req.user.id);
    res.status(201).json({ account: shapeAccount({ ...row, owner_username: req.user.username }, req.user.id) });
  }),
);

accountsRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const account = requireAccount(req.params.id, req.user.id, { write: true });
    if (account.role !== 'owner') throw forbidden('Only the owner can change an account');
    const body = parse(accountSchema.partial().extend({ archived: z.boolean().optional() }), req.body);
    db.prepare(
      `UPDATE accounts SET name = COALESCE(@name, name), type = COALESCE(@type, type),
              currency = COALESCE(@currency, currency),
              opening_balance_cents = COALESCE(@openingBalance, opening_balance_cents),
              archived = COALESCE(@archived, archived)
        WHERE id = @id`,
    ).run({
      id: account.id,
      name: body.name ?? null,
      type: body.type ?? null,
      currency: body.currency ?? null,
      openingBalance: body.openingBalance ?? null,
      archived: body.archived === undefined ? null : body.archived ? 1 : 0,
    });
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
    res.json({ account: shapeAccount({ ...row, role: 'owner' }, req.user.id) });
  }),
);

accountsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const account = requireAccount(req.params.id, req.user.id);
    if (account.role !== 'owner') throw forbidden('Only the owner can delete an account');
    db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
    res.json({ ok: true });
  }),
);

/** Share an account with someone you are connected to. */
accountsRouter.post(
  '/:id/shares',
  asyncRoute(async (req, res) => {
    const account = requireAccount(req.params.id, req.user.id);
    if (account.role !== 'owner') throw forbidden('Only the owner can share an account');
    const body = parse(z.object({ username: usernameSchema, role: z.enum(['viewer', 'editor']).default('viewer') }), req.body);
    const target = findByUsername(body.username);
    if (!target) throw notFound('No one is using that username');
    if (target.id === req.user.id) throw badRequest('You already own that account');
    if (!areConnected(req.user.id, target.id)) throw badRequest('Connect with them first, by username or QR code');
    try {
      db.prepare('INSERT INTO account_shares (account_id, user_id, role) VALUES (?, ?, ?)').run(account.id, target.id, body.role);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        db.prepare('UPDATE account_shares SET role = ? WHERE account_id = ? AND user_id = ?').run(body.role, account.id, target.id);
      } else throw err;
    }
    res.status(201).json({ shares: listShares(account.id) });
  }),
);

accountsRouter.delete(
  '/:id/shares/:username',
  asyncRoute(async (req, res) => {
    const account = requireAccount(req.params.id, req.user.id);
    const target = findByUsername(req.params.username);
    if (!target) throw notFound('No one is using that username');
    // The owner can revoke; a recipient can always remove their own access.
    if (account.role !== 'owner' && target.id !== req.user.id) throw forbidden('You cannot change that share');
    db.prepare('DELETE FROM account_shares WHERE account_id = ? AND user_id = ?').run(account.id, target.id);
    res.json({ ok: true });
  }),
);
