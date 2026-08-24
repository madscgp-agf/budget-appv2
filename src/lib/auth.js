import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db.js';
import { unauthorized } from './errors.js';

export function issueSession(res, user) {
  const token = jwt.sign({ sub: String(user.id) }, config.jwt.secret, { expiresIn: config.jwt.ttlSeconds });
  res.cookie(config.jwt.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: config.jwt.ttlSeconds * 1000,
    path: '/',
  });
  return token;
}

export function clearSession(res) {
  res.clearCookie(config.jwt.cookieName, { path: '/' });
}

const findUser = db.prepare('SELECT * FROM users WHERE id = ?');

/** Resolves the signed-in user from the session cookie, or null. */
export function currentUser(req) {
  const token = req.cookies?.[config.jwt.cookieName];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    return findUser.get(Number(payload.sub)) || null;
  } catch {
    return null;
  }
}

/** Route guard: attaches req.user or fails with 401. */
export function requireAuth(req, _res, next) {
  const user = currentUser(req);
  if (!user) return next(unauthorized());
  req.user = user;
  next();
}

/** Shape a user row for API responses; never leaks password hashes. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    currency: user.currency,
  };
}

/** The full profile of the signed-in user (includes their own email/settings). */
export function selfUser(user) {
  return {
    ...publicUser(user),
    email: user.email,
    emailVerified: Boolean(user.email_verified),
    discoverable: Boolean(user.discoverable),
    hasPassword: Boolean(user.password_hash),
    linkedGoogle: Boolean(user.google_id),
    createdAt: user.created_at,
  };
}
