import {
  ASSEMBLY_ZONE_CAPACITY,
  ASSEMBLY_ZONE_OFFSETS,
  BLUE_ROOM_BAYS,
  CORE_OPEN_CONNECTOR_CENTER,
  CLASSROOMS,
  CLASSROOM_CAPACITY,
  FIELD_CENTER,
  FLOOR_COUNT,
  FLOOR_HEIGHT,
  PINK_ROOM_BAYS,
  STAIR_FIRST_STEP_Z,
  STAIR_ACCESS_NODE_Z,
  SLAB_THICKNESS,
  stairAccessPoint,
  stairWorldPoint,
  STAIR_FLIGHT_CENTER_OFFSET,
  STAIR_MID_LANDING_Z,
  STAIR_RISER,
  STAIR_SECOND_STEP_Z,
  STAIR_STEPS_PER_FLIGHT,
  STAIR_TREAD,
  STAIR_EXIT_DOOR_CENTERS,
  STAIR_EXIT_DOOR_WIDTH,
  balancedOccupancyAt,
  floorBase,
  type RoomModuleDefinition,
  type StairZone,
} from "../building1/building1Data";
import type {
  AgentPhase,
  AgentWing,
  FireSource,
  RouteBundle,
  RoutePath,
  RoutingPreset,
  SimEdge,
  SimGraph,
  SimNode,
  SimulationConfig,
  Vec3,
} from "./types";
import { PEDESTRIAN_RADIUS, pointInsideWalkableCorridor } from "./walkable";
import { fireRadiusAt, smokeRadiusAt, fireHasStarted, fireCanAffectFloor, flameCellsAt, cellContactRadius, fireMayAffectPoint, bodySegmentTouchesFlame } from "./fireField";
export { fireRadiusAt, smokeRadiusAt } from "./fireField";
import { edgeAllowsDetour, planFireDetour } from "./localNavigation";

const EPS = 1e-6;
export const DEFAULT_AMBIENT_TEMPERATURE_C = 29;
export const DEFAULT_HEAT_AVOID_THRESHOLD_C = 44;
export const DEFAULT_HARD_BLOCK_TEMPERATURE_C = 62;

/**
 * Converts the normalized radiant-heat field into an interpretable modeled temperature.
 * This is intentionally a simplified risk-mapping relationship, not CFD/FDS output.
 */
export function modeledTemperatureFromHeat(heat: number, ambientTemperatureC = DEFAULT_AMBIENT_TEMPERATURE_C): number {
  const normalized = Math.max(0, Number.isFinite(heat) ? heat : 0);
  return ambientTemperatureC + normalized * 48;
}

const WALK_Y_OFFSET = 0.2;
const PINK_CORRIDOR_Z = 1.86;
const BLUE_CORRIDOR_X = -1.86;
// The lift bank occupies the left half of the core. The evacuation junction sits
// on the open right-hand concourse so no route can cut through a lift shaft.
const JUNCTION_X = 1.2;
const JUNCTION_Z = 1.86;

export function walkY(floor: number): number {
  return Math.max(0.2, floorBase(Math.max(1, floor)) + WALK_Y_OFFSET);
}

export function floorFromY(y: number): number {
  if (y < FLOOR_HEIGHT * 0.55) return 1;
  return Math.max(1, Math.min(FLOOR_COUNT, Math.floor((y + 0.15) / FLOOR_HEIGHT) + 1));
}

