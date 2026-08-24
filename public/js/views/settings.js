import { api } from '../api.js';
import { store } from '../store.js';
import { avatar, clear, confirmDialog, el, field, icon, openModal, select, toast } from '../ui.js';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'BRL', 'MXN', 'ZAR'];

export async function renderSettings(root) {
  clear(root);
  const refresh = () => renderSettings(root);
  await store.loadCategories();
  const user = store.user;

  root.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, 'Settings'), el('p', { class: 'sub' }, 'Your profile, sign-in methods and categories.')),
    ),
  );

  /* ---------------------------------------------------------- profile */
  const displayName = el('input', { type: 'text', value: user.displayName, maxlength: '80' });
  const username = el('input', { type: 'text', value: user.username, maxlength: '24' });
  const currency = select(CURRENCIES.map((code) => ({ value: code, label: code })), { value: user.currency });
  const saveProfile = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes');

  const profileForm = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        saveProfile.disabled = true;
        try {
          const { user: updated } = await api.patch('/api/users/me', {
            displayName: displayName.value.trim(),
            username: username.value.trim(),
            currency: currency.value,
          });
          store.user = updated;
          toast('Profile saved', 'good');
          refresh();
        } catch (err) {
          toast(err.message, 'bad');
          saveProfile.disabled = false;
        }
      },
    },
    el('div', { class: 'row' }, field('Name', displayName), field('Username', username)),
    field('Currency', currency),
    saveProfile,
  );

  root.append(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { style: { display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '18px' } },
        avatar(user, { large: true }),
        el(
          'div',
          {},
          el('div', { style: { fontWeight: '700', fontSize: '16px' } }, user.displayName),
          el('div', { style: { color: 'var(--muted)', fontSize: '13.5px' } }, `@${user.username} · ${user.email}`),
        ),
      ),
      profileForm,
    ),
  );

  /* -------------------------------------------------------- sign-in */
  const signIn = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, 'Signing in')));

  signIn.append(
    settingsRow(
      'Google',
      user.linkedGoogle ? 'Linked — you can sign in with one tap.' : 'Link your Google account to sign in without a password.',
      user.linkedGoogle
        ? el(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                if (!user.hasPassword) return toast('Set a password first so you can still sign in', 'bad');
                const ok = await confirmDialog({ title: 'Unlink Google?', message: 'You will sign in with your email and password instead.', confirmLabel: 'Unlink' });
                if (!ok) return;
                try {
                  const { user: updated } = await api.del('/api/auth/google/link');
                  store.user = updated;
                  toast('Google unlinked');
                  refresh();
                } catch (err) {
                  toast(err.message, 'bad');
                }
              },
            },
            'Unlink',
          )
        : el('span', { class: 'pill' }, store.authConfig.google.enabled ? 'Sign out and use the Google button' : 'Not configured'),
    ),
    settingsRow(
      'Password',
      user.hasPassword ? 'Change the password you sign in with.' : 'You signed up with Google. Add a password as a backup.',
      el('button', { class: 'btn btn-sm', onclick: () => passwordModal(user, refresh) }, user.hasPassword ? 'Change' : 'Set password'),
    ),
    settingsRow(
      'Findable by username',
      'When this is off, other people cannot find you in search. QR codes still work.',
      toggle(user.discoverable, async (value) => {
        const { user: updated } = await api.patch('/api/users/me', { discoverable: value });
        store.user = updated;
        toast(value ? 'You are findable by username' : 'You are hidden from search');
      }),
    ),
  );
  root.append(signIn);

  /* ------------------------------------------------------ categories */
  const categoriesCard = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h3', {}, 'Categories'),
      el('button', { class: 'btn btn-sm', onclick: () => categoryModal({ onSaved: refresh }) }, icon('plus', 15), 'Add'),
    ),
  );

  for (const kind of ['expense', 'income']) {
    const items = store.categoriesOfKind(kind);
    if (items.length === 0) continue;
    categoriesCard.append(el('div', { class: 'day-head' }, kind === 'expense' ? 'Expenses' : 'Income'));
    for (const category of items) {
      categoriesCard.append(
        el(
          'div',
          { class: 'list-item' },
          el('div', { class: 'dot-icon', style: { background: `${category.color}22`, color: category.color } }, icon('list', 15)),
          el('div', { class: 'grow' }, el('div', { class: 'title' }, category.name)),
          el(
            'div',
            { class: 'item-actions' },
            el('button', { class: 'icon-btn', title: 'Edit', onclick: () => categoryModal({ category, onSaved: refresh }) }, icon('pencil', 15)),
            el(
              'button',
              {
                class: 'icon-btn',
                title: 'Delete',
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: `Delete ${category.name}?`,
                    message: 'Transactions in this category will keep their amount but lose the category.',
                  });
                  if (!ok) return;
                  await api.del(`/api/categories/${category.id}`);
                  toast('Category deleted');
                  refresh();
                },
              },
              icon('trash', 15),
            ),
          ),
        ),
      );
    }
  }
  root.append(categoriesCard);

  /* ---------------------------------------------------------- danger */
  root.append(
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h3', {}, 'Account')),
      settingsRow('Sign out', 'Sign out on this device.', el('button', { class: 'btn btn-sm', onclick: () => store.signOut() }, icon('logout', 15), 'Sign out')),
      settingsRow(
        'Delete account',
        'Permanently removes your account, transactions, budgets and goals.',
        el(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              const ok = await confirmDialog({
                title: 'Delete your account?',
                message: 'Everything is removed straight away and cannot be recovered.',
                confirmLabel: 'Delete everything',
              });
              if (!ok) return;
              await api.del('/api/users/me');
              window.location.href = '/';
            },
          },
          'Delete',
        ),
      ),
    ),
  );
}

