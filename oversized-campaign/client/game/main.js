// Oversized Bench — the game shell. Loaded lazily when the player opens it.
import * as THREE from 'three';
import css from './styles.css';
import { createSim, DOWN, UP, ROUND_MS, RULES_VERSION, LIMITS, FEEDBACK } from '../../shared/rules.js';
import { createScene } from './scene.js';
import { detectQuality, frameGovernor, makeQuality, webglAvailable } from './quality.js';
import { createAudio } from './audio.js';
import { createApi } from './api.js';

const ICON = {
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  motion: '<svg viewBox="0 0 24 24"><path d="M3 12c3-6 6-6 9 0s6 6 9 0"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};

const fmt = (n) => Number(n || 0).toLocaleString('da-DK');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

function pref(key, fallback) {
  try {
    const v = localStorage.getItem(`osg:${key}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function setPref(key, v) {
  try {
    localStorage.setItem(`osg:${key}`, v ? '1' : '0');
  } catch {
    /* private mode: preference just is not remembered */
  }
}

/**
 * mount(container, options) -> { destroy }
 * options: apiBase, proxyBase (storefront app proxy path, optional),
 *          customerLoggedIn (hint only), onClose
 */
export function mount(container, options = {}) {
  const host = document.createElement('div');
  host.setAttribute('data-oversized-root', '');
  container.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  const el = document.createElement('div');
  el.className = 'osg';
  el.dataset.mode = 'menu';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Oversized Bench');
  el.innerHTML = `
    <div class="osg-stage"></div>
    <div class="osg-vignette"></div>
    <header class="osg-top" aria-hidden="false">
      <div class="stat"><span class="k">Vægt</span><span class="v" data-kg>60<small>kg</small></span></div>
      <div class="stat"><span class="k">Godkendte</span><span class="v" data-reps>0</span></div>
      <div class="stat time"><span class="k">Tid</span><span class="v" data-time>0:45</span></div>
      <div class="stat"><span class="k">Score</span><span class="v" data-score>0</span></div>
      <div class="stat pb"><span class="k">Rekord</span><span class="v" data-pb>–</span></div>
    </header>
    <div class="osg-tools">
      <button class="tool" data-profile aria-label="Profil og rekord">${ICON.user}</button>
      <button class="tool" data-sound aria-label="Lyd">${ICON.sound}</button>
      <button class="tool" data-motion aria-label="Bevægelse">${ICON.motion}</button>
      <button class="tool" data-close aria-label="Luk spillet">${ICON.close}</button>
    </div>
    <div class="osg-gauge" aria-hidden="true">
      <div class="track">
        <div class="zone touch"></div><div class="zone lock"></div>
        <span class="zlabel" data-zl-lock>LOCK</span><span class="zlabel" style="bottom:0">BRYST</span>
        <div class="marker"></div>
      </div>
      <div class="hint" data-hint></div>
    </div>
    <div class="osg-feedback" aria-live="polite"><div class="t"></div><div class="p"></div></div>
    <div class="osg-banner" hidden></div>
    <button class="osg-hold" aria-label="Hold for at sænke stangen, slip for at presse, tryk igen for lockout">
      <span><span class="l1">HOLD</span><span class="l2">eller mellemrum</span></span>
    </button>
    <div class="brand">OVERSIZED STUDIOS</div>
    <div class="osg-panel" role="document"></div>
  `;
  root.appendChild(el);

  const $ = (s) => el.querySelector(s);
  const panel = $('.osg-panel');
  const banner = $('.osg-banner');
  const hud = {
    kg: $('[data-kg]'),
    reps: $('[data-reps]'),
    time: $('[data-time]'),
    score: $('[data-score]'),
    pb: $('[data-pb]'),
    hint: $('[data-hint]'),
    touch: $('.zone.touch'),
    lock: $('.zone.lock'),
    lockLabel: $('[data-zl-lock]'),
    marker: $('.marker'),
    fb: $('.osg-feedback'),
    hold: $('.osg-hold'),
  };

  const api = createApi(options.apiBase || '', { proxyBase: options.proxyBase });
  const audio = createAudio();
  const state = {
    me: null,
    cookieOk: true,
    reduced: pref('reduced', matchMedia('(prefers-reduced-motion: reduce)').matches),
    sound: pref('sound', true),
    mode: 'menu', // menu | practice | countdown | round | submitting | result
    sim: null,
    t0: 0,
    lastViewT: 0,
    events: [],
    pending: [],
    lastEventT: -1e9,
    held: false,
    round: null,
    repCount: 0,
    practiceStep: 0,
    lastResult: null,
    destroyed: false,
  };
  audio.setEnabled(state.sound);
  el.dataset.motion = state.reduced ? 'reduced' : 'full';
  $('[data-sound]').setAttribute('aria-pressed', String(state.sound));
  $('[data-motion]').setAttribute('aria-pressed', String(!state.reduced));

  // ---------------------------------------------------------------- WebGL
  if (!webglAvailable()) {
    showPanel(`
      <div class="eyebrow">Oversized Bench</div>
      <h2>3D understøttes ikke her</h2>
      <p>Din browser eller enhed har ikke WebGL slået til, som spillet kræver.</p>
      <p class="small">Prøv en nyere version af Safari, Chrome, Firefox eller Edge, eller slå hardwareacceleration til i browserens indstillinger.</p>
      <div class="row"><button class="btn primary" data-act="close">Luk</button></div>`);
    wire();
    return { destroy };
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch {
    showPanel(`<h2>3D kunne ikke starte</h2><p>Grafikkortet afviste at starte 3D. Luk andre faner og prøv igen.</p>
      <div class="row"><button class="btn primary" data-act="close">Luk</button></div>`);
    wire();
    return { destroy };
  }
  const forced = new URLSearchParams(location.search).get('osgQuality');
  let quality = ['low', 'medium', 'high'].includes(forced) ? makeQuality(forced) : detectQuality(renderer);
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = quality.shadows > 0;
  renderer.shadowMap.type = quality.shadowType === 'basic' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  el.prepend(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showPanel(`<h2>Grafikken gik i stå</h2><p>Browseren stoppede 3D-visningen. Luk og åbn spillet igen.</p>
      <div class="row"><button class="btn primary" data-act="close">Luk</button></div>`);
  });

  const world = createScene(renderer, quality);
  if (options.athleteModelUrl) {
    import('./glbAthlete.js')
      .then((m) => m.loadGlbAthlete({ url: options.athleteModelUrl }))
      .then((a) => world.replaceAthlete(a))
      .catch((err) => console.warn('[Oversized Bench] Rigged athlete could not be loaded; using the built-in one.', err));
  }
  const governor = frameGovernor(() => {
    if (quality.tier === 'low') return;
    quality = makeQuality(quality.tier === 'high' ? 'medium' : 'low');
    renderer.setPixelRatio(quality.pixelRatio);
    resize();
  });

  function resize() {
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    world.resize(w, h);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  // ---------------------------------------------------------------- input
  // One button. Times are ms since the round started and are exactly what the
  // server replays, so the local sim and the server always agree.
  function gameTime() {
    return Math.floor(performance.now() - state.t0);
  }

  function input(type) {
    if (!state.sim || (state.mode !== 'round' && state.mode !== 'practice')) return;
    let t = Math.max(gameTime(), state.lastViewT);
    if (type === DOWN) {
      if (t - state.lastEventT < LIMITS.minGapMs) return; // too fast after release: ignore the press
      state.held = true;
    } else {
      if (!state.held) return;
      state.held = false;
      // A release that follows the press too quickly is delayed to the minimum gap.
      if (t - state.lastEventT < LIMITS.minGapMs) t = state.lastEventT + LIMITS.minGapMs;
    }
    state.lastEventT = t;
    state.pending.push([t, type]);
    flush(Math.max(gameTime(), state.lastViewT));
  }

  function flush(now) {
    while (state.pending.length && state.pending[0][0] <= now) {
      const [t, type] = state.pending.shift();
      if (state.mode === 'round') {
        if (t > ROUND_MS) continue;
        state.events.push([t, type]);
      }
      const before = state.sim.view(t).phase;
      state.sim.push(type, t);
      onPhaseChange(before, state.sim.view(t));
    }
  }

  const holdDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    audio.unlock();
    hud.hold.classList.add('down');
    try {
      e.target.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    input(DOWN);
  };
  const holdUp = (e) => {
    e.preventDefault?.();
    hud.hold.classList.remove('down');
    input(UP);
  };
  for (const target of [hud.hold, $('.osg-stage')]) {
    target.addEventListener('pointerdown', holdDown);
    target.addEventListener('pointerup', holdUp);
    target.addEventListener('pointercancel', holdUp);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const typing = () => {
    const a = root.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  };
  const onKeyDown = (e) => {
    if (e.code !== 'Space' || typing()) return;
    if (state.mode !== 'round' && state.mode !== 'practice') return;
    e.preventDefault();
    if (e.repeat) return;
    hud.hold.classList.add('down');
    audio.unlock();
    input(DOWN);
  };
  const onKeyUp = (e) => {
    if (e.code !== 'Space' || typing()) return;
    if (state.mode !== 'round' && state.mode !== 'practice') return;
    e.preventDefault();
    hud.hold.classList.remove('down');
    input(UP);
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  const onBlur = () => {
    if (state.held) holdUp({});
  };
  window.addEventListener('blur', onBlur);

  // ---------------------------------------------------------------- feedback
  let fbTimer = 0;
  function feedback(text, sub, kind) {
    hud.fb.querySelector('.t').textContent = text;
    hud.fb.querySelector('.p').textContent = sub || '';
    hud.fb.className = `osg-feedback show ${kind || ''}`;
    clearTimeout(fbTimer);
    fbTimer = setTimeout(() => hud.fb.classList.remove('show'), 1400);
  }

  function onPhaseChange(before, view) {
    if (before === view.phase) return;
    const effort = view.strain;
    if (view.phase === 'lowering') audio.inhale(effort);
    if (view.phase === 'pressing') effort > 0.55 ? audio.grunt(effort) : audio.exhale(effort);
  }

  function onRep(rep) {
    const text = FEEDBACK[rep.feedback] || '';
    if (rep.ok) {
      feedback(text, `+${fmt(rep.points)} · ${rep.kg} kg`, 'good');
      audio.good();
    } else {
      feedback(text, 'Ingen point', 'bad');
      audio.bad();
    }
    if (state.mode === 'practice') practiceProgress(rep);
  }

  // ---------------------------------------------------------------- HUD
  const HINTS = {
    ready: 'Hold nede',
    lowering: 'Slip i grøn',
    pressing: 'Tryk i gul',
    recover: '',
    failed: 'Spotter',
    done: '',
  };
  function renderHud(view) {
    hud.kg.innerHTML = `${view.kg}<small>kg</small>`;
    hud.reps.textContent = view.approved;
    const s = Math.ceil(view.remainingMs / 1000);
    hud.time.textContent = state.mode === 'practice' ? 'Øv' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    hud.time.classList.toggle('low', state.mode === 'round' && s <= 10);
    hud.score.textContent = fmt(view.score);
    el.dataset.phase = view.phase;
    hud.hint.textContent = HINTS[view.phase] ?? '';
    const p = view.params;
    hud.touch.style.height = `${p.touchZone * 100}%`;
    const lo = Math.max(0, p.lockCenter - p.lockHalf);
    const hi = Math.min(1, p.lockCenter + p.lockHalf);
    hud.lock.style.bottom = `${lo * 100}%`;
    hud.lock.style.height = `${(hi - lo) * 100}%`;
    hud.lockLabel.style.bottom = `${p.lockCenter * 100}%`;
    hud.marker.style.bottom = `${view.pos * 100}%`;
  }
  function renderPb() {
    const pb = state.me?.player?.bestScore;
    hud.pb.textContent = pb ? fmt(pb) : '–';
  }

  // ---------------------------------------------------------------- loop
  let raf = 0;
  let last = performance.now();
  let breathPhase = 0;
  const clock0 = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (document.hidden) return;
    let view = null;
    if (state.sim && (state.mode === 'round' || state.mode === 'practice' || state.mode === 'submitting')) {
      let t = gameTime();
      if (state.mode === 'practice' && t > ROUND_MS - 5000) {
        // Practice never runs out: restart the practice sim quietly.
        startPracticeSim();
        t = 0;
      }
      if (state.mode === 'round') {
        flush(t);
        t = Math.min(t, ROUND_MS);
      } else if (state.mode === 'practice') flush(t);
      state.lastViewT = Math.max(state.lastViewT, t);
      view = state.sim.view(state.mode === 'submitting' ? ROUND_MS : t);
      if (view.repCount > state.repCount) {
        state.repCount = view.repCount;
        onRep(view.lastRep);
      }
      renderHud(view);
      if (state.mode === 'round' && t >= ROUND_MS) endRound();
    }
    const fatigue = view ? view.fatigue : 0;
    const rate = 0.22 + fatigue * 0.55 + (view && view.phase === 'pressing' ? 0.25 : 0);
    breathPhase += dt * rate * Math.PI * 2 * (state.reduced ? 0.6 : 1);
    world.update({ view, dt, time: (now - clock0) / 1000, reducedMotion: state.reduced, breath: Math.sin(breathPhase), kg: 60 });
    renderer.render(world.scene, world.camera);
    governor(dt);
  }
  raf = requestAnimationFrame(frame);

  // ---------------------------------------------------------------- panels
  function setMode(mode) {
    state.mode = mode;
    el.dataset.mode = mode === 'round' || mode === 'practice' || mode === 'countdown' || mode === 'submitting' ? 'play' : 'menu';
  }

  function showPanel(html, { bare = false } = {}) {
    panel.innerHTML = html;
    panel.hidden = false;
    panel.classList.toggle('bare', bare);
    wire();
    const first = panel.querySelector('[data-focus]') || panel.querySelector('button.primary');
    first?.focus({ preventScroll: true });
  }
  function hidePanel() {
    panel.hidden = true;
    panel.innerHTML = '';
  }

  function tiersHtml(highlight) {
    const c = state.me?.campaign;
    if (!c || !c.tiers?.length) return '';
    return `<div class="tiers">${c.tiers
      .map((t) => `<div class="tier ${highlight && highlight.percent === t.percent ? 'on' : ''}"><div class="pc">${t.percent} %</div><div class="pt">${fmt(t.minScore)} point</div></div>`)
      .join('')}</div>${c.demoTiers ? '<div class="small">Demoindstillinger – butikken fastsætter de endelige niveauer.</div>' : ''}`;
  }

  function campaignLine() {
    const c = state.me?.campaign;
    if (!c) return '';
    if (c.status === 'running') {
      const extra = [c.minimumSubtotal ? `min. køb ${c.minimumSubtotal} kr.` : null, c.limitedProducts ? 'gælder udvalgte varer' : null, `koden gælder ${c.codeValidDays} dage`].filter(Boolean).join(' · ');
      return `<h3>Spil dig til rabat</h3>${tiersHtml()}<p class="small">Én rabatkode pr. ${c.requireVerified ? 'bekræftet spiller' : 'spiller'} · ${extra}.</p>`;
    }
    if (c.status === 'upcoming') return `<p class="small">Kampagnen starter ${fmtDate(c.startsAt)}. Du kan godt træne allerede nu.</p>`;
    return '<p class="small">Der er ingen rabatkampagne lige nu – men rekorden tæller stadig.</p>';
  }

  const deviceNote = () =>
    `<div class="note">Din rekord gemmes på vores server og genkendes i <strong>denne browser</strong> via en nødvendig cookie. Den følger ikke automatisk med til andre enheder – knyt en e-mail under profil for at kunne hente den frem et andet sted.${
      state.cookieOk ? '' : '<br><br><strong>Din browser blokerer cookien</strong>, så rekorden gælder kun dette besøg.'
    }</div>`;

  function showWelcome() {
    state.view = 'welcome';
    setMode('menu');
    banner.hidden = true;
    world.setRacked(true);
    const p = state.me?.player;
    showPanel(`
      <div class="eyebrow">Oversized Studios præsenterer</div>
      <h2>Oversized Bench</h2>
      <p>45 sekunder under stangen. Sænk kontrolleret, pres eksplosivt, lås ud med god teknik. Vægten stiger – det gør trætheden også.</p>
      ${p && p.roundsPlayed ? `<p><span class="badge">Velkommen tilbage${p.alias ? `, ${esc(p.alias)}` : ''}</span> Din rekord: <strong>${fmt(p.bestScore)}</strong></p>` : ''}
      ${campaignLine()}
      ${p ? rewardHtml(state.me.eligibility) : ''}
      <div class="row">
        <button class="btn primary" data-act="start" data-focus>Start runde</button>
        <button class="btn" data-act="intro">Sådan spiller du</button>
      </div>
      <div class="row" style="margin-top:10px">
        ${state.me?.campaign?.leaderboardEnabled ? '<button class="link" data-act="leaderboard">Leaderboard</button>' : ''}
        <button class="link" data-act="profile">Profil &amp; gem rekord</button>
      </div>
      ${state.me?.demoMode ? '<div class="note demo">DEMOTILSTAND – ingen forbindelse til en rigtig butik. Rabatkoder er demokoder og virker ikke i kassen.</div>' : ''}
      ${deviceNote()}
    `);
  }

  // ---------------------------------------------------------------- practice / intro
  const PRACTICE_STEPS = [
    ['1/3 · Sænk', 'Hold <strong>mellemrum</strong> eller knappen nede. Stangen sænkes roligt mod brystet.'],
    ['2/3 · Pres', 'Slip, når markøren til højre er i den <strong style="color:var(--touch)">grønne zone</strong> – stangen rører brystet, og du presser.'],
    ['3/3 · Lockout', 'Tryk igen, når markøren passerer den <strong style="color:var(--lock)">gule zone</strong>. Det låser løftet ud med god teknik.'],
  ];

  function startPracticeSim() {
    state.sim = createSim(424242);
    state.t0 = performance.now();
    state.lastViewT = 0;
    state.lastEventT = -1e9;
    state.pending = [];
    state.repCount = 0;
    state.held = false;
    hud.hold.classList.remove('down');
  }

  function showBanner(step, html, buttons = '') {
    banner.innerHTML = `<div class="step">${step}</div><div>${html}</div>${buttons ? `<div class="row">${buttons}</div>` : ''}`;
    banner.hidden = false;
    banner.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', onAction));
  }

  function startPractice() {
    hidePanel();
    setMode('practice');
    world.setRacked(false);
    startPracticeSim();
    state.practiceStep = 0;
    showBanner(...PRACTICE_STEPS[0], '<button class="btn" data-act="skip-intro">Spring over</button>');
    practiceWatch();
  }

  function practiceWatch() {
    if (state.mode !== 'practice') return;
    const v = state.sim.view(Math.max(gameTime(), state.lastViewT));
    if (state.practiceStep === 0 && v.phase === 'lowering') setStep(1);
    else if (state.practiceStep === 1 && v.phase === 'pressing') setStep(2);
    setTimeout(practiceWatch, 50);
  }
  function setStep(i) {
    state.practiceStep = i;
    showBanner(...PRACTICE_STEPS[i], '<button class="btn" data-act="skip-intro">Spring over</button>');
  }
  function practiceProgress(rep) {
    if (rep.ok) {
      state.practiceStep = 3;
      showBanner(
        'Klar',
        `${esc(FEEDBACK[rep.feedback])}! I en rigtig runde stiger vægten efter gode løft, og trætheden gør zonerne mindre og løftet tungere.`,
        '<button class="btn" data-act="practice-again">Øv mere</button><button class="btn primary" data-act="start">Start runde</button>',
      );
    } else {
      setTimeout(() => {
        if (state.mode === 'practice' && state.practiceStep !== 3) setStep(0);
      }, 900);
    }
  }

  // ---------------------------------------------------------------- round
  async function startRound() {
    banner.hidden = true;
    audio.unlock();
    showPanel('<div class="loading"><div class="spinner"></div><div>Gør stangen klar…</div></div>');
    let round;
    try {
      if (!state.me?.player) {
        const s = await api.ensureSession();
        state.me = s;
        state.cookieOk = s.cookieOk;
        renderPb();
      }
      round = await api.startRound();
    } catch (err) {
      showPanel(`<h2>Kunne ikke starte</h2><p>${esc(err.message)}</p>
        <p class="small">Du kan stadig øve dig – øverunder tæller bare ikke.</p>
        <div class="row"><button class="btn primary" data-act="start">Prøv igen</button><button class="btn" data-act="intro">Øv</button></div>`);
      return;
    }
    if (round.rulesVersion !== RULES_VERSION) {
      showPanel('<h2>Ny version</h2><p>Spillet er opdateret. Genindlæs siden for at spille.</p>');
      return;
    }
    state.round = round;
    state.sim = createSim(round.seed);
    state.events = [];
    state.pending = [];
    state.repCount = 0;
    state.lastEventT = -1e9;
    state.lastViewT = 0;
    state.held = false;
    hud.hold.classList.remove('down');
    setMode('countdown');
    world.setRacked(false); // unrack during the countdown
    renderHud(state.sim.view(0));
    for (const n of [3, 2, 1]) {
      showPanel(`<div class="countdown">${n}</div>`, { bare: true });
      audio.tick();
      await new Promise((r) => setTimeout(r, 700));
      if (state.destroyed || state.mode !== 'countdown') return;
    }
    hidePanel();
    state.t0 = performance.now();
    setMode('round');
    feedback('Kør!', 'Hold for at sænke', 'good');
  }

  async function endRound() {
    if (state.mode !== 'round') return;
    setMode('submitting');
    state.held = false;
    hud.hold.classList.remove('down');
    const local = state.sim.finish();
    world.setRacked(true);
    setTimeout(() => audio.clank(), 700);
    audio.end();
    showPanel(`<div class="loading"><div class="spinner"></div><div>Serveren genberegner din runde…</div></div>
      <p class="small">Lokal score: ${fmt(local.score)} (ikke verificeret)</p>`);
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await api.submitRound(state.round.roundId, state.events, RULES_VERSION);
        break;
      } catch (err) {
        if (err.status && err.status < 500) {
          showPanel(`<h2>Runden blev ikke godkendt</h2><p>${esc(err.message)}${err.data?.details?.reason ? ` (${esc(err.data.details.reason)})` : ''}</p>
            <div class="row"><button class="btn primary" data-act="start">Spil igen</button><button class="btn" data-act="menu">Menu</button></div>`);
          setMode('result');
          return;
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (!res) {
      showPanel(`<h2>Ingen forbindelse</h2><p>Vi kunne ikke sende runden til serveren. Din lokale score var ${fmt(local.score)}, men kun verificerede runder tæller.</p>
        <div class="row"><button class="btn primary" data-act="start">Spil igen</button></div>`);
      setMode('result');
      return;
    }
    state.lastResult = res;
    try {
      state.me = await api.me();
      renderPb();
    } catch {
      /* keep old */
    }
    setMode('result');
    showResult();
  }

  function rewardHtml(elig) {
    const c = state.me?.campaign;
    if (!elig || !c || c.status !== 'running') return '';
    const r = elig.reward;
    if (r && r.code) {
      return `<h3>Din rabatkode</h3>
        ${r.demo ? '<div class="note demo"><strong>DEMOKODE</strong> – dette er en demo uden butik. Koden virker ikke i kassen.</div>' : ''}
        <div class="code ${r.demo ? 'demo-code' : ''}"><span>${esc(r.code)}</span><button class="btn" style="flex:0 0 auto;min-height:34px" data-act="copy" data-code="${esc(r.code)}">Kopiér</button></div>
        <p class="small">${r.percent} % rabat · kan bruges én gang · udløber ${fmtDate(r.endsAt)}${c.minimumSubtotal ? ` · min. køb ${esc(c.minimumSubtotal)} kr.` : ''}${c.limitedProducts ? ' · gælder udvalgte varer' : ''}.</p>`;
    }
    if (r && r.status !== 'issued') {
      return `<h3>Din rabat</h3><p>Vi opretter din kode… </p><div class="row"><button class="btn" data-act="claim">Prøv igen</button></div>`;
    }
    if (elig.tier) {
      if (elig.needsVerification) {
        return `<h3>Du har låst ${elig.tier.percent} % op</h3>
          <p>For at give én rabat pr. person skal vi vide, at det er dig. Bekræft din e-mail – så kan du også hente din rekord på andre enheder.</p>
          ${verifyHtml()}`;
      }
      return `<h3>Du har låst ${elig.tier.percent} % op</h3>
        <p class="small">Du kan hente én kode i kampagnen. Henter du nu, låses niveauet fast${elig.nextTier ? ` – ${fmt(elig.nextTier.minScore)} point giver ${elig.nextTier.percent} %` : ''}.</p>
        <div class="row"><button class="btn primary" data-act="claim">Hent ${elig.tier.percent} % rabatkode</button></div>`;
    }
    if (elig.nextTier) return `<p class="small">${fmt(elig.nextTier.minScore - elig.bestCampaignScore)} point mere til ${elig.nextTier.percent} % rabat.</p>`;
    return '';
  }

  function verifyHtml() {
    const canCustomer = Boolean(options.proxyBase && options.customerLoggedIn);
    return `
      ${canCustomer ? '<div class="row"><button class="btn primary" data-act="link-customer">Brug min kundekonto</button></div><p class="small" style="text-align:center">eller</p>' : ''}
      ${state.me?.emailLinking ? `<form data-form="email">
        <label class="field">E-mail<input type="email" name="email" autocomplete="email" required placeholder="dig@eksempel.dk"></label>
        <button class="btn ${canCustomer ? '' : 'primary'}" type="submit" style="width:100%">Send engangslink</button>
        <div class="msg" data-msg></div>
      </form>
      <p class="small">Vi sender et link, der virker én gang i 20 minutter. Åbn det i den browser, hvor du vil spille – det er den browser, der bliver genkendt. E-mailen bruges kun til at genkende dig, ikke til nyhedsbreve, medmindre du selv vælger det.</p>` : '<p class="small">E-mail-bekræftelse er ikke sat op i denne butik endnu.</p>'}`;
  }

  function showResult() {
    state.view = 'result';
    const r = state.lastResult;
    const elig = r.eligibility;
    showPanel(`
      <div class="eyebrow">Verificeret af serveren</div>
      <div class="bigscore">${fmt(r.score)}</div>
      <div>${r.newRecord ? '<span class="badge hot">Ny rekord</span>' : `<span class="badge">Rekord ${fmt(r.personalBest)}</span>`}
        ${r.countsForCampaign ? '' : ' <span class="badge">Tæller ikke i kampagnen</span>'}</div>
      <div class="grid">
        <div class="cell"><div class="k">Godkendte</div><div class="v">${r.approvedReps}</div></div>
        <div class="cell"><div class="k">Rene</div><div class="v">${r.cleanReps}</div></div>
        <div class="cell"><div class="k">Tungeste løft</div><div class="v">${r.topKg || 0} kg</div></div>
        <div class="cell"><div class="k">Teknik</div><div class="v">${Math.round((r.avgQuality || 0) * 100)} %</div></div>
      </div>
      ${rewardHtml(elig)}
      <div class="row">
        <button class="btn primary" data-act="start" data-focus>Spil igen</button>
        ${state.me?.campaign?.leaderboardEnabled ? '<button class="btn" data-act="leaderboard">Leaderboard</button>' : ''}
      </div>
      <div class="row" style="margin-top:10px"><button class="link" data-act="profile">Profil &amp; gem rekord</button><button class="link" data-act="menu">Menu</button></div>
    `);
  }

  // ---------------------------------------------------------------- profile
  function showProfile(msg = '') {
    state.view = 'profile';
    setMode('menu');
    banner.hidden = true;
    const p = state.me?.player;
    const lbOn = state.me?.campaign?.leaderboardEnabled;
    if (!p) {
      showPanel(`<div class="eyebrow">Profil</div><h2>Ingen profil endnu</h2>
        <p>Din anonyme profil oprettes, første gang du spiller en runde. Du behøver ikke oprette en konto.</p>
        ${deviceNote()}
        <div class="row"><button class="btn primary" data-act="start">Start runde</button><button class="btn" data-act="menu">Tilbage</button></div>`);
      return;
    }
    showPanel(`
      <div class="eyebrow">Profil</div>
      <h2>${p.alias ? esc(p.alias) : 'Anonym løfter'}</h2>
      <p class="small">Rekord ${fmt(p.bestScore)} · ${p.roundsPlayed} runder · genkendt i denne browser</p>
      ${msg ? `<div class="note warn">${msg}</div>` : ''}
      ${p.verified ? rewardHtml(state.me.eligibility) : ''}
      ${lbOn ? `<h3>Leaderboard</h3>
      <form data-form="alias">
        <label class="field">Alias (vises offentligt – brug ikke dit navn, hvis du ikke vil)<input type="text" name="alias" maxlength="16" value="${esc(p.alias || '')}" placeholder="fx BænkBjørn"></label>
        <label class="check"><input type="checkbox" name="optin" ${p.leaderboardOptIn ? 'checked' : ''}> Vis mit alias og min rekord på leaderboardet</label>
        <button class="btn" type="submit">Gem</button><div class="msg" data-msg></div>
      </form>` : ''}
      <h3>Gem rekorden på tværs af enheder</h3>
      ${p.verified ? `<p>Knyttet til ${p.email ? esc(p.email) : ''}${p.email && p.shopifyCustomer ? ' og ' : ''}${p.shopifyCustomer ? 'din kundekonto' : ''}. Åbn spillet på en anden enhed og bekræft samme e-mail for at hente rekorden.</p>
        ${p.email ? `<label class="check"><input type="checkbox" data-marketing ${p.marketingOptIn ? 'checked' : ''}> Ja tak til nyheder og tilbud fra Oversized Studios på e-mail (valgfrit, kan altid afmeldes)</label>` : ''}` : verifyHtml()}
      ${deviceNote()}
      <p class="small">Vi bruger kun én nødvendig cookie til at genkende din browser. Ingen tracking, ingen fingerprinting.</p>
      <div class="row"><button class="btn primary" data-act="menu">Tilbage</button><button class="btn" data-act="logout">Glem denne enhed</button></div>
    `);
  }

  async function showLeaderboard() {
    state.view = 'leaderboard';
    setMode('menu');
    banner.hidden = true;
    showPanel('<div class="loading"><div class="spinner"></div><div>Henter leaderboard…</div></div>');
    try {
      const lb = await api.leaderboard();
      if (!lb.enabled) {
        showPanel('<h2>Leaderboard</h2><p>Leaderboardet er slået fra lige nu.</p><div class="row"><button class="btn primary" data-act="menu">Tilbage</button></div>');
        return;
      }
      showPanel(`<div class="eyebrow">Top 20</div><h2>Leaderboard</h2>
        ${lb.entries.length ? `<ol class="lb">${lb.entries.map((e) => `<li class="${e.you ? 'you' : ''}"><span class="n">${e.rank}</span><span class="a">${esc(e.alias)}${e.you ? ' (dig)' : ''}</span><span>${fmt(e.score)}</span></li>`).join('')}</ol>` : '<p>Ingen på tavlen endnu. Bliv den første!</p>'}
        <p class="small">Kun selvvalgte aliasser vises. Vil du med, så vælg et alias under profil.</p>
        <div class="row"><button class="btn primary" data-act="menu">Tilbage</button><button class="btn" data-act="profile">Profil</button></div>`);
    } catch (err) {
      showPanel(`<h2>Leaderboard</h2><p>${esc(err.message)}</p><div class="row"><button class="btn primary" data-act="menu">Tilbage</button></div>`);
    }
  }

  // ---------------------------------------------------------------- actions
  function wire() {
    panel.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', onAction));
    panel.querySelector('[data-form="email"]')?.addEventListener('submit', onEmail);
    panel.querySelector('[data-form="alias"]')?.addEventListener('submit', onAlias);
    panel.querySelector('[data-marketing]')?.addEventListener('change', async (e) => {
      try {
        state.me = await api.updateProfile({ marketingOptIn: e.target.checked });
      } catch (err) {
        e.target.checked = !e.target.checked;
        alert(err.message);
      }
    });
  }

  async function onEmail(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const msg = form.querySelector('[data-msg]');
    const email = form.email.value.trim();
    msg.textContent = 'Sender…';
    try {
      if (!state.me?.player) state.me = await api.ensureSession();
      const r = await api.emailLink(email);
      msg.innerHTML = esc(r.message);
      if (r.demoLink) {
        msg.innerHTML += `<div class="note demo" style="margin-top:8px">${esc(r.demoNotice)}<br><a href="${esc(r.demoLink)}" target="_blank" rel="noopener" style="color:inherit;word-break:break-all">${esc(r.demoLink)}</a></div>`;
      }
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  async function onAlias(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const msg = form.querySelector('[data-msg]');
    try {
      state.me = await api.updateProfile({ alias: form.alias.value.trim() || null, leaderboardOptIn: form.optin.checked });
      msg.textContent = 'Gemt';
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  async function onAction(e) {
    const act = e.currentTarget.dataset.act;
    audio.unlock();
    switch (act) {
      case 'start':
        return startRound();
      case 'intro':
      case 'practice-again':
        return startPractice();
      case 'skip-intro':
        banner.hidden = true;
        return showWelcome();
      case 'menu':
        return showWelcome();
      case 'profile':
        return showProfile();
      case 'leaderboard':
        return showLeaderboard();
      case 'close':
        return close();
      case 'copy': {
        const code = e.currentTarget.dataset.code;
        try {
          await navigator.clipboard.writeText(code);
          e.currentTarget.textContent = 'Kopieret';
        } catch {
          e.currentTarget.textContent = 'Markér og kopiér';
        }
        return;
      }
      case 'claim': {
        e.currentTarget.disabled = true;
        try {
          await api.claim();
        } catch (err) {
          alert(err.message);
        }
        state.me = await api.me();
        if (state.lastResult) state.lastResult.eligibility = state.me.eligibility;
        return state.lastResult ? showResult() : showProfile();
      }
      case 'link-customer': {
        try {
          if (!state.me?.player) state.me = await api.ensureSession();
          const r = await api.linkCustomer();
          if (r && r.loggedIn === false) return showProfile('Du er ikke logget ind i butikken. Log ind og prøv igen.');
          state.me = await api.me();
          if (state.lastResult) state.lastResult.eligibility = state.me.eligibility;
          return state.lastResult && state.mode === 'result' ? showResult() : showProfile('Din profil er nu knyttet til din kundekonto.');
        } catch (err) {
          return showProfile(esc(err.message));
        }
      }
      case 'logout':
        if (!confirm('Glem denne enhed? Din rekord bliver på serveren, men denne browser genkender dig ikke længere, medmindre du har knyttet en e-mail.')) return;
        await api.logout().catch(() => {});
        state.me = await api.me();
        renderPb();
        return showWelcome();
      default:
    }
  }

  // Coming back from the e-mail confirmation tab: pick up the new state.
  let refreshing = false;
  async function refreshMe() {
    if (refreshing || state.mode !== 'menu' && state.mode !== 'result') return;
    refreshing = true;
    try {
      const me = await api.me();
      const changed = JSON.stringify(me.player) !== JSON.stringify(state.me?.player) || JSON.stringify(me.eligibility) !== JSON.stringify(state.me?.eligibility);
      // Becoming verified (or getting a code) always re-renders; smaller changes wait until the player is not typing.
      const important = Boolean(me.player?.verified) !== Boolean(state.me?.player?.verified) || JSON.stringify(me.eligibility?.reward) !== JSON.stringify(state.me?.eligibility?.reward);
      state.me = me;
      renderPb();
      if (state.lastResult) state.lastResult.eligibility = me.eligibility;
      if (important || (changed && !typing())) {
        if (state.view === 'result' && state.lastResult) showResult();
        else if (state.view === 'profile') showProfile();
        else if (state.view === 'welcome') showWelcome();
      }
    } catch {
      /* offline: keep what we have */
    } finally {
      refreshing = false;
    }
  }
  const onVisible = () => {
    if (!document.hidden) refreshMe();
  };
  window.addEventListener('focus', refreshMe);
  document.addEventListener('visibilitychange', onVisible);

  $('[data-close]').addEventListener('click', close);
  $('[data-profile]').addEventListener('click', () => {
    if (state.mode === 'round' || state.mode === 'countdown') return;
    showProfile();
  });
  $('[data-sound]').addEventListener('click', (e) => {
    state.sound = !state.sound;
    setPref('sound', state.sound);
    audio.setEnabled(state.sound);
    e.currentTarget.setAttribute('aria-pressed', String(state.sound));
  });
  $('[data-motion]').addEventListener('click', (e) => {
    state.reduced = !state.reduced;
    setPref('reduced', state.reduced);
    el.dataset.motion = state.reduced ? 'reduced' : 'full';
    e.currentTarget.setAttribute('aria-pressed', String(!state.reduced));
    feedback(state.reduced ? 'Reduceret bevægelse' : 'Fuld bevægelse', '', '');
  });

  function close() {
    if (state.mode === 'round' && !confirm('Afslut runden? Den tæller ikke.')) return;
    destroy();
    options.onClose?.();
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', refreshMe);
    document.removeEventListener('visibilitychange', onVisible);
    renderer?.dispose();
    renderer?.forceContextLoss?.();
    host.remove();
  }

  // ---------------------------------------------------------------- boot
  showPanel('<div class="loading"><div class="spinner"></div><div>Tænder lyset i træningslokalet…</div></div>');
  api
    .me()
    .then((me) => {
      state.me = me;
      renderPb();
    })
    .catch(() => {
      state.me = null;
    })
    .finally(() => {
      if (!state.destroyed) showWelcome();
    });

  // Test hook (used by the automated visual check only).
  host.__osg = { state, world, input: (t) => input(t), refreshMe };
  return { destroy };
}
