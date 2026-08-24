import express from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { asyncRoute } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';
import { requireCategory } from '../lib/access.js';

export const categoriesRouter = express.Router();
categoriesRouter.use(requireAuth);

const shape = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  color: row.color,
  icon: row.icon,
  archived: Boolean(row.archived),
});

categoriesRouter.get('/', (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  const rows = db
    .prepare(
      `SELECT * FROM categories WHERE user_id = ? AND (? = 1 OR archived = 0)
       ORDER BY kind, name COLLATE NOCASE`,
    )
    .all(req.user.id, includeArchived ? 1 : 0);
  res.json({ categories: rows.map(shape) });
});

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Give the category a name').max(40),
  kind: z.enum(['income', 'expense']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour').optional(),
  icon: z.string().trim().max(24).optional(),
});

categoriesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = parse(categorySchema, req.body);
    const info = db
      .prepare('INSERT INTO categories (user_id, name, kind, color, icon) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, body.name, body.kind, body.color || '#6366f1', body.icon || 'tag');
    res.status(201).json({ category: shape(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid)) });
  }),
);

categoriesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const category = requireCategory(req.params.id, req.user.id);
    const body = parse(categorySchema.partial().extend({ archived: z.boolean().optional() }), req.body);
    db.prepare(
      `UPDATE categories SET name = COALESCE(@name, name), kind = COALESCE(@kind, kind),
              color = COALESCE(@color, color), icon = COALESCE(@icon, icon),
              archived = COALESCE(@archived, archived)
        WHERE id = @id`,
    ).run({
      id: category.id,
      name: body.name ?? null,
      kind: body.kind ?? null,
      color: body.color ?? null,
      icon: body.icon ?? null,
      archived: body.archived === undefined ? null : body.archived ? 1 : 0,
    });
    res.json({ category: shape(db.prepare('SELECT * FROM categories WHERE id = ?').get(category.id)) });
  }),
);

categoriesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const category = requireCategory(req.params.id, req.user.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
    res.json({ ok: true });
  }),
);
