import { z } from 'zod';
import { badRequest } from './errors.js';

/** Parses with a zod schema, converting failures into a 400 with field details. */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  throw badRequest(details[0] ? `${details[0].field}: ${details[0].message}` : 'Invalid request', details);
}

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username must be at most 24 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dots, dashes and underscores');

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password must be at most 200 characters');

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD');

export const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the period format YYYY-MM');

/** Money arrives as a decimal string or number and is stored as integer cents. */
export const moneySchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid amount' });
      return z.NEVER;
    }
    return Math.round(n * 100);
  });
