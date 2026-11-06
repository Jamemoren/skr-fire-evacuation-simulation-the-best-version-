/**
 * Movement of the person the user controls in the roleplay simulator.
 *
 * The player walks on exactly the walkable geometry the simulated crowd uses: the corridor around
 * every passage of the evacuation graph (`pointInsideWalkableCorridor`, including the stair-void and
 * lift-bank exclusions and the exterior building guard) plus the interior of each classroom. There
 * is no second collision model that could disagree with the calibration.
 *
 * - The player always stands on one "support" (a passage or a classroom). A step may only move onto
 *   the current support or a support that touches it (shares a graph node), so a floor can never be
 *   skipped and a stacked flight of a switchback stair is never confused with the one above it.
 * - Height follows the support: on a stair flight it is the height of the walking line at the
 *   nearest point, so the player walks up and down stairs and over the bridge; on a floor it is the
 *   floor's walking height. Nobody flies or falls through a slab.
 * - Each frame's motion is split into ≤ 6 cm sub-steps; a blocked sub-step slides along the
 *   blocking edge (one axis at a time) instead of passing through it.
 */
import { createEvacuationGraph, traversalPoints, walkY } from "../simulation/graph";
import { pointInsideWalkableCorridor } from "../simulation/walkable";
import { ALL_CLASSROOMS } from "../simulation/campusData";
import { getMapRegistry } from "../evac/mapRegistry";
import type { SimEdge, SimGraph, SimNode, Vec3 } from "../simulation/types";

export interface RoomBox {
  id: string;
  nodeId: string;
  buildingId: string;
  floor: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
  name: string;
}

export type Support =
  | { kind: "edge"; id: string; edge: SimEdge; path: Vec3[] }
  | { kind: "room"; id: string; room: RoomBox };

export interface WalkWorld {
  graph: SimGraph;
  nodeMap: Map<string, SimNode>;
  supports: Map<string, Support>;
  neighbours: Map<string, Support[]>;
  roomsByNode: Map<string, RoomBox>;
}

/** Largest height change accepted in one sub-step (stairs climb ≤ ~0.04 m per 6 cm). */
const MAX_STEP_RISE = 0.22;
/** Width (m) over which the heights of two nearly equally near path segments are blended. */
const BLEND_WIDTH = 0.35;
/** Path segments further than this (m) above or below the current height are other flights. */
const SEGMENT_HEIGHT_WINDOW = 0.6;
const SUB_STEP = 0.06;
/** Eye height above the walking line (the line itself is 0.2 m above the slab top). */
export const EYE_HEIGHT = 1.42;

/** Speed factor of the ground the player stands on (stairs are slower, as for the crowd). */
export function surfaceSpeedFactor(support: Support): number {
  return support.kind === "edge" ? Math.max(0.35, Math.min(1, support.edge.speedMultiplier || 1)) : 1;
}

function classroomBox(room: (typeof ALL_CLASSROOMS)[number]): RoomBox {
  const inset = 0.4;
  if (room.walkPosition) {
    return {
      id: `room:${room.id}`, nodeId: room.id, buildingId: room.buildingId ?? "building-1", floor: room.floor, name: room.name,
      minX: room.position[0] - room.size[0] / 2 + inset, maxX: room.position[0] + room.size[0] / 2 - inset,
      minZ: room.position[2] - room.size[2] / 2 + inset, maxZ: room.position[2] + room.size[2] / 2 - inset,
      y: room.walkPosition[1],
    };
  }
  // Building 1: the same interior extents the existing walk mode uses, shrunk by a body radius.
  const y = walkY(room.floor);
  return room.side === "pink"
    ? { id: `room:${room.id}`, nodeId: room.id, buildingId: "building-1", floor: room.floor, name: room.name, minX: room.position[0] - 3.54, maxX: room.position[0] + 3.54, minZ: -9.37, maxZ: -0.44, y }
    : { id: `room:${room.id}`, nodeId: room.id, buildingId: "building-1", floor: room.floor, name: room.name, minX: 0.64, maxX: 9.37, minZ: room.position[2] - 3.54, maxZ: room.position[2] + 3.54, y };
}

let cachedWorld: WalkWorld | null = null;

