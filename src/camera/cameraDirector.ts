/**
 * Camera director for the automatic editor demo and the presentation.
 *
 * frame(points): chooses a view that shows every point (an object, a node, both ends of an edge)
 *   inside the part of the screen the panels leave free, from a direction where the model does not
 *   hide them (rays checked against the drawn model, the same collision data as the editor's wall
 *   check). It keeps the current direction when that still shows everything clearly, so the viewer
 *   can follow; otherwise it tries oblique views around the target and a top view.
 * move(pose): eases there (smooth in/out) and resolves when the camera has stopped. With
 *   prefers-reduced-motion it cuts to the pose.
 * The user grabbing the camera cancels the move and notifies listeners (the demo pauses).
 */
import * as THREE from "three";
import { modelSurface } from "../simulation/modelPhysics";
import type { Vec3 } from "../simulation/types";

interface Controls { target: THREE.Vector3; update(): void; addEventListener(type: "start", listener: () => void): void; removeEventListener(type: "start", listener: () => void): void }
interface Rig { camera: THREE.PerspectiveCamera; controls: Controls | null; dom: HTMLElement }

export interface Insets { left: number; right: number; top: number; bottom: number }
export interface CameraPose { position: Vec3; target: Vec3 }
export interface FrameResult extends CameraPose { direction: string; reused: boolean; occluded: boolean }

let rig: Rig | null = null;
let animation = 0;
let pendingResolve: ((finished: boolean) => void) | null = null;
const interruptListeners = new Set<() => void>();

const onUserStart = () => {
  if (animation) { cancelAnimationFrame(animation); animation = 0; pendingResolve?.(false); pendingResolve = null; }
  interruptListeners.forEach((listener) => listener());
};

