import { now } from './clock.js';
import { tooMany } from './errors.js';

// Fixed-window counters in memory. This is enough for a single instance; run
// several instances behind a load balancer and you want a shared store
// (Redis or the database) instead -- see README.
const buckets = new Map();

export function hit(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= t) {
    b = { count: 0, resetAt: t + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { ok: b.count <= max, retryAfterMs: b.resetAt - t };
}

/** Throws 429 when the limit is exceeded. */
export function limit(key, max, windowMs) {
  const r = hit(key, max, windowMs);
  if (!r.ok) throw tooMany(undefined, { retryAfterSeconds: Math.ceil(r.retryAfterMs / 1000) });
}

/** Express middleware version keyed on client IP. */
export function limitByIp(name, max, windowMs) {
  return (req, _res, next) => {
    try {
      limit(`${name}:${req.ip}`, max, windowMs);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function resetRateLimits() {
  buckets.clear();
}

setInterval(() => {
  const t = now();
  for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
}, 60_000).unref();
