/**
 * Shared contract between the incident backend, the main control dashboard and the mobile PWA.
 * Plain data only (no React, no three.js) so the server, the dashboard and /mobile all compile
 * the very same definitions.
 */

/** Simulation: everything simulated, never reaches real users. Drill: real participants, every
 * screen says "ฝึกซ้อม". Live: real incident — disabled unless the server is explicitly configured. */
export type IncidentMode = "simulation" | "drill" | "live";
export type IncidentPhase = "standby" | "evacuate" | "ended";

export type Role = "participant" | "teacher" | "staff" | "map-admin" | "sensor-gateway" | "preview";

/** Where a position came from. Nothing here claims continuous indoor tracking. */
/** "simulator": the position of a person the user controls in the 3D roleplay simulator (simulation incidents only). */
export type LocationSource = "qr" | "manual" | "geolocation" | "teacher" | "demo-simulated" | "simulator";
export type LocationConfidence = "high" | "medium" | "low" | "unknown";
/** confirmed: fresh and consistent · stale: too old to route from as current · uncertain: floor or
 * point not known (e.g. rejected jump, geolocation without a calibrated map) · unknown: never set. */
export type LocationState = "confirmed" | "stale" | "uncertain" | "unknown";

export interface LocationFix {
  buildingId: string;
  floor: number;
  /** Zone = building:floor:wing — same zone key the crowd simulator uses for reports. */
  zoneId: string | null;
  checkpointId: string | null;
  nodeId: string | null;
  source: LocationSource;
  /** ms since epoch, measured on the device (client clock, may be wrong). */
  observedAt: number;
  /** ms since epoch, server clock. */
  receivedAt: number;
  accuracyM: number | null;
  confidence: LocationConfidence;
  mapVersion: string;
  /** Simulator only: exact position in model coordinates (m) and view heading (deg, 0 = −Z, clockwise). */
  position?: [number, number, number] | null;
  headingDeg?: number | null;
}

export type SensorType = "smoke" | "heat" | "flame" | "manual-call-point" | "door-contact" | "people-counter";
export type SensorStatus = "normal" | "alarm" | "fault" | "offline" | "unknown" | "test";
export type DataMode = "simulated" | "drill" | "live";

export interface SensorReading {
  sensorId: string;
  type: SensorType;
  /** Numeric reading where meaningful (°C, obscuration %/m, people count); null for contacts. */
  value: number | null;
  unit: string | null;
  status: SensorStatus;
  eventId: string;
  sequence: number;
  observedAt: number;
  quality: "good" | "suspect" | "bad";
  mode: DataMode;
}

export interface SensorInfo {
  sensorId: string;
  type: SensorType;
  buildingId: string;
  floor: number;
  zoneId: string;
  /** Graph node the sensor is installed next to (its measured area). */
  nodeId: string;
  label: string;
  /** Registered sensors only exist as simulator entries until real hardware is surveyed. */
  simulatedOnly: boolean;
}

export interface SensorState extends SensorInfo {
  status: SensorStatus;
  lastValue: number | null;
  unit: string | null;
  lastObservedAt: number | null;
  lastReceivedAt: number | null;
  lastSequence: number;
  mode: DataMode | null;
  quality: SensorReading["quality"] | null;
  /** Problems found in the incoming data (duplicates, out-of-order, wrong unit, out of range…). */
  issues: string[];
}

export type ManeuverKind = "start" | "leave-room" | "walk" | "stair-down" | "stair-up" | "bridge" | "exit" | "outdoor" | "assembly";

export interface Maneuver {
  index: number;
  kind: ManeuverKind;
  /** Thai instruction built from map landmarks (never left/right — heading is not known). */
  text: string;
  landmark: string;
  buildingId: string;
  floor: number;
  /** Graph nodes covered by this step (first … last). */
  nodeIds: string[];
  edgeIds: string[];
  distanceM: number;
}

export type AdviceStatus = "ok" | "no-route" | "no-location" | "stale-location" | "mobility-no-route" | "not-evacuating";

export interface RouteReason {
  code: "initial" | "closure" | "hazard" | "congestion" | "location-changed" | "mobility" | "manual";
  text: string;
}

export interface RouteAdvice {
  incidentId: string;
  routeId: string;
  /** Increases every time this participant's advice changes. Older revisions must be ignored. */
  routeRevision: number;
  mapVersion: string;
  hazardRevision: number;
  closureRevision: number;
  issuedAt: number;
  /** After this time the client must stop presenting the route as current. */
  expiresAt: number;
  status: AdviceStatus;
  start: { nodeId: string | null; locationState: LocationState; source: LocationSource | null; observedAt: number | null };
  destination: { nodeId: string; name: string } | null;
  nodeIds: string[];
  edgeIds: string[];
  maneuvers: Maneuver[];
  /** Present when the route changed for a reason the participant should know. */
  reason: RouteReason | null;
  previousRouteId: string | null;
  estimatedSeconds: number | null;
  message: string;
}

export interface Announcement {
  id: string;
  templateId: string;
  text: string;
  issuedAt: number;
}

export interface ArrivalState {
  /** The participant pressed "ถึงจุดรวมพลแล้ว" — a claim, not a safety confirmation. */
  selfReportedAt: number | null;
  selfReportedAssemblyId: string | null;
  /** A teacher/staff confirmed this participant in person. */
  teacherConfirmedAt: number | null;
}

