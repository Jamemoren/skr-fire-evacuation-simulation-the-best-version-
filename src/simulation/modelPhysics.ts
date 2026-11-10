/**
 * Physical checks against the 3D model that is actually drawn (walls, floors, railings, windows, trees).
 *
 * The simulator's own network was verified against the model when it was built. A node the user
 * moves, or a passage the user adds, in the model editor has no such evidence, so before the
 * simulator may walk it the same two tests the campus QA uses are run on the model:
 *   - support: there is a floor under every point (ray down, within 0.65 m);
 *   - clear:   nothing is hit between consecutive points at knee (0.8 m) and head (1.65 m) height.
 *
 * The drawn model changes with the view (cut-away floors, exploded floors, hidden walls, door leaves
 * that swing open during a run). So the collision model is captured once, from the full view
 * (exterior, walls shown, floors not exploded, no Building 3/4 cut), merged into one mesh with a
 * BVH, and reused. Door leaves are left out: a door is an opening people pass through.
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { Vec3 } from "./types";

export interface WalkPhysics {
  /** Height of the floor under `point` (searched from 0.03 m above it, up to `drop` metres down), or null. */
  floorBelow(point: Vec3, drop?: number): number | null;
  /** First obstacle between `from` and `to`, or null when the segment is clear. */
  obstacle(from: Vec3, to: Vec3): { point: Vec3; name: string } | null;
}

/** Marks a subtree that people pass through (door leaves). */
export const PASSABLE_USER_DATA = "passableForWalking";

let surface: THREE.Object3D | null = null;
let fullViewCheck: (() => boolean) | null = null;
let captured: WalkPhysics | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Called by the scene with the group that holds the drawn model (MODEL_SURFACE). */
export function registerModelSurface(object: THREE.Object3D | null, isFullView?: () => boolean) {
  surface = object;
  fullViewCheck = isFullView ?? null;
  notify();
}
/** The drawn model's root (for checks against what is visible right now, e.g. camera occlusion). */
export function modelSurface(): THREE.Object3D | null { return surface; }
export function subscribeModelPhysics(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Merge every visible mesh (world space) except overlays and door leaves into one BVH mesh. */
export function physicsFromObject(root: THREE.Object3D): WalkPhysics | null {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  const ranges: Array<{ end: number; name: string }> = [];
  const triangle = new THREE.Vector3(), instanceMatrix = new THREE.Matrix4(), world = new THREE.Matrix4();
  const skip = (object: THREE.Object3D) => {
    if (object.userData?.performanceBatch) return true; // drawn copy of meshes counted on their own
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const hidden = !node.visible && !(node === object && node.userData?.batchedSource);
      if (hidden || node.userData?.semanticOverlay || node.userData?.[PASSABLE_USER_DATA] || node.userData?.noPhysics) return true;
      if (node === root) break;
    }
    return false;
  };
  const named = (object: THREE.Object3D) => {
    for (let node: THREE.Object3D | null = object; node && node !== root; node = node.parent) if (node.name) return node.name;
    return "วัตถุในโมเดล";
  };
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || skip(mesh)) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry?.attributes?.position;
    if (!position) return;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const instanced = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh ? mesh as unknown as THREE.InstancedMesh : null;
    const copies = instanced ? instanced.count : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      if (instanced) { instanced.getMatrixAt(copy, instanceMatrix); world.multiplyMatrices(mesh.matrixWorld, instanceMatrix); }
      else world.copy(mesh.matrixWorld);
      for (let i = 0; i < count; i += 1) {
        triangle.fromBufferAttribute(position as THREE.BufferAttribute, index ? index.getX(i) : i).applyMatrix4(world);
        positions.push(triangle.x, triangle.y, triangle.z);
      }
    }
    ranges.push({ end: positions.length / 9, name: named(mesh) });
  });
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const bvh = new MeshBVH(geometry);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const nameOf = (faceIndex: number) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ranges[mid].end > faceIndex) hi = mid; else lo = mid + 1; }
    return ranges[lo]?.name ?? "วัตถุในโมเดล";
  };
  const ray = new THREE.Ray(), direction = new THREE.Vector3();
  const cast = (from: Vec3, dir: THREE.Vector3, near: number, far: number) => {
    ray.origin.set(from[0], from[1], from[2]);
    ray.direction.copy(dir);
    return bvh.raycastFirst(ray, material, near, far);
  };
  return {
    floorBelow(point, drop = 0.65) {
      const hit = cast([point[0], point[1] + 0.03, point[2]], direction.set(0, -1, 0), 0, drop + 0.03);
      return hit ? hit.point.y : null;
    },
    obstacle(from, to) {
      direction.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      const length = direction.length();
      if (length < 0.05) return null;
      const hit = cast(from, direction.normalize(), 0.025, length - 0.025);
      // MeshBVH reorders the index; the source triangle is the first vertex of the face / 3.
      const face = hit ? Math.floor((geometry.index?.getX((hit.faceIndex ?? 0) * 3) ?? 0) / 3) : 0;
      return hit ? { point: [hit.point.x, hit.point.y, hit.point.z], name: nameOf(face) } : null;
    },
  };
}

let version = 0;
let retry = 0;
/** Changes when the collision model becomes available (for React: useSyncExternalStore). */
export function modelPhysicsVersion() { return version; }

/**
 * The collision model of the full view, or null until it can be captured (model still loading,
 * or the view hides floors/walls right now and nothing was captured before). While it is null the
 * capture is retried every second; listeners are told when it succeeds.
 */
export function modelPhysics(): WalkPhysics | null {
  if (captured) return captured;
  if (surface && fullViewCheck?.()) captured = physicsFromObject(surface);
  if (captured) { version += 1; queueMicrotask(notify); return captured; }
  if (!retry && typeof window !== "undefined") retry = window.setTimeout(() => { retry = 0; if (!captured && modelPhysics()) return; }, 1000);
  return null;
}

/** Forget the captured model (a different model was loaded). */
export function resetModelPhysics() { captured = null; version += 1; notify(); }
