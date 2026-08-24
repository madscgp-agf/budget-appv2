/**
 * Fills a database with a demo account so the app has something to show.
 *   npm run seed
 * Sign in afterwards as demo@example.com / demo1234.
 */
import bcrypt from 'bcryptjs';
import { db } from '../src/db.js';
import { createUser, findByEmail } from '../src/lib/users.js';
import { advanceDate, currentPeriod, shiftPeriod } from '../src/lib/dates.js';

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo1234';

const SPENDING = [
  ['Groceries', ['Weekly shop', 'Corner shop', 'Market run'], 22, 95],
  ['Rent & bills', ['Rent', 'Electricity', 'Internet'], 40, 950],
  ['Transport', ['Bus pass', 'Fuel', 'Train ticket'], 8, 60],
  ['Eating out', ['Coffee', 'Lunch out', 'Dinner with friends'], 4, 48],
  ['Health', ['Pharmacy', 'Gym'], 12, 45],
  ['Fun', ['Cinema', 'Books', 'Streaming'], 6, 35],
];

function pick(list, seed) {
  return list[seed % list.length];
}

async function main() {
  if (findByEmail(EMAIL)) {
    console.log(`${EMAIL} already exists — nothing to do.`);
    return;
  }

  const user = createUser({
    email: EMAIL,
    username: 'demo',
    displayName: 'Demo User',
    passwordHash: await bcrypt.hash(PASSWORD, 12),
  });

  const everyday = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(user.id);
  const savings = db
    .prepare("INSERT INTO accounts (user_id, name, type, currency, opening_balance_cents) VALUES (?, 'Savings', 'savings', ?, 320000)")
    .run(user.id, user.currency);
  const savingsId = savings.lastInsertRowid;

  const categories = Object.fromEntries(
    db.prepare('SELECT * FROM categories WHERE user_id = ?').all(user.id).map((c) => [c.name, c]),
  );

  const insert = db.prepare(
    `INSERT INTO transactions (account_id, category_id, created_by_id, amount_cents, type, description, occurred_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Three months of plausible history.
  db.transaction(() => {
    for (let monthsAgo = 2; monthsAgo >= 0; monthsAgo -= 1) {
      const period = shiftPeriod(currentPeriod(), -monthsAgo);
      insert.run(everyday.id, categories.Salary.id, user.id, 285000, 'income', 'Monthly salary', `${period}-01`);

      let seed = monthsAgo * 7 + 3;
      for (const [categoryName, labels, count, typical] of SPENDING) {
        for (let i = 0; i < count; i += 1) {
          seed = (seed * 31 + 17) % 997;
          const day = String(1 + (seed % 27)).padStart(2, '0');
          const jitter = 0.55 + (seed % 90) / 100;
          insert.run(
            everyday.id,
            categories[categoryName].id,
            user.id,
            -Math.round(typical * jitter * 100),
            'expense',
            pick(labels, seed),
            `${period}-${day}`,
          );
        }
      }
      insert.run(savingsId, categories.Savings.id, user.id, -30000, 'expense', 'Move to savings', `${period}-02`);
    }
  })();

  const period = currentPeriod();
  const budgetStmt = db.prepare('INSERT INTO budgets (user_id, category_id, period, amount_cents) VALUES (?, ?, ?, ?)');
  for (const [name, amount] of [
    ['Groceries', 45000],
    ['Rent & bills', 110000],
    ['Transport', 12000],
    ['Eating out', 20000],
    ['Health', 8000],
    ['Fun', 15000],
  ]) {
    budgetStmt.run(user.id, categories[name].id, period, amount);
  }

  db.prepare('INSERT INTO goals (user_id, name, target_cents, saved_cents, target_date) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    'Holiday fund',
    250000,
    82000,
    `${shiftPeriod(period, 8)}-01`,
  );
  db.prepare('INSERT INTO goals (user_id, name, target_cents, saved_cents, target_date) VALUES (?, ?, ?, ?, ?)').run(
    user.id,
    'Emergency buffer',
    600000,
    320000,
    null,
  );

  db.prepare(
    `INSERT INTO recurring_rules (user_id, account_id, category_id, description, amount_cents, type, cadence, next_run_on)
     VALUES (?, ?, ?, 'Rent', 95000, 'expense', 'monthly', ?)`,
  ).run(user.id, everyday.id, categories['Rent & bills'].id, advanceDate(`${period}-01`, 'monthly'));

  console.log(`Seeded a demo account.\n  email:    ${EMAIL}\n  password: ${PASSWORD}`);
}

main();
