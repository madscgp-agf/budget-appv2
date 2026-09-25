// Oversized Bench — game rules.
//
// This module is the single source of truth for how a round plays out. It is
// imported by the browser (to drive the animation and HUD) and by the server
// (to recompute the score from the raw input events). It must therefore:
//
//  * depend on nothing but the seed and the list of input events,
//  * use only integer times (ms since round start),
//  * avoid transcendental Math functions (sin, exp, pow ...) whose last bits
//    may differ between JavaScript engines. Only + - * / and rounding are used,
//    which IEEE-754 guarantees to be identical everywhere.
//
// Changing any number below changes scores, so bump RULES_VERSION when you do.

export const RULES_VERSION = 1;
export const ROUND_MS = 45000;

// Input event types. A round is a list of [t, type] pairs.
export const DOWN = 1;
export const UP = 0;

export const LIMITS = {
  maxEvents: 600,       // ~6.6 presses per second for 45s; far more than a human needs
  minGapMs: 25,         // two events closer than this are not humanly possible on one button
};

export const TUNING = {
  startKg: 60,
  maxKg: 180,
  descentMs: 1250,       // lowering from lockout to chest at 60 kg, fresh
  touchZone: 0.13,       // bar position (0 = chest, 1 = lockout) that counts as touching
  minTouchZone: 0.08,
  dwellOkMs: 350,        // a short pause on the chest is fine
  dwellMaxMs: 1500,      // longer and the bar sinks: spotter takes it
  pressBaseMs: 1050,
  pressPerKgMs: 7,
  pressFatigueMs: 750,
  lockCenter: 0.86,
  lockJitter: 0.08,
  lockHalf: 0.10,
  minLockHalf: 0.05,
  lateGraceMs: 200,      // a tap just after the bar reaches the top still counts, poorly
  recoverMs: 450,
  failRecoverMs: 1300,   // spotter helps re-rack
};

export const FEEDBACK = {
  clean: 'Ren gentagelse',
  good: 'God gentagelse',
  sloppy: 'Godkendt – men sjusket',
  high: 'For højt – før stangen helt ned',
  noTouch: 'Ingen rep – stangen rørte ikke brystet',
  lostTension: 'Mistet spænding på brystet',
  sank: 'Stangen sank – spotter hjælper',
  early: 'For tidligt – vent på lockout-zonen',
  tooEarly: 'Alt for tidligt – ingen lockout',
  late: 'Sen lockout',
  noLock: 'Ingen lockout',
};

// mulberry32: tiny deterministic PRNG built on 32-bit integer maths only.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const q3 = (v) => Math.round(v * 1000) / 1000;

// Bar height during the press as a function of press progress u in [0, 1].
// A cubic with a slow "sticking point" in the middle: fast off the chest,
// grinding through mid-range, faster again into lockout. `stick` < 2 keeps
// the curve monotonic.
export function pressCurve(u, stick) {
  const x = clamp(u, 0, 1);
  return x + stick * x * (1 - x) * (1 - 2 * x);
}

// Everything about the next attempt that depends on load, fatigue and seed.
export function repParams(seed, repIndex, kg, fatigue) {
  const rng = mulberry32((seed ^ Math.imul(repIndex + 1, 0x9e3779b1)) >>> 0);
  const r1 = rng();
  const r2 = rng();
  const load = (kg - TUNING.startKg) / (TUNING.maxKg - TUNING.startKg); // 0..1
  const descentMs = Math.round(TUNING.descentMs * (1 + 0.18 * load + 0.2 * fatigue) * (0.95 + 0.1 * r1));
  const pressMs = Math.round(TUNING.pressBaseMs + TUNING.pressPerKgMs * (kg - TUNING.startKg) + TUNING.pressFatigueMs * fatigue);
  const stick = q3(clamp(0.9 + 0.5 * load + 0.5 * fatigue, 0, 1.8));
  const lockCenter = q3(TUNING.lockCenter + (r2 - 0.5) * TUNING.lockJitter);
  const lockHalf = q3(Math.max(TUNING.minLockHalf, TUNING.lockHalf * (1 - 0.35 * fatigue - 0.25 * load)));
  const touchZone = q3(Math.max(TUNING.minTouchZone, TUNING.touchZone * (1 - 0.3 * fatigue)));
  return { descentMs, pressMs, stick, lockCenter, lockHalf, touchZone };
}

