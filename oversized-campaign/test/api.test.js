import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv, startServer, playRound } from './helpers.js';

useTempEnv('api', { DEMO_MODE: '1' });
const { botEvents } = await import('../scripts/simulate.js');
const { advanceClock } = await import('../src/lib/clock.js');
const { resetRateLimits } = await import('../src/lib/rateLimit.js');
const { lastMessages } = await import('../src/lib/mailer.js');
const { scoreRound } = await import('../shared/rules.js');

let h;
before(async () => {
  h = await startServer();
});
after(() => h.close());

const good = (seed) => botEvents(seed, 0.95, () => 0.5);

async function newPlayer() {
  const c = h.client();
  const r = await c.post('/api/session');
  assert.equal(r.status, 201);
  return c;
}

test('first visit creates an anonymous player with a secure HttpOnly session cookie', async () => {
  const c = h.client();
  const me0 = await c.get('/api/me');
  assert.equal(me0.body.player, null);
  const r = await c.post('/api/session');
  assert.equal(r.status, 201);
  const cookie = c.cookies.find((x) => x.startsWith('osg_sid='));
  assert.ok(cookie, 'session cookie set');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  const token = c.jar.get('osg_sid');
  assert.ok(token.length >= 43, 'at least 32 random bytes');
  // Recognised on the next request in the same browser.
  const me = await c.get('/api/me');
  assert.ok(me.body.player);
  assert.equal(me.body.player.bestScore, 0);
  assert.equal(me.body.demoMode, true);
  // Calling /session again does not create a second player.
  await c.post('/api/session');
  assert.equal(c.cookies.filter((x) => x.startsWith('osg_sid=')).length, 1);
});

test('a forged or unknown session token is not recognised', async () => {
  const c = h.client();
  c.jar.set('osg_sid', 'not-a-real-token');
  assert.equal((await c.get('/api/me')).body.player, null);
  assert.equal((await c.post('/api/rounds')).status, 401);
});

test('header fallback session works when cookies are blocked', async () => {
  const c = h.client();
  const r = await c.post('/api/session', { transport: 'header' });
  assert.match(r.body.headerToken, /^osg_/);
  assert.equal(c.cookies.length, 0, 'no cookie in header mode');
  c.setBearer(r.body.headerToken);
  assert.ok((await c.get('/api/me')).body.player);
});

test('server recomputes the score from events and stores the personal best', async () => {
  const c = await newPlayer();
  const { start, submit, events } = await playRound(c, good);
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  assert.equal(submit.body.score, scoreRound(start.body.seed, events).score);
  assert.equal(submit.body.newRecord, true);
  const me = await c.get('/api/me');
  assert.equal(me.body.player.bestScore, submit.body.score);
  assert.equal(me.body.player.roundsPlayed, 1);
});

test('the client cannot send its own score', async () => {
  const c = await newPlayer();
  const start = await c.post('/api/rounds');
  advanceClock(45_500);
  const r = await c.post(`/api/rounds/${start.body.roundId}/submit`, { events: [], score: 999999, tier: 15 });
  assert.equal(r.status, 200);
  assert.equal(r.body.score, 0);
});

test('double submission: identical retry returns the stored result, different events are refused', async () => {
  const c = await newPlayer();
  const { start, submit, events } = await playRound(c, good);
  const again = await c.post(`/api/rounds/${start.body.roundId}/submit`, { events });
  assert.equal(again.status, 200);
  assert.equal(again.body.replay, true);
  assert.equal(again.body.score, submit.body.score);
  const other = await c.post(`/api/rounds/${start.body.roundId}/submit`, { events: events.slice(0, 4) });
  assert.equal(other.status, 409);
  assert.equal((await c.get('/api/me')).body.player.roundsPlayed, 1);
});

