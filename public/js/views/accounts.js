import { api } from '../api.js';
import { store } from '../store.js';
import { avatar, clear, confirmDialog, el, emptyState, field, icon, money, openModal, select, toast } from '../ui.js';
import { navigate } from '../router.js';

const TYPES = [
  { value: 'checking', label: 'Everyday / current' },
  { value: 'savings', label: 'Savings' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit', label: 'Credit card' },
  { value: 'investment', label: 'Investment' },
];

export async function renderAccounts(root) {
  clear(root);
  await Promise.all([store.loadAccounts(), store.loadConnections()]);
  const refresh = () => renderAccounts(root);

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Accounts'), el('p', { class: 'sub' }, 'Everything you track, plus anything shared with you.')),
      el('div', { class: 'head-actions' }, el('button', { class: 'btn btn-primary', onclick: () => accountModal({ onSaved: refresh }) }, icon('plus', 16), 'New account')),
    ),
  );

  const owned = store.accounts.filter((a) => a.role === 'owner');
  const shared = store.accounts.filter((a) => a.role !== 'owner');

  const total = owned.reduce((sum, a) => sum + a.balance, 0);
  root.append(
    el(
      'div',
      { class: 'grid grid-3', style: { marginBottom: '16px' } },
      el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Your total'), el('div', { class: `value ${total < 0 ? 'neg' : ''}` }, money(total, store.currency))),
      el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Accounts'), el('div', { class: 'value' }, String(owned.length))),
      el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Shared with you'), el('div', { class: 'value' }, String(shared.length))),
    ),
  );

  const list = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Your accounts')));
  if (owned.length === 0) {
    list.append(emptyState('\u{1F3E6}', 'No accounts yet', 'Add one to start tracking.', el('button', { class: 'btn btn-primary', onclick: () => accountModal({ onSaved: refresh }) }, 'New account')));
  } else {
    for (const account of owned) list.append(accountRow(account, refresh));
  }
  root.append(list);

  if (shared.length) {
    const sharedList = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Shared with you')));
    for (const account of shared) sharedList.append(sharedRow(account, refresh));
    root.append(sharedList);
  }
}

