import type { AgentBehaviorState, AwarenessSource, DecisionReasonCode } from "./agentReasons";

export type Vec3 = [number, number, number];

export type AgentWing = "pink" | "blue" | "core" | "ground" | "outdoor" | "assembly" | "building-3" | "building-4";
export type AgentPhase = "room" | "corridor" | "stair" | "ground" | "outdoor" | "assembly";

export type SimNodeType = "room" | "door" | "corridor" | "junction" | "stair" | "exit" | "gate" | "assembly";
export type SimEdgeKind = "room" | "corridor" | "junction" | "stair" | "exit" | "outdoor" | "assembly";
export type SimulationStatus = "idle" | "running" | "paused" | "completed";
export type RoutingPreset = "fastest" | "balanced" | "safest";
export type CrowdBehavior = "orderly" | "grouped" | "surge";
/**
 * occupant: each person decides from what they personally perceive or are told (default).
 * coordinated: a controller with whole-building information assigns and updates routes.
 */
export type DecisionMode = "occupant" | "coordinated";
export type AgentStatus = "waiting" | "evacuating" | "queueing" | "rerouting" | "arrived" | "blocked" | "incapacitated";
export type StudentGender = "male" | "female";
export type HazardAwareness = "none" | "reported" | "smoke" | "heat" | "direct";
export type SmokeAwareness = "none" | "reported" | "smelled" | "visible";
export type HeatAwareness = "none" | "reported" | "sensed" | "painful";
export type AgentDecisionState = "waiting" | "following-plan" | "assessing" | "following-group" | "avoiding-hazard" | "safe-stop";

export interface SimNode {
  id: string;
  name: string;
  type: SimNodeType;
  position: Vec3;
  floor: number;
  capacity: number;
  wing: AgentWing;
  phase: AgentPhase;
}

export interface SimEdge {
  id: string;
  from: string;
  to: string;
  kind: SimEdgeKind;
  distance: number;
  width: number;
  capacityPerSecond: number;
  speedMultiplier: number;
  twoWay: boolean;
  /** Ordered from `from` to `to`. Endpoints are optional; runtime adds them safely. */
  waypoints?: Vec3[];
  /** Indoor edges may never be treated as an outdoor shortcut. */
  insideBuilding: boolean;
  floorFrom: number;
  floorTo: number;
}

export interface SimGraph {
  nodes: SimNode[];
  edges: SimEdge[];
}

export interface FireSource {
  id: string;
  position: Vec3;
  startTime: number;
  intensity: number;
  fireRadius: number;
  smokeRadius: number;
  spreadRate: number;
  enabled: boolean;
  floor: number;
  wing: AgentWing;
  origin: "primary" | "spread";
  generation: number;
  parentId?: string;
  hasSpread: boolean;
  /** Physical school object/node that is currently burning. Propagation follows graph edges only. */
  attachmentNodeId?: string;
  attachmentKind?: Extract<SimNodeType, "room" | "door" | "corridor" | "junction" | "stair">;
  /**
   * Ordered physical route followed by a propagated flame front. The child object's
   * `startTime` is the destination ignition time. Before arrival, only the already
   * reached, visibly burning cells on this path can injure an occupant.
   */
  spreadPath?: Vec3[];
  spreadTravelStartTime?: number;
}

export interface RoutePath {
  nodeIds: string[];
  edgeIds: string[];
  distance: number;
  estimatedTime: number;
  risk: number;
  congestion: number;
  totalCost: number;
  bottleneckCapacity: number;
  goalId: string;
}

export interface RouteBundle {
  roomId: string;
  peopleCount: number;
  path: RoutePath;
}

export interface SimulationConfig {
  populationTarget: number;
  preset: RoutingPreset;
  walkingSpeed: number;
  responseDelayMin: number;
  responseDelayMax: number;
  rerouteInterval: number;
  distanceWeight: number;
  timeWeight: number;
  congestionWeight: number;
  fireWeight: number;
  smokeWeight: number;
  fireSpreadEnabled: boolean;
  crowdBehavior: CrowdBehavior;
  /** Approximate thermal-model controls (°C). */
  ambientTemperatureC?: number;
  heatAvoidThresholdC?: number;
  hardBlockTemperatureC?: number;
  thermalLookAheadEdges?: number;
  thermalWeight?: number;
  /** Seed for per-person traits and decision phases (same seed + scenario ⇒ same run). */
  seed?: number;
  /** Whose information drives route choice. Defaults to "occupant". */
  decisionMode?: DecisionMode;
}

