import { CLASSROOMS, FLOOR_COUNT, FLOOR_HEIGHT, STUDENT_BODY_HEIGHT } from "../building1/building1Data";
import type { FireSource, Vec3 } from "./types";

export interface FlameCell {
  position: Vec3;
  radius: number;
  height: number;
  floor: number;
  seed: number;
}
export const FLAME_CONTACT_CORE = .72;
export const AGENT_BODY_HEIGHT = STUDENT_BODY_HEIGHT;

export function fireFloorAt(y: number): number {
  return y < FLOOR_HEIGHT * .55 ? 1 : Math.max(1, Math.min(FLOOR_COUNT, Math.floor((y + .15) / FLOOR_HEIGHT) + 1));
}

export function fireRadiusAt(fire: FireSource, time: number): number {
  if (!fire.enabled || time < fire.startTime) return 0;
  const age = Math.max(0, time - fire.startTime);
  const seed = Math.min(.16, fire.fireRadius * .34);
  const growth = Math.max(.045, Math.min(.13, .055 + fire.spreadRate * 1.5));
  return seed + (fire.fireRadius - seed) * (1 - Math.exp(-age * growth));
}

export function smokeRadiusAt(fire: FireSource, time: number): number {
  if (!fire.enabled || time < fire.startTime) return 0;
  const age = Math.max(0, time - fire.startTime);
  return fire.smokeRadius * (.28 + .72 * (1 - Math.exp(-age * Math.max(.055, Math.min(.24, .07 + fire.spreadRate * 1.8)))));
}

export function spreadProgressAt(fire: FireSource, time: number): number {
  if (fire.origin !== "spread" || fire.spreadTravelStartTime == null || fire.startTime <= fire.spreadTravelStartTime) return 1;
  return Math.max(0, Math.min(1, (time - fire.spreadTravelStartTime) / (fire.startTime - fire.spreadTravelStartTime)));
}

export function fireHasStarted(fire: FireSource, time: number): boolean {
  return fire.enabled && time >= Math.min(fire.startTime, fire.spreadTravelStartTime ?? fire.startTime);
}

interface Layout {
  signature: string;
  baseSignature: string;
  path?: Vec3[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
  trail: { position: Vec3; distance: number }[];
  length: number;
  floors: number[];
  fuelBounds?: [number, number, number, number];
}
const layouts = new WeakMap<FireSource, Layout>();
const snapshots = new WeakMap<FireSource, { signature: string; values: Map<number, FlameCell[]> }>();
let layoutVersion = 0;

function layoutFor(fire: FireSource): Layout {
  const baseSignature = fire.position.join(",") + "|" + fire.fireRadius;
  const previous = layouts.get(fire);
  if (previous?.baseSignature === baseSignature && previous.path === fire.spreadPath) return previous;
  const signature = baseSignature + "|" + ++layoutVersion;
  const trail: Layout["trail"] = [];
  const path = fire.spreadPath?.length ? fire.spreadPath : [fire.position];
  let length = 0;
  if (path.length > 1) trail.push({ position: path[0], distance: 0 });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const count = Math.max(1, Math.ceil(d / .32));
    for (let j = 1; j <= count; j++) {
      const t = j / count;
      trail.push({ position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], distance: length + d * t });
    }
    length += d;
  }
  const all = [...path, fire.position];
  const bounds = {
    minX: Math.min(...all.map((p) => p[0])), maxX: Math.max(...all.map((p) => p[0])),
    minZ: Math.min(...all.map((p) => p[2])), maxZ: Math.max(...all.map((p) => p[2])),
    minY: Math.min(...all.map((p) => p[1])), maxY: Math.max(...all.map((p) => p[1])),
  };
  let fuelBounds: Layout["fuelBounds"];
  if (fire.floor > 0) {
    const [x, , z] = fire.position;
    const room = CLASSROOMS.find((room) => room.floor === fire.floor && (room.side === "pink"
      ? Math.abs(x - room.position[0]) < 3.9 && z > -9.77 && z < .04
      : Math.abs(z - room.position[2]) < 3.9 && x > .20 && x < 9.77));
    if (room) fuelBounds = room.side === "pink" ? [room.position[0] - 3.9, room.position[0] + 3.9, -9.77, .04]
      : [.20, 9.77, room.position[2] - 3.9, room.position[2] + 3.9];
    else if (x > -52 && x < -4 && z >= .3 && z < 3.48) fuelBounds = [-52, -4, .3, 3.48];
    else if (z > 4 && z < 52 && x > -3.48 && x <= .04) fuelBounds = [-3.48, .04, 4, 52];
  }
  const floors = [...new Set([fire.floor, ...path.map((p) => fireFloorAt(p[1]))])];
  const result = { signature, baseSignature, path: fire.spreadPath, bounds, trail, length, floors, fuelBounds };
  layouts.set(fire, result);
  return result;
}

