import * as THREE from "three";
import type { Calibration } from "../../types";
import { calibrationMatrix } from "../../utils/coordinates";
import { fittedViewDistance } from "../../rendering/cameraFraming";
import {
  CINEMATIC_CAMERA_SETTLE_SECONDS,
  CINEMATIC_INTRO_END_FOV,
  CINEMATIC_INTRO_END_POSITION,
  CINEMATIC_INTRO_END_SPAN,
  CINEMATIC_INTRO_END_TARGET,
} from "../cinematicConfig";

type V3 = [number, number, number];

interface Shot {
  t: number;
  position: V3;
  target: V3;
  fov: number;
  /** Horizontal subject width kept in frame on narrow (portrait) screens. */
  span: number;
}

/** Spherical helper: azimuth from +X toward +Z, elevation above the ground plane. */
function orbit(pivot: V3, azimuthDeg: number, elevationDeg: number, radius: number): V3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return [
    pivot[0] + Math.cos(el) * Math.cos(az) * radius,
    pivot[1] + Math.sin(el) * radius,
    pivot[2] + Math.cos(el) * Math.sin(az) * radius,
  ];
}

export const INTRO_SPARK_POINT: V3 = [-20, 0.6, 24];

/**
 * Model-local key poses. Foreground (grid, motes, rings) / midground (building) /
 * background (field, night horizon) are layered by keeping the camera low while it
 * travels and only climbing for the reveal and hero frames.
 */
const SHOTS: Shot[] = [
  { t: 0, target: INTRO_SPARK_POINT, position: orbit(INTRO_SPARK_POINT, 120, 50, 64), fov: 58, span: 60 },
  { t: 1.95, target: [-9, 9, 9], position: orbit([-9, 9, 9], 146, 9, 58), fov: 50, span: 64 },
  { t: 3.55, target: [-13, 13, 16], position: orbit([-13, 13, 16], 121, 22, 86), fov: 48, span: 100 },
  { t: 5.05, target: [-10, 10, 10], position: orbit([-10, 10, 10], 136, 18, 70), fov: 48, span: 84 },
  { t: 6.75, target: [-14, 10, 10], position: orbit([-14, 10, 10], 146, 15, 63), fov: 50, span: 76 },
  { t: 8.05, target: [-12, 12, 30], position: orbit([-12, 12, 30], 128, 16, 104), fov: 52, span: 120 },
  { t: 9.35, target: [-10, 22, 50], position: orbit([-10, 22, 50], 118, 12, 150), fov: 54, span: 175 },
  {
    t: CINEMATIC_CAMERA_SETTLE_SECONDS,
    target: [...CINEMATIC_INTRO_END_TARGET],
    position: [...CINEMATIC_INTRO_END_POSITION],
    fov: CINEMATIC_INTRO_END_FOV,
    span: CINEMATIC_INTRO_END_SPAN,
  },
];

const positionCurve = new THREE.CatmullRomCurve3(SHOTS.map((s) => new THREE.Vector3(...s.position)), false, "centripetal");
const targetCurve = new THREE.CatmullRomCurve3(SHOTS.map((s) => new THREE.Vector3(...s.target)), false, "centripetal");

// Monotone cubic (Fritsch–Carlson) time warp: each key pose is reached exactly on its
// beat, velocity is continuous between shots and zero at the first and last pose.
const keyTimes = SHOTS.map((s) => s.t);
const keyU = SHOTS.map((_, i) => i / (SHOTS.length - 1));
const tangents = (() => {
  const n = SHOTS.length;
  const secant = Array.from({ length: n - 1 }, (_, i) => (keyU[i + 1] - keyU[i]) / (keyTimes[i + 1] - keyTimes[i]));
  const m = Array.from({ length: n }, (_, i) => (i === 0 || i === n - 1 ? 0 : (secant[i - 1] + secant[i]) / 2));
  for (let i = 1; i < n - 1; i += 1) {
    const a = m[i] / secant[i - 1];
    const b = m[i] / secant[i];
    const h = a * a + b * b;
    if (h > 9) m[i] = (3 / Math.sqrt(h)) * a * secant[i - 1];
  }
  return m;
})();

function warp(t: number): number {
  if (t <= keyTimes[0]) return 0;
  const last = keyTimes.length - 1;
  if (t >= keyTimes[last]) return 1;
  let k = 0;
  while (k < last - 1 && t >= keyTimes[k + 1]) k += 1;
  const h = keyTimes[k + 1] - keyTimes[k];
  const s = (t - keyTimes[k]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * keyU[k] + (s3 - 2 * s2 + s) * h * tangents[k]
    + (-2 * s3 + 3 * s2) * keyU[k + 1] + (s3 - s2) * h * tangents[k + 1];
}

function keyBlend(u: number, pick: (shot: Shot) => number): number {
  const x = THREE.MathUtils.clamp(u, 0, 1) * (SHOTS.length - 1);
  const k = Math.min(SHOTS.length - 2, Math.floor(x));
  const w = x - k;
  const e = w * w * (3 - 2 * w);
  return pick(SHOTS[k]) * (1 - e) + pick(SHOTS[k + 1]) * e;
}

/** Decaying micro-shake tied to the two impact beats (spark burst, hero ring). */
function shake(t: number, out: THREE.Vector3) {
  out.set(0, 0, 0);
  const impulses: Array<[number, number]> = [[0.22, 0.32], [9.02, 0.26]];
  for (const [at, amp] of impulses) {
    const age = t - at;
    if (age < 0 || age > 1.2) continue;
    const a = amp * Math.exp(-age * 5.5);
    out.x += Math.sin(age * 71.3) * a;
    out.y += Math.sin(age * 57.1 + 1.3) * a * 0.7;
    out.z += Math.sin(age * 63.7 + 2.1) * a;
  }
  return out;
}

const scratch = {
  matrix: new THREE.Matrix4(),
  shake: new THREE.Vector3(),
};

export interface IntroCameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  fov: number;
}

/**
 * Sample the cinematic camera. `still` freezes the camera on the operational pose
 * (prefers-reduced-motion). The final pose is fitted exactly like the simulator's
 * establishing view so the hand-off never jumps.
 */
export function sampleIntroCamera(time: number, aspect: number, calibration: Calibration, out: IntroCameraPose, still = false): IntroCameraPose {
  const t = still ? CINEMATIC_CAMERA_SETTLE_SECONDS : Math.min(time, CINEMATIC_CAMERA_SETTLE_SECONDS);
  const u = warp(t);
  positionCurve.getPoint(u, out.position);
  targetCurve.getPoint(u, out.target);
  out.fov = keyBlend(u, (s) => s.fov);
  const span = keyBlend(u, (s) => s.span);
  const matrix = scratch.matrix.copy(calibrationMatrix(calibration));
  out.position.applyMatrix4(matrix);
  out.target.applyMatrix4(matrix);
  const distance = Math.max(0.01, out.position.distanceTo(out.target));
  const fitted = fittedViewDistance(distance, out.fov, aspect, span * calibration.scale);
  out.position.sub(out.target).multiplyScalar(fitted / distance).add(out.target);
  if (!still) {
    const offset = shake(time, scratch.shake).multiplyScalar(calibration.scale);
    out.position.add(offset);
    out.target.addScaledVector(offset, 0.6);
  }
  return out;
}

export function createIntroCameraPose(): IntroCameraPose {
  return { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: CINEMATIC_INTRO_END_FOV };
}
