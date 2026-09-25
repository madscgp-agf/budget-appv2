// Picks a graphics tier from what the device reports, and steps down at
// runtime if frames are slow.
export function detectQuality(renderer) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 820;
  const mem = nav.deviceMemory || 8;
  const cores = nav.hardwareConcurrency || 8;
  const gl = renderer.getContext();
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let tier = 'high';
  if (coarse && small) tier = 'medium';
  if (mem <= 3 || cores <= 4 || maxTex < 4096) tier = 'low';
  return makeQuality(tier);
}

export function makeQuality(tier) {
  const dpr = window.devicePixelRatio || 1;
  switch (tier) {
    case 'low':
      return { tier, pixelRatio: Math.min(dpr, 1), shadows: 512, detail: 0.4, shadowType: 'pcf' };
    case 'medium':
      return { tier, pixelRatio: Math.min(dpr, 1.5), shadows: 1024, detail: 0.7, shadowType: 'pcf' };
    default:
      return { tier, pixelRatio: Math.min(dpr, 2), shadows: 2048, detail: 1, shadowType: 'pcfsoft' };
  }
}

/** Watches frame times; calls onDowngrade once per step when sustained < ~45 fps. */
export function frameGovernor(onDowngrade) {
  let acc = 0;
  let frames = 0;
  let slow = 0;
  return (dt) => {
    acc += dt;
    frames++;
    if (acc >= 1) {
      const fps = frames / acc;
      slow = fps < 45 ? slow + 1 : 0;
      if (slow >= 3) {
        slow = 0;
        onDowngrade(fps);
      }
      acc = 0;
      frames = 0;
    }
  };
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}
