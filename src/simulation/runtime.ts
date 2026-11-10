import {
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
import { applyGraphEdits } from "./graphEdits";
import type {
  AgentPhase,
  AgentDecisionState,
  AgentPublicSnapshot,
  AgentStatus,
  AgentWing,
  BottleneckMetric,
  DecisionMode,
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
import { PEDESTRIAN_RADIUS, movementSegmentIsContinuous, pointClearsExteriorBuilding, pointInsideWalkableCorridor, walkableHalfWidth } from "./walkable";
import { ALL_CLASSROOMS, campusBuildingAt, BLOCK_LEVELS } from "./campusData";
import { fieldOffset } from "../building1/siteLayout";
import { flameCellsAt, flameClearanceAt, fireHasStarted, fireMayAffectPoint, spreadProgressAt, type FlameCell } from "./fireField";
import { edgeAllowsDetour, planFireDetour, segmentInsideWalkway } from "./localNavigation";
import { normalizeStudentPopulation, studentStartPosition } from "./studentPlacement";
import { normalizeSeed, seeded01, hashString } from "./seededRandom";
import { placeNameTh } from "./placeNames";
import { BRIDGE_EDGE_ID, BRIDGE_LABEL_TH } from "./bridge";
import { describeReasonTh, shortReasonTh, BEHAVIOR_LABEL_TH, AWARENESS_LABEL_TH, type AgentBehaviorState, type AwarenessSource, type DecisionReason, type DecisionReasonCode } from "./agentReasons";
import { neighbouringReportZones, nodeBuilding, perceptionTopology, reportZoneOf, spacesInView, type PerceptionTopology } from "./agentPerception";
import { createEdgeQueue, expectedQueueWait, joinQueue, leaveQueue, refillEdgeQueue, tryAdmit, tryAdmitCompetitive, type EdgeQueueState } from "./edgeQueue";

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
  retreatNodeId?: string;
  retreatEdge?: SimEdge;
  knownFireIds: Set<string>;
  fireKnowledge: Map<string, FireBelief>;
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
  /** Explicit behaviour state, derived once per fixed step from the fields above. */
  behavior: AgentBehaviorState;
  /** Strongest source through which the person knows about the emergency. */
  awareness: AwarenessSource;
  awareAt: number | null;
  /** Time at which this person hears the building alarm (audibility/attention differs). */
  alarmHeardAt: number;
  reason: DecisionReason;
  /** Why the *current route* was chosen (kept while waiting/queueing events update `reason`). */
  routeReason: DecisionReason;
  lastEvaluationAt: number;
  /** Seeded, staggered non-urgent re-evaluation schedule. */
  nextDecisionAt: number;
  decisionPeriod: number;
  /** Exponential back-off when no usable route exists, so failures never repeat every frame. */
  noRouteFailures: number;
  noRouteRetryAt: number;
  /** Recent hazard stops in front of a passage (edge, time, what was ahead). Detects a person who
   * would otherwise step up to the same doorway and back again every second. */
  hazardStops?: Array<{ edgeId: string; at: number; hazard: "smoke" | "heat" | "fire" }>;
  /** Passages that turned this person back more than once: avoided when planning until the time stored. */
  hazardAvoid?: Map<string, number>;
  /** Cached "this passage leads out of the smoke" verdict (re-evaluated at most once a second). */
  smokeExitCache?: { edgeId: string; segment: number; at: number; ok: boolean };
  /** Directed queue the person is physically waiting in, if any. */
  queueKey: string | null;
  queueJoinedAt: number;
  /** Global order in which people took their current place in any line (strict precedence). */
  queueSeq: number;
  /** Last time this person moved ≥ 0.15 m (from `progressAnchor`); drives the squeeze-past rule. */
  lastProgressAt: number;
  progressAnchor: Vec3;
  squeezeCounted: boolean;
  /** How many times each remembered closure has been gone back to and re-checked. */
  closureRechecks: Map<string, number>;
  /** Last route hazard forecast (see the decision point). */
  reservedCache: { at: number; value: Map<string, number> } | null;
  routeForecastCache: { route: RoutePath; edgeIndex: number; value: ReturnType<EvacuationRuntime["forecastRouteHazard"]> } | null;
  /** Personal memory of passages found closed (edge id → time observed). */
  knownClosed: Map<string, number>;
  /** Personal memory of observed queues (edge id → expected wait seconds, time observed). */
  queueMemory: Map<string, { wait: number; at: number }>;
  routeSwitches: number;
  lastSwitchAt: number;
  /** Recently abandoned route signatures (prevents A → B → A flip-flopping). */
  abandonedRoutes: Map<string, number>;
  /** Personal reluctance to change plan, expressed in seconds of expected gain required. */
  switchCostSeconds: number;
  assemblySlotIndex: number;
  /**
   * When someone is admitted from a waiting position on the incoming passage, they first walk the
   * rest of that passage to the entrance. Movement there is validated against that passage.
   */
  approachEdge?: SimEdge;
  approachPath?: Vec3[];
  /** Number of leading segments of edgePath that belong to the approach. */
  approachSegments: number;
  /** Passage the person physically arrived by (kept across re-plans, which reset route indices). */
  arrivalEdgeId?: string;
  arrivalFromNodeId?: string;
  /**
   * Personal tendency to press forward into gaps at a door or stair (0 polite – 1 shoves). Fixed for
   * the person; stress and seeing others push raise the effective value (see pressScore).
   */
  pushiness: number;
  /** Simulated phone guidance received for this person (simulator A), applied at the next node. */
  phoneAdvice?: { revision: number; nodeIds: string[]; edgeIds: string[]; reason: string | null; receivedAt: number; nodesSince: number };
  /** Revisions this person has already accepted or ignored. */
  phoneRevisionHandled?: number;
  /** Bounded lateral yielding, retained until this passage ends (not snapped back next tick). */
  bodyLateralOffset?: number;
  /** The person has stopped following the phone because what they saw contradicted it. */
  phoneIgnoredAt?: number;
}

interface FireBelief {
  source: Exclude<HazardAwareness, "none">;
  learnedAt: number;
  /** Last time the person directly sensed or was told about this fire. */
  observedAt: number;
  believedPosition: Vec3;
  /** 0–1. Direct observation ≈ 1, second-hand reports less, decaying with age. */
  confidence: number;
  /** Extra avoidance margin (m) representing location uncertainty. */
  uncertainty: number;
  controller?: boolean;
}

type RerouteTrigger = "periodic" | "queue" | "hazard" | "closed" | "recovery";
const EARLY_QUEUE_JOIN_KINDS = new Set<SimEdge["kind"]>(["corridor", "junction", "stair", "outdoor", "assembly"]);

/** Simulation clock step (s). Every movement, decision, queue and exposure update uses it. */
/** Smoke check along the way out: sample spacing (m), densest smoke still passable (perceived,
 * 0–1 model scale), and what counts as clean air at the far end. Model parameters, not tolerances. */
const SMOKE_EXIT_SAMPLE_M = 0.75;
const SMOKE_EXIT_PASS_LIMIT = 0.55;
const SMOKE_EXIT_CLEAN = 0.06;
const SMOKE_EXIT_EDGES = 4;
const SMOKE_EXIT_HORIZON_M = 25;
/** Hazard stops at the same passage within this window → hold instead of stepping up and back. */
const HAZARD_STOP_WINDOW_S = 30;
const HAZARD_STOP_REPEAT = 3;
const HAZARD_HOLD_RETRY_S = 4;
// A long passage (a stair flight) can take longer than HAZARD_STOP_WINDOW_S to walk down and back,
// so the second turn-back on the same passage within this window is remembered for planning.
const HAZARD_MEMORY_WINDOW_S = 240;
const HAZARD_MEMORY_REPEAT = 2;
const HAZARD_AVOID_SECONDS = 180;

export const FIXED_SIMULATION_DT = 0.1;
/** Reports and queue observations lose relevance with age (s). */
const REPORT_LIFETIME_SECONDS = 150;
const QUEUE_MEMORY_SECONDS = 45;
/** A remembered closure is re-checked after this long while a person has no usable route. */
const CLOSURE_RECHECK_SECONDS = 45;
/**
 * Safety net (project assumption, not a published value): after standing still this long a person
 * squeezes past people waiting in *other* lines. Rules between lines at a junction can otherwise
 * form a loop where everybody waits for somebody else. Counted in metrics as `squeezeEvents`.
 */
const STALL_SQUEEZE_SECONDS = 10;
/**
 * How competitive the crowd is at doors and stairs for each behaviour setting. A rehearsed drill
 * keeps an orderly line; in a real emergency people crowd the opening instead of queueing.
 */
const COMPETITIVENESS: Record<SimulationConfig["crowdBehavior"], number> = { orderly: 0, grouped: 0.55, surge: 0.9 };
/** People per m² at an opening above which the crowd is dangerous (crush/fall risk). */
const DANGEROUS_CROWD_DENSITY = 6;
/** Fixed controller detection/announcement delay for coordinated mode (s after ignition). */
const CONTROLLER_DETECTION_SECONDS = 20;

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
  seed: 1,
  decisionMode: "occupant",
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
        ? Math.min(2.40, walkableHalfWidth(edge) - 0.30)
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

/**
 * Speed–density relation of the hydraulic (Nelson–Mowrer) model in the SFPE Handbook of Fire
 * Protection Engineering ("Employing the Hydraulic Model in Assessing Emergency Movement"):
 * S = k − a·k·D with a = 0.266 m²/person, valid for 0.54 ≤ D ≤ 3.8 persons/m². It is used here
 * only for its *shape*, normalised so that a person keeps their own free speed (project setting ×
 * passage multiplier) below 0.54 p/m². Maximum specific flow occurs near 1.9 p/m². A small floor
 * keeps a jammed crowd creeping instead of freezing numerically.
 */
export function densitySpeedRatio(density: number): number {
  if (!Number.isFinite(density) || density <= 0.54) return 1;
  return Math.max(0.08, Math.min(1, (1 - 0.266 * density) / (1 - 0.266 * 0.54)));
}

/** Walkable area (m²) of a passage using effective width (0.15 m boundary layer each side). */
function effectiveEdgeArea(edge: SimEdge): number {
  return Math.max(1.2, Math.max(0.6, edge.width - 0.3) * Math.max(1.5, edge.distance));
}

/** Unit horizontal walking direction of an agent on its current path segment. */
function walkingHeading(agent: { edgePath: Vec3[]; segmentIndex: number }): [number, number] {
  const path = agent.edgePath;
  for (let index = Math.max(0, agent.segmentIndex); index < path.length - 1; index += 1) {
    const dx = path[index + 1][0] - path[index][0];
    const dz = path[index + 1][2] - path[index][2];
    const length = Math.hypot(dx, dz);
    if (length > 0.05) return [dx / length, dz / length];
  }
  return [0, 1];
}

function edgeSupportsLocalBypass(edge: SimEdge) {
  return edgeAllowsDetour(edge);
}

// Paths are never edited in place (a new array is assigned instead), so their length can be
// remembered per array object.
const polylineLengthCache = new WeakMap<Vec3[], number>();
function polylineLength(path: Vec3[]) {
  const cached = polylineLengthCache.get(path);
  if (cached !== undefined) return cached;
  let total = 0;
  for (let index = 1; index < path.length; index += 1) total += distance3(path[index - 1], path[index]);
  polylineLengthCache.set(path, total);
  return total;
}

/** Numeric key of a 1 m × 1.6 m × 1 m cell (x, level, z); cheaper than building strings. */
function stationaryCellKey(x: number, level: number, z: number) {
  return ((x + 4096) * 64 + (level + 32)) * 8192 + (z + 4096);
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

/**
 * Straight line from `a` to `b` stays inside the walkway. Sampled every 4 cm over the first 0.8 m
 * (thin corners of a stair void or lift bank must not slip between samples) and every 16 cm after.
 */
function chordClear(a: Vec3, b: Vec3, path: Vec3[], edge: SimEdge): boolean {
  const length = distance3(a, b);
  if (length < 1e-6) return pointInsideWalkableCorridor(a, path, edge);
  let travelled = 0;
  while (travelled <= length) {
    const t = travelled / length;
    if (!pointInsideWalkableCorridor([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], path, edge)) return false;
    travelled += travelled < 0.8 ? 0.04 : 0.16;
  }
  return pointInsideWalkableCorridor(b, path, edge);
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

function unrotatedAssemblySlot(center: Vec3, index: number, behavior: SimulationConfig["crowdBehavior"]): Vec3 {
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

function assemblySlotPosition(center: Vec3, index: number, behavior: SimulationConfig["crowdBehavior"]): Vec3 {
  const local=unrotatedAssemblySlot([0,0,0],index,behavior);
  const offset=fieldOffset(...local);
  return [center[0]+offset[0],center[1]+offset[1],center[2]+offset[2]];
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

function slotForGoal(goal: SimNode, index: number, behavior: SimulationConfig["crowdBehavior"]): Vec3 {
  return goal.id.startsWith("campus-parking-")
    ? [goal.position[0]-3.375+(index%10)*.75,goal.position[1]+.02,goal.position[2]-3.375+Math.floor(index/10)*.75]
    : assemblySlotPosition(goal.position,index,behavior);
}

export class EvacuationRuntime {
  graph: SimGraph = createEvacuationGraph();
  config: SimulationConfig = { ...DEFAULT_CONFIG };
  fires: FireSource[] = [];
  agents: RuntimeAgent[] = [];
  bundles: RouteBundle[] = [];
  /** Directed admission queues keyed by `${edgeId}|${fromNodeId}`. */
  edgeQueues = new Map<string, EdgeQueueState>();
  /** World truth: passages that are physically closed/blocked in the scenario. */
  closedEdges = new Set<string>();
  events: SimulationEvent[] = [];
  time = 0;
  /** A new population invalidates renderer history even if reset/start share one React batch. */
  revision = 0;
  running = false;
  completed = false;
  rerouteCount = 0;
  thermalRerouteCount = 0;
  /** Route changes by reason code (results screen). */
  rerouteReasonCounts = new Map<string, number>();
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
  /** Path searches actually run by people re-planning (cache hits and budget deferrals excluded). */
  planSearches = 0;
  private detourPlanningBudget = 0;
  private pendingDetourAgents = new Set<number>();
  private eventSequence = 0;
  private fireSequence = 0;
  private edgeMap = new Map<string, SimEdge>();
  private nodeMap = new Map<string, SimNode>();
  private activeEdgeCountsCache = new Map<string, number>();
  private forwardGapByAgentCache = new Map<number, number>();
  private queueSequence = 0;
  /** Number of times somebody had to squeeze past people of another line after standing still. */
  squeezeEvents = 0;
  /** Seconds (summed over openings) during which the crowd at an opening exceeded DANGEROUS_CROWD_DENSITY. */
  dangerousCrowdSeconds = 0;
  /** Highest crowd density measured at an opening mouth (people/m²). */
  peakMouthDensity = 0;
  /**
   * Simulator A: share of people who follow a route their phone gives them (0–1). Who holds a phone
   * and what it says is decided outside (the guidance backend); this runtime only decides whether
   * each person acts on it — and people still react to danger they see themselves.
   */
  phoneCompliance = 0.75;
  /**
   * Roleplay simulator: the body of the person the user controls (feet position), or null. Walking
   * NPCs do not step into it and people crowding an opening keep clear of it, exactly as for any
   * other standing person — including the 10 s squeeze-past safety net, so nobody waits for ever.
   */
  playerBody: Vec3 | null = null;
  private assemblyAreaCache: { behavior: string; areas: Array<{ nodeId: string; minX: number; maxX: number; minZ: number; maxZ: number; y: number }> } | null = null;
  /** People who switched to a phone-advised route / ignored one (metrics). */
  phoneFollowed = 0;
  phoneIgnored = 0;
  /** Ranking of the people pressing at each opening, rebuilt once per fixed step. */
  private mouthRanking = new Map<string, { time: number; order: number[]; contenders: number; radius: number }>();
  private fireBuildingsCache = new Map<string, string[]>();
  /** Fast front for fireBuildings(): same key (id + exact position) without building a string per call. */
  private fireBuildingsFast = new WeakMap<FireSource, { id: string; x: number; y: number; z: number; value: string[] }>();
  /** Per-step facts about a fire that are identical for every person (flame cells, their floors, view spaces). */
  private fireStepInfo = new WeakMap<FireSource, { time: number; attach?: string; parentId?: string; cells: FlameCell[]; floors: Set<number>; spaces: string[] }>();
  /** People standing still (queueing/holding) by 1 m cell, rebuilt every step. */
  private stationaryGrid = new Map<number, RuntimeAgent[]>();
  /** Distance left along the incoming walkway for each waiting person (rebuilt every step). */
  private queueRemainingCache = new Map<number, number>();
  private passagePathCache = new Map<string, Vec3[]>();
  /** Who is directly in front of each walker (diagnostics and the inspector). */
  private forwardBlockerByAgent = new Map<number, number>();
  private queueAheadByAgent = new Map<number, string>();
  private entranceOccupants = new Map<string, Vec3[]>();
  /** People standing (in another line) within the first 1.5 m of a passage, by stream. */
  private entranceStanders = new Map<string, Vec3[]>();
  /** Occupancy of each passage per walking direction (walkers + people queued on it). */
  private directionalEdgeCounts = new Map<string, number>();
  private planningReservedAt = -Infinity;
  private planningReservedCache = new Map<string, number>();
  private accumulator = 0;
  private queuesByEdge = new Map<string, EdgeQueueState[]>();
  /** goal id → slot index → agent id (or -1). Released whenever a person changes goal. */
  private slotOwners = new Map<string, Int32Array>();
  private goalCounts = new Map<string, number>();
  /** `${edgeId}@${zone}` → time a closure report reaches that zone. */
  private closureReports = new Map<string, number>();
  private beliefFireCache = new Map<string, FireSource>();
  private staleQueueRepairs = 0;
  private lastQueueAuditAt = -Infinity;
  private outgoingByNode = new Map<string, SimEdge[]>();
  private perception: PerceptionTopology | null = null;
  private occupantRouteCache = new Map<string, RoutePath[]>();
  private get seed() { return normalizeSeed(this.config.seed, 1); }
  get decisionMode(): DecisionMode { return this.config.decisionMode === "coordinated" ? "coordinated" : "occupant"; }

  reset(keepFires = true) {
    this.playerBody = null;
    this.revision += 1;
    this.agents = [];
    this.bundles = [];
    this.edgeQueues.clear();
    this.queuesByEdge.clear();
    this.slotOwners.clear();
    this.goalCounts.clear();
    this.closureReports.clear();
    this.beliefFireCache.clear();
    this.staleQueueRepairs = 0;
    this.lastQueueAuditAt = -Infinity;
    this.accumulator = 0;
    this.occupantRouteCache.clear();
    this.events = [];
    this.eventSequence = 0;
    this.time = 0;
    this.running = false;
    this.completed = false;
    this.rerouteCount = 0;
    this.rerouteReasonCounts = new Map();
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
    this.planSearches = 0;
    this.detourPlanningBudget = 0;
    this.pendingDetourAgents.clear();
    this.activeEdgeCountsCache.clear();
    this.forwardGapByAgentCache.clear();
    this.forwardBlockerByAgent.clear();
    this.queueRemainingCache.clear();
    this.stationaryGrid.clear();
    this.queueSequence = 0;
    this.squeezeEvents = 0;
    this.dangerousCrowdSeconds = 0;
    this.peakMouthDensity = 0;
    this.phoneFollowed = 0;
    this.phoneIgnored = 0;
    this.mouthRanking.clear();
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
      populationTarget: config.roomPopulation
        ? normalizeStudentPopulation(activeRoomPopulation(0, config.roomPopulation).reduce((sum, item) => sum + item.count, 0))
        : normalizeStudentPopulation(config.populationTarget ?? TARGET_POPULATION),
      walkingSpeed: normalizeWalkingSpeed(config.walkingSpeed),
      seed: normalizeSeed(config.seed ?? DEFAULT_CONFIG.seed, 1),
      decisionMode: config.decisionMode === "coordinated" ? "coordinated" : "occupant",
    };
    this.graph = applyGraphEdits(createEvacuationGraph(), this.config.graphEdits);
    this.edgeMap = new Map(this.graph.edges.map((edge) => [edge.id, edge]));
    this.nodeMap = new Map(this.graph.nodes.map((node) => [node.id, node]));
    this.outgoingByNode = new Map();
    for (const edge of this.graph.edges) {
      (this.outgoingByNode.get(edge.from) ?? this.outgoingByNode.set(edge.from, []).get(edge.from)!).push(edge);
      if (edge.twoWay) (this.outgoingByNode.get(edge.to) ?? this.outgoingByNode.set(edge.to, []).get(edge.to)!).push(edge);
    }
    this.perception = perceptionTopology(this.graph);
    // Closures that refer to passages missing from this graph cannot affect anybody.
    [...this.closedEdges].forEach((edgeId) => { if (!this.edgeMap.has(edgeId)) this.closedEdges.delete(edgeId); });
    for (const edgeId of this.config.editorClosedEdgeIds ?? []) if (this.edgeMap.has(edgeId)) this.closedEdges.add(edgeId);
    // The allocation is the *coordinated* plan: whole-building information, system optimum.
    // Occupant mode keeps only its class-level assembly-area assignment (taught in drills) and
    // lets every person choose the route from what they know.
    const allocation = allocatePopulation(this.graph, this.config, [], 0);
    this.bundles = allocation.bundles;
    this.estimatedMakespan = this.estimateMakespan(allocation.reserved);
    const nodeMap = this.nodeMap;
    const roomMap = new Map(ALL_CLASSROOMS.map((room) => [room.id, room]));
    const seed = this.seed;
    const coordinated = this.decisionMode === "coordinated";
    let id = 0;
    const roomCursor = new Map<string, number>();

    for (const bundle of this.bundles) {
      const room = roomMap.get(bundle.roomId);
      if (!room) continue;
      const roomNode = nodeMap.get(room.id);
      if (!roomNode) continue;
      for (let i = 0; i < bundle.peopleCount; i += 1) {
        const localIndex = roomCursor.get(room.id) ?? 0;
        roomCursor.set(room.id, localIndex + 1);
        const start = studentStartPosition(room, localIndex % CLASSROOM_CAPACITY);
        const goalNode = nodeMap.get(bundle.path.goalId);
        const groupSize = this.config.crowdBehavior === "surge" ? 16 : this.config.crowdBehavior === "grouped" ? 8 : 1;
        const groupSeed = Math.floor(id / groupSize);
        const r = (salt: string) => seeded01(seed, id, salt);
        const g = (salt: string) => seeded01(seed, groupSeed, salt);
        const speedSpread = this.config.crowdBehavior === "surge" ? 0.34 : this.config.crowdBehavior === "grouped" ? 0.2 : 0.12;
        const responseRange = Math.max(0, this.config.responseDelayMax - this.config.responseDelayMin);
        const groupResponse = this.config.responseDelayMin + g("group-response") * responseRange;
        const individualResponseJitter = this.config.crowdBehavior === "orderly" ? 0 : r("response-jitter") * 0.22;
        const alarmHeardAt = Math.min(1.5, this.config.responseDelayMax * 0.25) * r("alarm-audibility");
        const familiarity = 0.42 + r("familiarity") * 0.55;
        const agent: RuntimeAgent = {
          id,
          gender: (localIndex + room.floor + room.index) % 2 === 0 ? "female" : "male",
          roomId: room.id,
          position: start,
          status: "waiting",
          speed: this.config.walkingSpeed * (1 - speedSpread + r("speed") * speedSpread * 2),
          responseDelay: Math.max(alarmHeardAt, Math.min(this.config.responseDelayMax, groupResponse + individualResponseJitter)),
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
          wing: room.buildingId === "building-3" || room.buildingId === "building-4" ? room.buildingId : room.side,
          phase: "room",
          currentNodeId: room.id,
          assemblySlot: [...FIELD_CENTER] as Vec3,
          retreating: false,
          knownFireIds: new Set<string>(),
          fireKnowledge: new Map(),
          groupLeaderId: id - (localIndex % groupSize),
          riskAversion: 0.35 + r("risk-aversion") * 0.6,
          smokeSensitivity: 0.65 + r("smoke-sensitivity") * 0.7,
          heatSensitivity: 0.78 + r("heat-sensitivity") * 0.48,
          // People do not notice weak smoke at exactly the same concentration.
          // Lower values represent occupants with a more sensitive sense of smell.
          smokeDetectionThreshold: 0.025 + r("smoke-threshold") * 0.035,
          heatDetectionThreshold: 0.045 + r("heat-threshold") * 0.045,
          smokeAwareness: "none",
          heatAwareness: "none",
          perceivedSmoke: 0,
          perceivedHeat: 0,
          visibility: 1,
          familiarity,
          groupCohesion: this.config.crowdBehavior === "surge" ? 0.78 + g("cohesion") * 0.18 : this.config.crowdBehavior === "grouped" ? 0.62 + g("cohesion") * 0.28 : 0.18 + r("cohesion") * 0.34,
          queueToleranceSeconds: 8 + r("queue-tolerance") * 11,
          decisionLatency: 0.35 + r("decision-latency") * 2.2,
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
          lastHazardUpdateAt: -0.000001 - r("hazard-phase") * 0.9,
          cachedTrueRisk: { fire: 0, smoke: 0, heat: 0, blocked: false },
          cachedPerceivedFires: [],
          detourPath: [],
          detourIndex: 0,
          lastDetourPlanAt: -Infinity,
          behavior: "unaware",
          awareness: "none",
          awareAt: null,
          alarmHeardAt,
          reason: { code: "not-aware", at: 0 },
          routeReason: { code: "follow-plan", at: 0 },
          lastEvaluationAt: -Infinity,
          // Non-urgent re-evaluations are spread over a personal period with a seeded phase, so
          // hundreds of people never all turn on the same frame after reading the same queue.
          decisionPeriod: 5 + r("decision-period") * 5,
          nextDecisionAt: 0,
          noRouteFailures: 0,
          noRouteRetryAt: -Infinity,
          queueKey: null,
          queueJoinedAt: 0,
          queueSeq: 0,
          lastProgressAt: 0,
          progressAnchor: [0, 0, 0],
          squeezeCounted: false,
          closureRechecks: new Map(),
          routeForecastCache: null,
          reservedCache: null,
          knownClosed: new Map(),
          queueMemory: new Map(),
          routeSwitches: 0,
          lastSwitchAt: -Infinity,
          abandonedRoutes: new Map(),
          switchCostSeconds: 4 + r("switch-cost") * 6,
          assemblySlotIndex: -1,
          approachSegments: 0,
          // Skewed: most people press a little, a minority shove hard (Haghani et al.; He et al. 2024).
          pushiness: this.competitiveness > 0 ? Math.pow(r("pushiness"), 1.6) : 0,
        };
        agent.nextDecisionAt = agent.responseDelay + r("decision-phase") * agent.decisionPeriod;
        if (goalNode) {
          const slot = this.acquireSlot(goalNode, agent);
          if (slot) agent.assemblySlot = slot;
        }
        if (coordinated) {
          agent.reason = { code: "initial-controller-plan", at: 0, params: { via: this.routeViaLabel(bundle.path) } };
        } else {
          this.chooseInitialOccupantRoute(agent, room.id, bundle.path);
        }
        agent.routeReason = agent.reason;
        agent.reason = { code: "not-aware", at: 0 };
        this.agents.push(agent);
        id += 1;
      }
    }

    this.running = true;
    this.pushEvent("info", "เริ่มการจำลอง", `เริ่มจำลอง ${this.agents.length.toLocaleString("th-TH")} คน · seed ${seed} · ${coordinated ? "โหมดผู้ควบคุมสั่งการ (ข้อมูลทั้งระบบ)" : "โหมดผู้ใช้อาคารตัดสินใจเอง (ข้อมูลเฉพาะที่ตนรับรู้)"}`);
    this.pushEvent("success", "Physical topology guard active", "Agent ถูกบังคับ Room → Door → Corridor → Stair → ชั้น 1 → Exit → สนาม ไม่มีเส้นลัดทะลุอาคาร");
    this.pushEvent("info", "Human decision model active", coordinated
      ? "ผู้ควบคุมจัดสรรเส้นทางจากภาพรวมทั้งอาคาร และแจ้งเหตุ/ทางปิดให้ทุกคนหลังตรวจพบ"
      : "แต่ละคนเลือกทางจากความคุ้นเคย สิ่งที่มองเห็น คิวที่เห็นจริง คำเตือนในพื้นที่ และการตามกลุ่ม");
    this.pushEvent("success", "เปิดการประเมินเส้นทางตามความเสี่ยง", "ประเมินเวลาถึงแต่ละช่วงทางจากข้อมูลที่แต่ละคนรู้ ก่อนเลือกบันไดหรือทางออก โดยมีเกณฑ์กันการเปลี่ยนใจถี่");
    this.pushEvent("success", "Direct-flame contact model active", "ควันและความร้อนทำให้มองเห็นน้อยลง ชะลอ และเปลี่ยนเส้นทาง; นักเรียนจะหมดสติเฉพาะเมื่อร่างกายสัมผัสขอบเขตเปลวไฟต่อเนื่องเท่านั้น");
    if (this.config.fireSpreadEnabled) {
      this.pushEvent("success", "Object-connected fire spread active", "ไฟลามเฉพาะวัตถุที่เชื่อมกันจริง: ห้อง → ประตู → ทางเดิน → บันได โดยผนังคอนกรีตและพื้นแต่ละชั้นไม่ถูกข้ามด้วยรัศมีวงกลม");
    }
    if (this.agents.length < this.config.populationTarget) {
      this.pushEvent("danger", "Route validation warning", `${(this.config.populationTarget - this.agents.length).toLocaleString("th-TH")} คนไม่มีเส้นทางปลอดภัยไปสนามภายใต้ Hazard ปัจจุบัน`);
    }
    if (this.fires.length) this.pushEvent("warning", "Fire scenario active", `มีจุดไฟ ${this.fires.length} จุด · คนจะรู้เฉพาะเมื่อเห็น/ได้กลิ่น/ได้รับแจ้ง`);
    if (this.closedEdges.size) this.pushEvent("warning", "มีทางที่ถูกปิด", `${this.closedEdges.size} ช่วงทาง · คนจะรู้เมื่อเดินไปเห็นหรือได้รับแจ้ง`);
  }

  /** Short Thai label of the first stair (or exit) used by a route. */
  routeViaLabel(path: RoutePath | undefined): string {
    if (!path) return "เส้นทาง";
    const stair = path.edgeIds.find((edgeId) => this.edgeMap.get(edgeId)?.kind === "stair");
    if (!stair) return "ทางออกชั้นล่าง";
    const campus = stair.match(/^campus-b(\d)-stair-(\d)-/);
    if (campus) return `บันได ${Number(campus[2]) + 1} อาคาร ${campus[1]}`;
    const zone = stair.match(/^edge-stair-(left|center|right)-/)?.[1];
    return zone === "left" ? "บันไดซ้าย อาคาร 1" : zone === "right" ? "บันไดขวา อาคาร 1" : zone === "center" ? "บันไดกลาง อาคาร 1" : "บันได";
  }

  private routeViaKey(path: RoutePath): string {
    const stair = path.edgeIds.find((edgeId) => this.edgeMap.get(edgeId)?.kind === "stair");
    return stair ? stair.replace(/-(down-)?\d+(-\d+)?$/, "") : path.edgeIds[path.edgeIds.length - 1] ?? "none";
  }

  private routeTravelSeconds(path: RoutePath, speed: number, indoorOnly = false): number {
    let seconds = 0;
    for (const edgeId of path.edgeIds) {
      const edge = this.edgeMap.get(edgeId);
      if (edge && (!indoorOnly || edge.insideBuilding)) seconds += edge.distance / Math.max(0.25, speed * edge.speedMultiplier);
    }
    return seconds;
  }

  /**
   * Occupant-mode initial choice (no queue or hazard knowledge yet). Perceived cost in seconds:
   *   travel time at own speed × (1 ± 12 % personal estimation error for that stair)
   *   + unfamiliarity penalty (s) for a stair that is not the person's habitual (nearest) one.
   * Friends follow their group leader's stair with probability = group cohesion.
   */
  private chooseInitialOccupantRoute(agent: RuntimeAgent, roomId: string, planned: RoutePath) {
    const goalId = planned.goalId;
    const key = `${roomId}>${goalId}`;
    let candidates = this.occupantRouteCache.get(key);
    if (!candidates) {
      const freeConfig: SimulationConfig = { ...this.config, preset: "fastest" };
      candidates = kShortestPaths(this.graph, roomId, [goalId], freeConfig, [], 0, new Map(), 4)
        .filter((path) => routeIsPhysicallyValid(this.graph, path, this.nodeMap, this.edgeMap));
      if (!candidates.length) candidates = [planned];
      this.occupantRouteCache.set(key, candidates);
    }
    // Habit = the stair nearest to the classroom (indoor walking), as used every school day.
    const nominal = candidates.map((path) => this.routeTravelSeconds(path, this.config.walkingSpeed, true));
    const habitual = this.routeViaKey(candidates[nominal.indexOf(Math.min(...nominal))]);
    const leader = agent.groupLeaderId !== agent.id ? this.agents[agent.groupLeaderId] : undefined;
    if (leader && leader.roomId === agent.roomId && seeded01(this.seed, agent.id, "follow-leader-initial") < agent.groupCohesion) {
      const leaderVia = this.routeViaKey(leader.route);
      const shared = candidates.find((path) => this.routeViaKey(path) === leaderVia);
      if (shared) {
        agent.route = shared;
        agent.reason = { code: "initial-group-route", at: 0, params: { via: this.routeViaLabel(shared) } };
        return;
      }
    }
    let best = candidates[0];
    let bestCost = Infinity;
    for (const path of candidates) {
      const via = this.routeViaKey(path);
      const estimationError = 1 + (seeded01(this.seed, agent.id, `route-estimate:${via}`) * 2 - 1) * 0.12;
      const unfamiliarity = via === habitual ? 0 : (1 - agent.familiarity) * 45;
      // People judge mainly the indoor way to "their" stair; the outdoor leg to the assembly
      // area is only weakly considered (0.35 weight).
      const indoor = this.routeTravelSeconds(path, agent.speed, true);
      const outdoor = this.routeTravelSeconds(path, agent.speed) - indoor;
      const cost = indoor * estimationError + outdoor * 0.35 + unfamiliarity;
      if (cost < bestCost) { bestCost = cost; best = path; }
    }
    agent.route = best;
    agent.reason = { code: "initial-familiar-route", at: 0, params: { via: this.routeViaLabel(best), cost: Math.round(bestCost) } };
  }

  private slotOwnersFor(goal: SimNode): Int32Array {
    let owners = this.slotOwners.get(goal.id);
    if (!owners) { owners = new Int32Array(Math.max(0, goal.capacity)).fill(-1); this.slotOwners.set(goal.id, owners); }
    return owners;
  }

  private goalCount(goalId: string): number { return this.goalCounts.get(goalId) ?? 0; }

  private freeSlotIndex(goal: SimNode): number {
    const owners = this.slotOwnersFor(goal);
    for (let index = 0; index < owners.length; index += 1) if (owners[index] < 0) return index;
    return -1;
  }

  /** Reserve one standing position at an assembly area. Never shares or exceeds capacity. */
  private acquireSlot(goal: SimNode, agent: RuntimeAgent): Vec3 | null {
    const index = this.freeSlotIndex(goal);
    if (index < 0) return null;
    this.releaseSlot(agent);
    this.slotOwnersFor(goal)[index] = agent.id;
    this.goalCounts.set(goal.id, this.goalCount(goal.id) + 1);
    agent.assemblySlotIndex = index;
    return slotForGoal(goal, index, this.config.crowdBehavior);
  }

  private releaseSlot(agent: RuntimeAgent) {
    if (agent.assemblySlotIndex < 0) return;
    const owners = this.slotOwners.get(agent.route.goalId);
    if (owners && owners[agent.assemblySlotIndex] === agent.id) {
      owners[agent.assemblySlotIndex] = -1;
      this.goalCounts.set(agent.route.goalId, Math.max(0, this.goalCount(agent.route.goalId) - 1));
    } else {
      // Fall back to a scan so a mismatched goal id can never leak a reservation.
      this.slotOwners.forEach((list, goalId) => {
        const index = list.indexOf(agent.id);
        if (index >= 0) { list[index] = -1; this.goalCounts.set(goalId, Math.max(0, this.goalCount(goalId) - 1)); }
      });
    }
    agent.assemblySlotIndex = -1;
  }

  /** Move a person to a new route; releases queue + old slot and reserves the new goal's slot. */
  private commitRoute(agent: RuntimeAgent, path: RoutePath): boolean {
    if (path.goalId !== agent.route.goalId || agent.assemblySlotIndex < 0) {
      const goal = this.nodeMap.get(path.goalId);
      if (!goal) return false;
      const index = this.freeSlotIndex(goal);
      if (index < 0) return false;
      this.releaseSlot(agent);
      this.slotOwnersFor(goal)[index] = agent.id;
      this.goalCounts.set(goal.id, this.goalCount(goal.id) + 1);
      agent.assemblySlotIndex = index;
      agent.assemblySlot = slotForGoal(goal, index, this.config.crowdBehavior);
    }
    this.leaveCurrentQueue(agent);
    const previousSignature = agent.route.edgeIds.slice(agent.edgeIndex).join("|");
    if (previousSignature) agent.abandonedRoutes.set(previousSignature, this.time);
    agent.route = path;
    agent.routeSwitches += 1;
    agent.lastSwitchAt = this.time;
    return true;
  }

  private leaveCurrentQueue(agent: RuntimeAgent) {
    if (!agent.queueKey) return;
    leaveQueue(this.edgeQueues.get(agent.queueKey), agent.id);
    agent.queueKey = null;
  }

  /**
   * Simulator A: deliver phone guidance to a person. Older or already handled revisions are
   * ignored (a newer route never gets overwritten by an older one). Applied at the next node.
   */
  deliverPhoneAdvice(agentId: number, advice: { revision: number; nodeIds: string[]; edgeIds: string[]; reason: string | null }) {
    const agent = this.agents[agentId];
    if (!agent || agent.status === "arrived" || agent.status === "incapacitated") return false;
    if (!Number.isSafeInteger(advice.revision) || advice.revision <= 0) return false;
    if (advice.revision <= (agent.phoneRevisionHandled ?? 0) || advice.revision <= (agent.phoneAdvice?.revision ?? 0)) return false;
    if (advice.nodeIds.length < 2 || advice.edgeIds.length !== advice.nodeIds.length - 1) return false;
    agent.phoneAdvice = { ...advice, receivedAt: this.time, nodesSince: 0 };
    return true;
  }

  /** Simulator A: does this person carry a phone (seeded, so the same people every run)? */
  isPhoneHolder(agentId: number, share: number): boolean {
    return seeded01(this.seed, agentId, "phone-holder") < share;
  }

  /** Position of a graph node (for simulated sensors placed at nodes). */
  /**
   * Roleplay simulator: the assembly area a point stands in (its real footprint — the bounding box
   * of the area's standing positions plus 0.8 m — not merely "near the node"), or null.
   */
  assemblyAreaAt(point: Vec3): { nodeId: string } | null {
    const behavior = this.config.crowdBehavior;
    if (!this.assemblyAreaCache || this.assemblyAreaCache.behavior !== behavior) {
      const areas = this.graph.nodes.filter((node) => node.type === "assembly").map((node) => {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        const count = Math.max(1, Math.min(600, node.capacity || 1));
        for (let index = 0; index < count; index += 1) {
          const slot = slotForGoal(node, index, behavior);
          minX = Math.min(minX, slot[0]); maxX = Math.max(maxX, slot[0]); minZ = Math.min(minZ, slot[2]); maxZ = Math.max(maxZ, slot[2]);
        }
        return { nodeId: node.id, minX: minX - 0.8, maxX: maxX + 0.8, minZ: minZ - 0.8, maxZ: maxZ + 0.8, y: node.position[1] };
      });
      this.assemblyAreaCache = { behavior, areas };
    }
    for (const area of this.assemblyAreaCache.areas) {
      if (Math.abs(point[1] - area.y) > 1.5) continue;
      if (point[0] >= area.minX && point[0] <= area.maxX && point[2] >= area.minZ && point[2] <= area.maxZ) return { nodeId: area.nodeId };
    }
    return null;
  }

  /** Roleplay simulator: simulated people (not arrived/incapacitated) within `radius` m on the same level. */
  peopleAround(point: Vec3, radius: number): number {
    let count = 0;
    for (const agent of this.agents) {
      if (agent.status === "arrived" || agent.status === "incapacitated") continue;
      if (Math.abs(agent.position[1] - point[1]) > 1.2) continue;
      if (Math.hypot(agent.position[0] - point[0], agent.position[2] - point[2]) <= radius) count += 1;
    }
    return count;
  }

  /**
   * Simulator adapter: people the simulation counts per passage right now — walking on it plus
   * crowding/queueing at its entrance. Ground truth of the model, not a measurement.
   */
  passageCrowd(): Map<string, number> {
    const crowd = new Map(this.activeEdgeCountsCache);
    this.edgeQueues.forEach((queue) => { if (queue.waiting.length) crowd.set(queue.edgeId, Math.max(crowd.get(queue.edgeId) ?? 0, queue.waiting.length)); });
    return crowd;
  }

  /** Simulator adapter: modelled fire/smoke/heat on a passage at `offset` s from now (ground truth). */
  passageHazard(edgeId: string, offset = 0) {
    return edgeRiskSnapshot(this.graph, edgeId, this.fires, this.time + offset, this.nodeMap, this.edgeMap);
  }

  nodePosition(nodeId: string): Vec3 | null {
    return this.nodeMap.get(nodeId)?.position ?? null;
  }

  /** Last confirmed graph node; this simulator does not claim continuous indoor phone tracking. */
  phoneNodeOf(agentId: number): string | null {
    const agent = this.agents[agentId];
    if (!agent) return null;
    if (agent.status === "arrived") return agent.route.goalId;
    // Report the last confirmed node, not the destination of an unfinished edge. Otherwise
    // the backend would count someone as arrived while they are still crossing the field.
    return agent.route.nodeIds[agent.edgeIndex] ?? null;
  }

  /**
   * At a decision point: take the phone's route from here if this person follows it. Compliance is
   * a personal, seeded roll per route revision. Returns true if the route changed.
   */
  private applyPhoneAdvice(agent: RuntimeAgent, currentNodeId: string): boolean {
    const advice = agent.phoneAdvice;
    if (!advice) return false;
    const at = advice.nodeIds.indexOf(currentNodeId);
    if (at < 0) {
      // Not on the advised route (the advice was for a node just passed): wait a couple of nodes
      // for the backend to re-plan from the new position, then drop it.
      advice.nodesSince += 1;
      if (advice.nodesSince > 3) { agent.phoneRevisionHandled = advice.revision; agent.phoneAdvice = undefined; }
      return false;
    }
    agent.phoneAdvice = undefined;
    agent.phoneRevisionHandled = advice.revision;
    const nodeIds = advice.nodeIds.slice(at);
    const edgeIds = advice.edgeIds.slice(at);
    if (edgeIds.join("|") === agent.route.edgeIds.slice(agent.edgeIndex).join("|")) return false;
    const follows = seeded01(this.seed, agent.id * 7919 + advice.revision, "phone-compliance") < this.phoneCompliance;
    if (!follows) { this.phoneIgnored += 1; return false; }
    let distance = 0;
    for (const edgeId of edgeIds) distance += this.edgeMap.get(edgeId)?.distance ?? 0;
    const path: RoutePath = {
      nodeIds, edgeIds, distance, estimatedTime: distance / Math.max(0.3, agent.speed), risk: 0, congestion: 0, totalCost: distance,
      bottleneckCapacity: 0, goalId: nodeIds[nodeIds.length - 1],
    };
    if (!routeIsPhysicallyValid(this.graph, path, this.nodeMap, this.edgeMap)) return false;
    // Someone who has seen fire on that way, or knows it is closed, does not walk into it because a phone says so.
    const closures = this.planningClosures(agent);
    if (edgeIds.some((edgeId) => closures.has(edgeId))) { this.phoneIgnored += 1; agent.phoneIgnoredAt = this.time; return false; }
    const known = this.beliefFires(agent);
    if (known.length && this.forecastRouteHazard(agent, edgeIds, known, this.edgeMap).blocked) {
      this.phoneIgnored += 1; agent.phoneIgnoredAt = this.time; return false;
    }
    const via = this.routeViaLabel(path);
    if (!this.commitRoute(agent, path)) return false;
    this.phoneFollowed += 1;
    agent.routeSwitches += 1;
    agent.lastSwitchAt = this.time;
    agent.reason = { code: "follow-phone", at: this.time, params: { to: via, why: advice.reason ?? "" } };
    agent.routeReason = agent.reason;
    return true;
  }

  /** Crowd competitiveness of the current scenario (0 = orderly drill). */
  get competitiveness(): number {
    return COMPETITIVENESS[this.config.crowdBehavior] ?? 0;
  }

  /**
   * How hard this person presses towards the opening right now: being closest counts most, then
   * personal pushiness, stress, and a momentary chance (who happens to find the gap) that changes
   * every 0.8 s. Seeing many hard pushers around makes people push a little more (a small,
   * documented contagion effect — Lügering et al. 2023).
   */
  private pressScore(agent: RuntimeAgent, distanceToOpening: number, pushersAround: number): number {
    const luck = seeded01(this.seed, agent.id * 131 + Math.floor(this.time / 0.8), "mouth-luck");
    const contagion = Math.min(0.2, pushersAround * 0.04);
    return -distanceToOpening * 1.6 + (agent.pushiness + contagion) * 0.9 + agent.stress * 0.5 + luck * 0.7;
  }

  /**
   * Order of the people physically at the mouth of `queue`, best-placed first. Built once per fixed
   * step per opening, so everybody at the same opening is judged against the same snapshot. Also
   * measures the crowd density at the mouth for the crush-risk metric.
   */
  private rankMouth(queue: EdgeQueueState, node: SimNode, mouthRadius: number, atEntrance: (id: number) => boolean, dt: number) {
    const cached = this.mouthRanking.get(queue.key);
    if (cached && cached.time === this.time) return cached;
    const contenders: Array<{ id: number; distance: number }> = [];
    let pushers = 0;
    let inMetre = 0;
    for (const id of queue.waiting) {
      const person = this.agents[id];
      if (!person || !atEntrance(id)) continue;
      const distance = distance3(person.position, node.position);
      contenders.push({ id, distance });
      if (person.pushiness > 0.6) pushers += 1;
      if (distance <= 1) inMetre += 1;
    }
    const scored = contenders.map((entry) => ({ id: entry.id, score: this.pressScore(this.agents[entry.id], entry.distance, pushers) }));
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    // Half-disc of radius 1 m in front of the opening (≈ 1.57 m²).
    const density = inMetre / (Math.PI * 0.5);
    if (density > this.peakMouthDensity) this.peakMouthDensity = density;
    if (density >= DANGEROUS_CROWD_DENSITY) this.dangerousCrowdSeconds += dt;
    const ranking = { time: this.time, order: scored.map((entry) => entry.id), contenders: contenders.length, radius: mouthRadius };
    this.mouthRanking.set(queue.key, ranking);
    return ranking;
  }

  /** Directed admission queue for entering `edge` from `fromNodeId`. */
  private queueFor(edge: SimEdge, fromNodeId: string): EdgeQueueState {
    const key = `${edge.id}|${fromNodeId}`;
    let queue = this.edgeQueues.get(key);
    if (!queue) {
      // Outdoor/assembly lanes are open ground; only real openings become a competitive mouth.
      const open = edge.kind === "outdoor" || edge.kind === "assembly";
      queue = createEdgeQueue(key, edge.id, edge.capacityPerSecond, edge.width, this.time, open ? 0 : this.competitiveness);
      this.edgeQueues.set(key, queue);
      (this.queuesByEdge.get(edge.id) ?? this.queuesByEdge.set(edge.id, []).get(edge.id)!).push(queue);
    }
    return queue;
  }

  /**
   * Rate (people/s) at which a crowd on a passage clears: the passage capacity, or the hydraulic
   * model's maximum specific flow (≈1.1 × free speed × effective width) if that is lower.
   */
  private crowdServiceRate(edge: SimEdge): number {
    const freeSpeed = Math.max(0.3, this.config.walkingSpeed * edge.speedMultiplier);
    return Math.max(0.3, Math.min(edge.capacityPerSecond, 1.1 * freeSpeed * Math.max(0.6, edge.width - 0.3)));
  }

  /**
   * What a person standing at/looking at a passage sees: everyone waiting at its entrance plus the
   * crowd already on it, converted to the seconds it takes that crowd to clear.
   */
  private observedPassageWait(edgeId: string, fromNodeId?: string, excludeId = -1): number {
    const edge = this.edgeMap.get(edgeId);
    if (!edge) return 0;
    let waiting = 0;
    for (const queue of this.queuesByEdge.get(edgeId) ?? []) {
      if (fromNodeId && !queue.key.endsWith(`|${fromNodeId}`)) continue;
      waiting += queue.waiting.length - (excludeId >= 0 && queue.waiting.includes(excludeId) ? 1 : 0);
    }
    const occupants = this.activeEdgeCountsCache.get(edgeId) ?? 0;
    return (waiting + occupants) / this.crowdServiceRate(edge);
  }

  /** Ground-truth expected wait (s) at an edge entry, worst direction. */
  private trueQueueWait(edgeId: string): number {
    const queues = this.queuesByEdge.get(edgeId);
    if (!queues) return 0;
    let wait = 0;
    for (const queue of queues) wait = Math.max(wait, queue.waiting.length ? expectedQueueWait(queue, this.time) : 0);
    return wait;
  }



  pause() { this.running = false; }
  resume() { if (!this.completed && this.agents.length) this.running = true; }

  /**
   * Advance by `seconds` of simulated time using fixed FIXED_SIMULATION_DT steps. Rendering
   * frame rate only changes how many steps run per frame, never their size, so the same seed
   * and scenario produce the same result on fast and slow devices. Returns executed steps.
   */
  advance(seconds: number, maxSteps = Infinity, budgetMs = Infinity): number {
    if (!this.running || this.completed || !Number.isFinite(seconds) || seconds <= 0) return 0;
    this.accumulator += seconds;
    let steps = 0;
    const startedAt = Number.isFinite(budgetMs) ? performance.now() : 0;
    while (this.accumulator >= FIXED_SIMULATION_DT - 1e-9 && steps < maxSteps && this.running && !this.completed
      && (!Number.isFinite(budgetMs) || steps === 0 || performance.now() - startedAt < budgetMs)) {
      this.accumulator -= FIXED_SIMULATION_DT;
      this.stepFixed(FIXED_SIMULATION_DT);
      steps += 1;
    }
    // A slow device simply runs behind real time; it never takes larger physics steps.
    this.accumulator = this.running && !this.completed ? Math.max(0, Math.min(this.accumulator, FIXED_SIMULATION_DT * 4)) : 0;
    return steps;
  }

  /** Compatibility wrapper: advances at most 0.35 s of simulated time, still in fixed steps. */
  step(delta: number) {
    // Invalid frame deltas (NaN, ±Infinity, 0, negative) are ignored, never clamped into a step.
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.advance(Math.min(0.35, delta));
  }

  /** Scenario passages that can be closed (whole stairwells, exits, the B3–B4 bridge). */
  passageGroups(): Array<{ id: string; label: string; edgeIds: string[]; closed: boolean }> {
    const edges = this.graph.edges;
    const groups: Array<{ id: string; label: string; edgeIds: string[] }> = [];
    for (const zone of ["left", "center", "right"] as const) {
      const label = zone === "left" ? "ซ้าย" : zone === "center" ? "กลาง" : "ขวา";
      groups.push({ id: `b1-stair-${zone}`, label: `บันได${label} อาคาร 1`, edgeIds: edges.filter((edge) => edge.id.startsWith(`edge-stair-${zone}-`)).map((edge) => edge.id) });
      groups.push({ id: `b1-exit-${zone}`, label: `ทางออก${label} อาคาร 1`, edgeIds: edges.filter((edge) => edge.id === `edge-${zone}-door-exit`).map((edge) => edge.id) });
    }
    for (const building of [3, 4]) for (const stair of [0, 1]) {
      groups.push({ id: `b${building}-stair-${stair}`, label: `บันได ${stair + 1} อาคาร ${building}`, edgeIds: edges.filter((edge) => edge.id.startsWith(`campus-b${building}-stair-${stair}-down-`)).map((edge) => edge.id) });
      groups.push({ id: `b${building}-exit-${stair}`, label: `ทางออก ${stair + 1} อาคาร ${building}`, edgeIds: edges.filter((edge) => edge.id === `campus-b${building}-exit-door-${stair}`).map((edge) => edge.id) });
    }
    groups.push({ id: "b34-bridge", label: BRIDGE_LABEL_TH, edgeIds: edges.filter((edge) => edge.id === BRIDGE_EDGE_ID).map((edge) => edge.id) });
    return groups.filter((group) => group.edgeIds.length).map((group) => ({ ...group, closed: group.edgeIds.every((edgeId) => this.closedEdges.has(edgeId)) }));
  }

  /** Close or reopen passages (world truth). People learn about it only by seeing or being told. */
  setPassageClosed(edgeIds: string | string[], closed: boolean) {
    const ids = (Array.isArray(edgeIds) ? edgeIds : [edgeIds]).filter((edgeId) => this.graph.edges.some((edge) => edge.id === edgeId));
    let changed = 0;
    for (const edgeId of ids) {
      if (closed && !this.closedEdges.has(edgeId)) { this.closedEdges.add(edgeId); changed += 1; }
      if (!closed && this.closedEdges.delete(edgeId)) changed += 1;
    }
    if (!changed) return 0;
    // Stale closure reports must not outlive the closure itself.
    if (!closed) [...this.closureReports.keys()].forEach((key) => { if (ids.includes(key.split("@")[0])) this.closureReports.delete(key); });
    this.reroutePathCache.clear();
    this.pushEvent(closed ? "warning" : "info", closed ? "ปิดทาง" : "เปิดทางกลับมา", `${ids.length} ช่วงทาง · คนจะรู้เมื่อเห็นหรือได้รับแจ้ง`);
    return changed;
  }

  setPassageGroupClosed(groupId: string, closed: boolean) {
    const group = this.passageGroups().find((item) => item.id === groupId);
    return group ? this.setPassageClosed(group.edgeIds, closed) : 0;
  }

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
    // Attach to an object of the building the fire is actually in (never across to a
    // neighbouring building that happens to share the same floor number).
    const building = campusBuildingAt(position)?.id ?? "building-1";
    for (const node of this.graph.nodes) {
      if (node.floor !== floor || !isFireAttachmentNode(node) || nodeBuilding(node) !== building) continue;
      const distance = distance3(position, node.position);
      if (distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  addFire(position: Vec3, options: Partial<FireSource> = {}): FireSource {
    if (!Array.isArray(position) || position.length !== 3 || !position.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new RangeError("Fire position must contain three finite numbers");
    }
    const rawWing = classifyWing(position);
    const outside = rawWing === "outdoor" || rawWing === "assembly" || position[2] > 65;
    const floor = outside ? 0 : floorFromY(position[1],position);
    const snapped: Vec3 = outside
      ? [position[0], Math.max(0.18, position[1]), position[2]]
      : [position[0], campusBuildingAt(position) ? BLOCK_LEVELS[floor-1]+.01 : floorBase(floor) + SLAB_THICKNESS + .01, position[2]];
    const attachment = options.attachmentNodeId
      ? this.graph.nodes.find((node): node is FireAttachmentNode => node.id === options.attachmentNodeId && isFireAttachmentNode(node))
      : this.nearestFireAttachment(snapped, floor);
    const fire: FireSource = {
      // Deterministic ids: fire ids feed seeded report delays, so wall-clock ids would make
      // identical scenarios diverge.
      id: `fire-${++this.fireSequence}`,
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
      ...(options.sourceMarkerId ? { sourceMarkerId: options.sourceMarkerId } : {}),
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
    this.forgetFires(new Set([id]));
  }

  clearFires() {
    const ids = new Set(this.fires.map((fire) => fire.id));
    this.fires = [];
    this.fireTransmissionLedger.clear();
    this.forgetFires(ids);
    this.pushEvent("info", "ล้างจุดไฟ", "ลบ Fire Source ทั้งหมดออกจาก Scenario แล้ว");
  }

  /** A removed fire must not survive in anyone's memory, report queue or planning cache. */
  private forgetFires(ids: Set<string>) {
    if (!ids.size) return;
    for (const agent of this.agents) {
      ids.forEach((id) => { agent.knownFireIds.delete(id); agent.fireKnowledge.delete(id); });
      agent.cachedPerceivedFires = agent.cachedPerceivedFires.filter((fire) => !ids.has(fire.id));
      if (!agent.fireKnowledge.size) { agent.smokeAwareness = "none"; agent.heatAwareness = "none"; }
    }
    [...this.hazardReports.keys()].forEach((key) => { if (ids.has(key.split("@")[0])) this.hazardReports.delete(key); });
    this.beliefFireCache.clear();
    this.reroutePathCache.clear();
  }

  addPresetFire(preset: "left" | "center" | "right") {
    const positions: Record<typeof preset, Vec3> = {
      left: [-43, walkY(5) + 0.25, -3.5],
      center: [2.75, walkY(4) + 0.25, 1.8],
      right: [3.3, walkY(6) + 0.25, 45],
    };
    return this.addFire(positions[preset]);
  }

  /** Planning view of the hazards one person knows about — never the full world state. */
  private knownFireSources(agent: RuntimeAgent): FireSource[] {
    return this.beliefFires(agent);
  }

  private beliefFires(agent: RuntimeAgent): FireSource[] {
    if (!agent.fireKnowledge.size) return [];
    const result: FireSource[] = [];
    agent.fireKnowledge.forEach((belief, fireId) => {
      const fire = this.fires.find((candidate) => candidate.id === fireId);
      if (!fire || !fire.enabled) return;
      // Second-hand reports expire; what a person saw themselves stays remembered.
      if (belief.source === "reported" && !belief.controller && this.time - belief.observedAt > REPORT_LIFETIME_SECONDS) return;
      result.push(this.beliefFire(fire, belief));
    });
    return result;
  }

  /**
   * A fire *as believed*: its state at the last observation (growth since then is unknown, but the
   * standard growth curve is assumed forward from there), and for anything not seen directly a
   * displaced position with a wider smoke/caution cue (never an inflated solid flame).
   * Shared between people with the same
   * information so route caches stay effective.
   */
  private beliefFire(fire: FireSource, belief: FireBelief): FireSource {
    if (belief.controller) return fire;
    const staleness = Math.max(0, Math.round((this.time - belief.observedAt) * 2) / 2);
    const exact = belief.source === "direct";
    const key = `${fire.id}|${belief.source}|${staleness}|${exact ? "" : belief.believedPosition.map((value) => value.toFixed(1)).join(",")}|${belief.uncertainty.toFixed(1)}`;
    const cached = this.beliefFireCache.get(key);
    if (cached) return cached;
    const shifted: FireSource = {
      ...fire,
      startTime: fire.startTime + staleness,
      spreadTravelStartTime: fire.spreadTravelStartTime == null ? undefined : fire.spreadTravelStartTime + staleness,
      position: exact ? fire.position : [...belief.believedPosition] as Vec3,
      // Uncertain location increases caution/smoke reach, not the solid burning area.
      // Inflating it by 2–4 m invented flames across a clear classroom doorway and
      // prevented the person from approaching far enough to inspect the real opening.
      fireRadius: fire.fireRadius,
      smokeRadius: fire.smokeRadius + (exact ? 0 : belief.uncertainty),
      spreadPath: exact ? fire.spreadPath : undefined,
    };
    if (this.beliefFireCache.size > 4000) this.beliefFireCache.clear();
    this.beliefFireCache.set(key, shifted);
    return shifted;
  }

  private raiseAwareness(agent: RuntimeAgent, source: AwarenessSource) {
    const rank: Record<AwarenessSource, number> = { none: 0, alarm: 1, "others-leaving": 2, controller: 3, report: 3, smoke: 4, heat: 5, flame: 6 };
    if (rank[source] <= rank[agent.awareness]) return;
    agent.awareness = source;
    if (agent.awareAt == null) agent.awareAt = this.time;
  }

  private rememberFire(agent: RuntimeAgent, fire: FireSource, source: Exclude<HazardAwareness, "none">, controller = false) {
    const previous = agent.fireKnowledge.get(fire.id);
    const sourceRank: Record<Exclude<HazardAwareness, "none">, number> = { reported: 1, smoke: 2, heat: 3, direct: 4 };
    const localSense = source !== "reported";
    if (previous) {
      // Sensing the hazard again refreshes the belief; hearing a report again refreshes only hearsay.
      if (localSense || previous.source === "reported") previous.observedAt = this.time;
      if (sourceRank[previous.source] >= sourceRank[source] && !(controller && !previous.controller)) return;
    }
    const zoneSalt = reportZoneOf(this.nodeMap.get(agent.currentNodeId)) ?? "site";
    const uncertainty = controller || source === "direct" ? 0 : source === "heat" ? 1 : source === "smoke" ? 2 : 4;
    // Shared by everyone who learned it the same way in the same zone (same report, same smoke).
    const angle = seeded01(this.seed, hashString(fire.id), `${source}:${zoneSalt}`) * Math.PI * 2;
    const offset = uncertainty * 0.6;
    const believedPosition: Vec3 = [
      fire.position[0] + Math.cos(angle) * offset,
      fire.position[1],
      fire.position[2] + Math.sin(angle) * offset,
    ];
    agent.knownFireIds.add(fire.id);
    agent.fireKnowledge.set(fire.id, {
      source, learnedAt: previous?.learnedAt ?? this.time, observedAt: this.time, believedPosition,
      confidence: controller || source === "direct" ? 1 : source === "heat" ? 0.85 : source === "smoke" ? 0.7 : 0.55,
      uncertainty, controller: controller || Boolean(previous?.controller),
    });
    this.raiseAwareness(agent, controller ? "controller" : source === "direct" ? "flame" : source === "heat" ? "heat" : source === "smoke" ? "smoke" : "report");
    if (source === "direct" || source === "smoke" || source === "heat") {
      agent.decisionState = "assessing";
      const sensoryLatency = source === "direct" ? agent.decisionLatency : source === "heat" ? agent.decisionLatency * 0.72 : agent.decisionLatency * 1.25;
      agent.responseDelay = Math.min(agent.responseDelay, this.time + sensoryLatency);
    } else {
      // A warning does not reveal an exact flame position, but it shortens hesitation and
      // triggers a fresh route assessment.
      agent.decisionState = "assessing";
      agent.responseDelay = Math.min(agent.responseDelay, this.time + Math.max(0.65, agent.decisionLatency * 0.8));
    }
    agent.nextDecisionAt = Math.min(agent.nextDecisionAt, this.time + agent.decisionLatency);
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
   * A discovery is shouted to people in the same building wing/floor first, then to the other
   * wings of that floor and the floors directly above/below (and across the B3–B4 bridge on
   * floor 4). It never reaches another building's occupants through walls.
   */
  private scheduleHazardReports(agent: RuntimeAgent, fire: FireSource) {
    const zone = reportZoneOf(this.nodeMap.get(agent.currentNodeId));
    if (!zone) return;
    const key = `${fire.id}@${zone}`;
    if (this.hazardReports.has(key)) return;
    const localDelay = 0.8 + seeded01(this.seed, agent.id, `report:${fire.id}`) * 1.4 + (1 - agent.familiarity) * 0.45;
    this.hazardReports.set(key, this.time + localDelay);
    if (this.hazardReports.size <= 24) {
      this.pushEvent("warning", "Local fire discovery", `มีผู้พบไฟ/ควันที่ ${zone.replace("building-", "อาคาร ").replace(/:(\d+):/, " ชั้น $1 · ")} และเริ่มแจ้งเตือนคนบริเวณเดียวกัน`);
    }
    for (const neighbour of neighbouringReportZones(zone)) {
      const neighbourKey = `${fire.id}@${neighbour.zone}`;
      if (this.hazardReports.has(neighbourKey)) continue;
      const jitter = seeded01(this.seed, hashString(neighbour.zone), `report-spread:${fire.id}`) * 0.9;
      this.hazardReports.set(neighbourKey, this.time + localDelay + neighbour.delay + jitter);
    }
  }

  private agentSpaceKeys(agent: RuntimeAgent): string[] {
    const topology = this.perception;
    if (!topology) return [];
    if (agent.hasExitedBuilding) return ["site"];
    const keys: string[] = [];
    const current = topology.space.get(agent.currentNodeId)?.key;
    if (current) keys.push(current);
    if (agent.edgeEntered) {
      const next = topology.space.get(agent.route.nodeIds[agent.edgeIndex + 1])?.key;
      if (next && next !== current) keys.push(next);
    }
    return keys;
  }

  /** Approximate line of sight from a person to a graph node (see agentPerception.ts). */
  private nodeVisible(agent: RuntimeAgent, nodeId: string, maxDistance: number, spaces = this.agentSpaceKeys(agent)): boolean {
    const topology = this.perception;
    const node = this.nodeMap.get(nodeId);
    if (!topology || !node) return false;
    const target = topology.space.get(nodeId)?.key;
    if (!spaces.some((space) => spacesInView(topology, space, target))) return false;
    return Math.hypot(node.position[0] - agent.position[0], node.position[2] - agent.position[2]) <= maxDistance
      && Math.abs(node.position[1] - agent.position[1]) < 2.6;
  }

  private fireSpaceKeys(fire: FireSource): string[] {
    const topology = this.perception;
    if (!topology) return [];
    if (fire.floor === 0 || fire.wing === "outdoor" || fire.wing === "assembly") return ["site"];
    const keys = new Set<string>();
    const own = fire.attachmentNodeId ? topology.space.get(fire.attachmentNodeId)?.key : undefined;
    if (own) keys.add(own);
    // A travelling front is visible along the passage it is crossing (parent object's space).
    const parent = fire.parentId ? this.fires.find((candidate) => candidate.id === fire.parentId) : undefined;
    const parentSpace = parent?.attachmentNodeId ? topology.space.get(parent.attachmentNodeId)?.key : undefined;
    if (parentSpace) keys.add(parentSpace);
    return [...keys];
  }

  private fireBuilding(fire: FireSource) {
    if (fire.floor === 0 || fire.wing === "outdoor" || fire.wing === "assembly") return "site";
    const node = fire.attachmentNodeId ? this.nodeMap.get(fire.attachmentNodeId) : undefined;
    return node ? nodeBuilding(node) : campusBuildingAt(fire.position)?.id ?? "building-1";
  }

  /**
   * Buildings whose floor a fire is physically on. A fire on a link between buildings (the
   * straight B3–B4 bridge on floor 4) is on both decks it joins: people at either end can see it
   * along the bridge and smell its smoke, but nobody in a third building can.
   */
  private fireBuildings(fire: FireSource): string[] {
    const fast = this.fireBuildingsFast.get(fire);
    if (fast && fast.id === fire.id && fast.x === fire.position[0] && fast.y === fire.position[1] && fast.z === fire.position[2]) return fast.value;
    const value = this.fireBuildingsSlow(fire);
    this.fireBuildingsFast.set(fire, { id: fire.id, x: fire.position[0], y: fire.position[1], z: fire.position[2], value });
    return value;
  }

  private fireBuildingsSlow(fire: FireSource): string[] {
    const cacheKey = `${fire.id}@${fire.position.join(",")}`;
    const cached = this.fireBuildingsCache.get(cacheKey);
    if (cached) return cached;
    const resolved = this.resolveFireBuildings(fire);
    this.fireBuildingsCache.set(cacheKey, resolved);
    return resolved;
  }

  private resolveFireBuildings(fire: FireSource): string[] {
    const primary = this.fireBuilding(fire);
    if (primary === "site") return [primary];
    const result = new Set<string>([primary]);
    for (const edge of this.graph.edges) {
      const from = this.nodeMap.get(edge.from);
      const to = this.nodeMap.get(edge.to);
      if (!from || !to) continue;
      const a = nodeBuilding(from), b = nodeBuilding(to);
      if (a === b || a === "site" || b === "site") continue;
      if (Math.abs(fire.position[1] - from.position[1]) > 1.5) continue;
      const dx = to.position[0] - from.position[0], dz = to.position[2] - from.position[2];
      const lengthSq = dx * dx + dz * dz;
      if (lengthSq < 1e-6) continue;
      const t = ((fire.position[0] - from.position[0]) * dx + (fire.position[2] - from.position[2]) * dz) / lengthSq;
      if (t < 0 || t > 1) continue;
      const px = from.position[0] + dx * t, pz = from.position[2] + dz * t;
      if (Math.hypot(fire.position[0] - px, fire.position[2] - pz) > edge.width / 2 + 0.3) continue;
      result.add(a);
      result.add(b);
    }
    return [...result];
  }

  /** Flame cells, the floors they are on, and the spaces they are visible from — once per fire per step. */
  private fireInfoAt(fire: FireSource) {
    const info = this.fireStepInfo.get(fire);
    if (info && info.time === this.time && info.attach === fire.attachmentNodeId && info.parentId === fire.parentId) return info;
    const cells = flameCellsAt(fire, this.time);
    const next = { time: this.time, attach: fire.attachmentNodeId, parentId: fire.parentId, cells, floors: new Set(cells.map((cell) => cell.floor)), spaces: this.fireSpaceKeys(fire) };
    this.fireStepInfo.set(fire, next);
    return next;
  }

  private agentBuilding(agent: RuntimeAgent) {
    return agent.hasExitedBuilding ? "site" : nodeBuilding(this.nodeMap.get(agent.currentNodeId));
  }

  private updateFireAwareness(agent: RuntimeAgent, totalLocalRisk = pointRisk(agent.position, this.fires, this.time)): FireSource[] {
    agent.perceivedSmoke = Math.max(0, Math.min(1, totalLocalRisk.smoke * agent.smokeSensitivity));
    agent.perceivedHeat = Math.max(0, Math.min(1, totalLocalRisk.heat * agent.heatSensitivity));
    agent.visibility = Math.max(0.12, Math.min(1, 1 - totalLocalRisk.smoke * (0.66 + agent.smokeSensitivity * 0.16)));
    const anyReport = [...agent.fireKnowledge.values()].some((knowledge) => knowledge.source === "reported");
    agent.smokeAwareness = anyReport ? "reported" : "none";
    agent.heatAwareness = anyReport ? "reported" : "none";
    const topology = this.perception;
    const spaces = this.agentSpaceKeys(agent);
    const building = this.agentBuilding(agent);
    const zone = reportZoneOf(this.nodeMap.get(agent.currentNodeId));
    const coordinated = this.decisionMode === "coordinated";
    for (const fire of this.fires) {
      if (!fireHasStarted(fire, this.time)) continue;
      if (coordinated && this.time >= fire.startTime + CONTROLLER_DETECTION_SECONDS && !agent.fireKnowledge.get(fire.id)?.controller) {
        this.rememberFire(agent, fire, "reported", true);
      }
      const fireBuildings = this.fireBuildings(fire);
      const outdoorFire = fireBuildings[0] === "site";
      const info = this.fireInfoAt(fire);
      const visibleCells = info.cells;
      // Smoke and heat cues travel only inside the same building and floor (or open air).
      const sameFloor = outdoorFire
        ? building === "site" || agent.floor <= 1
        : fireBuildings.includes(building) && info.floors.has(agent.floor);
      const localRisk = sameFloor ? pointRisk(agent.position, [fire], this.time) : { fire: 0, smoke: 0, heat: 0, blocked: false };
      const smokeSignal = localRisk.smoke * agent.smokeSensitivity;
      const heatSignal = localRisk.heat * agent.heatSensitivity;
      const smelledSmoke = sameFloor && smokeSignal >= agent.smokeDetectionThreshold;
      const visibleSmoke = sameFloor && smokeSignal >= agent.smokeDetectionThreshold * 2.15;
      const sensedHeat = sameFloor && heatSignal >= agent.heatDetectionThreshold;
      const painfulHeat = sameFloor && heatSignal >= agent.heatDetectionThreshold * 3.1;
      const flameSightRange = Math.max(4.5, Math.min(10.5, fireRadiusAt(fire, this.time) + 4.5)) * Math.max(0.45, agent.visibility);
      const fireSpaces = info.spaces;
      // Cheap tests first; the nearest-flame distance is only needed when the rest already hold.
      const directlySawFlame = sameFloor && localRisk.fire > 0.025
        && Boolean(topology) && spaces.some((space) => fireSpaces.some((target) => spacesInView(topology!, space, target)))
        && visibleCells.reduce((nearest, cell) => Math.min(nearest, Math.hypot(cell.position[0] - agent.position[0], cell.position[2] - agent.position[2])), Infinity) <= flameSightRange;
      const previousKnowledge = agent.fireKnowledge.get(fire.id);
      // Approximate smoke reaching the immediately connected landing above a burning stair.
      // This is a local cue, not global knowledge of fires on other floors: require the actual
      // stair edge and a short propagation delay, then use the normal report and routing logic.
      const landing = this.nodeMap.get(agent.currentNodeId);
      const fireLanding = fire.attachmentNodeId ? this.nodeMap.get(fire.attachmentNodeId) : undefined;
      const stairSmoke = landing?.type === "stair" && fireLanding?.type === "stair"
        && landing.floor === fireLanding.floor + 1 && fireBuildings.includes(building)
        && this.time >= fire.startTime + 8
        && Math.hypot(agent.position[0] - landing.position[0], agent.position[2] - landing.position[2]) <= 4
        && this.graph.edges.some(edge => edge.kind === "stair"
          && ((edge.from === landing.id && edge.to === fireLanding.id) || (edge.to === landing.id && edge.from === fireLanding.id)));
      const locallyDiscovered = directlySawFlame || smelledSmoke || visibleSmoke || sensedHeat || stairSmoke;

      if (directlySawFlame) this.rememberFire(agent, fire, "direct");
      else if (sensedHeat) this.rememberFire(agent, fire, "heat");
      else if (smelledSmoke || visibleSmoke || stairSmoke) this.rememberFire(agent, fire, "smoke");
      if (visibleSmoke) agent.smokeAwareness = "visible";
      else if ((smelledSmoke || stairSmoke) && agent.smokeAwareness !== "visible") agent.smokeAwareness = "smelled";
      if (painfulHeat) agent.heatAwareness = "painful";
      else if (sensedHeat && agent.heatAwareness !== "painful") agent.heatAwareness = "sensed";

      if (locallyDiscovered) {
        this.scheduleHazardReports(agent, fire);
      } else if (zone && (!previousKnowledge || previousKnowledge.source === "reported")) {
        const reportedAt = this.hazardReports.get(`${fire.id}@${zone}`);
        if (reportedAt != null && this.time >= reportedAt && this.time - reportedAt <= REPORT_LIFETIME_SECONDS) {
          this.rememberFire(agent, fire, "reported");
          if (agent.smokeAwareness === "none") agent.smokeAwareness = "reported";
          if (agent.heatAwareness === "none") agent.heatAwareness = "reported";
        }
      }
    }
    return this.knownFireSources(agent);
  }

  /** Learn closed/reopened passages that are actually in view, or that were reported nearby. */
  private perceiveClosures(agent: RuntimeAgent) {
    if (this.decisionMode === "coordinated") {
      // The controller monitors every passage and broadcasts changes immediately.
      agent.knownClosed.forEach((_at, edgeId) => { if (!this.closedEdges.has(edgeId)) agent.knownClosed.delete(edgeId); });
      this.closedEdges.forEach((edgeId) => { if (!agent.knownClosed.has(edgeId)) agent.knownClosed.set(edgeId, this.time); });
      return;
    }
    if (!this.closedEdges.size && !agent.knownClosed.size) return;
    const spaces = this.agentSpaceKeys(agent);
    const limit = Math.min(agent.route.edgeIds.length, agent.edgeIndex + 6);
    for (let index = agent.edgeIndex; index < limit; index += 1) {
      const edgeId = agent.route.edgeIds[index];
      if (!this.closedEdges.has(edgeId) || agent.knownClosed.has(edgeId)) continue;
      if (this.nodeVisible(agent, agent.route.nodeIds[index], 12, spaces)) this.learnClosure(agent, edgeId, true);
    }
    agent.knownClosed.forEach((_at, edgeId) => {
      if (this.closedEdges.has(edgeId)) return;
      const edge = this.edgeMap.get(edgeId);
      if (edge && (this.nodeVisible(agent, edge.from, 12, spaces) || this.nodeVisible(agent, edge.to, 12, spaces))) agent.knownClosed.delete(edgeId);
    });
    const zone = reportZoneOf(this.nodeMap.get(agent.currentNodeId));
    if (!zone || !this.closureReports.size) return;
    this.closedEdges.forEach((edgeId) => {
      if (agent.knownClosed.has(edgeId)) return;
      const reportedAt = this.closureReports.get(`${edgeId}@${zone}`);
      if (reportedAt != null && this.time >= reportedAt && this.time - reportedAt <= REPORT_LIFETIME_SECONDS) this.learnClosure(agent, edgeId, false);
    });
  }

  private learnClosure(agent: RuntimeAgent, edgeId: string, seen: boolean) {
    agent.knownClosed.set(edgeId, this.time);
    if (agent.route.edgeIds.indexOf(edgeId, agent.edgeIndex) >= 0) agent.nextDecisionAt = this.time;
    if (!seen) return;
    const zone = reportZoneOf(this.nodeMap.get(agent.currentNodeId));
    if (!zone || this.closureReports.has(`${edgeId}@${zone}`)) return;
    const delay = 1 + seeded01(this.seed, agent.id, `closure:${edgeId}`) * 1.5;
    this.closureReports.set(`${edgeId}@${zone}`, this.time + delay);
    for (const neighbour of neighbouringReportZones(zone)) {
      const key = `${edgeId}@${neighbour.zone}`;
      if (!this.closureReports.has(key)) this.closureReports.set(key, this.time + delay + neighbour.delay);
    }
  }

  /**
   * Queue information a person can actually have: queues in view now (recorded into memory) plus
   * fading memories of queues seen earlier. Values are people-equivalents per edge, matching the
   * `reserved` semantics of the graph planner (load / capacity = seconds of waiting).
   */
  private perceivedReserved(agent: RuntimeAgent): Map<string, number> {
    // What a person sees of the queues changes slowly; reuse it for 0.5 s of simulated time.
    if (agent.reservedCache && this.time - agent.reservedCache.at < 0.5) return agent.reservedCache.value;
    const result = new Map<string, number>();
    agent.reservedCache = { at: this.time, value: result };
    agent.queueMemory.forEach((observation, edgeId) => {
      const age = this.time - observation.at;
      if (age > QUEUE_MEMORY_SECONDS) { agent.queueMemory.delete(edgeId); return; }
      const edge = this.edgeMap.get(edgeId);
      if (edge && observation.wait > 0) result.set(edgeId, observation.wait * edge.capacityPerSecond * Math.exp(-age / 25));
    });
    const spaces = this.agentSpaceKeys(agent);
    const observe = (edgeId: string) => {
      const edge = this.edgeMap.get(edgeId);
      if (!edge || !(this.nodeVisible(agent, edge.from, 20, spaces) || this.nodeVisible(agent, edge.to, 20, spaces))) return;
      const wait = this.observedPassageWait(edgeId);
      agent.queueMemory.set(edgeId, { wait, at: this.time });
      if (wait > 0.5) result.set(edgeId, wait * edge.capacityPerSecond);
      else result.delete(edgeId);
    };
    const seen = new Set<string>();
    this.queuesByEdge.forEach((queues, edgeId) => { if (queues.some((queue) => queue.waiting.length)) { seen.add(edgeId); observe(edgeId); } });
    this.activeEdgeCountsCache.forEach((count, edgeId) => { if (count >= 3 && !seen.has(edgeId)) observe(edgeId); });
    return result;
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
    // Waiting positions lie on the incoming passage (a corridor, or a stair flight above a
    // landing). Walk the rest of that passage to the entrance first instead of a straight chord
    // that could cut a corner or cross a stair void.
    agent.approachEdge = undefined;
    agent.approachPath = undefined;
    let approach: Vec3[] | null = null;
    const incoming = this.incomingPassage(agent);
    const incomingEdge = incoming?.edge;
    if (!corridorContinuation && !midOutdoorReroute && !openPortalContinuation && incoming && incomingEdge && currentNode
      && distance3(agent.position, currentNode.position) > 0.3) {
      const incomingPath = traversalPoints(incomingEdge, nodeMap, incoming.fromId, currentNodeId);
      if (incomingPath.length >= 2) {
        const projection = closestPointOnPolyline(agent.position, incomingPath);
        if (projection.distance <= walkableHalfWidth(incomingEdge) + 0.3) {
          approach = [[...agent.position] as Vec3];
          // A safe point on one side of a concave stair apron cannot necessarily see
          // the next vertex. Rejoin through an orthogonal elbow inside the *same*
          // verified envelope, instead of drawing a chord across the stair void.
          const nextState = segmentStateAtDistance(incomingPath, projection.distanceAlong + 1e-6);
          const nextVertex = incomingPath[Math.min(incomingPath.length - 1, nextState.segmentIndex + 1)];
          if (!chordClear(agent.position, nextVertex, incomingPath, incomingEdge)) {
            const rejoin = projection.point;
            if (chordClear(agent.position, rejoin, incomingPath, incomingEdge)) approach.push(rejoin);
            else {
              const elbows: Vec3[] = [[agent.position[0], rejoin[1], rejoin[2]], [rejoin[0], rejoin[1], agent.position[2]]];
              const elbow = elbows.find(point => chordClear(agent.position, point, incomingPath, incomingEdge) && chordClear(point, rejoin, incomingPath, incomingEdge));
              if (elbow) approach.push(elbow, rejoin);
              else return false;
            }
          }
          let travelled = 0;
          for (let index = 1; index < incomingPath.length; index += 1) {
            travelled += distance3(incomingPath[index - 1], incomingPath[index]);
            if (travelled > projection.distanceAlong + 0.05) approach.push(incomingPath[index]);
          }
          agent.approachEdge = incomingEdge;
          agent.approachPath = incomingPath;
        }
      }
    }
    // The corridor node is a cross-section, not a compulsory point on the centerline. Retain
    // the original physical envelope when continuing from the safe side of a burning node.
    // Someone who is already standing a little way *into* the next passage (e.g. at a junction
    // cross-section) continues forward from there instead of stepping back to the node first.
    let forwardStart: Vec3[] | null = null;
    if (!corridorContinuation && !midOutdoorReroute && !openPortalContinuation && currentNode
      && distance3(agent.position, currentNode.position) > 0.05 && pointInsideWalkableCorridor(agent.position, traversed, edge)) {
      const along = closestPointOnPolyline(agent.position, traversed).distanceAlong;
      if (along > 0.05) {
        let travelled = 0;
        forwardStart = [[...agent.position] as Vec3];
        for (let index = 1; index < traversed.length; index += 1) {
          travelled += distance3(traversed[index - 1], traversed[index]);
          if (travelled > along + 0.05) forwardStart.push(traversed[index]);
        }
        if (forwardStart.length < 2 || !chordClear(agent.position, forwardStart[1], traversed, edge)) forwardStart = null;
      }
    }
    if (forwardStart) { approach = null; agent.approachEdge = undefined; agent.approachPath = undefined; }
    const approachPoints = approach ? dedupePoints(approach) : null;
    agent.approachSegments = approachPoints ? approachPoints.length - 1 : 0;
    const points = dedupePoints(corridorContinuation ? traversed : forwardStart ?? (approachPoints ? [...approachPoints, ...traversed.slice(1)] : reroutePoints));
    if (edge.kind === "assembly" && nodeMap.get(nextNodeId)?.type === "assembly") points[points.length - 1] = [...agent.assemblySlot] as Vec3;
    agent.edgePath = points;
    agent.detourPath = [];
    agent.detourIndex = 0;
    agent.lastDetourPlanAt = -Infinity;
    agent.detourExitSide = false;
    this.pendingDetourAgents.delete(agent.id);
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.edgeEntered = true;
    agent.bodyLateralOffset = 0;
    agent.retreating = false;
    agent.retreatNodeId = undefined;
    agent.retreatEdge = undefined;
    agent.status = "evacuating";
    agent.decisionState = agent.knownFireIds.size ? "assessing" : "following-plan";
    if (edge.kind === "stair") agent.phase = "stair";
    else if (edge.kind === "outdoor") { agent.phase = "outdoor"; agent.wing = "outdoor"; agent.floor = 0; }
    else if (edge.kind === "assembly") {
      const finalApproach=nodeMap.get(nextNodeId)?.type==="assembly";
      agent.phase=finalApproach?"assembly":"outdoor";agent.wing=finalApproach?"assembly":"outdoor";agent.floor=0;
    }
    return true;
  }

  /**
   * Does the way ahead lead *out* of the smoke/heat? Walks the rest of this edge and up to
   * SMOKE_EXIT_EDGES further route edges (at most SMOKE_EXIT_HORIZON_M), perceived fires only,
   * 2 s ahead. True when a clean spot (or clearly cleaner air) is reached before the horizon and
   * no sample on the way is in flame, at/above the heat-avoid temperature, or in dense smoke.
   * This is the same limit the planner uses, so the step rule and the plan no longer disagree.
   */
  private smokeExitAhead(agent: RuntimeAgent, edge: SimEdge, fires: FireSource[], nodeMap: Map<string, SimNode>, edgeMap: Map<string, SimEdge>): boolean {
    if (!fires.length || agent.edgePath.length < 2) return false;
    const cached = agent.smokeExitCache;
    if (cached && cached.edgeId === edge.id && cached.segment === agent.segmentIndex && this.time - cached.at < 1) return cached.ok;
    const at = this.time + 2;
    const ambient = this.config.ambientTemperatureC ?? 29;
    const heatLimit = this.config.heatAvoidThresholdC ?? 44;
    const path: Vec3[] = [[...agent.position] as Vec3, ...agent.edgePath.slice(agent.segmentIndex + 1)];
    for (let k = 1; k <= SMOKE_EXIT_EDGES; k += 1) {
      const nextEdge = edgeMap.get(agent.route.edgeIds[agent.edgeIndex + k]);
      if (!nextEdge) break;
      const following = traversalPoints(nextEdge, nodeMap, agent.route.nodeIds[agent.edgeIndex + k], agent.route.nodeIds[agent.edgeIndex + k + 1]);
      path.push(...following.slice(1));
    }
    const here = pointRisk(agent.position, fires, at);
    const hereTemp = modeledTemperatureFromHeat(here.heat, ambient);
    let peakSmoke = here.smoke;
    let end = here;
    let walked = 0;
    let clean = false;
    let ok = true;
    for (let index = 1; index < path.length && ok && !clean && walked < SMOKE_EXIT_HORIZON_M; index += 1) {
      const a = path[index - 1], b = path[index];
      const length = distance3(a, b);
      const steps = Math.max(1, Math.ceil(length / SMOKE_EXIT_SAMPLE_M));
      for (let step = 1; step <= steps; step += 1) {
        const risk = pointRisk(lerp3(a, b, step / steps), fires, at);
        const temp = modeledTemperatureFromHeat(risk.heat, ambient);
        if (risk.blocked || risk.fire > 0.05 || temp >= heatLimit) { ok = false; break; }
        peakSmoke = Math.max(peakSmoke, risk.smoke);
        end = risk;
        walked += length / steps;
        if (risk.smoke <= SMOKE_EXIT_CLEAN && temp <= ambient + 2) { clean = true; break; }
        if (walked >= SMOKE_EXIT_HORIZON_M) break;
      }
    }
    const endTemp = modeledTemperatureFromHeat(end.heat, ambient);
    ok = ok && peakSmoke * agent.smokeSensitivity <= SMOKE_EXIT_PASS_LIMIT
      && (clean || (end.smoke <= Math.min(here.smoke - 0.03, here.smoke * 0.8) && endTemp <= hereTemp + 0.5));
    agent.smokeExitCache = { edgeId: edge.id, segment: agent.segmentIndex, at: this.time, ok };
    return ok;
  }

  private noteHazardStop(agent: RuntimeAgent, edgeId: string, hazard: "smoke" | "heat" | "fire") {
    const log = (agent.hazardStops ??= []);
    log.push({ edgeId, at: this.time, hazard });
    while (log.length && this.time - log[0].at > HAZARD_MEMORY_WINDOW_S) log.shift();
    if (log.length > 24) log.splice(0, log.length - 24);
    // Turned back from the same passage again: plan around it for a while (what a person would do
    // after walking into the same smoke twice), instead of walking down and back up indefinitely.
    if (log.filter((stop) => stop.edgeId === edgeId).length >= HAZARD_MEMORY_REPEAT) {
      (agent.hazardAvoid ??= new Map()).set(edgeId, this.time + HAZARD_AVOID_SECONDS);
    }
  }

  /** Passages this person currently plans around (see noteHazardStop); expired ones are forgotten. */
  private hazardAvoidance(agent: RuntimeAgent): string[] {
    const avoid = agent.hazardAvoid;
    if (!avoid?.size) return [];
    avoid.forEach((until, edgeId) => { if (until <= this.time) avoid.delete(edgeId); });
    return [...avoid.keys()];
  }

  /**
   * The person stopped in front of this same passage several times within the window and the plan
   * sends them to it again: there is no usable way past it right now. Instead of stepping up and
   * back every second (a livelock that looks like movement), hold at the safe point, show why, and
   * reassess at a slower pace. They keep trying; nothing is teleported or counted as arrived.
   */
  private holdIfRepeatingHazardStop(agent: RuntimeAgent) {
    const edgeId = agent.route.edgeIds[agent.edgeIndex];
    const log = agent.hazardStops;
    if (!edgeId || !log) return;
    const recent = log.filter((stop) => stop.edgeId === edgeId && this.time - stop.at <= HAZARD_STOP_WINDOW_S);
    if (recent.length < HAZARD_STOP_REPEAT) return;
    const hazard = recent[recent.length - 1].hazard;
    agent.status = "blocked";
    agent.decisionState = "safe-stop";
    agent.edgeEntered = false;
    agent.noRouteRetryAt = this.time + HAZARD_HOLD_RETRY_S;
    agent.lastRerouteAt = this.time;
    agent.reason = { code: "holding-repeat-hazard", at: this.time, params: {
      passage: this.passageLabel(edgeId), hazard: hazard === "smoke" ? "ควันหนาแน่น" : hazard === "heat" ? "ความร้อนสูง" : "ไฟ", count: recent.length, retryIn: HAZARD_HOLD_RETRY_S,
    } };
  }

  private beginRetreat(agent: RuntimeAgent, nodeMap: Map<string, SimNode>) {
    this.pendingDetourAgents.delete(agent.id);
    agent.detourExitSide = false;
    agent.detourPath = [];
    agent.detourIndex = 0;
    const currentNodeId = agent.route.nodeIds[agent.edgeIndex];
    const currentNode = nodeMap.get(currentNodeId);
    if (!currentNode || pointRisk(currentNode.position, this.fires, this.time + 1.5).blocked) {
      if (this.retreatAlongIncomingPassage(agent)) return;
      agent.retreating = false;
      agent.retreatNodeId = undefined;
      agent.retreatEdge = undefined;
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
    if (reverse.slice(1).some((point, index) => segmentTouchesFlame(reverse[index], point, this.fires, this.time + .65, PEDESTRIAN_RADIUS + .08))) {
      if (this.retreatAlongIncomingPassage(agent)) return;
      agent.retreating = false;
      agent.retreatNodeId = undefined;
      agent.retreatEdge = undefined;
      agent.status = "blocked";
      agent.decisionState = "safe-stop";
      agent.lastRerouteAt = Math.min(agent.lastRerouteAt, this.time - .5);
      return;
    }
    agent.edgePath = dedupePoints(reverse);
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.edgeEntered = true;
    agent.retreating = true;
    agent.retreatNodeId = currentNodeId;
    agent.retreatEdge = undefined;
    this.forwardGapByAgentCache.delete(agent.id);
    agent.status = "rerouting";
  }

  /** Early admission may leave someone on the incoming corridor when its end catches fire.
   * Walk back along that actual passage; planning from the burning logical node strands them. */
  private retreatAlongIncomingPassage(agent: RuntimeAgent): boolean {
    const incoming = this.incomingPassage(agent);
    if (!incoming) return false;
    const path = this.passagePath(incoming.edge, incoming.fromId, incoming.toId);
    if (path.length < 2 || !pointInsideWalkableCorridor(agent.position, path, incoming.edge)) return false;
    const safeNode = this.nodeMap.get(incoming.fromId);
    if (!safeNode || pointRisk(safeNode.position, this.fires, this.time + .65, PEDESTRIAN_RADIUS + .08).blocked) return false;
    const projection = closestPointOnPolyline(agent.position, path);
    const visited: Vec3[] = [path[0]];
    let along = 0;
    for (let i = 1; i < path.length; i += 1) {
      along += distance3(path[i - 1], path[i]);
      if (along >= projection.distanceAlong - .015) break;
      visited.push(path[i]);
    }
    let reverse = dedupePoints([[...agent.position] as Vec3, projection.point, ...visited.reverse()]);
    if (reverse.length < 2) return false;
    const segmentSafe = (from: Vec3, to: Vec3) => segmentInsideWalkway(from, to, path, incoming.edge)
      && !segmentTouchesFlame(from, to, this.fires, this.time + .65, PEDESTRIAN_RADIUS + .08);
    if (reverse.slice(1).some((point, index) => !segmentSafe(reverse[index], point))) {
      if (this.detourPlanningBudget <= 0 || this.time - agent.lastDetourPlanAt < .45) return false;
      this.detourPlanningBudget -= 1;
      agent.lastDetourPlanAt = this.time;
      const detour = planFireDetour([...path].reverse(), incoming.edge, {
        start: agent.position,
        riskAt: point => pointRisk(point, this.fires, this.time + .65, PEDESTRIAN_RADIUS + .08),
        segmentBlocked: (from, to) => segmentTouchesFlame(from, to, this.fires, this.time + .65, PEDESTRIAN_RADIUS + .08),
      });
      if (!detour) return false;
      reverse = detour;
    }
    this.leaveCurrentQueue(agent);
    this.pendingDetourAgents.delete(agent.id);
    this.forwardGapByAgentCache.delete(agent.id);
    agent.edgePath = reverse;
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.approachEdge = undefined;
    agent.approachPath = undefined;
    agent.approachSegments = 0;
    agent.detourPath = [];
    agent.detourIndex = 0;
    agent.edgeEntered = true;
    agent.retreating = true;
    agent.retreatNodeId = incoming.fromId;
    agent.retreatEdge = incoming.edge;
    agent.status = "rerouting";
    agent.decisionState = "avoiding-hazard";
    agent.reason = { code: "switch-hazard", at: this.time, params: { hazard: "ไฟบนเส้นทางเดิม", to: safeNode.name } };
    agent.noRouteRetryAt = -Infinity;
    return true;
  }

  private incapacitateAgent(agent: RuntimeAgent, reason: string) {
    if (agent.status === "incapacitated") return;
    this.pendingDetourAgents.delete(agent.id);
    this.leaveCurrentQueue(agent);
    agent.reason = { code: "incapacitated-flame", at: this.time };
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
      const queueDelay = Math.min(8, this.decisionMode === "coordinated"
        ? this.trueQueueWait(edge.id)
        : (agent.queueMemory.get(edge.id)?.wait ?? 0));
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

  private stepFixed(dt: number) {
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
      const local = firesByFloor.get(floorFromY(point[1],point)) ?? [];
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
    // Whole-building queue state. Only the coordinated controller plans with it; occupants use
    // perceivedReserved() (what they can see or remember).
    if (this.time - this.planningReservedAt >= 0.2 || this.planningReservedCache.size === 0) {
      const nextReserved = new Map<string, number>();
      const edgesWithCrowds = new Set<string>([...this.queuesByEdge.keys(), ...this.activeEdgeCountsCache.keys()]);
      edgesWithCrowds.forEach((edgeId) => {
        const edge = this.edgeMap.get(edgeId);
        const wait = edge ? this.observedPassageWait(edgeId) : 0;
        if (edge && wait > 0.5) nextReserved.set(edgeId, wait * edge.capacityPerSecond);
      });
      this.planningReservedCache = nextReserved;
      this.planningReservedAt = this.time;
    }
    if (this.time - this.lastQueueAuditAt >= 1) this.auditQueues();
    const planningReserved = this.planningReservedCache;
    // New path searches are expensive; safe cached paths remain unlimited. The budget is per
    // fixed step (i.e. per simulated time), so it does not depend on the device frame rate.
    this.reroutePlanningBudget = this.agents.length >= 1500 ? 2 : 4;
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

    // Crowd snapshot, rebuilt every fixed step. Each directed passage is ordered by remaining
    // distance to its end. People standing in a queue on that passage (waiting for the next
    // entrance), and people who were just admitted onward but are still walking out of it, are
    // obstacles on it. People standing still near a node (queueing for any entrance there, or
    // holding) are obstacles for everyone walking into that node from any passage.
    {
      type CrowdEntry = { agent: RuntimeAgent; order: number; queued: boolean };
      const activeEdgeCounts = new Map<string, number>();
      const streams = new Map<string, CrowdEntry[]>();
      const streamStart = new Map<string, string>();
      const push = (key: string, fromId: string, entry: CrowdEntry) => {
        const list = streams.get(key);
        if (list) list.push(entry); else { streams.set(key, [entry]); streamStart.set(key, fromId); }
      };
      const standingAtNode = new Map<string, RuntimeAgent[]>();
      const stationaryGrid = new Map<number, RuntimeAgent[]>();
      const addStanding = (nodeId: string | undefined, person: RuntimeAgent) => {
        if (!nodeId) return;
        const node = nodeMap.get(nodeId);
        if (!node || distance3(node.position, person.position) > 1.2) return;
        const list = standingAtNode.get(nodeId);
        if (list) { if (!list.includes(person)) list.push(person); } else standingAtNode.set(nodeId, [person]);
      };
      this.queueRemainingCache.clear();
      for (const occupant of this.agents) {
        if (occupant.status === "arrived" || occupant.status === "incapacitated") continue;
        if (occupant.status === "waiting" || distance3(occupant.progressAnchor, occupant.position) >= 0.15) {
          occupant.progressAnchor = [occupant.position[0], occupant.position[1], occupant.position[2]];
          occupant.lastProgressAt = this.time;
          occupant.squeezeCounted = false;
        } else if (!occupant.squeezeCounted && this.squeezing(occupant)) {
          occupant.squeezeCounted = true;
          this.squeezeEvents += 1;
        }
        if (occupant.edgeEntered) {
          if (occupant.status === "blocked" || occupant.retreating) {
            // Not part of any walking stream, but they still take up space (see settleStanding).
            const key = stationaryCellKey(Math.floor(occupant.position[0]), Math.round(occupant.position[1] / 1.6), Math.floor(occupant.position[2]));
            const holders = stationaryGrid.get(key);
            if (holders) holders.push(occupant); else stationaryGrid.set(key, [occupant]);
            continue;
          }
          const edgeId = occupant.route.edgeIds[occupant.edgeIndex];
          if (!edgeId) continue;
          activeEdgeCounts.set(edgeId, (activeEdgeCounts.get(edgeId) ?? 0) + 1);
          const remaining = polylineLength(occupant.edgePath) - polylineDistanceAt(occupant.edgePath, occupant.segmentIndex, occupant.segmentProgress);
          const fromId = occupant.route.nodeIds[occupant.edgeIndex];
          push(`${edgeId}:${fromId}>${occupant.route.nodeIds[occupant.edgeIndex + 1]}`, fromId, { agent: occupant, order: -remaining, queued: false });
          if (occupant.segmentIndex < occupant.approachSegments) {
            // Still walking out of the passage they queued in: an obstacle for whoever follows on it.
            const incoming = this.incomingPassage(occupant);
            if (incoming) push(`${incoming.edge.id}:${incoming.fromId}>${incoming.toId}`, incoming.fromId, { agent: occupant, order: 1e6, queued: true });
          }
          continue;
        }
        // Still at their seat inside the classroom: not on any walkway yet.
        if (occupant.status === "waiting") continue;
        const incoming = this.incomingPassage(occupant);
        const cell = stationaryCellKey(Math.floor(occupant.position[0]), Math.round(occupant.position[1] / 1.6), Math.floor(occupant.position[2]));
        const cellList = stationaryGrid.get(cell);
        if (cellList) cellList.push(occupant); else stationaryGrid.set(cell, [occupant]);
        addStanding(occupant.route.nodeIds[occupant.edgeIndex], occupant);
        if (incoming) addStanding(incoming.fromId, occupant);
        if (occupant.queueKey && incoming) {
          activeEdgeCounts.set(incoming.edge.id, (activeEdgeCounts.get(incoming.edge.id) ?? 0) + 1);
          const node = nodeMap.get(incoming.toId);
          const toNode = node ? distance3(node.position, occupant.position) : 0;
          push(`${incoming.edge.id}:${incoming.fromId}>${incoming.toId}`, incoming.fromId, { agent: occupant, order: 1e6 - toNode, queued: true });
        }
      }
      const forwardGapByAgent = new Map<number, number>();
      const queueAheadByAgent = new Map<number, string>();
      const forwardBlockerByAgent = new Map<number, number>();
      // Walkers still within the first 1.5 m of a passage, by the node they just left: whoever is
      // about to step off that node into a merging passage sees them.
      const enteringFromNode = new Map<string, RuntimeAgent[]>();
      streams.forEach((list, key) => {
        const fromId = streamStart.get(key);
        if (!fromId) return;
        for (const entry of list) {
          if (entry.queued) continue;
          const person = entry.agent;
          const approachLength = person.approachSegments ? polylineDistanceAt(person.edgePath, person.approachSegments, 0) : 0;
          const travelled = polylineLength(person.edgePath) + entry.order - approachLength;
          if (travelled < 0 || travelled > 1.5) continue;
          const nodeList = enteringFromNode.get(fromId);
          if (nodeList) nodeList.push(person); else enteringFromNode.set(fromId, [person]);
        }
      });
      streams.forEach((list) => {
        list.sort((a, b) => b.order - a.order);
        const queued = list.filter((entry) => entry.queued);
        const walkers = list.filter((entry) => !entry.queued);
        for (let index = 0; index < walkers.length; index += 1) {
          const me = walkers[index];
          const heading = walkingHeading(me.agent);
          let best = Infinity;
          let nearest: RuntimeAgent | null = null;
          // Somebody blocks me only if they are physically in front (along my walking direction)
          // within a body width sideways — whatever lane they prefer. Someone standing on exactly
          // my spot also blocks me when they are further along (they move off first).
          const consider = (person: RuntimeAgent, allowSameSpot: boolean) => {
            if (person === me.agent) return;
            const other = person.position, mine = me.agent.position;
            const dx = other[0] - mine[0], dz = other[2] - mine[2];
            if (Math.abs(other[1] - mine[1]) > 1.2) return;
            const gap = Math.hypot(dx, dz);
            const forward = dx * heading[0] + dz * heading[1];
            if (!(allowSameSpot && gap < 0.25)) {
              if (forward <= 0.02) return;
              if (Math.abs(-dx * heading[1] + dz * heading[0]) > 0.55) return;
            }
            if (gap < best) { best = gap; nearest = person; }
          };
          // Only people further along the passage (earlier in the sorted list) can hold me back.
          // That is a strict order, so "A waits for B" and "B waits for A" can never both hold and the
          // person at the front of any cluster is always free to move.
          for (let other = index - 1; other >= 0 && walkers[other].order - me.order <= 2; other -= 1) consider(walkers[other].agent, true);
          // People standing in the line at the far end of this passage, however far back up the
          // passage that line reaches (otherwise late arrivals would walk into its tail).
          for (const entry of queued) {
            if (this.queueRemaining(entry.agent) <= -me.order + 0.3) consider(entry.agent, true);
          }
          // After standing still for STALL_SQUEEZE_SECONDS a person squeezes past people of other
          // lines (their own line's order still holds). This is the safety net that guarantees no
          // permanent waiting loop between lines at a junction.
          const squeezing = this.squeezing(me.agent);
          // Just admitted and still walking out of the line I stood in: the people of that line
          // who are further along it are still in my way (strictly further along, so they never
          // wait for me in return).
          if (!squeezing && me.agent.segmentIndex < me.agent.approachSegments) {
            const incoming = this.incomingPassage(me.agent);
            const line = incoming ? streams.get(`${incoming.edge.id}:${incoming.fromId}>${incoming.toId}`) : undefined;
            if (line) {
              const mine = this.queueRemaining(me.agent);
              const myEdgeId = me.agent.route.edgeIds[me.agent.edgeIndex];
              for (const entry of line) {
                if (!entry.queued || entry.agent.edgeEntered || entry.agent === me.agent) continue;
                // Someone still waiting for the passage I was just admitted to comes after me.
                if (entry.agent.route.edgeIds[entry.agent.edgeIndex] === myEdgeId) continue;
                if (this.queueRemaining(entry.agent) < mine) consider(entry.agent, true);
              }
            }
          }
          // People standing at the node I am walking into, whichever passage they came from or wait
          // for. They never wait for walkers, so this cannot form a waiting loop.
          if (!squeezing && -me.order < 2.5) {
            const endNodeId = me.agent.route.nodeIds[me.agent.edgeIndex + 1];
            const myEdgeId = me.agent.route.edgeIds[me.agent.edgeIndex];
            for (const person of standingAtNode.get(endNodeId) ?? []) {
              // Someone waiting to come onto my passage (against my direction) waits for me, not
              // the other way round.
              if (person.route.edgeIds[person.edgeIndex] === myEdgeId) continue;
              // Someone holding without a route is squeezed past (they may stand there for long).
              if (!person.queueKey) continue;
              consider(person, false);
            }
            // People who just stepped off that node onto the next passage, going roughly my way
            // (not someone coming towards me — two people facing each other must not both stop).
            for (const person of enteringFromNode.get(endNodeId) ?? []) {
              const theirs = walkingHeading(person);
              if (theirs[0] * heading[0] + theirs[1] * heading[1] < -0.2) continue;
              consider(person, false);
            }
          }
          if (Number.isFinite(best)) forwardGapByAgent.set(me.agent.id, best);
          const blocker = nearest as RuntimeAgent | null;
          if (blocker) forwardBlockerByAgent.set(me.agent.id, blocker.id);
          if (blocker && !blocker.edgeEntered && blocker.queueKey) queueAheadByAgent.set(me.agent.id, blocker.queueKey);
        }
        // Somebody just admitted onward is still walking out of this passage: the people waiting
        // behind them in the line keep their distance (they never wait for the line, so no loop).
        const leaving = queued.filter((entry) => entry.agent.edgeEntered);
        if (leaving.length) {
          for (const entry of queued) {
            if (entry.agent.edgeEntered) continue;
            const mine = this.queueRemaining(entry.agent);
            let best = Infinity;
            for (const lead of leaving) {
              if (this.queueRemaining(lead.agent) >= mine) continue;
              if (Math.abs(lead.agent.position[1] - entry.agent.position[1]) > 1.2) continue;
              best = Math.min(best, Math.hypot(lead.agent.position[0] - entry.agent.position[0], lead.agent.position[2] - entry.agent.position[2]));
            }
            if (Number.isFinite(best)) forwardGapByAgent.set(entry.agent.id, best);
          }
        }
      });
      // People within the first 1.5 m of a passage occupy its entrance — walkers who just entered
      // and anyone standing there in a line for the far end of a short passage.
      const entranceOccupants = new Map<string, Vec3[]>();
      const entranceStanders = new Map<string, Vec3[]>();
      streams.forEach((list, key) => {
        const startNode = nodeMap.get(streamStart.get(key) ?? "");
        for (const entry of list) {
          if (entry.queued) {
            if (!startNode || distance3(startNode.position, entry.agent.position) > 1.5) continue;
            (entranceStanders.get(key) ?? entranceStanders.set(key, []).get(key)!).push(entry.agent.position);
            continue;
          } else {
            const total = polylineLength(entry.agent.edgePath);
            if (total + entry.order > 1.5 + (entry.agent.approachSegments ? polylineDistanceAt(entry.agent.edgePath, entry.agent.approachSegments, 0) : 0)) continue;
          }
          (entranceOccupants.get(key) ?? entranceOccupants.set(key, []).get(key)!).push(entry.agent.position);
        }
      });
      this.entranceOccupants = entranceOccupants;
      this.entranceStanders = entranceStanders;
      this.activeEdgeCountsCache = activeEdgeCounts;
      const directionalCounts = new Map<string, number>();
      streams.forEach((list, key) => directionalCounts.set(key, list.filter((entry) => !(entry.queued && entry.agent.edgeEntered)).length));
      this.directionalEdgeCounts = directionalCounts;
      this.forwardGapByAgentCache = forwardGapByAgent;
      this.queueAheadByAgent = queueAheadByAgent;
      this.forwardBlockerByAgent = forwardBlockerByAgent;
      this.stationaryGrid = stationaryGrid;
    }
    const activeEdgeCounts = this.activeEdgeCountsCache;
    const forwardGapByAgent = this.forwardGapByAgentCache;

    for (const agent of this.agents) {
      if (agent.status === "arrived" || agent.status === "incapacitated") continue;
      // Awareness: the building alarm (or the controller's announcement) reaches each person
      // after a short personal delay. Seeing the group leave is an additional social cue.
      if (agent.awareness === "none" && this.time >= agent.alarmHeardAt) {
        this.raiseAwareness(agent, this.decisionMode === "coordinated" ? "controller" : "alarm");
        agent.reason = { code: "pre-movement", at: this.time, params: { remaining: Math.max(0, agent.responseDelay - this.time) } };
      }
      if (agent.status === "waiting" && agent.groupLeaderId !== agent.id) {
        const leader = this.agents[agent.groupLeaderId];
        if (leader && leader.status !== "waiting" && leader.roomId === agent.roomId) {
          this.raiseAwareness(agent, "others-leaving");
          agent.responseDelay = Math.min(agent.responseDelay, this.time + 0.4 + seeded01(this.seed, agent.id, "follow-lag") * 1.2);
        }
      }
      // The local hard-safety check is cheap after floor indexing and runs every movement step.
      // Only the richer perception/report/physiology update is throttled, on a seeded personal
      // schedule in simulated time (never on frame counts).
      let currentRisk = pointRisk(agent.position, trueFiresAt(agent.position), this.time, PEDESTRIAN_RADIUS);
      let perceivedFires = agent.cachedPerceivedFires;
      const hazardCohortReady = this.time - agent.lastHazardUpdateAt >= agent.decisionPeriod * 0.1;
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
        this.perceiveClosures(agent);
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
      // The escape already consumed this substep's walking distance. Stepping away from a
      // door/stair entry gives up the place in its queue (rejoin at the back later).
      if (emergencyMoved) { this.leaveCurrentQueue(agent); continue; }
      // A safe-stop is no longer terminal. If an alternate route becomes available, retry it
      // periodically instead of leaving the person permanently stuck. This keeps the physical
      // no-teleport rule while allowing changing fire fronts / queue loads to free the agent.
      if (agent.status === "blocked") {
        const logicalNode = nodeMap.get(agent.currentNodeId);
        if (logicalNode && pointRisk(logicalNode.position, this.fires, this.time + .65).blocked) {
          this.retreatAlongIncomingPassage(agent);
        }
        if (!agent.retreating && this.time - agent.lastRerouteAt >= 0.45 && this.time >= agent.noRouteRetryAt) {
          const recoveryNodeId = agent.currentNodeId || agent.route.nodeIds[Math.min(agent.edgeIndex, agent.route.nodeIds.length - 1)];
          // Only what this person knows — no hidden fallback to the true fire map.
          const recovered = recoveryNodeId
            ? this.rerouteAgent(agent, recoveryNodeId, this.knownFireSources(agent), planningReserved, edgeMap, "recovery")
            : false;
          if (recovered === true) {
            agent.status = "rerouting";
            agent.decisionState = "avoiding-hazard";
          } else if (recovered === false) {
            agent.lastRerouteAt = this.time;
          }
        }
        if (agent.status === "blocked") { this.leaveCurrentQueue(agent); continue; }
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
          // Standing in the flame envelope means the person perceives it directly.
          trueFiresAt(agent.position).forEach((fire) => this.rememberFire(agent, fire, "direct"));
          if (recoveryNodeId) this.rerouteAgent(agent, recoveryNodeId, this.knownFireSources(agent), planningReserved, edgeMap, "recovery");
          agent.status = "evacuating";
          agent.decisionState = "avoiding-hazard";
          agent.responseDelay = Math.min(agent.responseDelay, this.time);
          // Deliberately continue into normal edge preparation below instead of safe-stopping.
        }
      }
      if (this.time < agent.responseDelay) {
        agent.status = "waiting";
        agent.decisionState = perceivedFires.length ? "assessing" : "waiting";
        if (agent.awareness !== "none" && agent.reason.code !== "pre-movement") {
          agent.reason = { code: "pre-movement", at: this.time, params: { remaining: Math.max(0, agent.responseDelay - this.time) } };
        }
        continue;
      }
      if (agent.edgeIndex >= agent.route.edgeIds.length) {
        this.markArrived(agent);
        continue;
      }

      let edge = this.getEdge(agent, edgeMap);
      if (agent.retreating && agent.retreatEdge) edge = agent.retreatEdge;
      if (!edge) {
        const recoveryNodeId = agent.currentNodeId || agent.route.nodeIds[Math.min(agent.edgeIndex, agent.route.nodeIds.length - 1)];
        if (agent.hasExitedBuilding && recoveryNodeId) {
          this.rerouteAgent(agent, recoveryNodeId, this.knownFireSources(agent), planningReserved, edgeMap, "recovery");
          agent.status = "rerouting";
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
        // Simulator A: a route from the person's phone is taken up here, at a node.
        if (agent.phoneAdvice && this.applyPhoneAdvice(agent, currentNodeId)) {
          const advised = this.getEdge(agent, edgeMap);
          if (!advised) { agent.status = "blocked"; continue; }
          edge = advised;
        }

        // A queue place belongs to one entry; moving on to another decision point releases it.
        if (agent.queueKey && agent.queueKey !== `${edge.id}|${currentNodeId}`) this.leaveCurrentQueue(agent);
        // Hard topology invariant: nobody may go outdoors before reaching floor 1.
        if ((edge.kind === "outdoor" || edge.kind === "assembly") && agent.floor > 1) {
          this.leaveCurrentQueue(agent);
          agent.status = "blocked";
          this.pushEvent("danger", "Topology guard", `ป้องกัน Agent #${agent.id} ออกจากอาคารก่อนถึงชั้น 1`);
          continue;
        }

        // Standing in a line with nothing new to react to (no fire known, no closure known, not yet
        // time for the personal re-evaluation): skip the decision analysis this step. The scheduled
        // re-evaluation (every 5–10 s) still looks at the queue and the alternatives.
        const waitingInLine = agent.status === "queueing" && agent.queueKey === `${edge.id}|${currentNodeId}`
          && this.time < agent.nextDecisionAt && !perceivedFires.length && !agent.knownClosed.size && !currentRisk.blocked;
        if (!waitingInLine) {
        // ---- Decision point: compare options only with information this person has ----------
        const urgentLocalDanger = currentRisk.blocked
          || currentRisk.fire > 0.035
          || currentRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 2.8
          || currentRisk.smoke * agent.smokeSensitivity > 0.2;
        const scheduledDecision = this.time >= agent.nextDecisionAt;
        // The person is standing at this entry, so its queue is directly observed.
        const entryQueue = this.queueFor(edge, currentNodeId);
        refillEdgeQueue(entryQueue, this.time);
        const position = entryQueue.waiting.indexOf(agent.id);
        const queueSeconds = position >= 0
          ? (position + (this.activeEdgeCountsCache.get(edge.id) ?? 0)) / this.crowdServiceRate(edge)
          : this.observedPassageWait(edge.id, currentNodeId, agent.id);
        agent.queueMemory.set(edge.id, { wait: queueSeconds, at: this.time });
        // Look ahead across several future edges, not only the next step. This lets a person choose
        // another stair while still on the corridor instead of discovering the fire too late on a landing.
        const lookAheadCount = Math.max(4, Math.min(20, Math.round(this.config.thermalLookAheadEdges ?? 10)));
        const lookAheadIds = agent.route.edgeIds.slice(agent.edgeIndex, agent.edgeIndex + lookAheadCount);
        // The forecast depends only on what this person knows and where their route goes: it is
        // recomputed when their senses update (personal schedule), at a scheduled decision, in
        // urgent danger, or when the route or position on it changes — not every 0.1 s step.
        const cachedForecast = agent.routeForecastCache;
        const forecastStale = !cachedForecast || cachedForecast.route !== agent.route || cachedForecast.edgeIndex !== agent.edgeIndex
          || updateHazardSenses || scheduledDecision || urgentLocalDanger;
        const routeForecast = !perceivedFires.length
          ? { eta: 0, fire: 0, smoke: 0, heat: 0, blocked: false, thermalBlocked: false, maxModeledTemperatureC: this.config.ambientTemperatureC ?? 29, danger: 0 }
          : forecastStale
            ? this.forecastRouteHazard(agent, lookAheadIds, perceivedFires, edgeMap)
            : cachedForecast!.value;
        if (perceivedFires.length && forecastStale) agent.routeForecastCache = { route: agent.route, edgeIndex: agent.edgeIndex, value: routeForecast };
        const fireAhead = routeForecast.blocked || routeForecast.fire > 0.055 * (1.15 - agent.riskAversion * 0.38);
        const smokeAhead = routeForecast.smoke * agent.smokeSensitivity > 0.125 * (1.2 - agent.riskAversion * 0.48);
        const heatAhead = routeForecast.thermalBlocked
          || routeForecast.maxModeledTemperatureC >= (this.config.heatAvoidThresholdC ?? 44)
          || routeForecast.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 2.55 * (1.15 - agent.riskAversion * 0.46);
        const localSmokeDanger = agent.perceivedSmoke > Math.max(0.12, agent.smokeDetectionThreshold * 3.4) * (1.18 - agent.riskAversion * 0.38);
        const localHeatDanger = agent.perceivedHeat > agent.heatDetectionThreshold * 3.8 * (1.18 - agent.riskAversion * 0.36);
        // Orderly drill: a stressed person gives up on a long line sooner. In a real emergency the
        // evidence points the other way — people in a hurry follow the crowd and under-use emptier
        // exits (herding; Helbing et al. 2000, Haghani & Sarvi 2017) — so stress raises tolerance.
        const queueThreshold = this.competitiveness > 0
          ? agent.queueToleranceSeconds * (1 + agent.stress * 0.6 * this.competitiveness)
          : agent.queueToleranceSeconds * (1 - agent.stress * 0.28);
        const survivalConcern = routeForecast.danger > 0.19 * (1.22 - agent.riskAversion * 0.44);
        // At real decision points (junctions, stair landings) people glance at the alternatives they
        // can see. Coupled with the hysteresis in rerouteAgent this lets visible queues redistribute
        // people gradually, without frame-by-frame flip-flopping.
        const proactiveSafeOptimization = Boolean(
          currentNode
          && (currentNode.type === "junction" || currentNode.type === "stair" || (perceivedFires.length > 0 && currentNode.type === "corridor")),
        );
        const localDetourEdge = edgeSupportsLocalBypass(edge);
        const hazardWantsReroute = fireAhead || smokeAhead || heatAhead || localSmokeDanger || localHeatDanger || survivalConcern;
        // Wide outdoor/assembly/corridor edges are continuous walkable areas. A point fire in the
        // middle must not make the agent solve a graph reroute back toward the building before it
        // has attempted to walk around the source inside the same physical edge.
        const openDecisionNodeCanSwitchLane = localDetourEdge && (currentNode?.type === "exit" || currentNode?.type === "gate");
        const globalHazardReroute = hazardWantsReroute && (!localDetourEdge || openDecisionNodeCanSwitchLane);
        const closedAhead = this.knownClosureAhead(agent);
        // A glance down the route: a long queue that is actually in view further ahead (e.g. the
        // stair landing seen from the corridor) is also a reason to reconsider.
        const visibleQueueAhead = scheduledDecision && queueSeconds <= queueThreshold
          ? this.visibleQueueAhead(agent, queueThreshold) : 0;
        let trigger: RerouteTrigger | null = null;
        if (closedAhead) trigger = "closed";
        else if (globalHazardReroute && (urgentLocalDanger || scheduledDecision || this.time - agent.lastRerouteAt >= 2)) trigger = "hazard";
        else if (scheduledDecision && (queueSeconds > queueThreshold || visibleQueueAhead > queueThreshold)) trigger = "queue";
        else if (scheduledDecision && proactiveSafeOptimization) trigger = "periodic";
        if (scheduledDecision || trigger) agent.nextDecisionAt = this.time + agent.decisionPeriod * (1 - agent.stress * 0.4);
        if (trigger) {
          agent.decisionState = trigger === "hazard" ? "avoiding-hazard" : "assessing";
          const hazardLabel = fireAhead ? "ไฟ" : heatAhead || localHeatDanger ? "ความร้อน" : "ควัน";
          const rerouted = this.rerouteAgent(agent, currentNodeId, perceivedFires, planningReserved, edgeMap, trigger, { queueSeconds: Math.max(queueSeconds, visibleQueueAhead), hazardLabel, closedEdgeId: closedAhead ?? undefined });
          if (rerouted === true) {
            if (heatAhead || localHeatDanger || routeForecast.thermalBlocked) this.thermalRerouteCount += 1;
            edge = this.getEdge(agent, edgeMap);
            if (!edge) { agent.status = "blocked"; continue; }
          } else if (trigger === "closed" && this.knownClosureAhead(agent)) {
            // Nowhere better to go: hold here (no teleport, no pushing into the closed passage).
            this.leaveCurrentQueue(agent);
            agent.status = "blocked";
            agent.decisionState = "safe-stop";
            continue;
          }
        }

        }

        // World truth at the entry: a closed passage is discovered on arrival even if it was not
        // visible earlier. The person learns it, tells others nearby and re-plans.
        if (this.closedEdges.has(edge.id)) {
          this.learnClosure(agent, edge.id, true);
          const result = this.rerouteAgent(agent, currentNodeId, perceivedFires, planningReserved, edgeMap, "closed", { closedEdgeId: edge.id });
          if (result === true) {
            edge = this.getEdge(agent, edgeMap);
            if (!edge) { agent.status = "blocked"; continue; }
          } else {
            this.leaveCurrentQueue(agent);
            agent.status = "blocked";
            agent.decisionState = "safe-stop";
            continue;
          }
          if (this.closedEdges.has(edge.id)) { this.leaveCurrentQueue(agent); agent.status = "blocked"; agent.decisionState = "safe-stop"; continue; }
        }

        const entryHazard = edgeHazard(edge.id, 2.5, perceivedFires);
        const entryThermalBlocked = modeledTemperatureFromHeat(entryHazard.heat, this.config.ambientTemperatureC ?? 29) >= (this.config.hardBlockTemperatureC ?? 62);
        if (entryHazard.blocked || entryThermalBlocked) {
          // On a wide edge, enter the edge and let the local steering layer sample the free side.
          // Thermal blocking at the centerline alone is not proof that the entire 5–8 m path is unsafe.
          const canTryBypass = edgeSupportsLocalBypass(edge);
          if (!canTryBypass) {
            agent.status = "rerouting";
            const rerouteResult = this.rerouteAgent(agent, currentNodeId, perceivedFires, planningReserved, edgeMap, "hazard", { hazardLabel: entryHazard.blocked ? "ไฟ" : "ความร้อน" });
            if (rerouteResult === true && entryThermalBlocked) this.thermalRerouteCount += 1;
            if (rerouteResult !== true) {
              this.leaveCurrentQueue(agent);
              agent.status = "rerouting";
              agent.decisionState = "safe-stop";
              if (agent.reason.code !== "no-route-reassess") agent.reason = { code: "holding-hazard", at: this.time };
            }
            continue;
          }
        }

        // Physical admission: long-run flow never exceeds the passage capacity, first come first
        // served, and nobody is admitted unless there is free space to step into.
        const queueState = this.queueFor(edge, currentNodeId);
        const spaceFree = this.entranceHasSpace(edge, activeEdgeCounts, agent, currentNodeId, agent.route.nodeIds[agent.edgeIndex + 1]);
        if (!spaceFree) joinQueue(queueState, agent.id);
        const node = nodeMap.get(currentNodeId);
        const entering = edge;
        const atEntrance = (id: number) => {
          const person = this.agents[id];
          if (!person || !node) return true;
          // Someone already outside who switched to another field gate on open ground joins the new
          // approach from where they stand (prepareEdge joins a forward exterior-safe waypoint); the
          // exit-door node is behind them, and waiting to be "at" it would hold them forever.
          if (person.hasExitedBuilding && (entering.kind === "outdoor" || entering.kind === "assembly")
            && distance3(person.position, node.position) > Math.max(0.85, walkableHalfWidth(entering) + 0.4)) return true;
          // Someone still in the classroom steps off from their seat along the room's own path.
          const incoming = this.incomingPassage(person);
          if (!incoming) return true;
          if (queueState.competitiveness > 0) {
            // The landing is a portal, not a point. A compressed crowd can stop just outside
            // the old spherical radius on the final stair run. Reserve its next passage while
            // it walks the remaining incoming polyline; prepareEdge retains that approach and
            // the movement guard still checks every step. No snapping or corner-cutting.
            const path = this.passagePath(incoming.edge, incoming.fromId, incoming.toId);
            return this.queueRemaining(person) <= 1.4
              && distance3(person.position, node.position) <= Math.hypot(1.4, walkableHalfWidth(incoming.edge)) + 0.1
              && pointInsideWalkableCorridor(person.position, path, incoming.edge);
          }
          // "At the entrance" = within reach of it across the width of the passage they came by.
          return distance3(person.position, node.position) <= Math.max(0.85, walkableHalfWidth(incoming.edge) + 0.4);
        };
        let admitted = false;
        if (spaceFree) {
          if (queueState.competitiveness > 0 && node) {
            // No line: the people at the mouth press for the gap; the best-placed get through.
            joinQueue(queueState, agent.id);
            const ranking = this.rankMouth(queueState, node, 0, atEntrance, dt);
            let rank: number | null = null;
            if (atEntrance(agent.id)) {
              rank = 0;
              for (const id of ranking.order) {
                if (id === agent.id) break;
                if (queueState.waiting.includes(id)) rank += 1;
              }
            }
            admitted = tryAdmitCompetitive(queueState, agent.id, this.time, rank, ranking.contenders);
          } else {
            admitted = tryAdmit(queueState, agent.id, this.time, atEntrance);
          }
        }
        if (!admitted) {
          if (agent.queueKey !== queueState.key) {
            this.leaveCurrentQueue(agent);
            agent.queueKey = queueState.key;
            agent.queueJoinedAt = this.time;
            agent.queueSeq = ++this.queueSequence;
          }
          agent.status = "queueing";
          agent.decisionState = agent.groupCohesion > 0.6 ? "following-group" : "assessing";
          const toStair = edge.kind === "stair" || nodeMap.get(agent.route.nodeIds[agent.edgeIndex + 1])?.type === "stair";
          const toDoor = edge.kind === "room" || edge.id.includes("door");
          const waitCode: DecisionReasonCode = queueState.competitiveness > 0
            ? (this.time < queueState.clogUntil ? "jammed-opening" : toStair ? "pushing-stair" : toDoor ? "pushing-door" : "pushing-space")
            : toStair ? "waiting-stair-space" : toDoor ? "waiting-door-space" : "waiting-space";
          // Keep a just-made route decision visible for a few seconds before showing the wait.
          const recentDecision = (agent.reason.code.startsWith("switch") || agent.reason.code.startsWith("keep")) && this.time - agent.reason.at < 3;
          if (agent.reason.code !== waitCode && !recentDecision) agent.reason = { code: waitCode, at: this.time };
          if (queueState.competitiveness > 0) this.positionInCrowd(agent, edge, currentNodeId, queueState, dt);
          else this.positionInQueue(agent, edge, currentNodeId, queueState, dt);
          continue;
        }
        agent.queueKey = null;
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
        if (agent.reason.code.startsWith("waiting") || agent.reason.code === "pre-movement" || agent.reason.code === "not-aware") {
          // Back on the move: show why this route was chosen (initial choice or last switch).
          agent.reason = agent.routeReason.code.startsWith("initial") || agent.routeReason.code.startsWith("switch") || agent.routeReason.code === "follow-group"
            ? agent.routeReason
            : { code: "follow-plan", at: this.time, params: { via: this.routeViaLabel(agent.route) } };
        }
      }

      // Traverse the current edge polyline segment-by-segment. This is the key fix that keeps
      // agents on room/corridor/stair geometry instead of interpolating directly through walls.
      if (agent.edgePath.length < 2 || agent.segmentIndex >= agent.edgePath.length - 1) {
        if (agent.retreating) {
          agent.edgeEntered = false;
          agent.retreating = false;
          const recoveredIncoming = Boolean(agent.retreatEdge);
          const currentNodeId = agent.retreatNodeId ?? agent.route.nodeIds[agent.edgeIndex];
          agent.retreatNodeId = undefined;
          agent.retreatEdge = undefined;
          this.updateContextFromNode(agent, nodeMap.get(currentNodeId));
          if (recoveredIncoming) {
            agent.arrivalEdgeId = undefined;
            agent.arrivalFromNodeId = undefined;
            agent.noRouteRetryAt = -Infinity;
            agent.decisionState = "safe-stop";
          }
          const rerouteResult = this.rerouteAgent(agent, currentNodeId, undefined, planningReserved, edgeMap);
          if (rerouteResult === false || rerouteResult === null) {
            agent.status = recoveredIncoming ? "blocked" : "rerouting";
            agent.decisionState = "safe-stop";
            agent.lastRerouteAt = Math.min(agent.lastRerouteAt, this.time - 0.5);
          }
          // Either way (re-planned onto the same passage, or plan kept), a repeated stop in front
          // of the same passage becomes an honest, slower hold instead of a step-up/step-back loop.
          this.holdIfRepeatingHazardStop(agent);
          continue;
        }
        this.completeEdge(agent, edge);
        continue;
      }
      // Physical queue formation: stop at the back of the waiting line for the next passage
      // instead of walking through the people already waiting there.
      const entranceGap = this.entranceQueueGap(agent);
      if (this.maybeJoinQueueEarly(agent, edge, entranceGap)) continue;

      const from = agent.edgePath[agent.segmentIndex];
      const to = agent.edgePath[agent.segmentIndex + 1];
      const actualDistance = Math.max(0.01, distance3(from, to));
      const activeOnEdge = activeEdgeCounts.get(edge.id) ?? 1;
      const edgeArea = effectiveEdgeArea(edge);
      const density = activeOnEdge / edgeArea;
      this.peakEdgeDensity = Math.max(this.peakEdgeDensity, density);
      // Hydraulic-model speed–density reduction (see densitySpeedRatio). Stairs keep their multiplier.
      const densitySpeedFactor = densitySpeedRatio(density);
      const smokeSlowdown = Math.max(0.48, 1 - currentRisk.smoke * agent.smokeSensitivity * 0.46);
      const visibilitySlowdown = 0.72 + agent.visibility * 0.28;
      const postureSlowdown = agent.protectivePosture ? 0.82 : 1;
      const alertnessBoost = 1 + Math.min(0.12, agent.stress * 0.16);
      const panicCoordination = Math.max(0.72, 1 - Math.max(0, agent.stress - 0.78) * 0.8);
      const streamGap = forwardGapByAgent.get(agent.id);
      const forwardGap = Number.isFinite(entranceGap) ? Math.min(entranceGap, streamGap ?? Infinity) : streamGap;
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
      const allowsLateralFlow = edge.kind === "corridor" || edge.kind === "junction" || edge.kind === "stair" || edge.kind === "outdoor" || edge.kind === "assembly";
      const touchesDoorPortal = edge.id.includes("door");
      if (allowsLateralFlow && !touchesDoorPortal && !agent.retreating) {
        const lane = walkingLanePlan(agent, edge, this.config.crowdBehavior);
        const edgeProgress = (agent.segmentIndex + nextProgress) / Math.max(1, agent.edgePath.length - 1);
        const openCrossSection = (node: SimNode | undefined) => Boolean(node && ["corridor","junction","stair","gate"].includes(node.type));
        // An open node is a cross-section: retain a small stream offset through the
        // junction rather than forcing everyone onto its exact centre for one tick.
        // Actual doorway edges still merge to the physical portal above.
        const startMerge = openCrossSection(nodeMap.get(agent.route.nodeIds[agent.edgeIndex])) ? .22 : 0;
        const endMerge = openCrossSection(nodeMap.get(agent.route.nodeIds[agent.edgeIndex+1])) ? .22 : 0;
        const mergeEnvelope = Math.min(1, Math.max(startMerge,edgeProgress*7), Math.max(endMerge,(1-edgeProgress)*7));
        const phase = hash01(agent.id * 97 + stableEdgeSeed(edge.id) * 0.00037) * Math.PI * 2;
        const humanMeander = 0.9 + Math.sin(edgeProgress * Math.PI * 3.2 + phase) * 0.1;
        const driftAmplitude = edge.kind === "stair" ? 0.05 : edge.kind === "corridor" || edge.kind === "junction" ? 0.10 : 0.14 + agent.stress * 0.08;
        const timeDrift = Math.sin(this.time * (0.34 + hash01(agent.id * 149) * 0.22) + phase * 1.7) * driftAmplitude * mergeEnvelope;
        const progressDrift = Math.sin(edgeProgress * Math.PI * (2.2 + hash01(agent.id * 157 + stableEdgeSeed(edge.id) * 0.00011)) + phase * 0.7) * driftAmplitude * 0.55;
        const lateralLimit = Math.min(edge.kind === "stair" ? 0.5 : edge.kind === "outdoor" || edge.kind === "assembly" ? 2.6 : 1.1, walkableHalfWidth(edge) - 0.08);
        const desiredOffset = Math.max(-lateralLimit, Math.min(lateralLimit, (lane.offset * humanMeander + timeDrift + progressDrift) * mergeEnvelope + (agent.bodyLateralOffset ?? 0)));
        const normal = horizontalPathNormal(agent.edgePath, agent.segmentIndex, nextProgress);
        let lateralOffset = desiredOffset;
        if (edge.kind === "outdoor" || edge.kind === "assembly" || (edgeSupportsLocalBypass(edge)
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
        if (!this.insideCurrentWalkway(agent, nextPosition, edge)) {
          const halfOffset = lerp3(centerlinePosition, nextPosition, 0.5);
          if (this.insideCurrentWalkway(agent, halfOffset, edge)) {
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
        const fraction = walkingBudget / desiredStep;
        nextPosition = lerp3(agent.position, nextPosition, fraction);
        // Progress is the interpolation parameter of this lane trajectory. Projecting
        // the blended-normal lane back onto the straight centreline can put it BEHIND
        // its old parameter at a switchback, freezing the leader and everybody behind.
        nextProgress = agent.segmentProgress + (nextProgress - agent.segmentProgress) * fraction;
      }
      if (!this.insideCurrentWalkway(agent, nextPosition, edge)) {
        // At a switchback the normal rotates. A bounded blend between two valid lane
        // targets can still leave their non-convex union. Spend this step recentering
        // on the current run before turning, retaining along-path progress.
        const centreNow = lerp3(from, to, agent.segmentProgress);
        const recentre = lerp3(agent.position, centreNow, Math.min(1, walkingBudget / Math.max(1e-6, distance3(agent.position, centreNow))));
        if (this.insideCurrentWalkway(agent, recentre, edge)
          && chordClear(agent.position, recentre, agent.edgePath, edge)
          && !segmentTouchesFlame(agent.position, recentre, this.fires, this.time + 0.35)) {
          nextPosition = recentre;
          nextProgress = agent.segmentProgress;
        }
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
        // Hard limit (≥ hard-block temperature) always stops the person. The softer "it is getting
        // warmer" cue only stops them when the way ahead does not lead out to cooler, cleaner air
        // below the heat-avoid limit — otherwise the only door out of a warm room became a livelock.
        const hardThermal = (!escapingHazard && perceivedNextTemperatureC >= (this.config.hardBlockTemperatureC ?? 62))
          || (!openDetourEdge && edgeTemperatureC >= (this.config.hardBlockTemperatureC ?? 62));
        const softThermal = (!escapingHazard
          && perceivedNextRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 3.7
          && perceivedNextRisk.heat * agent.heatSensitivity > currentHeatSignal + 0.035
        ) || (!openDetourEdge
          && edgeRisk.heat * agent.heatSensitivity > agent.heatDetectionThreshold * 4.2
          && agent.segmentProgress < 0.72);
        const thermalRetreat = hardThermal || (softThermal && !this.smokeExitAhead(agent, edge, perceivedFires, nodeMap, edgeMap));
        const smokeRises = !escapingHazard
          && perceivedNextRisk.smoke * agent.smokeSensitivity > 0.19 * (1.18 - agent.riskAversion * 0.42)
          && perceivedNextRisk.smoke * agent.smokeSensitivity > agent.perceivedSmoke + 0.045
          && agent.segmentProgress < 0.82;
        // A step into thicker smoke is not "deeper into danger" when this passage is the way out
        // to cleaner air (e.g. the only door of a smoky classroom next to the fire room). Judged
        // only from fires this person knows about; flame, heat and dense smoke still stop them.
        const smokeRetreat = smokeRises && !this.smokeExitAhead(agent, edge, perceivedFires, nodeMap, edgeMap);
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
              lateralPreference: walkingLanePlan(agent, edge, this.config.crowdBehavior).offset,
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
          this.noteHazardStop(agent, edge.id, sweptFlame || nextRisk.blocked || nearFlameRetreat || edgeWideBlock ? "fire" : thermalRetreat ? "heat" : "smoke");
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
        if (agent.retreating && agent.retreatEdge) {
          agent.retreating = false;
          if (!this.retreatAlongIncomingPassage(agent)) {
            agent.retreatEdge = undefined;
            agent.retreatNodeId = undefined;
            agent.edgeEntered = false;
            agent.status = "blocked";
          }
        }
        continue;
      }
      const stairTurnAllowance = edge.kind === "stair" ? Math.min(0.76, edge.width * 0.34) : 0;
      const openTurnAllowance = edge.kind === "outdoor" || edge.kind === "assembly"
        ? Math.min(1.6, edge.width * 0.24)
        : 0;
      const maxPhysicalStep = Math.max(0.44, speed * dt * 1.35 + lateralTravelAllowance * 1.15 + stairTurnAllowance + openTurnAllowance);
      // The roleplay player is a body like any other: do not walk into them (squeeze rule still applies).
      const player = this.playerBody;
      if (player && !this.squeezing(agent) && Math.abs(player[1] - nextPosition[1]) <= 1.2) {
        const after = Math.hypot(nextPosition[0] - player[0], nextPosition[2] - player[2]);
        if (after < 0.42 && after < Math.hypot(agent.position[0] - player[0], agent.position[2] - player[2])) continue;
      }
      const insideWalkway = this.insideCurrentWalkway(agent, nextPosition, edge);
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
        agent.floor = floorFromY(agent.position[1],agent.position);
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

    this.settleStanding(dt);
    this.settleCrossingStreams(dt);
    for (const agent of this.agents) agent.behavior = this.deriveBehavior(agent);
    if (this.agents.length && this.agents.every((agent) => agent.status === "arrived" || agent.status === "incapacitated")) {
      this.running = false;
      this.completed = true;
      const arrived = this.agents.filter((a) => a.status === "arrived").length;
      this.pushEvent(arrived === this.agents.length ? "success" : "warning", "Simulation completed", `ถึงจุดรวมพล ${arrived.toLocaleString("th-TH")}/${this.agents.length.toLocaleString("th-TH")} คน`);
    }
  }

  /** The passage this person is standing on while waiting at their current node, if any. */
  private incomingPassage(agent: RuntimeAgent): { edge: SimEdge; fromId: string; toId: string } | null {
    const toId = agent.route.nodeIds[agent.edgeIndex];
    if (!agent.arrivalEdgeId || !agent.arrivalFromNodeId || !toId) return null;
    const edge = this.edgeMap.get(agent.arrivalEdgeId);
    if (!edge || !((edge.from === agent.arrivalFromNodeId && edge.to === toId) || (edge.twoWay && edge.to === agent.arrivalFromNodeId && edge.from === toId))) return null;
    return { edge, fromId: agent.arrivalFromNodeId, toId };
  }

  /** Inside the current passage, or the incoming passage still being walked to its entrance. */
  private insideCurrentWalkway(agent: RuntimeAgent, point: Vec3, edge: SimEdge): boolean {
    return pointInsideWalkableCorridor(point, agent.edgePath, edge)
      || Boolean(agent.approachEdge && agent.approachPath && pointInsideWalkableCorridor(point, agent.approachPath, agent.approachEdge));
  }

  /** Bookkeeping when a person reaches the end node of their current edge. */
  private completeEdge(agent: RuntimeAgent, edge: SimEdge) {
    agent.approachEdge = undefined;
    agent.approachPath = undefined;
    agent.approachSegments = 0;
    agent.arrivalEdgeId = edge.id;
    agent.arrivalFromNodeId = agent.route.nodeIds[agent.edgeIndex];
    const nextNodeId = agent.route.nodeIds[agent.edgeIndex + 1];
    const nextNode = this.nodeMap.get(nextNodeId);
    if (edge.kind === "room" && nextNode?.type === "door") agent.hasPassedRoomDoor = true;
    if (edge.kind === "exit" && !edge.insideBuilding && nextNode?.type === "exit") agent.hasExitedBuilding = true;
    agent.edgeIndex += 1;
    agent.edgeEntered = false;
    agent.edgePath = [];
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    this.updateContextFromNode(agent, nextNode);
    if (agent.edgeIndex >= agent.route.edgeIds.length) { this.markArrived(agent); return; }
    // Take a place in the next entrance's line at once, so people arriving in the same step
    // see this person and stop behind instead of piling onto the same spot.
    const nextEdge = this.edgeMap.get(agent.route.edgeIds[agent.edgeIndex]);
    if (nextEdge && nextEdge.kind !== "outdoor" && nextEdge.kind !== "assembly") {
      const queue = this.queueFor(nextEdge, nextNodeId);
      this.leaveCurrentQueue(agent);
      joinQueue(queue, agent.id);
      agent.queueKey = queue.key;
      agent.queueJoinedAt = this.time;
      agent.queueSeq = ++this.queueSequence;
    }
  }

  private queueSpacing(agent: RuntimeAgent, edgeId: string) {
    // A pushing crowd packs to 6–9 people/m² (body-to-body, ~0.36–0.42 m centre to centre).
    if (this.competitiveness > 0) return 0.36 + (1 - this.competitiveness) * 0.12 + (hash01(agent.id * 83 + stableEdgeSeed(edgeId) * 0.00029) - 0.5) * 0.06 - agent.pushiness * 0.03;
    const base = this.config.crowdBehavior === "surge" ? 0.52 : this.config.crowdBehavior === "grouped" ? 0.64 : 0.74;
    return base + (hash01(agent.id * 83 + stableEdgeSeed(edgeId) * 0.00029) - 0.5) * 0.16;
  }

  /**
   * Distance to the nearest person already waiting at the entrance this walker is heading for
   * (from any incoming passage). Only computed in the last 2.5 m before that entrance.
   */
  private entranceQueueGap(agent: RuntimeAgent): number {
    if (agent.retreating) return Infinity;
    const nextEdgeId = agent.route.edgeIds[agent.edgeIndex + 1];
    const nodeId = agent.route.nodeIds[agent.edgeIndex + 1];
    if (!nextEdgeId || !nodeId) return Infinity;
    const queue = this.edgeQueues.get(`${nextEdgeId}|${nodeId}`);
    if (!queue || !queue.waiting.length) return Infinity;
    const remaining = polylineLength(agent.edgePath) - polylineDistanceAt(agent.edgePath, agent.segmentIndex, agent.segmentProgress);
    if (remaining > 2.5) return Infinity;
    let gap = Infinity;
    for (const otherId of queue.waiting) {
      const other = this.agents[otherId];
      if (other && other.id !== agent.id) gap = Math.min(gap, distance3(other.position, agent.position));
    }
    return gap;
  }

  /**
   * Physical queue formation: someone walking up behind a person who is already waiting for the
   * same next entrance stops there and joins the line (instead of walking through it to the door).
   */
  private maybeJoinQueueEarly(agent: RuntimeAgent, edge: SimEdge, entranceGap: number): boolean {
    if (agent.retreating || agent.detourPath.length || !EARLY_QUEUE_JOIN_KINDS.has(edge.kind)) return false;
    if (agent.segmentIndex < agent.approachSegments) return false;
    // Admission to a short connector may happen while still on the previous stair apron.
    // Do not logically finish that connector until physically inside its own envelope;
    // otherwise the following edge loses the stair approach and can cut across the void.
    const currentPath = this.passagePath(edge, agent.route.nodeIds[agent.edgeIndex], agent.route.nodeIds[agent.edgeIndex + 1]);
    if (!pointInsideWalkableCorridor(agent.position, currentPath, edge)) return false;
    const nextEdgeId = agent.route.edgeIds[agent.edgeIndex + 1];
    const nodeId = agent.route.nodeIds[agent.edgeIndex + 1];
    if (!nextEdgeId || !nodeId) return false;
    const spacing = this.queueSpacing(agent, nextEdgeId) + 0.2;
    const key = this.queueAheadByAgent.get(agent.id);
    const behindSameLine = key === `${nextEdgeId}|${nodeId}` && (this.forwardGapByAgentCache.get(agent.id) ?? Infinity) <= spacing;
    if (!behindSameLine && entranceGap > spacing) return false;
    this.completeEdge(agent, edge);
    return true;
  }

  /**
   * Distance (m) a waiting person still has to cover along the passage they arrived by before
   * reaching the entrance they queue for. Measured along the walkway, not in a straight line, so
   * the order is right on switchback stairs where the two flights lie side by side. Cached once
   * per fixed step.
   */
  /** Geometry of a passage walked from `fromId` to `toId` (cached: graph geometry is fixed). */
  private passagePath(edge: SimEdge, fromId: string, toId: string): Vec3[] {
    const key = `${edge.id}:${fromId}>${toId}`;
    const cached = this.passagePathCache.get(key);
    if (cached) return cached;
    const path = traversalPoints(edge, this.nodeMap, fromId, toId);
    this.passagePathCache.set(key, path);
    return path;
  }

  private queueRemaining(agent: RuntimeAgent): number {
    const cached = this.queueRemainingCache.get(agent.id);
    if (cached !== undefined) return cached;
    let remaining = Infinity;
    const incoming = this.incomingPassage(agent);
    if (incoming) {
      const path = this.passagePath(incoming.edge, incoming.fromId, incoming.toId);
      if (path.length >= 2) remaining = Math.max(0, polylineLength(path) - closestPointOnPolyline(agent.position, path).distanceAlong);
    } else {
      const node = this.nodeMap.get(agent.route.nodeIds[agent.edgeIndex]);
      if (node) remaining = distance3(node.position, agent.position);
    }
    this.queueRemainingCache.set(agent.id, remaining);
    return remaining;
  }

  /**
   * Hold a place in a FIFO queue on the incoming passage. People shuffle forward along that
   * passage (never backwards, at most 0.7 × walking pace) only while the nearest waiting person
   * ahead is more than one personal spacing away, so the line compresses without overlaps.
   * "Ahead" means earlier in the line (a strict order, so two people can never each wait for the
   * other) and not clearly behind along the walkway; a later arrival who is physically in front
   * simply lets the earlier one squeeze past.
   */
  private positionInQueue(agent: RuntimeAgent, edge: SimEdge, currentNodeId: string, queue: EdgeQueueState, dt: number) {
    const incoming = this.incomingPassage(agent);
    const incomingEdge = incoming?.edge;
    const previousNodeId = incoming?.fromId;
    const node = this.nodeMap.get(currentNodeId);
    if (!incomingEdge || !previousNodeId || !node) return;
    const incomingPath = this.passagePath(incomingEdge, previousNodeId, currentNodeId);
    if (incomingPath.length < 2) return;
    const projection = closestPointOnPolyline(agent.position, incomingPath);
    const total = polylineLength(incomingPath);
    const remaining = total - projection.distanceAlong;
    this.queueRemainingCache.set(agent.id, Math.max(0, remaining));
    if (remaining <= 0.42) return;
    const spacing = this.queueSpacing(agent, edge.id);
    const listed = queue.waiting.indexOf(agent.id);
    const myIndex = listed >= 0 ? listed : queue.waiting.length;
    let gap = Infinity;
    let crowding: RuntimeAgent | null = null;
    let crowdingSeparation = Infinity;
    // Only the few people just ahead in the line can be the nearest one in front (keeps this
    // O(line length) instead of O(line length²) for long stair queues).
    for (let index = Math.max(0, myIndex - 12); index < Math.min(queue.waiting.length, myIndex); index += 1) {
      const otherId = queue.waiting[index];
      if (otherId === agent.id) continue;
      const other = this.agents[otherId];
      if (!other) continue;
      const separation = distance3(other.position, agent.position);
      if (separation > 3) continue;
      // Earlier in the line (strict order, so nobody waits in a loop) and not clearly behind me.
      if (this.queueRemaining(other) > remaining + 0.3) continue;
      if (separation < 0.22 && separation < crowdingSeparation) { crowding = other; crowdingSeparation = separation; }
      gap = Math.min(gap, separation);
    }
    if (crowding) {
      // Standing on the same spot as someone ahead (they arrived from another direction): step
      // aside — across the walkway at this point, never backwards — to stand shoulder to shoulder.
      const [nx, nz] = normalAtPathDistance(incomingPath, projection.distanceAlong);
      for (const side of [1, -1]) {
        const target: Vec3 = [agent.position[0] + nx * side * 0.4, agent.position[1], agent.position[2] + nz * side * 0.4];
        if (distance3(target, crowding.position) < 0.35) continue;
        const step = lerp3(agent.position, target, Math.min(1, agent.speed * 0.7 * dt / 0.4));
        if (this.stepsOntoStanding(agent, step, incomingEdge.id)) continue;
        if (pointInsideWalkableCorridor(target, incomingPath, incomingEdge) && segmentInsideWalkway(agent.position, step, incomingPath, incomingEdge)
          && !segmentTouchesFlame(agent.position, step, this.fires, this.time + 0.35)) {
          agent.position = step;
          return;
        }
      }
      return;
    }
    // People who are walking in on the same passage are obstacles too.
    gap = Math.min(gap, this.forwardGapByAgentCache.get(agent.id) ?? Infinity);
    const step = Math.min(agent.speed * 0.7 * dt, remaining - 0.42, gap - spacing);
    if (step <= 0.005) return;
    const lateral: Vec3 = [agent.position[0] - projection.point[0], 0, agent.position[2] - projection.point[2]];
    const base = positionAlongPolyline(incomingPath, Math.min(1, (projection.distanceAlong + step) / Math.max(0.001, total)));
    // Standing just beside this passage (e.g. on the landing it starts from, where the line
    // reached back to): step straight towards its centre line to rejoin it. Only from close by,
    // so this never crosses a wall.
    if (projection.distance < 1.2 && !pointInsideWalkableCorridor(agent.position, incomingPath, incomingEdge)) {
      const towards = lerp3(agent.position, base, Math.min(1, step / Math.max(1e-3, distance3(agent.position, base))));
      if (!segmentTouchesFlame(agent.position, towards, this.fires, this.time + 0.35) && !this.stepsOntoStanding(agent, towards, incomingEdge.id)) {
        agent.position = towards;
        this.queueRemainingCache.set(agent.id, Math.max(0, remaining - step));
      }
      return;
    }
    // Keep the sideways place in the line; around a corner (e.g. a stair landing) fall back
    // towards the centre line rather than carrying the offset outside the walkway.
    for (const keep of [1, 0.5, 0]) {
      const target: Vec3 = [base[0] + lateral[0] * keep, base[1], base[2] + lateral[2] * keep];
      if (!pointInsideWalkableCorridor(target, incomingPath, incomingEdge)) continue;
      if (segmentTouchesFlame(agent.position, target, this.fires, this.time + 0.35)) return;
      if (!segmentInsideWalkway(agent.position, target, incomingPath, incomingEdge)) continue;
      // Someone from another line standing there (e.g. the tail of the next entrance's queue
      // reaching back across a short doorway) is not walked into either.
      if (this.stepsOntoStanding(agent, target, incomingEdge.id)) return;
      agent.position = target;
      this.queueRemainingCache.set(agent.id, Math.max(0, remaining - step));
      return;
    }
  }

  /**
   * Competitive crowd at an opening: there is no line. Each person keeps pushing towards the
   * opening and slips sideways into any gap across the width of the walkway, packing to body
   * contact (≈ 6–9 people/m²) — so the crowd fans out in front of a door or stair mouth instead of
   * standing single file down the corridor.
   *
   * Only people strictly closer to the opening (by walkway distance, ties broken by id) can hold a
   * person back. That is a strict order, so two people can never each wait for the other, and the
   * person nearest the opening is always free to press in.
   */
  private positionInCrowd(agent: RuntimeAgent, edge: SimEdge, currentNodeId: string, queue: EdgeQueueState, dt: number) {
    const incoming = this.incomingPassage(agent);
    const incomingEdge = incoming?.edge;
    const previousNodeId = incoming?.fromId;
    const node = this.nodeMap.get(currentNodeId);
    if (!incomingEdge || !previousNodeId || !node) return;
    const path = this.passagePath(incomingEdge, previousNodeId, currentNodeId);
    if (path.length < 2) return;
    const projection = closestPointOnPolyline(agent.position, path);
    const total = polylineLength(path);
    const remaining = total - projection.distanceAlong;
    this.queueRemainingCache.set(agent.id, Math.max(0, remaining));
    // Pressed right against the opening: nothing more to gain by moving.
    if (remaining <= 0.3 && projection.distance <= 0.05) return;
    const spacing = this.queueSpacing(agent, edge.id);
    const squeezing = this.squeezing(agent);
    // People in front (closer to this opening, by walkway distance; ties by id) keep the packing
    // distance. Anybody else standing still is never stepped onto (body contact ~0.32 m), unless
    // this person has been stuck long enough to squeeze past (deadlock safety net).
    const ahead: Vec3[] = [];
    const bodies: Vec3[] = [];
    const cx = Math.floor(agent.position[0]), cy = Math.round(agent.position[1] / 1.6), cz = Math.floor(agent.position[2]);
    for (let ox = -2; ox <= 2; ox += 1) for (let oz = -2; oz <= 2; oz += 1) {
      for (const other of this.stationaryGrid.get(stationaryCellKey(cx + ox, cy, cz + oz)) ?? []) {
        if (other === agent || other.status === "arrived" || other.status === "incapacitated") continue;
        if (Math.abs(other.position[1] - agent.position[1]) > 1.2) continue;
        if (Math.hypot(other.position[0] - agent.position[0], other.position[2] - agent.position[2]) > 2.2) continue;
        if (other.queueKey === queue.key) {
          const theirs = this.queueRemaining(other);
          if (theirs < remaining || (theirs === remaining && other.id < agent.id)) { ahead.push(other.position); continue; }
        }
        if (!squeezing) bodies.push(other.position);
      }
    }
    if (this.playerBody && !squeezing && Math.abs(this.playerBody[1] - agent.position[1]) <= 1.2) bodies.push(this.playerBody);
    // Someone just let through and still walking out of this crowd is in the way too.
    const leaving = this.forwardGapByAgentCache.get(agent.id) ?? Infinity;
    // Exactly min(Math.hypot(...)) over the list, without a hypot per person: find the smallest
    // squared distance, then take hypot only for the (near-)tied finalists. hypot and the squared
    // sum differ by at most a few ulps, far inside the 1e-9 relative margin.
    const nearest = (list: Vec3[], point: Vec3) => {
      let bestSq = Infinity;
      for (const other of list) {
        const dx = other[0] - point[0], dz = other[2] - point[2];
        const sq = dx * dx + dz * dz;
        if (sq < bestSq) bestSq = sq;
      }
      if (bestSq === Infinity) return Infinity;
      const limit = bestSq * (1 + 1e-9) + 1e-300;
      let best = Infinity;
      for (const other of list) {
        const dx = other[0] - point[0], dz = other[2] - point[2];
        if (dx * dx + dz * dz <= limit) best = Math.min(best, Math.hypot(dx, dz));
      }
      return best;
    };
    // Local walking direction at this person's own spot (never a direction from elsewhere on the
    // path, which flips at a switchback and would make a sideways jump).
    // At a vertex the projection belongs to both adjacent segments. Use the outgoing
    // tangent; the incoming tangent points away from the exit at a switchback corner.
    const state = segmentStateAtDistance(path, Math.min(total, projection.distanceAlong + 1e-6));
    let tangentIndex = state.segmentIndex;
    while (tangentIndex < path.length - 2 && Math.hypot(path[tangentIndex + 1][0] - path[tangentIndex][0], path[tangentIndex + 1][2] - path[tangentIndex][2]) < 1e-6) tangentIndex += 1;
    const a = path[tangentIndex], b = path[Math.min(path.length - 1, tangentIndex + 1)];
    let tx = b[0] - a[0], tz = b[2] - a[2];
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) return;
    tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;
    const lateralNow = (agent.position[0] - projection.point[0]) * nx + (agent.position[2] - projection.point[2]) * nz;
    // Pressing harder means a slightly longer lunge into a gap (still a walking-pace step).
    const stepLength = Math.min(agent.speed * (0.7 + agent.pushiness * 0.2) * dt, Math.max(0, remaining - 0.3) + projection.distance);
    if (stepLength <= 0.005) return;
    // Near the opening the crowd funnels towards its centre line.
    const funnel = Math.min(1, remaining / 1.6);
    const centrePull = -Math.sign(lateralNow) * Math.min(Math.abs(lateralNow), stepLength * 0.35) * (1 - funnel);
    // Does this person already have a clear line onward? Then every move must keep one; if not
    // (pushed into a pocket), only moves clearly back towards the centre line are allowed.
    const clearNow = chordClear(agent.position, path[Math.min(path.length - 1, state.segmentIndex + 1)], path, incomingEdge);
    const roomNow = nearest(ahead, agent.position);
    const bodyNow = nearest(bodies, agent.position);
    // Score every candidate with cheap checks first; the expensive walkway geometry tests then run
    // only on the best few, in order, until one passes (usually the first).
    const candidates: Array<{ point: Vec3; score: number; remaining: number; distance: number; forward: number }> = [];
    for (const forward of [1, 0.6, 0]) {
      if (forward > 0 && leaving < spacing * 0.9) continue;
      for (const shift of [0, 0.6, -0.6, 1.1, -1.1]) {
        if (forward === 0 && shift === 0) continue;
        const sideways = stepLength * shift * 0.6 + (forward > 0 ? centrePull : 0);
        const centre = positionAlongPolyline(path, Math.min(1, (projection.distanceAlong + stepLength * forward) / Math.max(.001, total)));
        const flat: Vec3 = [centre[0] + agent.position[0] - projection.point[0] + nx * sideways, centre[1] + agent.position[1] - projection.point[1], centre[2] + agent.position[2] - projection.point[2] + nz * sideways];
        // Preserve the full 3-D offset while advancing. Projecting Y alone onto a ramp
        // pulled people who already stood on the landing back UP the final riser, and
        // then the no-backtracking rule rejected every candidate. Do not descend below
        // the landing (or rise above the incoming level) while retaining this offset.
        const raw: Vec3 = [flat[0], Math.max(Math.min(path[0][1],node.position[1]),Math.min(Math.max(path[0][1],node.position[1]),flat[1])), flat[2]];
        // A person beside the final riser may already be standing on the landing's height.
        // Rejoining the sloping centreline must not snap their Y by a whole riser at once.
        const target = lerp3(agent.position, raw, Math.min(1, stepLength / Math.max(1e-6, distance3(agent.position, raw))));
        const onPath = closestPointOnPolyline(target, path);
        const targetRemaining = total - onPath.distanceAlong;
        // Never backwards along the walkway, never more than one step.
        if (targetRemaining > remaining + 0.01) continue;
        if (distance3(target, agent.position) > stepLength * 1.4 + 0.02) continue;
        const room = nearest(ahead, target);
        if (room < spacing && room < roomNow + 0.001) continue;
        const body = nearest(bodies, target);
        if (body < 0.32 && body < bodyNow + 0.001) continue;
        // Sidestepping only pays when it opens a way forward (more room in front).
        const recovering = onPath.distance < projection.distance - 0.001;
        if (forward === 0 && room <= roomNow + 0.002 && !recovering) continue;
        const gain = remaining - targetRemaining;
        candidates.push({ point: target, remaining: targetRemaining, distance: onPath.distance, forward, score: gain * 4 + Math.min(room, 1) * 0.6 + (!clearNow ? (projection.distance - onPath.distance) * 8 : 0) - (forward === 0 ? 0.25 : 0) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    let best: { point: Vec3; remaining: number } | null = null;
    for (const candidate of candidates) {
      const target = candidate.point;
      if (!pointInsideWalkableCorridor(target, path, incomingEdge)) continue;
      if (!segmentInsideWalkway(agent.position, target, path, incomingEdge)) continue;
      // A crowd stands in the open area in front of the opening: from where a person stands there
      // must be a clear straight line to the next point of the walkway (never a pocket behind a
      // stair void or lift bank that they could only leave by crossing it). Someone already in such
      // a pocket may only move clearly back towards the centre line.
      const nextVertex = path[Math.min(path.length - 1, segmentStateAtDistance(path, Math.min(total, total - candidate.remaining + 1e-6)).segmentIndex + 1)];
      // Recovery must be possible in a bounded physics step. A fixed 5 cm improvement
      // exceeded a slow person's entire sideways step and permanently trapped the crowd.
      if (!chordClear(target, nextVertex, path, incomingEdge) && (clearNow || candidate.distance >= projection.distance - 0.001)) continue;
      if (segmentTouchesFlame(agent.position, target, this.fires, this.time + 0.35)) continue;
      best = candidate;
      break;
    }
    if (!best) return;
    agent.position = best.point;
    this.queueRemainingCache.set(agent.id, Math.max(0, best.remaining));
  }

  /**
   * True if moving to `target` would bring this person onto somebody standing still there.
   * People waiting to step onto the very passage this person is already on are behind them in
   * the flow and never hold them back (otherwise each would wait for the other).
   */
  private stepsOntoStanding(agent: RuntimeAgent, target: Vec3, passageId?: string): boolean {
    if (this.squeezing(agent)) return false;
    const cx = Math.floor(target[0]);
    const cy = Math.round(target[1] / 1.6);
    const cz = Math.floor(target[2]);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const list = this.stationaryGrid.get(stationaryCellKey(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const other of list) {
        if (other === agent || other.status === "arrived" || other.status === "incapacitated") continue;
        // Only people standing in a line, who took their place before me, hold me back: a strict
        // order across all lines, so people waiting for different entrances on one stair flight
        // can never each wait for the other. Someone standing still for another reason (no
        // route) is squeezed past rather than blocking a line for ever.
        if (other.edgeEntered || !other.queueKey) continue;
        // My own line is ordered by queue position in positionInQueue.
        if (other.queueKey === agent.queueKey) continue;
        // Flow direction decides first: whoever already stands on the passage I am waiting to enter
        // is ahead of me; whoever waits to enter the passage I stand on is behind me.
        if (passageId && other.route.edgeIds[other.edgeIndex] === passageId) continue;
        const otherPassage = other.arrivalEdgeId;
        const downstream = Boolean(otherPassage && otherPassage === agent.route.edgeIds[agent.edgeIndex]);
        if (!downstream && other.queueSeq > agent.queueSeq) continue;
        if (Math.abs(other.position[1] - target[1]) > 1.2) continue;
        const after = Math.hypot(other.position[0] - target[0], other.position[2] - target[2]);
        if (after >= 0.3) continue;
        const before = Math.hypot(other.position[0] - agent.position[0], other.position[2] - agent.position[2]);
        if (after < before) return true;
      }
    }
    return false;
  }

  /**
   * People standing still (queueing or holding) who ended up on the same spot — typically a graph
   * node, which is a single point — ease apart: at most 5 cm per step, sideways or away from the
   * other person, only inside the walkway and never into flames. The lower id keeps its place.
   */
  private settleStanding(dt: number) {
    const reach = 0.25;
    const maxStep = Math.min(0.05, 0.5 * dt);
    this.stationaryGrid.forEach((list) => {
      for (const agent of list) {
        if (agent.status === "arrived" || agent.status === "incapacitated" || agent.status === "waiting") continue;
        // People mid-passage are only eased apart while they stand still (holding or retreated).
        if (agent.edgeEntered && agent.status !== "blocked" && agent.status !== "rerouting") continue;
        const cx = Math.floor(agent.position[0]), cy = Math.round(agent.position[1] / 1.6), cz = Math.floor(agent.position[2]);
        let nearest: RuntimeAgent | null = null;
        let nearestDistance = reach;
        for (let ox = -1; ox <= 1; ox += 1) for (let oz = -1; oz <= 1; oz += 1) {
          for (const other of this.stationaryGrid.get(stationaryCellKey(cx + ox, cy, cz + oz)) ?? []) {
            if (other === agent || other.id > agent.id || other.status === "arrived" || other.status === "incapacitated") continue;
            if (Math.abs(other.position[1] - agent.position[1]) > 1.2) continue;
            const distance = Math.hypot(other.position[0] - agent.position[0], other.position[2] - agent.position[2]);
            if (distance < nearestDistance) { nearest = other; nearestDistance = distance; }
          }
        }
        if (!nearest) continue;
        // Walkway this person stands in: the passage they arrived by, or the one they are about to take.
        const incoming = this.incomingPassage(agent);
        const nextEdge = this.edgeMap.get(agent.route.edgeIds[agent.edgeIndex] ?? "");
        const currentEdge = agent.edgeEntered ? this.edgeMap.get(agent.route.edgeIds[agent.edgeIndex] ?? "") : undefined;
        const walkway = agent.edgeEntered
          ? (currentEdge ? { edge: currentEdge, path: agent.edgePath } : null)
          : incoming
          ? { edge: incoming.edge, path: this.passagePath(incoming.edge, incoming.fromId, incoming.toId) }
          : nextEdge ? { edge: nextEdge, path: this.passagePath(nextEdge, agent.route.nodeIds[agent.edgeIndex], agent.route.nodeIds[agent.edgeIndex + 1]) } : null;
        if (!walkway || walkway.path.length < 2) continue;
        let ax = agent.position[0] - nearest.position[0], az = agent.position[2] - nearest.position[2];
        let length = Math.hypot(ax, az);
        if (length < 1e-3) {
          const angle = seeded01(this.seed, agent.id, "settle") * Math.PI * 2;
          ax = Math.cos(angle); az = Math.sin(angle); length = 1;
        }
        const step = Math.min(maxStep, reach - nearestDistance);
        for (const turn of [0, 1, -1]) {
          // Straight away from the other person first, then either side.
          const dx = turn === 0 ? ax / length : (-az / length) * turn;
          const dz = turn === 0 ? az / length : (ax / length) * turn;
          const target: Vec3 = [agent.position[0] + dx * step, agent.position[1], agent.position[2] + dz * step];
          if (!pointInsideWalkableCorridor(target, walkway.path, walkway.edge)) continue;
          if (segmentTouchesFlame(agent.position, target, this.fires, this.time + 0.35)) continue;
          agent.position = target;
          break;
        }
      }
    });
  }

  private settleCrossingStreams(dt: number) {
    // Last-resort separation of deeply interpenetrating point agents. Normal body spacing
    // (0.32 m and above) is handled by the stream/crowd rules. Applying that soft spacing
    // again here to every crossing stream displaces whole queues and creates new gridlock.
    const reach = 0.12;
    const maxStep = Math.min(0.05, 0.5 * dt);
    // Build from the *post-movement* positions, including walkers on different edges.
    // The queue grid excludes those walkers; two crossing campus streams could therefore
    // occupy the same point indefinitely while both still had status "evacuating".
    const bodies = new Map<number, RuntimeAgent[]>();
    for (const person of this.agents) {
      if (["arrived", "incapacitated", "waiting"].includes(person.status)) continue;
      const key = stationaryCellKey(Math.floor(person.position[0]), Math.round(person.position[1] / 1.6), Math.floor(person.position[2]));
      const list = bodies.get(key);
      if (list) list.push(person); else bodies.set(key, [person]);
    }
    bodies.forEach((list) => {
      for (const agent of list) {
        if (agent.status === "arrived" || agent.status === "incapacitated" || agent.status === "waiting") continue;
        // Include waiting people in this post-movement pass too: the earlier stationary
        // grid can miss two people converging on a landing during the same step.
        // A queue keeps priority over a walker; equal states use a stable id order.
        const cx = Math.floor(agent.position[0]), cy = Math.round(agent.position[1] / 1.6), cz = Math.floor(agent.position[2]);
        let nearest: RuntimeAgent | null = null;
        let nearestDistance = reach;
        const neighbours: RuntimeAgent[] = [];
        // Only people within reach + maxStep (< 0.2 m) matter, so a 1 m neighbour cell is visited only
        // when this person stands that close to its border. Same cells in the same order as before for
        // anyone who could match; the rest could never pass the distance test.
        const span = reach + maxStep;
        const fx = agent.position[0] - cx, fz = agent.position[2] - cz;
        for (let ox = -1; ox <= 1; ox += 1) {
          if ((ox === -1 && fx > span) || (ox === 1 && fx < 1 - span)) continue;
          for (let oy = -1; oy <= 1; oy += 1) for (let oz = -1; oz <= 1; oz += 1) {
          if ((oz === -1 && fz > span) || (oz === 1 && fz < 1 - span)) continue;
          const cell = bodies.get(stationaryCellKey(cx + ox, cy + oy, cz + oz));
          if (!cell) continue;
          for (const other of cell) {
            if (other === agent || (!agent.edgeEntered && other.edgeEntered)
              || (other.edgeEntered === agent.edgeEntered && other.id > agent.id)
              || other.status === "arrived" || other.status === "incapacitated") continue;
            if (Math.abs(other.position[1] - agent.position[1]) > 0.3) continue;
            const distance = Math.hypot(other.position[0] - agent.position[0], other.position[2] - agent.position[2]);
            if (distance <= reach + maxStep) neighbours.push(other);
            if (distance < nearestDistance) { nearest = other; nearestDistance = distance; }
          }
          }
        }
        if (!nearest) continue;
        // Walkway this person stands in: the passage they arrived by, or the one they are about to take.
        const incoming = this.incomingPassage(agent);
        const nextEdge = this.edgeMap.get(agent.route.edgeIds[agent.edgeIndex] ?? "");
        const currentEdge = agent.edgeEntered ? this.edgeMap.get(agent.route.edgeIds[agent.edgeIndex] ?? "") : undefined;
        const walkway = agent.edgeEntered && agent.approachEdge && agent.approachPath && agent.segmentIndex < agent.approachSegments
          ? { edge: agent.approachEdge, path: agent.approachPath }
          : agent.edgeEntered
          ? (currentEdge ? { edge: currentEdge, path: agent.edgePath } : null)
          : incoming
          ? { edge: incoming.edge, path: this.passagePath(incoming.edge, incoming.fromId, incoming.toId) }
          : nextEdge ? { edge: nextEdge, path: this.passagePath(nextEdge, agent.route.nodeIds[agent.edgeIndex], agent.route.nodeIds[agent.edgeIndex + 1]) } : null;
        if (!walkway || walkway.path.length < 2) continue;
        let ax = agent.position[0] - nearest.position[0], az = agent.position[2] - nearest.position[2];
        let length = Math.hypot(ax, az);
        if (length < 1e-3) {
          const angle = seeded01(this.seed, agent.id, "settle") * Math.PI * 2;
          ax = Math.cos(angle); az = Math.sin(angle); length = 1;
        }
        const step = Math.min(maxStep, reach - nearestDistance);
        const projected = closestPointOnPolyline(agent.position, walkway.path);
        const tangent = agent.edgeEntered
          ? [agent.edgePath[agent.segmentIndex + 1]?.[0] - agent.edgePath[agent.segmentIndex]?.[0], agent.edgePath[agent.segmentIndex + 1]?.[2] - agent.edgePath[agent.segmentIndex]?.[2]]
          : null;
        let best: Vec3 | null = null;
        let clearance = nearestDistance;
        for (const turn of [0, 1, -1, 0.5, -0.5, 2]) {
          // Straight away from the other person first, then either side.
          const angle = turn * Math.PI / 2;
          let dx = (ax * Math.cos(angle) - az * Math.sin(angle)) / length;
          let dz = (ax * Math.sin(angle) + az * Math.cos(angle)) / length;
          if (tangent && Math.hypot(...tangent) > 1e-6) {
            // A walking person yields sideways, preserving their along-path progress.
            const tl = Math.hypot(...tangent), nx = -tangent[1] / tl, nz = tangent[0] / tl;
            const side = dx * nx + dz * nz;
            dx = nx * Math.sign(side); dz = nz * Math.sign(side);
          }
          const target: Vec3 = [agent.position[0] + dx * step, agent.position[1], agent.position[2] + dz * step];
          let gap = Infinity;
          for (const other of neighbours) gap = Math.min(gap, Math.hypot(other.position[0] - target[0], other.position[2] - target[2]));
          if (gap <= clearance + 0.00001) continue;
          if (!pointInsideWalkableCorridor(target, walkway.path, walkway.edge)) continue;
          if (!segmentInsideWalkway(agent.position, target, walkway.path, walkway.edge)) continue;
          if (!agent.edgeEntered && closestPointOnPolyline(target, walkway.path).distanceAlong < projected.distanceAlong - 0.001) continue;
          const projectedState = segmentStateAtDistance(walkway.path, projected.distanceAlong + 1e-6);
          const vertex = walkway.path[Math.min(walkway.path.length - 1, projectedState.segmentIndex + 1)];
          if (!chordClear(target, vertex, walkway.path, walkway.edge)) continue;
          if (segmentTouchesFlame(agent.position, target, this.fires, this.time + 0.35)) continue;
          clearance = gap; best = target;
        }
        if (best) {
          // Yielding sideways is not forward progress: otherwise small collision-avoidance
          // oscillations keep resetting the 10 s deadlock timer forever.
          agent.progressAnchor = [agent.progressAnchor[0] + best[0] - agent.position[0], agent.progressAnchor[1], agent.progressAnchor[2] + best[2] - agent.position[2]];
          if (agent.edgeEntered && currentEdge && !currentEdge.id.includes("door")) {
            const normal = horizontalPathNormal(agent.edgePath, agent.segmentIndex, agent.segmentProgress);
            const delta = (best[0] - agent.position[0]) * normal[0] + (best[2] - agent.position[2]) * normal[1];
            agent.bodyLateralOffset = Math.max(-0.3, Math.min(0.3, (agent.bodyLateralOffset ?? 0) + delta));
          }
          agent.position = best;
        }
      }
    });
  }

  /** Removes FIFO entries that no longer correspond to a waiting person (must stay at zero). */
  private auditQueues() {
    this.lastQueueAuditAt = this.time;
    this.edgeQueues.forEach((queue) => {
      if (!queue.waiting.length) return;
      const valid = queue.waiting.filter((id) => {
        const agent = this.agents[id];
        return Boolean(agent && agent.queueKey === queue.key && !agent.edgeEntered && agent.status !== "arrived" && agent.status !== "incapacitated");
      });
      if (valid.length !== queue.waiting.length) {
        this.staleQueueRepairs += queue.waiting.length - valid.length;
        queue.waiting = valid;
      }
    });
    for (const agent of this.agents) {
      if (!agent.queueKey) continue;
      const queue = this.edgeQueues.get(agent.queueKey);
      if (!queue || !queue.waiting.includes(agent.id)) { agent.queueKey = null; this.staleQueueRepairs += 1; }
    }
  }

  /**
   * Free space to step into: occupancy of the passage is limited to 2.2 people/m² of effective
   * area (just beyond the maximum-flow density of the hydraulic model). Newly admitted people then
   * keep their distance from whoever is ahead through the normal forward-gap rule.
   */
  private entranceHasSpace(edge: SimEdge, activeEdgeCounts: Map<string, number>, agent: RuntimeAgent, fromNodeId: string, toNodeId: string): boolean {
    if (edge.kind === "assembly" || edge.kind === "outdoor") return true;
    const occupancyLimit = Math.max(2, Math.floor(effectiveEdgeArea(edge) * 2.2));
    // Someone who has stood still for a while squeezes past people coming the other way: only
    // people going in their own direction then count against the space (otherwise a narrow gallery
    // used in both directions can lock up completely).
    const occupancy = this.squeezing(agent)
      ? this.directionalEdgeCounts.get(`${edge.id}:${fromNodeId}>${toNodeId}`) ?? 0
      : activeEdgeCounts.get(edge.id) ?? 0;
    if (occupancy >= occupancyLimit) return false;
    // Nobody may step onto the spot where someone who just entered is still standing.
    for (const position of this.entranceOccupants.get(`${edge.id}:${fromNodeId}>${toNodeId}`) ?? []) {
      if (position !== agent.position && distance3(position, agent.position) < 0.45) return false;
    }
    if (!this.squeezing(agent)) {
      for (const position of this.entranceStanders.get(`${edge.id}:${fromNodeId}>${toNodeId}`) ?? []) {
        if (position !== agent.position && distance3(position, agent.position) < 0.45) return false;
      }
    }
    return true;
  }

  /** Has stood still long enough to squeeze past people of other lines (see STALL_SQUEEZE_SECONDS). */
  private squeezing(agent: RuntimeAgent): boolean {
    return this.time - agent.lastProgressAt >= STALL_SQUEEZE_SECONDS;
  }

  /** Longest expected wait (s) among the next few route passages whose queue is in view. */
  private visibleQueueAhead(agent: RuntimeAgent, minimum: number): number {
    let longest = 0;
    const spaces = this.agentSpaceKeys(agent);
    const limit = Math.min(agent.route.edgeIds.length, agent.edgeIndex + 5);
    for (let index = agent.edgeIndex + 1; index < limit; index += 1) {
      const edgeId = agent.route.edgeIds[index];
      if (!this.nodeVisible(agent, agent.route.nodeIds[index], 20, spaces)) continue;
      const wait = this.observedPassageWait(edgeId, agent.route.nodeIds[index]);
      agent.queueMemory.set(edgeId, { wait, at: this.time });
      if (wait > minimum) longest = Math.max(longest, wait);
    }
    return longest;
  }

  /** Closures this person plans around (remembered ones are re-checked after a long hold). */
  private planningClosures(agent: RuntimeAgent): Set<string> {
    const result = new Set<string>();
    agent.knownClosed.forEach((at, edgeId) => {
      // Each further re-check of the same passage waits twice as long (45, 90, 180 … s), so a person
      // with truly no way out mostly waits instead of pacing between closed stairs.
      const rechecks = agent.closureRechecks.get(edgeId) ?? 0;
      const recheck = this.decisionMode === "occupant" && agent.noRouteFailures >= 2 && this.time - at > CLOSURE_RECHECK_SECONDS * 2 ** rechecks;
      // Stuck for a while with an old closure in mind: go and look again. The memory is dropped
      // (not just ignored once), otherwise the route chosen to go and look would immediately be
      // rejected again by the same memory. If it is still closed it is seen again on arrival.
      if (recheck) { agent.knownClosed.delete(edgeId); agent.closureRechecks.set(edgeId, rechecks + 1); }
      else result.add(edgeId);
    });
    return result;
  }

  private knownClosureAhead(agent: RuntimeAgent): string | null {
    if (!agent.knownClosed.size) return null;
    const closures = this.planningClosures(agent);
    for (let index = agent.edgeIndex; index < agent.route.edgeIds.length; index += 1) {
      if (closures.has(agent.route.edgeIds[index])) return agent.route.edgeIds[index];
    }
    return null;
  }

  private passageLabel(edgeId: string | undefined): string {
    if (!edgeId) return "ทางข้างหน้า";
    const group = this.passageGroups().find((item) => item.edgeIds.includes(edgeId));
    if (group) return group.label;
    const edge = this.edgeMap.get(edgeId);
    return edge ? this.edgeName(edge) : "ทางข้างหน้า";
  }

  private deriveBehavior(agent: RuntimeAgent): AgentBehaviorState {
    if (agent.status === "incapacitated") return "incapacitated";
    if (agent.status === "arrived") return "arrived";
    if (agent.awareness === "none") return "unaware";
    if (agent.status === "waiting") return agent.decisionState === "assessing" && agent.fireKnowledge.size ? "assessing" : "preparing";
    if (agent.status === "blocked" || agent.decisionState === "safe-stop" || this.time < agent.noRouteRetryAt) return "holding";
    if (agent.status === "queueing") return this.competitiveness > 0 ? "crowding" : "queueing";
    if (agent.status === "rerouting") return "replanning";
    if (agent.edgeEntered && this.edgeMap.get(agent.route.edgeIds[agent.edgeIndex])?.kind === "stair") return "on-stairs";
    if (!agent.hasPassedRoomDoor) return "leaving-room";
    return "moving";
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
    knownClosed?: ReadonlySet<string>,
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
    if (knownClosed?.size && path.edgeIds.some((edgeId) => knownClosed.has(edgeId))) return invalid;

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
      // Coordinated controller: live queue truth. Occupant: only `reserved`, which already holds
      // what this person sees or remembers (see perceivedReserved).
      const liveQueueDelay = this.decisionMode === "coordinated" ? Math.max(0, this.trueQueueWait(edge.id) - eta) : 0;
      // Expected wait (s) = people ahead / passage capacity (people/s). No artificial cap: a
      // 3-minute stair queue must look like 3 minutes when comparing it with another stair.
      const queueDelay = Math.min(900, Math.max(liveQueueDelay, queuedPeople / capacity));
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
      // Bent campus approaches must retain their calibrated crossing/footpath.
      if (edge.waypoints?.length) continue;
      const goal = this.nodeMap.get(edge.to);
      if (!goal || goal.type !== "assembly") continue;
      const slotIndex = goal.id === agent.route.goalId && agent.assemblySlotIndex >= 0 ? agent.assemblySlotIndex : this.freeSlotIndex(goal);
      if (slotIndex < 0) continue;
      const slot = slotForGoal(goal, slotIndex, this.config.crowdBehavior);
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
      // The field approach is open ground: its queue is visible from the gate.
      const queueDelay = this.trueQueueWait(edge.id);
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
    const fieldRoute: RoutePath = {
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
    if (!this.commitRoute(agent, fieldRoute)) return false;
    agent.reason = { code: "switch-hazard", at: this.time, params: { hazard: "ไฟ", to: best.goal.name } };
    agent.routeReason = agent.reason;
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
    this.countRerouteReason("emergency-exit-flame");
    return true;
  }

  private countRerouteReason(code: string) {
    this.rerouteReasonCounts.set(code, (this.rerouteReasonCounts.get(code) ?? 0) + 1);
  }

  /**
   * Re-plans from `currentNodeId` with the person's own information.
   *
   * Units: every compared quantity is an expected arrival time in seconds (travel at own speed +
   * expected queue wait), evaluated only after hard constraints (known flames, known closures,
   * physically valid topology). Hazard exposure is compared lexicographically (safe first) rather
   * than converted with a large weight. A switch needs a gain larger than the person's switching
   * cost (4–10 s, or 12 % of the remaining time); returning to a route abandoned in the last 60 s
   * needs twice that; a non-urgent switch is not allowed within 15 s of the previous one.
   *
   * Returns true when the route changed, false when the current plan is kept or nothing usable
   * exists, null when the evaluation was deferred (planning budget or no-route back-off).
   */
  private rerouteAgent(
    agent: RuntimeAgent,
    currentNodeId: string,
    perceivedFires = this.knownFireSources(agent),
    reservedOverride?: Map<string, number>,
    routeEdgeMapOverride?: Map<string, SimEdge>,
    trigger: RerouteTrigger = "recovery",
    context: { queueSeconds?: number; hazardLabel?: string; closedEdgeId?: string } = {},
  ): boolean | null {
    const inFlame = agent.flameContactSeconds > 0.05;
    if (this.time < agent.noRouteRetryAt && !inFlame) return null;
    const forceRecovery = agent.status === "blocked" || agent.decisionState === "safe-stop" || inFlame;
    const coordinated = this.decisionMode === "coordinated";
    const goals = this.graph.nodes.filter((node) => node.type === "assembly"
      && (node.id === agent.route.goalId || this.goalCount(node.id) < node.capacity)).map((node) => node.id);
    const routeEdgeMap = routeEdgeMapOverride ?? this.edgeMap;
    const knownClosed = this.planningClosures(agent);
    const avoiding = this.hazardAvoidance(agent);
    avoiding.forEach((edgeId) => knownClosed.add(edgeId));
    const reserved = coordinated ? (reservedOverride ?? this.planningReservedCache) : this.perceivedReserved(agent);
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
    // Hundreds of people can reach the same decision point at once. People with the same
    // information share one candidate search (the final choice is still personal).
    const profileBand = sharedOutdoorRecovery
      ? `field-shared:${queueBand}`
      : perceivedFires.length
        ? `${riskBand}:${smokeBand}:${queueBand}:${exposureBand}`
        : `clear:${queueBand}`;
    const fireSignature = fireRouteZoneSignature(perceivedFires);
    const forecastHorizon = Math.min(18, 4.5 + Math.max(1, agent.floor) * 1.35 + agent.decisionLatency * 0.8);
    const routeTimeBucket = Math.floor(this.time / 2.5);
    const closedSignature = [...knownClosed].sort().join(",");
    const loadSignature = coordinated ? "global" : String(hashString([...reserved.entries()]
      .filter(([, people]) => people >= 2).map(([edgeId, people]) => `${edgeId}:${Math.round(people / 3)}`).sort().join(",")));
    const cacheKey = `${currentNodeId}:${this.config.preset}:${routeTimeBucket}:${fireSignature}:${socialGoal}:${profileBand}:${Math.round(forecastHorizon)}:${closedSignature}:${loadSignature}`;
    const cached = this.reroutePathCache.get(cacheKey);
    let nextPath: RoutePath | null;
    const cacheFresh = Boolean(cached && this.time - cached.at < 3);
    const cachedForecast = cacheFresh && cached?.path
      ? this.forecastRouteSurvival(agent, cached.path, perceivedFires, reserved, routeEdgeMap, knownClosed)
      : null;
    let socialChoice = false;
    if (cacheFresh && cached && (cached.path === null || (cachedForecast?.survivable && goals.includes(cached.path.goalId)))) {
      // Includes negative results: a failed search is not repeated for the same information.
      nextPath = cached.path;
    } else {
      if (this.reroutePlanningBudget <= 0) return null;
      this.reroutePlanningBudget -= 1;
      this.planSearches += 1;
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
          ...kShortestPaths(this.graph, currentNodeId, [goalId], personalConfig, perceivedFires, planningTime, reserved, perceivedFires.length ? 2 : 1, knownClosed),
          ...(perceivedFires.length
            ? kShortestPaths(this.graph, currentNodeId, [goalId], safetyConfig, perceivedFires, this.time + forecastHorizon, reserved, 1, knownClosed)
            : []),
        ];
        alternatives.forEach((path) => {
          if (routeIsPhysicallyValid(this.graph, path, this.nodeMap, this.edgeMap)) candidateMap.set(path.nodeIds.join(">"), path);
        });
      }
      const forecasts = [...candidateMap.values()]
        .map((path) => this.forecastRouteSurvival(agent, path, perceivedFires, reserved, routeEdgeMap, knownClosed))
        .filter((forecast) => Number.isFinite(forecast.eta))
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
      socialChoice = socialIsReasonable && socialForecast!.path !== individuallyBest?.path;
      if (socialIsReasonable && nextPath?.goalId === socialGoal && agent.decisionState !== "avoiding-hazard") {
        agent.decisionState = "following-group";
      }
      this.reroutePathCache.set(cacheKey, { at: this.time, path: nextPath });
      if (this.reroutePathCache.size > 6000) this.reroutePathCache.clear();
    }
    agent.lastRerouteAt = this.time;
    agent.lastEvaluationAt = this.time;
    if ((!nextPath || nextPath.edgeIds.length === 0) && avoiding.length) {
      // Planning around the remembered passages leaves no way at all: forget them and plan again
      // with them (a smoky passage is better than none); the hold rule still slows repeated tries.
      agent.hazardAvoid?.clear();
      agent.noRouteRetryAt = this.time + HAZARD_HOLD_RETRY_S;
      return null;
    }
    if (!nextPath || nextPath.edgeIds.length === 0) {
      // Nothing usable with what this person knows. Back off exponentially (1.5 → 24 s) so the
      // failure is not recomputed every frame, and hold position meanwhile.
      agent.noRouteFailures += 1;
      const retryIn = Math.min(24, 1.5 * 2 ** Math.min(4, agent.noRouteFailures - 1))
        * (0.85 + 0.3 * seeded01(this.seed, agent.id, `retry:${agent.noRouteFailures}`));
      agent.noRouteRetryAt = this.time + retryIn;
      agent.reason = { code: "no-route-reassess", at: this.time, params: { retryIn } };
      return false;
    }
    const remainingEdges = agent.route.edgeIds.slice(agent.edgeIndex);
    const currentRemainingPath: RoutePath = {
      ...agent.route,
      nodeIds: agent.route.nodeIds.slice(agent.edgeIndex),
      edgeIds: remainingEdges,
    };
    const currentForecast = remainingEdges.length
      ? this.forecastRouteSurvival(agent, currentRemainingPath, perceivedFires, reserved, routeEdgeMap, knownClosed)
      : null;
    const nextForecast = this.forecastRouteSurvival(agent, nextPath, perceivedFires, reserved, routeEdgeMap, knownClosed);
    const sameRoute = nextPath.edgeIds.join("|") === remainingEdges.join("|");
    const currentUsable = Boolean(currentForecast && !currentForecast.blocked && Number.isFinite(currentForecast.eta));
    const urgent = trigger === "hazard" || trigger === "closed";
    if (!forceRecovery && currentUsable && currentForecast!.survivable) {
      if (!nextForecast.survivable || sameRoute) {
        if (trigger === "queue" || trigger === "periodic") {
          agent.reason = { code: "keep-route-with-queue", at: this.time, params: { current: currentForecast!.eta, best: nextForecast.eta } };
        }
        agent.noRouteFailures = 0;
        return false;
      }
      if (!urgent && this.time - agent.lastSwitchAt < 15) {
        agent.reason = { code: "keep-route-cooldown", at: this.time };
        return false;
      }
      const gain = currentForecast!.eta - nextForecast.eta;
      const abandonedAt = agent.abandonedRoutes.get(nextPath.edgeIds.join("|"));
      const flipFlop = abandonedAt != null && this.time - abandonedAt < 60;
      // Herding: in a competitive crowd a better option has to be clearly better before a person
      // leaves the stream everybody else is in — and someone already pressed into the crowd at the
      // mouth (within ~2 m) does not give up the place they fought for unless there is danger.
      const herd = this.competitiveness * (0.5 + agent.stress);
      const pressedIn = this.competitiveness > 0 && agent.status === "queueing" && (this.queueRemainingCache.get(agent.id) ?? Infinity) < 2;
      const required = Math.max(agent.switchCostSeconds, currentForecast!.eta * 0.12) * (flipFlop ? 2 : 1) * (1 + herd);
      if (pressedIn || gain < required) {
        if (pressedIn || herd > 0.4) {
          agent.reason = { code: "keep-route-crowd", at: this.time, params: { current: currentForecast!.eta, best: nextForecast.eta } };
          return false;
        }
        agent.reason = { code: "keep-route-with-queue", at: this.time, params: { current: currentForecast!.eta, best: nextForecast.eta } };
        return false;
      }
    } else if (!forceRecovery && currentUsable) {
      if (nextForecast.blocked) return false;
      const marginGain = nextForecast.survivalMargin - currentForecast!.survivalMargin;
      const dangerGain = currentForecast!.danger - nextForecast.danger;
      if (marginGain < 0.025 && dangerGain < 0.05) return false;
    }
    if (!forceRecovery && sameRoute) return false;
    const previousVia = this.routeViaLabel(agent.route);
    if (!sameRoute || agent.assemblySlotIndex < 0) {
      if (!this.commitRoute(agent, nextPath)) return false;
    } else {
      this.leaveCurrentQueue(agent);
      agent.route = nextPath;
    }
    agent.noRouteFailures = 0;
    agent.noRouteRetryAt = -Infinity;
    agent.edgeIndex = 0;
    agent.edgeEntered = false;
    agent.edgePath = [];
    agent.segmentIndex = 0;
    agent.segmentProgress = 0;
    agent.status = "rerouting";
    if (agent.decisionState !== "avoiding-hazard" && agent.decisionState !== "following-group") agent.decisionState = "assessing";
    agent.currentNodeId = currentNodeId;
    this.updateContextFromNode(agent, this.nodeMap.get(currentNodeId));
    const to = this.routeViaLabel(nextPath);
    if (sameRoute) {
      // A held person trying the very same passage again is not a route change: do not report a
      // switch or inflate the reroute count (the 4 s hold retry used to add ~220 "reroutes").
      agent.reason = { code: "retry-same-route", at: this.time, params: { via: to } };
      return true;
    }
    if (coordinated) agent.reason = { code: "switch-controller", at: this.time, params: { to } };
    else if (trigger === "closed") agent.reason = { code: "switch-closed", at: this.time, params: { closed: this.passageLabel(context.closedEdgeId), to } };
    else if (trigger === "hazard" || (trigger === "recovery" && perceivedFires.length)) agent.reason = { code: "switch-hazard", at: this.time, params: { hazard: context.hazardLabel ?? "อันตราย", to } };
    else if (socialChoice) agent.reason = { code: "follow-group", at: this.time, params: { to } };
    else if (trigger === "queue" || trigger === "periodic") {
      agent.reason = { code: "switch-shorter-queue", at: this.time, params: { from: previousVia, to, wait: context.queueSeconds ?? Math.max(0, (currentForecast?.eta ?? 0) - nextForecast.eta) } };
    } else agent.reason = { code: "follow-plan", at: this.time, params: { via: to } };
    agent.routeReason = agent.reason;
    this.rerouteCount += 1;
    this.countRerouteReason(agent.reason.code);
    if (this.rerouteCount <= 40 || this.rerouteCount % 25 === 0) {
      this.pushEvent("warning", "คำนวณเส้นทางอพยพใหม่", `Agent #${agent.id}: ${describeReasonTh(agent.reason)}`);
    }
    return true;
  }

  private markArrived(agent: RuntimeAgent) {
    if (agent.status === "arrived") return;
    this.pendingDetourAgents.delete(agent.id);
    this.leaveCurrentQueue(agent);
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
    agent.reason = { code: "arrived", at: this.time };
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
      behavior: agent.behavior,
      awareness: agent.awareness,
      reasonCode: agent.reason.code,
      routeSwitches: agent.routeSwitches,
    }));
  }

  /**
   * Decision inspector: everything shown is read from the fields the decision logic actually
   * used (state, awareness source, destination, reason code + parameters, perceived queue/hazard).
   */
  inspectAgent(id: number) {
    const agent = this.agents[id];
    if (!agent || agent.id !== id) return null;
    const goal = this.nodeMap.get(agent.route.goalId);
    const nextEdgeId = agent.route.edgeIds[agent.edgeIndex];
    // Time-dependent parameters are recomputed from the same fields the runtime uses.
    const liveReason: DecisionReason = agent.reason.code === "pre-movement"
      ? { ...agent.reason, params: { ...agent.reason.params, remaining: Math.max(0, agent.responseDelay - this.time) } }
      : agent.reason.code === "no-route-reassess"
        ? { ...agent.reason, params: { ...agent.reason.params, retryIn: Math.max(0, agent.noRouteRetryAt - this.time) } }
        : agent.reason;
    const knownFires = [...agent.fireKnowledge.entries()].map(([fireId, belief]) => ({
      fireId,
      source: belief.source,
      controller: Boolean(belief.controller),
      ageSeconds: this.time - belief.observedAt,
      confidence: belief.source === "reported" && !belief.controller
        ? belief.confidence * Math.max(0, 1 - (this.time - belief.observedAt) / REPORT_LIFETIME_SECONDS)
        : belief.confidence,
      uncertaintyMeters: belief.uncertainty,
    }));
    const queues = [...agent.queueMemory.entries()]
      .filter(([, observation]) => this.time - observation.at <= QUEUE_MEMORY_SECONDS && observation.wait > 0.5)
      .sort((a, b) => b[1].wait - a[1].wait).slice(0, 4)
      .map(([edgeId, observation]) => ({ edgeId, label: this.passageLabel(edgeId), waitSeconds: observation.wait, ageSeconds: this.time - observation.at }));
    return {
      id: agent.id,
      roomId: agent.roomId,
      position: [...agent.position] as Vec3,
      floor: agent.floor,
      status: agent.status,
      behavior: agent.behavior,
      behaviorLabel: BEHAVIOR_LABEL_TH[agent.behavior],
      awareness: agent.awareness,
      awarenessLabel: AWARENESS_LABEL_TH[agent.awareness],
      awareAt: agent.awareAt,
      goalId: agent.route.goalId,
      goalLabel: goal?.name ?? agent.route.goalId,
      viaLabel: this.routeViaLabel(agent.route),
      nextPassage: nextEdgeId ? this.passageLabel(nextEdgeId) : null,
      reason: liveReason,
      reasonText: describeReasonTh(liveReason),
      routeReason: agent.routeReason,
      routeReasonText: describeReasonTh(agent.routeReason),
      lastEvaluationAt: Number.isFinite(agent.lastEvaluationAt) ? agent.lastEvaluationAt : null,
      routeSwitches: agent.routeSwitches,
      knownFires,
      knownClosed: [...agent.knownClosed.keys()].map((edgeId) => this.passageLabel(edgeId)),
      perceivedQueues: queues,
      perceivedSmoke: agent.perceivedSmoke,
      perceivedHeat: agent.perceivedHeat,
      visibility: agent.visibility,
      traits: {
        speed: agent.speed,
        responseDelay: agent.responseDelay,
        familiarity: agent.familiarity,
        riskAversion: agent.riskAversion,
        groupCohesion: agent.groupCohesion,
        switchCostSeconds: agent.switchCostSeconds,
      },
      decisionMode: this.decisionMode,
      time: this.time,
    };
  }

  /** Ids of a few people in a given behaviour state, for the inspector's quick picks. */
  findAgents(predicate: "rerouted" | "queueing" | "holding" | "aware-of-fire" | "any", limit = 1): number[] {
    const result: number[] = [];
    for (const agent of this.agents) {
      const match = predicate === "any" ? agent.status !== "arrived"
        : predicate === "rerouted" ? agent.routeSwitches > 0 && agent.status !== "arrived"
          : predicate === "queueing" ? agent.status === "queueing"
            : predicate === "holding" ? agent.behavior === "holding"
              : agent.fireKnowledge.size > 0 && agent.status !== "arrived";
      if (match) { result.push(agent.id); if (result.length >= limit) break; }
    }
    return result;
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
    let holding = 0, unaware = 0, stateInconsistencies = 0;
    let clogEvents = 0, cloggedSeconds = 0;
    this.edgeQueues.forEach((queue) => { clogEvents += queue.clogs; cloggedSeconds += queue.cloggedSeconds; });
    let maxModeledTemperatureC = this.config.ambientTemperatureC ?? 29;
    const floorPopulation = Array.from({ length: 10 }, () => 0);
    const wingPopulation: Record<AgentWing, number> = { pink: 0, blue: 0, core: 0, ground: 0, outdoor: 0, assembly: 0, "building-3":0, "building-4":0 };
    const arrivals: number[] = [];
    const waitingByEdge = new Map<string, number>();
    const stuckByReason = new Map<string, { count: number; example: DecisionReason }>();
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
      if (agent.behavior === "holding") {
        holding += 1;
        const entry = stuckByReason.get(agent.reason.code);
        if (entry) entry.count += 1; else stuckByReason.set(agent.reason.code, { count: 1, example: agent.reason });
      }
      if (agent.behavior === "unaware") unaware += 1;
      // Contradictory public states (e.g. arrived but still on a stair or in a queue).
      const contradictory = (agent.status === "arrived" && (agent.phase !== "assembly" || agent.floor !== 0 || !agent.hasExitedBuilding || agent.queueKey !== null || agent.edgeEntered))
        || (agent.status === "incapacitated" && (agent.edgeEntered || agent.queueKey !== null))
        || (agent.status === "queueing" && agent.queueKey === null)
        || (agent.behavior === "arrived") !== (agent.status === "arrived")
        || (agent.behavior === "incapacitated") !== (agent.status === "incapacitated")
        || !agent.position.every(Number.isFinite);
      if (contradictory) stateInconsistencies += 1;
    });

    // A bottleneck is where people are delayed: those waiting at the entrance plus the crowd on the
    // passage beyond its free-flow density (0.54 p/m²), cleared at the passage's service rate.
    const delayedByEdge = new Map<string, { people: number; seconds: number }>();
    for (const edge of this.graph.edges) {
      const waiting = waitingByEdge.get(edge.id) ?? 0;
      const occupants = this.activeEdgeCountsCache.get(edge.id) ?? 0;
      const excess = Math.max(0, occupants - effectiveEdgeArea(edge) * 0.54);
      const people = waiting + excess;
      if (people >= 1) delayedByEdge.set(edge.id, { people, seconds: people / this.crowdServiceRate(edge) });
    }
    const bottlenecks: BottleneckMetric[] = [...delayedByEdge.entries()].map(([edgeId, delayed]) => {
      const edge = this.edgeMap.get(edgeId)!;
      return {
        edgeId,
        name: this.edgeName(edge),
        queueSeconds: delayed.seconds,
        capacityPerSecond: this.crowdServiceRate(edge),
        reservedPeople: Math.round(delayed.people),
        utilization: Math.min(9.99, delayed.people / Math.max(1, this.crowdServiceRate(edge) * 10)),
      };
    }).sort((a, b) => b.queueSeconds - a.queueSeconds).slice(0, 6);

    const activeQueueSeconds = [...delayedByEdge.values()].map((delayed) => delayed.seconds);
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
      stuckReasons: [...stuckByReason.entries()].map(([code, { count, example }]) => ({ code, label: shortReasonTh(code, example), count }))
        .sort((a, b) => b.count - a.count).slice(0, 5),
      rerouteReasons: [...this.rerouteReasonCounts.entries()].map(([code, count]) => ({ code, label: code === "emergency-exit-flame" ? "ออกจากเปลวไฟทันที" : shortReasonTh(code), count }))
        .sort((a, b) => b.count - a.count).slice(0, 5),
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
      holding,
      unaware,
      closedPassages: this.closedEdges.size,
      staleQueueRepairs: this.staleQueueRepairs,
      squeezeEvents: this.squeezeEvents,
      clogEvents,
      cloggedSeconds,
      phoneFollowed: this.phoneFollowed,
      phoneIgnored: this.phoneIgnored,
      peakMouthDensity: this.peakMouthDensity,
      dangerousCrowdSeconds: this.dangerousCrowdSeconds,
      competitiveness: this.competitiveness,
      stateInconsistencies,
      decisionMode: this.decisionMode,
      seed: this.seed,
    };
  }

  private edgeName(edge: SimEdge) {
    if (edge.kind === "stair") {
      const b1 = edge.id.match(/^edge-stair-(left|center|right)-(\d+)-(\d+)$/);
      if (b1) return `บันได${b1[1] === "left" ? "ซ้าย" : b1[1] === "right" ? "ขวา" : "กลาง"} อาคาร 1 ชั้น ${b1[2]}→${b1[3]}`;
      const campus = edge.id.match(/^campus-b(\d)-stair-(\d)-down-(\d+)$/);
      if (campus) return `บันได ${Number(campus[2]) + 1} อาคาร ${campus[1]} ชั้น ${campus[3]}→${Number(campus[3]) - 1}`;
      return `บันได ${edge.id.replace("edge-stair-", "")}`;
    }
    if (edge.id === BRIDGE_EDGE_ID) return BRIDGE_LABEL_TH;
    // Names people can read (from the graph's own place names), never internal ids.
    const from = placeNameTh(this.nodeMap.get(edge.from)?.name ?? ""), to = placeNameTh(this.nodeMap.get(edge.to)?.name ?? "");
    if (edge.kind === "room") return from ? `ประตู ${from}` : "ประตูห้องเรียน";
    if (edge.kind === "corridor" || edge.kind === "junction") return to && !/^ประตู/.test(to) ? to : from || `ทางเดินชั้น ${edge.floorFrom}`;
    if (edge.kind === "assembly") return to ? `เข้า ${to}` : "เข้าจุดรวมพล";
    return from && to ? `${from} → ${to}` : `ทางเดินชั้น ${edge.floorFrom}`;
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
    return activeRoomPopulation(this.config.populationTarget, this.config.roomPopulation);
  }
}

export const evacuationRuntime = new EvacuationRuntime();
