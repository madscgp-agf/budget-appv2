// Procedural textures drawn on canvases at start-up. No image files, so
// there is nothing to license and nothing extra to download.
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

// Small deterministic PRNG so textures look the same on every load.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseFill(ctx, w, h, base, spread, count, seed, sizeMax = 2) {
  const r = rng(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const v = Math.floor(r() * spread);
    const a = 0.08 + r() * 0.25;
    ctx.fillStyle = r() > 0.5 ? `rgba(255,255,255,${a * 0.35})` : `rgba(0,0,0,${a})`;
    const s = 0.5 + r() * sizeMax;
    ctx.fillRect(r() * w, r() * h, s + v * 0, s);
  }
}

function tex(c, { repeat = [1, 1], srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Rubber gym tiles: 1 m squares with seams and speckle. */
export function rubberFloor(size = 512) {
  const [c, ctx] = canvas(size, size);
  noiseFill(ctx, size, size, '#1a1b1d', 1, size * 40, 11, 1.6);
  // coloured EPDM flecks, muted
  const r = rng(12);
  for (let i = 0; i < size * 6; i++) {
    ctx.fillStyle = r() > 0.5 ? 'rgba(90,90,95,0.35)' : 'rgba(60,62,66,0.35)';
    ctx.fillRect(r() * size, r() * size, 1.5, 1.5);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
  const [rc, rctx] = canvas(size, size);
  noiseFill(rctx, size, size, '#d8d8d8', 1, size * 50, 13, 1.4);
  rctx.strokeStyle = '#ffffff';
  rctx.lineWidth = 4;
  rctx.strokeRect(2, 2, size - 4, size - 4);
  return { map: tex(c, { repeat: [24, 24] }), roughnessMap: tex(rc, { repeat: [24, 24], srgb: false }) };
}

/** Raw concrete wall with form-tie holes and stains. */
export function concrete(size = 512) {
  const [c, ctx] = canvas(size, size);
  noiseFill(ctx, size, size, '#3a3a3a', 1, size * 60, 21, 2.2);
  const r = rng(22);
  for (let i = 0; i < 14; i++) {
    const g = ctx.createRadialGradient(r() * size, r() * size, 0, r() * size, r() * size, 40 + r() * 120);
    g.addColorStop(0, 'rgba(0,0,0,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (const [x, y] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    ctx.beginPath();
    ctx.arc(x * size, y * size, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  return tex(c, { repeat: [4, 2] });
}

/** Knurled steel for the bar grip. */
export function knurl() {
  const [c, ctx] = canvas(256, 64);
  ctx.fillStyle = '#9a9ea3';
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = 'rgba(40,40,45,0.7)';
  ctx.lineWidth = 1;
  for (let i = -64; i < 256 + 64; i += 4) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 64, 64);
    ctx.moveTo(i + 64, 0);
    ctx.lineTo(i, 64);
    ctx.stroke();
  }
  const t = tex(c, { repeat: [14, 1] });
  return t;
}

/** Soft cotton weave for the oversized tee and joggers (used as bump). */
export function fabric(seed = 31) {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 256, 256);
  const r = rng(seed);
  for (let y = 0; y < 256; y += 2) {
    ctx.fillStyle = `rgba(0,0,0,${0.05 + r() * 0.08})`;
    ctx.fillRect(0, y, 256, 1);
  }
  for (let x = 0; x < 256; x += 2) {
    ctx.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.05})`;
    ctx.fillRect(x, 0, 1, 256);
  }
  return tex(c, { repeat: [6, 6], srgb: false });
}

/** Tee colour map with a small tonal chest print. */
export function teePrint(transparent = false) {
  const [c, ctx] = canvas(512, 512);
  if (!transparent) {
    ctx.fillStyle = '#26272a';
    ctx.fillRect(0, 0, 512, 512);
  }
  ctx.save();
  ctx.translate(256, transparent ? 256 : 170);
  ctx.fillStyle = 'rgba(210,210,205,0.78)';
  ctx.font = '700 38px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
  ctx.fillText('OVERSIZED', 0, 0);
  ctx.font = '500 14px "Helvetica Neue", Arial, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '5px';
  ctx.fillStyle = 'rgba(180,180,175,0.55)';
  ctx.fillText('STUDIOS — HEAVY COTTON', 0, 34);
  ctx.restore();
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Back-lit brand sign on the wall. */
export function brandSign() {
  const [c, ctx] = canvas(1024, 256);
  ctx.clearRect(0, 0, 1024, 256);
  ctx.fillStyle = '#e9e6df';
  ctx.font = '800 150px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '22px';
  ctx.fillText('OVERSIZED', 512, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Numbers and ribs for plate faces. */
export function plateFace(label, rubber) {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = rubber ? '#141414' : '#7c7f84';
  ctx.fillRect(0, 0, 256, 256);
  ctx.translate(128, 128);
  ctx.strokeStyle = rubber ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 3;
  for (const rad of [118, 96, 44]) {
    ctx.beginPath();
    ctx.arc(0, 0, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = rubber ? 'rgba(220,220,220,0.55)' : 'rgba(30,30,30,0.6)';
  ctx.font = '700 26px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, -70);
  ctx.rotate(Math.PI);
  ctx.font = '600 13px "Helvetica Neue", Arial, sans-serif';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
  ctx.fillText('OVERSIZED', 0, -70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Perforated upright (the rack's hole pattern). */
export function uprightHoles() {
  const [c, ctx] = canvas(64, 512);
  ctx.fillStyle = '#1b1c1e';
  ctx.fillRect(0, 0, 64, 512);
  ctx.fillStyle = '#050505';
  for (let y = 16; y < 512; y += 32) {
    ctx.beginPath();
    ctx.arc(32, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = tex(c, { repeat: [1, 1] });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** A soft radial sprite used for light pools and dust. */
export function radial(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
