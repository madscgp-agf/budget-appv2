import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startServer, signUp } from './helpers.js';

useTempDatabase('budget');
const harness = await startServer();
test.after(() => harness.close());

const ada = await signUp(harness, { username: 'ada' });
const accountId = (await ada.client.get('/api/accounts')).body.accounts[0].id;
const categories = (await ada.client.get('/api/categories')).body.categories;
const groceries = categories.find((c) => c.name === 'Groceries');
const salary = categories.find((c) => c.name === 'Salary');
const period = new Date().toISOString().slice(0, 7);
const day = `${period}-05`;

test('records income and expenses with the right sign', async () => {
  const expense = await ada.client.post('/api/transactions', {
    accountId,
    categoryId: groceries.id,
    amount: '42.50',
    type: 'expense',
    description: 'Weekly shop',
    date: day,
  });
  assert.equal(expense.status, 201);
  assert.equal(expense.body.transaction.amount, -42.5);

  const income = await ada.client.post('/api/transactions', {
    accountId,
    categoryId: salary.id,
    amount: 2000,
    type: 'income',
    description: 'Payday',
    date: day,
  });
  assert.equal(income.body.transaction.amount, 2000);
});

test('the account balance is the sum of everything in it', async () => {
  const account = (await ada.client.get('/api/accounts')).body.accounts[0];
  assert.equal(account.balance, 1957.5);
});

test('filters transactions by category, type and search text', async () => {
  assert.equal((await ada.client.get(`/api/transactions?categoryId=${groceries.id}`)).body.transactions.length, 1);
  assert.equal((await ada.client.get('/api/transactions?type=income')).body.transactions.length, 1);
  assert.equal((await ada.client.get('/api/transactions?q=Weekly')).body.transactions.length, 1);
  assert.equal((await ada.client.get('/api/transactions?q=nothing-matches')).body.transactions.length, 0);
});

test('editing a transaction keeps the sign consistent with its type', async () => {
  const tx = (await ada.client.get('/api/transactions?q=Weekly')).body.transactions[0];
  const updated = await ada.client.patch(`/api/transactions/${tx.id}`, { amount: '30', description: 'Corner shop' });
  assert.equal(updated.body.transaction.amount, -30);
  assert.equal(updated.body.transaction.description, 'Corner shop');
});

test('a transfer moves money without changing the total', async () => {
  const savings = await ada.client.post('/api/accounts', { name: 'Savings', type: 'savings' });
  const before = (await ada.client.get('/api/reports/summary')).body.netWorth;

  const transfer = await ada.client.post('/api/transactions/transfer', {
    fromAccountId: accountId,
    toAccountId: savings.body.account.id,
    amount: 500,
    date: day,
  });
  assert.equal(transfer.status, 201);
  assert.equal(transfer.body.transfer.transactions.length, 2);

  const after = await ada.client.get('/api/reports/summary');
  assert.equal(after.body.netWorth, before);
  // Transfers must not count as income or spending.
  assert.equal(after.body.totals.expenses, 30);
  assert.equal(after.body.totals.income, 2000);
});

test('deleting one leg of a transfer removes both', async () => {
  const transfer = (await ada.client.get('/api/transactions?type=transfer')).body.transactions;
  assert.equal(transfer.length, 2);
  await ada.client.del(`/api/transactions/${transfer[0].id}`);
  assert.equal((await ada.client.get('/api/transactions?type=transfer')).body.transactions.length, 0);
});

test('a transfer needs two different accounts', async () => {
  const res = await ada.client.post('/api/transactions/transfer', {
    fromAccountId: accountId,
    toAccountId: accountId,
    amount: 10,
  });
  assert.equal(res.status, 400);
});

test('budgets track spending and report what is left', async () => {
  assert.equal((await ada.client.put('/api/budgets', { categoryId: groceries.id, period, amount: 200 })).status, 200);

  const budgets = await ada.client.get(`/api/budgets?period=${period}`);
  const row = budgets.body.items.find((item) => item.categoryId === groceries.id);
  assert.equal(row.limit, 200);
  assert.equal(row.spent, 30);
  assert.equal(row.remaining, 170);
  assert.equal(row.over, false);
  assert.equal(budgets.body.totals.limit, 200);
});