export interface IncidentSummary {
  id: string;
  mode: IncidentMode;
  phase: IncidentPhase;
  title: string;
  joinCode: string;
  createdAt: number;
  evacuateAt: number | null;
  endedAt: number | null;
  hazardRevision: number;
  closureRevision: number;
  /** Plain-language hazards relevant to everyone (zone + sensor type), not the full sensor list. */
  hazards: Array<{ zoneId: string; label: string; kind: "measured" | "estimated" | "simulated"; since: number }>;
  /** Simulation incidents fed by the 3D simulator adapter: when the last world snapshot arrived. */
  simWorld?: { source: "simulator-ground-truth"; receivedAt: number; simTime: number; blockedEdges: number; crowdedEdges: number } | null;
  closedEdgeIds: string[];
  announcements: Announcement[];
}

/** Everything one phone needs. Pushed whole on every change, with a monotonic revision. */
export interface ParticipantView {
  revision: number;
  serverTime: number;
  mapVersion: string;
  incident: IncidentSummary | null;
  me: {
    participantId: string;
    displayName: string;
    isTest: boolean;
    /** The person a user controls in the roleplay simulator (always a test participant). */
    isPlayer?: boolean;
    mobility: "standard" | "no-stairs";
    location: LocationFix | null;
    locationState: LocationState;
    locationNote: string | null;
    arrival: ArrivalState;
    helpRequestedAt: number | null;
  };
  advice: RouteAdvice | null;
  /**
   * Passages the system currently knows are unsafe (sensor alarm, or the 3D simulation's fire in
   * simulation rounds) or closed by staff — drawn on the phone's plan. Optional for older servers.
   */
  hazards?: { blockedEdgeIds: string[]; closedEdgeIds: string[]; revision: number } | null;
}

export type DeliveryStage = "accepted" | "sent" | "received" | "viewed" | "confirmed";

export interface ParticipantRow {
  participantId: string;
  displayName: string;
  isTest: boolean;
  /** The roleplay simulator's character (SIMULATOR only). */
  isPlayer?: boolean;
  connected: boolean;
  connections: number;
  lastSeenAt: number | null;
  location: LocationFix | null;
  locationState: LocationState;
  routeId: string | null;
  routeRevision: number;
  adviceStatus: AdviceStatus | null;
  destinationName: string | null;
  nextInstruction: string | null;
  delivery: Record<DeliveryStage, number | null>;
  arrival: ArrivalState;
  helpRequestedAt: number | null;
  blockedReports: number;
}

export interface ZoneOccupancy {
  zoneId: string;
  label: string;
  /** Registered participants whose latest *confirmed* location is here. */
  participants: number;
  /** Their devices with an open stream right now. */
  connectedDevices: number;
  /** Planned headcount from the school's room allocation (rooms in this zone). */
  plannedHeadcount: number;
  /** Teacher headcount, when a teacher has entered one. */
  teacherCount: number | null;
  teacherCountAt: number | null;
  /** Best estimate and how sure we are. Never "0 people" just because no phone reported. */
  estimate: number | null;
  coverage: "teacher" | "devices-partial" | "plan-only" | "none";
  /** Participants currently routed through this zone's passages. */
  routedThrough: number;
}

export interface BottleneckRow {
  edgeId: string;
  label: string;
  buildingId: string;
  floor: number;
  widthM: number;
  capacityPerSecond: number;
  /** Participants whose current advice uses this passage. */
  assigned: number;
  /** assigned / capacity (s): a rough clearance time, not a measured queue. */
  clearanceSeconds: number;
}

export interface EventLogEntry {
  seq: number;
  at: number;
  incidentId: string | null;
  actor: string;
  role: Role | "system";
  type: string;
  detail: string;
}

export interface StaffSnapshot {
  revision: number;
  serverTime: number;
  mapVersion: string;
  liveModeAvailable: boolean;
  liveReadiness: Array<{ id: string; label: string; ok: boolean }>;
  incidents: IncidentSummary[];
  activeIncidentId: string | null;
  participants: ParticipantRow[];
  counts: {
    connectedDevices: number;
    openStreams: number;
    sessions: number;
    registeredParticipants: number;
    testParticipants: number;
    withConfirmedLocation: number;
    staleOrUnknownLocation: number;
    selfReportedArrived: number;
    teacherConfirmed: number;
    plannedPopulation: number;
    /** Bots of the 3D crowd simulation carrying a simulated phone (simulation incidents only; not people). */
    simBots: number;
    simBotsRouted: number;
    simBotsArrived: number;
  };
  occupancy: ZoneOccupancy[];
  bottlenecks: BottleneckRow[];
  sensors: SensorState[];
  log: EventLogEntry[];
}

/** Messages on /api/stream (Server-Sent Events). `id:` carries a per-stream sequence number. */
export type StreamMessage =
  | { type: "participant"; view: ParticipantView }
  | { type: "staff"; snapshot: StaffSnapshot }
  | { type: "error"; code: string; message: string };

/** Map package served to phones and cached by the PWA (versioned, offline reference only). */
export interface MapPackage {
  mapVersion: string;
  generatedAt: string;
  buildings: Array<{ id: string; name: string; floors: number[] }>;
  nodes: Array<{ id: string; name: string; type: string; buildingId: string; floor: number; x: number; z: number; zoneId: string | null }>;
  edges: Array<{ id: string; from: string; to: string; kind: string; twoWay: boolean; floorFrom: number; floorTo: number }>;
  checkpoints: Array<{ id: string; nodeId: string; buildingId: string; floor: number; zoneId: string | null; name: string; kind: string }>;
  assemblies: Array<{ id: string; name: string; capacity: number }>;
  /** Statement shown with the offline map — it is the static plan, not live guidance. */
  offlineNote: string;
}

export const MAX_TEXT_LENGTH = 240;
