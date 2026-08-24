import { db } from '../db.js';
import { publicUser } from './auth.js';

/** The connection row between two users, in whichever direction it exists. */
export function connectionBetween(a, b) {
  return db
    .prepare(
      `SELECT * FROM connections
       WHERE (requester_id = @a AND addressee_id = @b) OR (requester_id = @b AND addressee_id = @a)`,
    )
    .get({ a, b });
}

export function areConnected(a, b) {
  const row = connectionBetween(a, b);
  return Boolean(row && row.status === 'accepted');
}

/** Ids of every user connected to `userId`. */
export function connectedUserIds(userId) {
  return db
    .prepare(
      `SELECT CASE WHEN requester_id = @id THEN addressee_id ELSE requester_id END AS other_id
       FROM connections WHERE status = 'accepted' AND (requester_id = @id OR addressee_id = @id)`,
    )
    .all({ id: userId })
    .map((r) => r.other_id);
}

const userById = db.prepare('SELECT * FROM users WHERE id = ?');

/** Shapes a connection row from the point of view of `userId`. */
export function shapeConnection(row, userId) {
  const outgoing = row.requester_id === userId;
  const otherId = outgoing ? row.addressee_id : row.requester_id;
  return {
    id: row.id,
    status: row.status,
    origin: row.origin,
    direction: outgoing ? 'outgoing' : 'incoming',
    user: publicUser(userById.get(otherId)),
    createdAt: row.created_at,
    respondedAt: row.responded_at,
  };
}

export function listConnections(userId) {
  const rows = db
    .prepare(
      `SELECT * FROM connections
       WHERE (requester_id = @id OR addressee_id = @id) AND status IN ('pending','accepted')
       ORDER BY created_at DESC`,
    )
    .all({ id: userId })
    .map((row) => shapeConnection(row, userId));

  return {
    connected: rows.filter((r) => r.status === 'accepted'),
    incoming: rows.filter((r) => r.status === 'pending' && r.direction === 'incoming'),
    outgoing: rows.filter((r) => r.status === 'pending' && r.direction === 'outgoing'),
  };
}
