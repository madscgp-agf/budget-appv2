// The gym, the equipment and the camera. Rendering only: every number that
// matters for scoring comes from shared/rules.js through the view object.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createAthlete, PAD_Y } from './athlete.js';
import { brandSign, concrete, knurl, plateFace, radial, rubberFloor, uprightHoles } from './textures.js';

// Bar path (bar centre). The bar touches the lower chest and locks out over
// the shoulders, travelling in the slight J-curve of a real bench press.
export const BAR = {
  chest: new THREE.Vector3(-0.2, 0.755, 0),
  lockout: new THREE.Vector3(-0.35, 1.19, 0),
  hooks: new THREE.Vector3(-0.6, 1.105, 0),
};
const SHAFT_R = 0.014;
const SLEEVE_START = 0.66;
const SLEEVE_END = 1.1;
const RACK_Z = 0.58;
const RACK_X = -0.84;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (t) => t * t * (3 - 2 * t);

function plateProfile(r, thick, rubber) {
  // Lathe profile: hub, recessed face, raised rim.
  const hub = 0.026;
  const pts = rubber
    ? [
        [hub, -thick / 2],
        [r * 0.92, -thick / 2],
        [r, -thick / 2 + 0.004],
        [r, thick / 2 - 0.004],
        [r * 0.92, thick / 2],
        [hub, thick / 2],
      ]
    : [
        [hub, -thick * 0.5],
        [hub + 0.02, -thick * 0.5],
        [hub + 0.022, -thick * 0.25],
        [r * 0.86, -thick * 0.25],
        [r * 0.88, -thick * 0.5],
        [r, -thick * 0.5],
        [r, thick * 0.5],
        [r * 0.88, thick * 0.5],
        [r * 0.86, thick * 0.25],
        [hub + 0.022, thick * 0.25],
        [hub + 0.02, thick * 0.5],
        [hub, thick * 0.5],
      ];
  return pts.map(([x, y]) => new THREE.Vector2(x, y));
}

const PLATE_SPECS = [
  { kg: 25, r: 0.225, t: 0.055, rubber: true },
  { kg: 20, r: 0.225, t: 0.045, rubber: true },
  { kg: 15, r: 0.225, t: 0.036, rubber: true },
  { kg: 10, r: 0.225, t: 0.03, rubber: true },
  { kg: 5, r: 0.115, t: 0.022, rubber: false },
  { kg: 2.5, r: 0.095, t: 0.017, rubber: false },
  { kg: 1.25, r: 0.08, t: 0.013, rubber: false },
];

export function platesPerSide(totalKg) {
  let side = Math.max(0, (totalKg - 20) / 2);
  const out = [];
  for (const p of PLATE_SPECS) {
    while (side >= p.kg - 1e-6) {
      out.push(p);
      side -= p.kg;
    }
  }
  return out;
}