export function classifyWing(position: Vec3): AgentWing {
  const [x, y, z] = position;
  if (z > 66 || y < 0.05) return z > 66 ? "outdoor" : "ground";
  if (x < -5 && z < 8) return "pink";
  if (z > 5 && x < 12) return "blue";
  return "core";
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function polylineDistance(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance3(points[i - 1], points[i]);
  return total;
}

/** Smoke and radiant heat are avoidance cues. Only visible flame cells set blocked. */
export function pointRisk(point: Vec3, fires: FireSource[], time: number, flamePadding = 0) {
  let fire = 0, smoke = 0, heat = 0, blocked = false;
  const floor = floorFromY(point[1]);
  for (const source of fires) {
    if (!fireHasStarted(source, time) || !fireMayAffectPoint(source, point, flamePadding)) continue;
    const sameFloor = source.floor === 0 || source.floor === floor;
    if (sameFloor && time >= source.startTime) {
      const distance = distance3(point, source.position);
      const fr = fireRadiusAt(source, time), sr = smokeRadiusAt(source, time);
      if (fr > 0) {
        fire = Math.max(fire, Math.max(0, 1 - distance / Math.max(EPS, fr * 1.65)) * source.intensity);
        heat = Math.max(heat, Math.pow(Math.max(0, 1 - distance / Math.max(EPS, fr * 2.75)), 1.55) * source.intensity);
      }
      if (sr > 0) smoke = Math.max(smoke, Math.max(0, 1 - distance / sr) * source.intensity);
    }
    // All primary cells are contained by this circle. Distant smoke/heat samples
    // need no per-cell contact work (important for route searches with 3,000 people).
    if (source.origin === "primary" && (!sameFloor || Math.hypot(point[0] - source.position[0], point[2] - source.position[2]) > fireRadiusAt(source, time) + flamePadding)) continue;
    for (const cell of flameCellsAt(source, time)) {
      if (cell.floor > 0 && cell.floor !== floor) continue;
      const horizontal = Math.hypot(point[0] - cell.position[0], point[2] - cell.position[2]);
      const contactRadius = cellContactRadius(cell, point[1]);
      if (contactRadius >= 0 && horizontal <= contactRadius + flamePadding) blocked = true;
      if (source.origin === "primary") continue;
      const d = Math.hypot(horizontal, Math.max(0, cell.position[1] - point[1] - .7));
      const cueReach = .8 + cell.radius * 3.2;
      fire = Math.max(fire, Math.max(0, 1 - d / cueReach) * source.intensity);
      heat = Math.max(heat, Math.pow(Math.max(0, 1 - d / (cueReach * 1.45)), 1.55) * source.intensity);
      if (source.origin === "spread") smoke = Math.max(smoke, Math.max(0, 1 - d / (cueReach * 1.8)) * source.intensity * .4);
    }
  }
  return { fire, smoke, heat, blocked };
}

/** Same occupied flame geometry as the renderer, tested over the entire movement. */
export function segmentTouchesFlame(from: Vec3, to: Vec3, fires: FireSource[], time: number, padding = PEDESTRIAN_RADIUS): boolean {
  return bodySegmentTouchesFlame(from, to, fires, time, padding);
}

function stairId(zone: StairZone, floor: number) {
  return `sim-stair-${zone}-f${floor}`;
}

function exitId(zone: StairZone) {
  return `sim-exit-${zone}`;
}

function stairExitDoorId(zone: StairZone) {
  return `sim-stair-exit-door-${zone}`;
}

function doorId(room: RoomModuleDefinition) {
  return `sim-door-${room.id}`;
}

function corridorId(side: "pink" | "blue", floor: number, bay: number) {
  return `sim-corr-${side}-f${floor}-b${bay}`;
}

function junctionId(floor: number) {
  return `sim-junction-f${floor}`;
}

export const SIM_EXIT_POSITIONS: Record<StairZone, Vec3> = {
  left: [-49, 0.2, 12],
  center: [-9, 0.2, 15],
  right: [11, 0.2, 48],
};

// Keep the assembly gate north of the blue end tower. The previous z=58 gate sat
// inside that tower's ground footprint and made the last outdoor leg cut a wall.
export const FIELD_GATE_POSITION: Vec3 = [FIELD_CENTER[0], 0.22, 67];
export const FIELD_GATE_LEFT_POSITION: Vec3 = [FIELD_CENTER[0] - 6, 0.22, 67];
export const FIELD_GATE_RIGHT_POSITION: Vec3 = [FIELD_CENTER[0] + 6, 0.22, 67];
const FIELD_GATE_VARIANTS = [
  { id: "sim-field-gate-left", label: "Assembly Gate Left", position: FIELD_GATE_LEFT_POSITION },
  { id: "sim-field-gate", label: "Assembly Gate Center", position: FIELD_GATE_POSITION },
  { id: "sim-field-gate-right", label: "Assembly Gate Right", position: FIELD_GATE_RIGHT_POSITION },
] as const;

function roomWalkPosition(room: RoomModuleDefinition): Vec3 {
  return [room.position[0], walkY(room.floor), room.position[2]];
}

function roomDoorPosition(room: RoomModuleDefinition): Vec3 {
  const y = walkY(room.floor);
  // The classroom door is intentionally offset toward the near-left bay of each
  // room facade. Keep this navigation portal on the model opening itself; using
  // the room centre here makes agents cross the glazed wall beside the door.
  return room.side === "pink"
    ? [room.position[0] - 2.25, y, -0.06]
    : [0.06, y, room.position[2] - 2.25];
}

function roomCorridorPosition(room: RoomModuleDefinition): Vec3 {
  const y = walkY(room.floor);
  return room.side === "pink"
    ? [room.position[0], y, PINK_CORRIDOR_Z]
    : [BLUE_CORRIDOR_X, y, room.position[2]];
}

/**
 * Exact evacuation traversal for the modeled 8 + landing + 8 switchback stair.
 * Returned order is always from upper-floor landing to lower-floor landing.
 */
export function stairDescentWaypoints(zone: StairZone, upperFloor: number): Vec3[] {
  const lowerFloor = upperFloor - 1;
  const lowerBase = floorBase(lowerFloor) + SLAB_THICKNESS;
  const lowerY = walkY(lowerFloor);
  const upperY = walkY(upperFloor);
  const halfHeight = STAIR_STEPS_PER_FLIGHT * STAIR_RISER;
  const firstX = -STAIR_FLIGHT_CENTER_OFFSET;
  const secondX = STAIR_FLIGHT_CENTER_OFFSET;
  const startZ = STAIR_FIRST_STEP_Z;
  const landingZ = STAIR_MID_LANDING_Z;
  const secondStartZ = STAIR_SECOND_STEP_Z;

  // Cross the supported upper access landing before reaching the first descending tread.
  // This approach segment also gives lane offsets room to merge before the 180° turn.
  const local: Vec3[] = [[0, upperY, STAIR_ACCESS_NODE_Z], [secondX, upperY, 1.55]];
  for (let step = STAIR_STEPS_PER_FLIGHT - 1; step >= 0; step -= 1) {
    local.push([
      secondX,
      lowerBase + halfHeight + (step + 1) * STAIR_RISER,
      secondStartZ + step * STAIR_TREAD,
    ]);
  }
  local.push([0, lowerBase + halfHeight + 0.03, landingZ]);
  local.push([firstX, lowerBase + halfHeight + 0.03, landingZ]);
  for (let step = STAIR_STEPS_PER_FLIGHT - 1; step >= 0; step -= 1) {
    local.push([
      firstX,
      lowerBase + (step + 1) * STAIR_RISER,
      startZ - step * STAIR_TREAD,
    ]);
  }
  local.push([firstX, lowerY, 1.55]);
  local.push([0, lowerY, STAIR_ACCESS_NODE_Z]);
  return local.map((point) => stairWorldPoint(zone, ...point));
}

function normalizedEdgePoints(edge: SimEdge, nodeMap: Map<string, SimNode>): Vec3[] {
  const from = nodeMap.get(edge.from)?.position;
  const to = nodeMap.get(edge.to)?.position;
  if (!from || !to) return [];
  const points: Vec3[] = [from];
  (edge.waypoints ?? []).forEach((point) => {
    if (distance3(points[points.length - 1], point) > 0.01) points.push(point);
  });
  if (distance3(points[points.length - 1], to) > 0.01) points.push(to);
  return points;
}

export function traversalPoints(edge: SimEdge, nodeMap: Map<string, SimNode>, currentNodeId: string, nextNodeId: string): Vec3[] {
  const points = normalizedEdgePoints(edge, nodeMap);
  if (!points.length) return [];
  if (edge.from === currentNodeId && edge.to === nextNodeId) return points;
  if (edge.twoWay && edge.to === currentNodeId && edge.from === nextNodeId) return [...points].reverse();
  return [];
}

function denseSamples(points: Vec3[], spacing = 1.4): Vec3[] {
  if (points.length < 2) return [...points];
  const result: Vec3[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const d = distance3(a, b);
    const n = Math.max(1, Math.ceil(d / spacing));
    for (let j = 1; j <= n; j += 1) result.push(lerp(a, b, j / n));
  }
  return result;
}

function computeEdgeRisk(edge: SimEdge, nodeMap: Map<string, SimNode>, fires: FireSource[], time: number) {
  const physicalPath = normalizedEdgePoints(edge, nodeMap);
  let points = denseSamples(physicalPath);
  if (!points.length) return { fire: 0, smoke: 0, heat: 0, modeledTemperatureC: DEFAULT_AMBIENT_TEMPERATURE_C, blocked: true, detourAvailable: false };
  // One edge occupies at most two adjacent floors. Filter once here instead of making every
  // dense sample scan all burning objects across all nine floors.
  const relevantFires = fires.filter((fire) => (
    fireCanAffectFloor(fire, edge.floorFrom)
    || fireCanAffectFloor(fire, edge.floorTo)
    || (fire.floor === 0 && (edge.floorFrom === 0 || edge.floorTo === 0 || edge.kind === "outdoor"))
  ));
  const clearance = PEDESTRIAN_RADIUS + 0.08;
  let blocked = physicalPath.slice(1).some((point, index) => segmentTouchesFlame(physicalPath[index], point, relevantFires, time, clearance));
  let detourAvailable = false;
  if (blocked && edgeAllowsDetour(edge)) {
    const detour = planFireDetour(physicalPath, edge, {
      allowStartLanes: nodeMap.get(edge.from)?.type === "corridor" || nodeMap.get(edge.from)?.type === "junction" || nodeMap.get(edge.from)?.type === "gate",
      allowGoalLanes: nodeMap.get(edge.to)?.type === "corridor" || nodeMap.get(edge.to)?.type === "junction" || nodeMap.get(edge.to)?.type === "gate",
      riskAt: (point) => pointRisk(point, relevantFires, time, clearance),
      segmentBlocked: (from, to) => segmentTouchesFlame(from, to, relevantFires, time, clearance),
    });
    if (detour) {
      points = denseSamples(detour, 0.4);
      blocked = false;
      detourAvailable = true;
    }
  }
  const samples = points.map((point) => pointRisk(point, relevantFires, time));
  const heat = Math.max(...samples.map((s) => s.heat));
  return {
    fire: Math.max(...samples.map((s) => s.fire)),
    smoke: Math.max(...samples.map((s) => s.smoke)),
    heat,
    modeledTemperatureC: modeledTemperatureFromHeat(heat),
    blocked,
    detourAvailable,
  };
}

const edgeHazardResults = new WeakMap<SimEdge, Map<string, ReturnType<typeof computeEdgeRisk>>>();

function edgeRisk(edge: SimEdge, nodeMap: Map<string, SimNode>, fires: FireSource[], time: number) {
  // Alternative global routes evaluate the same edge repeatedly. Reuse exact hazard states;
  // do not round time or positions, which could miss a growing flame at a narrow clearance.
  const relevant = fires.filter((fire) => fireHasStarted(fire, time) && (
    fireCanAffectFloor(fire, edge.floorFrom) || fireCanAffectFloor(fire, edge.floorTo)
    || (fire.floor === 0 && (edge.floorFrom === 0 || edge.floorTo === 0 || edge.kind === "outdoor"))
  ));
  const key = relevant.length ? JSON.stringify([time, relevant.map((fire) => [
    fire.id, fire.position, fire.floor, fire.startTime, fire.fireRadius, fire.smokeRadius, fire.spreadRate, fire.intensity,
  ])]) : "clear";
  let cache = edgeHazardResults.get(edge);
  if (!cache) { cache = new Map(); edgeHazardResults.set(edge, cache); }
  const cached = cache.get(key);
  if (cached) return cached;
  const result = computeEdgeRisk(edge, nodeMap, relevant, time);
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

function addNode(nodes: SimNode[], node: SimNode) {
  nodes.push(node);
}

function addEdge(edges: SimEdge[], nodeMap: Map<string, SimNode>, edge: Omit<SimEdge, "distance" | "floorFrom" | "floorTo">) {
  const from = nodeMap.get(edge.from);
  const to = nodeMap.get(edge.to);
  if (!from || !to) return;
  const provisional: SimEdge = {
    ...edge,
    distance: 0,
    floorFrom: from.floor,
    floorTo: to.floor,
  };
  provisional.distance = polylineDistance(normalizedEdgePoints(provisional, nodeMap));
  edges.push(provisional);
}

export function createEvacuationGraph(): SimGraph {
  const nodes: SimNode[] = [];
  const pendingEdges: Array<Omit<SimEdge, "distance" | "floorFrom" | "floorTo">> = [];

  CLASSROOMS.forEach((room) => {
    addNode(nodes, {
      id: room.id,
      name: room.name,
      type: "room",
      position: roomWalkPosition(room),
      floor: room.floor,
      capacity: CLASSROOM_CAPACITY,
      wing: room.side,
      phase: "room",
    });
    addNode(nodes, {
      id: doorId(room),
      name: `ประตู ${room.name}`,
      type: "door",
      position: roomDoorPosition(room),
      floor: room.floor,
      capacity: 4.5,
      wing: room.side,
      phase: "corridor",
    });
  });

  for (let floor = 2; floor <= FLOOR_COUNT; floor += 1) {
    for (let bay = 1; bay <= PINK_ROOM_BAYS; bay += 1) {
      const room = CLASSROOMS.find((r) => r.floor === floor && r.side === "pink" && r.index === bay)!;
      addNode(nodes, {
        id: corridorId("pink", floor, bay),
        name: `โถงปีกซ้าย ชั้น ${floor} ช่วง ${bay}`,
        type: "corridor",
        position: roomCorridorPosition(room),
        floor,
        capacity: 12,
        wing: "pink",
        phase: "corridor",
      });
    }
    for (let bay = 1; bay <= BLUE_ROOM_BAYS; bay += 1) {
      const room = CLASSROOMS.find((r) => r.floor === floor && r.side === "blue" && r.index === bay)!;
      addNode(nodes, {
        id: corridorId("blue", floor, bay),
        name: `โถงปีกขวา ชั้น ${floor} ช่วง ${bay}`,
        type: "corridor",
        position: roomCorridorPosition(room),
        floor,
        capacity: 12,
        wing: "blue",
        phase: "corridor",
      });
    }
    addNode(nodes, {
      id: junctionId(floor),
      name: `โถงแกนกลาง ชั้น ${floor}`,
      type: "junction",
      position: [JUNCTION_X, walkY(floor), JUNCTION_Z],
      floor,
      capacity: 18,
      wing: "core",
      phase: "corridor",
    });
  }

  (["left", "center", "right"] as StairZone[]).forEach((zone) => {
    for (let floor = 1; floor <= FLOOR_COUNT; floor += 1) {
      addNode(nodes, {
        id: stairId(zone, floor),
        name: `บันได${zone === "left" ? "ซ้าย" : zone === "center" ? "กลาง" : "ขวา"} ชั้น ${floor}`,
        type: "stair",
        position: stairAccessPoint(zone, floor),
        floor,
        capacity: zone === "center" ? 4.6 : 3.6,
        wing: zone === "left" ? "pink" : zone === "right" ? "blue" : "core",
        phase: "stair",
      });
    }
    addNode(nodes, {
      id: stairExitDoorId(zone),
      name: `ประตูหนีไฟ${zone === "left" ? "ปีกซ้าย" : zone === "center" ? "แกนกลาง" : "ปีกขวา"}`,
      type: "door",
      position: STAIR_EXIT_DOOR_CENTERS[zone],
      floor: 1,
      capacity: 4.8,
      wing: "ground",
      phase: "ground",
    });
    addNode(nodes, {
      id: exitId(zone),
      name: `ทางออก${zone === "left" ? "ซ้าย" : zone === "center" ? "กลาง" : "ขวา"}`,
      type: "exit",
      position: SIM_EXIT_POSITIONS[zone],
      floor: 1,
      capacity: 7.2,
      wing: "ground",
      phase: "ground",
    });
  });

  FIELD_GATE_VARIANTS.forEach((gate) => {
    addNode(nodes, {
      id: gate.id,
      name: gate.label,
      type: "gate",
      position: gate.position,
      floor: 0,
      capacity: 12,
      wing: "outdoor",
      phase: "outdoor",
    });
  });

  ASSEMBLY_ZONE_OFFSETS.forEach(([zone, dx, dz]) => {
    addNode(nodes, {
      id: `sim-zone-${zone.toLowerCase()}`,
      name: `จุดรวมพล Zone ${zone}`,
      type: "assembly",
      position: [FIELD_CENTER[0] + dx, 0.22, FIELD_CENTER[2] + dz],
      floor: 0,
      capacity: ASSEMBLY_ZONE_CAPACITY,
      wing: "assembly",
      phase: "assembly",
    });
  });

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  CLASSROOMS.forEach((room) => {
    pendingEdges.push({
      id: `edge-room-door-${room.id}`,
      from: room.id,
      to: doorId(room),
      kind: "room",
      width: 1.2,
      capacityPerSecond: 1.8,
      speedMultiplier: 0.82,
      twoWay: true,
      insideBuilding: true,
      waypoints: [],
    });
    pendingEdges.push({
      id: `edge-door-corr-${room.id}`,
      from: doorId(room),
      to: corridorId(room.side, room.floor, room.index),
      kind: "corridor",
      width: 2.2,
      capacityPerSecond: 5.2,
      speedMultiplier: 0.92,
      twoWay: true,
      insideBuilding: true,
      waypoints: [room.side === "pink"
        ? [room.position[0] - 2.25, walkY(room.floor), .75]
        : [-.75, walkY(room.floor), room.position[2] - 2.25]],
    });
  });

  for (let floor = 2; floor <= FLOOR_COUNT; floor += 1) {
    for (let bay = 1; bay < PINK_ROOM_BAYS; bay += 1) {
      pendingEdges.push({
        id: `edge-pink-corr-f${floor}-${bay}-${bay + 1}`,
        from: corridorId("pink", floor, bay),
        to: corridorId("pink", floor, bay + 1),
        kind: "corridor",
        width: 3.2,
        capacityPerSecond: 8.2,
        speedMultiplier: 1,
        twoWay: true,
        insideBuilding: true,
      });
    }
    for (let bay = 1; bay < BLUE_ROOM_BAYS; bay += 1) {
      pendingEdges.push({
        id: `edge-blue-corr-f${floor}-${bay}-${bay + 1}`,
        from: corridorId("blue", floor, bay),
        to: corridorId("blue", floor, bay + 1),
        kind: "corridor",
        width: 3.2,
        capacityPerSecond: 8.2,
        speedMultiplier: 1,
        twoWay: true,
        insideBuilding: true,
      });
    }

    pendingEdges.push({
      id: `edge-pink-inner-junction-f${floor}`,
      from: corridorId("pink", floor, 1),
      to: junctionId(floor),
      kind: "junction",
      width: 3.5,
      capacityPerSecond: 9.5,
      speedMultiplier: 0.96,
      twoWay: true,
      insideBuilding: true,
      waypoints: [
        [CORE_OPEN_CONNECTOR_CENTER[0] - 0.16, walkY(floor), CORE_OPEN_CONNECTOR_CENTER[2]],
        [CORE_OPEN_CONNECTOR_CENTER[0] + 0.42, walkY(floor), CORE_OPEN_CONNECTOR_CENTER[2]],
        [-5.45, walkY(floor), 2.55],
        [-2, walkY(floor), 3.1],
        [JUNCTION_X, walkY(floor), JUNCTION_Z],
      ],
    });
    pendingEdges.push({
      id: `edge-blue-inner-junction-f${floor}`,
      from: corridorId("blue", floor, 1),
      to: junctionId(floor),
      kind: "junction",
      width: 3.5,
      capacityPerSecond: 9.5,
      speedMultiplier: 0.96,
      twoWay: true,
      insideBuilding: true,
      waypoints: [[BLUE_CORRIDOR_X, walkY(floor), 3.1], [JUNCTION_X, walkY(floor), 3.1]],
    });
    pendingEdges.push({
      id: `edge-pink-outer-left-stair-f${floor}`,
      from: corridorId("pink", floor, PINK_ROOM_BAYS),
      to: stairId("left", floor),
      kind: "junction",
      width: 1.1,
      capacityPerSecond: 2.0,
      speedMultiplier: 0.92,
      twoWay: true,
      insideBuilding: true,
      waypoints: [[-52.85, walkY(floor), PINK_CORRIDOR_Z], [-52.85, walkY(floor), -0.95]],
    });
    pendingEdges.push({
      id: `edge-blue-outer-right-stair-f${floor}`,
      from: corridorId("blue", floor, BLUE_ROOM_BAYS),
      to: stairId("right", floor),
      kind: "junction",
      width: 1.1,
      capacityPerSecond: 2.0,
      speedMultiplier: 0.92,
      twoWay: true,
      insideBuilding: true,
      waypoints: [[BLUE_CORRIDOR_X, walkY(floor), 52.85], [5.55, walkY(floor), 52.85]],
    });
    pendingEdges.push({
      id: `edge-junction-center-stair-f${floor}`,
      from: junctionId(floor),
      to: stairId("center", floor),
      kind: "junction",
      width: 3.2,
      capacityPerSecond: 7.2,
      speedMultiplier: 0.9,
      twoWay: true,
      insideBuilding: true,
      waypoints: [[1.2, walkY(floor), 2.35]],
    });
  }

  (["left", "center", "right"] as StairZone[]).forEach((zone) => {
    for (let floor = FLOOR_COUNT; floor >= 2; floor -= 1) {
      pendingEdges.push({
        id: `edge-stair-${zone}-${floor}-${floor - 1}`,
        from: stairId(zone, floor),
        to: stairId(zone, floor - 1),
        kind: "stair",
        width: 2.2,
        capacityPerSecond: zone === "center" ? 4.5 : 3.55,
        speedMultiplier: 0.55,
        twoWay: false,
        insideBuilding: true,
        waypoints: stairDescentWaypoints(zone, floor),
      });
    }

    const approachDoorPaths: Record<StairZone, Vec3[]> = {
      left: [[-55, walkY(1), 1], STAIR_EXIT_DOOR_CENTERS.left],
      center: [STAIR_EXIT_DOOR_CENTERS.center],
      right: [[5.55, walkY(1), 53.1], STAIR_EXIT_DOOR_CENTERS.right],
    };
    pendingEdges.push({
      id: `edge-${zone}-stair-door`,
      from: stairId(zone, 1),
      to: stairExitDoorId(zone),
      kind: "exit",
      width: STAIR_EXIT_DOOR_WIDTH,
      capacityPerSecond: 4.8,
      speedMultiplier: 0.88,
      twoWay: false,
      insideBuilding: true,
      waypoints: approachDoorPaths[zone],
    });

    const clearDoorPaths: Record<StairZone, Vec3[]> = {
      left: [[-52, walkY(1), 7]],
      center: [[-4, walkY(1), 10]],
      right: [[8, walkY(1), 50]],
    };
    pendingEdges.push({
      id: `edge-${zone}-door-exit`,
      from: stairExitDoorId(zone),
      to: exitId(zone),
      kind: "exit",
      width: 4,
      capacityPerSecond: 7.2,
      speedMultiplier: 0.95,
      twoWay: false,
      insideBuilding: false,
      waypoints: clearDoorPaths[zone],
    });

    const outdoorPaths: Record<StairZone, Vec3[]> = {
      left: [[-39, 0.22, 17], [-24, 0.22, 23], [-12, 0.22, 35], [-7, 0.22, 62.6], [-5.4, 0.22, 65.2]],
      center: [[-8, 0.22, 22], [-7, 0.22, 44], [-7, 0.22, 62.6], [-5.4, 0.22, 65.2]],
      right: [[12.8, 0.22, 50.5], [13.2, 0.22, 62.5], [8, 0.22, 65.5]],
    };
    FIELD_GATE_VARIANTS.forEach((gate) => {
      const gateSuffix = gate.id === "sim-field-gate" ? "" : gate.id.endsWith("left") ? "-left" : "-right";
      const approach = outdoorPaths[zone].slice(0, -1);
      const finalGuide: Vec3 = [
        gate.position[0] + (zone === "right" ? 1.4 : zone === "left" ? -1.0 : 0),
        0.22,
        64.8,
      ];
      pendingEdges.push({
        id: `edge-${zone}-field-gate${gateSuffix}`,
        from: exitId(zone),
        to: gate.id,
        kind: "outdoor",
        width: 7,
        capacityPerSecond: 12,
        speedMultiplier: 1.08,
        twoWay: false,
        insideBuilding: false,
        waypoints: [...approach, finalGuide],
      });
    });
  });

  ASSEMBLY_ZONE_OFFSETS.forEach(([zone]) => {
    FIELD_GATE_VARIANTS.forEach((gate) => {
      const gateSuffix = gate.id === "sim-field-gate" ? "" : gate.id.endsWith("left") ? "-left" : "-right";
      pendingEdges.push({
        id: `edge-gate${gateSuffix}-zone-${zone.toLowerCase()}`,
        from: gate.id,
        to: `sim-zone-${zone.toLowerCase()}`,
        kind: "assembly",
        width: 6,
        capacityPerSecond: 9,
        speedMultiplier: 0.95,
        twoWay: false,
        insideBuilding: false,
        waypoints: [],
      });
    });
  });

  const edges: SimEdge[] = [];
  pendingEdges.forEach((edge) => addEdge(edges, nodeMap, edge));
  return { nodes, edges };
}

interface Arc { edge: SimEdge; from: SimNode; to: SimNode }

function adjacency(graph: SimGraph, nodeMap: Map<string, SimNode>): Map<string, Arc[]> {
  const map = new Map<string, Arc[]>();
  graph.nodes.forEach((n) => map.set(n.id, []));
  graph.edges.forEach((edge) => {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) return;
    map.get(from.id)?.push({ edge, from, to });
    if (edge.twoWay) map.get(to.id)?.push({ edge, from: to, to: from });
  });
  return map;
}

function topologyAllowed(arc: Arc): boolean {
  const { edge, from, to } = arc;
  if (edge.kind === "stair") return from.floor > 1 && to.floor === from.floor - 1;
  if (edge.kind === "outdoor") return from.floor === 1 && to.floor === 0;
  if (edge.kind === "assembly") return from.floor === 0 && to.floor === 0;
  if (edge.kind === "exit") return from.floor === 1 && to.floor === 1;
  // Room/corridor/junction movement is strictly floor-local.
  return from.floor === to.floor && from.floor >= 2;
}

function arcCost(
  arc: Arc,
  graphNodeMap: Map<string, SimNode>,
  config: SimulationConfig,
  fires: FireSource[],
  time: number,
  reserved: Map<string, number>,
  excluded: Set<string>,
): number {
  if (excluded.has(arc.edge.id) || !topologyAllowed(arc)) return Infinity;
  const risk = edgeRisk(arc.edge, graphNodeMap, fires, time);
  const ambientTemperatureC = config.ambientTemperatureC ?? DEFAULT_AMBIENT_TEMPERATURE_C;
  const heatAvoidThresholdC = config.heatAvoidThresholdC ?? DEFAULT_HEAT_AVOID_THRESHOLD_C;
  const hardBlockTemperatureC = Math.max(heatAvoidThresholdC + 1, config.hardBlockTemperatureC ?? DEFAULT_HARD_BLOCK_TEMPERATURE_C);
  const modeledTemperatureC = modeledTemperatureFromHeat(risk.heat, ambientTemperatureC);
  if (risk.blocked || (modeledTemperatureC >= hardBlockTemperatureC && !risk.detourAvailable)) return Infinity;
  const thermalBand = Math.max(0, (modeledTemperatureC - heatAvoidThresholdC) / Math.max(1, hardBlockTemperatureC - heatAvoidThresholdC));
  const thermalPenalty = thermalBand * thermalBand * (config.thermalWeight ?? 2400);
  const speed = Math.max(0.25, config.walkingSpeed * arc.edge.speedMultiplier);
  const travel = arc.edge.distance / speed;
  const load = reserved.get(arc.edge.id) ?? 0;
  const queueDelay = load / Math.max(0.1, arc.edge.capacityPerSecond);
  const density = load / Math.max(1, arc.edge.width * Math.max(4, arc.edge.distance));
  if (config.preset === "fastest") return travel + queueDelay * 0.95 + density * 2.5 + risk.fire * 1400 + risk.heat * 720 + risk.smoke * 180 + thermalPenalty * 0.35;
  if (config.preset === "safest") return travel * 0.35 + queueDelay * 0.55 + risk.fire * 7000 + risk.heat * 3800 + risk.smoke * 2400 + density * 16 + thermalPenalty * 1.75;
  return arc.edge.distance * config.distanceWeight + (travel + queueDelay) * config.timeWeight + density * config.congestionWeight + risk.fire * config.fireWeight + risk.heat * config.fireWeight * 0.58 + risk.smoke * config.smokeWeight + thermalPenalty;
}

function heuristic(node: SimNode, goals: SimNode[], preset: RoutingPreset) {
  const d = Math.min(...goals.map((goal) => distance3(node.position, goal.position)));
  return preset === "safest" ? d * 0.08 : d * 0.34;
}

export function findPath(
  graph: SimGraph,
  startId: string,
  goalIds: string[],
  config: SimulationConfig,
  fires: FireSource[],
  time: number,
  reserved = new Map<string, number>(),
  excluded = new Set<string>(),
  heuristicWeight = 1,
): RoutePath | null {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const goals = goalIds.map((id) => nodeMap.get(id)).filter((v): v is SimNode => Boolean(v));
  if (!nodeMap.has(startId) || goals.length === 0) return null;
  const adj = adjacency(graph, nodeMap);
  const open: Array<{ id: string; f: number }> = [{ id: startId, f: 0 }];
  const g = new Map<string, number>([[startId, 0]]);
  const prev = new Map<string, { nodeId: string; edgeId: string }>();
  const closed = new Set<string>();
  let reached: string | null = null;

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const current = open.shift()!;
    if (closed.has(current.id)) continue;
    if (goalIds.includes(current.id)) { reached = current.id; break; }
    closed.add(current.id);
    for (const arc of adj.get(current.id) ?? []) {
      const cost = arcCost(arc, nodeMap, config, fires, time, reserved, excluded);
      if (!Number.isFinite(cost)) continue;
      const nextG = (g.get(current.id) ?? Infinity) + cost;
      if (nextG < (g.get(arc.to.id) ?? Infinity)) {
        g.set(arc.to.id, nextG);
        prev.set(arc.to.id, { nodeId: current.id, edgeId: arc.edge.id });
        open.push({ id: arc.to.id, f: nextG + heuristic(arc.to, goals, config.preset) * heuristicWeight });
      }
    }
  }
  if (!reached) return null;

  const nodeIds = [reached];
  const edgeIds: string[] = [];
  let cursor = reached;
  while (cursor !== startId) {
    const p = prev.get(cursor);
    if (!p) return null;
    nodeIds.unshift(p.nodeId);
    edgeIds.unshift(p.edgeId);
    cursor = p.nodeId;
  }

  const edgeMap = new Map(graph.edges.map((e) => [e.id, e]));
  let distance = 0;
  let estimatedTime = 0;
  let risk = 0;
  let congestion = 0;
  let bottleneckCapacity = Infinity;
  edgeIds.forEach((id) => {
    const edge = edgeMap.get(id);
    if (!edge) return;
    distance += edge.distance;
    estimatedTime += edge.distance / Math.max(0.25, config.walkingSpeed * edge.speedMultiplier);
    bottleneckCapacity = Math.min(bottleneckCapacity, edge.capacityPerSecond);
    const load = reserved.get(id) ?? 0;
    congestion += load / Math.max(1, edge.width * Math.max(4, edge.distance));
    const er = edgeRisk(edge, nodeMap, fires, time);
    risk += er.fire + er.heat * 0.72 + er.smoke;
  });

  const path: RoutePath = {
    nodeIds,
    edgeIds,
    distance,
    estimatedTime,
    risk,
    congestion,
    totalCost: g.get(reached) ?? Infinity,
    bottleneckCapacity: Number.isFinite(bottleneckCapacity) ? bottleneckCapacity : 1,
    goalId: reached,
  };
  return routeIsPhysicallyValid(graph, path, nodeMap, edgeMap) ? path : null;
}