/** Called every frame by the scene's camera controller (cheap: only stores references). */
export function syncCameraRig(camera: THREE.Camera, controls: Controls | null, dom: HTMLElement) {
  if (!(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;
  if (rig && rig.camera === camera && rig.controls === controls && rig.dom === dom) return;
  rig?.controls?.removeEventListener("start", onUserStart);
  rig = { camera: camera as THREE.PerspectiveCamera, controls, dom };
  controls?.addEventListener("start", onUserStart);
}
export function cameraReady() { return !!rig; }
/** Notified when the user starts moving the camera themselves. */
export function onCameraInterrupt(listener: () => void) { interruptListeners.add(listener); return () => { interruptListeners.delete(listener); }; }

export function currentPose(): CameraPose | null {
  if (!rig) return null;
  const target = rig.controls?.target ?? rig.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(30).add(rig.camera.position);
  return { position: rig.camera.position.toArray() as Vec3, target: target.toArray() as Vec3 };
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Ease the camera to a pose; resolves true when it arrived, false if the user took over. */
// The app's own camera focus (view buttons, floor changes) animates the camera too; a directed move
// takes over from it instead of fighting it frame by frame.
let appFocusCanceller: (() => void) | null = null;
export function registerAppFocusCanceller(cancel: (() => void) | null) { appFocusCanceller = cancel; }

export function moveCamera(pose: CameraPose, durationMs = 1400): Promise<boolean> {
  if (!rig) return Promise.resolve(false);
  appFocusCanceller?.();
  if (animation) { cancelAnimationFrame(animation); animation = 0; pendingResolve?.(false); pendingResolve = null; }
  const { camera, controls } = rig;
  const fromPos = camera.position.clone(), fromTarget = (controls?.target ?? new THREE.Vector3(...pose.target)).clone();
  const toPos = new THREE.Vector3(...pose.position), toTarget = new THREE.Vector3(...pose.target);
  const apply = (t: number) => {
    camera.position.lerpVectors(fromPos, toPos, t);
    const target = fromTarget.clone().lerp(toTarget, t);
    camera.lookAt(target);
    controls?.target.copy(target);
    controls?.update();
  };
  const distance = fromPos.distanceTo(toPos) + fromTarget.distanceTo(toTarget);
  if (reducedMotion() || distance < 0.05) { apply(1); return Promise.resolve(true); }
  const duration = Math.max(500, Math.min(2600, durationMs * Math.min(1.6, 0.55 + distance / 120)));
  return new Promise((resolve) => {
    pendingResolve = resolve;
    const start = performance.now();
    const step = () => {
      appFocusCanceller?.(); // a focus started by a view change after this move began must not pull the camera back
      const t = Math.min(1, (performance.now() - start) / duration);
      apply(ease(t));
      if (t < 1) { animation = requestAnimationFrame(step); return; }
      animation = 0;
      pendingResolve = null;
      resolve(true);
    };
    animation = requestAnimationFrame(step);
  });
}

export function cancelCameraMove() {
  if (animation) { cancelAnimationFrame(animation); animation = 0; pendingResolve?.(false); pendingResolve = null; }
}

/** Screen area the UI panels cover, measured from elements marked data-camera-inset="left|right|top|bottom". */
export function measureInsets(): Insets {
  const insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  if (!rig) return insets;
  const box = rig.dom.getBoundingClientRect();
  document.querySelectorAll<HTMLElement>("[data-camera-inset]").forEach((element) => {
    const side = element.dataset.cameraInset as keyof Insets;
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(element).visibility === "hidden") return;
    if (side === "left") insets.left = Math.max(insets.left, r.right - box.left);
    if (side === "right") insets.right = Math.max(insets.right, box.right - r.left);
    if (side === "top") insets.top = Math.max(insets.top, r.bottom - box.top);
    if (side === "bottom") insets.bottom = Math.max(insets.bottom, box.bottom - r.top);
  });
  const clamp = (value: number, size: number) => Math.max(0, Math.min(value, size * 0.62));
  return { left: clamp(insets.left, box.width), right: clamp(insets.right, box.width), top: clamp(insets.top, box.height), bottom: clamp(insets.bottom, box.height) };
}

interface Viewport { width: number; height: number; insets: Insets; margin: number }

/** Where each point lands on screen (pixels) for a camera at `position` looking at `target`. */
/** Where a world point is on screen now (page coordinates), for drawing a pointer from a 3D label to text. */
export function screenPoint(point: Vec3): { x: number; y: number; visible: boolean } | null {
  if (!rig) return null;
  const box = rig.dom.getBoundingClientRect();
  const p = new THREE.Vector3(...point).project(rig.camera);
  return { x: box.left + (p.x + 1) / 2 * box.width, y: box.top + (1 - p.y) / 2 * box.height, visible: p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05 };
}

function project(points: THREE.Vector3[], position: THREE.Vector3, target: THREE.Vector3, camera: THREE.PerspectiveCamera, view: Viewport) {
  const probe = camera.clone();
  probe.aspect = view.width / view.height;
  probe.position.copy(position);
  probe.up.set(0, 1, 0);
  probe.lookAt(target);
  probe.updateMatrixWorld(true);
  probe.updateProjectionMatrix();
  return points.map((point) => {
    const p = point.clone().project(probe);
    return { x: (p.x + 1) / 2 * view.width, y: (1 - p.y) / 2 * view.height, behind: p.z > 1 };
  });
}

function fits(screen: Array<{ x: number; y: number; behind: boolean }>, view: Viewport) {
  const { insets, margin } = view;
  return screen.every((p) => !p.behind && p.x >= insets.left + margin && p.x <= view.width - insets.right - margin && p.y >= insets.top + margin && p.y <= view.height - insets.bottom - margin);
}

/**
 * Is any point hidden by what is drawn right now (a cut-away view hides upper floors, so the check
 * uses the visible meshes, not the full collision model)? Overlays and door leaves never hide.
 */
const occlusionRay = new THREE.Raycaster();
function visibleChain(object: THREE.Object3D, root: THREE.Object3D) {
  for (let node: THREE.Object3D | null = object; node && node !== root; node = node.parent) {
    if (!node.visible) return false; // the GPU batches that replace hidden source meshes are what is drawn
    if (node.userData?.semanticOverlay || node.userData?.passableForWalking || node.userData?.noPhysics) return false;
  }
  return true;
}
function occludedFrom(position: THREE.Vector3, points: THREE.Vector3[]): boolean {
  const root = modelSurface();
  if (!root) return false;
  return points.some((point) => {
    const lifted = point.clone().add(new THREE.Vector3(0, 0.6, 0));
    const direction = lifted.clone().sub(position);
    const length = direction.length();
    occlusionRay.set(position, direction.normalize());
    occlusionRay.near = 0.1; occlusionRay.far = Math.max(0.2, length - 0.9);
    if (rig) occlusionRay.camera = rig.camera; // fat lines (Line2) need it to be tested
    try {
      const hits = occlusionRay.intersectObject(root, true);
      return hits.some((hit) => visibleChain(hit.object, root) && !(hit.object as unknown as { isLine2?: boolean; isLineSegments2?: boolean }).isLineSegments2);
    } catch { return false; } // an object that cannot be ray-tested never blocks the view
  });
}

/**
 * The best view of `targets` (world points). Keeps the current view when it already shows them all,
 * unobstructed, inside the free area; otherwise tries the current direction moved to fit, then
 * oblique views around the target, then straight down.
 */
export function frame(targets: Vec3[], options: { minDistance?: number; preferTop?: boolean; insets?: Insets; margin?: number } = {}): FrameResult | null {
  if (!rig || !targets.length) return null;
  const { camera } = rig;
  const box = rig.dom.getBoundingClientRect();
  const view: Viewport = { width: Math.max(1, box.width), height: Math.max(1, box.height), insets: options.insets ?? measureInsets(), margin: options.margin ?? Math.min(72, box.width * 0.06) };
  const points = targets.map((p) => new THREE.Vector3(...p));
  const bounds = new THREE.Box3().setFromPoints(points);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(2, bounds.getSize(new THREE.Vector3()).length() / 2);
  // Samples for visibility: the centre plus the ends (for an edge: both endpoints).
  const samples = [center, ...points.slice(0, 6)];

  const current = currentPose();
  if (current) {
    const position = new THREE.Vector3(...current.position), target = new THREE.Vector3(...current.target);
    if (fits(project(points, position, target, camera, view), view) && position.distanceTo(center) < radius * 14 && !occludedFrom(position, samples)) {
      return { position: current.position, target: current.target, direction: "current", reused: true, occluded: false };
    }
  }
  // Shift the look-at point so the target sits in the middle of the free area, not the whole canvas.
  const freeCenterX = (view.insets.left + view.width - view.insets.right) / 2 - view.width / 2;
  const freeCenterY = (view.insets.top + view.height - view.insets.bottom) / 2 - view.height / 2;

  const currentDir = current ? new THREE.Vector3(...current.position).sub(new THREE.Vector3(...current.target)).normalize() : null;
  const directions: Array<{ name: string; dir: THREE.Vector3 }> = [];
  if (currentDir && !options.preferTop && currentDir.y > 0.2) directions.push({ name: "current", dir: currentDir });
  const yaw0 = currentDir ? Math.atan2(currentDir.x, currentDir.z) : Math.PI * 0.75;
  for (const turn of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, Math.PI]) {
    const yaw = yaw0 + turn;
    directions.push({ name: `oblique ${Math.round(turn * 57)}°`, dir: new THREE.Vector3(Math.sin(yaw) * 0.72, 0.62, Math.cos(yaw) * 0.72).normalize() });
  }
  directions.push({ name: "top", dir: new THREE.Vector3(0.02, 1, 0.12).normalize() });
  if (options.preferTop) directions.unshift(directions.pop()!);

  let fallback: FrameResult | null = null;
  for (const { name, dir } of directions) {
    let distance = Math.max(options.minDistance ?? 6, radius * 1.6);
    let position = center.clone().add(dir.clone().multiplyScalar(distance));
    let target = center.clone();
    for (let i = 0; i < 40; i += 1) {
      // Pan the target so the free area's centre, not the canvas centre, looks at the bounds' centre.
      const viewHeightWorld = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const pixel = viewHeightWorld / view.height;
      const right = new THREE.Vector3().crossVectors(dir.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, dir.clone().negate()).normalize();
      target = center.clone().sub(right.clone().multiplyScalar(freeCenterX * pixel)).add(up.clone().multiplyScalar(freeCenterY * pixel));
      position = target.clone().add(dir.clone().multiplyScalar(distance));
      if (fits(project(points, position, target, camera, view), view)) break;
      distance *= 1.12;
    }
    const occluded = occludedFrom(position, samples);
    const result = { position: position.toArray() as Vec3, target: target.toArray() as Vec3, direction: name, reused: false, occluded };
    if (!occluded) return result;
    fallback ??= result;
  }
  return fallback;
}

/** For checks: does the current camera show all `targets` inside the free area, unobstructed? */
export function inspectView(targets: Vec3[]) {
  if (!rig) return null;
  const box = rig.dom.getBoundingClientRect();
  const view: Viewport = { width: box.width, height: box.height, insets: measureInsets(), margin: 0 };
  const pose = currentPose()!;
  const points = targets.map((p) => new THREE.Vector3(...p));
  const screen = project(points, new THREE.Vector3(...pose.position), new THREE.Vector3(...pose.target), rig.camera, view);
  return { inside: fits(screen, view), occluded: occludedFrom(new THREE.Vector3(...pose.position), points), screen, insets: view.insets };
}
