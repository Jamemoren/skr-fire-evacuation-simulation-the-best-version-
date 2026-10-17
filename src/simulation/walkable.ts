import { BLUE_END_TOWER_CENTER, PINK_END_TOWER_CENTER, CORE_LIFT_X, CORE_LIFT_Z, CORE_LIFT_SIZE, STAIR_ZONE_CENTERS, STAIR_FLOOR_OPENING_SIZE, CENTRAL_STAIR_FLOOR_OPENING_SIZE, STAIR_ACCESS_MIN_Z, type StairZone } from "../building1/building1Data";
import type { SimEdge, Vec3 } from "./types";

const EPS = 1e-6;

export const PEDESTRIAN_RADIUS = 0.18;

export function walkableHalfWidth(edge: SimEdge): number {
  const shoulder = edge.kind === "outdoor" ? 3 : edge.kind === "assembly" ? 2.5 : 0;
  const width = Math.max(0.32, edge.width * 0.5 - PEDESTRIAN_RADIUS + shoulder);
  return edge.kind === "stair" ? Math.min(0.62, width) : width;
}

function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function distancePointSegment(point: Vec3, a: Vec3, b: Vec3): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = point[0] - a[0];
  const apy = point[1] - a[1];
  const apz = point[2] - a[2];
  const denom = abx * abx + aby * aby + abz * abz;
  if (denom < EPS) return Math.sqrt(distanceSq(point, a));
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / denom));
  const nearest: Vec3 = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
  return Math.sqrt(distanceSq(point, nearest));
}

function insideFootprint(point: Vec3, center: Vec3, width: number, depth: number): boolean {
  const inset = 0.04;
  return point[0] > center[0] - width / 2 + inset
    && point[0] < center[0] + width / 2 - inset
    && point[2] > center[2] - depth / 2 + inset
    && point[2] < center[2] + depth / 2 - inset;
}

/** Exterior pedestrians may never occupy the solid footprint of either end tower. */
export function pointClearsExteriorBuilding(point: Vec3): boolean {
  return !insideFootprint(point, PINK_END_TOWER_CENTER, 8.5, 15)
    && !insideFootprint(point, BLUE_END_TOWER_CENTER, 15, 8.5);
}

/** The lift bank is a solid obstacle; the open connector runs in front of it. */
export function pointClearsCentralLiftBank(point: Vec3): boolean {
  return CORE_LIFT_X.every((x) => !(Math.abs(point[0] - x) < CORE_LIFT_SIZE[0] / 2 + PEDESTRIAN_RADIUS
    && Math.abs(point[2] - CORE_LIFT_Z) < CORE_LIFT_SIZE[2] / 2 + PEDESTRIAN_RADIUS));
}

/** Floor traffic stays on the front apron; only a stair edge may enter the void. */
export function pointClearsStairVoid(point: Vec3): boolean {
  return (Object.keys(STAIR_ZONE_CENTERS) as StairZone[]).every((zone) => {
    const center = STAIR_ZONE_CENTERS[zone];
    const dx = point[0] - center[0], dz = point[2] - center[2];
    const x = zone === "right" ? -dz : dx;
    const z = zone === "right" ? dx : dz;
    const depth = zone === "center" ? CENTRAL_STAIR_FLOOR_OPENING_SIZE[1] : STAIR_FLOOR_OPENING_SIZE[1];
    return Math.abs(x) >= STAIR_FLOOR_OPENING_SIZE[0] / 2 + PEDESTRIAN_RADIUS
      || z <= -depth / 2 - PEDESTRIAN_RADIUS
      || z >= STAIR_ACCESS_MIN_Z + PEDESTRIAN_RADIUS;
  });
}

/**
 * Defensive collision guard for simulated pedestrians.
 * Every indoor pedestrian is constrained to the explicit walkable polyline of the
 * current room/corridor/stair edge. This is deliberately stricter than a visual
 * bounding-box check: an agent can only move where the navigation topology says a
 * person can physically walk.
 */
export function pointInsideWalkableCorridor(point: Vec3, path: Vec3[], edge: SimEdge): boolean {
  if (path.length < 2) return false;
  const exteriorTransition = edge.kind === "outdoor" || (edge.kind === "exit" && !edge.insideBuilding);
  if (edge.insideBuilding && edge.kind !== "room" && !pointClearsCentralLiftBank(point)) return false;
  if (edge.insideBuilding && edge.kind !== "stair" && !pointClearsStairVoid(point)) return false;
  let best = Infinity;
  for (let i = 1; i < path.length; i += 1) {
    best = Math.min(best, distancePointSegment(point, path[i - 1], path[i]));
  }

  // Keep a body-radius margin from walls/railings. Outdoor paths are intentionally wider.
  // Outdoor and assembly links represent a broad paved/track approach, not a corridor bounded by
  // walls. Give them a modest shoulder so agents can physically sidestep a point hazard while the
  // exterior-building footprint guard still prevents shortcuts through solid structures.
  const tolerance = walkableHalfWidth(edge);
  // An exterior exit begins just inside its physical door. Crowd lane offsets may leave a
  // shoulder less than one body-width behind that threshold, so the narrow, graph-verified
  // exit throat must remain valid until the pedestrian crosses the facade. Outdoor edges do
  // not receive this exception and can never pass through a building footprint.
  const insideVerifiedExitThroat = edge.kind === "exit" && !edge.insideBuilding && best <= tolerance + 0.025;
  if (exteriorTransition && !pointClearsExteriorBuilding(point) && !insideVerifiedExitThroat) return false;
  return best <= tolerance + 0.025;
}

export function movementSegmentIsContinuous(from: Vec3, to: Vec3, maxStep: number): boolean {
  return Math.sqrt(distanceSq(from, to)) <= Math.max(0.1, maxStep) + 0.05;
}

export function corridorSafetyMargin(edge: SimEdge): number {
  return Math.max(0.32, edge.width * 0.5 - 0.18);
}