/** Exact Dijkstra route using the same dynamic edge-cost function as A*. */
export function dijkstraPath(
  graph: SimGraph,
  startId: string,
  goalIds: string[],
  config: SimulationConfig,
  fires: FireSource[],
  time: number,
  reserved = new Map<string, number>(),
  excluded = new Set<string>(),
): RoutePath | null {
  return findPath(graph, startId, goalIds, config, fires, time, reserved, excluded, 0);
}

export function kShortestPaths(
  graph: SimGraph,
  startId: string,
  goalIds: string[],
  config: SimulationConfig,
  fires: FireSource[],
  time: number,
  reserved: Map<string, number>,
  k = 4,
): RoutePath[] {
  const results: RoutePath[] = [];
  const queue: Set<string>[] = [new Set()];
  const seen = new Set<string>();
  while (queue.length && results.length < k) {
    const excluded = queue.shift()!;
    const path = findPath(graph, startId, goalIds, config, fires, time, reserved, excluded);
    if (!path) continue;
    const sig = path.nodeIds.join(">");
    if (seen.has(sig)) continue;
    seen.add(sig);
    results.push(path);
    path.edgeIds.forEach((edgeId) => {
      const next = new Set(excluded);
      next.add(edgeId);
      queue.push(next);
    });
  }
  return results.sort((a, b) => a.totalCost - b.totalCost);
}