export function createScene(renderer, quality) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x09090a);
  scene.fog = new THREE.FogExp2(0x09090a, 0.085);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;
  pmrem.dispose();

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const castAll = (o) => {
    o.traverse((m) => {
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return o;
  };

  // ---------------------------------------------------------------- room
  const floorTex = rubberFloor();
  floorTex.map.anisotropy = aniso;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ map: floorTex.map, roughnessMap: floorTex.roughnessMap, roughness: 0.95, color: 0xffffff }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Lifting platform: slightly raised dark rubber with a steel edge.
  const platform = new THREE.Mesh(
    new RoundedBoxGeometry(2.6, 0.02, 2.2, 2, 0.006),
    new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.92 }),
  );
  platform.position.set(-0.05, 0.01, 0);
  platform.receiveShadow = true;
  scene.add(platform);
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(2.64, 0.022, 2.24),
    new THREE.MeshStandardMaterial({ color: 0x3b3d40, metalness: 0.9, roughness: 0.4 }),
  );
  edge.position.copy(platform.position).add(new THREE.Vector3(0, -0.002, 0));
  scene.add(edge);

  const wallTex = concrete();
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.96, color: 0x9a9a9a });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), wallMat);
  back.position.set(-3.6, 2.5, 0);
  back.rotation.y = Math.PI / 2;
  back.receiveShadow = true;
  scene.add(back);
  const side = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), wallMat);
  side.position.set(0, 2.5, -3.4);
  side.receiveShadow = true;
  scene.add(side);

  // Brand sign, softly back-lit.
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.375),
    new THREE.MeshStandardMaterial({ map: brandSign(), transparent: true, emissive: 0xffffff, emissiveMap: brandSign(), emissiveIntensity: 0.22, roughness: 0.6 }),
  );
  sign.position.set(-1.6, 2.1, -3.37);
  scene.add(sign);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial('rgba(255,244,230,0.18)'), depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.set(2.6, 1.0, 1);
  glow.position.set(-1.6, 2.1, -3.3);
  scene.add(glow);

  // LED strips on the side wall.
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xdfe6f0, emissiveIntensity: 0.7 });
  for (const x of [-3.1, 1.6, 3.4]) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.035, 3.2, 0.02), ledMat);
    led.position.set(x, 1.9, -3.38);
    scene.add(led);
  }

  // Dumbbell rack in the background (instanced).
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, metalness: 0.8, roughness: 0.45 });
    const rack = castAll(new THREE.Group());
    const rail = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.05, 0.4), steel);
    for (const y of [0.55, 0.95]) {
      const r = rail.clone();
      r.position.set(0, y, 0);
      rack.add(r);
    }
    for (const x of [-1.55, 1.55]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.4), steel);
      leg.position.set(x, 0.5, 0);
      rack.add(leg);
    }
    const headGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.07, 6);
    const rubberMat = new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.8 });
    const n = 20;
    const heads = new THREE.InstancedMesh(headGeo, rubberMat, n * 2);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
    let k = 0;
    for (let i = 0; i < n; i++) {
      const row = i < 10 ? 0 : 1;
      const x = -1.4 + (i % 10) * 0.31;
      const y = row ? 1.05 : 0.65;
      const s = 0.75 + (i % 10) * 0.05;
      for (const dz of [-0.11, 0.11]) {
        m.compose(new THREE.Vector3(x, y, dz), q, new THREE.Vector3(s, 1, s));
        heads.setMatrixAt(k++, m);
      }
    }
    heads.castShadow = true;
    rack.add(heads);
    rack.rotation.y = Math.PI / 2;
    rack.position.set(-3.2, 0, -1.2);
    scene.add(rack);
  }

  // ---------------------------------------------------------------- bench
  const powder = new THREE.MeshStandardMaterial({ color: 0x151618, metalness: 0.55, roughness: 0.5 });
  const padMat = new THREE.MeshPhysicalMaterial({ color: 0x0c0c0d, roughness: 0.42, clearcoat: 0.25, clearcoatRoughness: 0.6 });
  const bench = castAll(new THREE.Group());
  const pad = new THREE.Mesh(new RoundedBoxGeometry(1.26, 0.075, 0.3, 4, 0.03), padMat);
  pad.position.set(-0.12, PAD_Y - 0.0375, 0);
  bench.add(pad);
  const padBase = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.26), powder);
  padBase.position.set(-0.1, PAD_Y - 0.085, 0);
  bench.add(padBase);
  const railB = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.06, 0.08), powder);
  railB.position.set(-0.1, PAD_Y - 0.13, 0);
  bench.add(railB);
  for (const x of [-0.58, 0.38]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, PAD_Y - 0.13, 0.07), powder);
    post.position.set(x, (PAD_Y - 0.13) / 2, 0);
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.05, 0.5, 2, 0.01), powder);
    foot.position.set(x, 0.045, 0);
    bench.add(post, foot);
    for (const z of [-0.25, 0.25]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.03, 0.022, 12), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 }));
      cap.position.set(x, 0.011, z);
      bench.add(cap);
    }
  }
  scene.add(bench);

  // ---------------------------------------------------------------- rack
  const holes = uprightHoles();
  const uprightMat = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, metalness: 0.6, roughness: 0.45, map: holes });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8e9398, metalness: 1, roughness: 0.3 });
  const uhmw = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.6 });
  const rack = castAll(new THREE.Group());
  for (const s of [-1, 1]) {
    const up = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.75, 0.075), uprightMat);
    up.position.set(RACK_X, 0.875, s * RACK_Z);
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.05, 0.08, 2, 0.01), powder);
    base.position.set(RACK_X, 0.035, s * RACK_Z);
    // J-hook with a plastic liner.
    const hook = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.025, 0.06), steel);
    arm.position.set(0.13, 0, 0);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.06, 0.06), steel);
    lip.position.set(0.26, 0.03, 0);
    const liner = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.008, 0.062), uhmw);
    liner.position.set(0.14, 0.016, 0);
    hook.add(arm, lip, liner);
    hook.position.set(RACK_X + 0.04, BAR.hooks.y - SHAFT_R - 0.016, s * RACK_Z);
    // Safety arm just under chest height.
    const safety = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.04), steel);
    safety.position.set(RACK_X + 0.23, PAD_Y + 0.1, s * RACK_Z);
    rack.add(up, base, hook, safety);
  }
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, RACK_Z * 2), powder);
  crossbar.position.set(RACK_X, 1.72, 0);
  rack.add(crossbar);
  scene.add(rack);

  // ---------------------------------------------------------------- barbell
  const bar = new THREE.Group();
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0xa4a8ad, metalness: 1, roughness: 0.34, map: knurl() });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc5c9ce, metalness: 1, roughness: 0.18 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, SLEEVE_START * 2, 24), shaftMat);
  shaft.rotation.x = Math.PI / 2;
  bar.add(shaft);
  for (const s of [-1, 1]) {
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, SLEEVE_END - SLEEVE_START, 24), chrome);
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.z = s * (SLEEVE_START + (SLEEVE_END - SLEEVE_START) / 2);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.03, 24), chrome);
    collar.rotation.x = Math.PI / 2;
    collar.position.z = s * (SLEEVE_START - 0.015);
    bar.add(sleeve, collar);
  }
  castAll(bar);
  scene.add(bar);

  const plateGroup = new THREE.Group();
  bar.add(plateGroup);
  const plateGeoCache = new Map();
  const plateMatCache = new Map();
  const lockCollarGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.04, 20);
  const lockCollarMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.5, metalness: 0.3 });
  let shownKg = -1;
  function setPlates(kg) {
    if (kg === shownKg) return;
    shownKg = kg;
    plateGroup.clear();
    const plates = platesPerSide(kg);
    for (const s of [-1, 1]) {
      let z = SLEEVE_START + 0.005;
      for (const p of plates) {
        let geo = plateGeoCache.get(p.kg);
        if (!geo) {
          geo = new THREE.LatheGeometry(plateProfile(p.r, p.t, p.rubber), quality.detail > 0.7 ? 56 : 32);
          plateGeoCache.set(p.kg, geo);
        }
        let mat = plateMatCache.get(p.kg);
        if (!mat) {
          mat = p.rubber
            ? new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.82, map: plateFace(`${p.kg} KG`, true) })
            : new THREE.MeshStandardMaterial({ color: 0x9b9fa4, metalness: 0.95, roughness: 0.38, map: plateFace(`${p.kg}`, false) });
          plateMatCache.set(p.kg, mat);
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = Math.PI / 2;
        mesh.position.z = s * (z + p.t / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        plateGroup.add(mesh);
        z += p.t + 0.002;
      }
      const c = new THREE.Mesh(lockCollarGeo, lockCollarMat);
      c.rotation.x = Math.PI / 2;
      c.position.z = s * (z + 0.02);
      plateGroup.add(c);
    }
  }

  // ---------------------------------------------------------------- athlete
  let athlete = createAthlete({ detail: quality.detail });
  scene.add(athlete.group);

  // ---------------------------------------------------------------- lights
  scene.add(new THREE.HemisphereLight(0x8a96a8, 0x0b0b0b, 0.5));
  const key = new THREE.SpotLight(0xfff0dc, 85, 12, 0.66, 0.75, 2);
  key.position.set(0.5, 3.4, 1.0);
  key.target.position.set(-0.2, 0.6, 0);
  key.castShadow = quality.shadows > 0;
  if (key.castShadow) {
    key.shadow.mapSize.set(quality.shadows, quality.shadows);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 6;
    key.shadow.radius = 4;
  }
  scene.add(key, key.target);
  const rim = new THREE.SpotLight(0xa9c2ff, 28, 10, 0.7, 0.9, 2);
  rim.position.set(-2.6, 2.4, -1.8);
  rim.target.position.set(-0.2, 0.8, 0);
  scene.add(rim, rim.target);
  const fill = new THREE.PointLight(0xffe2c4, 3.2, 7, 2);
  fill.position.set(2.2, 1.4, 2.4);
  scene.add(fill);
  const signLight = new THREE.PointLight(0xfff4e6, 2.2, 5, 2);
  signLight.position.set(-1.6, 2.1, -3.0);
  scene.add(signLight);


  // Chalk dust drifting in the light.
  let dust = null;
  if (quality.detail > 0.4) {
    const n = 160;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      p[i * 3] = -1.2 + Math.random() * 2.4;
      p[i * 3 + 1] = 0.3 + Math.random() * 2.6;
      p[i * 3 + 2] = -1.2 + Math.random() * 2.4;
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    dust = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 0.012, map: radial(), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff }),
    );
    scene.add(dust);
  }

  // ---------------------------------------------------------------- camera
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 40);
  const target = new THREE.Vector3(-0.3, 0.8, 0);
  const camState = { az: 1.0, el: 0.26, dist: 3, shake: 0, push: 0 };

  function resize(w, h) {
    camera.aspect = w / h;
    const portrait = w < h;
    // Short landscape screens (phones on their side) need a wider view.
    camera.fov = portrait ? 46 : h < 500 ? 44 : 34;
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const R = portrait ? 1.0 : 1.02;
    camState.dist = R / Math.sin(Math.min(vHalf, hHalf));
    // In portrait, look a little more from above and from the feet so the
    // tall shape of the lift fills the screen.
    camState.az = portrait ? 0.42 : 0.55;
    camState.el = portrait ? 0.62 : 0.52;
    camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- per-frame
  const barPos = new THREE.Vector3().copy(BAR.hooks);
  const barTarget = new THREE.Vector3();
  let rack01 = 1; // 1 = on the hooks, 0 = in the lifter's hands at lockout
  let rackGoal = 1;
  let lastPhase = 'ready';
  let failKick = 0;

  function barFromView(view) {
    const p = view.pos;
    barTarget.set(
      lerp(BAR.chest.x, BAR.lockout.x, 1 - (1 - p) * (1 - p)),
      lerp(BAR.chest.y, BAR.lockout.y, p),
      0,
    );
    return barTarget;
  }

  /**
   * frame: { view (from sim) | null, dt, time, reducedMotion, breath }
   */
  function update(frame) {
    const { view, dt, time, reducedMotion } = frame;
    const strain = view ? view.strain : 0;
    if (view) setPlates(view.phase === 'ready' || view.phase === 'recover' || shownKg < 0 ? view.kg : shownKg);
    else setPlates(frame.kg || 60);

    rack01 += (rackGoal - rack01) * Math.min(1, dt * 2.2);
    const lockout = view ? barFromView(view) : BAR.lockout;
    const r = smooth(clamp01(rack01));
    const want = new THREE.Vector3(lerp(lockout.x, BAR.hooks.x, r), lerp(lockout.y, BAR.hooks.y, r), 0);
    // Tiny lift off the hooks mid-way (the bar has to clear the J-hook lip).
    want.y += Math.sin(r * Math.PI) * 0.035;
    // Follow closely; only smooths the jumps between phases.
    const k = view && view.phase === 'failed' ? 6 : 22;
    barPos.lerp(want, Math.min(1, dt * k));

    if (view && view.phase !== lastPhase) {
      if (view.phase === 'failed') failKick = 1;
      lastPhase = view.phase;
    }
    failKick = Math.max(0, failKick - dt * 1.2);

    // Effort tremor grows with load and fatigue; stronger while grinding.
    const motion = reducedMotion ? 0.25 : 1;
    const grinding = view && view.phase === 'pressing' ? 1.6 : view && view.phase === 'lowering' ? 1.1 : 0.5;
    const amp = (0.0006 + 0.0048 * strain * strain * grinding + 0.004 * failKick) * motion;
    const tremor = new THREE.Vector3(
      (Math.sin(time * 41) * 0.5 + Math.sin(time * 67.3) * 0.5) * amp * 0.5,
      (Math.sin(time * 53.1) * 0.6 + Math.sin(time * 29.7) * 0.4) * amp,
      0,
    );
    bar.position.copy(barPos).add(tremor);
    bar.rotation.x = (Math.sin(time * 3.1) * 0.004 + Math.sin(time * 37) * 0.002) * strain * motion;

    const breath = frame.breath ?? 0;
    athlete.update({
      bar: bar.position,
      barPos: view ? view.pos : 1,
      strain,
      breath,
      press: view && view.phase === 'pressing' ? 0.6 + 0.4 * strain : 0,
      time,
    });

    if (dust && !reducedMotion) {
      dust.rotation.y += dt * 0.01;
      dust.position.y = Math.sin(time * 0.1) * 0.05;
    }

    // Camera: slow drift, a push-in with effort, and a small kick on failure.
    const drift = reducedMotion ? 0 : 1;
    camState.push += ((view ? strain * 0.08 : 0) - camState.push) * Math.min(1, dt * 0.8);
    const az = camState.az + Math.sin(time * 0.07) * 0.06 * drift;
    const el = camState.el + Math.sin(time * 0.05 + 1) * 0.02 * drift;
    const dist = camState.dist * (1 - camState.push * drift);
    camera.position.set(
      target.x + Math.cos(az) * Math.cos(el) * dist,
      target.y + Math.sin(el) * dist,
      target.z + Math.sin(az) * Math.cos(el) * dist,
    );
    const kick = failKick * failKick * 0.01 * drift;
    camera.position.x += Math.sin(time * 31) * kick;
    camera.position.y += Math.sin(time * 27) * kick;
    camera.lookAt(target.x, target.y + (view ? (view.pos - 0.5) * 0.04 * drift : 0), target.z);
    if (api.debugView) {
      camera.position.set(...api.debugView.pos);
      camera.lookAt(...api.debugView.target);
    }
  }

  function setRacked(racked) {
    rackGoal = racked ? 1 : 0;
  }
  function snapRacked(racked) {
    rackGoal = rack01 = racked ? 1 : 0;
  }

  setPlates(60);
  /** Swap in another athlete with the same update(pose) interface (e.g. a rigged GLB). */
  function replaceAthlete(next) {
    scene.remove(athlete.group);
    athlete = next;
    scene.add(athlete.group);
  }

  const api = { scene, camera, resize, update, setRacked, snapRacked, replaceAthlete, debugView: null };
  return api;
}
