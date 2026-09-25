// The lifter.
//
// TEMPORARY ASSET: this athlete is built from code (lathe-turned limbs, a
// shaped torso and oversized garments) because no commercially licensable,
// rigged human model was available to this project. It is proportioned like
// an adult (about 1.80 m) and driven by the same pose interface a rigged GLB
// would use -- see glbAthlete.js to swap in a real model.
//
// Coordinates: metres. The bench runs along X (head at -X, feet at +X),
// the bar runs along Z, Y is up. Pad top is at PAD_Y.
import * as THREE from 'three';
import { fabric, teePrint } from './textures.js';

export const PAD_Y = 0.46;
export const GRIP_HALF = 0.405; // hands ~81 cm apart: index finger on the rings
export const UPPER_ARM = 0.3;
export const FOREARM = 0.265;
const WRIST_BELOW_BAR = 0.058;

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

/** A smooth tapered solid along +Y from 0 to len. radii: [[t, r], ...], t in 0..1 */
function turned(len, radii, radial = 20, rings = 14) {
  const pts = [];
  pts.push(new THREE.Vector2(0.0001, 0));
  // round cap at the start
  const r0 = radii[0][1];
  for (let i = 1; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.sin(a) * r0, (1 - Math.cos(a)) * r0 * 0.6));
  }
  for (let i = 1; i < rings; i++) {
    const t = i / rings;
    let r = radii[0][1];
    for (let k = 0; k < radii.length - 1; k++) {
      const [ta, ra] = radii[k];
      const [tb, rb] = radii[k + 1];
      if (t >= ta && t <= tb) {
        const u = (t - ta) / (tb - ta);
        r = ra + (rb - ra) * (u * u * (3 - 2 * u));
      }
    }
    pts.push(new THREE.Vector2(r, t * len));
  }
  const r1 = radii[radii.length - 1][1];
  for (let i = 0; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.cos(a) * r1 + 0.0001, len - r1 * 0.6 + Math.sin(a) * r1 * 0.6));
  }
  const g = new THREE.LatheGeometry(pts, radial);
  g.computeVertexNormals();
  return g;
}

/** Orient an object whose geometry points along +Y so it spans a -> b. */
function span(obj, a, b) {
  obj.position.copy(a);
  const d = new THREE.Vector3().subVectors(b, a).normalize();
  obj.quaternion.setFromUnitVectors(UP, d);
}

/** Gentle fabric folds: displace along the normal with low-frequency waves. */
function wrinkle(geo, amount, freq, seed = 1) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const w =
      Math.sin(y * freq + seed) * 0.6 +
      Math.sin((x + z) * freq * 0.7 + y * freq * 0.3 + seed * 2) * 0.4 +
      Math.sin(Math.atan2(z, x) * 5 + y * freq * 0.5) * 0.3;
    const k = amount * w;
    pos.setXYZ(i, x + nrm.getX(i) * k, y + nrm.getY(i) * k, z + nrm.getZ(i) * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/** Two-bone IK. Returns the elbow position for shoulder s, wrist w and a pole hint. */
export function solveElbow(s, w, pole, l1 = UPPER_ARM, l2 = FOREARM) {
  const d = new THREE.Vector3().subVectors(w, s);
  let dist = d.length();
  const maxLen = (l1 + l2) * 0.9995;
  if (dist > maxLen) {
    d.multiplyScalar(maxLen / dist);
    dist = maxLen;
  }
  const dir = d.clone().normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const p = new THREE.Vector3().subVectors(pole, s);
  p.sub(dir.clone().multiplyScalar(p.dot(dir)));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0);
  p.normalize();
  return s.clone().add(dir.multiplyScalar(a)).add(p.multiplyScalar(h));
}