/** The walkable world (built once; the evacuation graph geometry is fixed). */
export function walkWorld(graph: SimGraph = createEvacuationGraph()): WalkWorld {
  if (cachedWorld && cachedWorld.graph.nodes.length === graph.nodes.length && cachedWorld.graph.edges.length === graph.edges.length) return cachedWorld;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const supports = new Map<string, Support>();
  const byNode = new Map<string, Support[]>();
  const add = (nodeId: string, support: Support) => (byNode.get(nodeId) ?? byNode.set(nodeId, []).get(nodeId)!).push(support);
  for (const edge of graph.edges) {
    const path = traversalPoints(edge, nodeMap, edge.from, edge.to);
    if (path.length < 2) continue;
    const support: Support = { kind: "edge", id: `edge:${edge.id}`, edge, path };
    supports.set(support.id, support);
    add(edge.from, support);
    add(edge.to, support);
  }
  const roomsByNode = new Map<string, RoomBox>();
  for (const room of ALL_CLASSROOMS) {
    if (!nodeMap.has(room.id)) continue;
    const box = classroomBox(room);
    const support: Support = { kind: "room", id: box.id, room: box };
    supports.set(support.id, support);
    roomsByNode.set(room.id, box);
    add(room.id, support);
  }
  // Supports touching this one (share a node), and those touching them: short connector passages
  // (a stair access, a door) can be narrower than the space where two walkways actually overlap.
  // Height continuity in tryStep still rules out any jump between floors.
  const direct = new Map<string, Support[]>();
  supports.forEach((support) => {
    const ends = support.kind === "edge" ? [support.edge.from, support.edge.to] : [support.room.nodeId];
    const list = new Map<string, Support>();
    for (const nodeId of ends) for (const other of byNode.get(nodeId) ?? []) list.set(other.id, other);
    direct.set(support.id, [...list.values()]);
  });
  const neighbours = new Map<string, Support[]>();
  direct.forEach((first, id) => {
    const list = new Map<string, Support>();
    for (const support of first) { list.set(support.id, support); for (const second of direct.get(support.id) ?? []) list.set(second.id, second); }
    neighbours.set(id, [...list.values()]);
  });
  cachedWorld = { graph, nodeMap, supports, neighbours, roomsByNode };
  return cachedWorld;
}

function closestOnPath(point: Vec3, path: Vec3[]) {
  let best = { point: path[0], distance: Infinity, along: 0, segment: 0 };
  let travelled = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1], b = path[index];
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const length2 = abx * abx + aby * aby + abz * abz;
    const t = length2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby + (point[2] - a[2]) * abz) / length2));
    const q: Vec3 = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
    const distance = Math.hypot(point[0] - q[0], point[1] - q[1], point[2] - q[2]);
    const length = Math.sqrt(length2);
    if (distance < best.distance) best = { point: q, distance, along: travelled + length * t, segment: index - 1 };
    travelled += length;
  }
  return best;
}

/**
 * Height of the walking line under (x, z). Each segment is projected in plan (so the height follows
 * the slope continuously instead of jumping at a 3D corner). The segment nearest in plan wins; height
 * only breaks ties at landings. Flights of other floors are other supports, which tryStep rejects by
 * the step-rise limit, so the flight above or below is never picked.
 */
function heightOnPath(x: number, z: number, fromY: number, path: Vec3[]): number | null {
  const candidates: Array<{ score: number; y: number }> = [];
  let best = Infinity;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1], b = path[index];
    const abx = b[0] - a[0], abz = b[2] - a[2];
    const length2 = abx * abx + abz * abz;
    const t = length2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / length2));
    const px = a[0] + abx * t, pz = a[2] + abz * t, py = a[1] + (b[1] - a[1]) * t;
    // A switchback stair starts and ends at the same place in plan, a storey apart: only segments
    // within a step of the current height count.
    if (Math.abs(py - fromY) > SEGMENT_HEIGHT_WINDOW) continue;
    const score = Math.hypot(x - px, z - pz) + 0.1 * Math.abs(py - fromY);
    candidates.push({ score, y: py });
    best = Math.min(best, score);
  }
  if (!candidates.length) return null;
  // Blend segments that are almost equally near (a landing corner), so the height never jumps when
  // the nearest segment changes. The weights are continuous in (x, z), so the height is too.
  let sum = 0, weight = 0;
  for (const candidate of candidates) {
    const gap = candidate.score - best;
    if (gap > BLEND_WIDTH) continue;
    const w = 1 - gap / BLEND_WIDTH;
    sum += w * w * candidate.y; weight += w * w;
  }
  return sum / weight;
}

/** Height the player would stand at on `support` at (x, z), coming from height `fromY`. Null if not on it. */
export function standOn(support: Support, x: number, z: number, fromY: number): number | null {
  if (support.kind === "room") {
    const r = support.room;
    return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ ? r.y : null;
  }
  // Nearest point of the walking line, judged in 3D from the current height so that the flight
  // above or below on a switchback stair is never picked.
  const y = heightOnPath(x, z, fromY, support.path);
  if (y === null) return null;
  return pointInsideWalkableCorridor([x, y, z], support.path, support.edge) ? y : null;
}

