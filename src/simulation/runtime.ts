import {
  CLASSROOMS,
  CLASSROOM_CAPACITY,
  FIELD_CENTER,
  FLOOR_HEIGHT,
  SLAB_THICKNESS,
  floorBase,
  STAIR_EXIT_DOOR_WIDTH,
  TARGET_POPULATION,
} from "../building1/building1Data";
import {
  activeRoomPopulation,
  allocatePopulation,
  classifyWing,
  createEvacuationGraph,
  edgeRiskSnapshot,
  fireRadiusAt,
  modeledTemperatureFromHeat,
  floorFromY,
  kShortestPaths,
  nodeContext,
  pointRisk,
  segmentTouchesFlame,
  routeIsPhysicallyValid,
  smokeRadiusAt,
  traversalPoints,
  walkY,
} from "./graph";
import type {
  AgentPhase,
  AgentDecisionState,
  AgentPublicSnapshot,
  AgentStatus,
  AgentWing,
  BottleneckMetric,
  FireSource,
  HazardAwareness,
  HeatAwareness,
  RouteBundle,
  RoutePath,
  SimEdge,
  SimGraph,
  SimNode,
  SimulationConfig,
  SimulationEvent,
  SimulationMetrics,
  SmokeAwareness,
  StudentGender,
  Vec3,
} from "./types";
import { PEDESTRIAN_RADIUS, movementSegmentIsContinuous, pointClearsExteriorBuilding, pointInsideWalkableCorridor } from "./walkable";
import { flameCellsAt, flameClearanceAt, fireHasStarted, fireMayAffectPoint, spreadProgressAt } from "./fireField";
import { edgeAllowsDetour, planFireDetour, segmentInsideWalkway } from "./localNavigation";
import { normalizeStudentPopulation, studentStartPosition } from "./studentPlacement";

interface RuntimeAgent {
  id: number;
  gender: StudentGender;
  roomId: string;
  position: Vec3;
  status: AgentStatus;
  speed: number;
  responseDelay: number;
  route: RoutePath;
  edgeIndex: number;
  edgeEntered: boolean;
  edgePath: Vec3[];
  segmentIndex: number;
  segmentProgress: number;
  arrivedAt: number | null;
  smokeExposure: boolean;
  lastRerouteAt: number;
  floor: number;
  wing: AgentWing;
  phase: AgentPhase;
  currentNodeId: string;
  assemblySlot: Vec3;
  retreating: boolean;
  knownFireIds: Set<string>;
  fireKnowledge: Map<string, { source: Exclude<HazardAwareness, "none">; learnedAt: number; believedPosition: Vec3 }>;
  groupLeaderId: number;
  riskAversion: number;
  smokeSensitivity: number;
  heatSensitivity: number;
  smokeDetectionThreshold: number;
  heatDetectionThreshold: number;
  smokeAwareness: SmokeAwareness;
  heatAwareness: HeatAwareness;
  perceivedSmoke: number;
  perceivedHeat: number;
  visibility: number;
  familiarity: number;
  groupCohesion: number;
  queueToleranceSeconds: number;
  decisionLatency: number;
  stress: number;
  health: number;
  flameContactSeconds: number;
  smokeDose: number;
  heatDose: number;
  heatExposure: boolean;
  protectivePosture: boolean;
  incapacitatedAt: number | null;
  decisionState: AgentDecisionState;
  hasPassedRoomDoor: boolean;
  hasExitedBuilding: boolean;
  lastHazardUpdateAt: number;
  cachedTrueRisk: { fire: number; smoke: number; heat: number; blocked: boolean };
  cachedPerceivedFires: FireSource[];
  detourPath: Vec3[];
  detourIndex: number;
  lastDetourPlanAt: number;
  lateralRecoveryUntil?: number;
  detourExitSide?: boolean;
}

interface EdgeQueueState {
  nextEntryTime: number;
  entries: number;
}

type FireAttachmentKind = NonNullable<FireSource["attachmentKind"]>;
type FireAttachmentNode = SimNode & { type: FireAttachmentKind };
const FIRE_ATTACHMENT_TYPES = new Set<FireAttachmentKind>(["room", "door", "corridor", "junction", "stair"]);

function isFireAttachmentNode(node: SimNode): node is FireAttachmentNode {
  return FIRE_ATTACHMENT_TYPES.has(node.type as FireAttachmentKind);
}

interface RouteSurvivalForecast {
  path: RoutePath;
  eta: number;
  projectedHealth: number;
  projectedSmokeDose: number;
  projectedHeatDose: number;
  survivalMargin: number;
  danger: number;
  blocked: boolean;
  survivable: boolean;
}

/**
 * A flame overlap must persist long enough to represent real contact rather than a single
 * floating-point boundary sample. Smoke and radiant heat affect navigation, but only direct,
 * sustained flame contact can incapacitate an agent.
 */
const DIRECT_FLAME_INCAPACITATION_SECONDS = 0.9;
const MAX_OBJECT_CONNECTED_FIRE_PATCHES = 16;
const MAX_FIRE_SPREAD_GENERATION = 12;
const MAX_HORIZONTAL_FIRE_TRANSFER_DISTANCE = 12;
const MAX_STAIR_FIRE_TRANSFER_DISTANCE = 11.5;

const DEFAULT_CONFIG: SimulationConfig = {
  populationTarget: TARGET_POPULATION,
  preset: "balanced",
  walkingSpeed: 1.32,
  responseDelayMin: 3,
  responseDelayMax: 10,
  rerouteInterval: 1.25,
  distanceWeight: 0.28,
  timeWeight: 1,
  congestionWeight: 20,
  fireWeight: 4200,
  smokeWeight: 1250,
  fireSpreadEnabled: true,
  crowdBehavior: "grouped",
  ambientTemperatureC: 29,
  heatAvoidThresholdC: 44,
  hardBlockTemperatureC: 62,
  thermalLookAheadEdges: 10,
  thermalWeight: 2400,
};

/** Accept every finite positive walking speed without imposing a product cap. */
function normalizeWalkingSpeed(value: number | undefined, fallback = DEFAULT_CONFIG.walkingSpeed): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(0.01, value)
    : fallback;
}

function hash01(value: number): number {
  const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function compactPolyline(points: Vec3[]): Vec3[] {
  const compact: Vec3[] = [];
  points.forEach((point) => {
    if (!compact.length || distance3(compact[compact.length - 1], point) > 0.04) compact.push([...point] as Vec3);
  });
  return compact;
}

function positionAlongPolyline(points: Vec3[], progress: number): Vec3 {
  if (!points.length) return [0, 0, 0];
  if (points.length === 1) return [...points[0]] as Vec3;
  const clamped = Math.max(0, Math.min(1, progress));
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = distance3(points[index - 1], points[index]);
    lengths.push(length);
    total += length;
  }
  if (total <= 0.001) return [...points[points.length - 1]] as Vec3;
  let remaining = total * clamped;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      return lerp3(points[index], points[index + 1], length <= 0.001 ? 1 : Math.min(1, remaining / length));
    }
    remaining -= length;
  }
  return [...points[points.length - 1]] as Vec3;
}

function fireKnowledgeSignature(fires: FireSource[]): string {
  // Attachment IDs represent actual burning school objects and remain identical for people who
  // received the same report. Personal uncertainty still affects local sensing, but must not
  // explode the shared route cache into thousands of nearly identical path searches.
  return fires
    .filter((fire) => fire.enabled)
    .map((fire) => fire.attachmentNodeId ?? `f${fire.floor}:${Math.round(fire.position[0] / 8)},${Math.round(fire.position[2] / 8)}`)
    .sort()
    .join("|") || "unknown";
}

function fireRouteZoneSignature(fires: FireSource[]): string {
  // Route candidates remain reusable while a front advances through objects in the same zone.
  // Every cached path is still re-forecast against the caller's exact known fires before use.
  return [...new Set(fires.filter((fire) => fire.enabled).map((fire) => `f${fire.floor}:${fire.wing}`))].sort().join("|") || "unknown";
}

const edgeSeedCache = new Map<string, number>();

function stableEdgeSeed(edgeId: string): number {
  const cached = edgeSeedCache.get(edgeId);
  if (cached != null) return cached;
  let seed = 2166136261;
  for (let index = 0; index < edgeId.length; index += 1) {
    seed ^= edgeId.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  const normalized = Math.abs(seed >>> 0);
  edgeSeedCache.set(edgeId, normalized);
  return normalized;
}

interface WalkingLanePlan {
  index: number;
  count: number;
  offset: number;
}

const walkingLaneCache = new WeakMap<RuntimeAgent, {
  edge: SimEdge; width: number; kind: SimEdge["kind"]; behavior: SimulationConfig["crowdBehavior"];
  leader: number; cohesion: number; plan: WalkingLanePlan;
}>();

function walkingLanePlan(agent: RuntimeAgent, edge: SimEdge, behavior: SimulationConfig["crowdBehavior"]): WalkingLanePlan {
  const cached = walkingLaneCache.get(agent);
  if (cached && cached.edge === edge && cached.width === edge.width && cached.kind === edge.kind
    && cached.behavior === behavior && cached.leader === agent.groupLeaderId && cached.cohesion === agent.groupCohesion) return cached.plan;
  const plan = calculateWalkingLanePlan(agent, edge, behavior);
  walkingLaneCache.set(agent, { edge, width: edge.width, kind: edge.kind, behavior,
    leader: agent.groupLeaderId, cohesion: agent.groupCohesion, plan });
  return plan;
}

/**
 * People naturally occupy several loose streams, even in an orderly drill. This is not a rigid
 * lane assignment: each person has a small lateral preference and friends only sometimes choose
 * the same stream. The offsets stay inside the collision-safe stair/corridor envelope.
 */
function calculateWalkingLanePlan(agent: RuntimeAgent, edge: SimEdge, behavior: SimulationConfig["crowdBehavior"]): WalkingLanePlan {
  const edgeSeed = stableEdgeSeed(edge.id);
  const maximumLanes = edge.kind === "stair" ? 3 : edge.kind === "outdoor" || edge.kind === "assembly" ? 5 : 4;
  const count = Math.max(1, Math.min(maximumLanes, Math.floor(edge.width / 0.65)));
  if (count === 1) return { index: 0, count, offset: 0 };

  const personalLane = Math.min(count - 1, Math.floor(hash01(agent.id * 37 + edgeSeed * 0.00013) * count));
  const groupLane = Math.min(count - 1, Math.floor(hash01(agent.groupLeaderId * 41 + edgeSeed * 0.00017) * count));
  const followsFriends = behavior !== "orderly"
    && hash01(agent.id * 59 + edgeSeed * 0.00019) < agent.groupCohesion * (behavior === "surge" ? 0.48 : 0.28);
  // Keep a loose stream preference rather than rigid, visually obvious marching lanes.
  // The index is retained for queue bookkeeping, while the actual offset below blends the
  // personal and social preferences into a continuous lateral position.
  const index = followsFriends ? groupLane : personalLane;
  const usableHalfWidth = edge.kind === "stair"
    ? Math.min(0.50, edge.width * 0.5 - 0.28)
    : edge.kind === "junction"
      ? Math.min(0.60, edge.width * 0.5 - 0.30)
      : edge.kind === "outdoor" || edge.kind === "assembly"
        ? Math.min(1.10, edge.width * 0.5 - 0.34)
        : Math.min(0.68, edge.width * 0.5 - 0.30);
  const normalizedLane = index / (count - 1) * 2 - 1;
  const laneStep = usableHalfWidth * 2 / (count - 1);
  const personalCenter = hash01(agent.id * 73 + edgeSeed * 0.00023) * 2 - 1;
  const groupCenter = hash01(agent.groupLeaderId * 61 + edgeSeed * 0.00029) * 2 - 1;
  const blendedCenter = followsFriends
    ? personalCenter * (1 - Math.min(0.55, agent.groupCohesion * 0.52)) + groupCenter * Math.min(0.55, agent.groupCohesion * 0.52)
    : personalCenter;
  const softLaneBias = normalizedLane * 0.38;
  const personalJitter = (hash01(agent.id * 101 + edgeSeed * 0.00031) * 2 - 1) * Math.min(0.13, laneStep * 0.24);
  const offset = Math.max(-usableHalfWidth, Math.min(usableHalfWidth, (blendedCenter * 0.62 + softLaneBias) * usableHalfWidth + personalJitter));
  return { index, count, offset };
}

function horizontalPathNormal(path: Vec3[], segmentIndex: number, progress: number): [number, number] {
  const direction = (index: number): [number, number] | null => {
    if (index < 0 || index >= path.length - 1) return null;
    const dx = path[index + 1][0] - path[index][0];
    const dz = path[index + 1][2] - path[index][2];
    const length = Math.hypot(dx, dz);
    return length > 0.015 ? [dx / length, dz / length] : null;
  };
  const current = direction(segmentIndex) ?? direction(segmentIndex - 1) ?? direction(segmentIndex + 1) ?? [0, 1];
  const upcoming = direction(segmentIndex + 1) ?? current;
  const rawTurn = Math.max(0, Math.min(1, (progress - 0.62) / 0.38));
  const turn = rawTurn * rawTurn * (3 - 2 * rawTurn);
  const dx = current[0] * (1 - turn) + upcoming[0] * turn;
  const dz = current[1] * (1 - turn) + upcoming[1] * turn;
  const length = Math.hypot(dx, dz);
  const tangent = length > 0.08 ? [dx / length, dz / length] : current;
  return [-tangent[1], tangent[0]];
}

/** Samples a queue position backwards across the complete incoming polyline, including stairs. */
function pointBehindPathEnd(path: Vec3[], distanceBehind: number, lateralOffset: number): Vec3 | null {
  let remaining = Math.max(0, distanceBehind);
  for (let index = path.length - 1; index > 0; index -= 1) {
    const from = path[index - 1];
    const to = path[index];
    const length = distance3(from, to);
    if (length <= 0.001) continue;
    if (remaining <= length) {
      const progress = 1 - remaining / length;
      const point = lerp3(from, to, progress);
      const normal = horizontalPathNormal(path, index - 1, progress);
      return [point[0] + normal[0] * lateralOffset, point[1], point[2] + normal[1] * lateralOffset];
    }
    remaining -= length;
  }
  return null;
}

function edgeSupportsLocalBypass(edge: SimEdge) {
  return edgeAllowsDetour(edge);
}

function polylineLength(path: Vec3[]) {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += distance3(path[index - 1], path[index]);
  return total;
}

function polylineDistanceAt(path: Vec3[], segmentIndex: number, progress: number) {
  let total = 0;
  for (let index = 1; index <= Math.min(segmentIndex, path.length - 1); index += 1) total += distance3(path[index - 1], path[index]);
  const activeIndex = Math.min(Math.max(0, segmentIndex), path.length - 2);
  total += distance3(path[activeIndex], path[activeIndex + 1]) * Math.max(0, Math.min(1, progress));
  return total;
}

function closestPointOnPolyline(point: Vec3, path: Vec3[]) {
  let bestDistance = Infinity;
  let bestDistanceAlong = 0;
  let bestPoint = path[0] ?? ([0, 0, 0] as Vec3);
  let travelled = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const denom = abx * abx + aby * aby + abz * abz;
    const apx = point[0] - a[0];
    const apy = point[1] - a[1];
    const apz = point[2] - a[2];
    const t = denom <= 1e-6 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / denom));
    const closest: Vec3 = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
    const distance = distance3(point, closest);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestDistanceAlong = travelled + distance3(a, b) * t;
      bestPoint = closest;
    }
    travelled += distance3(a, b);
  }
  return { distance: bestDistance, distanceAlong: bestDistanceAlong, point: bestPoint };
}

function normalAtPathDistance(path: Vec3[], distanceAlong: number): [number, number] {
  const total = Math.max(0.001, polylineLength(path));
  const center = Math.max(0, Math.min(1, distanceAlong / total));
  const epsilon = Math.max(0.004, 0.45 / total);
  const a = positionAlongPolyline(path, Math.max(0, center - epsilon));
  const b = positionAlongPolyline(path, Math.min(1, center + epsilon));
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dz);
  if (length <= 0.001) return [0, 1];
  return [-dz / length, dx / length];
}

function segmentStateAtDistance(path: Vec3[], distanceAlong: number) {
  let remaining = Math.max(0, distanceAlong);
  for (let index = 0; index < path.length - 1; index += 1) {
    const length = distance3(path[index], path[index + 1]);
    if (remaining <= length || index === path.length - 2) {
      return { segmentIndex: index, progress: length <= 0.001 ? 1 : Math.max(0, Math.min(1, remaining / length)) };
    }
    remaining -= length;
  }
  return { segmentIndex: Math.max(0, path.length - 2), progress: 1 };
}

/**
 * Last-resort physical escape step used only when a flame envelope expands onto an agent's
 * current position. The step stays on the current verified edge polyline and is deliberately
 * short; it never teleports to another graph node. This gives the risk-aware routing logic one chance
 * to move the person out of direct flame before the contact timer can become a casualty.
 */
