import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { db, tx } from '../db.js';
import { now, nowIso } from '../lib/clock.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, asyncRoute, HttpError, conflict } from '../lib/errors.js';
import { getCampaign, publicCampaign } from '../lib/campaign.js';
import { limit } from '../lib/rateLimit.js';
import { ensurePlayer, currentPlayer, requirePlayer, revokeSession, rotateSession, issueHeaderSession } from '../lib/sessions.js';
import { findByCustomer, findByEmail, mergePlayers, playerById, resolvePlayer, selfView } from '../lib/players.js';
import { eligibility } from '../lib/rewards.js';
import { mailConfigured, sendMagicLink } from '../lib/mailer.js';
import { consumeCustomerAssertion } from '../lib/assertions.js';

export const playerRouter = Router();

function mePayload(player) {
  const campaign = getCampaign();
  return {
    demoMode: config.demoMode,
    player: player ? selfView(player) : null,
    campaign: publicCampaign(campaign),
    eligibility: player ? eligibility(player, campaign) : null,
    emailLinking: mailConfigured() || config.demoMode,
  };
}

// Who am I? Never creates anything.
playerRouter.get('/me', (req, res) => {
  res.json(mePayload(currentPlayer(req, res)));
});

// First visit: create an anonymous profile and a session.
// transport=header is the fallback when the browser refuses the cookie.
playerRouter.post('/session', (req, res) => {
  limit(`session:${req.ip}`, 20, 60 * 60_000);
  const transport = req.body?.transport === 'header' ? 'header' : 'cookie';
  const { player, headerToken } = ensurePlayer(req, res, transport);
  res.status(201).json({ ...mePayload(player), ...(headerToken ? { headerToken } : {}) });
});

const ALIAS_RE = /^[A-Za-z0-9ÆØÅæøåÄÖÜäöüß _.-]{3,16}$/;
const profileSchema = z.object({
  alias: z.string().trim().regex(ALIAS_RE, 'Alias skal være 3–16 tegn: bogstaver, tal, mellemrum, _ . -').nullable().optional(),
  leaderboardOptIn: z.boolean().optional(),
  marketingOptIn: z.boolean().optional(),
});

playerRouter.patch('/me', requirePlayer, (req, res) => {
  const input = profileSchema.parse(req.body || {});
  const p = req.player;
  const t = nowIso();
  tx(() => {
    if (input.alias !== undefined) {
      const lower = input.alias ? input.alias.toLowerCase() : null;
      if (lower) {
        const taken = db.prepare('SELECT id FROM players WHERE alias_lower = ? AND id != ?').get(lower, p.id);
        if (taken) throw conflict('Det alias er taget');
      }
      db.prepare('UPDATE players SET alias = ?, alias_lower = ?, alias_hidden = 0 WHERE id = ?').run(input.alias || null, lower, p.id);
    }
    if (input.leaderboardOptIn !== undefined) {
      db.prepare('UPDATE players SET leaderboard_opt_in = ? WHERE id = ?').run(input.leaderboardOptIn ? 1 : 0, p.id);
    }
    if (input.marketingOptIn !== undefined) {
      // Marketing consent is separate from recognition and needs a verified email.
      if (input.marketingOptIn && !p.email_verified_at) throw badRequest('Bekræft din e-mail først');
      db.prepare('UPDATE players SET marketing_opt_in = ?, marketing_opt_in_at = ? WHERE id = ?').run(
        input.marketingOptIn ? 1 : 0,
        input.marketingOptIn ? t : null,
        p.id,
      );
    }
  });
  res.json(mePayload(playerById.get(p.id)));
});

// "Forget this device": revokes the session and clears the cookie.
playerRouter.post('/logout', (req, res) => {
  revokeSession(req, res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- email link

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200) });

