import { api } from '../api.js';
import { store } from '../store.js';
import { clear, el, emptyState, icon, money, periodLabel, shortDate } from '../ui.js';
import { transactionModal, transferModal } from './forms.js';
import { navigate } from '../router.js';

function statCard(label, value, { delta, tone } = {}) {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'label' }, label),
    el('div', { class: `value ${tone || ''}` }, value),
    delta ? el('div', { class: 'delta' }, delta) : null,
  );
}

function deltaText(current, previous, currency) {
  if (!previous) return null;
  const change = current - previous;
  if (Math.abs(change) < 0.005) return 'Same as last month';
  const direction = change > 0 ? 'more' : 'less';
  return `${money(Math.abs(change), currency)} ${direction} than last month`;
}

/** Donut chart built from a conic gradient -- no chart library needed. */
function donut(items, currency) {
  const total = items.reduce((sum, item) => sum + item.total, 0);
  if (total <= 0) return null;

  let cursor = 0;
  const stops = items.slice(0, 8).map((item) => {
    const start = (cursor / total) * 100;
    cursor += item.total;
    const end = (cursor / total) * 100;
    return `${item.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
  });
  if (cursor < total) stops.push(`var(--border) ${(cursor / total) * 100}% 100%`);

  return el(
    'div',
    { class: 'donut-wrap' },
    el(
      'div',
      { class: 'donut', style: { background: `conic-gradient(${stops.join(',')})` } },
      el(
        'div',
        { class: 'donut-center' },
        el('div', { class: 't' }, 'Spent'),
        el('div', { class: 'v' }, money(total, currency)),
      ),
    ),
    el(
      'div',
      { class: 'donut-legend' },
      items.slice(0, 8).map((item) =>
        el(
          'div',
          { class: 'r' },
          el('span', { class: 'sw', style: { background: item.color } }),
          el('span', { class: 'nm' }, item.name),
          el('span', { class: 'vl' }, `${money(item.total, currency)} · ${Math.round((item.total / total) * 100)}%`),
        ),
      ),
    ),
  );
}

function cashflowChart(series, currency) {
  const peak = Math.max(...series.map((point) => Math.max(point.income, point.expenses)), 1);
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'chart' },
      series.map((point) =>
        el(
          'div',
          { class: 'chart-col', title: `${point.period}: +${money(point.income, currency)} / -${money(point.expenses, currency)}` },
          el(
            'div',
            { class: 'chart-bars' },
            el('div', { class: 'chart-bar income', style: { height: `${(point.income / peak) * 100}%` } }),
            el('div', { class: 'chart-bar expense', style: { height: `${(point.expenses / peak) * 100}%` } }),
          ),
          el('div', { class: 'chart-label' }, point.period.slice(5)),
        ),
      ),
    ),
    el(
      'div',
      { class: 'legend', style: { marginTop: '12px' } },
      el('span', {}, el('i', { style: { background: 'var(--good)' } }), 'Income'),
      el('span', {}, el('i', { style: { background: 'var(--bad)' } }), 'Expenses'),
    ),
  );
}

export async function renderDashboard(root) {
  clear(root);
  root.append(el('div', { class: 'splash' }, el('div', { class: 'spinner' })));

  const [summary, cashflow] = await Promise.all([
    api.get('/api/reports/summary', { period: store.period }),
    api.get('/api/reports/cashflow', { period: store.period, months: 6 }),
  ]);
  const currency = summary.currency;

  const refresh = () => renderDashboard(root);

  clear(root);
  root.append(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', {}, `Hello, ${store.user.displayName.split(' ')[0]}`),
        el('p', { class: 'sub' }, `Here is how ${periodLabel(summary.period)} is going.`),
      ),
      el(
        'div',
        { class: 'head-actions' },
        el('button', { class: 'btn', onclick: () => transferModal({ onSaved: refresh }) }, icon('repeat', 16), 'Transfer'),
        el(
          'button',
          { class: 'btn btn-primary', onclick: () => transactionModal({ onSaved: refresh }) },
          icon('plus', 16),
          'Add transaction',
        ),
      ),
    ),
  );

  if (summary.pendingConnections > 0) {
    root.append(
      el(
        'div',
        { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' } },
        el('span', { style: { fontSize: '22px' } }, '\u{1F44B}'),
        el(
          'div',
          { style: { flex: '1' } },
          el('div', { style: { fontWeight: '600', fontSize: '14px' } }, `${summary.pendingConnections} connection request${summary.pendingConnections > 1 ? 's' : ''}`),
          el('div', { style: { fontSize: '13px', color: 'var(--muted)' } }, 'Someone wants to connect with you.'),
        ),
        el('button', { class: 'btn btn-sm', onclick: () => navigate('/people') }, 'Review'),
      ),
    );
  }

  const net = summary.totals.net;
  root.append(
    el(
      'div',
      { class: 'grid grid-4', style: { marginBottom: '16px' } },
      statCard('Net worth', money(summary.netWorth, currency), { tone: summary.netWorth < 0 ? 'neg' : '' }),
      statCard('Income', money(summary.totals.income, currency), {
        tone: 'pos',
        delta: deltaText(summary.totals.income, summary.previousTotals.income, currency),
      }),
      statCard('Spent', money(summary.totals.expenses, currency), {
        tone: 'neg',
        delta: deltaText(summary.totals.expenses, summary.previousTotals.expenses, currency),
      }),
      statCard('Left over', money(net, currency), {
        tone: net >= 0 ? 'pos' : 'neg',
        delta: summary.budgetedTotal > 0 ? `${money(summary.budgetedTotal, currency)} budgeted` : 'No budgets set yet',
      }),
    ),
  );

  const spendingCard = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h3', {}, 'Where it went'),
      el('button', { class: 'link', onclick: () => navigate('/budgets') }, 'Budgets'),
    ),
    summary.byCategory.length
      ? donut(summary.byCategory, currency)
      : emptyState('\u{1F4CA}', 'No spending yet', 'Add a transaction and it will show up here.'),
  );

  const trendCard = el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', {}, 'Last 6 months')),
    cashflowChart(cashflow.series, currency),
  );

  root.append(el('div', { class: 'grid grid-2' }, spendingCard, trendCard));

  const recentCard = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h3', {}, 'Recent activity'),
      el('button', { class: 'link', onclick: () => navigate('/transactions') }, 'See all'),
    ),
    summary.recent.length
      ? el(
          'div',
          { class: 'list' },
          summary.recent.map((tx) =>
            el(
              'div',
              { class: 'list-item' },
              el(
                'div',
                {
                  class: 'dot-icon',
                  style: { background: `${tx.categoryColor || 'var(--brand)'}22`, color: tx.categoryColor || 'var(--brand)' },
                },
                tx.type === 'transfer' ? '⇄' : tx.amount >= 0 ? '+' : '-',
              ),
              el(
                'div',
                { class: 'grow' },
                el('div', { class: 'title' }, tx.description),
                el('div', { class: 'meta' }, `${shortDate(tx.date)} · ${tx.categoryName || tx.accountName}`),
              ),
              el('div', { class: `amount ${tx.amount >= 0 ? 'pos' : 'neg'}` }, money(tx.amount, currency, { sign: true })),
            ),
          ),
        )
      : emptyState(
          '\u{1F9FE}',
          'Nothing logged yet',
          'Your transactions will appear here.',
          el('button', { class: 'btn btn-primary', onclick: () => transactionModal({ onSaved: refresh }) }, 'Add your first one'),
        ),
  );

  const accountsCard = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h3', {}, 'Accounts'),
      el('button', { class: 'link', onclick: () => navigate('/accounts') }, 'Manage'),
    ),
    el(
      'div',
      { class: 'list' },
      summary.accounts.map((account) =>
        el(
          'div',
          { class: 'list-item' },
          el('div', { class: 'dot-icon', style: { background: 'var(--brand-soft)', color: 'var(--brand-strong)' } }, icon('wallet', 16)),
          el(
            'div',
            { class: 'grow' },
            el('div', { class: 'title' }, account.name),
            el('div', { class: 'meta' }, account.shared ? `Shared · ${account.role}` : account.type),
          ),
          el('div', { class: `amount ${account.balance < 0 ? 'neg' : ''}` }, money(account.balance, currency)),
        ),
      ),
    ),
  );

  root.append(el('div', { class: 'grid grid-2' }, recentCard, accountsCard));
}
