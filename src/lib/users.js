import { db } from '../db.js';
import { config } from '../config.js';
import { conflict } from './errors.js';

export const findByEmail = (email) =>
  db.prepare('SELECT * FROM users WHERE email_lower = ?').get(String(email).toLowerCase());

export const findByUsername = (username) =>
  db.prepare('SELECT * FROM users WHERE username_lower = ?').get(String(username).toLowerCase());

export const findByGoogleId = (googleId) => db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);

export const findById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

/**
 * Turns an email or display name into a username that is free, e.g.
 * "ada.lovelace@gmail.com" -> "ada.lovelace", then "ada.lovelace2" if taken.
 */
export function suggestUsername(seed) {
  const base =
    String(seed || '')
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '.')
      .replace(/^[._-]+|[._-]+$/g, '')
      .replace(/\.{2,}/g, '.')
      .slice(0, 20) || 'user';
  const padded = base.length >= 3 ? base : `${base}.user`.slice(0, 20);
  if (!findByUsername(padded)) return padded;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${padded.slice(0, 20)}${i}`;
    if (!findByUsername(candidate)) return candidate;
  }
  return `${padded.slice(0, 14)}${Date.now().toString(36)}`;
}

const insertUser = db.prepare(`
  INSERT INTO users (email, email_lower, username, username_lower, display_name, avatar_url,
                     password_hash, google_id, email_verified, currency)
  VALUES (@email, @email_lower, @username, @username_lower, @display_name, @avatar_url,
          @password_hash, @google_id, @email_verified, @currency)
`);

export function createUser({
  email,
  username,
  displayName,
  avatarUrl = null,
  passwordHash = null,
  googleId = null,
  emailVerified = false,
  currency = config.defaultCurrency,
}) {
  if (findByEmail(email)) throw conflict('An account with that email already exists');
  if (findByUsername(username)) throw conflict('That username is already taken');

  const info = insertUser.run({
    email,
    email_lower: email.toLowerCase(),
    username,
    username_lower: username.toLowerCase(),
    display_name: displayName || username,
    avatar_url: avatarUrl,
    password_hash: passwordHash,
    google_id: googleId,
    email_verified: emailVerified ? 1 : 0,
    currency,
  });
  const user = findById(info.lastInsertRowid);
  seedStarterData(user);
  return user;
}

const DEFAULT_CATEGORIES = [
  { name: 'Salary', kind: 'income', color: '#16a34a', icon: 'wallet' },
  { name: 'Other income', kind: 'income', color: '#0ea5e9', icon: 'plus' },
  { name: 'Groceries', kind: 'expense', color: '#f97316', icon: 'cart' },
  { name: 'Rent & bills', kind: 'expense', color: '#6366f1', icon: 'home' },
  { name: 'Transport', kind: 'expense', color: '#0891b2', icon: 'car' },
  { name: 'Eating out', kind: 'expense', color: '#e11d48', icon: 'food' },
  { name: 'Health', kind: 'expense', color: '#14b8a6', icon: 'heart' },
  { name: 'Fun', kind: 'expense', color: '#a855f7', icon: 'star' },
  { name: 'Savings', kind: 'expense', color: '#64748b', icon: 'piggy' },
];

/** Every new account starts with one cash account and a usable category set. */
function seedStarterData(user) {
  const insertCategory = db.prepare(
    'INSERT OR IGNORE INTO categories (user_id, name, kind, color, icon) VALUES (?, ?, ?, ?, ?)',
  );
  const insertAccount = db.prepare(
    'INSERT INTO accounts (user_id, name, type, currency, opening_balance_cents) VALUES (?, ?, ?, ?, 0)',
  );
  db.transaction(() => {
    for (const c of DEFAULT_CATEGORIES) insertCategory.run(user.id, c.name, c.kind, c.color, c.icon);
    insertAccount.run(user.id, 'Everyday account', 'checking', user.currency);
  })();
}
