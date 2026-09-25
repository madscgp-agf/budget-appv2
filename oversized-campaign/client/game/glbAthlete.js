// Adapter for a rigged GLB athlete (replaces the temporary built-in one).
//
// STATUS: written against the standard Mixamo bone names but NOT yet tested
// with a real model -- no licensed model was available. See README
// ("Udskift atleten med en rigget GLB-model").
//
// It exposes the same update(pose) as athlete.js. The arms and legs are
// placed by aiming bones at IK targets computed with the same two-bone
// solver, so the hands stay locked to the bar exactly as they do now.
import * as THREE from 'three';
import { GRIP_HALF, PAD_Y, solveElbow } from './athlete.js';

export const MIXAMO_BONES = {
  hips: 'mixamorigHips',
  chest: 'mixamorigSpine2',
  head: 'mixamorigHead',
  leftArm: 'mixamorigLeftArm',
  leftForeArm: 'mixamorigLeftForeArm',
  leftHand: 'mixamorigLeftHand',
  rightArm: 'mixamorigRightArm',
  rightForeArm: 'mixamorigRightForeArm',
  rightHand: 'mixamorigRightHand',
  leftUpLeg: 'mixamorigLeftUpLeg',
  leftLeg: 'mixamorigLeftLeg',
  leftFoot: 'mixamorigLeftFoot',
  rightUpLeg: 'mixamorigRightUpLeg',
  rightLeg: 'mixamorigRightLeg',
  rightFoot: 'mixamorigRightFoot',
};

/**
 * options:
 *   url            GLB file (served from the theme extension assets or the app)
 *   bones          bone name map (defaults to Mixamo)
 *   rootTransform  { position, rotation, scale } that lays the model on its
 *                  back on the bench: head towards -X, chest up (+Y)
 */
export async function loadGlbAthlete({ url, bones = MIXAMO_BONES, rootTransform = {} }) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  const group = new THREE.Group();
  group.add(root);
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const rt = { position: [0, PAD_Y + 0.12, 0], rotation: [0, 0, -Math.PI / 2], scale: 1, ...rootTransform };
  root.position.fromArray(rt.position);
  root.rotation.fromArray(rt.rotation);
  root.scale.setScalar(rt.scale);

  const b = {};
  for (const [key, name] of Object.entries(bones)) {
    b[key] = root.getObjectByName(name);
    if (!b[key]) throw new Error(`GLB athlete is missing bone ${name}`);
  }
  group.updateMatrixWorld(true);

  const lengths = {
    upper: b.leftArm.getWorldPosition(new THREE.Vector3()).distanceTo(b.leftForeArm.getWorldPosition(new THREE.Vector3())),
    fore: b.leftForeArm.getWorldPosition(new THREE.Vector3()).distanceTo(b.leftHand.getWorldPosition(new THREE.Vector3())),
    thigh: b.leftUpLeg.getWorldPosition(new THREE.Vector3()).distanceTo(b.leftLeg.getWorldPosition(new THREE.Vector3())),
    shin: b.leftLeg.getWorldPosition(new THREE.Vector3()).distanceTo(b.leftFoot.getWorldPosition(new THREE.Vector3())),
  };

  const q = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();
  const a = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cur = new THREE.Vector3();
  const want = new THREE.Vector3();

  // Rotate `bone` (in world space) so that its child points at `target`.
  function aim(bone, child, target) {
    bone.updateWorldMatrix(true, false);
    bone.getWorldPosition(a);
    child.getWorldPosition(c);
    cur.subVectors(c, a).normalize();
    want.subVectors(target, a).normalize();
    q.setFromUnitVectors(cur, want);
    bone.getWorldQuaternion(parentQ);
    const world = q.multiply(parentQ);
    const pInv = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    bone.quaternion.copy(pInv.multiply(world));
    bone.updateWorldMatrix(false, true);
  }

  const chestBase = b.chest.position.clone();

  function update(pose) {
    const { bar, strain, breath, press } = pose;
    b.chest.position.copy(chestBase);
    b.chest.position.y += breath * 0.01 * (1 + strain);
    group.updateMatrixWorld(true);

    for (const [side, arm, fore, hand] of [
      [-1, b.rightArm, b.rightForeArm, b.rightHand],
      [1, b.leftArm, b.leftForeArm, b.leftHand],
    ]) {
      const s = arm.getWorldPosition(new THREE.Vector3());
      const grip = new THREE.Vector3(bar.x, bar.y, bar.z + side * GRIP_HALF);
      const wrist = new THREE.Vector3(grip.x - 0.01, grip.y - 0.058, grip.z);
      const pole = new THREE.Vector3(s.x + 0.12, s.y - 0.5, s.z + side * 0.45);
      const elbow = solveElbow(s, wrist, pole, lengths.upper, lengths.fore);
      aim(arm, fore, elbow);
      aim(fore, hand, wrist);
    }
    for (const [side, up, leg, foot] of [
      [-1, b.rightUpLeg, b.rightLeg, b.rightFoot],
      [1, b.leftUpLeg, b.leftLeg, b.leftFoot],
    ]) {
      const hip = up.getWorldPosition(new THREE.Vector3());
      const ankle = new THREE.Vector3(0.51, 0.09, side * 0.34);
      const pole = new THREE.Vector3(hip.x + 0.6, hip.y + 0.3, side * (0.3 + 0.01 * press));
      const knee = solveElbow(hip, ankle, pole, lengths.thigh, lengths.shin);
      aim(up, leg, knee);
      aim(leg, foot, ankle);
    }
  }

  return { group, update };
}
