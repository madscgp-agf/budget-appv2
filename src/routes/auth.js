import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { asyncRoute, badRequest, conflict, unauthorized } from '../lib/errors.js';
import { emailSchema, parse, passwordSchema, usernameSchema } from '../lib/validate.js';
import { clearSession, issueSession, requireAuth, selfUser } from '../lib/auth.js';
import { createUser, findByEmail, findByGoogleId, findById, findByUsername, suggestUsername } from '../lib/users.js';
import { buildAuthUrl, exchangeCode, verifyIdToken, verifyState } from '../lib/google.js';

export const authRouter = express.Router();

const STATE_COOKIE = 'google_oauth_state';

authRouter.get('/config', (_req, res) => {
  res.json({
    google: { enabled: config.google.enabled, clientId: config.google.clientId, redirectFlow: config.google.redirectFlowEnabled },
    defaultCurrency: config.defaultCurrency,
  });
});

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});

authRouter.post(
  '/register',
  asyncRoute(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = createUser({
      email: body.email,
      username: body.username,
      displayName: body.displayName || body.username,
      passwordHash,
    });
    issueSession(res, user);
    res.status(201).json({ user: selfUser(user) });
  }),
);

const loginSchema = z.object({
  // Either an email address or a username.
  identifier: z.string().trim().min(1, 'Enter your email or username'),
  password: z.string().min(1, 'Enter your password'),
});

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = body.identifier.includes('@') ? findByEmail(body.identifier) : findByUsername(body.identifier);
    if (!user || !user.password_hash) {
      // Google-only accounts land here too; keep the hint useful but not enumerable.
      throw unauthorized('Those details did not match an account with a password');
    }
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) throw unauthorized('Those details did not match an account with a password');
    issueSession(res, user);
    res.json({ user: selfUser(user) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/**
 * Google sign-in / sign-up in one call. The browser sends the `credential`
 * from the Google Identity Services button; a matching account is signed in,
 * an existing email is linked, and anything else creates a new user.
 */
authRouter.post(
  '/google',
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ credential: z.string().min(1) }), req.body);
    const profile = await verifyIdToken(body.credential);
    const { user, created } = upsertGoogleUser(profile);
    issueSession(res, user);
    res.status(created ? 201 : 200).json({ user: selfUser(user), created });
  }),
);

/** Starts the server-side redirect flow (fallback for blocked third-party scripts). */
authRouter.get(
  '/google/start',
  asyncRoute(async (req, res) => {
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
    const { url, state } = buildAuthUrl({ next });
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    res.redirect(url);
  }),
);

authRouter.get(
  '/google/callback',
  asyncRoute(async (req, res) => {
    if (req.query.error) throw badRequest(`Google sign-in was cancelled (${req.query.error})`);
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = req.cookies?.[STATE_COOKIE];
    if (!code) throw badRequest('Google did not return an authorization code');
    if (!state || !cookieState || state !== cookieState) throw badRequest('That sign-in could not be verified. Please start again.');
    const claims = verifyState(state);
    res.clearCookie(STATE_COOKIE, { path: '/' });

    const profile = await exchangeCode(code);
    const { user } = upsertGoogleUser(profile);
    issueSession(res, user);
    const next = typeof claims.next === 'string' && claims.next.startsWith('/') ? claims.next : '/';
    res.redirect(next);
  }),
);

/**
 * Finds or creates the user behind a verified Google profile.
 * Matching by Google ID first, then by email so people who signed up with a
 * password can start using the Google button without a duplicate account.
 */
export function upsertGoogleUser(profile) {
  const existingByGoogle = findByGoogleId(profile.googleId);
  if (existingByGoogle) {
    db.prepare(
      "UPDATE users SET avatar_url = COALESCE(?, avatar_url), email_verified = 1, updated_at = datetime('now') WHERE id = ?",
    ).run(profile.avatarUrl, existingByGoogle.id);
    return { user: findById(existingByGoogle.id), created: false };
  }

  const existingByEmail = findByEmail(profile.email);
  if (existingByEmail) {
    if (existingByEmail.google_id && existingByEmail.google_id !== profile.googleId) {
      throw conflict('That email is already linked to a different Google account');
    }
    db.prepare(
      "UPDATE users SET google_id = ?, email_verified = 1, avatar_url = COALESCE(avatar_url, ?), updated_at = datetime('now') WHERE id = ?",
    ).run(profile.googleId, profile.avatarUrl, existingByEmail.id);
    return { user: findById(existingByEmail.id), created: false };
  }

  const user = createUser({
    email: profile.email,
    username: suggestUsername(profile.email),
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    googleId: profile.googleId,
    emailVerified: profile.emailVerified,
  });
  return { user, created: true };
}

/** Links Google to the account you are already signed in to. */
authRouter.post(
  '/google/link',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ credential: z.string().min(1) }), req.body);
    const profile = await verifyIdToken(body.credential);
    const owner = findByGoogleId(profile.googleId);
    if (owner && owner.id !== req.user.id) throw conflict('That Google account is already linked to another user');
    db.prepare("UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?), updated_at = datetime('now') WHERE id = ?").run(
      profile.googleId,
      profile.avatarUrl,
      req.user.id,
    );
    res.json({ user: selfUser(findById(req.user.id)) });
  }),
);

/** Unlinks Google, but never leaves an account with no way to sign in. */
authRouter.delete(
  '/google/link',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!req.user.password_hash) throw badRequest('Set a password first so you can still sign in');
    db.prepare("UPDATE users SET google_id = NULL, updated_at = datetime('now') WHERE id = ?").run(req.user.id);
    res.json({ user: selfUser(findById(req.user.id)) });
  }),
);

/** Lets a Google-only account add a password, or an existing user change theirs. */
authRouter.post(
  '/password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = parse(
      z.object({ currentPassword: z.string().optional(), newPassword: passwordSchema }),
      req.body,
    );
    if (req.user.password_hash) {
      const ok = body.currentPassword && (await bcrypt.compare(body.currentPassword, req.user.password_hash));
      if (!ok) throw unauthorized('Your current password is not correct');
    }
    const hash = await bcrypt.hash(body.newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, req.user.id);
    res.json({ user: selfUser(findById(req.user.id)) });
  }),
);

/** Username availability check used by the sign-up form. */
authRouter.get('/username-available', (req, res) => {
  const raw = String(req.query.username || '');
  const result = usernameSchema.safeParse(raw);
  if (!result.success) return res.json({ available: false, reason: result.error.issues[0].message });
  const taken = Boolean(findByUsername(result.data));
  res.json({ available: !taken, reason: taken ? 'That username is already taken' : null, username: result.data });
});
