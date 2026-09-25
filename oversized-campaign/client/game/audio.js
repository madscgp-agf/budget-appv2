// Tiny synthesised sound set (no audio files): breathing, plate clank,
// timing tick, success and failure cues. Starts muted until a user gesture.
export function createAudio() {
  let ctx = null;
  let master = null;
  let enabled = true;
  let noiseBuf = null;

  function ensure() {
    if (!enabled) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function noise(dur, { freq = 800, q = 0.7, gain = 0.3, attack = 0.05, type = 'bandpass' } = {}) {
    const c = ensure();
    if (!c) return;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    const t = c.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  function tone(freq, dur, { type = 'sine', gain = 0.2, slide = 0 } = {}) {
    const c = ensure();
    if (!c) return;
    const o = c.createOscillator();
    o.type = type;
    const g = c.createGain();
    const t = c.currentTime;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  return {
    unlock: ensure,
    setEnabled(v) {
      enabled = v;
      if (!v && ctx) ctx.suspend();
      if (v) ensure();
    },
    get enabled() {
      return enabled;
    },
    inhale(effort) {
      noise(0.55 + effort * 0.3, { freq: 1200 + effort * 600, q: 0.6, gain: 0.05 + effort * 0.06, attack: 0.25 });
    },
    exhale(effort) {
      noise(0.35 + effort * 0.25, { freq: 700 + effort * 400, q: 0.8, gain: 0.08 + effort * 0.1, attack: 0.03 });
    },
    grunt(effort) {
      tone(110 + effort * 40, 0.25, { type: 'sawtooth', gain: 0.025 + 0.04 * effort, slide: 0.8 });
      noise(0.25, { freq: 400, q: 1.2, gain: 0.06 * effort, attack: 0.02 });
    },
    clank() {
      tone(1240, 0.35, { type: 'triangle', gain: 0.08, slide: 0.98 });
      tone(1873, 0.25, { type: 'triangle', gain: 0.05 });
      noise(0.12, { freq: 3000, q: 1.5, gain: 0.12, attack: 0.002 });
    },
    tick() {
      tone(1400, 0.05, { type: 'square', gain: 0.03 });
    },
    good() {
      tone(523, 0.12, { gain: 0.08 });
      setTimeout(() => tone(784, 0.18, { gain: 0.08 }), 70);
    },
    bad() {
      tone(180, 0.3, { type: 'sawtooth', gain: 0.05, slide: 0.7 });
    },
    end() {
      tone(392, 0.2, { gain: 0.08 });
      setTimeout(() => tone(523, 0.2, { gain: 0.08 }), 120);
      setTimeout(() => tone(659, 0.35, { gain: 0.08 }), 240);
    },
  };
}
