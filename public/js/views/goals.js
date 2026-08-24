import { api } from '../api.js';
import { store } from '../store.js';
import { clear, confirmDialog, el, emptyState, field, icon, money, openModal, select, shortDate, toast } from '../ui.js';

export async function renderGoals(root) {
  clear(root);
  const refresh = () => renderGoals(root);
  const [{ goals }] = await Promise.all([api.get('/api/goals'), store.loadEssentials()]);
  const { rules } = await api.get('/api/recurring');

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Plans'), el('p', { class: 'sub' }, 'Savings goals and the bills that repeat every month.')),
      el(
        'div',
        { class: 'head-actions' },
        el('button', { class: 'btn', onclick: () => recurringModal({ onSaved: refresh }) }, icon('repeat', 16), 'New recurring'),
        el('button', { class: 'btn btn-primary', onclick: () => goalModal({ onSaved: refresh }) }, icon('plus', 16), 'New goal'),
      ),
    ),
  );

  const goalsCard = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Savings goals')));
  if (goals.length === 0) {
    goalsCard.append(emptyState('\u{1F3AF}', 'No goals yet', 'Set aside for a holiday, a deposit or a rainy day.',
      el('button', { class: 'btn btn-primary', onclick: () => goalModal({ onSaved: refresh }) }, 'Create a goal')));
  } else {
    for (const goal of goals) goalsCard.append(goalRow(goal, refresh));
  }

  const recurringCard = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Recurring')));
  if (rules.length === 0) {
    recurringCard.append(emptyState('\u{1F501}', 'Nothing repeating', 'Add rent, a salary or a subscription and it posts itself.',
      el('button', { class: 'btn btn-primary', onclick: () => recurringModal({ onSaved: refresh }) }, 'Add recurring item')));
  } else {
    for (const rule of rules) recurringCard.append(recurringRow(rule, refresh));
  }

  root.append(el('div', { class: 'grid grid-2' }, goalsCard, recurringCard));
}

function goalRow(goal, refresh) {
  const pct = Math.round(goal.progress * 100);
  return el(
    'div',
    { class: 'budget-row' },
    el(
      'div',
      { class: 'top' },
      el('div', { class: 'name' }, goal.name, goal.progress >= 1 ? el('span', { class: 'pill good' }, 'Reached') : null),
      el('div', { class: 'nums' }, `${money(goal.saved, store.currency)} of ${money(goal.target, store.currency)}`),
    ),
    el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: { width: `${pct}%`, background: goal.progress >= 1 ? 'var(--good)' : 'var(--brand)' } })),
    el(
      'div',
      { class: 'foot' },
      el('span', {}, goal.targetDate ? `Target ${shortDate(goal.targetDate)} · ${money(goal.remaining, store.currency)} to go` : `${money(goal.remaining, store.currency)} to go`),
      el(
        'span',
        { style: { display: 'flex', gap: '4px' } },
        el('button', { class: 'btn btn-sm', onclick: () => contributeModal(goal, refresh) }, 'Add money'),
        el('button', { class: 'icon-btn', title: 'Edit', onclick: () => goalModal({ goal, onSaved: refresh }) }, icon('pencil', 15)),
        el(
          'button',
          {
            class: 'icon-btn',
            title: 'Delete',
            onclick: async () => {
              const ok = await confirmDialog({ title: `Delete ${goal.name}?`, message: 'The goal and its progress will be removed.' });
              if (!ok) return;
              await api.del(`/api/goals/${goal.id}`);
              toast('Goal deleted');
              refresh();
            },
          },
          icon('trash', 15),
        ),
      ),
    ),
  );
}

function recurringRow(rule, refresh) {
  return el(
    'div',
    { class: 'list-item' },
    el(
      'div',
      { class: 'dot-icon', style: { background: rule.type === 'income' ? 'var(--good-soft)' : 'var(--bad-soft)', color: rule.type === 'income' ? 'var(--good)' : 'var(--bad)' } },
      icon('repeat', 15),
    ),
    el(
      'div',
      { class: 'grow' },
      el('div', { class: 'title' }, rule.description),
      el('div', { class: 'meta' }, `${rule.cadence} · next ${shortDate(rule.nextRunOn)} · ${rule.accountName}`),
    ),
    el('div', { class: `amount ${rule.type === 'income' ? 'pos' : 'neg'}` }, money(rule.type === 'income' ? rule.amount : -rule.amount, store.currency, { sign: true })),
    el(
      'div',
      { class: 'item-actions' },
      el(
        'button',
        {
          class: 'icon-btn',
          title: rule.active ? 'Pause' : 'Resume',
          onclick: async () => {
            await api.patch(`/api/recurring/${rule.id}`, { active: !rule.active });
            refresh();
          },
        },
        rule.active ? icon('x', 15) : icon('check', 15),
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          title: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({ title: `Delete ${rule.description}?`, message: 'Transactions it already posted will stay.' });
            if (!ok) return;
            await api.del(`/api/recurring/${rule.id}`);
            toast('Recurring item deleted');
            refresh();
          },
        },
        icon('trash', 15),
      ),
    ),
  );
}

