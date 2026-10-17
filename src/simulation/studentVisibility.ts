import type { BuildingViewMode } from "../building1/building1Store";
import type * as THREE from "three";

/** null hides a floor; offsets apply to rendering only, never simulation physics. */
export function yOffsetForRender(floor: number, building: {
  viewMode: BuildingViewMode; selectedFloor: number; explodeFloors: boolean;
}): number | null {
  const singleFloor = building.viewMode === "interior" || building.viewMode === "single-floor";
  if (singleFloor && floor !== building.selectedFloor) return null;
  if (building.viewMode === "cutaway" && floor > building.selectedFloor) return null;
  return building.explodeFloors ? Math.max(0, floor - 1) * 1.1 : 0;
}

/** Camera planes are in world space; the calibrated model may be moved or scaled. */
export function studentWorldBounds(sphere: THREE.Sphere, position: readonly number[], floorOffset: number, modelWorld: THREE.Matrix4): THREE.Sphere {
  sphere.center.set(position[0], position[1] + floorOffset + 0.8, position[2]);
  sphere.radius = 0.9;
  return sphere.applyMatrix4(modelWorld);
}
