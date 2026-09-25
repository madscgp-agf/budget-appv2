// A replaceable clock so tests can move time forward without waiting.
let offsetMs = 0;
export const now = () => Date.now() + offsetMs;
export const nowIso = () => new Date(now()).toISOString();
export const isoIn = (ms) => new Date(now() + ms).toISOString();
export function advanceClock(ms) {
  offsetMs += ms;
}
export function resetClock() {
  offsetMs = 0;
}
