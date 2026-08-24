import { api } from '../api.js';
import { store } from '../store.js';
import { el, field, openModal, select, toast } from '../ui.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

/** Add or edit a transaction. Resolves through `onSaved` after a successful write. */
export function transactionModal({ transaction = null, onSaved, defaults = {} } = {}) {
  const editing = Boolean(transaction);
  const accounts = store.writableAccounts();

  if (accounts.length === 0) {
    toast('Create an account first', 'bad');
    return null;
  }

  let type = transaction?.type === 'income' ? 'income' : 'expense';

  const amount = el('input', {
    type: 'number',
    step: '0.01',
    min: '0',
    placeholder: '0.00',
    required: true,
    value: transaction ? Math.abs(transaction.amount).toFixed(2) : '',
  });
  const description = el('input', {
    type: 'text',
    placeholder: 'Coffee, rent, payday...',
    required: true,
    maxlength: '120',
    value: transaction?.description || '',
  });
  const accountSelect = select(
    accounts.map((a) => ({ value: a.id, label: a.shared ? `${a.name} (shared)` : a.name })),
    { value: transaction?.accountId ?? defaults.accountId ?? accounts[0].id },
  );
  const categorySlot = el('div');
  const date = el('input', { type: 'date', value: transaction?.date || defaults.date || todayStr(), required: true });
  const notes = el('textarea', { placeholder: 'Optional notes', maxlength: '500' }, transaction?.notes || '');

  const drawCategories = () => {
    const options = [
      { value: '', label: 'No category' },
      ...store.categoriesOfKind(type).map((c) => ({ value: c.id, label: c.name })),
    ];
    const chosen = categorySlot.querySelector('select')?.value ?? transaction?.categoryId ?? '';
    categorySlot.replaceChildren(field('Category', select(options, { value: chosen })));
  };

  const typeToggle = el(
    'div',
    { class: 'tabs' },
    ['expense', 'income'].map((kind) =>
      el(
        'button',
        {
          type: 'button',
          class: kind === type ? 'active' : '',
          onclick: (event) => {
            type = kind;
            for (const button of typeToggle.children) button.classList.toggle('active', button === event.currentTarget);
            drawCategories();
          },
        },
        kind === 'expense' ? 'Expense' : 'Income',
      ),
    ),
  );

  drawCategories();

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, editing ? 'Save changes' : 'Add transaction');

  const form = el(
    'form',
    { id: 'transaction-form' },
    typeToggle,
    field('Amount', amount),
    field('Description', description),
    field('Account', accountSelect),
    categorySlot,
    field('Date', date),
    field('Notes', notes),
  );

  const dialog = openModal({
    title: editing ? 'Edit transaction' : 'New transaction',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    dialog.showError(null);
    save.disabled = true;
    const categoryValue = categorySlot.querySelector('select').value;
    const payload = {
      accountId: Number(accountSelect.value),
      categoryId: categoryValue ? Number(categoryValue) : null,
      amount: amount.value,
      type,
      description: description.value.trim(),
      notes: notes.value.trim() || null,
      date: date.value,
    };
    try {
      if (editing) await api.patch(`/api/transactions/${transaction.id}`, payload);
      else await api.post('/api/transactions', payload);
      dialog.close();
      toast(editing ? 'Transaction updated' : 'Transaction added', 'good');
      await onSaved?.();
    } catch (err) {
      dialog.showError(err.message);
    } finally {
      save.disabled = false;
    }
  });

  return dialog;
}

/** Move money between two accounts. */
export function transferModal({ onSaved } = {}) {
  const accounts = store.writableAccounts();
  if (accounts.length < 2) {
    toast('You need two accounts to make a transfer', 'bad');
    return null;
  }

  const options = accounts.map((a) => ({ value: a.id, label: a.name }));
  const from = select(options, { value: accounts[0].id });
  const to = select(options, { value: accounts[1].id });
  const amount = el('input', { type: 'number', step: '0.01', min: '0.01', placeholder: '0.00', required: true });
  const description = el('input', { type: 'text', placeholder: 'Optional description', maxlength: '120' });
  const date = el('input', { type: 'date', value: todayStr(), required: true });
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Transfer');

  const form = el('form', {}, field('From', from), field('To', to), field('Amount', amount), field('Description', description), field('Date', date));

  const dialog = openModal({
    title: 'Transfer between accounts',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    dialog.showError(null);
    save.disabled = true;
    try {
      await api.post('/api/transactions/transfer', {
        fromAccountId: Number(from.value),
        toAccountId: Number(to.value),
        amount: amount.value,
        description: description.value.trim() || undefined,
        date: date.value,
      });
      dialog.close();
      toast('Transfer recorded', 'good');
      await onSaved?.();
    } catch (err) {
      dialog.showError(err.message);
    } finally {
      save.disabled = false;
    }
  });

  return dialog;
}
