import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db.js';
import { asyncRoute, badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, usernameSchema } from '../lib/validate.js';
import { publicUser, requireAuth } from '../lib/auth.js';
import { findByUsername } from '../lib/users.js';
import { connectionBetween, listConnections, shapeConnection } from '../lib/connections.js';

export const connectionsRouter = express.Router();
connectionsRouter.use(requireAuth);

connectionsRouter.get('/', (req, res) => {
  res.json(listConnections(req.user.id));
});

/** Username lookup: the first of the two ways to connect. */
connectionsRouter.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE discoverable = 1 AND id != @me AND (username_lower LIKE @like OR lower(display_name) LIKE @like)
       ORDER BY CASE WHEN username_lower = @q THEN 0 ELSE 1 END, username_lower
       LIMIT 10`,
    )
    .all({ me: req.user.id, like: `%${q}%`, q });

  res.json({
    results: rows.map((row) => {
      const existing = connectionBetween(req.user.id, row.id);
      return {
        ...publicUser(row),
        connectionStatus: existing ? existing.status : null,
        connectionDirection: existing ? (existing.requester_id === req.user.id ? 'outgoing' : 'incoming') : null,
      };
    }),
  });
});

const createRequest = db.prepare(
  'INSERT INTO connections (requester_id, addressee_id, status, origin) VALUES (?, ?, ?, ?)',
);

/** Send a connection request to a username. */
connectionsRouter.post(
  '/requests',
  asyncRoute(async (req, res) => {
    const body = parse(z.object({ username: usernameSchema }), req.body);
    const target = findByUsername(body.username);
    if (!target) throw notFound('No one is using that username');
    if (target.id === req.user.id) throw badRequest('You are already yourself');

    const existing = connectionBetween(req.user.id, target.id);
    if (existing) {
      if (existing.status === 'accepted') throw conflict('You are already connected');
      if (existing.status === 'pending') {
        // They asked first: accept instead of creating a mirrored request.
        if (existing.addressee_id === req.user.id) {
          db.prepare("UPDATE connections SET status = 'accepted', responded_at = datetime('now') WHERE id = ?").run(existing.id);
          const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(existing.id);
          return res.status(200).json({ connection: shapeConnection(row, req.user.id) });
        }
        throw conflict('You already asked to connect with them');
      }
      if (existing.status === 'blocked') throw conflict('You cannot connect with that account');
      // A previously declined request can be re-sent.
      db.prepare("UPDATE connections SET status = 'pending', requester_id = ?, addressee_id = ?, origin = 'username', created_at = datetime('now'), responded_at = NULL WHERE id = ?").run(
        req.user.id,
        target.id,
        existing.id,
      );
      const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(existing.id);
      return res.status(201).json({ connection: shapeConnection(row, req.user.id) });
    }

    const info = createRequest.run(req.user.id, target.id, 'pending', 'username');
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ connection: shapeConnection(row, req.user.id) });
  }),
);

function ownConnection(id, userId) {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(Number(id));
  if (!row || (row.requester_id !== userId && row.addressee_id !== userId)) throw notFound('Connection not found');
  return row;
}

connectionsRouter.post(
  '/:id/accept',
  asyncRoute(async (req, res) => {
    const row = ownConnection(req.params.id, req.user.id);
    if (row.addressee_id !== req.user.id) throw badRequest('Only the person who was invited can accept');
    if (row.status === 'accepted') return res.json({ connection: shapeConnection(row, req.user.id) });
    db.prepare("UPDATE connections SET status = 'accepted', responded_at = datetime('now') WHERE id = ?").run(row.id);
    res.json({ connection: shapeConnection(db.prepare('SELECT * FROM connections WHERE id = ?').get(row.id), req.user.id) });
  }),
);

connectionsRouter.post(
  '/:id/decline',
  asyncRoute(async (req, res) => {
    const row = ownConnection(req.params.id, req.user.id);
    db.prepare("UPDATE connections SET status = 'declined', responded_at = datetime('now') WHERE id = ?").run(row.id);
    res.json({ ok: true });
  }),
);

/** Removes a connection (or cancels a request you sent). */
connectionsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const row = ownConnection(req.params.id, req.user.id);
    db.transaction(() => {
      // Shared access only makes sense between connected people.
      db.prepare(
        `DELETE FROM account_shares WHERE
           (user_id = @other AND account_id IN (SELECT id FROM accounts WHERE user_id = @me))
           OR (user_id = @me AND account_id IN (SELECT id FROM accounts WHERE user_id = @other))`,
      ).run({ me: req.user.id, other: row.requester_id === req.user.id ? row.addressee_id : row.requester_id });
      db.prepare('DELETE FROM connections WHERE id = ?').run(row.id);
    })();
    res.json({ ok: true });
  }),
);

/* ---------------------------------------------------------------------------
 * QR codes: the second way to connect.
 * A user generates a short-lived token, shows it as a QR image, and whoever
 * scans it (while signed in) is connected immediately -- scanning in person is
 * the confirmation, so no second approval step is needed.
 * ------------------------------------------------------------------------ */

const inviteUrlFor = (token) => `${config.appUrl}/connect/${token}`;

connectionsRouter.post(
  '/qr',
  asyncRoute(async (req, res) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + config.connect.tokenTtlSeconds * 1000).toISOString();
    db.prepare('INSERT INTO connect_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      req.user.id,
      expiresAt,
    );
    const url = inviteUrlFor(token);
    const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
    res.status(201).json({
      token,
      url,
      qr,
      username: req.user.username,
      expiresAt,
      expiresInSeconds: config.connect.tokenTtlSeconds,
    });
  }),
);

function loadToken(token) {
  const row = db.prepare('SELECT * FROM connect_tokens WHERE token = ?').get(String(token));
  if (!row) throw notFound('That connect code is not valid');
  if (row.used_at) throw badRequest('That connect code has already been used');
  if (new Date(row.expires_at).getTime() < Date.now()) throw badRequest('That connect code has expired');
  return row;
}

/** Preview who a scanned code belongs to, before connecting. */
connectionsRouter.get(
  '/qr/:token',
  asyncRoute(async (req, res) => {
    const row = loadToken(req.params.token);
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const existing = connectionBetween(req.user.id, owner.id);
    res.json({
      user: publicUser(owner),
      isSelf: owner.id === req.user.id,
      expiresAt: row.expires_at,
      alreadyConnected: Boolean(existing && existing.status === 'accepted'),
    });
  }),
);

connectionsRouter.post(
  '/qr/:token/accept',
  asyncRoute(async (req, res) => {
    const row = loadToken(req.params.token);
    if (row.user_id === req.user.id) throw badRequest('That is your own connect code');

    const result = db.transaction(() => {
      db.prepare("UPDATE connect_tokens SET used_at = datetime('now'), used_by_id = ? WHERE id = ?").run(req.user.id, row.id);
      const existing = connectionBetween(req.user.id, row.user_id);
      if (existing) {
        if (existing.status === 'blocked') throw conflict('You cannot connect with that account');
        db.prepare("UPDATE connections SET status = 'accepted', origin = 'qr', responded_at = datetime('now') WHERE id = ?").run(existing.id);
        return db.prepare('SELECT * FROM connections WHERE id = ?').get(existing.id);
      }
      const info = createRequest.run(row.user_id, req.user.id, 'accepted', 'qr');
      db.prepare("UPDATE connections SET responded_at = datetime('now') WHERE id = ?").run(info.lastInsertRowid);
      return db.prepare('SELECT * FROM connections WHERE id = ?').get(info.lastInsertRowid);
    })();

    res.status(201).json({ connection: shapeConnection(result, req.user.id) });
  }),
);
