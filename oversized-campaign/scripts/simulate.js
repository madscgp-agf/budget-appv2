// Plays many rounds with simple bots to show how the score model behaves.
// Usage: npm run simulate
import { createSim, repParams, pressCurve, ROUND_MS, DOWN, UP, scoreRound } from '../shared/rules.js';

// Find the press time at which the bar reaches `target` height.
function timeForPos(p, target) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (pressCurve(mid, p.stick) < target) lo = mid;
    else hi = mid;
  }
  return Math.round(hi * p.pressMs);
}

// skill 0..1: 1 is frame-perfect, 0.5 a decent human.
export function botEvents(seed, skill, rnd = Math.random) {
  const sim = createSim(seed);
  const events = [];
  const noise = (ms) => Math.round((rnd() - 0.5) * 2 * ms * (1 - skill));
  let t = 250;
  while (t < ROUND_MS - 50) {
    const v = sim.view(t);
    if (v.phase !== 'ready') { t += 10; continue; }
    const p = v.params;
    events.push([t, DOWN]); sim.push(DOWN, t);
    const release = t + p.descentMs + 60 + noise(260);
    const up = Math.max(t + 30, release);
    if (up >= ROUND_MS) break;
    events.push([up, UP]); sim.push(UP, up);
    if (sim.view(up).phase !== 'pressing') { t = up + 40; continue; }
    const tap = up + timeForPos(p, p.lockCenter) + noise(220);
    const tapT = Math.max(up + 30, tap);
    if (tapT >= ROUND_MS) break;
    events.push([tapT, DOWN]); sim.push(DOWN, tapT);
    const tapUp = tapT + 90 + Math.round(rnd() * 40);
    if (tapUp >= ROUND_MS) break;
    events.push([tapUp, UP]); sim.push(UP, tapUp);
    t = tapUp + 60 + Math.round(rnd() * 200 * (1 - skill));
  }
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const skill of [1, 0.9, 0.75, 0.5, 0.3]) {
    const scores = [];
    let reps = 0;
    for (let i = 0; i < 300; i++) {
      const seed = (Math.random() * 2 ** 32) >>> 0;
      const r = scoreRound(seed, botEvents(seed, skill));
      scores.push(r.score);
      reps += r.approvedReps;
    }
    scores.sort((a, b) => a - b);
    const pct = (q) => scores[Math.floor(q * (scores.length - 1))];
    console.log(`skill ${skill}: median ${pct(0.5)}  p10 ${pct(0.1)}  p90 ${pct(0.9)}  max ${pct(1)}  avg reps ${(reps / 300).toFixed(1)}`);
  }
}
