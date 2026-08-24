import { api } from '../api.js';
import { store } from '../store.js';
import { clear, el, emptyState, field, icon, money, openModal, periodLabel, select, toast } from '../ui.js';

export async function renderBudgets(root) {
  clear(root);
  await store.loadCategories();

  const host = el('div', {});
  const periodLabelNode = el('span', { class: 'label' }, periodLabel(store.period));

  const move = (months) => {
    const [y, m] = store.period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + months, 1));
    store.period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    periodLabelNode.textContent = periodLabel(store.period);
    load();
  };

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Budgets'), el('p', { class: 'sub' }, 'Set a monthly limit per category and watch what is left.')),
      el(
        'div',
        { class: 'head-actions' },
        el(
          'div',
          { class: 'period-nav' },
          el('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => move(-1) }, icon('chevronLeft', 18)),
          periodLabelNode,
          el('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => move(1) }, icon('chevronRight', 18)),
        ),
        el('button', { class: 'btn', onclick: () => copyModal(load) }, 'Copy last month'),
      ),
    ),
    host,
  );

  async function load() {
    clear(host);
    host.append(el('div', { class: 'splash', style: { minHeight: '160px' } }, el('div', { class: 'spinner' })));
    const data = await api.get('/api/budgets', { period: store.period });
    clear(host);

    if (data.items.length === 0) {
      host.append(
        el('div', { class: 'card' }, emptyState('\u{1F3F7}', 'No expense categories yet', 'Add categories in Settings, then set a budget for each.')),
      );
      return;
    }

    const currency = store.currency;
    const budgeted = data.items.filter((item) => item.limit > 0);
    const overall = data.totals.limit > 0 ? Math.min(data.totals.spent / data.totals.limit, 1.5) : 0;

    host.append(
      el(
        'div',
        { class: 'grid grid-3', style: { marginBottom: '16px' } },
        stat('Budgeted', money(data.totals.limit, currency)),
        stat('Spent', money(data.totals.spent, currency), data.totals.spent > data.totals.limit && data.totals.limit > 0 ? 'neg' : ''),
        stat('Remaining', money(data.totals.remaining, currency), data.totals.remaining < 0 ? 'neg' : 'pos'),
      ),
    );

    if (data.totals.limit > 0) {
      host.append(
        el(
          'div',
          { class: 'card' },
          el(
            'div',
            { class: 'card-head' },
            el('h3', {}, `${Math.round((data.totals.spent / data.totals.limit) * 100)}% of ${periodLabel(data.period)} used`),
            el('span', { class: 'pill ' + (data.totals.remaining < 0 ? 'bad' : 'good') },
              data.totals.remaining < 0 ? `${money(-data.totals.remaining, currency)} over` : `${money(data.totals.remaining, currency)} left`),
          ),
          el(
            'div',
            { class: 'bar-track', style: { height: '10px' } },
            el('div', {
              class: 'bar-fill',
              style: { width: `${overall * 100}%`, background: data.totals.remaining < 0 ? 'var(--bad)' : 'var(--brand)' },
            }),
          ),
        ),
      );
    }

    const rows = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'By category')));
    for (const item of data.items) {
      rows.append(budgetRow(item, data.period, currency, load));
    }
    host.append(rows);

    if (budgeted.length === 0) {
      host.append(
        el(
          'p',
          { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '13.5px', marginTop: '14px' } },
          'Tap a category above to set its monthly limit.',
        ),
      );
    }
  }

  load();
}

function stat(label, value, tone = '') {
  return el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: `value ${tone}` }, value));
}

function budgetRow(item, period, currency, refresh) {
  const pct = item.limit > 0 ? Math.min(item.spent / item.limit, 1) : 0;
  const barColor = item.over ? 'var(--bad)' : pct > 0.85 ? 'var(--warn)' : item.color;

  return el(
    'div',
    {
      class: 'budget-row',
      style: { cursor: 'pointer' },
      role: 'button',
      tabindex: '0',
      onclick: () => editBudget(item, period, currency, refresh),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          editBudget(item, period, currency, refresh);
        }
      },
    },
    el(
      'div',
      { class: 'top' },
      el('div', { class: 'name' }, el('span', { class: 'swatch', style: { background: item.color } }), item.categoryName),
      el(
        'div',
        { class: 'nums' },
        item.limit > 0 ? `${money(item.spent, currency)} of ${money(item.limit, currency)}` : `${money(item.spent, currency)} spent`,
      ),
    ),
    item.limit > 0
      ? el(
          'div',
          {},
          el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: { width: `${pct * 100}%`, background: barColor } })),
          el(
            'div',
            { class: 'foot' },
            el('span', {}, item.over ? `${money(-item.remaining, currency)} over budget` : `${money(item.remaining, currency)} left`),
            el('span', {}, `${Math.round((item.spent / item.limit) * 100)}%`),
          ),
        )
      : el('div', { class: 'foot' }, el('span', {}, 'No budget set'), el('span', {}, 'Tap to set one')),
  );
}

function editBudget(item, period, currency, refresh) {
  const amount = el('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    value: item.limit > 0 ? item.limit.toFixed(2) : '',
    placeholder: '0.00',
  });
  const save = el('button', { class: 'btn btn-primary' }, 'Save budget');

  const dialog = openModal({
    title: `${item.categoryName} · ${periodLabel(period)}`,
    body: el(
      'div',
      {},
      el('p', { style: { fontSize: '14px', color: 'var(--muted)', marginBottom: '16px' } },
        `You have spent ${money(item.spent, currency)} on ${item.categoryName} this month.`),
      field('Monthly limit', amount, { hint: 'Set it to 0 to remove the budget.' }),
    ),
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api.put('/api/budgets', { categoryId: item.categoryId, period, amount: amount.value || 0 });
      dialog.close();
      toast('Budget saved', 'good');
      refresh();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}

function copyModal(refresh) {
  const [y, m] = store.period.split('-').map(Number);
  const previous = new Date(Date.UTC(y, m - 2, 1));
  const from = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;

  const fromSelect = select(
    Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 2 - i, 1));
      const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      return { value, label: periodLabel(value) };
    }),
    { value: from },
  );
  const save = el('button', { class: 'btn btn-primary' }, 'Copy');

  const dialog = openModal({
    title: `Copy budgets into ${periodLabel(store.period)}`,
    body: field('Copy from', fromSelect, { hint: 'Existing budgets for this month will be overwritten.' }),
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const { copied } = await api.post('/api/budgets/copy', { from: fromSelect.value, to: store.period });
      dialog.close();
      toast(copied ? `Copied ${copied} budget${copied > 1 ? 's' : ''}` : 'There was nothing to copy', copied ? 'good' : '');
      refresh();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}