// Points for one approved rep. Deterministic and integer.
export function repPoints(kg, quality, cleanStreak) {
  const mult = 1 + 0.08 * Math.min(cleanStreak, 6);
  return Math.round(kg * 1.5 * quality * mult);
}

function depthQuality(releasePos, dwellMs, p) {
  if (releasePos <= 0) {
    if (dwellMs <= TUNING.dwellOkMs) return { q: 1, note: null };
    const over = (dwellMs - TUNING.dwellOkMs) / (TUNING.dwellMaxMs - TUNING.dwellOkMs);
    return { q: q3(1 - 0.5 * clamp(over, 0, 1)), note: 'lostTension' };
  }
  if (releasePos <= p.touchZone) return { q: q3(1 - 0.25 * (releasePos / p.touchZone)), note: null };
  if (releasePos <= p.touchZone * 2) return { q: 0.35, note: 'high' };
  return { q: 0, note: 'noTouch', fail: true };
}

function lockQuality(pos, lateMs, p) {
  if (lateMs > 0) return { q: 0.3, note: 'late' };
  const lo = p.lockCenter - p.lockHalf;
  const hi = p.lockCenter + p.lockHalf;
  if (pos >= lo && pos <= hi) return { q: q3(1 - 0.5 * (Math.abs(pos - p.lockCenter) / p.lockHalf)), note: null };
  if (pos > hi) return { q: q3(0.5 - 0.2 * ((pos - hi) / Math.max(0.001, 1 - hi))), note: 'late' };
  if (pos >= lo - 0.5 * p.lockHalf) return { q: 0.25, note: 'early' };
  return { q: 0, note: 'tooEarly', fail: true };
}

/**
 * Create a simulation. Feed it input with push(type, t) in time order and ask
 * for the state at any time with view(t). finish() closes the round.
 */