test('a budget flags going over', async () => {
  await ada.client.post('/api/transactions', {
    accountId,
    categoryId: groceries.id,
    amount: 300,
    type: 'expense',
    description: 'Big shop',
    date: day,
  });
  const row = (await ada.client.get(`/api/budgets?period=${period}`)).body.items.find((i) => i.categoryId === groceries.id);
  assert.equal(row.spent, 330);
  assert.equal(row.over, true);
  assert.equal(row.remaining, -130);
});

test('setting a budget to zero clears it', async () => {
  await ada.client.put('/api/budgets', { categoryId: groceries.id, period, amount: 0 });
  const row = (await ada.client.get(`/api/budgets?period=${period}`)).body.items.find((i) => i.categoryId === groceries.id);
  assert.equal(row.limit, 0);
  assert.equal(row.budgetId, null);
});

test('budgets can be copied into another month', async () => {
  await ada.client.put('/api/budgets', { categoryId: groceries.id, period, amount: 150 });
  const next = '2099-01';
  const copied = await ada.client.post('/api/budgets/copy', { from: period, to: next });
  assert.equal(copied.body.copied, 1);
  const row = (await ada.client.get(`/api/budgets?period=${next}`)).body.items.find((i) => i.categoryId === groceries.id);
  assert.equal(row.limit, 150);
});

test('goals accumulate contributions and stop at zero', async () => {
  const goal = await ada.client.post('/api/goals', { name: 'Holiday', target: 1000 });
  assert.equal(goal.body.goal.saved, 0);

  const funded = await ada.client.post(`/api/goals/${goal.body.goal.id}/contribute`, { amount: 250 });
  assert.equal(funded.body.goal.saved, 250);
  assert.equal(funded.body.goal.remaining, 750);
  assert.equal(funded.body.goal.progress, 0.25);

  const emptied = await ada.client.post(`/api/goals/${goal.body.goal.id}/contribute`, { amount: -400 });
  assert.equal(emptied.body.goal.saved, 0);
});

test('a recurring rule posts everything due and moves its date on', async () => {
  const rule = await ada.client.post('/api/recurring', {
    accountId,
    categoryId: groceries.id,
    description: 'Rent',
    amount: 100,
    type: 'expense',
    cadence: 'monthly',
    nextRunOn: '2024-01-01',
  });
  assert.equal(rule.status, 201);

  const run = await ada.client.post('/api/recurring/run');
  assert.ok(run.body.posted >= 12, `expected a catch-up run, got ${run.body.posted}`);

  const posted = await ada.client.get('/api/transactions?q=Rent&limit=500');
  assert.equal(posted.body.transactions.length, run.body.posted);
  assert.ok(posted.body.transactions.every((tx) => tx.amount === -100));

  // Running again posts nothing new: the rule has moved into the future.
  assert.equal((await ada.client.post('/api/recurring/run')).body.posted, 0);
});

test('reports break spending down by category', async () => {
  const report = await ada.client.get(`/api/reports/by-category?period=${period}`);
  const row = report.body.items.find((item) => item.name === 'Groceries');
  assert.ok(row.total > 0);

  const cashflow = await ada.client.get('/api/reports/cashflow?months=6');
  assert.equal(cashflow.body.series.length, 6);
});

test('validation rejects nonsense input', async () => {
  assert.equal((await ada.client.post('/api/transactions', { accountId, amount: 'abc', type: 'expense', description: 'x' })).status, 400);
  assert.equal((await ada.client.post('/api/transactions', { accountId, amount: 5, type: 'wat', description: 'x' })).status, 400);
  assert.equal((await ada.client.post('/api/transactions', { accountId, amount: 5, type: 'expense', description: '' })).status, 400);
  assert.equal((await ada.client.put('/api/budgets', { categoryId: groceries.id, period: 'nope', amount: 5 })).status, 400);
});
