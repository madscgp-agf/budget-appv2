import { api } from '../api.js';
import { store } from '../store.js';
import { clear, confirmDialog, dayHeading, el, emptyState, icon, money, select, toast } from '../ui.js';
import { transactionModal, transferModal } from './forms.js';

const state = { accountId: '', categoryId: '', type: '', q: '', from: '', to: '', offset: 0 };

export async function renderTransactions(root) {
  clear(root);
  await store.loadEssentials();

  const listHost = el('div', { class: 'card' });
  const refresh = () => load();

  const filters = el(
    'div',
    { class: 'filters' },
    Object.assign(
      el('input', { type: 'search', placeholder: 'Search description or notes', class: 'grow-2', value: state.q }),
      {
        oninput: debounce((event) => {
          state.q = event.target.value;
          state.offset = 0;
          load();
        }, 300),
      },
    ),
    onChange(
      select(
        [{ value: '', label: 'All accounts' }, ...store.accounts.map((a) => ({ value: a.id, label: a.name }))],
        { value: state.accountId },
      ),
      (value) => {
        state.accountId = value;
        state.offset = 0;
        load();
      },
    ),
    onChange(
      select(
        [{ value: '', label: 'All categories' }, ...store.categories.map((c) => ({ value: c.id, label: c.name }))],
        { value: state.categoryId },
      ),
      (value) => {
        state.categoryId = value;
        state.offset = 0;
        load();
      },
    ),
    onChange(
      select(
        [
          { value: '', label: 'All types' },
          { value: 'expense', label: 'Expenses' },
          { value: 'income', label: 'Income' },
          { value: 'transfer', label: 'Transfers' },
        ],
        { value: state.type },
      ),
      (value) => {
        state.type = value;
        state.offset = 0;
        load();
      },
    ),
  );

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Transactions'), el('p', { class: 'sub' }, 'Everything you have logged, newest first.')),
      el(
        'div',
        { class: 'head-actions' },
        el('button', { class: 'btn', onclick: () => transferModal({ onSaved: refresh }) }, icon('repeat', 16), 'Transfer'),
        el('button', { class: 'btn btn-primary', onclick: () => transactionModal({ onSaved: refresh }) }, icon('plus', 16), 'Add'),
      ),
    ),
    filters,
    listHost,
  );

  async function load() {
    clear(listHost);
    listHost.append(el('div', { class: 'splash', style: { minHeight: '160px' } }, el('div', { class: 'spinner' })));

    const data = await api.get('/api/transactions', {
      accountId: state.accountId,
      categoryId: state.categoryId,
      type: state.type,
      q: state.q,
      from: state.from,
      to: state.to,
      limit: 50,
      offset: state.offset,
    });

    clear(listHost);
    if (data.transactions.length === 0) {
      listHost.append(
        emptyState(
          '\u{1F50E}',
          'Nothing here',
          state.q || state.accountId || state.categoryId || state.type
            ? 'No transactions match these filters.'
            : 'Add your first transaction to get started.',
          el('button', { class: 'btn btn-primary', onclick: () => transactionModal({ onSaved: refresh }) }, 'Add transaction'),
        ),
      );
      return;
    }

    // Group by day so a long list stays readable.
    const groups = new Map();
    for (const tx of data.transactions) {
      if (!groups.has(tx.date)) groups.set(tx.date, []);
      groups.get(tx.date).push(tx);
    }

    for (const [date, items] of groups) {
      const dayTotal = items.reduce((sum, tx) => (tx.type === 'transfer' ? sum : sum + tx.amount), 0);
      listHost.append(
        el(
          'div',
          { class: 'day-group' },
          el(
            'div',
            { class: 'day-head', style: { display: 'flex', justifyContent: 'space-between' } },
            el('span', {}, dayHeading(date)),
            el('span', {}, money(dayTotal, store.currency, { sign: true })),
          ),
          el('div', { class: 'list' }, items.map((tx) => transactionRow(tx, refresh))),
        ),
      );
    }

    const shown = state.offset + data.transactions.length;
    if (shown < data.total) {
      listHost.append(
        el(
          'div',
          { style: { textAlign: 'center', paddingTop: '16px' } },
          el(
            'button',
            {
              class: 'btn',
              onclick: () => {
                state.offset += 50;
                load();
              },
            },
            `Load more (${data.total - shown} left)`,
          ),
        ),
      );
    }
    if (state.offset > 0) {
      listHost.append(
        el(
          'div',
          { style: { textAlign: 'center', paddingTop: '10px' } },
          el(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              onclick: () => {
                state.offset = 0;
                load();
              },
            },
            'Back to the top',
          ),
        ),
      );
    }
  }

  load();
}

function transactionRow(tx, refresh) {
  const color = tx.categoryColor || (tx.type === 'transfer' ? 'var(--muted)' : 'var(--brand)');
  return el(
    'div',
    { class: 'list-item' },
    el('div', { class: 'dot-icon', style: { background: `${color}22`, color } }, tx.type === 'transfer' ? '⇄' : tx.amount >= 0 ? '+' : '-'),
    el(
      'div',
      { class: 'grow' },
      el('div', { class: 'title' }, tx.description),
      el(
        'div',
        { class: 'meta' },
        [tx.categoryName, tx.accountName, tx.createdBy !== store.user.username ? `by @${tx.createdBy}` : null]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
    el('div', { class: `amount ${tx.amount >= 0 ? 'pos' : 'neg'}` }, money(tx.amount, tx.currency || store.currency, { sign: true })),
    el(
      'div',
      { class: 'item-actions' },
      tx.type === 'transfer'
        ? null
        : el(
            'button',
            { class: 'icon-btn', title: 'Edit', onclick: () => transactionModal({ transaction: tx, onSaved: refresh }) },
            icon('pencil', 16),
          ),
      el(
        'button',
        {
          class: 'icon-btn',
          title: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Delete transaction?',
              message: tx.transferGroup ? 'Both sides of this transfer will be removed.' : `"${tx.description}" will be removed.`,
            });
            if (!ok) return;
            await api.del(`/api/transactions/${tx.id}`);
            toast('Transaction deleted');
            refresh();
          },
        },
        icon('trash', 16),
      ),
    ),
  );
}

function onChange(node, handler) {
  node.addEventListener('change', (event) => handler(event.target.value));
  return node;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