export function createSim(seed) {
  const s = {
    seed: seed >>> 0,
    kg: TUNING.startKg,
    fatigue: 0,
    phase: 'ready',   // ready | lowering | pressing | recover | failed | done
    phaseAt: 0,
    params: null,
    // current attempt
    releasePos: 1,
    dwellMs: 0,
    depth: null,
    lock: null,
    tapPos: null,
    ignoreUp: false,
    // totals
    attempts: 0,
    reps: [],          // every attempt with its outcome
    approved: 0,
    clean: 0,
    cleanStreak: 0,
    score: 0,
    qualitySum: 0,
    events: 0,
    lastT: 0,
  };
  s.params = repParams(s.seed, 0, s.kg, s.fatigue);

  function barPos(t) {
    const p = s.params;
    switch (s.phase) {
      case 'lowering':
        return clamp(1 - (t - s.phaseAt) / p.descentMs, 0, 1);
      case 'pressing':
        return pressCurve((t - s.phaseAt) / p.pressMs, p.stick);
      case 'failed': {
        // Spotter lifts it back to the hooks.
        const u = clamp((t - s.phaseAt) / TUNING.failRecoverMs, 0, 1);
        return s.releasePos + (1 - s.releasePos) * u * u * (3 - 2 * u);
      }
      default:
        return 1;
    }
  }

  function chestAt() {
    return s.phaseAt + s.params.descentMs;
  }

  function nextAttempt() {
    s.attempts += 1;
    s.params = repParams(s.seed, s.attempts, s.kg, s.fatigue);
    s.releasePos = 1;
    s.dwellMs = 0;
    s.depth = null;
    s.lock = null;
    s.tapPos = null;
  }

  function settle(t, outcome) {
    const rep = {
      i: s.reps.length,
      kg: s.kg,
      t,
      ok: !outcome.fail,
      quality: outcome.quality,
      points: 0,
      feedback: outcome.feedback,
      depthQ: s.depth ? s.depth.q : 0,
      lockQ: s.lock ? s.lock.q : 0,
    };
    s.fatigue = q3(clamp(s.fatigue + 0.035 + 0.0007 * (s.kg - TUNING.startKg) + (outcome.fail ? 0.08 : 0), 0, 1));
    if (!outcome.fail) {
      const clean = rep.quality >= 0.85;
      rep.clean = clean;
      rep.points = repPoints(s.kg, rep.quality, s.cleanStreak);
      s.score += rep.points;
      s.approved += 1;
      s.qualitySum += rep.quality;
      if (clean) {
        s.clean += 1;
        s.cleanStreak += 1;
      } else {
        s.cleanStreak = 0;
      }
      const step = rep.quality >= 0.85 ? 5 : rep.quality >= 0.6 ? 2.5 : 0;
      s.kg = Math.min(TUNING.maxKg, s.kg + step);
    } else {
      rep.clean = false;
      s.cleanStreak = 0;
      s.kg = Math.max(TUNING.startKg, s.kg - 5);
    }
    s.reps.push(rep);
    return rep;
  }

  function fail(t, feedbackKey, recoverPhase) {
    const rep = settle(t, { fail: true, quality: 0, feedback: feedbackKey });
    s.phase = recoverPhase || 'failed';
    s.phaseAt = t;
    return rep;
  }

  // Apply every time-driven transition up to and including t.
  function advance(t) {
    for (let guard = 0; guard < 16; guard++) {
      if (s.phase === 'done') return;
      if (t >= ROUND_MS && s.phase !== 'done') {
        // Anything still in progress when the clock runs out does not count.
        s.phase = 'done';
        s.phaseAt = ROUND_MS;
        return;
      }
      if (s.phase === 'lowering') {
        const failAt = chestAt() + TUNING.dwellMaxMs;
        if (t >= failAt) {
          s.releasePos = 0;
          fail(failAt, 'sank');
          continue;
        }
        return;
      }
      if (s.phase === 'pressing') {
        const topAt = s.phaseAt + s.params.pressMs;
        if (s.lock) {
          if (t >= topAt) {
            s.phase = 'recover';
            s.phaseAt = topAt;
            continue;
          }
          return;
        }
        const giveUpAt = topAt + TUNING.lateGraceMs;
        if (t >= giveUpAt) {
          fail(giveUpAt, 'noLock', 'recover');
          continue;
        }
        return;
      }
      if (s.phase === 'recover' || s.phase === 'failed') {
        const d = s.phase === 'recover' ? TUNING.recoverMs : TUNING.failRecoverMs;
        if (t >= s.phaseAt + d) {
          s.phaseAt += d;
          s.phase = 'ready';
          nextAttempt();
          continue;
        }
        return;
      }
      return;
    }
  }

  // Returns the rep that settled because of this input, if any.
  function push(type, t) {
    advance(t);
    s.events += 1;
    s.lastT = t;
    if (s.phase === 'done') return null;

    if (type === DOWN) {
      if (s.phase === 'ready') {
        s.phase = 'lowering';
        s.phaseAt = t;
        s.ignoreUp = false;
        return null;
      }
      if (s.phase === 'pressing' && !s.lock) {
        const topAt = s.phaseAt + s.params.pressMs;
        const lateMs = t > topAt ? t - topAt : 0;
        const pos = barPos(Math.min(t, topAt));
        s.tapPos = pos;
        s.lock = lockQuality(pos, lateMs, s.params);
        s.ignoreUp = true;
        if (s.lock.fail) {
          s.releasePos = pos;
          return fail(t, s.lock.note);
        }
        const quality = q3(0.45 * s.depth.q + 0.55 * s.lock.q);
        const note = s.depth.note || s.lock.note;
        const feedback = note || (quality >= 0.85 ? 'clean' : quality >= 0.6 ? 'good' : 'sloppy');
        const rep = settle(t, { fail: false, quality, feedback });
        if (t >= topAt) {
          s.phase = 'recover';
          s.phaseAt = t;
        }
        return rep;
      }
      // Pressing the button while re-racking does nothing, and neither does
      // letting go of it afterwards.
      s.ignoreUp = true;
      return null;
    }

    // UP
    if (s.phase === 'lowering') {
      const pos = barPos(t);
      const chest = chestAt();
      s.releasePos = pos;
      s.dwellMs = t > chest ? t - chest : 0;
      s.depth = depthQuality(pos, s.dwellMs, s.params);
      if (s.depth.fail) return fail(t, s.depth.note);
      s.phase = 'pressing';
      s.phaseAt = t;
      return null;
    }
    s.ignoreUp = false;
    return null;
  }

  function view(t) {
    advance(t);
    const p = s.params;
    const pos = barPos(Math.min(t, ROUND_MS));
    let pressU = 0;
    if (s.phase === 'pressing') pressU = clamp((t - s.phaseAt) / p.pressMs, 0, 1);
    const load = (s.kg - TUNING.startKg) / (TUNING.maxKg - TUNING.startKg);
    return {
      t,
      remainingMs: Math.max(0, ROUND_MS - t),
      phase: s.phase,
      phaseAt: s.phaseAt,
      pos,
      pressU,
      kg: s.kg,
      fatigue: s.fatigue,
      strain: clamp(0.25 * load + 0.55 * s.fatigue + (s.phase === 'pressing' ? 0.25 : 0), 0, 1),
      params: p,
      approved: s.approved,
      clean: s.clean,
      score: s.score,
      cleanStreak: s.cleanStreak,
      lastRep: s.reps.length ? s.reps[s.reps.length - 1] : null,
      repCount: s.reps.length,
    };
  }

  function finish() {
    advance(ROUND_MS);
    return result();
  }

  function result() {
    return {
      rulesVersion: RULES_VERSION,
      score: s.score,
      approvedReps: s.approved,
      cleanReps: s.clean,
      attempts: s.reps.length,
      topKg: s.reps.reduce((m, r) => (r.ok && r.kg > m ? r.kg : m), 0),
      avgQuality: s.approved ? q3(s.qualitySum / s.approved) : 0,
      reps: s.reps.map((r) => ({ i: r.i, kg: r.kg, ok: r.ok, quality: r.quality, points: r.points, feedback: r.feedback })),
    };
  }

  return { push, advance, view, finish, result, state: s };
}