const physicalArcValidityCache = new WeakMap<SimGraph, Map<string, boolean>>();

/**
 * Final structural gate for every planned route. A path is accepted only when
 * each edge joins the declared adjacent nodes, obeys the floor/exit topology,
 * and every sampled point remains inside that edge's collision-safe corridor.
 * This turns walls, lift shafts, railings, and missing door portals into hard
 * constraints rather than costs that an optimizer could trade away.
 */
export function routeIsPhysicallyValid(graph: SimGraph, path: RoutePath,
  nodes?: Map<string, SimNode>, edges?: Map<string, SimEdge>): boolean {
  if (path.nodeIds.length !== path.edgeIds.length + 1 || path.nodeIds.length < 2) return false;
  if (path.nodeIds[path.nodeIds.length - 1] !== path.goalId) return false;
  const nodeMap = nodes ?? new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeMap = edges ?? new Map(graph.edges.map((edge) => [edge.id, edge]));
  let arcCache = physicalArcValidityCache.get(graph);
  if (!arcCache) {
    arcCache = new Map<string, boolean>();
    physicalArcValidityCache.set(graph, arcCache);
  }
  if (nodeMap.get(path.goalId)?.type !== "assembly") return false;

  for (let index = 0; index < path.edgeIds.length; index += 1) {
    const edge = edgeMap.get(path.edgeIds[index]);
    const from = nodeMap.get(path.nodeIds[index]);
    const to = nodeMap.get(path.nodeIds[index + 1]);
    if (!edge || !from || !to) return false;
    const forward = edge.from === from.id && edge.to === to.id;
    const reverse = edge.twoWay && edge.to === from.id && edge.from === to.id;
    if ((!forward && !reverse) || !topologyAllowed({ edge, from, to })) return false;
    const arcKey = `${edge.id}:${from.id}>${to.id}`;
    let physicallyValid = arcCache.get(arcKey);
    if (physicallyValid == null) {
      const points = traversalPoints(edge, nodeMap, from.id, to.id);
      physicallyValid = points.length >= 2;
      for (let segment = 1; physicallyValid && segment < points.length; segment += 1) {
        const a = points[segment - 1];
        const b = points[segment];
        const samples = Math.max(2, Math.ceil(distance3(a, b) / 0.45));
        for (let sample = 0; sample <= samples; sample += 1) {
          if (!pointInsideWalkableCorridor(lerp(a, b, sample / samples), points, edge)) {
            physicallyValid = false;
            break;
          }
        }
      }
      arcCache.set(arcKey, physicallyValid);
    }
    if (!physicallyValid) return false;
  }
  return true;
}