function findEmergencyEscapeStep(
  currentPosition: Vec3,
  path: Vec3[],
  edge: SimEdge,
  segmentIndex: number,
  progress: number,
  fires: FireSource[],
  time: number,
  maxStep: number,
): Vec3 | null {
  if (path.length < 2) return null;
  const totalLength = polylineLength(path);
  if (totalLength <= 0.05) return null;
  const currentDistance = polylineDistanceAt(path, segmentIndex, progress);
  const currentRisk = pointRisk(currentPosition, fires, time, PEDESTRIAN_RADIUS);
  const currentClearance = flameClearanceAt(currentPosition, fires, time);
  const halfWidth = edge.kind === "outdoor" || edge.kind === "assembly"
    ? Math.max(0.45, Math.min(2.2, edge.width * 0.42))
    : edge.kind === "corridor" || edge.kind === "junction"
      ? Math.max(0.20, Math.min(1.35, edge.width * .5 - PEDESTRIAN_RADIUS - .08))
      : 0;
  const longitudinalSteps = [-0.68, -0.48, -0.30, 0.30, 0.48, 0.68];
  const lateralOffsets = halfWidth > 0
    ? [0, halfWidth * .35, -halfWidth * .35, halfWidth * .65, -halfWidth * .65, halfWidth, -halfWidth]
    : [0];
  let best: { point: Vec3; score: number } | null = null;
  for (const longitudinal of longitudinalSteps) {
    const targetDistance = Math.max(0, Math.min(totalLength, currentDistance + longitudinal));
    const base = positionAlongPolyline(path, targetDistance / totalLength);
    const normal = normalAtPathDistance(path, targetDistance);
    for (const lateral of lateralOffsets) {
      const target: Vec3 = [base[0] + normal[0] * lateral, base[1], base[2] + normal[1] * lateral];
      const candidate = lerp3(currentPosition, target, Math.min(1, maxStep / Math.max(0.001, distance3(currentPosition, target))));
      if (!segmentInsideWalkway(currentPosition, candidate, path, edge)) continue;
      const riskNow = pointRisk(candidate, fires, time, PEDESTRIAN_RADIUS);
      const riskSoon = pointRisk(candidate, fires, time + 0.55, PEDESTRIAN_RADIUS);
      const clearance = flameClearanceAt(candidate, fires, time);
      const safetyGain = (currentRisk.fire - riskNow.fire) * 4.5 + (currentRisk.heat - riskNow.heat) * 2.2
        + (Number.isFinite(currentClearance) ? Math.max(-2, Math.min(2, clearance - currentClearance)) : 0) * 6;
      if (!currentRisk.blocked && segmentTouchesFlame(currentPosition, candidate, fires, time + .15)) continue;
      // Prefer a fully safe step, but when the flame has already expanded around the person,
      // allow a short step through a *lower-risk* part of the same envelope. Repeating these
      // bounded steps lets the person physically walk out instead of becoming permanently stuck.
      const stillInsideFlame = riskNow.blocked || riskSoon.blocked;
      if (safetyGain <= .0001) continue;
      const score = (stillInsideFlame ? 18 : 0)
        + riskNow.fire * 12 + riskNow.heat * 7 + riskNow.smoke * 1.6
        + riskSoon.fire * 8 + riskSoon.heat * 4 + distance3(currentPosition, candidate) * 0.35
        - safetyGain * 5;
      if (!best || score < best.score) best = { point: candidate, score };
    }
  }
  return best?.point ?? null;
}

function assemblySlotPosition(center: Vec3, index: number, behavior: SimulationConfig["crowdBehavior"]): Vec3 {
  if (behavior !== "orderly") {
    const clusterSize = behavior === "surge" ? 20 : 10;
    const clusterIndex = Math.floor(index / clusterSize);
    const member = index % clusterSize;
    const clusterCols = behavior === "surge" ? 5 : 10;
    const clusterRows = Math.ceil(500 / clusterSize / clusterCols);
    const spacingX = behavior === "surge" ? 3.0 : 1.5;
    const spacingZ = behavior === "surge" ? 2.05 : 2.1;
    const clusterX = clusterIndex % clusterCols;
    const clusterZ = Math.floor(clusterIndex / clusterCols) % clusterRows;
    const angle = member * 2.399963 + hash01(index + 311) * 0.5;
    const radius = Math.sqrt((member + 0.5) / clusterSize) * (behavior === "surge" ? 1.25 : 0.62);
    return [
      center[0] - ((clusterCols - 1) * spacingX) / 2 + clusterX * spacingX + Math.cos(angle) * radius,
      center[1] + 0.02,
      center[2] - ((clusterRows - 1) * spacingZ) / 2 + clusterZ * spacingZ + Math.sin(angle) * radius,
    ];
  }
  const cols = 25;
  const rows = 20;
  const col = index % cols;
  const row = Math.floor(index / cols) % rows;
  const spacingX = 0.65;
  const spacingZ = 0.60;
  return [
    center[0] - ((cols - 1) * spacingX) / 2 + col * spacingX,
    center[1] + 0.02,
    center[2] - ((rows - 1) * spacingZ) / 2 + row * spacingZ,
  ];
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  // getMetrics sorts its local arrival list once for all three percentiles.
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1));
  return values[index];
}

function dedupePoints(points: Vec3[]): Vec3[] {
  const result: Vec3[] = [];
  points.forEach((point) => {
    if (!result.length || distance3(result[result.length - 1], point) > 0.015) result.push([...point] as Vec3);
  });
  return result;
}

function exteriorSegmentIsClear(a: Vec3, b: Vec3) {
  const samples = Math.max(8, Math.ceil(distance3(a, b) / 0.65));
  for (let sample = 0; sample <= samples; sample += 1) {
    const point = lerp3(a, b, sample / samples);
    if (!pointClearsExteriorBuilding(point)) return false;
  }
  return true;
}

function joinOutdoorReroute(current: Vec3, traversed: Vec3[]) {
  if (traversed.length < 2) return [current, ...traversed];
  // Prefer a waypoint that is at or ahead of the pedestrian. Rejoining at the first waypoint of
  // a newly selected gate can draw a diagonal backwards through the tower footprint.
  const candidates = traversed
    .map((point, index) => ({ point, index, distance: distance3(current, point) }))
    .filter(({ index, point }) => index > 0 && point[2] >= current[2] - 0.75)
    .sort((a, b) => a.distance - b.distance);
  const safe = candidates.find(({ point }) => exteriorSegmentIsClear(current, point));
  if (safe) return [current, ...traversed.slice(safe.index)];
  // Fall back to any safe forward connection before accepting a backwards join.
  for (let index = traversed.length - 1; index > 0; index -= 1) {
    if (exteriorSegmentIsClear(current, traversed[index])) return [current, ...traversed.slice(index)];
  }
  return [current, ...traversed];
}

export class EvacuationRuntime {
  graph: SimGraph = createEvacuationGraph();
  config: SimulationConfig = { ...DEFAULT_CONFIG };
  fires: FireSource[] = [];
  agents: RuntimeAgent[] = [];
  bundles: RouteBundle[] = [];
  edgeQueues = new Map<string, EdgeQueueState>();
  events: SimulationEvent[] = [];
  time = 0;
  /** A new population invalidates renderer history even if reset/start share one React batch. */
  revision = 0;
  running = false;
  completed = false;
  rerouteCount = 0;
  thermalRerouteCount = 0;
  collisionCorrections = 0;
  peakEdgeDensity = 0;
  firstArrival: number | null = null;
  estimatedMakespan = 0;
  private reroutePathCache = new Map<string, { at: number; path: RoutePath | null }>();
  private hazardReports = new Map<string, number>();
  private fireTransmissionLedger = new Map<string, Set<string>>();
  private lastFireTransmissionAt = -Infinity;
  private collisionCorrectionSamples: string[] = [];
  private reroutePlanningBudget = 0;
  private detourPlanningBudget = 0;
  private pendingDetourAgents = new Set<number>();
  private eventSequence = 0;
  private fireSequence = 0;
  private edgeMap = new Map<string, SimEdge>();
  private nodeMap = new Map<string, SimNode>();
  private crowdSnapshotAt = -Infinity;
  private activeEdgeCountsCache = new Map<string, number>();
  private forwardGapByAgentCache = new Map<number, number>();
  private planningReservedAt = -Infinity;
  private planningReservedCache = new Map<string, number>();

  reset(keepFires = true) {
    this.revision += 1;
    this.agents = [];
    this.bundles = [];
    this.edgeQueues.clear();
    this.events = [];
    this.eventSequence = 0;
    this.time = 0;
    this.running = false;
    this.completed = false;
    this.rerouteCount = 0;
    this.thermalRerouteCount = 0;
    this.collisionCorrections = 0;
    this.peakEdgeDensity = 0;
    this.firstArrival = null;
    this.estimatedMakespan = 0;
    this.reroutePathCache.clear();
    this.hazardReports.clear();
    this.fireTransmissionLedger.clear();
    this.lastFireTransmissionAt = -Infinity;
    this.collisionCorrectionSamples = [];
    this.reroutePlanningBudget = 0;
    this.detourPlanningBudget = 0;
    this.pendingDetourAgents.clear();
    this.crowdSnapshotAt = -Infinity;
    this.activeEdgeCountsCache.clear();
    this.forwardGapByAgentCache.clear();
    this.planningReservedAt = -Infinity;
    this.planningReservedCache.clear();
    if (!keepFires) {
      this.fires = [];
    } else {
      // Reset keeps only user-placed ignition sources. Propagated cells are regenerated
      // deterministically from t=0 so replaying the same scenario remains reproducible.
      this.fires = this.fires
        .filter((fire) => fire.origin !== "spread")
        .map((fire) => ({ ...fire, startTime: 0, generation: 0, parentId: undefined, hasSpread: false }));
    }
  }

  start(config: Partial<SimulationConfig> = {}) {
    this.reset(true);
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      populationTarget: normalizeStudentPopulation(config.populationTarget ?? TARGET_POPULATION),
      walkingSpeed: normalizeWalkingSpeed(config.walkingSpeed),
    };
    this.graph = createEvacuationGraph();
    this.edgeMap = new Map(this.graph.edges.map((edge) => [edge.id, edge]));
    this.nodeMap = new Map(this.graph.nodes.map((node) => [node.id, node]));
    // The alarm initiates evacuation, but occupants do not know the exact ignition
    // location until it is perceived or reported locally.
    const allocation = allocatePopulation(this.graph, this.config, [], 0);
    this.bundles = allocation.bundles;
    this.estimatedMakespan = this.estimateMakespan(allocation.reserved);
    const nodeMap = this.nodeMap;
    const roomMap = new Map(CLASSROOMS.map((room) => [room.id, room]));
    let id = 0;
    const roomCursor = new Map<string, number>();
    const goalCursor = new Map<string, number>();

    for (const bundle of this.bundles) {
      const room = roomMap.get(bundle.roomId);
      if (!room) continue;
      const roomNode = nodeMap.get(room.id);
      if (!roomNode) continue;
      for (let i = 0; i < bundle.peopleCount; i += 1) {
        const localIndex = roomCursor.get(room.id) ?? 0;
        roomCursor.set(room.id, localIndex + 1);
        const start = studentStartPosition(room, localIndex % CLASSROOM_CAPACITY);
        const goalIndex = goalCursor.get(bundle.path.goalId) ?? 0;
        goalCursor.set(bundle.path.goalId, goalIndex + 1);
        const goalNode = nodeMap.get(bundle.path.goalId);
        const assemblySlot = goalNode ? assemblySlotPosition(goalNode.position, goalIndex, this.config.crowdBehavior) : [...FIELD_CENTER] as Vec3;
        const groupSize = this.config.crowdBehavior === "surge" ? 16 : this.config.crowdBehavior === "grouped" ? 8 : 1;
        const groupSeed = Math.floor(id / groupSize);
        const speedSpread = this.config.crowdBehavior === "surge" ? 0.34 : this.config.crowdBehavior === "grouped" ? 0.2 : 0.12;
        const responseRange = Math.max(0, this.config.responseDelayMax - this.config.responseDelayMin);
        const groupResponse = this.config.responseDelayMin + hash01(groupSeed + 49) * responseRange;
        const individualResponseJitter = this.config.crowdBehavior === "orderly" ? 0 : hash01(id + 193) * 0.22;
        this.agents.push({
          id,
          gender: (localIndex + room.floor + room.index) % 2 === 0 ? "female" : "male",
          roomId: room.id,
          position: start,
          status: "waiting",
          speed: this.config.walkingSpeed * (1 - speedSpread + hash01(id + 17) * speedSpread * 2),
          responseDelay: Math.min(this.config.responseDelayMax, groupResponse + individualResponseJitter),
          route: bundle.path,
          edgeIndex: 0,
          edgeEntered: false,
          edgePath: [],
          segmentIndex: 0,
          segmentProgress: 0,
          arrivedAt: null,
          smokeExposure: false,
          lastRerouteAt: -Infinity,
          floor: room.floor,
          wing: room.side,
          phase: "room",
          currentNodeId: room.id,
          assemblySlot,
          retreating: false,
          knownFireIds: new Set<string>(),
          fireKnowledge: new Map(),
          groupLeaderId: id - (localIndex % groupSize),
          riskAversion: 0.35 + hash01(id + 401) * 0.6,
          smokeSensitivity: 0.65 + hash01(id + 503) * 0.7,
          heatSensitivity: 0.78 + hash01(id + 521) * 0.48,
          // People do not notice weak smoke at exactly the same concentration.
          // Lower values represent occupants with a more sensitive sense of smell.
          smokeDetectionThreshold: 0.025 + hash01(id + 557) * 0.035,
          heatDetectionThreshold: 0.045 + hash01(id + 571) * 0.045,
          smokeAwareness: "none",
          heatAwareness: "none",
          perceivedSmoke: 0,
          perceivedHeat: 0,
          visibility: 1,
          familiarity: 0.42 + hash01(id + 607) * 0.55,
          groupCohesion: this.config.crowdBehavior === "surge" ? 0.78 + hash01(groupSeed + 701) * 0.18 : this.config.crowdBehavior === "grouped" ? 0.62 + hash01(groupSeed + 701) * 0.28 : 0.18 + hash01(id + 701) * 0.34,
          queueToleranceSeconds: 8 + hash01(id + 809) * 11,
          decisionLatency: 0.35 + hash01(id + 907) * 2.2,
          stress: 0,
          health: 1,
          flameContactSeconds: 0,
          smokeDose: 0,
          heatDose: 0,
          heatExposure: false,
          protectivePosture: false,
          incapacitatedAt: null,
          decisionState: "waiting",
          hasPassedRoomDoor: false,
          hasExitedBuilding: false,
          lastHazardUpdateAt: -Infinity,
          cachedTrueRisk: { fire: 0, smoke: 0, heat: 0, blocked: false },
          cachedPerceivedFires: [],
          detourPath: [],
          detourIndex: 0,
          lastDetourPlanAt: -Infinity,
        });
        id += 1;
      }
    }

