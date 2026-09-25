import crypto from 'node:crypto';
import { config } from '../config.js';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomId = () => crypto.randomUUID();
export const randomSeed = () => crypto.randomBytes(4).readUInt32BE(0);
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Keyed hash for values we want to correlate but not store in the clear (IPs).
export const keyedHash = (value) => crypto.createHmac('sha256', config.appSecret).update(`h:${value}`).digest('hex').slice(0, 32);

export function hmacBase64(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}
export function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

const encKey = crypto.createHash('sha256').update(`enc:${config.appSecret}`).digest();

/** AES-256-GCM for secrets at rest (Shopify access tokens). */
export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// Unambiguous alphabet for discount codes (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
