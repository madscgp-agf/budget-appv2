import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { badRequest } from './errors.js';

export const GOOGLE_REDIRECT_PATH = '/api/auth/google/callback';
export const googleRedirectUri = () => `${config.appUrl}${GOOGLE_REDIRECT_PATH}`;

let client;
function oauthClient() {
  if (!client) {
    client = new OAuth2Client({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret || undefined,
      redirectUri: googleRedirectUri(),
    });
  }
  return client;
}

/**
 * Verifies a Google ID token (the `credential` produced by the Google Identity
 * Services button) and returns the profile it asserts.
 */
export async function verifyIdToken(credential) {
  if (!config.google.enabled) throw badRequest('Google sign-in is not configured on this server');
  let ticket;
  try {
    ticket = await oauthClient().verifyIdToken({ idToken: credential, audience: config.google.clientId });
  } catch {
    throw badRequest('That Google sign-in could not be verified. Please try again.');
  }
  const payload = ticket.getPayload();
  if (!payload?.email) throw badRequest('Google did not return an email address for that account');
  if (!payload.email_verified) throw badRequest('Please verify your email with Google before signing in');
  return profileFromPayload(payload);
}

function profileFromPayload(payload) {
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
    displayName: payload.name || payload.given_name || payload.email.split('@')[0],
    avatarUrl: payload.picture || null,
  };
}

/** Builds the consent-screen URL plus the state value to store in a cookie. */
export function buildAuthUrl({ next = '/' } = {}) {
  if (!config.google.redirectFlowEnabled) {
    throw badRequest('The Google redirect flow needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign({ nonce, next }, config.jwt.secret, { expiresIn: 600 });
  const url = oauthClient().generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  });
  return { url, state };
}

export function verifyState(state) {
  try {
    return jwt.verify(state, config.jwt.secret);
  } catch {
    throw badRequest('That sign-in link expired. Please start again.');
  }
}

/** Exchanges an OAuth code for the caller's Google profile. */
export async function exchangeCode(code) {
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.id_token) throw badRequest('Google did not return an identity token');
  const ticket = await oauthClient().verifyIdToken({
    idToken: tokens.id_token,
    audience: config.google.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) throw badRequest('Google did not return an email address for that account');
  return profileFromPayload(payload);
}