export function fireCanAffectFloor(fire: FireSource, floor: number): boolean {
  return layoutFor(fire).floors.includes(floor);
}

/** Coarse path bounds include the moving front, not just the unlit target. */
export function fireMayAffectPoint(fire: FireSource, point: Vec3, margin = 0): boolean {
  const b = layoutFor(fire).bounds;
  const reach = Math.max(fire.smokeRadius, fire.fireRadius * 2.9, 1.2) + margin;
  return point[0] >= b.minX - reach && point[0] <= b.maxX + reach
    && point[2] >= b.minZ - reach && point[2] <= b.maxZ + reach
    && point[1] >= b.minY - AGENT_BODY_HEIGHT - reach && point[1] <= b.maxY + reach;
}

/** Authoritative burning cells. Graphics and all contact tests consume this same list.
 * The trail remains alight after arrival; the destination starts as a small new flame.
 * Quality settings never remove a cell that can injure an occupant.
 */
export function flameCellsAt(fire: FireSource, time: number): FlameCell[] {
  if (!fireHasStarted(fire, time)) return [];
  const layout = layoutFor(fire);
  const signature = [layout.signature, fire.startTime, fire.spreadTravelStartTime, fire.intensity, fire.spreadRate, fire.floor].join("|");
  let cache = snapshots.get(fire);
  if (!cache || cache.signature !== signature) {
    cache = { signature, values: new Map() }; snapshots.set(fire, cache);
  }
  const cached = cache.values.get(time);
  if (cached) { cache.values.delete(time); cache.values.set(time, cached); return cached; }
  const cells: FlameCell[] = [];
  const add = (position: Vec3, radius: number, seed: number, floor = fire.floor) => {
    if (radius < .012) return;
    cells.push({ position, radius, height: Math.min(2.35, (.32 + Math.sqrt(radius / .42) * (1.0 + Math.sqrt(Math.max(.05, fire.intensity)) * .4)) * (.76 + (Math.abs(seed * 37) % 101) / 101 * .4)),
      floor, seed });
  };
  if (layout.trail.length && fire.spreadTravelStartTime != null) {
    const duration = Math.max(.01, fire.startTime - fire.spreadTravelStartTime);
    const elapsed = time - fire.spreadTravelStartTime;
    for (let i = 0; i < layout.trail.length; i++) {
      const sample = layout.trail[i];
      const age = elapsed - duration * sample.distance / Math.max(.001, layout.length);
      if (age <= 0) continue;
      add(sample.position, .30 * (1 - Math.exp(-age * 1.8)), i + 509, fire.floor === 0 ? 0 : fireFloorAt(sample.position[1]));
    }
  }
  const radius = fireRadiusAt(fire, time);
  if (radius > 0) {
    const patchRadius = Math.max(.16, Math.min(.48, fire.fireRadius / 7));
    const spacing = patchRadius * 1.25;
    const rows = Math.ceil(radius / (spacing * .8660254));
    for (let row = -rows; row <= rows; row++) for (let col = -rows; col <= rows; col++) {
      const x = (col + (Math.abs(row) % 2) * .5) * spacing;
      const z = row * spacing * .8660254;
      const d = Math.hypot(x, z);
      if (d >= radius) continue;
      const px = fire.position[0] + x, pz = fire.position[2] + z;
      const b = layout.fuelBounds;
      const wallClearance = b ? Math.min(px - b[0], b[1] - px, pz - b[2], b[3] - pz) : Infinity;
      add([px, fire.position[1], pz], Math.min(patchRadius, radius - d, wallClearance), (row + 128) * 97 + col + 128);
    }
  }
  // Exact times, never rounded: a fast-forward frame cannot use a future contact shape.
  if (cache.values.size >= 32) cache.values.delete(cache.values.keys().next().value!);
  cache.values.set(time, cells);
  return cells;
}