/** Every support that contains this point at about this height (used to place/validate a spawn). */
export function supportsAt(world: WalkWorld, point: Vec3, tolerance = 0.6): Array<{ support: Support; y: number }> {
  const found: Array<{ support: Support; y: number }> = [];
  world.supports.forEach((support) => {
    const y = standOn(support, point[0], point[2], point[1]);
    if (y !== null && Math.abs(y - point[1]) <= tolerance) found.push({ support, y });
  });
  return found.sort((a, b) => Math.abs(a.y - point[1]) - Math.abs(b.y - point[1]) || (a.support.kind === "room" ? -1 : 1));
}

export interface MotionResult {
  /** Horizontal distance actually travelled (m). */
  travelled: number;
  /** True when part of the requested motion was stopped by a wall, void or person. */
  blocked: boolean;
}

export class PlayerNavigator {
  readonly world: WalkWorld;
  position: Vec3;
  support: Support;

  constructor(world: WalkWorld, position: Vec3, support: Support) {
    this.world = world;
    this.position = [...position] as Vec3;
    this.support = support;
  }

  /** Place the player at a validated point. Returns null if the point is not walkable. */
  static at(world: WalkWorld, point: Vec3): PlayerNavigator | null {
    const [first] = supportsAt(world, point);
    if (!first) return null;
    return new PlayerNavigator(world, [point[0], first.y, point[2]], first.support);
  }

  tryStep(x: number, z: number, isBlockedByPerson?: (from: Vec3, to: Vec3) => boolean): boolean {
    const fromY = this.position[1];
    const candidates = [this.support, ...(this.world.neighbours.get(this.support.id) ?? []).filter((support) => support !== this.support)];
    let best: { support: Support; y: number } | null = null;
    for (const support of candidates) {
      const y = standOn(support, x, z, fromY);
      if (y === null || Math.abs(y - fromY) > MAX_STEP_RISE) continue;
      if (support === this.support) { best = { support, y }; break; }
      if (!best || Math.abs(y - fromY) < Math.abs(best.y - fromY)) best = { support, y };
    }
    if (!best) return false;
    const next: Vec3 = [x, best.y, z];
    if (isBlockedByPerson?.(this.position, next)) return false;
    this.position = next;
    this.support = best.support;
    return true;
  }

  /**
   * Move by (dx, dz) metres in the horizontal plane. The caller limits dx/dz to speed × dt with a
   * capped dt, so a dropped frame can never produce a long jump.
   */
  move(dx: number, dz: number, isBlockedByPerson?: (from: Vec3, to: Vec3) => boolean): MotionResult {
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return { travelled: 0, blocked: false };
    const steps = Math.max(1, Math.ceil(length / SUB_STEP));
    const sx = dx / steps, sz = dz / steps;
    let travelled = 0;
    let blocked = false;
    for (let step = 0; step < steps; step += 1) {
      const [x, , z] = this.position;
      if (this.tryStep(x + sx, z + sz, isBlockedByPerson)) { travelled += Math.hypot(sx, sz); continue; }
      blocked = true;
      // Slide along whatever blocks the way: try each axis on its own.
      let slid = false;
      if (Math.abs(sx) > 1e-6 && this.tryStep(x + sx, z, isBlockedByPerson)) { travelled += Math.abs(sx); slid = true; }
      const [x2] = this.position;
      if (Math.abs(sz) > 1e-6 && this.tryStep(x2, z + sz, isBlockedByPerson)) { travelled += Math.abs(sz); slid = true; }
      if (!slid) {
        // Into a corner (both axes blocked): glance off it, as a person steps around the edge of a
        // landing — the same step length, turned up to 70°, never through the wall.
        const length = Math.hypot(sx, sz);
        for (const turn of [0.6, -0.6, 1.2, -1.2]) {
          const c = Math.cos(turn), s2 = Math.sin(turn);
          const rx = (sx * c - sz * s2) * 0.8, rz = (sx * s2 + sz * c) * 0.8;
          if (this.tryStep(x + rx, z + rz, isBlockedByPerson)) { travelled += length * 0.8; slid = true; break; }
        }
      }
      if (!slid) break;
    }
    return { travelled, blocked };
  }

