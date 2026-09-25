import { db } from '../db.js';
import { nowIso } from './clock.js';

/** Records a problem talking to Shopify (or mail) so the admin can see it. */
export function recordIntegrationError(source, message, details) {
  try {
    db.prepare('INSERT INTO integration_errors (source, message, details_json, created_at) VALUES (?, ?, ?, ?)').run(
      source,
      String(message).slice(0, 1000),
      details === undefined ? null : JSON.stringify(details).slice(0, 8000),
      nowIso(),
    );
  } catch (err) {
    console.error('Could not record integration error', err);
  }
  console.warn(`[integration:${source}] ${message}`);
}
