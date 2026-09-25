import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim, scoreRound, validateEvents, repParams, pressCurve, repPoints, DOWN, UP, ROUND_MS, RULES_VERSION } from '../shared/rules.js';
import { botEvents } from '../scripts/simulate.js';

const seeded = (s) => {
  let a = s;
  return () => ((a = (a * 1103515245 + 12345) >>> 0) / 2 ** 32);
};

test('same seed and events give the same score every time', () => {
  const events = botEvents(1234, 0.8, seeded(9));
  const a = scoreRound(1234, events);
  const b = scoreRound(1234, JSON.parse(JSON.stringify(events)));
  assert.equal(a.valid, true);
  assert.deepEqual(a, b);
  assert.ok(a.score > 0);
  assert.equal(a.rulesVersion, RULES_VERSION);
});

test('the live simulation the browser runs agrees with the server replay', () => {
  const seed = 987654;
  const events = botEvents(seed, 0.7, seeded(3));
  const sim = createSim(seed);
  let i = 0;
  // Interleave view() calls at 16 ms frames like requestAnimationFrame does.
  for (let t = 0; t <= ROUND_MS; t += 16) {
    while (i < events.length && events[i][0] <= t) {
      sim.push(events[i][1], events[i][0]);
      i++;
    }
    sim.view(t);
  }
  assert.equal(sim.finish().score, scoreRound(seed, events).score);
});

test('a different seed changes the timing windows', () => {
  const a = repParams(1, 3, 80, 0.2);
  const b = repParams(2, 3, 80, 0.2);
  assert.notEqual(a.lockCenter, b.lockCenter);
});

test('the press curve is monotonic for every allowed stickiness', () => {
  for (const stick of [0, 0.9, 1.4, 1.8]) {
    let prev = -1;
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const p = pressCurve(u, stick);
      assert.ok(p >= prev - 1e-12, `stick ${stick} u ${u}`);
      prev = p;
    }
  }
});

test('score grows with weight, quality and streak', () => {
  assert.ok(repPoints(100, 1, 0) > repPoints(60, 1, 0));
  assert.ok(repPoints(80, 1, 0) > repPoints(80, 0.5, 0));
  assert.ok(repPoints(80, 1, 3) > repPoints(80, 1, 0));
});

test('better timing scores more than sloppy timing', () => {
  let good = 0;
  let bad = 0;
  for (let s = 1; s <= 20; s++) {
    good += scoreRound(s, botEvents(s, 0.95, seeded(s))).score;
    bad += scoreRound(s, botEvents(s, 0.2, seeded(s))).score;
  }
  assert.ok(good > bad * 1.4, `${good} vs ${bad}`);
});

test('a perfect bot cannot exceed a sane ceiling', () => {
  const r = scoreRound(42, botEvents(42, 1, seeded(1)));
  assert.ok(r.score < 3500, `score ${r.score}`);
  assert.ok(r.approvedReps <= 16);
});

test('releasing too high is a failed rep', () => {
  const sim = createSim(5);
  sim.push(DOWN, 1000);
  sim.push(UP, 1100); // bar has barely moved
  const rep = sim.state.reps[0];
  assert.equal(rep.ok, false);
  assert.equal(rep.feedback, 'noTouch');
});

test('no lockout tap fails the rep', () => {
  const sim = createSim(5);
  const p = sim.view(1000).params;
  sim.push(DOWN, 1000);
  sim.push(UP, 1000 + p.descentMs + 50);
  sim.view(1000 + p.descentMs + 50 + p.pressMs + 1000);
  assert.equal(sim.state.reps[0].feedback, 'noLock');
});

test('holding the bar on the chest too long makes it sink', () => {
  const sim = createSim(5);
  const p = sim.view(0).params;
  sim.push(DOWN, 100);
  sim.view(100 + p.descentMs + 2000);
  assert.equal(sim.state.reps[0].feedback, 'sank');
});

test('inputs after the clock runs out are ignored', () => {
  const sim = createSim(5);
  sim.push(DOWN, ROUND_MS);
  sim.push(UP, ROUND_MS);
  assert.equal(sim.finish().attempts, 0);
});

test('event validation rejects malformed or impossible input', () => {
  assert.equal(validateEvents([]), null);
  assert.match(validateEvents('x'), /array/);
  assert.match(validateEvents([[0, UP]]), /order/);
  assert.match(validateEvents([[10, DOWN], [5, UP]]), /back in time|too close/);
  assert.match(validateEvents([[10, DOWN], [20, UP]]), /too close/);
  assert.match(validateEvents([[10.5, DOWN]]), /time/);
  assert.match(validateEvents([[ROUND_MS + 1, DOWN]]), /time/);
  assert.match(validateEvents([[10, 2]]), /type/);
  assert.match(validateEvents([[10, DOWN, 3]]), /malformed/);
  const many = [];
  for (let i = 0; i < 700; i++) many.push([i * 30, i % 2 ? UP : DOWN]);
  assert.match(validateEvents(many), /too many/);
});