export interface AgentPublicSnapshot {
  id: number;
  gender: StudentGender;
  position: Vec3;
  status: AgentStatus;
  roomId: string;
  routeGoalId: string;
  floor: number;
  wing: AgentWing;
  phase: AgentPhase;
  currentNodeId: string;
  knownFireCount: number;
  hazardAwareness: HazardAwareness;
  smokeAwareness: SmokeAwareness;
  heatAwareness: HeatAwareness;
  perceivedSmoke: number;
  perceivedHeat: number;
  visibility: number;
  decisionState: AgentDecisionState;
  stress: number;
  health: number;
  /** Continuous time physically inside a flame envelope; smoke/heat alone never increment it. */
  flameContactSeconds: number;
  smokeDose: number;
  heatDose: number;
  protectivePosture: boolean;
  incapacitatedAt: number | null;
  hasPassedRoomDoor: boolean;
  hasExitedBuilding: boolean;
  behavior: AgentBehaviorState;
  awareness: AwarenessSource;
  reasonCode: DecisionReasonCode;
  routeSwitches: number;
}

export interface BottleneckMetric {
  edgeId: string;
  name: string;
  queueSeconds: number;
  capacityPerSecond: number;
  reservedPeople: number;
  utilization: number;
}

export interface SimulationEvent {
  id: string;
  time: number;
  severity: "info" | "warning" | "danger" | "success";
  title: string;
  detail: string;
}

/** How many people share one reason (results screen: why people are stuck / why they switched). */
export interface ReasonCount {
  code: string;
  label: string;
  count: number;
}

export interface SimulationMetrics {
  total: number;
  arrived: number;
  waiting: number;
  evacuating: number;
  queueing: number;
  rerouting: number;
  blocked: number;
  incapacitated: number;
  exposedToSmoke: number;
  smokeAware: number;
  heatAware: number;
  exposedToHeat: number;
  progress: number;
  elapsed: number;
  firstArrival: number | null;
  p50Arrival: number | null;
  p90Arrival: number | null;
  p95Arrival: number | null;
  finalArrival: number | null;
  averageArrival: number | null;
  rerouteCount: number;
  thermalRerouteCount: number;
  /** People who cannot proceed right now (holding), grouped by the reason they show. */
  stuckReasons: ReasonCount[];
  /** Route changes so far, grouped by why the person switched. */
  rerouteReasons: ReasonCount[];
  estimatedMakespan: number;
  maxModeledTemperatureC: number;
  blockedThermalEdges: number;
  fireBlockedEdges: number;
  smokeAffectedEdges: number;
  maxQueue: number;
  averageQueue: number;
  bottlenecks: BottleneckMetric[];
  indoorAgents: number;
  stairAgents: number;
  outdoorAgents: number;
  topologyViolations: number;
  collisionCorrections: number;
  peakEdgeDensity: number;
  floorPopulation: number[];
  wingPopulation: Record<AgentWing, number>;
  /** People who are aware but cannot currently find a usable route (holding / no route). */
  holding: number;
  /** People who have not yet perceived the emergency. */
  unaware: number;
  /** Passages closed in the scenario (world truth). */
  closedPassages: number;
  /** Queue/reservation entries that had to be repaired (must stay 0). */
  staleQueueRepairs: number;
  /** Times somebody squeezed past another line after standing still ≥ 10 s (deadlock safety net). */
  squeezeEvents: number;
  /** Times an opening jammed (an arch of people pressed in the doorway) in a competitive crowd. */
  clogEvents: number;
  /** Total seconds openings were jammed. */
  cloggedSeconds: number;
  /** Highest crowd density measured at an opening mouth (people/m²). */
  peakMouthDensity: number;
  /** Seconds (summed over openings) with ≥ 6 people/m² at an opening — crush/fall risk. */
  dangerousCrowdSeconds: number;
  /** Simulator A: route changes people took from their phone / phone routes they ignored. */
  phoneFollowed: number;
  phoneIgnored: number;
  /** 0 = orderly drill (people line up), 0.55 real-life crowding, 0.9 surge. */
  competitiveness: number;
  /** Agents whose public state contradicts itself (must stay 0). */
  stateInconsistencies: number;
  decisionMode: DecisionMode;
  seed: number;
}