export function activeRoomPopulation(populationTarget: number): Array<{ room: RoomModuleDefinition; count: number }> {
  const target = Math.max(0, Math.min(populationTarget, CLASSROOMS.length * CLASSROOM_CAPACITY));
  return CLASSROOMS
    .map((room, index) => ({ room, count: balancedOccupancyAt(index, target, CLASSROOMS.length) }))
    .filter(({ count }) => count > 0);
}

function marginalSystemArrivalScore(
  path: RoutePath,
  reserved: Map<string, number>,
  zoneLoads: Map<string, number>,
  edgeMap: Map<string, SimEdge>,
  config: SimulationConfig,
): number {
  let freeFlow = 0;
  let queueDelay = 0;
  let bottleneckDelay = 0;
  let crowdPenalty = 0;
  for (const edgeId of path.edgeIds) {
    const edge = edgeMap.get(edgeId);
    if (!edge) continue;
    const speed = Math.max(0.25, config.walkingSpeed * edge.speedMultiplier);
    freeFlow += edge.distance / speed;
    const loadAfter = (reserved.get(edgeId) ?? 0) + 1;
    const serviceTime = loadAfter / Math.max(0.1, edge.capacityPerSecond);
    // Queue effects at consecutive edges overlap in time, so use a mixed max + small sum model
    // instead of blindly adding every queue in full.
    bottleneckDelay = Math.max(bottleneckDelay, serviceTime);
    queueDelay += serviceTime * 0.10;
    crowdPenalty += loadAfter / Math.max(1, edge.width * Math.max(3, edge.distance));
  }
  const zoneFill = (zoneLoads.get(path.goalId) ?? 0) / ASSEMBLY_ZONE_CAPACITY;
  const hazardPenalty = config.preset === "safest" ? path.risk * 3200 : path.risk * 900;
  const congestionFactor = config.preset === "fastest" ? 0.72 : config.preset === "safest" ? 0.48 : 1;
  return freeFlow + (bottleneckDelay + queueDelay) * congestionFactor + crowdPenalty * 5.5 + zoneFill * 7 + hazardPenalty;
}