function goalModal({ goal = null, onSaved } = {}) {
  const editing = Boolean(goal);
  const name = el('input', { type: 'text', required: true, maxlength: '60', placeholder: 'Holiday fund', value: goal?.name || '' });
  const target = el('input', { type: 'number', step: '0.01', min: '0.01', required: true, placeholder: '1500', value: goal ? goal.target.toFixed(2) : '' });
  const targetDate = el('input', { type: 'date', value: goal?.targetDate || '' });
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, editing ? 'Save' : 'Create goal');

  const form = el('form', {}, field('Name', name), field('Target amount', target), field('Target date', targetDate, { hint: 'Optional.' }));
  const dialog = openModal({
    title: editing ? 'Edit goal' : 'New savings goal',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const payload = { name: name.value.trim(), target: target.value, targetDate: targetDate.value || null };
    try {
      if (editing) await api.patch(`/api/goals/${goal.id}`, payload);
      else await api.post('/api/goals', payload);
      dialog.close();
      toast(editing ? 'Goal updated' : 'Goal created', 'good');
      await onSaved?.();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}

function contributeModal(goal, refresh) {
  const amount = el('input', { type: 'number', step: '0.01', placeholder: '50.00', required: true });
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add to goal');
  const form = el('form', {}, field('Amount', amount, { hint: 'Use a negative amount to take money back out.' }));

  const dialog = openModal({
    title: goal.name,
    body: el('div', {}, el('p', { style: { fontSize: '14px', color: 'var(--muted)', marginBottom: '16px' } },
      `${money(goal.remaining, store.currency)} still to go.`), form),
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api.post(`/api/goals/${goal.id}/contribute`, { amount: amount.value });
      dialog.close();
      toast('Goal updated', 'good');
      refresh();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}

function recurringModal({ onSaved } = {}) {
  const accounts = store.writableAccounts();
  if (accounts.length === 0) return toast('Create an account first', 'bad');

  let type = 'expense';
  const description = el('input', { type: 'text', required: true, maxlength: '120', placeholder: 'Rent' });
  const amount = el('input', { type: 'number', step: '0.01', min: '0.01', required: true, placeholder: '850.00' });
  const account = select(accounts.map((a) => ({ value: a.id, label: a.name })));
  const categorySlot = el('div');
  const cadence = select(
    [
      { value: 'monthly', label: 'Every month' },
      { value: 'weekly', label: 'Every week' },
      { value: 'biweekly', label: 'Every two weeks' },
      { value: 'yearly', label: 'Every year' },
    ],
    { value: 'monthly' },
  );
  const nextRun = el('input', { type: 'date', required: true, value: new Date().toISOString().slice(0, 10) });

  const drawCategories = () => {
    categorySlot.replaceChildren(
      field('Category', select([{ value: '', label: 'No category' }, ...store.categoriesOfKind(type).map((c) => ({ value: c.id, label: c.name }))])),
    );
  };
  drawCategories();

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

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create');
  const form = el('form', {}, typeToggle, field('Description', description), field('Amount', amount), field('Account', account), categorySlot, field('Repeats', cadence), field('Next date', nextRun));

  const dialog = openModal({
    title: 'New recurring item',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const categoryValue = categorySlot.querySelector('select').value;
    try {
      await api.post('/api/recurring', {
        accountId: Number(account.value),
        categoryId: categoryValue ? Number(categoryValue) : null,
        description: description.value.trim(),
        amount: amount.value,
        type,
        cadence: cadence.value,
        nextRunOn: nextRun.value,
      });
      dialog.close();
      toast('Recurring item created', 'good');
      await onSaved?.();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}
