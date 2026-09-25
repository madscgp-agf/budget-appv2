import { z } from 'zod';
import { db } from '../db.js';
import { nowIso } from './clock.js';

// DEMO SETTINGS. These tiers are placeholders for local testing and must be
// reviewed by the shop before a real campaign goes live.
export const DEMO_TIERS = [
  { minScore: 500, percent: 5 },
  { minScore: 1000, percent: 10 },
  { minScore: 2000, percent: 15 },
];

const get = db.prepare('SELECT * FROM campaigns ORDER BY id LIMIT 1');

function ensureCampaign() {
  let row = get.get();
  if (!row) {
    db.prepare(
      `INSERT INTO campaigns (id, name, active, tiers_json, code_prefix, code_valid_days, updated_at)
       VALUES (1, 'Oversized Bench (demo-indstillinger)', 1, ?, 'OVS', 14, ?)`,
    ).run(JSON.stringify(DEMO_TIERS), nowIso());
    row = get.get();
  }
  return row;
}

export function campaignFromRow(r) {
  return {
    id: r.id,
    name: r.name,
    active: Boolean(r.active),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    tiers: JSON.parse(r.tiers_json),
    codePrefix: r.code_prefix,
    codeValidDays: r.code_valid_days,
    minimumSubtotal: r.minimum_subtotal,
    productIds: JSON.parse(r.product_ids_json),
    collectionIds: JSON.parse(r.collection_ids_json),
    combinesWith: {
      orderDiscounts: Boolean(r.combine_order),
      productDiscounts: Boolean(r.combine_product),
      shippingDiscounts: Boolean(r.combine_shipping),
    },
    requireVerified: Boolean(r.require_verified),
    restrictToCustomer: Boolean(r.restrict_to_customer),
    leaderboardEnabled: Boolean(r.leaderboard_enabled),
    isDemoTiers: JSON.stringify(JSON.parse(r.tiers_json)) === JSON.stringify(DEMO_TIERS),
    updatedAt: r.updated_at,
  };
}

export function getCampaign() {
  return campaignFromRow(ensureCampaign());
}

/** Is the campaign accepting rounds and rewards right now? */
export function campaignStatus(c, at = nowIso()) {
  if (!c.active) return 'inactive';
  if (c.startsAt && at < c.startsAt) return 'upcoming';
  if (c.endsAt && at >= c.endsAt) return 'ended';
  return 'running';
}

export function tierFor(c, score) {
  let best = null;
  for (const t of c.tiers) if (score >= t.minScore && (!best || t.percent > best.percent)) best = t;
  return best;
}

const gid = (type) => z.string().regex(new RegExp(`^gid://shopify/${type}/\\d+$`), `Forventer gid://shopify/${type}/…`);

export const campaignSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    active: z.boolean(),
    startsAt: z.string().datetime({ offset: true }).nullable(),
    endsAt: z.string().datetime({ offset: true }).nullable(),
    tiers: z
      .array(z.object({ minScore: z.number().int().min(1).max(100000), percent: z.number().int().min(1).max(90) }))
      .min(1)
      .max(10),
    codePrefix: z.string().regex(/^[A-Z0-9]{2,10}$/, 'Kun A–Z og 0–9, 2–10 tegn'),
    codeValidDays: z.number().int().min(1).max(365),
    minimumSubtotal: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable(),
    productIds: z.array(gid('Product')).max(100),
    collectionIds: z.array(gid('Collection')).max(100),
    combinesWith: z.object({ orderDiscounts: z.boolean(), productDiscounts: z.boolean(), shippingDiscounts: z.boolean() }),
    requireVerified: z.boolean(),
    restrictToCustomer: z.boolean(),
    leaderboardEnabled: z.boolean(),
  })
  .refine((c) => !c.startsAt || !c.endsAt || c.startsAt < c.endsAt, { message: 'Slutdato skal ligge efter startdato', path: ['endsAt'] });

export function updateCampaign(input) {
  const c = campaignSchema.parse(input);
  const tiers = [...c.tiers].sort((a, b) => a.minScore - b.minScore);
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  ensureCampaign();
  db.prepare(
    `UPDATE campaigns SET name=@name, active=@active, starts_at=@startsAt, ends_at=@endsAt, tiers_json=@tiers,
       code_prefix=@codePrefix, code_valid_days=@codeValidDays, minimum_subtotal=@minimumSubtotal,
       product_ids_json=@productIds, collection_ids_json=@collectionIds, combine_order=@co, combine_product=@cp,
       combine_shipping=@cs, require_verified=@requireVerified, restrict_to_customer=@restrictToCustomer,
       leaderboard_enabled=@leaderboardEnabled, updated_at=@updatedAt WHERE id = 1`,
  ).run({
    name: c.name,
    active: c.active ? 1 : 0,
    startsAt: iso(c.startsAt),
    endsAt: iso(c.endsAt),
    tiers: JSON.stringify(tiers),
    codePrefix: c.codePrefix,
    codeValidDays: c.codeValidDays,
    minimumSubtotal: c.minimumSubtotal,
    productIds: JSON.stringify(c.productIds),
    collectionIds: JSON.stringify(c.collectionIds),
    co: c.combinesWith.orderDiscounts ? 1 : 0,
    cp: c.combinesWith.productDiscounts ? 1 : 0,
    cs: c.combinesWith.shippingDiscounts ? 1 : 0,
    requireVerified: c.requireVerified ? 1 : 0,
    restrictToCustomer: c.restrictToCustomer ? 1 : 0,
    leaderboardEnabled: c.leaderboardEnabled ? 1 : 0,
    updatedAt: nowIso(),
  });
  return getCampaign();
}

/** The part of the campaign the storefront may see. */
export function publicCampaign(c) {
  return {
    status: campaignStatus(c),
    name: c.name,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    tiers: c.tiers,
    requireVerified: c.requireVerified,
    leaderboardEnabled: c.leaderboardEnabled,
    minimumSubtotal: c.minimumSubtotal,
    codeValidDays: c.codeValidDays,
    limitedProducts: c.productIds.length + c.collectionIds.length > 0,
    demoTiers: c.isDemoTiers,
  };
}