/**
 * System-level route allocation approximation: occupants are assigned one-by-one to the candidate route whose
 * *marginal predicted arrival time* is currently lowest. The score is recomputed after every
 * assignment, therefore doors/stairs that are becoming bottlenecks immediately become less
 * attractive. This is intentionally different from letting every person choose the same shortest
 * path independently.
 */
export function allocatePopulation(
  graph: SimGraph,
  config: SimulationConfig,
  fires: FireSource[],
  time = 0,
): { bundles: RouteBundle[]; reserved: Map<string, number>; zoneLoads: Map<string, number> } {
  const reserved = new Map<string, number>();
  const zoneLoads = new Map<string, number>();
  const bundles: RouteBundle[] = [];
  const edgeMap = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const goals = graph.nodes.filter((n) => n.type === "assembly").map((n) => n.id);
  const rooms = activeRoomPopulation(config.populationTarget).sort((a, b) => b.room.floor - a.room.floor);

  for (const { room, count } of rooms) {
    // Generate alternatives to every assembly zone. Three alternatives per zone gives the
    // optimizer enough freedom to split occupants across left/center/right stair systems.
    const candidates = goals
      .flatMap((goalId) => kShortestPaths(graph, room.id, [goalId], config, fires, time, reserved, 3))
      .filter((path, index, all) => all.findIndex((other) => other.nodeIds.join(">") === path.nodeIds.join(">")) === index);
    if (!candidates.length) continue;

    const roomAssignments = new Map<string, { path: RoutePath; amount: number }>();
    for (let person = 0; person < count; person += 1) {
      const viable = candidates.filter((path) => (zoneLoads.get(path.goalId) ?? 0) < ASSEMBLY_ZONE_CAPACITY);
      if (!viable.length) break;
      let best = viable[0];
      let bestScore = Infinity;
      for (const path of viable) {
        const score = marginalSystemArrivalScore(path, reserved, zoneLoads, edgeMap, config);
        if (score < bestScore) {
          bestScore = score;
          best = path;
        }
      }

      const signature = best.nodeIds.join(">");
      const previous = roomAssignments.get(signature);
      roomAssignments.set(signature, { path: best, amount: (previous?.amount ?? 0) + 1 });
      zoneLoads.set(best.goalId, (zoneLoads.get(best.goalId) ?? 0) + 1);
      best.edgeIds.forEach((edgeId) => reserved.set(edgeId, (reserved.get(edgeId) ?? 0) + 1));
    }

    roomAssignments.forEach((assignment) => {
      if (assignment.amount > 0) bundles.push({ roomId: room.id, peopleCount: assignment.amount, path: assignment.path });
    });
  }
  return { bundles, reserved, zoneLoads };
}

export function edgeBlockedByFire(graph: SimGraph, edgeId: string, fires: FireSource[], time: number): boolean {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return true;
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  return edgeRisk(edge, nodeMap, fires, time).blocked;
}

export function edgeRiskSnapshot(graph: SimGraph, edgeId: string, fires: FireSource[], time: number,
  nodes?: Map<string, SimNode>, edges?: Map<string, SimEdge>) {
  const edge = edges?.get(edgeId) ?? graph.edges.find((e) => e.id === edgeId);
  if (!edge) return { fire: 1, smoke: 1, heat: 1, modeledTemperatureC: modeledTemperatureFromHeat(1), blocked: true, detourAvailable: false };
  const nodeMap = nodes?.size ? nodes : new Map(graph.nodes.map((n) => [n.id, n]));
  return edgeRisk(edge, nodeMap, fires, time);
}

export function nodeContext(node: SimNode | undefined): { floor: number; wing: AgentWing; phase: AgentPhase } {
  return node ? { floor: node.floor, wing: node.wing, phase: node.phase } : { floor: 0, wing: "outdoor", phase: "outdoor" };
}