  /**
   * Could the character walk in a straight line from where it stands to `target` (plan), with no
   * wall, void or floor change in the way? Probes a copy; the character itself does not move.
   */
  canWalkStraightTo(target: Vec3): boolean {
    const probe = new PlayerNavigator(this.world, this.position, this.support);
    const dx = target[0] - this.position[0], dz = target[2] - this.position[2];
    const length = Math.hypot(dx, dz);
    if (length < 0.05) return true;
    const steps = Math.ceil(length / SUB_STEP);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      if (!probe.tryStep(this.position[0] + dx * t, this.position[2] + dz * t)) return false;
    }
    return Math.abs(probe.position[1] - target[1]) < 1.2;
  }

  /** Graph node nearest to the player along the support they stand on (what the phone reports). */
  nearestNode(): string {
    const support = this.support;
    if (support.kind === "room") return support.room.nodeId;
    const nearest = closestOnPath(this.position, support.path);
    const total = support.path.reduce((sum, point, index) => index ? sum + Math.hypot(point[0] - support.path[index - 1][0], point[1] - support.path[index - 1][1], point[2] - support.path[index - 1][2]) : 0, 0);
    return nearest.along <= total / 2 ? support.edge.from : support.edge.to;
  }

  /** Building and floor from the support (never from x/z alone, which repeat on every floor). */
  place(): { buildingId: string; floor: number; nodeId: string } {
    const registry = getMapRegistry();
    const nodeId = this.nearestNode();
    if (this.support.kind === "room") return { buildingId: this.support.room.buildingId, floor: this.support.room.floor, nodeId };
    const node = this.world.nodeMap.get(nodeId);
    return { buildingId: registry.buildingOf.get(nodeId) ?? "site", floor: node?.floor ?? 1, nodeId };
  }
}

/**
 * Bearing (degrees, clockwise) of a target relative to where the player looks. 0 = straight ahead,
 * 90 = to the right, 180 = behind, -90 = to the left. Yaw follows three.js: yaw 0 looks along −Z,
 * positive yaw turns to the left (counter-clockwise seen from above).
 */