function settingsRow(title, description, control) {
  return el(
    'div',
    { class: 'settings-row' },
    el('div', { class: 'info' }, el('div', { class: 't' }, title), el('div', { class: 'd' }, description)),
    control,
  );
}

function toggle(checked, onChange) {
  const input = el('input', { type: 'checkbox', checked: checked || null });
  input.addEventListener('change', async () => {
    try {
      await onChange(input.checked);
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message, 'bad');
    }
  });
  return el('label', { class: 'switch' }, input, el('span', { class: 'slider' }));
}

function passwordModal(user, refresh) {
  const currentPassword = el('input', { type: 'password', autocomplete: 'current-password' });
  const newPassword = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Save password');

  const form = el(
    'form',
    {},
    user.hasPassword ? field('Current password', currentPassword) : null,
    field('New password', newPassword, { hint: 'At least 8 characters.' }),
  );

  const dialog = openModal({
    title: user.hasPassword ? 'Change password' : 'Set a password',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const { user: updated } = await api.post('/api/auth/password', {
        currentPassword: user.hasPassword ? currentPassword.value : undefined,
        newPassword: newPassword.value,
      });
      store.user = updated;
      dialog.close();
      toast('Password saved', 'good');
      refresh();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}

const PALETTE = ['#6366f1', '#0ea5e9', '#14b8a6', '#16a34a', '#f97316', '#e11d48', '#a855f7', '#64748b'];

function categoryModal({ category = null, onSaved } = {}) {
  const editing = Boolean(category);
  const name = el('input', { type: 'text', required: true, maxlength: '40', value: category?.name || '', placeholder: 'Groceries' });
  const kind = select([{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }], { value: category?.kind || 'expense' });

  let color = category?.color || PALETTE[0];
  const swatches = el(
    'div',
    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    PALETTE.map((option) =>
      el('button', {
        type: 'button',
        'aria-label': option,
        style: {
          width: '30px',
          height: '30px',
          borderRadius: '9px',
          background: option,
          border: option === color ? '3px solid var(--text)' : '1px solid var(--border)',
          cursor: 'pointer',
        },
        onclick: (event) => {
          color = option;
          for (const button of swatches.children) button.style.border = '1px solid var(--border)';
          event.currentTarget.style.border = '3px solid var(--text)';
        },
      }),
    ),
  );

  const save = el('button', { class: 'btn btn-primary', type: 'submit' }, editing ? 'Save' : 'Add category');
  const form = el('form', {}, field('Name', name), field('Type', kind), field('Colour', swatches));

  const dialog = openModal({
    title: editing ? 'Edit category' : 'New category',
    body: form,
    actions: [el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'), save],
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const payload = { name: name.value.trim(), kind: kind.value, color };
    try {
      if (editing) await api.patch(`/api/categories/${category.id}`, payload);
      else await api.post('/api/categories', payload);
      dialog.close();
      toast(editing ? 'Category updated' : 'Category added', 'good');
      await onSaved?.();
    } catch (err) {
      dialog.showError(err.message);
      save.disabled = false;
    }
  });
}