    this.running = true;
    this.pushEvent("info", "เริ่มการจำลอง", `เริ่มจำลอง ${this.agents.length.toLocaleString("th-TH")} คน · เปิดใช้การนำทางตามโครงสร้างอาคารและการตรวจขอบเขตการเดิน`);
    this.pushEvent("success", "Physical topology guard active", "Agent ถูกบังคับ Room → Door → Corridor → Stair → ชั้น 1 → Exit → สนาม ไม่มีเส้นลัดทะลุอาคาร");
    this.pushEvent("info", "Human decision model active", "นักเรียนมีข้อมูลไม่สมบูรณ์ ตอบสนองต่างกันตามความคุ้นเคย ความกลัวควัน ความเครียด คิว และการตามกลุ่ม");
    this.pushEvent("success", "เปิดการประเมินเส้นทางตามความเสี่ยง", "ประเมินเวลาถึงแต่ละช่วงทางและคาดการณ์เปลวไฟ ควัน และความร้อนก่อนเลือกบันไดหรือทางออก พร้อมละกลุ่มเมื่อเส้นทางกลุ่มเสี่ยงเกินไป");
    this.pushEvent("success", "Smoke perception active", "แต่ละคนรับรู้ควันต่างกันจากกลิ่น การมองเห็น ระยะมองเห็น และคำเตือนในพื้นที่ ก่อนตัดสินใจเปลี่ยนเส้นทาง");
    this.pushEvent("success", "Direct-flame contact model active", "ควันและความร้อนทำให้มองเห็นน้อยลง ชะลอ และเปลี่ยนเส้นทาง; นักเรียนจะหมดสติเฉพาะเมื่อร่างกายสัมผัสขอบเขตเปลวไฟต่อเนื่องเท่านั้น");
    if (this.config.fireSpreadEnabled) {
      this.pushEvent("success", "Object-connected fire spread active", "ไฟลามเฉพาะวัตถุที่เชื่อมกันจริง: ห้อง → ประตู → ทางเดิน → บันได โดยผนังคอนกรีตและพื้นแต่ละชั้นไม่ถูกข้ามด้วยรัศมีวงกลม");
    }
    if (this.agents.length < this.config.populationTarget) {
      this.pushEvent("danger", "Route validation warning", `${(this.config.populationTarget - this.agents.length).toLocaleString("th-TH")} คนไม่มีเส้นทางปลอดภัยไปสนามภายใต้ Hazard ปัจจุบัน`);
    }
    if (this.fires.length) this.pushEvent("warning", "Fire scenario active", `มีจุดไฟ ${this.fires.length} จุด ระบบใช้ Fire-forecast + Dynamic rerouting`);
  }

  pause() { this.running = false; }
  resume() { if (!this.completed && this.agents.length) this.running = true; }

  /**
   * Changes an active population's speed without rebuilding its routes.
   * Individual variation is preserved while the graph, doorway and wall guards
   * continue to own every accepted movement.
   */
  setWalkingSpeed(value: number) {
    const previous = normalizeWalkingSpeed(this.config.walkingSpeed);
    const next = normalizeWalkingSpeed(value, previous);
    if (Math.abs(next - previous) <= Number.EPSILON) return;
    const ratio = next / previous;
    this.config.walkingSpeed = next;
    this.agents.forEach((agent) => {
      const scaled = agent.speed * ratio;
      agent.speed = Number.isFinite(scaled) ? scaled : Number.MAX_VALUE;
    });
    const remainingEstimate = Math.max(0, this.estimatedMakespan - this.time);
    this.estimatedMakespan = this.time + remainingEstimate / ratio;
    this.reroutePathCache.clear();
  }

  private nearestFireAttachment(position: Vec3, floor: number): FireAttachmentNode | undefined {
    if (floor < 1) return undefined;
    let nearest: FireAttachmentNode | undefined;
    let nearestDistance = Infinity;
    for (const node of this.graph.nodes) {
      if (node.floor !== floor || !isFireAttachmentNode(node)) continue;
      const distance = distance3(position, node.position);
      if (distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  addFire(position: Vec3, options: Partial<FireSource> = {}): FireSource {
    const rawWing = classifyWing(position);
    const outside = rawWing === "outdoor" || rawWing === "assembly" || position[2] > 65;
    const floor = outside ? 0 : floorFromY(position[1]);
    const snapped: Vec3 = outside
      ? [position[0], Math.max(0.18, position[1]), position[2]]
      : [position[0], floorBase(floor) + SLAB_THICKNESS + .01, position[2]];
    const attachment = options.attachmentNodeId
      ? this.graph.nodes.find((node): node is FireAttachmentNode => node.id === options.attachmentNodeId && isFireAttachmentNode(node))
      : this.nearestFireAttachment(snapped, floor);
    const fire: FireSource = {
      id: `fire-${Date.now()}-${++this.fireSequence}`,
      position: snapped,
      startTime: options.startTime ?? this.time,
      intensity: options.intensity ?? 1,
      fireRadius: options.fireRadius ?? 3.2,
      smokeRadius: options.smokeRadius ?? 8.5,
      spreadRate: options.spreadRate ?? 0.028,
      enabled: true,
      floor,
      wing: outside ? "outdoor" : rawWing,
      origin: options.origin ?? "primary",
      generation: options.generation ?? 0,
      parentId: options.parentId,
      hasSpread: options.hasSpread ?? false,
      attachmentNodeId: attachment?.id,
      attachmentKind: attachment?.type,
      spreadPath: options.spreadPath?.map((point) => [...point] as Vec3),
      spreadTravelStartTime: options.spreadTravelStartTime,
    };
    this.fires.push(fire);
    const travelling = fire.origin === "spread" && fire.spreadTravelStartTime != null && fire.startTime > this.time;
    this.pushEvent(
      "danger",
      travelling ? "แนวไฟกำลังลาม" : fire.origin === "spread" ? "ไฟลามถึงวัตถุถัดไป" : "เพิ่มจุดไฟ",
      `${floor ? `ชั้น ${floor}` : "ภายนอก"} · ${fire.wing} · ${fire.origin === "spread" ? `generation ${fire.generation} · ${travelling ? `จะติดไฟใน ${Math.max(0.1, fire.startTime - this.time).toFixed(1)}s` : "ติดไฟแล้ว"}` : "Hazard-aware rerouting เปิดใช้งาน"}`,
    );
    return fire;
  }

  /**
   * Object-connected fire propagation.
   * Every source is attached to a real graph object (room contents, door, corridor or stair).
   * A new source may be scheduled only across an indoor architectural edge, so concrete walls and
   * floor slabs are never crossed by a growing radius. Its visible front then travels along that
   * exact edge before the target object becomes hazardous. Stair edges allow both directions,
   * with upward stack effect faster than downward transfer. This remains an educational model and
   * requires material/fire-engineering calibration before any life-safety use.
   */
  private updateFireSpread() {
    // Bounded material patches advance a connected flame front. Every already-reached
    // part of a path remains visibly alight and uses the same contact geometry.
    const maximumBurningObjects = MAX_OBJECT_CONNECTED_FIRE_PATCHES;
    if (!this.config.fireSpreadEnabled || this.fires.length >= maximumBurningObjects) return;
    // Advance the fire as a slow, continuous front. The cadence stays frequent enough for a
    // connected visual trail, but slower overall so the spread no longer races or pops.
    const transmissionCadence = Math.max(0.95, Math.min(1.35, 1.24 - this.fires.length * 0.01));
    if (this.time - this.lastFireTransmissionAt < transmissionCadence) return;

    const nodeMap = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const adjacency = new Map<string, Array<{ edge: SimEdge; target: FireAttachmentNode }>>();
    for (const edge of this.graph.edges) {
      if (!edge.insideBuilding) continue;
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to || !isFireAttachmentNode(from) || !isFireAttachmentNode(to)) continue;
      const fromList = adjacency.get(from.id) ?? [];
      fromList.push({ edge, target: to });
      adjacency.set(from.id, fromList);
      const toList = adjacency.get(to.id) ?? [];
      toList.push({ edge, target: from });
      adjacency.set(to.id, toList);
    }

    const burningNodes = new Set(this.fires.map((fire) => fire.attachmentNodeId).filter((id): id is string => Boolean(id)));
    const nodeBaseDelay: Record<FireAttachmentKind, number> = {
      room: 12.5,
      door: 7.4,
      corridor: 10.2,
      junction: 11.0,
      stair: 12.0,
    };
    const matureRadius: Record<FireAttachmentKind, number> = {
      room: 1.42,
      door: 0.46,
      corridor: 0.72,
      junction: 0.80,
      stair: 0.44,
    };
    const smokeEnvelope: Record<FireAttachmentKind, number> = {
      room: 4.8,
      door: 2.9,
      corridor: 3.5,
      junction: 3.8,
      stair: 3.4,
    };
    const fuelFactor: Record<FireAttachmentKind, number> = {
      room: 1,
      door: 0.82,
      corridor: 0.68,
      junction: 0.72,
      stair: 0.62,
    };
    const ignitionPositionFor = (target: FireAttachmentNode): Vec3 => {
      // Navigation nodes sit on the pedestrian centerline. Actual combustible finishes are at
      // room contents, door leaves, corridor edges and landing edges, so offset only the visual /
      // local flame patch while retaining the exact attachment node for propagation topology.
      let offsetX = 0;
      let offsetZ = 0;
      if (target.type === "door") {
        if (target.wing === "pink") offsetZ = -0.78;
        else if (target.wing === "blue") offsetX = 0.78;
      } else if (target.type === "corridor") {
        if (target.wing === "pink") offsetZ = -1.22;
        else if (target.wing === "blue") offsetX = 1.22;
      } else if (target.type === "junction") {
        offsetX = -1.22;
        offsetZ = 1.02;
      } else if (target.type === "stair") {
        offsetX = target.id.includes("right") ? -0.92 : 0.92;
        offsetZ = target.id.includes("left") ? 0.34 : -0.34;
      }
      return [target.position[0] + offsetX, target.position[1] + .05, target.position[2] + offsetZ];
    };

    const orderedSources = [...this.fires].sort((a, b) => a.generation - b.generation || a.startTime - b.startTime || a.id.localeCompare(b.id));
    for (const source of orderedSources) {
      if (this.fires.length >= maximumBurningObjects) break;
      if (!source.enabled || this.time < source.startTime || source.generation >= MAX_FIRE_SPREAD_GENERATION) continue;
      const attachment = source.attachmentNodeId ? nodeMap.get(source.attachmentNodeId) : undefined;
      if (!attachment || !isFireAttachmentNode(attachment)) continue;
      const transmitted = this.fireTransmissionLedger.get(source.id) ?? new Set<string>();
      this.fireTransmissionLedger.set(source.id, transmitted);
      const sourceAge = this.time - source.startTime;
      const eligible = (adjacency.get(attachment.id) ?? [])
        .map(({ edge, target }) => {
          const floorDelta = target.floor - attachment.floor;
          const targetPosition = ignitionPositionFor(target);
          // Fire can propagate either way through a stairwell. The one-way evacuation rule
          // belongs to pedestrians; use the full tread/landing path for both flame directions.
          const physicalEdgePath = traversalPoints({ ...edge, twoWay: true }, nodeMap, attachment.id, target.id);
          const spreadPath = compactPolyline([
            source.position,
            ...physicalEdgePath.slice(1, -1).map((point) => [point[0], point[1] + .05, point[2]] as Vec3),
            targetPosition,
          ]);
          const pathDistance = spreadPath.slice(1).reduce((sum, point, index) => sum + distance3(spreadPath[index], point), 0);
          const intensitySpeedup = Math.max(0.72, Math.min(1.22, 1.1 / Math.max(0.35, source.intensity)));
          // The source must heat the next material before a visible front starts. Once started,
          // the front advances continuously instead of teleporting to the target node. Upward
          // stack movement is faster; downward propagation remains possible but takes longer.
          const ignitionDelay = nodeBaseDelay[attachment.type] * intensitySpeedup;
          const frontSpeed = edge.kind === "stair"
            ? (floorDelta > 0 ? 0.62 : 0.42)
            : target.type === "room"
              ? 0.28
              : target.type === "door"
                ? 0.38
                : target.type === "corridor"
                  ? 0.44
                  : 0.40;
          const directionalDelay = floorDelta > 0 ? 2.2 : floorDelta < 0 ? 6.4 : 1.1;
          const travelDuration = Math.max(6.0, Math.min(42, pathDistance / Math.max(0.18, frontSpeed) + directionalDelay));
          const maxTransferDistance = edge.kind === "stair" ? MAX_STAIR_FIRE_TRANSFER_DISTANCE : MAX_HORIZONTAL_FIRE_TRANSFER_DISTANCE;
          // A switchback stair is longer than the straight separation between adjacent objects.
          // Bound object separation while retaining the entire physical path for travel time.
          const transferDistance = edge.kind === "stair" ? distance3(source.position, targetPosition) : pathDistance;
          const transferTooFar = transferDistance > maxTransferDistance;
          const verticalPriority = edge.kind === "stair" && floorDelta > 0 ? -1.4 : edge.kind === "stair" && floorDelta < 0 ? 2.8 : 0;
          return { edge, target, targetPosition, spreadPath, pathDistance, transferTooFar, ignitionDelay, travelDuration, verticalPriority };
        })
        .filter(({ target, ignitionDelay, transferTooFar }) => !transferTooFar && sourceAge >= ignitionDelay && !transmitted.has(target.id) && !burningNodes.has(target.id))
        .sort((a, b) => (a.ignitionDelay + a.travelDuration + a.verticalPriority + hash01(source.id.length + a.target.id.length * 17) * 0.28)
          - (b.ignitionDelay + b.travelDuration + b.verticalPriority + hash01(source.id.length + b.target.id.length * 17) * 0.28));

      // Ignite one connected object at a time. Children still need their own ignition delay,
      // producing an irregular front instead of a simultaneous circular pulse.
      for (const { target, targetPosition, spreadPath, travelDuration } of eligible.slice(0, 1)) {
        if (this.fires.length >= maximumBurningObjects) break;
        transmitted.add(target.id);
        burningNodes.add(target.id);
        source.hasSpread = true;
        const floorDelta = target.floor - attachment.floor;
        const verticalFactor = floorDelta > 0 ? 0.88 : floorDelta < 0 ? 0.60 : 1;
        const intensity = Math.max(0.34, Math.min(1.1, source.intensity * fuelFactor[target.type] * verticalFactor));
        this.addFire(targetPosition, {
          // Destination ignition is delayed. Before arrival, only reached trail cells burn.
          startTime: this.time + travelDuration,
          intensity,
          fireRadius: matureRadius[target.type],
          smokeRadius: smokeEnvelope[target.type],
          spreadRate: Math.max(0.004, source.spreadRate * 0.52),
          origin: "spread",
          generation: source.generation + 1,
          parentId: source.id,
          attachmentNodeId: target.id,
          attachmentKind: target.type,
          spreadPath,
          spreadTravelStartTime: this.time,
        });
        this.lastFireTransmissionAt = this.time;
        return;
      }
    }
  }

  removeFire(id: string) {
    this.fires = this.fires.filter((fire) => fire.id !== id);
    this.fireTransmissionLedger.delete(id);
  }

  clearFires() {
    this.fires = [];
    this.fireTransmissionLedger.clear();
    this.pushEvent("info", "ล้างจุดไฟ", "ลบ Fire Source ทั้งหมดออกจาก Scenario แล้ว");
  }

  addPresetFire(preset: "left" | "center" | "right") {
    const positions: Record<typeof preset, Vec3> = {
      left: [-43, walkY(5) + 0.25, -3.5],
      center: [2.75, walkY(4) + 0.25, 1.8],
      right: [3.3, walkY(6) + 0.25, 45],
    };
    return this.addFire(positions[preset]);
  }

  private knownFireSources(agent: RuntimeAgent): FireSource[] {
    return this.fires.filter((fire) => agent.knownFireIds.has(fire.id));
  }

  private rememberFire(agent: RuntimeAgent, fire: FireSource, source: Exclude<HazardAwareness, "none">) {
    const previous = agent.fireKnowledge.get(fire.id);
    const sourceRank: Record<Exclude<HazardAwareness, "none">, number> = { reported: 1, smoke: 2, heat: 3, direct: 4 };
    if (previous && sourceRank[previous.source] >= sourceRank[source]) return;
    const uncertainty = source === "direct"
      ? 0.35 + hash01(agent.id + fire.id.length * 13) * 1.15
      : source === "smoke"
        ? 1.1 + hash01(agent.id + fire.id.length * 23) * 2.3
        : source === "heat"
          ? 0.75 + hash01(agent.id + fire.id.length * 27) * 1.75
          : 2.1 + hash01(agent.id + fire.id.length * 29) * 3.8;
    const angle = hash01(agent.id * 1.7 + fire.id.length * 43) * Math.PI * 2;
    const believedPosition: Vec3 = [
      fire.position[0] + Math.cos(angle) * uncertainty,
      fire.position[1],
      fire.position[2] + Math.sin(angle) * uncertainty,
    ];
    agent.knownFireIds.add(fire.id);
    agent.fireKnowledge.set(fire.id, { source, learnedAt: this.time, believedPosition });
    if (source === "direct" || source === "smoke" || source === "heat") {
      agent.decisionState = "assessing";
      const sensoryLatency = source === "direct" ? agent.decisionLatency : source === "heat" ? agent.decisionLatency * 0.72 : agent.decisionLatency * 1.25;
      agent.responseDelay = Math.min(agent.responseDelay, this.time + sensoryLatency);
    } else if (source === "reported") {
      // A verified school alarm does not reveal an exact flame position, but it should still
      // shorten hesitation and trigger a fresh survival-route assessment.
      agent.decisionState = "assessing";
      agent.responseDelay = Math.min(agent.responseDelay, this.time + Math.max(0.65, agent.decisionLatency * 0.8));
    }
  }

  private awarenessLevel(agent: RuntimeAgent): HazardAwareness {
    let level: HazardAwareness = "none";
    const rank: Record<HazardAwareness, number> = { none: 0, reported: 1, smoke: 2, heat: 3, direct: 4 };
    agent.fireKnowledge.forEach((knowledge) => {
      if (rank[knowledge.source] > rank[level]) level = knowledge.source;
    });
    return level;
  }

  /**
   * Human-scale situational awareness. Smoke is sensed independently by smell and
   * visibility, while flames require a shorter sight line. A detected hazard is
   * shared locally after a delay, so distant occupants never receive omniscient data.
   */
  private scheduleHazardReports(agent: RuntimeAgent, fire: FireSource, localKey: string) {
    if (this.hazardReports.has(localKey)) return;
    const localDelay = 0.8 + hash01(agent.id + fire.id.length * 19) * 1.4 + (1 - agent.familiarity) * 0.45;
    this.hazardReports.set(localKey, this.time + localDelay);

    // A school alarm and shouted warnings spread progressively. People still receive only an
    // approximate report: the exact ignition point remains unknown until they sense it themselves.
    const zones: AgentWing[] = ["pink", "blue", "core"];
    zones.forEach((wing) => {
      const crossWingKey = `${fire.id}:${agent.floor}:${wing}`;
      if (!this.hazardReports.has(crossWingKey)) {
        const crossWingDelay = localDelay + 1.2 + hash01(fire.id.length * 31 + agent.floor * 7 + wing.length) * 0.9;
        this.hazardReports.set(crossWingKey, this.time + crossWingDelay);
      }
    });
    [-1, 1].forEach((floorOffset) => {
      const adjacentFloor = agent.floor + floorOffset;
      if (adjacentFloor < 1 || adjacentFloor > 9) return;
      const stairKey = `${fire.id}:${adjacentFloor}:${agent.wing}`;
      if (!this.hazardReports.has(stairKey)) {
        const verticalDelay = localDelay + 2.1 + hash01(fire.id.length * 37 + adjacentFloor * 11) * 1.1;
        this.hazardReports.set(stairKey, this.time + verticalDelay);
      }
    });
  }

  private updateFireAwareness(agent: RuntimeAgent, totalLocalRisk = pointRisk(agent.position, this.fires, this.time)): FireSource[] {
    agent.perceivedSmoke = Math.max(0, Math.min(1, totalLocalRisk.smoke * agent.smokeSensitivity));
    agent.perceivedHeat = Math.max(0, Math.min(1, totalLocalRisk.heat * agent.heatSensitivity));
    agent.visibility = Math.max(0.12, Math.min(1, 1 - totalLocalRisk.smoke * (0.66 + agent.smokeSensitivity * 0.16)));
    agent.smokeAwareness = [...agent.fireKnowledge.values()].some((knowledge) => knowledge.source === "reported") ? "reported" : "none";
    agent.heatAwareness = [...agent.fireKnowledge.values()].some((knowledge) => knowledge.source === "reported") ? "reported" : "none";
    for (const fire of this.fires) {
      if (!fireHasStarted(fire, this.time)) continue;
      const visibleCells = flameCellsAt(fire, this.time);
      const sameFloor = visibleCells.some((cell) => cell.floor === agent.floor || cell.floor === 0);
      const sameZone = fire.wing === agent.wing || fire.wing === "core" || agent.wing === "core";
      const horizontalDistance = visibleCells.reduce((nearest, cell) => Math.min(nearest, Math.hypot(cell.position[0] - agent.position[0], cell.position[2] - agent.position[2])), Infinity);
      const canSenseLocally = sameFloor && sameZone;
      const localRisk = canSenseLocally ? pointRisk(agent.position, [fire], this.time) : { fire: 0, smoke: 0, heat: 0, blocked: false };
      const smokeSignal = localRisk.smoke * agent.smokeSensitivity;
      const heatSignal = localRisk.heat * agent.heatSensitivity;
      const smelledSmoke = sameFloor && sameZone && smokeSignal >= agent.smokeDetectionThreshold;
      const visibleSmoke = sameFloor && sameZone && smokeSignal >= agent.smokeDetectionThreshold * 2.15;
      const sensedHeat = sameFloor && sameZone && heatSignal >= agent.heatDetectionThreshold;
      const painfulHeat = sameFloor && sameZone && heatSignal >= agent.heatDetectionThreshold * 3.1;
      const flameSightRange = Math.max(4.5, Math.min(10.5, fireRadiusAt(fire, this.time) + 4.5)) * Math.max(0.45, agent.visibility);
      const directlySawFlame = sameFloor && sameZone && horizontalDistance <= flameSightRange && localRisk.fire > 0.025;
      const reportKey = `${fire.id}:${agent.floor}:${agent.wing}`;
      const previousKnowledge = agent.fireKnowledge.get(fire.id);
      const locallyDiscovered = directlySawFlame || smelledSmoke || visibleSmoke || sensedHeat;

      if (directlySawFlame) {
        this.rememberFire(agent, fire, "direct");
      } else if (sensedHeat) {
        this.rememberFire(agent, fire, "heat");
      } else if (smelledSmoke || visibleSmoke) {
        this.rememberFire(agent, fire, "smoke");
      }
      if (visibleSmoke) agent.smokeAwareness = "visible";
      else if (smelledSmoke && agent.smokeAwareness !== "visible") agent.smokeAwareness = "smelled";
      if (painfulHeat) agent.heatAwareness = "painful";
      else if (sensedHeat && agent.heatAwareness !== "painful") agent.heatAwareness = "sensed";

      if (locallyDiscovered) {
        if (!this.hazardReports.has(reportKey)) {
          this.scheduleHazardReports(agent, fire, reportKey);
          if (this.hazardReports.size <= 18) {
            this.pushEvent("warning", "Local fire discovery", `มีผู้พบไฟ/ควัน ชั้น ${agent.floor} · ${agent.wing} และเริ่มแจ้งเตือนคนบริเวณเดียวกัน`);
          }
        }
      } else if (!previousKnowledge) {
        const reportedAt = this.hazardReports.get(reportKey);
        if (reportedAt != null && this.time >= reportedAt) {
          this.rememberFire(agent, fire, "reported");
          if (agent.smokeAwareness === "none") agent.smokeAwareness = "reported";
          if (agent.heatAwareness === "none") agent.heatAwareness = "reported";
        }
      }
    }
    return this.knownFireSources(agent);
  }

  private getEdge(agent: RuntimeAgent, edgeMap: Map<string, SimEdge>) {
    return edgeMap.get(agent.route.edgeIds[agent.edgeIndex]);
  }

  private prepareEdge(agent: RuntimeAgent, edge: SimEdge, nodeMap: Map<string, SimNode>) {
    const currentNodeId = agent.route.nodeIds[agent.edgeIndex];
    const nextNodeId = agent.route.nodeIds[agent.edgeIndex + 1];
    const currentNode = nodeMap.get(currentNodeId);
    if (edge.id.startsWith("edge-door-corr-") && !agent.hasPassedRoomDoor) return false;
    if ((edge.kind === "outdoor" || edge.kind === "assembly") && !agent.hasExitedBuilding) return false;
    if (edge.kind === "exit" && !edge.insideBuilding) {
      const atPhysicalDoor = currentNode?.type === "door"
        && distance3(agent.position, currentNode.position) <= STAIR_EXIT_DOOR_WIDTH * 0.5;
      if (!atPhysicalDoor) return false;
    }
    const traversed = traversalPoints(edge, nodeMap, currentNodeId, nextNodeId);
    if (traversed.length < 2) return false;
    // After an outdoor detour, the agent may cross the field-gate region several metres to the
    // side of the graph node. Do not force the next assembly edge back through the exact gate
    // center (which may be where the fire sits). Treat the field gate as a portal region and
    // continue from the physically safe position the pedestrian actually reached.
    const openPortalContinuation = edge.kind === "assembly" && agent.hasExitedBuilding;
    const midOutdoorReroute = edge.kind === "outdoor"
      && agent.phase === "outdoor"
      && currentNode?.type === "exit"
      && distance3(agent.position, currentNode.position) > 0.65;
    const reroutePoints = midOutdoorReroute
      ? joinOutdoorReroute(agent.position, traversed)
      : openPortalContinuation
        ? [agent.position, ...traversed.slice(1)]
        : [agent.position, ...traversed];
    const corridorContinuation = agent.detourExitSide && edgeSupportsLocalBypass(edge)
      && (currentNode?.type === "corridor" || currentNode?.type === "junction")
      && pointInsideWalkableCorridor(agent.position, traversed, edge);
    // The corridor node is a cross-section, not a compulsory point on the centerline. Retain
    // the original physical envelope when continuing from the safe side of a burning node.
    const points = dedupePoints(corridorContinuation ? traversed : reroutePoints);
    if (edge.kind === "assembly") points[points.length - 1] = [...agent.assemblySlot] as Vec3;
    agent.edgePath = points;
    agent.detourPath = [];
    agent.detourIndex = 0;
    agent.lastDetourPlanAt = -Infinity;
    agent.detourExitSide = false;
    this.pendingDetourAgents.delete(agent.id);
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.edgeEntered = true;
    agent.retreating = false;
    agent.status = "evacuating";
    agent.decisionState = agent.knownFireIds.size ? "assessing" : "following-plan";
    if (edge.kind === "stair") agent.phase = "stair";
    else if (edge.kind === "outdoor") { agent.phase = "outdoor"; agent.wing = "outdoor"; agent.floor = 0; }
    else if (edge.kind === "assembly") { agent.phase = "assembly"; agent.wing = "assembly"; agent.floor = 0; }
    return true;
  }

  private beginRetreat(agent: RuntimeAgent, nodeMap: Map<string, SimNode>) {
    this.pendingDetourAgents.delete(agent.id);
    agent.detourExitSide = false;
    agent.detourPath = [];
    agent.detourIndex = 0;
    const currentNodeId = agent.route.nodeIds[agent.edgeIndex];
    const currentNode = nodeMap.get(currentNodeId);
    if (!currentNode || pointRisk(currentNode.position, this.fires, this.time + 1.5).blocked) {
      // Never teleport an occupant through a wall to escape a hazard. A safe-stop remains a
      // *temporary* rerouting state so the agent keeps testing alternate gates/routes as the
      // hazard and queues evolve instead of becoming permanently stuck.
      agent.status = agent.hasExitedBuilding ? "rerouting" : "blocked";
      agent.decisionState = "safe-stop";
      agent.lastRerouteAt = Math.min(agent.lastRerouteAt, this.time - 0.5);
      this.pushEvent("warning", "Safe-stop", `Agent #${agent.id} หยุดชั่วคราวก่อนพื้นที่ไฟ และจะหาเส้นทางปลอดภัยใหม่`);
      return;
    }

    // Reverse the *already traversed* polyline, not a straight chord to the node. This keeps the
    // pedestrian inside the same doorway/corridor/stair geometry while retreating.
    const reverse: Vec3[] = [[...agent.position] as Vec3];
    if (agent.edgePath.length > 1) {
      for (let i = Math.min(agent.segmentIndex, agent.edgePath.length - 1); i >= 0; i -= 1) {
        const point = agent.edgePath[i];
        if (distance3(reverse[reverse.length - 1], point) > 0.015) reverse.push([...point] as Vec3);
      }
    }
    if (distance3(reverse[reverse.length - 1], currentNode.position) > 0.015) reverse.push([...currentNode.position] as Vec3);
    agent.edgePath = dedupePoints(reverse);
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.edgeEntered = true;
    agent.retreating = true;
    agent.status = "rerouting";
  }

  private incapacitateAgent(agent: RuntimeAgent, reason: string) {
    if (agent.status === "incapacitated") return;
    this.pendingDetourAgents.delete(agent.id);
    agent.status = "incapacitated";
    agent.decisionState = "safe-stop";
    agent.incapacitatedAt = this.time;
    agent.edgeEntered = false;
    agent.edgePath = [];
    agent.retreating = false;
    agent.health = 0;
    this.pushEvent("danger", "ต้องการความช่วยเหลือ", `Agent #${agent.id} หมดสติจาก${reason} · ทีมช่วยเหลือต้องเข้าถึงตำแหน่งปัจจุบัน`);
  }

  /** Follow a retained zigzag at walking speed; do not snap back to a crowd lane each frame. */
  private advanceDetour(agent: RuntimeAgent, edge: SimEdge, speed: number, dt: number): boolean {
    if (agent.detourPath.length < 2) return false;
    let remaining = speed * dt;
    let position = agent.position;
    while (remaining > 0.000001 && agent.detourIndex < agent.detourPath.length) {
      const target = agent.detourPath[agent.detourIndex];
      const length = distance3(position, target);
      const candidate = lerp3(position, target, length < 0.000001 ? 1 : Math.min(1, remaining / length));
      if (segmentTouchesFlame(position, candidate, this.fires, this.time + 0.35, PEDESTRIAN_RADIUS + 0.04)
        || !segmentInsideWalkway(position, candidate, agent.edgePath, edge)) {
        agent.detourPath = [];
        return false;
      }
      remaining -= length;
      position = candidate;
      if (distance3(candidate, target) > 0.000001) break;
      agent.detourIndex += 1;
    }
    agent.position = position;
    const projected = closestPointOnPolyline(position, agent.edgePath);
    const state = segmentStateAtDistance(agent.edgePath, projected.distanceAlong);
    agent.segmentIndex = state.segmentIndex;
    agent.segmentProgress = state.progress;
    if (agent.segmentProgress >= 0.999999) { agent.segmentIndex += 1; agent.segmentProgress = 0; }
    agent.status = "evacuating";
    agent.decisionState = "avoiding-hazard";
    if (agent.detourIndex >= agent.detourPath.length) {
      agent.detourExitSide = distance3(position, agent.edgePath[agent.edgePath.length - 1]) > 0.04;
      agent.detourPath = [];
    }
    return true;
  }



  private updateContextFromNode(agent: RuntimeAgent, node: SimNode | undefined) {
    const ctx = nodeContext(node);
    agent.floor = ctx.floor;
    agent.wing = ctx.wing;
    agent.phase = ctx.phase;
    if (node) agent.currentNodeId = node.id;
  }

  /**
   * Predicts what this person is likely to encounter at the time they reach each edge. Using
   * travel time (rather than a fixed edge index) is essential for upper-floor occupants because
   * fire and smoke can change substantially before they reach a lower stair landing.
   */
  private forecastRouteHazard(agent: RuntimeAgent, edgeIds: string[], perceivedFires: FireSource[], edgeMap: Map<string, SimEdge>) {
    let eta = Math.max(0.8, agent.decisionLatency * 0.45);
    let fire = 0;
    let smoke = 0;
    let heat = 0;
    let blocked = false;
    let thermalBlocked = false;
    let maxModeledTemperatureC = this.config.ambientTemperatureC ?? 29;
    let danger = 0;
    const configuredLookAhead = Math.max(4, Math.min(20, Math.round(this.config.thermalLookAheadEdges ?? 10)));
    const limit = Math.min(edgeIds.length, configuredLookAhead);
    for (let index = 0; index < limit; index += 1) {
      const edge = edgeMap.get(edgeIds[index]);
      if (!edge) continue;
      const queue = this.edgeQueues.get(edge.id);
      const queueDelay = Math.min(8, Math.max(0, (queue?.nextEntryTime ?? this.time) - this.time));
      eta += edge.distance / Math.max(0.3, agent.speed * edge.speedMultiplier) + queueDelay;
      const risk = edgeRiskSnapshot(this.graph, edge.id, perceivedFires, this.time + eta, this.nodeMap, this.edgeMap);
      fire = Math.max(fire, risk.fire);
      smoke = Math.max(smoke, risk.smoke);
      heat = Math.max(heat, risk.heat);
      const modeledTemperatureC = modeledTemperatureFromHeat(risk.heat, this.config.ambientTemperatureC ?? 29);
      maxModeledTemperatureC = Math.max(maxModeledTemperatureC, modeledTemperatureC);
      thermalBlocked ||= modeledTemperatureC >= (this.config.hardBlockTemperatureC ?? 62) && !risk.detourAvailable;
      blocked ||= risk.blocked || thermalBlocked;
      danger = Math.max(
        danger,
        (risk.blocked ? 2 : 0)
          + risk.fire * 1.55
          + risk.heat * agent.heatSensitivity * 1.05
          + Math.max(0, modeledTemperatureC - (this.config.heatAvoidThresholdC ?? 44)) / 18
          + risk.smoke * agent.smokeSensitivity * 0.72,
      );
      if (blocked) break;
    }
    return { eta, fire, smoke, heat, blocked, thermalBlocked, maxModeledTemperatureC, danger };
  }

  step(delta: number) {
    if (!this.running || this.completed || !Number.isFinite(delta) || delta <= 0) return;
    const dt = Math.min(0.35, Math.max(0, delta));
    this.time += dt;
    this.updateFireSpread();
    const edgeMap = this.edgeMap;
    const nodeMap = this.nodeMap;
    const firesByFloor = new Map<number, FireSource[]>();
    for (const fire of this.fires) {
      if (!fireHasStarted(fire, this.time)) continue;
      const floors = new Set([fire.floor, ...flameCellsAt(fire, this.time).map((cell) => cell.floor)]);
      for (const activeFloor of floors) {
        const list = firesByFloor.get(activeFloor) ?? [];
        list.push(fire); firesByFloor.set(activeFloor, list);
      }
    }
    const outdoorFires = firesByFloor.get(0) ?? [];
    // Broad-phase fire culling: most of the 3,000 occupants are nowhere near any active source.
    // Filter with the mature maximum envelope before calling pointRisk(), which avoids repeatedly
    // evaluating distant fire/smoke sources on every microscopic movement step.
    const trueFiresAt = (point: Vec3) => {
      const local = firesByFloor.get(floorFromY(point[1])) ?? [];
      if (!local.length && !outdoorFires.length) return [];
      const candidates: FireSource[] = [];
      const appendIfNear = (fire: FireSource) => {
        if (!fireMayAffectPoint(fire, point, 1.25)) return;
        candidates.push(fire);
      };
      local.forEach(appendIfNear);
      outdoorFires.forEach((fire) => {
        if (!local.includes(fire)) appendIfNear(fire);
      });
      return candidates;
    };
    // Queue reservations are routing estimates, not collision constraints. Refresh them a few
    // times per simulated second rather than rebuilding a 369-edge snapshot on every substep.
    if (this.time - this.planningReservedAt >= 0.22 || this.planningReservedCache.size === 0) {
      const nextReserved = new Map<string, number>();
      for (const other of this.agents) {
        if (other.status !== "queueing") continue;
        const queuedEdgeId = other.route.edgeIds[other.edgeIndex];
        if (queuedEdgeId) nextReserved.set(queuedEdgeId, (nextReserved.get(queuedEdgeId) ?? 0) + 1);
      }
      this.graph.edges.forEach((edge) => {
        if (nextReserved.has(edge.id)) return;
        const queue = this.edgeQueues.get(edge.id);
        nextReserved.set(edge.id, queue ? Math.max(0, (queue.nextEntryTime - this.time) * edge.capacityPerSecond) : 0);
      });
      this.planningReservedCache = nextReserved;
      this.planningReservedAt = this.time;
    }
    const planningReserved = this.planningReservedCache;
    // New path searches are expensive; safe cached paths remain unlimited. Large scenarios plan
    // one new cohort per frame while system tests can plan three.
    this.reroutePlanningBudget = this.agents.length >= 1500 ? 1 : 3;
    this.detourPlanningBudget = this.agents.length >= 1500 ? 2 : 8;
    const edgeHazardCache = new Map<string, ReturnType<typeof edgeRiskSnapshot>>();
    const edgeHazard = (edgeId: string, offset: number, perceivedFires: FireSource[]) => {
      const bucket = Math.round(offset * 10);
      // Believed positions differ between people. Including a coarse location in the key avoids
      // reusing another person's hazard estimate while retaining useful cache sharing.
      const knowledge = fireKnowledgeSignature(perceivedFires);
      const key = `${edgeId}:${bucket}:${knowledge}`;
      const cached = edgeHazardCache.get(key);
      if (cached) return cached;
      const risk = edgeRiskSnapshot(this.graph, edgeId, perceivedFires, this.time + offset, this.nodeMap, this.edgeMap);
      edgeHazardCache.set(key, risk);
      return risk;
    };

    // Crowd spacing does not need to be rebuilt at every 50x micro-substep. A 0.11 s simulated
    // snapshot is still much faster than human reaction time while roughly halving sorting work.
    if (this.time - this.crowdSnapshotAt >= 0.11 || this.activeEdgeCountsCache.size === 0) {
      const activeEdgeCounts = new Map<string, number>();
      const directedEdgeAgents = new Map<string, RuntimeAgent[]>();
      for (const occupant of this.agents) {
        if (!occupant.edgeEntered || occupant.status === "arrived" || occupant.status === "blocked" || occupant.retreating) continue;
        const edgeId = occupant.route.edgeIds[occupant.edgeIndex];
        if (!edgeId) continue;
        activeEdgeCounts.set(edgeId, (activeEdgeCounts.get(edgeId) ?? 0) + 1);
        const occupiedEdge = edgeMap.get(edgeId);
        const lane = occupiedEdge ? walkingLanePlan(occupant, occupiedEdge, this.config.crowdBehavior) : { index: 0 };
        const directionKey = `${edgeId}:${occupant.route.nodeIds[occupant.edgeIndex]}>${occupant.route.nodeIds[occupant.edgeIndex + 1]}:lane-${lane.index}`;
        const stream = directedEdgeAgents.get(directionKey) ?? [];
        stream.push(occupant);
        directedEdgeAgents.set(directionKey, stream);
      }
      const forwardGapByAgent = new Map<number, number>();
      directedEdgeAgents.forEach((lane) => {
        lane.sort((a, b) => (b.segmentIndex + b.segmentProgress) - (a.segmentIndex + a.segmentProgress));
        for (let index = 1; index < lane.length; index += 1) {
          forwardGapByAgent.set(lane[index].id, distance3(lane[index].position, lane[index - 1].position));
        }
      });
      this.activeEdgeCountsCache = activeEdgeCounts;
      this.forwardGapByAgentCache = forwardGapByAgent;
      this.crowdSnapshotAt = this.time;
    }
    const activeEdgeCounts = this.activeEdgeCountsCache;
    const forwardGapByAgent = this.forwardGapByAgentCache;
    const queueRanks = new Map<string, number>();

    for (const agent of this.agents) {
      if (agent.status === "arrived" || agent.status === "incapacitated") continue;
      // The local hard-safety check is cheap after floor indexing and runs every movement step.
      // Only the richer perception/report/physiology update is cohort-throttled below.
      let currentRisk = pointRisk(agent.position, trueFiresAt(agent.position), this.time, PEDESTRIAN_RADIUS);
      let perceivedFires = agent.cachedPerceivedFires;
      const hazardCohortReady = (agent.id * 5 + Math.floor(this.time * 30)) % 9 === 0;
      const hazardElapsed = this.time - agent.lastHazardUpdateAt;
      let emergencyMoved = false;
      // If a growing fire front reaches the exact point where someone is standing, attempt one
      // short physical escape step before accumulating direct-flame injury. This is especially
      // important at queues near field gates, where waiting agents can otherwise be engulfed by a
      // fire that expanded after they stopped. The move stays on the current verified edge.
      const nearbyFlames = trueFiresAt(agent.position);
      const waitingNearFire = agent.status === "queueing" || agent.status === "blocked" || agent.status === "waiting";
      const imminentContact = nearbyFlames.length > 0
        && flameClearanceAt(agent.position, nearbyFlames, this.time + 1.0) < (waitingNearFire ? .42 : 0);
      if (imminentContact) {
        agent.stress = Math.max(agent.stress, .85);
        agent.responseDelay = Math.min(agent.responseDelay, this.time);
        nearbyFlames.forEach((fire) => this.rememberFire(agent, fire, "direct"));
      }
      if (currentRisk.blocked || imminentContact) {
        const activeEdge = edgeMap.get(agent.route.edgeIds[agent.edgeIndex]);
        const incomingEdge = agent.edgeIndex > 0 ? edgeMap.get(agent.route.edgeIds[agent.edgeIndex - 1]) : undefined;
        const contexts: { edge: SimEdge; path: Vec3[] }[] = [];
        if (agent.edgeEntered && activeEdge && agent.edgePath.length >= 2) contexts.push({ edge: activeEdge, path: agent.edgePath });
        else {
          if (incomingEdge) contexts.push({ edge: incomingEdge, path: traversalPoints(incomingEdge, nodeMap, agent.route.nodeIds[agent.edgeIndex - 1], agent.route.nodeIds[agent.edgeIndex]) });
          if (activeEdge) contexts.push({ edge: activeEdge, path: dedupePoints([agent.position, ...traversalPoints(activeEdge, nodeMap, agent.route.nodeIds[agent.edgeIndex], agent.route.nodeIds[agent.edgeIndex + 1])]) });
        }
        let escape: Vec3 | null = null, bestClearance = -Infinity;
        for (const context of contexts) {
          if (context.path.length < 2) continue;
          const projection = closestPointOnPolyline(agent.position, context.path);
          const state = segmentStateAtDistance(context.path, projection.distanceAlong);
          const candidate = findEmergencyEscapeStep(agent.position, context.path, context.edge, state.segmentIndex, state.progress,
            nearbyFlames, this.time, agent.speed * context.edge.speedMultiplier * dt);
          if (candidate) {
            const clearance = flameClearanceAt(candidate, nearbyFlames, this.time + .2);
            if (clearance > bestClearance) { escape = candidate; bestClearance = clearance; }
          }
        }
        if (escape) {
          agent.position = escape;
          emergencyMoved = true;
          this.pendingDetourAgents.delete(agent.id);
          agent.lateralRecoveryUntil = this.time + 1;
          agent.status = "rerouting";
          agent.decisionState = "avoiding-hazard";
          if (agent.edgeEntered) {
            const projection = closestPointOnPolyline(agent.position, agent.edgePath);
            const state = segmentStateAtDistance(agent.edgePath, projection.distanceAlong);
            agent.segmentIndex = state.segmentIndex; agent.segmentProgress = state.progress;
          }
          currentRisk = pointRisk(agent.position, trueFiresAt(agent.position), this.time, PEDESTRIAN_RADIUS);
        }
      }

      // Physical contact uses every simulation substep, independently of throttled perception.
      // A safe frame breaks continuous contact: old smoke/heat dose and old fire contacts cannot
      // cause a delayed collapse after the pedestrian is clear of the flame.
      agent.flameContactSeconds = currentRisk.blocked ? agent.flameContactSeconds + dt : 0;
      agent.health = Math.max(0, 1 - agent.flameContactSeconds / DIRECT_FLAME_INCAPACITATION_SECONDS);
      if (currentRisk.blocked) {
        agent.stress = Math.max(agent.stress, 0.94);
        agent.decisionState = "avoiding-hazard";
        if (agent.flameContactSeconds >= DIRECT_FLAME_INCAPACITATION_SECONDS) {
          this.incapacitateAgent(agent, "การสัมผัสเปลวไฟโดยตรง");
          continue;
        }
      }

      const immediateLocalSignal = currentRisk.blocked
        || currentRisk.fire > 0.015
        || currentRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 0.8
        || currentRisk.smoke * agent.smokeSensitivity > agent.smokeDetectionThreshold * 0.8;
      const updateHazardSenses = (hazardCohortReady || immediateLocalSignal) && (agent.lastHazardUpdateAt < 0 || hazardElapsed >= 0.1);
      if (updateHazardSenses) {
        perceivedFires = this.updateFireAwareness(agent, currentRisk);
        agent.cachedTrueRisk = currentRisk;
        agent.cachedPerceivedFires = perceivedFires;
        const hazardDt = agent.lastHazardUpdateAt < 0 ? dt : Math.min(0.8, Math.max(dt, hazardElapsed));
        agent.lastHazardUpdateAt = this.time;
        agent.smokeExposure ||= currentRisk.smoke > 0.2;
        agent.heatExposure ||= currentRisk.heat * agent.heatSensitivity > 0.16;
        // Crouching below the densest smoke is a limited protective response. It is slower,
        // disabled on stairs, and reduces rather than eliminates inhalation.
        agent.protectivePosture = agent.phase !== "stair" && agent.perceivedSmoke > 0.27 && agent.visibility < 0.74 && agent.perceivedHeat < 0.26;
        const postureInhalationFactor = agent.protectivePosture ? 0.78 : 1;
        agent.smokeDose += Math.pow(Math.max(0, currentRisk.smoke), 1.55) * hazardDt * postureInhalationFactor;
        const effectiveRadiantHeat = Math.max(0, currentRisk.heat * agent.heatSensitivity - 0.06);
        agent.heatDose += Math.pow(effectiveRadiantHeat, 1.65) * hazardDt * 0.22;
        const hazardStress = Math.min(1, currentRisk.fire * 1.1 + currentRisk.heat * agent.heatSensitivity * 1.18 + currentRisk.smoke * agent.smokeSensitivity * 0.82);
        const awarenessStress = Math.min(0.24, perceivedFires.length * 0.065);
        const targetStress = Math.min(1, hazardStress + awarenessStress);
        const stressResponse = targetStress > agent.stress ? 1.25 : 0.16;
        agent.stress += (targetStress - agent.stress) * Math.min(1, hazardDt * stressResponse);
      }
      // The escape already consumed this substep's walking distance.
      if (emergencyMoved) continue;
      // A safe-stop is no longer terminal. If an alternate route becomes available, retry it
      // periodically instead of leaving the person permanently stuck. This keeps the physical
      // no-teleport rule while allowing changing fire fronts / queue loads to free the agent.
      if (agent.status === "blocked") {
        if (this.time - agent.lastRerouteAt >= 0.45) {
          const recoveryNodeId = agent.currentNodeId || agent.route.nodeIds[Math.min(agent.edgeIndex, agent.route.nodeIds.length - 1)];
          const recoveryFires = this.knownFireSources(agent).length ? this.knownFireSources(agent) : this.fires;
          const recovered = recoveryNodeId
            ? this.rerouteAgent(agent, recoveryNodeId, recoveryFires, planningReserved, edgeMap)
            : false;
          if (recovered === true || recovered === null) {
            agent.status = "rerouting";
            agent.decisionState = "avoiding-hazard";
          } else {
            agent.lastRerouteAt = this.time;
          }
        }
        if (agent.status === "blocked") continue;
      }
      if (currentRisk.blocked && !agent.retreating) {
        // No teleport-to-nearest-node fallback: if already on an edge, retreat along the exact
        // path walked. If still standing on a graph node (for example a fire is placed under a
        // waiting student), start the best available outgoing route immediately so the next
        // bounded emergency steps can physically walk the person out of the flame envelope.
        if (agent.edgeEntered) {
          this.beginRetreat(agent, nodeMap);
          continue;
        } else {
          const recoveryNodeId = agent.currentNodeId || agent.route.nodeIds[Math.min(agent.edgeIndex, agent.route.nodeIds.length - 1)];
          if (recoveryNodeId) this.rerouteAgent(agent, recoveryNodeId, this.fires, planningReserved, edgeMap);
          agent.status = "evacuating";
          agent.decisionState = "avoiding-hazard";
          agent.responseDelay = Math.min(agent.responseDelay, this.time);
          // Deliberately continue into normal edge preparation below instead of safe-stopping.
        }
      }
      if (this.time < agent.responseDelay) {
        agent.status = "waiting";
        agent.decisionState = perceivedFires.length ? "assessing" : "waiting";
        continue;
      }
      if (agent.edgeIndex >= agent.route.edgeIds.length) {
        this.markArrived(agent);
        continue;
      }

      let edge = this.getEdge(agent, edgeMap);
      if (!edge) {
        const recoveryNodeId = agent.currentNodeId || agent.route.nodeIds[Math.min(agent.edgeIndex, agent.route.nodeIds.length - 1)];
        if (agent.hasExitedBuilding && recoveryNodeId) {
          const recovered = this.rerouteAgent(agent, recoveryNodeId, this.fires, planningReserved, edgeMap);
          agent.status = recovered === false ? "rerouting" : "rerouting";
          agent.decisionState = "avoiding-hazard";
          continue;
        }
        agent.status = "blocked";
        continue;
      }

      if (!agent.edgeEntered) {
        const currentNodeId = agent.route.nodeIds[agent.edgeIndex];
        const currentNode = nodeMap.get(currentNodeId);
        if (currentNode) this.updateContextFromNode(agent, currentNode);

        // Hard topology invariant: nobody may go outdoors before reaching floor 1.
        if ((edge.kind === "outdoor" || edge.kind === "assembly") && agent.floor > 1) {
          agent.status = "blocked";
          this.pushEvent("danger", "Topology guard", `ป้องกัน Agent #${agent.id} ออกจากอาคารก่อนถึงชั้น 1`);
          continue;
        }

        const humanDecisionInterval = this.config.rerouteInterval + agent.decisionLatency * (1 - agent.stress * 0.55);
        // Warning announcements can reach hundreds of students together. Humans do not all solve
        // a route on the same millisecond, so distribute non-urgent replanning across deterministic
        // cohorts. Direct local danger always bypasses the cohort gate.
        const decisionCohortReady = (agent.id * 17 + Math.floor(this.time * 10)) % 90 === 0;
        const urgentLocalDanger = currentRisk.blocked
          || currentRisk.fire > 0.035
          || currentRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 2.8
          || currentRisk.smoke * agent.smokeSensitivity > 0.2;
        const shouldCheck = this.time - agent.lastRerouteAt >= humanDecisionInterval && (urgentLocalDanger || decisionCohortReady);
        const queue = this.edgeQueues.get(edge.id);
        const queueSeconds = Math.max(0, (queue?.nextEntryTime ?? this.time) - this.time);
        // Look ahead across several future edges, not only the next step. This lets a person choose
        // another stair while still on the corridor instead of discovering the fire too late on a landing.
        const lookAheadCount = Math.max(4, Math.min(20, Math.round(this.config.thermalLookAheadEdges ?? 10)));
        const lookAheadIds = agent.route.edgeIds.slice(agent.edgeIndex, agent.edgeIndex + lookAheadCount);
        const routeForecast = perceivedFires.length
          ? this.forecastRouteHazard(agent, lookAheadIds, perceivedFires, edgeMap)
          : { eta: 0, fire: 0, smoke: 0, heat: 0, blocked: false, thermalBlocked: false, maxModeledTemperatureC: this.config.ambientTemperatureC ?? 29, danger: 0 };
        const fireAhead = routeForecast.blocked || routeForecast.fire > 0.055 * (1.15 - agent.riskAversion * 0.38);
        const smokeAhead = routeForecast.smoke * agent.smokeSensitivity > 0.125 * (1.2 - agent.riskAversion * 0.48);
        const heatAhead = routeForecast.thermalBlocked
          || routeForecast.maxModeledTemperatureC >= (this.config.heatAvoidThresholdC ?? 44)
          || routeForecast.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 2.55 * (1.15 - agent.riskAversion * 0.46);
        const localSmokeDanger = agent.perceivedSmoke > Math.max(0.12, agent.smokeDetectionThreshold * 3.4) * (1.18 - agent.riskAversion * 0.38);
        const localHeatDanger = agent.perceivedHeat > agent.heatDetectionThreshold * 3.8 * (1.18 - agent.riskAversion * 0.36);
        const queueThreshold = agent.queueToleranceSeconds * (1 - agent.stress * 0.28);
        const survivalConcern = routeForecast.danger > 0.19 * (1.22 - agent.riskAversion * 0.44);
        // At real decision points, periodically compare all viable exits even when the current
        // route is not yet dangerous. This is what makes the agent choose the earliest safe
        // arrival as queues evolve, without running an expensive full search on every frame.
        const proactiveSafeOptimization = Boolean(
          currentNode
          && perceivedFires.length > 0
          && currentNode.type === "junction",
        );
        const localDetourEdge = edgeSupportsLocalBypass(edge);
        const hazardWantsReroute = fireAhead || smokeAhead || heatAhead || localSmokeDanger || localHeatDanger || survivalConcern;
        // Wide outdoor/assembly/corridor edges are continuous walkable areas. A point fire in the
        // middle must not make the agent solve a graph reroute back toward the building before it
        // has attempted to walk around the source inside the same physical edge.
        const openDecisionNodeCanSwitchLane = localDetourEdge && (currentNode?.type === "exit" || currentNode?.type === "gate");
        const globalHazardReroute = hazardWantsReroute && (!localDetourEdge || openDecisionNodeCanSwitchLane);
        if (shouldCheck && (globalHazardReroute || queueSeconds > queueThreshold || proactiveSafeOptimization)) {
          agent.decisionState = hazardWantsReroute ? "avoiding-hazard" : "assessing";
          const rerouted = this.rerouteAgent(agent, currentNodeId, perceivedFires, planningReserved, edgeMap);
          if (rerouted === true) {
            if (heatAhead || localHeatDanger || routeForecast.thermalBlocked) this.thermalRerouteCount += 1;
            edge = this.getEdge(agent, edgeMap);
            if (!edge) { agent.status = "blocked"; continue; }
          }
        }

        const entryHazard = edgeHazard(edge.id, 2.5, perceivedFires);
        const entryThermalBlocked = modeledTemperatureFromHeat(entryHazard.heat, this.config.ambientTemperatureC ?? 29) >= (this.config.hardBlockTemperatureC ?? 62);
        if (entryHazard.blocked || entryThermalBlocked) {
          // On a wide edge, enter the edge and let the local steering layer sample the free side.
          // Thermal blocking at the centerline alone is not proof that the entire 5–8 m path is unsafe.
          const canTryBypass = edgeSupportsLocalBypass(edge);
          if (!canTryBypass) {
            agent.status = "rerouting";
            const rerouteResult = this.rerouteAgent(agent, currentNodeId, perceivedFires, planningReserved, edgeMap);
            if (rerouteResult === true && entryThermalBlocked) this.thermalRerouteCount += 1;
            if (rerouteResult === false) {
              agent.status = "rerouting";
              agent.decisionState = "safe-stop";
            }
            continue;
          }
        }

        const queueState = this.edgeQueues.get(edge.id) ?? { nextEntryTime: 0, entries: 0 };
        if (this.time + 1e-4 < queueState.nextEntryTime) {
          agent.status = "queueing";
          agent.decisionState = agent.groupCohesion > 0.6 ? "following-group" : "assessing";
          const incomingEdge = agent.edgeIndex > 0 ? edgeMap.get(agent.route.edgeIds[agent.edgeIndex - 1]) : undefined;
          const previousNodeId = agent.edgeIndex > 0 ? agent.route.nodeIds[agent.edgeIndex - 1] : undefined;
          if (incomingEdge && previousNodeId && currentNode) {
            const incomingPath = traversalPoints(incomingEdge, nodeMap, previousNodeId, currentNodeId);
            if (incomingPath.length >= 2) {
              const lane = walkingLanePlan(agent, incomingEdge, this.config.crowdBehavior);
              const rankKey = `${edge.id}:${incomingEdge.id}:lane-${lane.index}`;
              const row = queueRanks.get(rankKey) ?? 0;
              queueRanks.set(rankKey, row + 1);
              const baseSpacing = this.config.crowdBehavior === "surge" ? 0.52 : this.config.crowdBehavior === "grouped" ? 0.64 : 0.74;
              const personalSpacing = baseSpacing + (hash01(agent.id * 83 + stableEdgeSeed(edge.id) * 0.00029) - 0.5) * 0.16;
              const longitudinalJitter = (hash01(agent.id * 109 + row * 13 + stableEdgeSeed(edge.id) * 0.00041) - 0.5) * 0.18;
              const queueSideDrift = (hash01(agent.id * 127 + row * 19 + stableEdgeSeed(incomingEdge.id) * 0.00017) - 0.5) * Math.min(0.16, Math.max(0.04, incomingEdge.width * 0.08));
              const longitudinal = 0.42 + row * personalSpacing + longitudinalJitter;
              const candidate = pointBehindPathEnd(incomingPath, longitudinal, lane.offset + queueSideDrift);
              if (candidate && pointInsideWalkableCorridor(candidate, incomingPath, incomingEdge)) {
                const queueStep = lerp3(agent.position, candidate, Math.min(1, dt * 4.5));
                if (!segmentTouchesFlame(agent.position, queueStep, this.fires, this.time + 0.35)
                  && segmentInsideWalkway(agent.position, queueStep, incomingPath, incomingEdge)) agent.position = queueStep;
              }
            }
          }
          continue;
        }
        const admissionBurst = this.config.crowdBehavior === "surge" ? 2.6 : this.config.crowdBehavior === "grouped" ? 1.55 : 1;
        queueState.nextEntryTime = Math.max(this.time, queueState.nextEntryTime) + 1 / Math.max(0.1, edge.capacityPerSecond * admissionBurst);
        queueState.entries += 1;
        this.edgeQueues.set(edge.id, queueState);
        if (!this.prepareEdge(agent, edge, nodeMap)) {
          if (agent.hasExitedBuilding || edge.kind === "outdoor" || edge.kind === "assembly") {
            agent.status = "rerouting";
            agent.decisionState = "safe-stop";
            agent.lastRerouteAt = Math.min(agent.lastRerouteAt, this.time - 0.5);
          } else {
            agent.status = "blocked";
          }
          continue;
        }
      }

      // Traverse the current edge polyline segment-by-segment. This is the key fix that keeps
      // agents on room/corridor/stair geometry instead of interpolating directly through walls.
      if (agent.edgePath.length < 2 || agent.segmentIndex >= agent.edgePath.length - 1) {
        if (agent.retreating) {
          agent.edgeEntered = false;
          agent.retreating = false;
          const currentNodeId = agent.route.nodeIds[agent.edgeIndex];
          const rerouteResult = this.rerouteAgent(agent, currentNodeId, undefined, planningReserved, edgeMap);
          if (rerouteResult === false || rerouteResult === null) {
            agent.status = "rerouting";
            agent.decisionState = "safe-stop";
            agent.lastRerouteAt = Math.min(agent.lastRerouteAt, this.time - 0.5);
          }
          continue;
        }
        const nextNodeId = agent.route.nodeIds[agent.edgeIndex + 1];
        const nextNode = nodeMap.get(nextNodeId);
        if (edge.kind === "room" && nextNode?.type === "door") {
          agent.hasPassedRoomDoor = true;
        }
        if (edge.kind === "exit" && !edge.insideBuilding && nextNode?.type === "exit") {
          agent.hasExitedBuilding = true;
        }
        agent.edgeIndex += 1;
        agent.edgeEntered = false;
        agent.edgePath = [];
        agent.segmentIndex = 0;
        agent.segmentProgress = 0;
        this.updateContextFromNode(agent, nextNode);
        if (agent.edgeIndex >= agent.route.edgeIds.length) this.markArrived(agent);
        continue;
      }

      const from = agent.edgePath[agent.segmentIndex];
      const to = agent.edgePath[agent.segmentIndex + 1];
      const actualDistance = Math.max(0.01, distance3(from, to));
      const activeOnEdge = activeEdgeCounts.get(edge.id) ?? 1;
      const edgeArea = Math.max(1.2, edge.width * Math.max(1.5, edge.distance));
      const density = activeOnEdge / edgeArea;
      this.peakEdgeDensity = Math.max(this.peakEdgeDensity, density);
      // Smooth fundamental-diagram style speed reduction. Stairs already have a lower multiplier.
      const densitySpeedFactor = Math.max(0.30, 1 - Math.pow(Math.min(1.8, density / 1.85), 1.35) * 0.72);
      const smokeSlowdown = Math.max(0.48, 1 - currentRisk.smoke * agent.smokeSensitivity * 0.46);
      const visibilitySlowdown = 0.72 + agent.visibility * 0.28;
      const postureSlowdown = agent.protectivePosture ? 0.82 : 1;
      const alertnessBoost = 1 + Math.min(0.12, agent.stress * 0.16);
      const panicCoordination = Math.max(0.72, 1 - Math.max(0, agent.stress - 0.78) * 0.8);
      const forwardGap = forwardGapByAgent.get(agent.id);
      const spacingBase = this.config.crowdBehavior === "surge" ? 0.48 : this.config.crowdBehavior === "grouped" ? 0.58 : 0.68;
      const preferredSpacing = spacingBase + hash01(agent.id * 89 + stableEdgeSeed(edge.id) * 0.00031) * (this.config.crowdBehavior === "surge" ? 0.16 : 0.22);
      const stopDistance = Math.max(0.38, preferredSpacing * 0.58);
      const openPassingEdge = edge.kind === "outdoor" || edge.kind === "assembly";
      const spacingFactor = forwardGap == null
        ? 1
        : forwardGap <= stopDistance
          ? (openPassingEdge ? 0.2 : 0)
          : Math.max(openPassingEdge ? 0.2 : 0, Math.min(1, (forwardGap - stopDistance) / Math.max(0.12, preferredSpacing - stopDistance)));
      const unconstrainedSpeed = agent.speed * edge.speedMultiplier * densitySpeedFactor * smokeSlowdown * visibilitySlowdown * postureSlowdown * alertnessBoost * panicCoordination * spacingFactor;
      const speed = spacingFactor <= 0.001 ? 0 : Math.max(0.04, unconstrainedSpeed);
      if (!agent.retreating && this.advanceDetour(agent, edge, speed, dt)) continue;
      let nextProgress = Math.min(1, agent.segmentProgress + (speed * dt) / actualDistance);
      const centerlinePosition = lerp3(from, to, nextProgress);
      let nextPosition = [...centerlinePosition] as Vec3;
      let lateralTravelAllowance = 0;
      const allowsLateralFlow = edge.kind === "corridor" || edge.kind === "junction" || edge.kind === "stair" || edge.kind === "outdoor";
      const touchesDoorPortal = edge.id.includes("door");
      if (allowsLateralFlow && !touchesDoorPortal && !agent.retreating) {
        const lane = walkingLanePlan(agent, edge, this.config.crowdBehavior);
        const edgeProgress = (agent.segmentIndex + nextProgress) / Math.max(1, agent.edgePath.length - 1);
        const mergeEnvelope = Math.min(1, edgeProgress * 7, (1 - edgeProgress) * 7);
        const phase = hash01(agent.id * 97 + stableEdgeSeed(edge.id) * 0.00037) * Math.PI * 2;
        const humanMeander = 0.9 + Math.sin(edgeProgress * Math.PI * 3.2 + phase) * 0.1;
        const driftAmplitude = edge.kind === "stair" ? 0.05 : edge.kind === "corridor" || edge.kind === "junction" ? 0.10 : 0.14;
        const timeDrift = Math.sin(this.time * (0.34 + hash01(agent.id * 149) * 0.22) + phase * 1.7) * driftAmplitude * mergeEnvelope;
        const progressDrift = Math.sin(edgeProgress * Math.PI * (2.2 + hash01(agent.id * 157 + stableEdgeSeed(edge.id) * 0.00011)) + phase * 0.7) * driftAmplitude * 0.55;
        const desiredOffset = (lane.offset * humanMeander + timeDrift + progressDrift) * mergeEnvelope;
        const normal = horizontalPathNormal(agent.edgePath, agent.segmentIndex, nextProgress);
        let lateralOffset = desiredOffset;
        if (edge.kind === "outdoor" || (edgeSupportsLocalBypass(edge)
          && (agent.lateralRecoveryUntil ?? 0) > this.time)) {
          const currentBase = lerp3(from, to, agent.segmentProgress);
          const currentNormal = horizontalPathNormal(agent.edgePath, agent.segmentIndex, agent.segmentProgress);
          const currentOffset = (agent.position[0] - currentBase[0]) * currentNormal[0] + (agent.position[2] - currentBase[2]) * currentNormal[1];
          // Merge back gradually after a hazard sidestep.
          // Snapping straight to the crowd's preferred lane would create a sideways jump.
          const maxLateralShift = Math.max(0.08, Math.min(0.32, speed * dt * 0.72 + 0.06));
          const lateralDelta = Math.max(-maxLateralShift, Math.min(maxLateralShift, desiredOffset - currentOffset));
          lateralOffset = currentOffset + lateralDelta;
          lateralTravelAllowance = Math.abs(lateralDelta);
        } else {
          lateralTravelAllowance = Math.abs(nextProgress - agent.segmentProgress) * Math.abs(lateralOffset) * Math.PI * 2.2;
        }
        nextPosition[0] += normal[0] * lateralOffset;
        nextPosition[2] += normal[1] * lateralOffset;
        // A loose stream must never turn into a wall collision. Near tower corners the full
        // lateral preference can leave the verified outdoor envelope even though the centerline
        // itself is valid. Reduce the offset locally instead of triggering retreat/reroute loops.
        if (!pointInsideWalkableCorridor(nextPosition, agent.edgePath, edge)) {
          const halfOffset = lerp3(centerlinePosition, nextPosition, 0.5);
          if (pointInsideWalkableCorridor(halfOffset, agent.edgePath, edge)) {
            nextPosition = halfOffset;
            lateralTravelAllowance *= 0.5;
          } else {
            nextPosition = [...centerlinePosition] as Vec3;
            lateralTravelAllowance = 0;
          }
        }
      }

      // A desired crowd lane may change after a sidestep or at a polyline corner. Spend the
      // actual walking-distance budget on that transition instead of snapping sideways to it.
      const desiredStep = distance3(agent.position, nextPosition);
      const walkingBudget = speed * dt;
      if (desiredStep > walkingBudget + 0.000001) {
        nextPosition = lerp3(agent.position, nextPosition, walkingBudget / desiredStep);
        const direction: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const lengthSquared = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
        const projectedProgress = ((nextPosition[0] - from[0]) * direction[0]
          + (nextPosition[1] - from[1]) * direction[1] + (nextPosition[2] - from[2]) * direction[2]) / Math.max(0.000001, lengthSquared);
        nextProgress = Math.min(1, Math.max(agent.segmentProgress, projectedProgress));
      }

      // Predict a few seconds ahead. If the next movement would cross active fire, stop and
      // retreat to the graph node rather than ever interpolating through the hazard.
      if (!agent.retreating) {
        const nextRisk = pointRisk(nextPosition, trueFiresAt(nextPosition), this.time + 2.0);
        const perceivedNextRisk = pointRisk(nextPosition, perceivedFires, this.time + Math.max(2.4, agent.decisionLatency + 1.4));
        const edgeRisk = edgeHazard(edge.id, 2.0, perceivedFires);
        const currentHeatSignal = currentRisk.heat * agent.heatSensitivity;
        const perceivedNextTemperatureC = modeledTemperatureFromHeat(perceivedNextRisk.heat, this.config.ambientTemperatureC ?? 29);
        const edgeTemperatureC = modeledTemperatureFromHeat(edgeRisk.heat, this.config.ambientTemperatureC ?? 29);
        const openDetourEdge = edgeSupportsLocalBypass(edge);
        const escapingHazard = openDetourEdge
          && nextRisk.fire <= currentRisk.fire + 0.004
          && perceivedNextRisk.heat <= Math.max(currentRisk.heat + 0.012, agent.perceivedHeat + 0.012)
          && perceivedNextRisk.smoke <= Math.max(currentRisk.smoke + 0.025, agent.perceivedSmoke + 0.025);
        // On open outdoor/assembly links, a person already beside a fire must be allowed to keep
        // moving *away* from it. An absolute temperature threshold previously caused a safe person
        // on the field side of the flame to freeze at the gate forever even though every next step
        // reduced exposure.
        const thermalRetreat = (!escapingHazard && perceivedNextTemperatureC >= (this.config.hardBlockTemperatureC ?? 62)) || (
          !escapingHazard
          && perceivedNextRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 3.7
          && perceivedNextRisk.heat * agent.heatSensitivity > currentHeatSignal + 0.035
        ) || (!openDetourEdge && (
          edgeTemperatureC >= (this.config.hardBlockTemperatureC ?? 62) || (
            edgeRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 4.2
            && agent.segmentProgress < 0.72
          )
        ));
        const smokeRetreat = !escapingHazard
          && perceivedNextRisk.smoke * agent.smokeSensitivity > 0.19 * (1.18 - agent.riskAversion * 0.42)
          && perceivedNextRisk.smoke * agent.smokeSensitivity > agent.perceivedSmoke + 0.045
          && agent.segmentProgress < 0.82;
        const edgeWideBlock = !openDetourEdge && edgeRisk.blocked && agent.segmentProgress < 0.92;
        const nearFlameRetreat = nextRisk.fire > 0.11 && nextRisk.fire > currentRisk.fire + 0.018;
        const sweptFlame = segmentTouchesFlame(agent.position, nextPosition, this.fires, this.time + 0.65, PEDESTRIAN_RADIUS + 0.08);
        if (sweptFlame || nextRisk.blocked || nearFlameRetreat || thermalRetreat || smokeRetreat || edgeWideBlock) {
          if (edgeSupportsLocalBypass(edge) && this.time - agent.lastDetourPlanAt >= 0.45) {
            // Retain FIFO order while large crowds wait for local searches. Pending people hold
            // their last safe point; a failed search cannot monopolize every following frame.
            this.pendingDetourAgents.add(agent.id);
            if (this.detourPlanningBudget <= 0 || this.pendingDetourAgents.values().next().value !== agent.id) {
              agent.status = "rerouting";
              agent.decisionState = "avoiding-hazard";
              continue;
            }
            this.pendingDetourAgents.delete(agent.id);
            this.detourPlanningBudget -= 1;
            agent.lastDetourPlanAt = this.time;
            const clearance = PEDESTRIAN_RADIUS + 0.08;
            const followingEdge = edgeMap.get(agent.route.edgeIds[agent.edgeIndex + 1]);
            const followingPath = followingEdge ? traversalPoints(followingEdge, nodeMap,
              agent.route.nodeIds[agent.edgeIndex + 1], agent.route.nodeIds[agent.edgeIndex + 2]) : [];
            const detour = planFireDetour(agent.edgePath, edge, {
              start: agent.position,
              allowGoalLanes: ["corridor", "junction", "gate"].includes(nodeMap.get(agent.route.nodeIds[agent.edgeIndex + 1])?.type ?? ""),
              goalAllowed: (point) => !followingEdge || pointInsideWalkableCorridor(point, followingPath, followingEdge),
              riskAt: (point) => pointRisk(point, this.fires, this.time + 0.65, clearance),
              segmentBlocked: (from, to) => segmentTouchesFlame(from, to, this.fires, this.time + 0.65, clearance),
            });
            if (detour) {
              agent.detourPath = detour;
              agent.detourIndex = 1;
              if (this.advanceDetour(agent, edge, speed, dt)) continue;
            }
          }
          agent.decisionState = "avoiding-hazard";
          if (edge.kind === "outdoor" || edge.kind === "assembly") {
            // Once a pedestrian has crossed a field gate, planning from the exact graph-node
            // center can be misleading when the fire itself sits on that center. Select a safe
            // assembly zone directly from the person's real position before falling back to the
            // graph-level gate switch.
            const currentNodeId = agent.route.nodeIds[agent.edgeIndex];
            const fieldSwitched = edge.kind === "assembly"
              ? this.switchAssemblyGoalFromCurrentPosition(agent, currentNodeId, perceivedFires.length ? perceivedFires : this.fires)
              : false;
            if (fieldSwitched) {
              if (thermalRetreat) this.thermalRerouteCount += 1;
              continue;
            }
            // A broad outdoor approach has parallel gate lanes. If local steering cannot find a
            // safe cross-section, switch to another gate directly from the current outdoor
            // position. `prepareEdge` joins only to a forward exterior-safe waypoint.
            const switched = this.rerouteAgent(agent, currentNodeId, perceivedFires, planningReserved, edgeMap);
            agent.status = "rerouting";
            if (switched === true) {
              if (thermalRetreat) this.thermalRerouteCount += 1;
              continue;
            }
            // No safe alternate exists at this instant: hold the last safe point and retry.
            continue;
          }
          this.beginRetreat(agent, nodeMap);
          continue;
        }
      }

      // Wall/railing collision guard. A movement is accepted only inside the explicit walkable
      // corridor around the current navigation polyline and with physically continuous motion.
      // A lane-change can add roughly 0.3 m of lateral motion even when congestion briefly
      // lowers forward speed. Keep the guard above one plausible 0.35 s walking stride while
      // still rejecting any teleport-sized jump.
      // Switchback stair vertices rotate the lateral lane normal while a student rounds the
      // landing. The resulting diagonal lane transition is real motion inside the stair throat,
      // not a teleport. Keep the strict corridor test, but include one bounded lane-width turn.
      if (!currentRisk.blocked && segmentTouchesFlame(agent.position, nextPosition, this.fires, this.time + 0.05)) {
        agent.status = "rerouting";
        agent.decisionState = "safe-stop";
        continue;
      }
      const stairTurnAllowance = edge.kind === "stair" ? Math.min(0.76, edge.width * 0.34) : 0;
      const openTurnAllowance = edge.kind === "outdoor" || edge.kind === "assembly"
        ? Math.min(1.6, edge.width * 0.24)
        : 0;
      const maxPhysicalStep = Math.max(0.44, speed * dt * 1.35 + lateralTravelAllowance * 1.15 + stairTurnAllowance + openTurnAllowance);
      const insideWalkway = pointInsideWalkableCorridor(nextPosition, agent.edgePath, edge);
      // Check both the explicit walkable envelope and continuous motion, including stairs.
      const continuousStep = movementSegmentIsContinuous(agent.position, nextPosition, maxPhysicalStep);
      if (!insideWalkway || !continuousStep) {
        this.collisionCorrections += 1;
        if (this.collisionCorrectionSamples.length < 8) {
          const diagnostic = `agent=${agent.id} edge=${edge.id} inside=${insideWalkway} continuous=${continuousStep} phase=${agent.phase} segment=${agent.segmentIndex} retreat=${agent.retreating} step=${distance3(agent.position, nextPosition).toFixed(3)} max=${maxPhysicalStep.toFixed(3)} from=${agent.position.join(",")} to=${nextPosition.join(",")}`;
          this.collisionCorrectionSamples.push(diagnostic);
          this.pushEvent("warning", "Movement guard correction", diagnostic);
        }
        agent.status = "rerouting";
        this.beginRetreat(agent, nodeMap);
        continue;
      }

      this.pendingDetourAgents.delete(agent.id);
      agent.segmentProgress = nextProgress;
      agent.position = nextPosition;

      if (edge.kind === "stair") {
        agent.floor = floorFromY(agent.position[1]);
        agent.phase = "stair";
      }

      if (agent.segmentProgress >= 0.999999) {
        // Keep the loose stream offset at intermediate stair/corridor vertices. Snapping every
        // person back to the centre at each step created the artificial single-file pile-up.
        agent.position = nextPosition;
        agent.segmentIndex += 1;
        agent.segmentProgress = 0;
      }
    }

    if (this.agents.length && this.agents.every((agent) => agent.status === "arrived" || agent.status === "incapacitated")) {
      this.running = false;
      this.completed = true;
      const arrived = this.agents.filter((a) => a.status === "arrived").length;
      this.pushEvent(arrived === this.agents.length ? "success" : "warning", "Simulation completed", `ถึงจุดรวมพล ${arrived.toLocaleString("th-TH")}/${this.agents.length.toLocaleString("th-TH")} คน`);
    }
  }

  /**
   * Predicts direct flame overlap plus smoke/heat burden at the assembly point using the
   * time at which this specific student is expected to reach every edge. Smoke and heat
   * influence route preference and behavior; only a blocked flame envelope is lethal.
   */
  private forecastRouteSurvival(
    agent: RuntimeAgent,
    path: RoutePath,
    perceivedFires: FireSource[],
    reserved: Map<string, number>,
    edgeMap: Map<string, SimEdge>,
  ): RouteSurvivalForecast {
    const invalid: RouteSurvivalForecast = {
      path,
      eta: Infinity,
      projectedHealth: 0,
      projectedSmokeDose: Infinity,
      projectedHeatDose: Infinity,
      survivalMargin: -Infinity,
      danger: Infinity,
      blocked: true,
      survivable: false,
    };
    if (!routeIsPhysicallyValid(this.graph, path, this.nodeMap, this.edgeMap)) return invalid;

    let eta = Math.max(0.35, agent.decisionLatency * 0.28);
    let projectedHealth = agent.health;
    let projectedSmokeDose = agent.smokeDose;
    let projectedHeatDose = agent.heatDose;
    let danger = 0;
    let blocked = false;

    for (const edgeId of path.edgeIds) {
      const edge = edgeMap.get(edgeId);
      if (!edge) return invalid;
      const capacity = Math.max(0.1, edge.capacityPerSecond);
      const queuedPeople = Math.max(0, reserved.get(edge.id) ?? 0);
      const liveQueueDelay = Math.max(0, (this.edgeQueues.get(edge.id)?.nextEntryTime ?? this.time) - (this.time + eta));
      const queueDelay = Math.min(18, Math.max(liveQueueDelay, queuedPeople / capacity * 0.72));
      const travelTime = edge.distance / Math.max(0.28, agent.speed * edge.speedMultiplier);
      const sampleTimes = [
        this.time + eta + queueDelay * 0.5,
        this.time + eta + queueDelay + travelTime * 0.5,
        this.time + eta + queueDelay + travelTime,
      ];
      const risks = sampleTimes.map((sampleTime) => edgeRiskSnapshot(this.graph, edge.id, perceivedFires, sampleTime, this.nodeMap, this.edgeMap));
      const risk = {
        fire: Math.max(...risks.map((value) => value.fire)),
        smoke: Math.max(...risks.map((value) => value.smoke)),
        heat: Math.max(...risks.map((value) => value.heat)),
        blocked: risks.some((value) => value.blocked),
      };
      const modeledTemperatureC = modeledTemperatureFromHeat(risk.heat, this.config.ambientTemperatureC ?? 29);
      const thermalBlocked = risks.some((sample) => !sample.detourAvailable
        && modeledTemperatureFromHeat(sample.heat, this.config.ambientTemperatureC ?? 29) >= (this.config.hardBlockTemperatureC ?? 62));
      blocked ||= risk.blocked || thermalBlocked;

      const exposureSeconds = travelTime + queueDelay * 0.72;
      const predictedCrouch = edge.kind !== "stair" && risk.smoke * agent.smokeSensitivity > 0.27 && risk.heat * agent.heatSensitivity < 0.26;
      const inhalationFactor = predictedCrouch ? 0.78 : 1;
      const effectiveHeat = Math.max(0, risk.heat * agent.heatSensitivity - 0.06);
      projectedSmokeDose += Math.pow(Math.max(0, risk.smoke), 1.55) * exposureSeconds * inhalationFactor;
      projectedHeatDose += Math.pow(effectiveHeat, 1.65) * exposureSeconds * 0.22;
      if (risk.blocked) projectedHealth = 0;
      danger = Math.max(
        danger,
        (risk.blocked ? 10 : 0)
          + (thermalBlocked ? 6 : 0)
          + Math.max(0, modeledTemperatureC - (this.config.heatAvoidThresholdC ?? 44)) / 16
          + risk.fire * 2.2
          + risk.heat * agent.heatSensitivity * 1.45
          + risk.smoke * agent.smokeSensitivity,
      );
      eta += queueDelay + travelTime;
      if (blocked) break;
    }

    const healthMargin = projectedHealth;
    // These are route-comparison comfort margins, not incapacitation thresholds.
    const smokeMargin = (24 - projectedSmokeDose) / 24;
    const heatMargin = (5.5 - projectedHeatDose) / 5.5;
    const survivalMargin = Math.min(healthMargin, smokeMargin, heatMargin);
    const survivable = !blocked && danger <= 0.82;
    return {
      path,
      eta,
      projectedHealth,
      projectedSmokeDose,
      projectedHeatDose,
      survivalMargin,
      danger,
      blocked,
      survivable,
    };
  }

  /** Survival is lexicographic: safe paths first, then the earliest arrival. */
  private compareSurvivalForecast(a: RouteSurvivalForecast, b: RouteSurvivalForecast): number {
    if (a.survivable !== b.survivable) return a.survivable ? -1 : 1;
    if (a.survivable && b.survivable) {
      if (Math.abs(a.eta - b.eta) > 0.12) return a.eta - b.eta;
      if (Math.abs(a.danger - b.danger) > 0.005) return a.danger - b.danger;
      return b.survivalMargin - a.survivalMargin;
    }
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    if (Math.abs(a.survivalMargin - b.survivalMargin) > 0.01) return b.survivalMargin - a.survivalMargin;
    if (Math.abs(a.danger - b.danger) > 0.005) return a.danger - b.danger;
    return a.eta - b.eta;
  }

  private switchAssemblyGoalFromCurrentPosition(
    agent: RuntimeAgent,
    currentNodeId: string,
    fires: FireSource[],
  ): boolean {
    if (!agent.hasExitedBuilding) return false;
    const gateNode = this.nodeMap.get(currentNodeId);
    if (gateNode?.type !== "gate") return false;
    const candidates: Array<{ edge: SimEdge; goal: SimNode; slot: Vec3; score: number; risk: number }> = [];
    for (const edge of this.graph.edges) {
      if (edge.from !== currentNodeId || edge.kind !== "assembly") continue;
      const goal = this.nodeMap.get(edge.to);
      if (!goal || goal.type !== "assembly") continue;
      const slot = assemblySlotPosition(goal.position, agent.id % 500, this.config.crowdBehavior);
      const distance = distance3(agent.position, slot);
      const samples = Math.max(8, Math.min(28, Math.ceil(distance / 1.4)));
      let unsafe = false;
      let accumulatedRisk = 0;
      for (let sample = 0; sample <= samples; sample += 1) {
        const t = sample / samples;
        const point = lerp3(agent.position, slot, t);
        if (!pointClearsExteriorBuilding(point)) { unsafe = true; break; }
        const eta = t * distance / Math.max(0.4, agent.speed * edge.speedMultiplier);
        const risk = pointRisk(point, fires, this.time + eta);
        const temperature = modeledTemperatureFromHeat(risk.heat, this.config.ambientTemperatureC ?? 29);
        if (risk.blocked || temperature >= (this.config.hardBlockTemperatureC ?? 62)) { unsafe = true; break; }
        accumulatedRisk += risk.fire * 5.2 + risk.heat * 3.1 + risk.smoke * 0.72;
      }
      if (unsafe) continue;
      const queue = this.edgeQueues.get(edge.id);
      const queueDelay = Math.max(0, (queue?.nextEntryTime ?? this.time) - this.time);
      candidates.push({
        edge,
        goal,
        slot,
        risk: accumulatedRisk / (samples + 1),
        score: distance / Math.max(0.4, agent.speed * edge.speedMultiplier) + queueDelay + accumulatedRisk * 4.8,
      });
    }
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    if (!best) return false;
    agent.assemblySlot = best.slot;
    agent.route = {
      nodeIds: [currentNodeId, best.goal.id],
      edgeIds: [best.edge.id],
      distance: distance3(agent.position, best.slot),
      estimatedTime: best.score,
      risk: best.risk,
      congestion: 0,
      totalCost: best.score,
      bottleneckCapacity: best.edge.capacityPerSecond,
      goalId: best.goal.id,
    };
    agent.edgeIndex = 0;
    agent.edgeEntered = false;
    agent.edgePath = [];
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.retreating = false;
    agent.status = "rerouting";
    agent.decisionState = "avoiding-hazard";
    agent.currentNodeId = currentNodeId;
    agent.lastRerouteAt = this.time;
    this.rerouteCount += 1;
    return true;
  }

  private rerouteAgent(
    agent: RuntimeAgent,
    currentNodeId: string,
    perceivedFires = this.knownFireSources(agent),
    reservedOverride?: Map<string, number>,
    routeEdgeMapOverride?: Map<string, SimEdge>,
  ): boolean | null {
    const forceRecovery = agent.status === "blocked" || agent.decisionState === "safe-stop" || agent.flameContactSeconds > 0.05;
    const goals = this.graph.nodes.filter((node) => node.type === "assembly").map((node) => node.id);
    const routeEdgeMap = routeEdgeMapOverride ?? new Map(this.graph.edges.map((edge) => [edge.id, edge]));
    const reserved = reservedOverride ?? (() => {
      const snapshot = new Map<string, number>();
      this.agents.forEach((other) => {
        if (other.status !== "queueing") return;
        const queuedEdgeId = other.route.edgeIds[other.edgeIndex];
        if (queuedEdgeId) snapshot.set(queuedEdgeId, (snapshot.get(queuedEdgeId) ?? 0) + 1);
      });
      this.graph.edges.forEach((edge) => {
        if (snapshot.has(edge.id)) return;
        const queue = this.edgeQueues.get(edge.id);
        snapshot.set(edge.id, queue ? Math.max(0, (queue.nextEntryTime - this.time) * edge.capacityPerSecond) : 0);
      });
      return snapshot;
    })();
    const riskBand = Math.round(agent.riskAversion * 2) / 2;
    const smokeBand = Math.round(agent.smokeSensitivity * 2) / 2;
    const queueBand = agent.queueToleranceSeconds < 13.5 ? 0 : 1;
    const survivalUrgency = 1 + agent.stress * 0.42 + Math.max(0, 1 - agent.health) * 0.65;
    const personalConfig: SimulationConfig = {
      ...this.config,
      congestionWeight: this.config.congestionWeight * (queueBand === 0 ? 1.18 : 0.82),
      fireWeight: this.config.fireWeight * (0.82 + riskBand * 0.94) * survivalUrgency,
      smokeWeight: this.config.smokeWeight * smokeBand * (0.82 + riskBand * 0.58) * survivalUrgency,
    };
    const leader = this.agents[agent.groupLeaderId];
    const socialGoal = leader && leader.roomId === agent.roomId && leader.status !== "blocked"
      ? leader.route.goalId
      : agent.route.goalId;
    const currentNode = this.nodeMap.get(currentNodeId);
    const sharedOutdoorRecovery = agent.hasExitedBuilding && (currentNode?.type === "exit" || currentNode?.type === "gate");
    const exposureBand = `${Math.floor(agent.health * 5)}:${Math.floor(agent.smokeDose / 3)}:${Math.floor(agent.heatDose / 0.5)}`;
    // Hundreds of people can reach the same field approach at once. Their safe gate choice can
    // share one route cache per assembly goal/fire state instead of solving nearly identical
    // personal profiles serially, which both removes visible stalls and lowers CPU load.
    const profileBand = sharedOutdoorRecovery
      ? `field-shared:${queueBand}`
      : perceivedFires.length
        ? `${riskBand}:${smokeBand}:${queueBand}:${exposureBand}`
        : `clear:${queueBand}`;
    const fireSignature = fireRouteZoneSignature(perceivedFires);
    const forecastHorizon = Math.min(18, 4.5 + Math.max(1, agent.floor) * 1.35 + agent.decisionLatency * 0.8);
    const routeTimeBucket = Math.floor(this.time / 2.5);
    const cacheKey = `${currentNodeId}:${this.config.preset}:${routeTimeBucket}:${fireSignature}:${socialGoal}:${profileBand}:${Math.round(forecastHorizon)}`;
    const cached = this.reroutePathCache.get(cacheKey);
    let nextPath: RoutePath | null;
    const cachedForecast = cached?.path
      ? this.forecastRouteSurvival(agent, cached.path, perceivedFires, reserved, routeEdgeMap)
      : null;
    if (cached && this.time - cached.at < 3 && cachedForecast?.survivable) {
      nextPath = cached.path;
    } else {
      if (this.reroutePlanningBudget <= 0) return null;
      this.reroutePlanningBudget -= 1;
      const safetyConfig: SimulationConfig = {
        ...personalConfig,
        preset: "safest",
        fireWeight: personalConfig.fireWeight * 1.8,
        smokeWeight: personalConfig.smokeWeight * 1.65,
      };
      const planningTime = this.time + Math.min(4, Math.max(1.2, agent.decisionLatency + 0.8));
      const candidateMap = new Map<string, RoutePath>();
      for (const goalId of goals) {
        const alternatives = [
          ...kShortestPaths(this.graph, currentNodeId, [goalId], personalConfig, perceivedFires, planningTime, reserved, perceivedFires.length ? 2 : 1),
          ...(perceivedFires.length
            ? kShortestPaths(this.graph, currentNodeId, [goalId], safetyConfig, perceivedFires, this.time + forecastHorizon, reserved, 1)
            : []),
        ];
        alternatives.forEach((path) => {
          if (routeIsPhysicallyValid(this.graph, path, this.nodeMap, this.edgeMap)) candidateMap.set(path.nodeIds.join(">"), path);
        });
      }
      const forecasts = [...candidateMap.values()]
        .map((path) => this.forecastRouteSurvival(agent, path, perceivedFires, reserved, routeEdgeMap))
        .sort((a, b) => this.compareSurvivalForecast(a, b));
      const individuallyBest = forecasts[0] ?? null;
      const considersSocialRoute = (this.config.crowdBehavior !== "orderly" || agent.familiarity > 0.82)
        && agent.decisionState !== "avoiding-hazard"
        && agent.stress < 0.72
        && agent.health > 0.45;
      const socialForecast = considersSocialRoute && socialGoal
        ? forecasts.filter((forecast) => forecast.path.goalId === socialGoal)
          .sort((a, b) => this.compareSurvivalForecast(a, b))[0] ?? null
        : null;
      const socialTolerance = 1.015 + agent.groupCohesion * 0.08 + agent.familiarity * 0.04;
      const socialIsReasonable = Boolean(
        individuallyBest
        && socialForecast
        && individuallyBest.survivable
        && socialForecast.survivable
        && socialForecast.eta <= individuallyBest.eta * socialTolerance
        && socialForecast.survivalMargin >= individuallyBest.survivalMargin - 0.035 * (1 - agent.riskAversion),
      );
      nextPath = socialIsReasonable ? socialForecast!.path : individuallyBest?.path ?? null;
      if (socialIsReasonable && nextPath?.goalId === socialGoal && agent.decisionState !== "avoiding-hazard") {
        agent.decisionState = "following-group";
      }
    }
    if (!cached || this.time - cached.at >= 3) this.reroutePathCache.set(cacheKey, { at: this.time, path: nextPath });
    agent.lastRerouteAt = this.time;
    if (!nextPath || nextPath.edgeIds.length === 0) return false;
    const currentRemainingPath: RoutePath = {
      ...agent.route,
      nodeIds: agent.route.nodeIds.slice(agent.edgeIndex),
      edgeIds: agent.route.edgeIds.slice(agent.edgeIndex),
    };
    const currentForecast = currentRemainingPath.edgeIds.length
      ? this.forecastRouteSurvival(agent, currentRemainingPath, perceivedFires, reserved, routeEdgeMap)
      : null;
    const nextForecast = this.forecastRouteSurvival(agent, nextPath, perceivedFires, reserved, routeEdgeMap);
    // Route hysteresis prevents people from oscillating between two almost-identical queues.
    // A safe current route is retained unless the alternative is also safe and materially faster.
    if (!forceRecovery && currentForecast?.survivable) {
      if (!nextForecast.survivable) return false;
      const meaningfulGain = Math.max(1.5, currentForecast.eta * 0.035);
      if (currentForecast.eta - nextForecast.eta < meaningfulGain) return false;
    } else if (!forceRecovery && currentForecast) {
      if (nextForecast.blocked && !currentForecast.blocked) return false;
      const marginGain = nextForecast.survivalMargin - currentForecast.survivalMargin;
      const dangerGain = currentForecast.danger - nextForecast.danger;
      if (marginGain < 0.025 && dangerGain < 0.05) return false;
    }
    if (!forceRecovery && nextPath.edgeIds.join("|") === agent.route.edgeIds.slice(agent.edgeIndex).join("|")) return false;
    agent.route = nextPath;
    agent.edgeIndex = 0;
    agent.edgeEntered = false;
    agent.edgePath = [];
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.status = "rerouting";
    if (agent.decisionState !== "avoiding-hazard" && agent.decisionState !== "following-group") agent.decisionState = "assessing";
    agent.currentNodeId = currentNodeId;
    const node = this.graph.nodes.find((n) => n.id === currentNodeId);
    this.updateContextFromNode(agent, node);
    this.rerouteCount += 1;
    if (this.rerouteCount <= 40 || this.rerouteCount % 25 === 0) {
      this.pushEvent("warning", "คำนวณเส้นทางอพยพใหม่", `Agent #${agent.id} เลือกเส้นทางที่ถึงเร็วที่สุดจากชุดเส้นทางที่คาดว่ารอด โดยผ่านประตู/โถงจริง`);
    }
    return true;
  }

  private markArrived(agent: RuntimeAgent) {
    if (agent.status === "arrived") return;
    this.pendingDetourAgents.delete(agent.id);
    if (!agent.hasExitedBuilding) {
      agent.status = "blocked";
      agent.decisionState = "safe-stop";
      this.collisionCorrections += 1;
      if (this.collisionCorrectionSamples.length < 8) {
        const diagnostic = `agent=${agent.id} premature-arrival goal=${agent.route.goalId} node=${agent.currentNodeId}`;
        this.collisionCorrectionSamples.push(diagnostic);
        this.pushEvent("warning", "Arrival portal guard", diagnostic);
      }
      return;
    }
    agent.status = "arrived";
    agent.decisionState = "following-plan";
    agent.arrivedAt = this.time;
    agent.floor = 0;
    agent.wing = "assembly";
    agent.phase = "assembly";
    agent.position = [...agent.assemblySlot] as Vec3;
    if (this.firstArrival == null) this.firstArrival = this.time;
  }

  private estimateMakespan(reserved: Map<string, number>) {
    let worstQueue = 0;
    for (const edge of this.graph.edges) {
      worstQueue = Math.max(worstQueue, (reserved.get(edge.id) ?? 0) / Math.max(0.1, edge.capacityPerSecond));
    }
    const highestFloorTravel = 8 * FLOOR_HEIGHT / Math.max(0.4, this.config.walkingSpeed * 0.55);
    const outsideTravel = Math.hypot(FIELD_CENTER[2] - 15, FIELD_CENTER[0] + 9) / Math.max(0.4, this.config.walkingSpeed);
    return this.config.responseDelayMax + worstQueue * 2.0 + highestFloorTravel + outsideTravel;
  }

  private pushEvent(severity: SimulationEvent["severity"], title: string, detail: string) {
    this.eventSequence += 1;
    this.events.unshift({ id: `evt-${this.eventSequence}`, time: this.time, severity, title, detail });
    if (this.events.length > 80) this.events.length = 80;
  }

  getAgentSnapshots(): AgentPublicSnapshot[] {
    return this.agents.map((agent) => ({
      id: agent.id,
      gender: agent.gender,
      position: agent.position,
      status: agent.status,
      roomId: agent.roomId,
      routeGoalId: agent.route.goalId,
      floor: agent.floor,
      wing: agent.wing,
      phase: agent.phase,
      currentNodeId: agent.currentNodeId,
      knownFireCount: agent.knownFireIds.size,
      hazardAwareness: this.awarenessLevel(agent),
      smokeAwareness: agent.smokeAwareness,
      heatAwareness: agent.heatAwareness,
      perceivedSmoke: agent.perceivedSmoke,
      perceivedHeat: agent.perceivedHeat,
      visibility: agent.visibility,
      decisionState: agent.decisionState,
      stress: agent.stress,
      health: agent.health,
      flameContactSeconds: agent.flameContactSeconds,
      smokeDose: agent.smokeDose,
      heatDose: agent.heatDose,
      protectivePosture: agent.protectivePosture,
      incapacitatedAt: agent.incapacitatedAt,
      hasPassedRoomDoor: agent.hasPassedRoomDoor,
      hasExitedBuilding: agent.hasExitedBuilding,
    }));
  }

  getCollisionCorrectionSamples(): string[] {
    return [...this.collisionCorrectionSamples];
  }

  getAgentRenderViews(): ReadonlyArray<Pick<AgentPublicSnapshot, "id" | "gender" | "roomId" | "position" | "status" | "floor" | "phase" | "incapacitatedAt" | "protectivePosture">> {
    return this.agents;
  }

  getRoutePolylines(): Array<{ id: string; points: Vec3[]; people: number; goalId: string; risk: number }> {
    const nodeMap = this.nodeMap;
    const edgeMap = this.edgeMap;
    const grouped = new Map<string, { id: string; points: Vec3[]; people: number; goalId: string; risk: number }>();

    this.agents.forEach((agent) => {
      if (agent.status === "arrived" || agent.status === "blocked") return;
      const key = `${agent.edgeIndex}:${agent.route.nodeIds.slice(agent.edgeIndex).join(">")}`;
      const existing = grouped.get(key);
      if (existing) { existing.people += 1; return; }
      const points: Vec3[] = [agent.position];

      if (agent.edgeEntered && agent.edgePath.length > 1) {
        points.push(...agent.edgePath.slice(agent.segmentIndex + 1));
      }
      for (let i = agent.edgeEntered ? agent.edgeIndex + 1 : agent.edgeIndex; i < agent.route.edgeIds.length; i += 1) {
        const edge = edgeMap.get(agent.route.edgeIds[i]);
        const fromId = agent.route.nodeIds[i];
        const toId = agent.route.nodeIds[i + 1];
        if (!edge || !toId) continue;
        const traversal = traversalPoints(edge, nodeMap, fromId, toId);
        points.push(...traversal.slice(1));
      }
      if (points.length > 1 && agent.route.goalId.startsWith("sim-zone-")) points[points.length - 1] = agent.assemblySlot;
      grouped.set(key, { id: key, points: dedupePoints(points), people: 1, goalId: agent.route.goalId, risk: agent.route.risk });
    });
    return [...grouped.values()].sort((a, b) => b.people - a.people).slice(0, 16);
  }

  getMetrics(): SimulationMetrics {
    let arrived = 0, waiting = 0, evacuating = 0, queueing = 0, rerouting = 0, blocked = 0, incapacitated = 0, exposedToSmoke = 0, smokeAware = 0, heatAware = 0, exposedToHeat = 0;
    let indoorAgents = 0, stairAgents = 0, outdoorAgents = 0, topologyViolations = 0;
    let maxModeledTemperatureC = this.config.ambientTemperatureC ?? 29;
    const floorPopulation = Array.from({ length: 10 }, () => 0);
    const wingPopulation: Record<AgentWing, number> = { pink: 0, blue: 0, core: 0, ground: 0, outdoor: 0, assembly: 0 };
    const arrivals: number[] = [];
    const waitingByEdge = new Map<string, number>();
    this.agents.forEach((agent) => {
      if (agent.status === "arrived") arrived += 1;
      else if (agent.status === "waiting") waiting += 1;
      else if (agent.status === "queueing") {
        queueing += 1;
        const edgeId = agent.route.edgeIds[agent.edgeIndex];
        if (edgeId) waitingByEdge.set(edgeId, (waitingByEdge.get(edgeId) ?? 0) + 1);
      }
      else if (agent.status === "rerouting") rerouting += 1;
      else if (agent.status === "blocked") blocked += 1;
      else if (agent.status === "incapacitated") incapacitated += 1;
      else evacuating += 1;
      if (agent.smokeExposure) exposedToSmoke += 1;
      if (agent.smokeAwareness !== "none") smokeAware += 1;
      if (agent.heatAwareness !== "none") heatAware += 1;
      if (agent.heatExposure) exposedToHeat += 1;
      maxModeledTemperatureC = Math.max(maxModeledTemperatureC, modeledTemperatureFromHeat(agent.cachedTrueRisk.heat, this.config.ambientTemperatureC ?? 29));
      if (agent.arrivedAt != null) arrivals.push(agent.arrivedAt);
      if (agent.phase === "stair") stairAgents += 1;
      else if (agent.phase === "outdoor" || agent.phase === "assembly") outdoorAgents += 1;
      else indoorAgents += 1;
      if (agent.floor >= 0 && agent.floor < floorPopulation.length) floorPopulation[agent.floor] += 1;
      wingPopulation[agent.wing] += 1;
      const claimsExteriorWithoutPortal = (agent.phase === "outdoor" || agent.phase === "assembly" || agent.status === "arrived")
        && !agent.hasExitedBuilding;
      const leftRoomWithoutDoor = agent.phase !== "room" && !agent.hasPassedRoomDoor;
      if ((agent.floor > 1 && (agent.phase === "outdoor" || agent.phase === "assembly")) || claimsExteriorWithoutPortal || leftRoomWithoutDoor) topologyViolations += 1;
    });

    const bottlenecks: BottleneckMetric[] = this.graph.edges.filter((edge) => waitingByEdge.has(edge.id)).map((edge) => {
      const reservedPeople = waitingByEdge.get(edge.id) ?? 0;
      const queueSeconds = reservedPeople / Math.max(0.1, edge.capacityPerSecond);
      return {
        edgeId: edge.id,
        name: this.edgeName(edge),
        queueSeconds,
        capacityPerSecond: edge.capacityPerSecond,
        reservedPeople,
        utilization: Math.min(9.99, reservedPeople / Math.max(1, edge.capacityPerSecond * 10)),
      };
    }).filter((item) => item.reservedPeople > 0).sort((a, b) => b.queueSeconds - a.queueSeconds).slice(0, 6);

    const activeQueueSeconds = [...waitingByEdge.entries()].map(([edgeId, count]) => {
      const edge = this.edgeMap.get(edgeId);
      return count / Math.max(0.1, edge?.capacityPerSecond ?? 1);
    });
    const maxQueue = activeQueueSeconds.length ? Math.max(...activeQueueSeconds) : 0;
    const averageQueue = activeQueueSeconds.length ? activeQueueSeconds.reduce((sum, value) => sum + value, 0) / activeQueueSeconds.length : 0;
    let blockedThermalEdges = 0, fireBlockedEdges = 0, smokeAffectedEdges = 0;
    for (const edge of this.graph.edges) {
      const risk = edgeRiskSnapshot(this.graph, edge.id, this.fires, this.time, this.nodeMap, this.edgeMap);
      const temperatureC = modeledTemperatureFromHeat(risk.heat, this.config.ambientTemperatureC ?? 29);
      if (risk.blocked) fireBlockedEdges += 1;
      if (temperatureC >= (this.config.hardBlockTemperatureC ?? 62)) blockedThermalEdges += 1;
      if (risk.smoke >= 0.08) smokeAffectedEdges += 1;
    }

    const total = this.agents.length;
    const averageArrival = arrivals.length ? arrivals.reduce((a, b) => a + b, 0) / arrivals.length : null;
    arrivals.sort((a, b) => a - b);
    return {
      total,
      arrived,
      waiting,
      evacuating,
      queueing,
      rerouting,
      blocked,
      incapacitated,
      exposedToSmoke,
      smokeAware,
      heatAware,
      exposedToHeat,
      progress: total ? arrived / total : 0,
      elapsed: this.time,
      firstArrival: this.firstArrival,
      p50Arrival: percentile(arrivals, 0.5),
      p90Arrival: percentile(arrivals, 0.9),
      p95Arrival: percentile(arrivals, 0.95),
      finalArrival: this.completed && arrivals.length ? Math.max(...arrivals) : null,
      averageArrival,
      rerouteCount: this.rerouteCount,
      thermalRerouteCount: this.thermalRerouteCount,
      estimatedMakespan: this.estimatedMakespan,
      maxModeledTemperatureC,
      blockedThermalEdges,
      fireBlockedEdges,
      smokeAffectedEdges,
      maxQueue,
      averageQueue,
      bottlenecks,
      indoorAgents,
      stairAgents,
      outdoorAgents,
      topologyViolations,
      collisionCorrections: this.collisionCorrections,
      peakEdgeDensity: this.peakEdgeDensity,
      floorPopulation,
      wingPopulation,
    };
  }

  private edgeName(edge: SimEdge) {
    if (edge.kind === "stair") return `บันได ${edge.id.replace("edge-stair-", "")}`;
    if (edge.kind === "room") return `ประตูห้อง ${edge.from.replace("b1-", "")}`;
    if (edge.kind === "corridor" || edge.kind === "junction") return `ทางเดินชั้น ${edge.floorFrom}`;
    if (edge.kind === "outdoor") return "ทางออก → สนามฟุตบอล";
    if (edge.kind === "assembly") return `Assembly ${edge.to.replace("sim-zone-", "Zone ").toUpperCase()}`;
    return edge.id;
  }

  getFireVisuals() {
    return this.fires.map((fire) => {
      const propagationProgress = spreadProgressAt(fire, this.time);
      const path = fire.spreadPath?.length ? fire.spreadPath : [fire.position];
      return {
        ...fire,
        currentFireRadius: fireRadiusAt(fire, this.time),
        currentSmokeRadius: smokeRadiusAt(fire, this.time),
        propagationProgress,
        flameCells: flameCellsAt(fire, this.time),
        visualPosition: propagationProgress < 1 ? positionAlongPolyline(path, propagationProgress) : fire.position,
      };
    });
  }

  getInitialPopulationSummary() {
    return activeRoomPopulation(this.config.populationTarget);
  }
}

export const evacuationRuntime = new EvacuationRuntime();
