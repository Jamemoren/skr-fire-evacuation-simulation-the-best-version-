import * as THREE from "three";
import type { Calibration, Vec3 } from "../types";

export function calibrationMatrix(calibration: Calibration): THREE.Matrix4 {
  const position = new THREE.Vector3(...calibration.position);
  const rotation = new THREE.Euler(...calibration.rotation);
  const quaternion = new THREE.Quaternion().setFromEuler(rotation);
  const scale = new THREE.Vector3(
    calibration.scale,
    calibration.scale,
    calibration.scale,
  );
  return new THREE.Matrix4().compose(position, quaternion, scale);
}

export function modelLocalToWorld(position: Vec3, calibration: Calibration): Vec3 {
  const vector = new THREE.Vector3(...position).applyMatrix4(calibrationMatrix(calibration));
  return [vector.x, vector.y, vector.z];
}

export function worldToModelLocal(position: Vec3, calibration: Calibration): Vec3 {
  const matrix = calibrationMatrix(calibration).invert();
  const vector = new THREE.Vector3(...position).applyMatrix4(matrix);
  return [vector.x, vector.y, vector.z];
}

export function snapVec3(position: Vec3, size: number): Vec3 {
  if (size <= 0) return [...position];
  return position.map((value) => Math.round(value / size) * size) as Vec3;
}

export function distanceBetween(a: Vec3, b: Vec3): number {
  return new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b));
}