/**
 * Check a submitted event list for structural problems before replaying it.
 * Returns null when the list is acceptable, otherwise a short reason string.
 */
export function validateEvents(events) {
  if (!Array.isArray(events)) return 'events must be an array';
  if (events.length > LIMITS.maxEvents) return 'too many events';
  let prevT = -Infinity;
  let expect = DOWN;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!Array.isArray(e) || e.length !== 2) return `event ${i} is malformed`;
    const [t, type] = e;
    if (!Number.isInteger(t) || t < 0 || t > ROUND_MS) return `event ${i} has an invalid time`;
    if (type !== DOWN && type !== UP) return `event ${i} has an invalid type`;
    if (type !== expect) return `event ${i} is out of order (presses and releases must alternate)`;
    if (t < prevT) return `event ${i} goes back in time`;
    if (i > 0 && t - prevT < LIMITS.minGapMs) return `event ${i} is too close to the previous one`;
    prevT = t;
    expect = type === DOWN ? UP : DOWN;
  }
  return null;
}

/** Replay a full round. This is what the server trusts. */
export function scoreRound(seed, events) {
  const reason = validateEvents(events);
  if (reason) return { valid: false, reason };
  const sim = createSim(seed);
  for (const [t, type] of events) sim.push(type, t);
  const res = sim.finish();
  return { valid: true, ...res, lastEventMs: events.length ? events[events.length - 1][0] : 0 };
}

/**
 * Heuristics that mark a round for review. They never change the score:
 * a strong human can trip them, and a careful bot can avoid them.
 */
export function suspicionFlags(result, events) {
  const flags = [];
  const ok = result.reps.filter((r) => r.ok);
  if (ok.length >= 8 && ok.every((r) => r.quality >= 0.97)) flags.push('near-perfect-timing');
  if (events.length >= 12) {
    const gaps = [];
    for (let i = 1; i < events.length; i += 2) gaps.push(events[i][0] - events[i - 1][0]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length;
    if (variance < 4) flags.push('robotic-hold-lengths');
  }
  return flags;
}
