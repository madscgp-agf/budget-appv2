import { db } from '../db.js';
import { forbidden, notFound } from './errors.js';

/**
 * Every account a user can see: their own plus any shared with them.
 * `role` is 'owner', 'editor' or 'viewer'.
 */
export function visibleAccounts(userId, { includeArchived = false } = {}) {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT a.*, 'owner' AS role, u.username AS owner_username, u.display_name AS owner_name
           FROM accounts a JOIN users u ON u.id = a.user_id
          WHERE a.user_id = @id AND (@includeArchived = 1 OR a.archived = 0)
         UNION ALL
         SELECT a.*, s.role AS role, u.username AS owner_username, u.display_name AS owner_name
           FROM accounts a
           JOIN account_shares s ON s.account_id = a.id
           JOIN users u ON u.id = a.user_id
          WHERE s.user_id = @id AND (@includeArchived = 1 OR a.archived = 0)
       )
       ORDER BY role != 'owner', name COLLATE NOCASE`,
    )
    .all({ id: userId, includeArchived: includeArchived ? 1 : 0 });
}

export function visibleAccountIds(userId) {
  return visibleAccounts(userId, { includeArchived: true }).map((a) => a.id);
}

/** Loads one account, checking the caller has at least the required role. */
export function requireAccount(accountId, userId, { write = false } = {}) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!account) throw notFound('Account not found');
  if (account.user_id === userId) return { ...account, role: 'owner' };

  const share = db.prepare('SELECT * FROM account_shares WHERE account_id = ? AND user_id = ?').get(account.id, userId);
  if (!share) throw notFound('Account not found');
  if (write && share.role !== 'editor') throw forbidden('You have view-only access to that account');
  return { ...account, role: share.role };
}

/** Loads a category owned by the caller. */
export function requireCategory(categoryId, userId) {
  const row = db.prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?').get(Number(categoryId), userId);
  if (!row) throw notFound('Category not found');
  return row;
}

/** The current balance of an account: opening balance plus every transaction. */
export function accountBalanceCents(accountId) {
  const row = db
    .prepare(
      `SELECT (SELECT opening_balance_cents FROM accounts WHERE id = @id)
              + COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE account_id = @id), 0) AS balance`,
    )
    .get({ id: accountId });
  return row.balance || 0;
}