playerRouter.post(
  '/email-link',
  requirePlayer,
  asyncRoute(async (req, res) => {
    if (!mailConfigured() && !config.demoMode) throw new HttpError(503, 'E-mail er ikke sat op endnu');
    const { email } = emailSchema.parse(req.body || {});
    limit(`mail:player:${req.player.id}`, 3, 60 * 60_000);
    limit(`mail:email:${email}`, 3, 60 * 60_000);
    limit(`mail:ip:${req.ip}`, 10, 60 * 60_000);

    const token = randomToken(32);
    db.prepare(
      'INSERT INTO email_tokens (token_hash, player_id, email, email_lower, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sha256(token), req.player.id, email, email, nowIso(), new Date(now() + config.magicLinkTtlMinutes * 60_000).toISOString());

    // The token goes in the fragment so it never appears in server logs or
    // Referer headers; the page posts it back only after a click.
    const link = `${config.appUrl}/verify#t=${token}`;
    const sent = await sendMagicLink(email, link, config.magicLinkTtlMinutes);
    // Same answer whether or not the address is already known.
    res.json({
      ok: true,
      message: 'Hvis adressen er gyldig, får du en mail med et link om lidt.',
      ...(sent.demo ? { demoLink: link, demoNotice: 'DEMO: ingen mail er sendt. Brug linket herunder.' } : {}),
    });
  }),
);

playerRouter.post('/email-verify', (req, res) => {
  limit(`verify:${req.ip}`, 20, 60 * 60_000);
  const token = String(req.body?.token || '');
  const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(sha256(token));
  if (!row || row.used_at || row.expires_at <= nowIso()) {
    throw badRequest('Linket er udløbet eller allerede brugt. Bed om et nyt fra spillet.');
  }
  const claimed = db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(nowIso(), row.token_hash);
  if (claimed.changes === 0) throw badRequest('Linket er allerede brugt');

  // Ownership of the address is now proven. Whoever already owns it wins; the
  // requesting profile (and this browser's profile) are merged into it.
  const requester = resolvePlayer(row.player_id);
  const owner = findByEmail(row.email_lower);
  let survivor;
  if (owner) {
    survivor = requester && requester.id !== owner.id ? mergePlayers(requester.id, owner.id) : owner;
  } else {
    if (!requester) throw badRequest('Profilen findes ikke længere');
    db.prepare('UPDATE players SET email = ?, email_lower = ?, email_verified_at = ? WHERE id = ?').run(
      row.email,
      row.email_lower,
      nowIso(),
      requester.id,
    );
    survivor = resolvePlayer(requester.id);
  }
  const here = currentPlayer(req, res);
  if (here && here.id !== survivor.id && !here.email_verified_at && !here.shopify_customer_id) {
    survivor = mergePlayers(here.id, survivor.id);
  }
  let headerToken;
  if (req.sessionRow?.transport === 'header') headerToken = `osg_${issueHeaderSession(survivor.id)}`;
  else rotateSession(req, res, survivor.id);
  res.json({ ...mePayload(resolvePlayer(survivor.id)), merged: Boolean(owner && requester && owner.id !== row.player_id), ...(headerToken ? { headerToken } : {}) });
});

// ------------------------------------------------------- Shopify customer link

playerRouter.post('/link-customer', requirePlayer, (req, res) => {
  const a = consumeCustomerAssertion(req.body?.assertion);
  if (!a || (config.shopify.shopDomain && a.shop !== config.shopify.shopDomain)) throw badRequest('Kunne ikke bekræfte kundelogin');
  const owner = findByCustomer(a.customerId);
  let survivor;
  if (owner && owner.id !== req.player.id) {
    survivor = mergePlayers(req.player.id, owner.id);
    rotateSession(req, res, survivor.id);
  } else {
    db.prepare('UPDATE players SET shopify_customer_id = ?, customer_verified_at = ? WHERE id = ?').run(a.customerId, nowIso(), req.player.id);
    survivor = resolvePlayer(req.player.id);
  }
  res.json(mePayload(survivor));
});