export function createAthlete({ detail = 1 } = {}) {
  const radial = detail > 0.7 ? 24 : 14;
  const group = new THREE.Group();
  group.name = 'athlete';

  const weave = fabric();
  const skin = new THREE.MeshPhysicalMaterial({ color: 0x7a5646, roughness: 0.58, sheen: 0.2, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffc2a0) });
  const faceSkin = skin.clone();
  const tee = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.93, bumpMap: weave, bumpScale: 0.6 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.96, bumpMap: weave, bumpScale: 0.5 });
  const rib = new THREE.MeshStandardMaterial({ color: 0x1f2023, roughness: 0.9 });
  const shoe = new THREE.MeshPhysicalMaterial({ color: 0x0d0d0e, roughness: 0.45, clearcoat: 0.3 });
  const sole = new THREE.MeshStandardMaterial({ color: 0xd8d4cb, roughness: 0.7 });
  const beanieMat = new THREE.MeshStandardMaterial({ color: 0x121213, roughness: 0.98, bumpMap: weave, bumpScale: 1.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1210, roughness: 0.4 });

  const cast = (m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // ------------------------------------------------------------- torso
  // A turned body from hips (+X) to shoulders (-X), flattened into an oval.
  const torsoLen = 0.7;
  const teeGeo = turned(
    torsoLen,
    [
      [0, 0.185],
      [0.15, 0.2],
      [0.45, 0.198],
      [0.72, 0.212],
      [0.9, 0.21],
      [1, 0.16],
    ],
    radial + 8,
    22,
  );
  wrinkle(teeGeo, 0.006, 38, 3);
  // Oversized drape: the loose belly fabric settles towards the bench.
  {
    const p = teeGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / torsoLen; // 0 hips .. 1 shoulders
      const x = p.getX(i);
      const z = p.getZ(i);
      const belly = Math.max(0, 1 - Math.abs(y - 0.3) / 0.35);
      // x is "up" once the torso is laid down (see rotation below)
      if (x > 0) p.setX(i, x * (1 - 0.18 * belly));
      p.setZ(i, z * (1 + 0.05 * belly));
    }
    teeGeo.computeVertexNormals();
  }
  const torso = cast(new THREE.Mesh(teeGeo, tee));
  // lathe axis +Y -> world -X; lathe +X -> world +Y (so "x > 0" above is the chest side)
  torso.rotation.set(0, 0, Math.PI / 2);
  torso.scale.set(0.62, 1, 0.98);
  const torsoPivot = new THREE.Group();
  torsoPivot.position.set(0.27, PAD_Y + 0.212 * 0.62, 0);
  torsoPivot.add(torso);
  group.add(torsoPivot);

  // Chest print (transparent decal lying on the chest).
  const print = teePrint(true);
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.28, 8, 1),
    new THREE.MeshStandardMaterial({ map: print, transparent: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  {
    const g = decal.geometry;
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, -((x / 0.14) ** 2) * 0.03);
    }
    g.computeVertexNormals();
  }
  decal.rotation.set(-Math.PI / 2, 0, 0);
  decal.rotateOnWorldAxis(UP, Math.PI / 2);
  decal.position.set(-0.26 - 0.27, 0.212 * 0.62 + 0.003, 0);
  torsoPivot.add(decal);

  // Collar
  const collar = cast(new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 8, radial), rib));
  collar.rotation.set(0, Math.PI / 2, 0);
  collar.scale.set(1, 0.8, 1.15);
  collar.position.set(-0.42 - 0.27, 0.035, 0);
  torsoPivot.add(collar);

  // ------------------------------------------------------------- neck & head
  const neck = cast(new THREE.Mesh(turned(0.13, [[0, 0.056], [1, 0.05]], radial), skin));
  span(neck, V(-0.4, PAD_Y + 0.14, 0), V(-0.53, PAD_Y + 0.115, 0));
  group.add(neck);

  const head = new THREE.Group();
  head.position.set(-0.62, PAD_Y + 0.1, 0);
  group.add(head);
  const skull = cast(new THREE.Mesh(new THREE.SphereGeometry(1, radial + 8, 18), faceSkin));
  skull.scale.set(0.12, 0.104, 0.084);
  head.add(skull);
  const jaw = cast(new THREE.Mesh(new THREE.SphereGeometry(1, radial, 14), faceSkin));
  jaw.scale.set(0.07, 0.066, 0.064);
  jaw.position.set(0.055, 0.012, 0);
  head.add(jaw);
  const nose = cast(new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.034, 10), faceSkin));
  nose.position.set(0.018, 0.108, 0);
  nose.rotation.z = -0.25;
  head.add(nose);
  for (const s of [-1, 1]) {
    const ear = cast(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), faceSkin));
    ear.scale.set(0.028, 0.018, 0.009);
    ear.position.set(-0.005, 0.0, s * 0.079);
    head.add(ear);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 10, 8), dark);
    eye.position.set(-0.018, 0.087, s * 0.032);
    eye.scale.set(1.3, 0.55, 1);
    head.add(eye);
    const brow = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.006, 0.026, 4, 8), faceSkin));
    brow.rotation.x = Math.PI / 2;
    brow.position.set(-0.034, 0.094, s * 0.032);
    head.add(brow);
  }
  const mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.003, 0.02, 4, 6), dark);
  mouth.rotation.x = Math.PI / 2;
  mouth.position.set(0.075, 0.068, 0);
  head.add(mouth);
  // Beanie: ribbed cuff plus a knitted crown.
  const beanie = cast(new THREE.Mesh(new THREE.SphereGeometry(1, radial + 4, 14, 0, Math.PI * 2, 0, Math.PI * 0.55), beanieMat));
  beanie.scale.set(0.118, 0.105, 0.087);
  beanie.rotation.z = Math.PI / 2 + 0.25;
  beanie.position.set(-0.012, -0.004, 0);
  head.add(beanie);
  const cuff = cast(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, radial + 4, 1, true), beanieMat));
  cuff.scale.set(0.105, 0.04, 0.09);
  cuff.rotation.z = Math.PI / 2 + 0.25;
  cuff.position.set(-0.035, 0.012, 0);
  head.add(cuff);

  // ------------------------------------------------------------- pelvis & legs
  const hips = cast(new THREE.Mesh(new THREE.SphereGeometry(1, radial, 14), pants));
  hips.scale.set(0.15, 0.11, 0.2);
  hips.position.set(0.3, PAD_Y + 0.1, 0);
  group.add(hips);

  const thighGeo = turned(0.42, [[0, 0.1], [0.5, 0.093], [1, 0.072]], radial);
  wrinkle(thighGeo, 0.004, 55, 7);
  const shinGeo = turned(0.44, [[0, 0.072], [0.35, 0.068], [0.85, 0.06], [1, 0.048]], radial);
  wrinkle(shinGeo, 0.004, 60, 9);
  const legs = [];
  for (const s of [-1, 1]) {
    const thigh = cast(new THREE.Mesh(thighGeo, pants));
    const shin = cast(new THREE.Mesh(shinGeo, pants));
    const knee = cast(new THREE.Mesh(new THREE.SphereGeometry(0.066, radial, 12), pants));
    const cuffL = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.05, radial), rib));
    const shoeG = new THREE.Group();
    const upper = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.17, 6, 14), shoe));
    upper.rotation.z = Math.PI / 2;
    upper.scale.set(0.95, 1, 0.95);
    upper.position.set(0.05, 0.05, 0);
    const soleM = cast(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.028, 0.1), sole));
    soleM.position.set(0.05, 0.014, 0);
    shoeG.add(upper, soleM);
    group.add(thigh, shin, knee, cuffL, shoeG);
    legs.push({ s, thigh, shin, knee, cuff: cuffL, shoe: shoeG });
  }

  // ------------------------------------------------------------- arms
  const upperGeo = turned(UPPER_ARM, [[0, 0.064], [0.45, 0.062], [0.85, 0.05], [1, 0.043]], radial);
  const foreGeo = turned(FOREARM, [[0, 0.044], [0.25, 0.049], [0.8, 0.036], [1, 0.031]], radial);
  const sleeveGeo = turned(0.23, [[0, 0.09], [0.7, 0.084], [1, 0.08]], radial, 10);
  wrinkle(sleeveGeo, 0.005, 60, 5);
  const arms = [];
  for (const s of [-1, 1]) {
    const upperArm = cast(new THREE.Mesh(upperGeo, skin));
    const sleeve = cast(new THREE.Mesh(sleeveGeo, tee));
    sleeve.position.y = -0.02;
    upperArm.add(sleeve);
    const elbow = cast(new THREE.Mesh(new THREE.SphereGeometry(0.043, radial, 10), skin));
    const fore = cast(new THREE.Mesh(foreGeo, skin));
    const deltoid = cast(new THREE.Mesh(new THREE.SphereGeometry(0.082, radial, 12), tee));
    deltoid.scale.set(1, 0.85, 0.9);
    // Hand: palm under the bar, fingers wrapped around it.
    const hand = new THREE.Group();
    const palm = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.045, 6, 12), skin));
    palm.scale.set(1.25, 1, 0.62);
    palm.position.set(0, -0.034, 0);
    const fingers = cast(new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.0125, 8, 18, Math.PI * 1.35), skin));
    fingers.rotation.set(0, 0, -Math.PI * 0.2);
    fingers.scale.set(1, 1, 3.6);
    const thumb = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.03, 4, 8), skin));
    thumb.position.set(-0.012, 0.025, -s * 0.045);
    thumb.rotation.set(Math.PI / 2, 0, 0.3);
    hand.add(palm, fingers, thumb);
    group.add(upperArm, elbow, fore, deltoid, hand);
    arms.push({ s, upperArm, elbow, fore, hand, deltoid });
  }

  // Anchors (rest pose)
  const shoulderBase = (s) => V(-0.37, PAD_Y + 0.135, s * 0.18);
  const hipJoint = (s) => V(0.3, PAD_Y + 0.1, s * 0.105);
  const footBase = (s) => V(0.53, 0.0, s * 0.34);

  const tmp = {
    s: new THREE.Vector3(),
    w: new THREE.Vector3(),
    grip: new THREE.Vector3(),
    pole: new THREE.Vector3(),
  };

  /**
   * pose: { bar: Vector3 (bar centre), barPos 0..1, strain 0..1, breath -1..1,
   *         press 0..1 (how hard they drive), time (s), tremor Vector3 }
   */
  function update(pose) {
    const { bar, barPos, strain, breath, press } = pose;
    // Breathing: the chest rises and widens slightly.
    const b = breath * (0.012 + 0.012 * strain);
    torso.scale.y = 1 + b * 0.4;
    torsoPivot.position.y = PAD_Y + 0.212 * 0.62 + b * 0.5 + press * 0.008;

    // Face flushes with effort.
    faceSkin.color.setRGB(0.478 + 0.08 * strain, 0.337 - 0.04 * strain, 0.275 - 0.04 * strain, THREE.SRGBColorSpace);
    head.rotation.z = -0.05 * press + 0.02 * breath;

    for (const arm of arms) {
      const s = arm.s;
      // Shoulders stay pinned back but rise a touch at lockout.
      tmp.s.copy(shoulderBase(s));
      tmp.s.y += 0.015 * barPos;
      tmp.s.x += 0.01 * barPos;
      tmp.grip.set(bar.x, bar.y, bar.z + s * GRIP_HALF);
      // Wrist sits under the bar, slightly towards the head (neutral wrist).
      tmp.w.set(tmp.grip.x - 0.01, tmp.grip.y - WRIST_BELOW_BAR, tmp.grip.z - s * 0.005);
      // Elbows out ~45-60 degrees and down.
      tmp.pole.set(tmp.s.x + 0.12, tmp.s.y - 0.5, tmp.s.z + s * 0.45);
      const e = solveElbow(tmp.s, tmp.w, tmp.pole);
      span(arm.upperArm, tmp.s, e);
      arm.elbow.position.copy(e);
      span(arm.fore, e, tmp.w);
      arm.deltoid.position.copy(tmp.s).add(V(0.0, 0.0, s * 0.01));
      // Hand: from wrist up into the bar, wrapped around the bar axis (Z).
      arm.hand.position.copy(tmp.grip);
      const forearmDir = new THREE.Vector3().subVectors(tmp.w, e).normalize();
      const tilt = Math.atan2(forearmDir.x, forearmDir.y);
      arm.hand.rotation.set(0, 0, -tilt);
    }

    for (const leg of legs) {
      const s = leg.s;
      const hip = hipJoint(s);
      const foot = footBase(s);
      // Leg drive: knees push out a little when pressing hard.
      const knee = V(0.7, PAD_Y + 0.04 + 0.01 * press, s * (0.22 + 0.01 * press));
      const ankle = V(foot.x - 0.02, 0.09, foot.z);
      span(leg.thigh, hip, knee);
      span(leg.shin, knee, ankle);
      leg.knee.position.copy(knee);
      leg.cuff.position.copy(ankle).add(V(0, 0.01, 0));
      leg.shoe.position.set(foot.x - 0.07, 0, foot.z);
      leg.shoe.rotation.y = -s * 0.12;
    }
  }

  return { group, update, materials: { skin, tee, pants } };
}