function accountRow(account, refresh) {
  const shares = account.shares || [];
  return el(
    'div',
    { class: 'list-item' },
    el('div', { class: 'dot-icon', style: { background: 'var(--brand-soft)', color: 'var(--brand-strong)' } }, icon('wallet', 16)),
    el(
      'div',
      { class: 'grow' },
      el('div', { class: 'title' }, account.name),
      el(
        'div',
        { class: 'meta' },
        [TYPES.find((t) => t.value === account.type)?.label || account.type,
         shares.length ? `shared with ${shares.map((s) => `@${s.username}`).join(', ')}` : null]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
    el('div', { class: `amount ${account.balance < 0 ? 'neg' : ''}` }, money(account.balance, account.currency)),
    el(
      'div',
      { class: 'item-actions' },
      el('button', { class: 'icon-btn', title: 'Share', onclick: () => shareModal(account, refresh) }, icon('users', 16)),
      el('button', { class: 'icon-btn', title: 'Edit', onclick: () => accountModal({ account, onSaved: refresh }) }, icon('pencil', 16)),
      el(
        'button',
        {
          class: 'icon-btn',
          title: 'Delete',
          onclick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${account.name}?`,
              message: 'Every transaction in this account will be deleted too. This cannot be undone.',
            });
            if (!ok) return;
            await api.del(`/api/accounts/${account.id}`);
            toast('Account deleted');
            refresh();
          },
        },
        icon('trash', 16),
      ),
    ),
  );
}

function sharedRow(account, refresh) {
  return el(
    'div',
    { class: 'list-item' },
    el('div', { class: 'dot-icon', style: { background: 'var(--surface-2)', color: 'var(--muted)' } }, icon('users', 16)),
    el(
      'div',
      { class: 'grow' },
      el('div', { class: 'title' }, account.name),
      el('div', { class: 'meta' }, `${account.owner?.displayName || 'Someone'} · you can ${account.role === 'editor' ? 'add and edit' : 'view only'}`),
    ),
    el('div', { class: `amount ${account.balance < 0 ? 'neg' : ''}` }, money(account.balance, account.currency)),
    el(
      'div',
      { class: 'item-actions' },
      el(
        'button',
        {
          class: 'icon-btn',
          title: 'Leave this shared account',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Leave this account?',
              message: `You will no longer see ${account.name}. The owner can share it again later.`,
              confirmLabel: 'Leave',
            });
            if (!ok) return;
            await api.del(`/api/accounts/${account.id}/shares/${store.user.username}`);
            toast('You left the shared account');
            refresh();
          },
        },
        icon('x', 16),
      ),
    ),
  );
}

function accountModal({ account = null, onSaved } = {}) {
  const editing = Boolean(account);
  const name = el('input', { type: 'text', required: true, maxlength: '60', placeholder: 'Everyday account', value: account?.name || '' });
  const type = select(TYPES, { value: account?.type || 'checking' });
  const opening = el('input', {
    type: 'number',
    step: '0.01',
    value: account ? account.openingBalance.toFixed(2) : '0.00',
  });
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, editing ? 'Save' : 'Create account');

  const form = el(
    'form',
    {},
    field('Name', name),
    field('Type', type),
    field('Starting balance', opening, { hint: 'What is in the account before you log anything.' }),
  );

  const dialog = openModal({
    title: editing ? 'Edit account' : 'New account',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const payload = { name: name.value.trim(), type: type.value, openingBalance: opening.value || 0 };
    try {
      if (editing) await api.patch(`/api/accounts/${account.id}`, payload);
      else await api.post('/api/accounts', payload);
      dialog.close();
      toast(editing ? 'Account updated' : 'Account created', 'good');
      await onSaved?.();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}

function shareModal(account, refresh) {
  const connected = store.connections.connected;
  const body = el('div', {});

  const dialog = openModal({ title: `Share ${account.name}`, body, actions: [] });

  const draw = async () => {
    clear(body);
    const current = (await api.get('/api/accounts')).accounts.find((a) => a.id === account.id);
    const shares = current?.shares || [];

    if (shares.length) {
      body.append(el('div', { class: 'card-head' }, el('h3', {}, 'Shared with')));
      for (const share of shares) {
        body.append(
          el(
            'div',
            { class: 'person-row' },
            avatar(share),
            el('div', { class: 'who' }, el('div', { class: 'name' }, share.displayName), el('div', { class: 'handle' }, `@${share.username} · ${share.role === 'editor' ? 'can add and edit' : 'view only'}`)),
            el(
              'button',
              {
                class: 'icon-btn',
                title: 'Stop sharing',
                onclick: async () => {
                  await api.del(`/api/accounts/${account.id}/shares/${share.username}`);
                  toast('Sharing stopped');
                  await refresh();
                  draw();
                },
              },
              icon('x', 16),
            ),
          ),
        );
      }
    }

    const available = connected.filter((c) => !shares.some((s) => s.username === c.user.username));
    if (available.length === 0) {
      body.append(
        emptyState(
          '\u{1F465}',
          shares.length ? 'Everyone is already added' : 'No one to share with yet',
          'Connect with someone by username or QR code first.',
          el('button', { class: 'btn btn-primary', onclick: () => { dialog.close(); navigate('/people'); } }, 'Go to People'),
        ),
      );
      return;
    }

    const person = select(available.map((c) => ({ value: c.user.username, label: `${c.user.displayName} (@${c.user.username})` })));
    const role = select([
      { value: 'viewer', label: 'View only' },
      { value: 'editor', label: 'Can add and edit transactions' },
    ]);
    const add = el('button', { class: 'btn btn-primary btn-block' }, 'Share account');

    add.addEventListener('click', async () => {
      add.disabled = true;
      try {
        await api.post(`/api/accounts/${account.id}/shares`, { username: person.value, role: role.value });
        toast('Account shared', 'good');
        await refresh();
        draw();
      } catch (err) {
        dialog.showError(err.message);
        add.disabled = false;
      }
    });

    body.append(
      el('div', { class: 'card-head', style: { marginTop: shares.length ? '20px' : '0' } }, el('h3', {}, 'Add someone')),
      field('Person', person),
      field('They can', role),
      add,
    );
  };

  draw();
}
