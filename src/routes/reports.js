import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accountBalanceCents, visibleAccountIds, visibleAccounts } from '../lib/access.js';
import { currentPeriod, periodRange, shiftPeriod } from '../lib/dates.js';
import { periodSchema } from '../lib/validate.js';

export const reportsRouter = express.Router();
reportsRouter.use(requireAuth);

const askedPeriod = (req) =>
  periodSchema.safeParse(String(req.query.period || '')).success ? String(req.query.period) : currentPeriod();

function totalsForRange(accountIds, start, end) {
  if (accountIds.length === 0) return { income: 0, expenses: 0 };
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS income,
              COALESCE(SUM(CASE WHEN amount_cents < 0 THEN -amount_cents END), 0) AS expenses
         FROM transactions
        WHERE account_id IN (${accountIds.map(() => '?').join(',')})
          AND type != 'transfer' AND occurred_on BETWEEN ? AND ?`,
    )
    .get(...accountIds, start, end);
  return { income: row.income / 100, expenses: row.expenses / 100 };
}

/** Everything the dashboard needs in one round trip. */
reportsRouter.get('/summary', (req, res) => {
  const period = askedPeriod(req);
  const { start, end } = periodRange(period);
  const accounts = visibleAccounts(req.user.id);
  const accountIds = accounts.map((a) => a.id);

  const totals = totalsForRange(accountIds, start, end);
  const previous = periodRange(shiftPeriod(period, -1));
  const previousTotals = totalsForRange(accountIds, previous.start, previous.end);

  const netWorth = accounts.reduce((sum, a) => sum + accountBalanceCents(a.id), 0) / 100;

  const byCategory =
    accountIds.length === 0
      ? []
      : db
          .prepare(
            `SELECT c.id, c.name, c.color, SUM(-t.amount_cents) AS total
               FROM transactions t JOIN categories c ON c.id = t.category_id
              WHERE t.account_id IN (${accountIds.map(() => '?').join(',')})
                AND t.type = 'expense' AND t.occurred_on BETWEEN ? AND ?
              GROUP BY c.id ORDER BY total DESC`,
          )
          .all(...accountIds, start, end)
          .map((r) => ({ categoryId: r.id, name: r.name, color: r.color, total: r.total / 100 }));

  const budgetRow = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM budgets WHERE user_id = ? AND period = ?')
    .get(req.user.id, period);

  const recent =
    accountIds.length === 0
      ? []
      : db
          .prepare(
            `SELECT t.*, a.name AS account_name, c.name AS category_name, c.color AS category_color
               FROM transactions t JOIN accounts a ON a.id = t.account_id
               LEFT JOIN categories c ON c.id = t.category_id
              WHERE t.account_id IN (${accountIds.map(() => '?').join(',')})
              ORDER BY t.occurred_on DESC, t.id DESC LIMIT 8`,
          )
          .all(...accountIds)
          .map((r) => ({
            id: r.id,
            description: r.description,
            amount: r.amount_cents / 100,
            type: r.type,
            date: r.occurred_on,
            accountName: r.account_name,
            categoryName: r.category_name,
            categoryColor: r.category_color,
          }));

  const pendingConnections = db
    .prepare("SELECT COUNT(*) AS n FROM connections WHERE addressee_id = ? AND status = 'pending'")
    .get(req.user.id).n;

  res.json({
    period,
    currency: req.user.currency,
    netWorth,
    totals: { ...totals, net: totals.income - totals.expenses },
    previousTotals: { ...previousTotals, net: previousTotals.income - previousTotals.expenses },
    budgetedTotal: budgetRow.total / 100,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      role: a.role,
      balance: accountBalanceCents(a.id) / 100,
      shared: a.role !== 'owner',
    })),
    byCategory,
    recent,
    pendingConnections,
  });
});

/** Income and expenses month by month, for the trend chart. */
reportsRouter.get('/cashflow', (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
  const accountIds = visibleAccountIds(req.user.id);
  const end = askedPeriod(req);
  const series = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const period = shiftPeriod(end, -i);
    const { start, end: last } = periodRange(period);
    const totals = totalsForRange(accountIds, start, last);
    series.push({ period, ...totals, net: totals.income - totals.expenses });
  }
  res.json({ series });
});

/** Spending by category over an arbitrary range. */
reportsRouter.get('/by-category', (req, res) => {
  const accountIds = visibleAccountIds(req.user.id);
  const period = askedPeriod(req);
  const range = periodRange(period);
  const from = String(req.query.from || range.start);
  const to = String(req.query.to || range.end);
  if (accountIds.length === 0) return res.json({ from, to, items: [] });

  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.color, c.kind, SUM(ABS(t.amount_cents)) AS total, COUNT(*) AS count
         FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.account_id IN (${accountIds.map(() => '?').join(',')})
          AND t.type != 'transfer' AND t.occurred_on BETWEEN ? AND ?
        GROUP BY c.id ORDER BY total DESC`,
    )
    .all(...accountIds, from, to);

  res.json({
    from,
    to,
    items: rows.map((r) => ({
      categoryId: r.id,
      name: r.name,
      color: r.color,
      kind: r.kind,
      total: r.total / 100,
      count: r.count,
    })),
  });
});