test('concurrent submissions of one round are counted once', async () => {
  const c = await newPlayer();
  const start = await c.post('/api/rounds');
  const events = good(start.body.seed);
  advanceClock(45_500);
  const [a, b] = await Promise.all([
    c.post(`/api/rounds/${start.body.roundId}/submit`, { events }),
    c.post(`/api/rounds/${start.body.roundId}/submit`, { events: events.slice(0, 2) }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await c.get('/api/me')).body.player.roundsPlayed, 1);
});

test('submitting before 45 s could have passed is rejected', async () => {
  const c = await newPlayer();
  const start = await c.post('/api/rounds');
  advanceClock(20_000);
  const r = await c.post(`/api/rounds/${start.body.roundId}/submit`, { events: good(start.body.seed) });
  assert.equal(r.status, 422);
  assert.match(r.body.details.reason, /before the round/);
});

test('expired rounds and other players\' rounds cannot be submitted', async () => {
  const c = await newPlayer();
  const start = await c.post('/api/rounds');
  const d = await newPlayer();
  advanceClock(45_500);
  assert.equal((await d.post(`/api/rounds/${start.body.roundId}/submit`, { events: [] })).status, 404);
  advanceClock(120_000);
  assert.equal((await c.post(`/api/rounds/${start.body.roundId}/submit`, { events: [] })).status, 410);
});

test('invalid event streams are rejected', async () => {
  const c = await newPlayer();
  const start = await c.post('/api/rounds');
  advanceClock(45_500);
  const r = await c.post(`/api/rounds/${start.body.roundId}/submit`, { events: [[100, 1], [110, 0]] });
  assert.equal(r.status, 422);
});

test('only one live round per player: starting again abandons the old one', async () => {
  const c = await newPlayer();
  const a = await c.post('/api/rounds');
  const b = await c.post('/api/rounds');
  advanceClock(45_500);
  assert.equal((await c.post(`/api/rounds/${a.body.roundId}/submit`, { events: [] })).status, 409);
  assert.equal((await c.post(`/api/rounds/${b.body.roundId}/submit`, { events: [] })).status, 200);
});

test('starting rounds is rate limited', async () => {
  resetRateLimits();
  const c = await newPlayer();
  const statuses = [];
  for (let i = 0; i < 17; i++) statuses.push((await c.post('/api/rounds')).status);
  assert.ok(statuses.includes(429));
  resetRateLimits();
});

test('cross-site requests from unknown origins are refused, allowed storefront origins get CORS', async () => {
  const evil = h.client({ origin: 'https://evil.example' });
  assert.equal((await evil.post('/api/session')).status, 403);
  const shop = h.client({ origin: 'https://www.oversized.test' });
  const r = await shop.post('/api/session');
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://www.oversized.test');
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  const pre = await fetch(`${h.base}/api/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(pre.status, 403);
});

test('leaderboard shows only opted-in aliases, never e-mail', async () => {
  resetRateLimits();
  const c = await newPlayer();
  await playRound(c, good);
  let lb = await c.get('/api/leaderboard');
  assert.equal(lb.body.entries.some((e) => e.you), false, 'not listed before opting in');
  const bad = await c.patch('/api/me', { alias: '<script>' });
  assert.equal(bad.status, 400);
  assert.equal((await c.patch('/api/me', { alias: 'Bænkebidder', leaderboardOptIn: true })).status, 200);
  lb = await c.get('/api/leaderboard');
  const mine = lb.body.entries.find((e) => e.you);
  assert.equal(mine.alias, 'Bænkebidder');
  assert.deepEqual(Object.keys(mine).sort(), ['alias', 'rank', 'score', 'you']);
  const d = await newPlayer();
  assert.equal((await d.patch('/api/me', { alias: 'bænkebidder' })).status, 409, 'aliases are unique');
});

test('magic link verifies ownership and merges a second device into the first profile', async () => {
  resetRateLimits();
  const phone = await newPlayer();
  const { submit } = await playRound(phone, good);
  const r1 = await phone.post('/api/email-link', { email: 'Lifter@Example.com' });
  assert.equal(r1.status, 200);
  assert.ok(r1.body.demoLink, 'demo mode shows the link');
  const token1 = new URL(r1.body.demoLink).hash.slice(3);
  assert.equal((await phone.post('/api/email-verify', { token: token1 })).status, 200);
  assert.equal((await phone.post('/api/email-verify', { token: token1 })).status, 400, 'link is single use');

  // A new device: typing the same e-mail proves nothing by itself...
  const laptop = await newPlayer();
  const r2 = await laptop.post('/api/email-link', { email: 'lifter@example.com' });
  let me = await laptop.get('/api/me');
  assert.equal(me.body.player.bestScore, 0, 'no merge before the link is clicked');
  assert.equal(me.body.player.verified, false);
  // ...clicking the link does.
  const token2 = new URL(r2.body.demoLink).hash.slice(3);
  const v = await laptop.post('/api/email-verify', { token: token2 });
  assert.equal(v.status, 200);
  me = await laptop.get('/api/me');
  assert.equal(me.body.player.bestScore, submit.body.score, 'record restored on the second device');
  assert.equal(me.body.player.email, 'l•••••@example.com');
  assert.equal(lastMessages().at(-1).to, 'lifter@example.com');
});

test('expired magic links do not work', async () => {
  resetRateLimits();
  const c = await newPlayer();
  const r = await c.post('/api/email-link', { email: 'late@example.com' });
  advanceClock(21 * 60_000);
  const token = new URL(r.body.demoLink).hash.slice(3);
  assert.equal((await c.post('/api/email-verify', { token })).status, 400);
});

test('magic link requests are rate limited per address', async () => {
  resetRateLimits();
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const c = await newPlayer();
    statuses.push((await c.post('/api/email-link', { email: 'spam@example.com' })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  resetRateLimits();
});

test('demo reward: requires verification, is labelled DEMO and is issued once', async () => {
  resetRateLimits();
  const c = await newPlayer();
  await playRound(c, good);
  const denied = await c.post('/api/rewards/claim');
  assert.equal(denied.status, 403, 'anonymous players must verify first');
  const r = await c.post('/api/email-link', { email: 'winner@example.com' });
  await c.post('/api/email-verify', { token: new URL(r.body.demoLink).hash.slice(3) });
  const [a, b, d] = await Promise.all([c.post('/api/rewards/claim'), c.post('/api/rewards/claim'), c.post('/api/rewards/claim')]);
  const codes = new Set([a, b, d].map((x) => x.body.reward?.code));
  assert.equal(codes.size, 1);
  const code = [...codes][0];
  assert.match(code, /^DEMO-(5|10|15)-/);
  assert.equal(a.body.reward.demo, true);
  const me = await c.get('/api/me');
  assert.equal(me.body.eligibility.reward.code, code);
  assert.equal(me.body.eligibility.canClaim, false);
});

test('logout revokes the session', async () => {
  const c = await newPlayer();
  const token = c.jar.get('osg_sid');
  await c.post('/api/logout');
  c.jar.set('osg_sid', token);
  assert.equal((await c.get('/api/me')).body.player, null);
});

test('demo admin is available locally in demo mode', async () => {
  const c = h.client();
  const s = await c.get('/admin/api/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.demoAdmin, true);
  const spoof = await c.get('/admin/api/status', { 'x-forwarded-for': '1.2.3.4' });
  assert.equal(spoof.status, 401, 'not through a proxy');
  const camp = await c.get('/admin/api/campaign');
  assert.equal(camp.body.isDemoTiers, true);
  const upd = await c.put('/admin/api/campaign', { ...camp.body, leaderboardEnabled: false });
  assert.equal(upd.status, 200);
  assert.equal((await c.get('/api/leaderboard')).body.enabled, false);
  const bad = await c.put('/admin/api/campaign', { ...camp.body, productIds: ['123'] });
  assert.equal(bad.status, 400);
});
