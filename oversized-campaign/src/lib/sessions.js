import { config } from '../config.js';
import { db } from '../db.js';
import { now, nowIso } from './clock.js';
import { randomToken, sha256 } from './crypto.js';
import { unauthorized } from './errors.js';
import { createPlayer, resolvePlayer } from './players.js';

const DAY = 86_400_000;

// The session token is 32 random bytes. The browser holds it in an HttpOnly
// cookie; the database only holds its SHA-256. Nothing about score or reward
// eligibility lives in the browser.
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: config.session.ttlDays * DAY,
  };
}

function insertSession(playerId, transport, ttlMs) {
  const token = randomToken(32);
  const t = nowIso();
  db.prepare(
    'INSERT INTO sessions (token_hash, player_id, transport, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), playerId, transport, t, t, new Date(now() + ttlMs).toISOString());
  return token;
}

export function issueCookieSession(res, playerId) {
  const token = insertSession(playerId, 'cookie', config.session.ttlDays * DAY);
  res.cookie(config.session.cookieName, token, cookieOptions());
  return token;
}

/**
 * Fallback for storefronts where the API is cross-site and the browser blocks
 * third-party cookies: a short-lived token kept in page memory only. It lasts
 * for this visit; the player is not recognised next time.
 */
export function issueHeaderSession(playerId) {
  return insertSession(playerId, 'header', config.session.headerTtlHours * 3_600_000);
}

export function revokeSession(req, res) {
  const token = readToken(req);
  if (token) db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token.value));
  res.clearCookie(config.session.cookieName, { ...cookieOptions(), maxAge: undefined });
}

function readToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer osg_')) return { value: auth.slice('Bearer osg_'.length), transport: 'header' };
  const c = req.cookies?.[config.session.cookieName];
  if (c) return { value: c, transport: 'cookie' };
  return null;
}

const findSession = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');

/** Resolves the player for this request, or null. Refreshes sliding expiry. */
export function currentPlayer(req, res) {
  if (req.player !== undefined) return req.player;
  req.player = null;
  const token = readToken(req);
  if (!token) return null;
  const s = findSession.get(sha256(token.value));
  if (!s || s.revoked_at || s.transport !== token.transport || s.expires_at <= nowIso()) return null;
  const player = resolvePlayer(s.player_id);
  if (!player) return null;
  req.player = player;
  req.sessionRow = s;

  // Touch at most every ten minutes; extend cookie sessions (sliding expiry)
  // once a day so returning players stay recognised.
  const t = now();
  if (t - Date.parse(s.last_seen_at) > 10 * 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), s.token_hash);
    db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(nowIso(), player.id);
  }
  if (s.transport === 'cookie' && res && Date.parse(s.expires_at) - t < (config.session.ttlDays - 1) * DAY) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
      new Date(t + config.session.ttlDays * DAY).toISOString(),
      s.token_hash,
    );
    res.cookie(config.session.cookieName, token.value, cookieOptions());
  }
  return player;
}

export function requirePlayer(req, res, next) {
  const p = currentPlayer(req, res);
  if (!p) return next(unauthorized('Start spillet først – vi kunne ikke genkende din browser'));
  next();
}

/** Returns the existing player or creates a new anonymous one with a session. */
export function ensurePlayer(req, res, transport = 'cookie') {
  const existing = currentPlayer(req, res);
  if (existing && transport === 'cookie') return { player: existing, created: false };
  const player = existing || createPlayer();
  req.player = player;
  if (transport === 'header') return { player, created: !existing, headerToken: `osg_${issueHeaderSession(player.id)}` };
  issueCookieSession(res, player.id);
  return { player, created: true };
}

/** After a verified merge, give this browser a fresh session for the survivor. */
export function rotateSession(req, res, playerId) {
  // Header sessions were already moved to the survivor by the merge.
  if (req.sessionRow?.transport === 'header') return;
  if (req.sessionRow) db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').run(nowIso(), req.sessionRow.token_hash);
  issueCookieSession(res, playerId);
}