export function cellContactRadius(cell: FlameCell, feetY: number): number {
  const lowestBody = Math.max(feetY + .04, cell.position[1] + .015);
  // The shader's shortest height is .90 and maximum radial tip deflection is
  // sqrt(.16² + .13²) < .21. This inner envelope stays inside it at every phase.
  const q = (lowestBody - cell.position[1]) / (cell.height * .90);
  const visibleInnerRadius = 1 - q - .21 * q * q;
  if (visibleInnerRadius <= 0 || feetY + AGENT_BODY_HEIGHT <= cell.position[1]) return -1;
  return cell.radius * FLAME_CONTACT_CORE * visibleInnerRadius;
}

export function flameClearanceAt(point: Vec3, fires: FireSource[], time: number, bodyRadius = .18): number {
  let clearance = Infinity;
  const floor = fireFloorAt(point[1]);
  for (const fire of fires) {
    if (!fireHasStarted(fire, time) || !fireMayAffectPoint(fire, point, bodyRadius)) continue;
    for (const cell of flameCellsAt(fire, time)) {
      if (cell.floor > 0 && cell.floor !== floor) continue;
      const r = cellContactRadius(cell, point[1]);
      if (r < 0) continue;
      clearance = Math.min(clearance, Math.hypot(point[0] - cell.position[0], point[2] - cell.position[2]) - r - bodyRadius);
    }
  }
  return clearance;
}

/** Swept body against the same tapered visible flames, including active travelling cells. */
export function bodySegmentTouchesFlame(from: Vec3, to: Vec3, fires: FireSource[], time: number, padding = .18): boolean {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const horizontalSq = dx * dx + dz * dz;
  for (const fire of fires) {
    if (!fireHasStarted(fire, time)) continue;
    // Do not cull by endpoints: a long safe-to-safe edge can cross a small fire.
    const b = layoutFor(fire).bounds;
    const reach = Math.max(fire.fireRadius, .32) + padding;
    if (Math.min(from[0], to[0]) > b.maxX + reach || Math.max(from[0], to[0]) < b.minX - reach
      || Math.min(from[2], to[2]) > b.maxZ + reach || Math.max(from[2], to[2]) < b.minZ - reach) continue;
    if (fire.origin === "primary") {
      const t = horizontalSq < 1e-10 ? 0 : Math.max(0, Math.min(1, ((fire.position[0] - from[0]) * dx + (fire.position[2] - from[2]) * dz) / horizontalSq));
      if (Math.hypot(from[0] + dx * t - fire.position[0], from[2] + dz * t - fire.position[2]) > fireRadiusAt(fire, time) + padding) continue;
    }
    for (const cell of flameCellsAt(fire, time)) {
      const rMax = cell.radius + padding;
      if (Math.min(from[0], to[0]) > cell.position[0] + rMax || Math.max(from[0], to[0]) < cell.position[0] - rMax
        || Math.min(from[2], to[2]) > cell.position[2] + rMax || Math.max(from[2], to[2]) < cell.position[2] - rMax) continue;
      let lo = 0, hi = 1;
      if (Math.abs(dy) > 1e-8) {
        const a = (cell.position[1] - AGENT_BODY_HEIGHT - from[1]) / dy;
        const b = (cell.position[1] + cell.height - .04 - from[1]) / dy;
        lo = Math.max(0, Math.min(a, b)); hi = Math.min(1, Math.max(a, b));
        if (lo > hi) continue;
      }
      const t = Math.max(lo, Math.min(hi, horizontalSq < 1e-10 ? lo : ((cell.position[0] - from[0]) * dx + (cell.position[2] - from[2]) * dz) / horizontalSq));
      const y = from[1] + dy * t;
      if (cell.floor > 0 && fireFloorAt(y) !== cell.floor) continue;
      const r = cellContactRadius(cell, y);
      if (r >= 0 && Math.hypot(from[0] + dx * t - cell.position[0], from[2] + dz * t - cell.position[2]) <= r + padding) return true;
    }
  }
  return false;
}