export function relativeBearing(from: Vec3, to: Vec3, yaw: number): number {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  // Absolute heading of the target, measured like the view: 0 along −Z, positive to the left.
  const targetYaw = Math.atan2(-dx, -dz);
  let delta = (yaw - targetYaw) * (180 / Math.PI);
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

/** Compass-free view heading (deg, clockwise from −Z) reported with the simulator position. */
export function headingDegFromYaw(yaw: number): number {
  let degrees = -yaw * (180 / Math.PI);
  while (degrees < 0) degrees += 360;
  while (degrees >= 360) degrees -= 360;
  return degrees;
}

/**
 * The next waypoint on the advised route, a few metres ahead along the walkway (so an arrow follows
 * the corridor and never points through a wall at the assembly area). Also reports whether that
 * stretch is a stair going up or down and to which floor.
 */
/**
 * The advised route as the character must walk it: when the character stands on a walkway that is
 * not part of the route (a stair flight that was just closed, a corridor it wandered into), that
 * walkway is walked first, back to the route's nearest node. The arrow then follows the walkway
 * instead of pointing straight at the route through a wall.
 */
export function routeFromSupport(support: Support, nodeIds: string[], edgeIds: string[]): { nodeIds: string[]; edgeIds: string[] } {
  if (support.kind !== "edge" || edgeIds.includes(support.edge.id) || !nodeIds.length) return { nodeIds, edgeIds };
  const { from, to } = support.edge;
  const at = [from, to].map((nodeId) => nodeIds.indexOf(nodeId)).filter((index) => index >= 0);
  if (!at.length) return { nodeIds, edgeIds };
  const join = Math.min(...at);
  const entry = nodeIds[join];
  const start = entry === from ? to : from;
  return { nodeIds: [start, ...nodeIds.slice(join)], edgeIds: [support.edge.id, ...edgeIds.slice(join)] };
}

export function routeLookahead(world: WalkWorld, nodeIds: string[], edgeIds: string[], position: Vec3, ahead = 3) {
  const polyline: Vec3[] = [];
  const floorAt: number[] = [];
  for (let index = 0; index < edgeIds.length; index += 1) {
    const support = world.supports.get(`edge:${edgeIds[index]}`);
    if (!support || support.kind !== "edge") return null;
    const forward = support.edge.from === nodeIds[index];
    const path = forward ? support.path : [...support.path].reverse();
    const toFloor = world.nodeMap.get(nodeIds[index + 1])?.floor ?? 1;
    for (const point of path) {
      const last = polyline[polyline.length - 1];
      if (last && Math.hypot(last[0] - point[0], last[1] - point[1], last[2] - point[2]) < 1e-6) continue;
      polyline.push(point);
      floorAt.push(toFloor);
    }
  }
  // Drop short back-tracking spikes (a junction node a little off the line between the walkway in and
  // the walkway out): going to the node and turning back is not how anyone walks it, and the in and
  // out segments overlap, which would make "where am I on the route" flip between them.
  for (let index = 1; index < polyline.length - 1; ) {
    const a = polyline[index - 1], b = polyline[index], c = polyline[index + 1];
    const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - b[0], vz = c[2] - b[2];
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    const reverses = lu > 1e-6 && lv > 1e-6 && (ux * vx + uz * vz) / (lu * lv) < -0.85;
    if (reverses && Math.min(lu, lv) < 1.2 && Math.abs(c[1] - a[1]) < 0.3) { polyline.splice(index, 1); floorAt.splice(index, 1); index = Math.max(1, index - 1); }
    else index += 1;
  }
  if (polyline.length < 2) return null;
  const nearest = closestOnPath(position, polyline);
  let remaining = ahead;
  let index = nearest.segment;
  let from = nearest.point;
  let target = polyline[polyline.length - 1];
  const heading = (a: Vec3, b: Vec3) => Math.atan2(b[0] - a[0], b[2] - a[2]);
  while (index < polyline.length - 1) {
    const to = polyline[index + 1];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (length >= remaining) {
      const t = remaining / Math.max(1e-6, length);
      target = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
      break;
    }
    remaining -= length;
    const passed = ahead - remaining;
    // Stop at a sharp turn of the walkway (a stair landing, a corner): a point beyond it would be
    // behind a wall, and an arrow towards it would point through that wall.
    const after = polyline[index + 2];
    if (after && Math.hypot(to[0] - from[0], to[2] - from[2]) > 0.05 && Math.hypot(after[0] - to[0], after[2] - to[2]) > 0.05) {
      let turn = Math.abs(heading(to, after) - heading(from, to));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      // (Only once the turn is a little way ahead — a turn right where the person stands is taken.)
      if (turn > Math.PI / 3 && passed > 0.4) { target = to; index += 1; break; }
    }
    from = to;
    index += 1;
  }
  const rise = target[1] - nearest.point[1];
  const vertical = rise > 0.4 ? "up" as const : rise < -0.4 ? "down" as const : null;
  let total = 0;
  for (let i = 1; i < polyline.length; i += 1) total += Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1], polyline[i][2] - polyline[i - 1][2]);
  return {
    waypoint: target,
    /** Metres left along the advised walkway to its end (the assembly area). */
    remainingM: Math.max(0, total - nearest.along),
    /** Where the route line is nearest, and the corners of that piece of it (fallback aims). */
    onRoute: nearest.point,
    corners: [polyline[nearest.segment], polyline[Math.min(polyline.length - 1, nearest.segment + 1)]] as [Vec3, Vec3],
    /** How far the player is from the route line (m): large = off route. */
    offRoute: nearest.distance,
    vertical,
    targetFloor: floorAt[Math.min(floorAt.length - 1, index + 1)] ?? null,
  };
}

/**
 * Lookahead used by the game and its tests: along the advised route; when the character is clearly
 * off it (> 1 m) on a walkway that leads back to it, along that walkway first (routeFromSupport).
 */
export function guideLookahead(world: WalkWorld, support: Support, nodeIds: string[], edgeIds: string[], position: Vec3, ahead = 3) {
  const direct = routeLookahead(world, nodeIds, edgeIds, position, ahead);
  const route = direct && direct.offRoute <= 1 ? { nodeIds, edgeIds } : routeFromSupport(support, nodeIds, edgeIds);
  const first = route.nodeIds === nodeIds ? direct : routeLookahead(world, route.nodeIds, route.edgeIds, position, ahead) ?? direct;
  if (!first) return null;
  // The arrow must never point through a wall: if the straight line to the waypoint is not
  // walkable (cutting the inside of a landing or corner), aim at a nearer point of the walkway.
  const probe = new PlayerNavigator(world, position, support);
  if (probe.canWalkStraightTo(first.waypoint)) return first;
  for (const nearer of [2, 1.4, 0.9, 0.5, 0.25]) {
    if (nearer >= ahead) continue;
    const candidate = routeLookahead(world, route.nodeIds, route.edgeIds, position, nearer);
    if (candidate && probe.canWalkStraightTo(candidate.waypoint)) return { ...candidate, remainingM: first.remainingM };
  }
  // Wedged in a corner of a landing: aim back at the route line or the corner it turns at.
  for (const aim of [first.onRoute, ...first.corners]) {
    if (probe.canWalkStraightTo(aim)) return { ...first, waypoint: aim };
  }
  return first;
}
