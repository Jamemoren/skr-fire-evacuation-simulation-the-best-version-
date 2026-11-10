/**
 * Incident service: the single source of truth that every device talks to. Holds incidents
 * (simulation / drill / live), participants and their sessions, positions, sensor states,
 * closures, route advice with revisions, delivery acknowledgements, occupancy estimates and an
 * append-only event log. Pure logic — HTTP and SSE live in index.ts.
 */
import { getMapRegistry, passageGroups, passageLabel, displayNodeName, zoneLabel, type MapRegistry } from "../src/evac/mapRegistry";
import { buildManeuvers } from "../src/evac/maneuvers";
import {
  clearlyBetter, computeRouteField, firstIneligibleEdge, pathFromField, routeCost, LOAD_WEIGHT,
  type MobilityProfile, type RouteField, type RoutingConstraints,
} from "../src/evac/routing";
import type {
  AdviceStatus, Announcement, ArrivalState, BottleneckRow, DataMode, DeliveryStage, EventLogEntry, IncidentMode, IncidentPhase,
  IncidentSummary, LocationFix, LocationSource, LocationState, ParticipantRow, ParticipantView, Role, RouteAdvice, RouteReason,
  SensorReading, SensorState, StaffSnapshot, ZoneOccupancy,
} from "../src/evac/protocol";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) { super(message); }
}

/** A position older than this is not used as "current" (QR confirms a moment, not a track). */
export const LOCATION_FRESH_MS = 120_000;
/** Advice must be re-issued before this; the phone stops presenting it as current afterwards. */
export const ADVICE_TTL_MS = 90_000;
/** Minimum time between two crowd-only route changes for the roleplay player. */
export const PLAYER_CONGESTION_COOLDOWN_MS = 8_000;
/** Fastest believable walking between two reports (m/s); faster jumps are flagged, not trusted. */
const MAX_PLAUSIBLE_SPEED = 3;
const HAZARD_BLOCK_RADIUS_M = 6;
const HAZARD_MARGIN_RADIUS_M = 15;
const HAZARD_MARGIN_SECONDS = 45;

export interface Incident {
  id: string;
  mode: IncidentMode;
  phase: IncidentPhase;
  title: string;
  joinCode: string;
  createdAt: number;
  createdBy: string;
  evacuateAt: number | null;
  endedAt: number | null;
  closedEdges: Map<string, { at: number; by: string; reason: string }>;
  closureRevision: number;
  hazardRevision: number;
  announcements: Announcement[];
  /** Sensor states in this incident's namespace (simulated/drill readings never leak to others). */
  sensors: Map<string, SensorState>;
  previewTickets: Map<string, { createdAt: number; used: boolean; kind?: "tester" | "player" }>;
  /**
   * Simulator adapter (simulation incidents only): ground truth of the 3D simulation — passages
   * the fire/smoke currently blocks, extra margins near it, and people the simulation counts on each
   * passage. Labelled simulated; never a measurement and never accepted for drills or live incidents.
   */
  simWorld: SimWorld | null;
  teacherCounts: Map<string, { count: number; at: number; by: string }>;
}

export interface Participant {
  id: string;
  token: string;
  incidentId: string;
  deviceKey: string;
  displayName: string;
  isTest: boolean;
  mobility: MobilityProfile;
  createdAt: number;
  lastSeenAt: number | null;
  connections: number;
  location: LocationFix | null;
  locationState: LocationState;
  locationNote: string | null;
  lastClientSeq: number;
  recentFloors: Array<{ floor: number; at: number }>;
  arrival: ArrivalState;
  helpRequestedAt: number | null;
  blockedReports: number;
  advice: RouteAdvice | null;
  routeRevision: number;
  delivery: Record<DeliveryStage, number | null>;
  viewRevision: number;
  /** Set by the preview host's "simulate disconnect"; server-side only flag for the report. */
  removed: boolean;
  /** A bot of the 3D crowd simulation carrying a simulated phone (simulation incidents only). */
  isBot?: boolean;
  /** The person a user controls in the roleplay simulator. */
  isPlayer?: boolean;
  /** When the advised route last changed (server clock). */
  lastRouteChangeAt?: number;
  botId?: number;
  /** Highest route revision already handed to the 3D simulation for this bot. */
  botDelivered?: number;
}

export interface SimWorld {
  blocked: Set<string>;
  margins: Map<string, number>;
  /** People per passage seen in the simulation (on it or crowding at its entrance). */
  crowd: Map<string, number>;
  zones: Array<{ zoneId: string; label: string }>;
  receivedAt: number;
  simTime: number;
  signature: string;
}

/** One bot's position from the 3D simulation (graph node it stands at or last passed). */
export interface SimBotUpdate { botId: number; nodeId: string | null; mobility?: MobilityProfile }
/** Advice returned to the 3D simulation for one bot (only when its revision changed). */
export interface SimBotAdvice {
  botId: number;
  participantId: string;
  routeRevision: number;
  status: AdviceStatus;
  nodeIds: string[];
  edgeIds: string[];
  destinationNodeId: string | null;
  reason: string | null;
}

const isRouteStatus = (status: AdviceStatus | null | undefined) => status === "ok" || status === "stale-location";
const emptyDelivery = (): Record<DeliveryStage, number | null> => ({ accepted: null, sent: null, received: null, viewed: null, confirmed: null });

/**
 * Cryptographic random bytes. Uses Web Crypto (browser and Node ≥ 19); the Node server also
 * injects node:crypto through setRandomSource so older runtimes keep working. The service has no
 * other platform dependency, so the same code runs on the server and in the in-browser backend.
 */
let randomSource: (count: number) => Uint8Array = (count) => {
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!cryptoApi?.getRandomValues) throw new Error("ไม่มีตัวสุ่มที่ปลอดภัย (Web Crypto) ในสภาพแวดล้อมนี้");
  return cryptoApi.getRandomValues(new Uint8Array(count));
};
export function setRandomSource(source: (count: number) => Uint8Array) { randomSource = source; }
export function randomHex(bytes = 24) { return [...randomSource(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function token(bytes = 24) { return randomHex(bytes); }
function shortCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomSource(6);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export interface ServiceOptions {
  liveEnabled: boolean;
  liveReadiness: Array<{ id: string; label: string; ok: boolean }>;
  log: (entry: EventLogEntry) => void;
  now?: () => number;
}

export class IncidentService {
  readonly registry: MapRegistry = getMapRegistry();
  readonly incidents = new Map<string, Incident>();
  readonly participants = new Map<string, Participant>();
  private byToken = new Map<string, Participant>();
  private byDevice = new Map<string, Participant>();
  activeIncidentId: string | null = null;
  private logSeq = 0;
  readonly recentLog: EventLogEntry[] = [];
  private fields = new Map<string, { key: string; field: RouteField }>();
  /** Bumped on any change the staff dashboard should see. */
  staffRevision = 0;
  private listeners = new Set<(kind: "participant" | "staff", participantId?: string) => void>();
  private distanceCache = new Map<string, Map<string, number>>();
  readonly now: () => number;

  constructor(private options: ServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  onChange(listener: (kind: "participant" | "staff", participantId?: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private touchParticipant(participant: Participant) {
    participant.viewRevision += 1;
    this.staffRevision += 1;
    this.listeners.forEach((listener) => listener("participant", participant.id));
  }

  private touchStaff() {
    this.staffRevision += 1;
    this.listeners.forEach((listener) => listener("staff"));
  }

  log(actor: string, role: Role | "system", type: string, detail: string, incidentId: string | null = null) {
    const entry: EventLogEntry = { seq: ++this.logSeq, at: this.now(), incidentId, actor, role, type, detail: detail.slice(0, 400) };
    this.recentLog.push(entry);
    if (this.recentLog.length > 2000) this.recentLog.splice(0, this.recentLog.length - 2000);
    this.options.log(entry);
    return entry;
  }

  // ------------------------------------------------------------------ incidents

  createIncident(mode: IncidentMode, title: string, actor: string, activate = true): Incident {
    if (mode === "live" && !this.options.liveEnabled) {
      throw new ApiError(403, "live-disabled", "ยังเปิดโหมดเหตุจริงไม่ได้: ระบบยังไม่ผ่านเงื่อนไขความพร้อม", this.options.liveReadiness);
    }
    const now = this.now();
    const incident: Incident = {
      id: `inc-${now.toString(36)}-${token(3)}`,
      mode, phase: "standby",
      title: title.trim().slice(0, 80) || (mode === "drill" ? "รอบฝึกซ้อมอพยพ" : mode === "simulation" ? "สถานการณ์จำลอง" : "เหตุการณ์จริง"),
      joinCode: shortCode(),
      createdAt: now, createdBy: actor, evacuateAt: null, endedAt: null,
      closedEdges: new Map(), closureRevision: 0, hazardRevision: 0, announcements: [],
      sensors: new Map(this.registry.sensors.map((info) => [info.sensorId, {
        ...info, status: "unknown", lastValue: null, unit: null, lastObservedAt: null, lastReceivedAt: null, lastSequence: -1, mode: null, quality: null, issues: [],
      } satisfies SensorState])),
      previewTickets: new Map(), teacherCounts: new Map(), simWorld: null,
    };
    this.incidents.set(incident.id, incident);
    // The roleplay simulator runs its own simulation incident without taking over the control
    // centre's active incident.
    if (activate) this.activeIncidentId = incident.id;
    this.log(actor, "staff", "incident.created", `${mode} "${incident.title}" รหัสเข้าร่วม ${incident.joinCode}`, incident.id);
    this.touchStaff();
    return incident;
  }

  getIncident(id: string): Incident {
    const incident = this.incidents.get(id);
    if (!incident) throw new ApiError(404, "incident-not-found", "ไม่พบเหตุการณ์นี้");
    return incident;
  }

  setActive(id: string) { this.getIncident(id); this.activeIncidentId = id; this.touchStaff(); }

  startEvacuation(incidentId: string, actor: string) {
    const incident = this.getIncident(incidentId);
    if (incident.phase === "ended") throw new ApiError(409, "incident-ended", "เหตุการณ์นี้ยุติแล้ว");
    if (incident.phase === "evacuate") return incident;
    incident.phase = "evacuate";
    incident.evacuateAt = this.now();
    this.log(actor, "staff", "incident.evacuate", `เริ่มอพยพ (${incident.mode})`, incident.id);
    this.recomputeIncident(incident, { code: "initial", text: "เริ่มอพยพตามแผน" });
    this.touchStaff();
    return incident;
  }

  endIncident(incidentId: string, actor: string) {
    const incident = this.getIncident(incidentId);
    if (incident.phase === "ended") return incident;
    incident.phase = "ended";
    incident.endedAt = this.now();
    this.log(actor, "staff", "incident.ended", "ยุติเหตุการณ์/รอบฝึกซ้อม", incident.id);
    for (const participant of this.participantsOf(incident)) {
      participant.advice = null;
      this.touchParticipant(participant);
    }
    this.touchStaff();
    return incident;
  }

  /** Reset only the test scenario: test participants, simulated sensors, closures. Real drill participants stay. */
  resetTestScenario(incidentId: string, actor: string, scope: "all" | "bots" = "all") {
    const incident = this.getIncident(incidentId);
    if (scope === "bots" && incident.mode !== "simulation") throw new ApiError(403, "simulation-only", "ล้างบอทได้เฉพาะรอบจำลอง");
    let removed = 0;
    for (const participant of [...this.participantsOf(incident)]) {
      if (!participant.isTest || (scope === "bots" && !participant.isBot)) continue;
      this.removeParticipant(participant);
      removed += 1;
    }
    incident.sensors.forEach((sensor) => {
      if (sensor.mode === "simulated" || sensor.mode === "drill") {
        Object.assign(sensor, { status: "unknown", lastValue: null, unit: null, lastObservedAt: null, lastReceivedAt: null, lastSequence: -1, mode: null, quality: null, issues: [] });
      }
    });
    incident.closedEdges.clear();
    incident.closureRevision += 1;
    incident.hazardRevision += 1;
    incident.phase = incident.phase === "ended" ? "ended" : "standby";
    incident.evacuateAt = null;
    this.log(actor, "staff", "incident.reset-test", `ล้างสถานการณ์ทดสอบ: ผู้ทดสอบ ${removed} คน เซนเซอร์จำลอง ทางปิด`, incident.id);
    for (const participant of this.participantsOf(incident)) { participant.advice = null; this.touchParticipant(participant); }
    this.touchStaff();
  }

  setClosure(incidentId: string, target: { groupId?: string; edgeIds?: string[] }, closed: boolean, reason: string, actor: string, role: Role) {
    const incident = this.getIncident(incidentId);
    const group = target.groupId ? passageGroups(this.registry).find((candidate) => candidate.id === target.groupId) : undefined;
    if (target.groupId && !group) throw new ApiError(400, "unknown-passage", "ไม่พบทางที่ระบุ");
    const edgeIds = group ? group.edgeIds : (target.edgeIds ?? []);
    if (!edgeIds.length || edgeIds.some((edgeId) => !this.registry.edgeMap.has(edgeId))) throw new ApiError(400, "unknown-edge", "ไม่พบช่วงทางที่ระบุในแผนที่");
    let changed = false;
    for (const edgeId of edgeIds) {
      if (closed && !incident.closedEdges.has(edgeId)) { incident.closedEdges.set(edgeId, { at: this.now(), by: actor, reason }); changed = true; }
      if (!closed && incident.closedEdges.delete(edgeId)) changed = true;
    }
    if (!changed) return incident;
    incident.closureRevision += 1;
    const label = group?.label ?? passageLabel(edgeIds[0], this.registry);
    this.log(actor, role, closed ? "closure.closed" : "closure.opened", `${label}${reason ? ` — ${reason}` : ""}`, incident.id);
    this.recomputeIncident(incident, closed
      ? { code: "closure", text: `${label} ถูกปิด${reason ? ` (${reason})` : ""}` }
      : { code: "closure", text: `${label} เปิดใช้ได้อีกครั้ง` });
    this.touchStaff();
    return incident;
  }

  announce(incidentId: string, templateId: string, params: Record<string, string>, actor: string) {
    const incident = this.getIncident(incidentId);
    const text = ANNOUNCEMENT_TEMPLATES[templateId]?.(params, this.registry);
    if (!text) throw new ApiError(400, "unknown-template", "ไม่พบแบบประกาศนี้");
    const announcement: Announcement = { id: `ann-${token(4)}`, templateId, text, issuedAt: this.now() };
    incident.announcements = [...incident.announcements, announcement].slice(-5);
    this.log(actor, "staff", "announcement", text, incident.id);
    for (const participant of this.participantsOf(incident)) this.touchParticipant(participant);
    this.touchStaff();
    return announcement;
  }

  createPreviewTicket(incidentId: string, actor: string, kind: "tester" | "player" = "tester") {
    const incident = this.getIncident(incidentId);
    if (incident.phase === "ended") throw new ApiError(409, "incident-ended", "เหตุการณ์นี้ยุติแล้ว");
    if (kind === "player" && incident.mode !== "simulation") throw new ApiError(403, "simulation-only", "ผู้เล่นสวมบทใช้ได้เฉพาะรอบสถานการณ์จำลอง");
    const ticket = token(16);
    incident.previewTickets.set(ticket, { createdAt: this.now(), used: false, kind });
    this.log(actor, "staff", "preview.ticket", kind === "player" ? "ออกบัตรผู้เล่นสวมบท (SIMULATOR)" : "ออกบัตรผู้ทดสอบสำหรับกรอบมือถือจำลอง", incident.id);
    return ticket;
  }

  /**
   * Simulator adapter: replace this simulation incident's world snapshot. Hazard changes (blocked
   * passages or margins) bump the hazard revision and re-route everybody with a reason; crowd-only
   * changes re-route just the roleplay player(s), whose hysteresis decides whether it is worth a
   * new route. Simulation incidents only.
   */
  applySimWorld(incidentId: string, input: { blocked: string[]; margins: Record<string, number>; crowd: Record<string, number>; simTime: number }, actor: string) {
    const incident = this.getIncident(incidentId);
    if (incident.mode !== "simulation") throw new ApiError(403, "simulation-only", "ข้อมูลจากแบบจำลองใช้ได้เฉพาะรอบสถานการณ์จำลอง");
    if (incident.phase === "ended") throw new ApiError(409, "incident-ended", "เหตุการณ์นี้ยุติแล้ว");
    const known = (edgeId: string) => this.registry.edgeMap.has(edgeId);
    const blocked = new Set(input.blocked.filter(known));
    const margins = new Map(Object.entries(input.margins).filter(([edgeId, value]) => known(edgeId) && Number.isFinite(value) && value > 0).map(([edgeId, value]) => [edgeId, Math.min(600, value)] as [string, number]));
    const crowd = new Map(Object.entries(input.crowd).filter(([edgeId, value]) => known(edgeId) && Number.isFinite(value) && value > 0).map(([edgeId, value]) => [edgeId, Math.min(5000, value)] as [string, number]));
    const zoneSet = new Map<string, string>();
    blocked.forEach((edgeId) => {
      const edge = this.registry.edgeMap.get(edgeId)!;
      const zone = this.registry.zoneOf.get(edge.from) ?? this.registry.zoneOf.get(edge.to);
      if (zone) zoneSet.set(zone, zoneLabel(zone));
    });
    const signature = `${[...blocked].sort().join(",")}|${[...margins.keys()].sort().join(",")}`;
    const hazardChanged = signature !== (incident.simWorld?.signature ?? "|");
    incident.simWorld = { blocked, margins, crowd, zones: [...zoneSet].map(([zoneId, label]) => ({ zoneId, label })), receivedAt: this.now(), simTime: input.simTime, signature };
    if (hazardChanged) {
      incident.hazardRevision += 1;
      this.log(actor, "staff", "sim.world", `แบบจำลอง: ไฟ/ควันปิด ${blocked.size} ช่วงทาง (ข้อมูลจำลอง)`, incident.id);
      this.recomputeIncident(incident, { code: "hazard", text: blocked.size ? `ไฟหรือควันในแบบจำลองปิดทางบริเวณ ${[...zoneSet.values()].slice(0, 3).join(", ")}` : "ไฟหรือควันในแบบจำลองไม่ขวางทางแล้ว" });
    } else if (incident.phase === "evacuate") {
      const players = this.participantsOf(incident).filter((participant) => participant.isPlayer);
      for (const player of players) this.recomputeParticipant(player, null);
    }
    this.touchStaff();
    return { hazardRevision: incident.hazardRevision, blocked: blocked.size, crowded: crowd.size };
  }

  recordTeacherCount(incidentId: string, zoneId: string, count: number, actor: string, role: Role) {
    const incident = this.getIncident(incidentId);
    if (!this.registry.zoneLabels.has(zoneId)) throw new ApiError(400, "unknown-zone", "ไม่พบโซนนี้");
    if (!Number.isInteger(count) || count < 0 || count > 2000) throw new ApiError(400, "bad-count", "จำนวนคนไม่ถูกต้อง");
    incident.teacherCounts.set(zoneId, { count, at: this.now(), by: actor });
    this.log(actor, role, "occupancy.teacher-count", `${zoneLabel(zoneId)} = ${count} คน`, incident.id);
    this.touchStaff();
  }

  // ------------------------------------------------------------------ participants

  participantsOf(incident: Incident) {
    return [...this.participants.values()].filter((participant) => participant.incidentId === incident.id && !participant.removed);
  }

  join(input: { joinCode?: string; previewTicket?: string; incidentId?: string; deviceKey: string; displayName?: string; mobility?: MobilityProfile }): Participant {
    let incident: Incident | undefined;
    let isTest = false;
    let isPlayer = false;
    if (input.previewTicket) {
      incident = input.incidentId ? this.incidents.get(input.incidentId) : [...this.incidents.values()].find((candidate) => candidate.previewTickets.has(input.previewTicket!));
      const ticket = incident?.previewTickets.get(input.previewTicket);
      if (!incident || !ticket) throw new ApiError(403, "bad-ticket", "บัตรผู้ทดสอบไม่ถูกต้องหรือหมดอายุ");
      isTest = true;
      isPlayer = ticket.kind === "player";
      ticket.used = true;
    } else {
      const code = (input.joinCode ?? "").trim().toUpperCase();
      incident = [...this.incidents.values()].find((candidate) => candidate.joinCode === code && candidate.phase !== "ended");
      if (!incident) throw new ApiError(404, "bad-join-code", "ไม่พบรอบฝึกซ้อมที่ใช้รหัสนี้ หรือรอบนี้ยุติแล้ว");
      if (incident.mode === "simulation") throw new ApiError(403, "simulation-only", "สถานการณ์จำลองรับเฉพาะผู้ทดสอบจากศูนย์ควบคุม ไม่รับอุปกรณ์จริง");
    }
    // One participant per (incident, device). Several tabs on one phone share it.
    const deviceKey = `${incident.id}|${input.deviceKey}|${isPlayer ? "player" : isTest ? "test" : "real"}`;
    const existing = this.byDevice.get(deviceKey);
    if (existing && !existing.removed) return existing;
    const now = this.now();
    const participant: Participant = {
      id: `p-${token(5)}`,
      token: token(24),
      incidentId: incident.id,
      deviceKey,
      displayName: isPlayer ? "ผู้เล่นสวมบท (SIMULATOR)" : (input.displayName ?? "").trim().slice(0, 40) || (isTest ? "ผู้ทดสอบ (กรอบจำลอง)" : "ผู้เข้าร่วม"),
      isTest,
      isPlayer,
      mobility: input.mobility === "no-stairs" ? "no-stairs" : "standard",
      createdAt: now, lastSeenAt: now, connections: 0,
      location: null, locationState: "unknown", locationNote: null, lastClientSeq: -1, recentFloors: [],
      arrival: { selfReportedAt: null, selfReportedAssemblyId: null, teacherConfirmedAt: null },
      helpRequestedAt: null, blockedReports: 0,
      advice: null, routeRevision: 0, delivery: emptyDelivery(), viewRevision: 1, removed: false,
    };
    this.participants.set(participant.id, participant);
    this.byToken.set(participant.token, participant);
    this.byDevice.set(deviceKey, participant);
    this.log(participant.id, isTest ? "preview" : "participant", "participant.joined", isPlayer ? "ผู้เล่นสวมบทใน SIMULATOR" : isTest ? "ผู้ทดสอบจากกรอบมือถือจำลอง" : "เข้าร่วมด้วยรหัส", incident.id);
    if (incident.phase === "evacuate") this.recomputeParticipant(participant, { code: "initial", text: "เริ่มอพยพตามแผน" });
    this.touchStaff();
    return participant;
  }

  participantByToken(value: string | null | undefined): Participant {
    const participant = value ? this.byToken.get(value) : undefined;
    if (!participant || participant.removed) throw new ApiError(401, "bad-session", "เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าร่วมใหม่");
    return participant;
  }

  getParticipant(id: string): Participant {
    const participant = this.participants.get(id);
    if (!participant || participant.removed) throw new ApiError(404, "participant-not-found", "ไม่พบผู้เข้าร่วม");
    return participant;
  }

  /**
   * Simulator A: the 3D crowd simulation's bots that "carry a phone" report where they are, and the
   * same routing engine that serves real phones answers. Only in a simulation incident (bots never
   * mix with a drill or a real incident). Bots are test participants: never counted as people.
   * Locations are applied directly (the simulation's own movement is already physically checked);
   * a bot is re-routed when it leaves its advised route, at evacuation start, and on every
   * closure/hazard change like everybody else. Returns only advice newer than `known`.
   */
  syncSimBots(incidentId: string, bots: SimBotUpdate[], full: boolean, actor: string, replace = false) {
    const incident = this.getIncident(incidentId);
    if (incident.mode !== "simulation") throw new ApiError(403, "simulation-only", "บอทจากแบบจำลองใช้ได้เฉพาะกับรอบสถานการณ์จำลอง");
    if (incident.phase === "ended") throw new ApiError(409, "ended", "รอบนี้ยุติแล้ว");
    const ids = new Set<number>();
    for (const bot of bots) {
      if (!Number.isInteger(bot.botId) || bot.botId < 0 || bot.botId > 100_000 || ids.has(bot.botId)) throw new ApiError(400, "bad-bots", "botId ต้องเป็นจำนวนเต็มและไม่ซ้ำ");
      if (bot.nodeId !== null && !this.registry.nodeMap.has(bot.nodeId)) throw new ApiError(400, "unknown-node", "ไม่พบตำแหน่งบอทในแผนที่");
      ids.add(bot.botId);
    }
    if (replace) for (const p of [...this.participantsOf(incident)]) {
      if (p.isBot && p.botId !== undefined && !ids.has(p.botId)) this.removeParticipant(p);
    }
    const now = this.now();
    let created = 0;
    const toRoute: Participant[] = [];
    const touched = new Map<number, Participant>();
    for (const bot of bots) {
      const deviceKey = `${incident.id}|sim-bot-${bot.botId}|test`;
      let participant = this.byDevice.get(deviceKey);
      if (!participant || participant.removed) {
        participant = {
          id: `b-${token(5)}`, token: token(24), incidentId: incident.id, deviceKey, displayName: `บอทจำลอง #${bot.botId}`,
          isTest: true, isBot: true, botId: bot.botId, botDelivered: 0, mobility: bot.mobility === "no-stairs" ? "no-stairs" : "standard",
          createdAt: now, lastSeenAt: now, connections: 0, location: null, locationState: "unknown", locationNote: null,
          lastClientSeq: -1, recentFloors: [], arrival: { selfReportedAt: null, selfReportedAssemblyId: null, teacherConfirmedAt: null },
          helpRequestedAt: null, blockedReports: 0, advice: null, routeRevision: 0, delivery: emptyDelivery(), viewRevision: 1, removed: false,
        };
        this.participants.set(participant.id, participant);
        this.byToken.set(participant.token, participant);
        this.byDevice.set(deviceKey, participant);
        created += 1;
      }
      participant.lastSeenAt = now;
      touched.set(bot.botId, participant);
      const node = bot.nodeId ? this.registry.nodeMap.get(bot.nodeId) : undefined;
      if (!node) {
        participant.location = null;
        participant.locationState = "unknown";
        toRoute.push(participant);
      }
      if (node && participant.location?.nodeId !== node.id) {
        participant.location = {
          buildingId: this.registry.buildingOf.get(node.id) ?? "site", floor: node.floor, zoneId: this.registry.zoneOf.get(node.id) ?? null,
          checkpointId: this.registry.checkpointByNode.get(node.id)?.id ?? null, nodeId: node.id, source: "demo-simulated",
          observedAt: now, receivedAt: now, accuracyM: null, confidence: "medium", mapVersion: this.registry.mapVersion,
        };
        participant.locationState = "confirmed";
        participant.locationNote = null;
        if (node.type === "assembly" && !participant.arrival.selfReportedAt) {
          participant.arrival = { ...participant.arrival, selfReportedAt: now, selfReportedAssemblyId: node.id };
        }
        // Still on the advised route: no need to plan again (the advice stays valid from here).
        const onRoute = participant.advice && isRouteStatus(participant.advice.status) && participant.advice.nodeIds.includes(node.id);
        if (!onRoute) toRoute.push(participant);
      } else if (node) {
        // A stationary simulated person is still observed. Heartbeats keep location fresh,
        // without manufacturing a new route revision or claiming progress to the next node.
        if (participant.location) Object.assign(participant.location, { observedAt: now, receivedAt: now });
        participant.locationState = "confirmed";
        if (!participant.advice) toRoute.push(participant);
      } else if (!participant.advice && !toRoute.includes(participant)) {
        toRoute.push(participant);
      }
    }
    if (incident.phase === "evacuate" && toRoute.length) this.recomputeBatch(incident, toRoute, null, true);
    if (created) this.log(actor, "staff", "sim.bots", `บอทจากแบบจำลองถือมือถือเข้าร่วม ${created} ตัว (ข้อมูลจำลอง ไม่นับเป็นคน)`, incident.id);
    // Every bot's new advice since the last delivery — including bots that did not move (a closure
    // or a new hazard re-routes them too). `full` re-sends everything (after a lost response).
    const advice: SimBotAdvice[] = [];
    for (const participant of this.participantsOf(incident)) {
      if (!participant.isBot || participant.botId === undefined) continue;
      const current = participant.advice;
      if (!current || (!full && participant.routeRevision <= (participant.botDelivered ?? 0))) continue;
      participant.botDelivered = participant.routeRevision;
      const botId = participant.botId;
      advice.push({
        botId, participantId: participant.id, routeRevision: participant.routeRevision, status: current.status,
        nodeIds: current.nodeIds, edgeIds: current.edgeIds, destinationNodeId: current.destination?.nodeId ?? null, reason: current.reason?.text ?? null,
      });
    }
    this.touchStaff();
    return { advice, bots: this.participantsOf(incident).filter(p=>p.isBot).length };
  }

  /** Bot ids → participant ids, for "show this bot's phone" in the control panel. */
  simBotParticipant(incidentId: string, botId: number) {
    const participant = this.byDevice.get(`${incidentId}|sim-bot-${botId}|test`);
    return participant && !participant.removed ? participant.id : null;
  }

  removeParticipant(participant: Participant) {
    participant.removed = true;
    this.byToken.delete(participant.token);
    this.byDevice.delete(participant.deviceKey);
    this.participants.delete(participant.id);
    this.touchStaff();
  }

  setMobility(participant: Participant, mobility: MobilityProfile) {
    if (participant.mobility === mobility) return;
    participant.mobility = mobility;
    this.log(participant.id, "participant", "participant.mobility", mobility === "no-stairs" ? "ต้องการเส้นทางที่ไม่ใช้บันได" : "ใช้บันไดได้", participant.incidentId);
    this.recomputeParticipant(participant, { code: "mobility", text: "ปรับตามข้อจำกัดการเคลื่อนที่ที่แจ้งไว้" });
    this.touchParticipant(participant);
  }

  connectionOpened(participant: Participant) { participant.connections += 1; participant.lastSeenAt = this.now(); this.touchStaff(); }
  connectionClosed(participant: Participant) { participant.connections = Math.max(0, participant.connections - 1); participant.lastSeenAt = this.now(); this.touchStaff(); }

  markSent(participant: Participant) {
    if (participant.advice && participant.delivery.accepted && !participant.delivery.sent) { participant.delivery.sent = this.now(); this.touchStaff(); }
  }

  acknowledge(participant: Participant, routeId: string, stage: "received" | "viewed" | "confirmed") {
    participant.lastSeenAt = this.now();
    if (!participant.advice || participant.advice.routeId !== routeId) return false; // late ack for an older route: ignored
    if (participant.delivery[stage]) return true;
    participant.delivery[stage] = this.now();
    if (stage === "confirmed") this.log(participant.id, "participant", "advice.confirmed", `รับทราบเส้นทาง ${routeId}`, participant.incidentId);
    this.touchStaff();
    return true;
  }

  requestHelp(participant: Participant, auto = false) {
    if (!participant.helpRequestedAt) participant.helpRequestedAt = this.now();
    // Simulated bots do not flood the staff event log (they are summarised in the counts).
    if (participant.isBot) return;
    this.log(participant.id, auto ? "system" : "participant", "participant.help", auto ? "ระบบแจ้งเจ้าหน้าที่อัตโนมัติ: ไม่พบเส้นทางที่ใช้ได้สำหรับผู้ใช้นี้" : "ขอความช่วยเหลือ", participant.incidentId);
    this.touchParticipant(participant);
  }

  reportBlocked(participant: Participant, edgeId: string | null) {
    participant.blockedReports += 1;
    const label = edgeId && this.registry.edgeMap.has(edgeId) ? passageLabel(edgeId, this.registry) : "ทางข้างหน้า";
    // A participant report never closes a passage by itself (could be wrong or spoofed); staff decides.
    this.log(participant.id, "participant", "participant.blocked-report", `แจ้งว่า${label}ใช้ไม่ได้ (รอเจ้าหน้าที่ตรวจสอบ)`, participant.incidentId);
    this.touchParticipant(participant);
  }

  reportArrived(participant: Participant, assemblyId: string | null) {
    const assembly = assemblyId ? this.registry.nodeMap.get(assemblyId) : undefined;
    participant.arrival = { ...participant.arrival, selfReportedAt: this.now(), selfReportedAssemblyId: assembly?.type === "assembly" ? assembly.id : null };
    this.log(participant.id, "participant", "arrival.self-reported", `แจ้งว่าถึง${assembly ? displayNodeName(assembly) : "จุดรวมพล"}แล้ว (ยังไม่ใช่การยืนยันของครู)`, participant.incidentId);
    this.touchParticipant(participant);
  }

  confirmArrival(participant: Participant, actor: string, role: Role) {
    participant.arrival = { ...participant.arrival, teacherConfirmedAt: this.now() };
    this.log(actor, role, "arrival.teacher-confirmed", `ยืนยันตัว ${participant.displayName} (${participant.id})`, participant.incidentId);
    this.touchParticipant(participant);
  }

  // ------------------------------------------------------------------ positioning

  /**
   * Accept a position report after checking it against the map: known node, same map version,
   * not older than what we have, and walkable from the previous fix in the time between them.
   */
  reportLocation(participant: Participant, input: {
    source: LocationSource; checkpointId?: string | null; nodeId?: string | null; observedAt: number; clientSeq: number; mapVersion: string;
    accuracyM?: number | null; geo?: { lat: number; lon: number; accuracy: number } | null; confirmJump?: boolean;
    position?: [number, number, number] | null; headingDeg?: number | null;
  }, actorRole: Role = "participant") {
    const now = this.now();
    if (input.source === "simulator") {
      // Only the roleplay player of a simulation incident may report a simulator position: it is the
      // game character's position, never a measurement, so it must not reach a drill or live incident.
      const incident = this.incidents.get(participant.incidentId);
      if (!participant.isPlayer || !participant.isTest || incident?.mode !== "simulation") {
        throw new ApiError(403, "simulator-only", "ตำแหน่งจากเกมจำลองใช้ได้เฉพาะผู้เล่นสวมบทในรอบสถานการณ์จำลอง");
      }
    }
    if (input.mapVersion !== this.registry.mapVersion) {
      throw new ApiError(409, "map-version-mismatch", "แผนที่ในเครื่องเป็นคนละรุ่นกับระบบ กรุณาโหลดแผนที่ใหม่", { serverMapVersion: this.registry.mapVersion });
    }
    if (input.clientSeq <= participant.lastClientSeq) {
      throw new ApiError(409, "stale-report", "รายงานตำแหน่งนี้เก่ากว่าที่ระบบมีอยู่แล้ว");
    }
    participant.lastClientSeq = input.clientSeq;
    participant.lastSeenAt = now;
    // Device clock is not trusted for freshness beyond a small skew.
    const observedAt = Math.abs(input.observedAt - now) > 5 * 60_000 ? now : Math.min(input.observedAt, now);
    if (input.source === "geolocation") {
      // No surveyed georeference of the model yet: a GPS fix cannot be mapped to a building, floor or node.
      participant.locationState = participant.location ? participant.locationState : "uncertain";
      participant.locationNote = `ได้รับพิกัด GPS (ความคลาดเคลื่อน ±${Math.round(input.geo?.accuracy ?? 0)} ม.) แต่แผนที่ยังไม่ได้เทียบพิกัดจริง จึงใช้ระบุอาคาร/ชั้นไม่ได้ — กรุณาสแกน QR หรือเลือกจุดเอง`;
      this.log(participant.id, actorRole, "location.geolocation-unmapped", participant.locationNote, participant.incidentId);
      this.touchParticipant(participant);
      return participant;
    }
    const checkpoint = input.checkpointId ? this.registry.checkpointById.get(input.checkpointId) : undefined;
    if (input.checkpointId && !checkpoint) throw new ApiError(400, "unknown-checkpoint", "ไม่พบจุดตรวจ QR นี้ในแผนที่รุ่นปัจจุบัน");
    const nodeId = checkpoint?.nodeId ?? input.nodeId ?? null;
    const node = nodeId ? this.registry.nodeMap.get(nodeId) : undefined;
    if (!node) throw new ApiError(400, "unknown-node", "ไม่พบตำแหน่งนี้ในแผนที่");
    const buildingId = this.registry.buildingOf.get(node.id) ?? "site";
    const fix: LocationFix = {
      buildingId, floor: node.floor, zoneId: this.registry.zoneOf.get(node.id) ?? null,
      checkpointId: checkpoint?.id ?? this.registry.checkpointByNode.get(node.id)?.id ?? null,
      nodeId: node.id, source: input.source, observedAt, receivedAt: now,
      accuracyM: input.accuracyM ?? null,
      confidence: input.source === "qr" ? "high" : input.source === "teacher" ? "high" : input.source === "simulator" ? "high" : "medium",
      mapVersion: this.registry.mapVersion,
      position: input.source === "simulator" && input.position ? input.position : null,
      headingDeg: input.source === "simulator" && typeof input.headingDeg === "number" ? input.headingDeg : null,
    };
    if (input.source === "simulator") {
      // The character walks on the same collision geometry as the crowd (no teleport is possible),
      // so the walking-speed plausibility check is not needed; the node is the nearest graph node on
      // the walkway the character stands on. Same node: refresh freshness/pose only.
      const sameNode = participant.location?.nodeId === node.id;
      participant.location = fix;
      participant.locationState = "confirmed";
      participant.locationNote = null;
      const incident = this.incidents.get(participant.incidentId);
      if (!sameNode) {
        this.log(participant.id, actorRole, "location.accepted", `${displayNodeName(node)} (simulator)`, participant.incidentId);
        if (incident?.phase === "evacuate") this.recomputeParticipant(participant, { code: "location-changed", text: `ตำแหน่งใหม่ใกล้${displayNodeName(node)}` });
      } else if (incident?.phase === "evacuate" && participant.advice && participant.advice.expiresAt - now < ADVICE_TTL_MS / 2) {
        this.recomputeParticipant(participant, null);
      }
      this.touchParticipant(participant);
      return participant;
    }
    // Plausibility against the previous confirmed fix.
    const previous = participant.location;
    let note: string | null = null;
    if (previous?.nodeId && previous.nodeId !== node.id && !input.confirmJump) {
      const elapsed = Math.max(1, (observedAt - previous.observedAt) / 1000);
      const walk = this.walkingDistance(previous.nodeId, node.id);
      if (!Number.isFinite(walk)) note = "ตำแหน่งใหม่ไม่เชื่อมกับตำแหน่งเดิมในแผนที่";
      else if (walk > MAX_PLAUSIBLE_SPEED * elapsed + 15 && elapsed < 600) {
        note = `ตำแหน่งใหม่ห่างจากเดิมประมาณ ${Math.round(walk)} ม. ภายใน ${Math.round(elapsed)} วินาที ซึ่งเดินไม่ทัน`;
      }
    }
    // Floor flapping: alternating floors within 30 s without a stair in between.
    participant.recentFloors = [...participant.recentFloors.filter((entry) => now - entry.at < 30_000), { floor: node.floor, at: now }];
    const floors = participant.recentFloors.map((entry) => entry.floor);
    if (!note && floors.length >= 3 && floors[floors.length - 1] === floors[floors.length - 3] && floors[floors.length - 2] !== floors[floors.length - 1] && input.source !== "qr") {
      note = "ชั้นที่รายงานสลับไปมา ยังยืนยันชั้นไม่ได้";
    }
    if (note) {
      participant.locationState = "uncertain";
      participant.locationNote = `${note} — กรุณายืนยันตำแหน่งอีกครั้ง`;
      this.log(participant.id, actorRole, "location.rejected", `${displayNodeName(node)}: ${note}`, participant.incidentId);
      // The old route must not keep looking current while we do not know where the person is.
      const current = this.incidents.get(participant.incidentId);
      if (current?.phase === "evacuate") this.recomputeParticipant(participant, null);
      this.touchParticipant(participant);
      return participant;
    }
    participant.location = fix;
    participant.locationState = now - observedAt > LOCATION_FRESH_MS ? "stale" : "confirmed";
    participant.locationNote = null;
    this.log(participant.id, actorRole, "location.accepted", `${displayNodeName(node)} (${input.source})`, participant.incidentId);
    const incident = this.incidents.get(participant.incidentId);
    if (incident?.phase === "evacuate") this.recomputeParticipant(participant, { code: "location-changed", text: `ยืนยันตำแหน่งใหม่ที่${displayNodeName(node)}` });
    this.touchParticipant(participant);
    return participant;
  }

  /** Mark a test participant's position as unknown (demo control). */
  markUncertain(participant: Participant, actor: string) {
    participant.locationState = "uncertain";
    participant.locationNote = "ข้อมูลจำลอง: ระบบยังไม่ทราบชั้นหรือจุดที่แน่ชัด";
    this.log(actor, "staff", "demo.location-uncertain", `ตั้งตำแหน่งผู้ทดสอบ ${participant.id} เป็นไม่แน่นอน`, participant.incidentId);
    const incident = this.incidents.get(participant.incidentId);
    if (incident?.phase === "evacuate") this.recomputeParticipant(participant, null);
    this.touchParticipant(participant);
  }

  /** Shortest walkable distance ignoring closures (used only to judge whether a jump is believable). */
  private walkingDistance(fromId: string, toId: string): number {
    let table = this.distanceCache.get(fromId);
    if (!table) {
      table = new Map<string, number>([[fromId, 0]]);
      const queue: Array<[number, string]> = [[0, fromId]];
      const adjacency = this.undirectedAdjacency();
      while (queue.length) {
        queue.sort((a, b) => a[0] - b[0]);
        const [d, id] = queue.shift()!;
        if (d > (table.get(id) ?? Infinity) || d > 2000) continue;
        for (const [next, length] of adjacency.get(id) ?? []) {
          const candidate = d + length;
          if (candidate < (table.get(next) ?? Infinity)) { table.set(next, candidate); queue.push([candidate, next]); }
        }
      }
      if (this.distanceCache.size > 400) this.distanceCache.clear();
      this.distanceCache.set(fromId, table);
    }
    return table.get(toId) ?? Infinity;
  }

  private adjacencyCache: Map<string, Array<[string, number]>> | null = null;
  private undirectedAdjacency() {
    if (this.adjacencyCache) return this.adjacencyCache;
    const adjacency = new Map<string, Array<[string, number]>>();
    for (const edge of this.registry.graph.edges) {
      (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push([edge.to, edge.distance]);
      (adjacency.get(edge.to) ?? adjacency.set(edge.to, []).get(edge.to)!).push([edge.from, edge.distance]);
    }
    this.adjacencyCache = adjacency;
    return adjacency;
  }

  // ------------------------------------------------------------------ sensors

  ingestSensorReadings(incident: Incident, readings: SensorReading[], actor: string, role: Role) {
    const now = this.now();
    const results: Array<{ eventId: string; accepted: boolean; issue?: string }> = [];
    let hazardChanged = false;
    for (const reading of readings) {
      const sensor = incident.sensors.get(reading.sensorId);
      if (!sensor) { results.push({ eventId: reading.eventId, accepted: false, issue: "unknown-sensor" }); continue; }
      if (incident.mode !== "live" && reading.mode === "live") { results.push({ eventId: reading.eventId, accepted: false, issue: "live-data-in-test-incident" }); continue; }
      if (incident.mode === "live" && reading.mode !== "live") { results.push({ eventId: reading.eventId, accepted: false, issue: "test-data-in-live-incident" }); continue; }
      const issues: string[] = [];
      if (reading.sequence <= sensor.lastSequence) {
        // Duplicate or late (out of order): never overrides the newer state.
        results.push({ eventId: reading.eventId, accepted: false, issue: reading.sequence === sensor.lastSequence ? "duplicate" : "out-of-order" });
        sensor.issues = [...sensor.issues, reading.sequence === sensor.lastSequence ? "ข้อมูลซ้ำ" : "ข้อมูลมาช้า/สลับลำดับ"].slice(-4);
        continue;
      }
      const expectedUnit = reading.type === "heat" ? "°C" : reading.type === "smoke" ? "%/m" : reading.type === "people-counter" ? "people" : null;
      if (reading.value !== null && expectedUnit && reading.unit !== expectedUnit) issues.push(`หน่วยไม่ถูกต้อง (${reading.unit ?? "ไม่ระบุ"} แทน ${expectedUnit})`);
      if (reading.value !== null && reading.type === "heat" && (reading.value < -20 || reading.value > 1200)) issues.push("ค่าอุณหภูมิอยู่นอกช่วงที่เป็นไปได้");
      if (reading.value !== null && reading.type === "smoke" && (reading.value < 0 || reading.value > 100)) issues.push("ค่าควันอยู่นอกช่วง 0–100");
      if (now - reading.observedAt > 60_000) issues.push(`ข้อมูลล่าช้า ${Math.round((now - reading.observedAt) / 1000)} วินาที`);
      const previousStatus = sensor.status;
      Object.assign(sensor, {
        status: issues.some((issue) => issue.includes("หน่วย") || issue.includes("นอกช่วง")) ? "fault" : reading.status,
        lastValue: reading.value, unit: reading.unit, lastObservedAt: reading.observedAt, lastReceivedAt: now,
        lastSequence: reading.sequence, mode: reading.mode, quality: issues.length ? "suspect" : reading.quality, issues,
      });
      if ((previousStatus === "alarm") !== (sensor.status === "alarm")) hazardChanged = true;
      results.push({ eventId: reading.eventId, accepted: true, ...(issues.length ? { issue: issues.join("; ") } : {}) });
      this.log(actor, role, "sensor.reading", `${sensor.label}: ${STATUS_TH[sensor.status]}${reading.value !== null ? ` ${reading.value} ${reading.unit ?? ""}` : ""}${reading.mode !== "live" ? " [ข้อมูลจำลอง]" : ""}`, incident.id);
    }
    if (hazardChanged) {
      incident.hazardRevision += 1;
      const alarms = [...incident.sensors.values()].filter((sensor) => sensor.status === "alarm");
      this.recomputeIncident(incident, { code: "hazard", text: alarms.length ? `ตรวจพบเหตุที่${alarms.map((sensor) => zoneLabel(sensor.zoneId)).join(", ")}` : "เซนเซอร์กลับสู่สถานะปกติ" });
    }
    this.touchStaff();
    return results;
  }

  /** Sensors not heard from for a while are offline — which is NOT the same as safe. */
  markSilentSensors(timeoutMs = 120_000) {
    const now = this.now();
    for (const incident of this.incidents.values()) {
      incident.sensors.forEach((sensor) => {
        if (sensor.lastReceivedAt && sensor.status !== "offline" && now - sensor.lastReceivedAt > timeoutMs) {
          sensor.status = "offline";
          sensor.issues = [...sensor.issues, "ไม่ได้รับข้อมูลเกินเวลาที่กำหนด"].slice(-4);
          this.touchStaff();
        }
      });
    }
  }

  // ------------------------------------------------------------------ routing

  /** Passages a measured hazard (sensor alarm, or the 3D simulation's fire for simulation rounds) makes impassable or risky. */
  private hazardEdges(incident: Incident) {
    const hazardBlocked = new Set<string>();
    const hazardMargin = new Map<string, number>();
    for (const sensor of incident.sensors.values()) {
      if (sensor.status !== "alarm") continue;
      const origin = this.registry.nodeMap.get(sensor.nodeId);
      if (!origin) continue;
      const building = this.registry.buildingOf.get(origin.id);
      for (const edge of this.registry.graph.edges) {
        const a = this.registry.nodeMap.get(edge.from), b = this.registry.nodeMap.get(edge.to);
        if (!a || !b) continue;
        const sameFloor = (a.floor === origin.floor || b.floor === origin.floor)
          && (this.registry.buildingOf.get(a.id) === building || this.registry.buildingOf.get(b.id) === building);
        if (!sameFloor) continue;
        const da = Math.hypot(a.position[0] - origin.position[0], a.position[2] - origin.position[2]);
        const db = Math.hypot(b.position[0] - origin.position[0], b.position[2] - origin.position[2]);
        const near = Math.min(da, db);
        // A manual call point says "something is wrong here", not where the fire is: margin only.
        if (sensor.type !== "manual-call-point" && (edge.from === origin.id || edge.to === origin.id || near <= HAZARD_BLOCK_RADIUS_M)) hazardBlocked.add(edge.id);
        else if (near <= HAZARD_MARGIN_RADIUS_M) hazardMargin.set(edge.id, Math.max(hazardMargin.get(edge.id) ?? 0, HAZARD_MARGIN_SECONDS));
      }
    }
    if (incident.mode === "simulation" && incident.simWorld) {
      incident.simWorld.blocked.forEach((edgeId) => hazardBlocked.add(edgeId));
      incident.simWorld.margins.forEach((seconds, edgeId) => hazardMargin.set(edgeId, Math.max(hazardMargin.get(edgeId) ?? 0, seconds)));
    }
    return { hazardBlocked, hazardMargin };
  }

  /**
   * What the phone draws on its plan during an incident: passages the system knows are unsafe
   * (sensor/simulation hazard) or closed by staff. Same sources the router avoids; cached per
   * hazard/closure revision because every participant view includes it.
   */
  private hazardMapCache = new WeakMap<Incident, { key: string; value: NonNullable<ParticipantView["hazards"]> }>();
  hazardMap(incident: Incident): NonNullable<ParticipantView["hazards"]> {
    const key = `${incident.hazardRevision}|${incident.closureRevision}`;
    const cached = this.hazardMapCache.get(incident);
    if (cached?.key === key) return cached.value;
    const { hazardBlocked } = this.hazardEdges(incident);
    const value = { blockedEdgeIds: [...hazardBlocked].sort(), closedEdgeIds: [...incident.closedEdges.keys()].sort(), revision: incident.hazardRevision };
    this.hazardMapCache.set(incident, { key, value });
    return value;
  }

  constraintsFor(incident: Incident, exclude?: Participant): RoutingConstraints {
    const { hazardBlocked, hazardMargin } = this.hazardEdges(incident);
    const edgeLoad = new Map<string, number>();
    const assemblyLoad = new Map<string, number>();
    for (const participant of this.participantsOf(incident)) {
      if (participant === exclude || !isRouteStatus(participant.advice?.status)) continue;
      for (const edgeId of participant.advice.edgeIds) edgeLoad.set(edgeId, (edgeLoad.get(edgeId) ?? 0) + 1);
      const goal = participant.advice.destination?.nodeId;
      if (goal) assemblyLoad.set(goal, (assemblyLoad.get(goal) ?? 0) + 1);
    }
    if (incident.mode === "simulation" && incident.simWorld) {
      // People the simulation sees on/at a passage. Dividing by LOAD_WEIGHT makes their cost term
      // exactly people ÷ capacity = seconds to clear (weight 1.0), unlike advised-but-not-yet-there
      // participants who count at LOAD_WEIGHT.
      incident.simWorld.crowd.forEach((people, edgeId) => edgeLoad.set(edgeId, (edgeLoad.get(edgeId) ?? 0) + people / LOAD_WEIGHT));
    }
    return { closedEdges: new Set(incident.closedEdges.keys()), hazardBlockedEdges: hazardBlocked, hazardMarginEdges: hazardMargin, edgeLoad, assemblyLoad };
  }

  private fieldFor(incident: Incident, profile: MobilityProfile, constraints: RoutingConstraints, loadStep: number) {
    const key = `${incident.id}:${profile}:${incident.closureRevision}:${incident.hazardRevision}:${loadStep}`;
    const cached = this.fields.get(`${incident.id}:${profile}`);
    if (cached && cached.key === key) return cached.field;
    const field = computeRouteField(this.registry, profile, constraints);
    this.fields.set(`${incident.id}:${profile}`, { key, field });
    return field;
  }

  /** Recompute everyone in an incident after a closure/hazard change (loads spread in steps). */
  recomputeIncident(incident: Incident, reason: RouteReason | null) {
    if (incident.phase !== "evacuate") return;
    this.recomputeBatch(incident, this.participantsOf(incident).sort((a, b) => a.id.localeCompare(b.id)), reason, true);
  }

  /**
   * Recompute many participants with ONE shared load map, updated as each new route is issued
   * (O(n) instead of rebuilding the loads from everyone for every person, which is O(n²)).
   * With `stepLoads` the route field is refreshed every 50 assignments so later people see
   * the load of earlier ones (this is what spreads people over several stairs).
   */
  private recomputeBatch(incident: Incident, participants: Participant[], reason: RouteReason | null, stepLoads: boolean) {
    const shared = this.constraintsFor(incident);
    let loadStep = 0;
    let sinceRefresh = 0;
    for (const participant of participants) {
      if (stepLoads && sinceRefresh >= 50) { loadStep += 1; sinceRefresh = 0; }
      adjustLoad(shared, participant.advice, -1);
      this.recomputeParticipant(participant, reason, stepLoads ? loadStep : -1, shared);
      adjustLoad(shared, participant.advice, 1);
      sinceRefresh += 1;
    }
  }

  recomputeParticipant(participant: Participant, reason: RouteReason | null, loadStep = -1, shared?: RoutingConstraints) {
    const incident = this.incidents.get(participant.incidentId);
    if (!incident || incident.phase !== "evacuate") return;
    const now = this.now();
    const previous = participant.advice;
    const location = participant.location;
    const base = (status: AdviceStatus, message: string): RouteAdvice => ({
      incidentId: incident.id, routeId: previous?.routeId ?? "none", routeRevision: participant.routeRevision,
      mapVersion: this.registry.mapVersion, hazardRevision: incident.hazardRevision, closureRevision: incident.closureRevision,
      issuedAt: now, expiresAt: now + ADVICE_TTL_MS, status,
      start: { nodeId: location?.nodeId ?? null, locationState: participant.locationState, source: location?.source ?? null, observedAt: location?.observedAt ?? null },
      destination: null, nodeIds: [], edgeIds: [], maneuvers: [], reason: null, previousRouteId: previous?.routeId ?? null,
      estimatedSeconds: null, message,
    });
    if (!location?.nodeId || participant.locationState === "unknown" || (participant.locationState === "uncertain" && !location)) {
      this.setAdvice(participant, base("no-location", "ยังไม่ทราบตำแหน่งของคุณ — สแกน QR ที่ป้ายใกล้ตัว หรือเลือกจุดที่อยู่ แล้วระบบจะแนะนำเส้นทาง ระหว่างนี้ทำตามคำสั่งครู"), previous);
      return;
    }
    if (participant.locationState === "uncertain") {
      this.setAdvice(participant, base("no-location", `ยังยืนยันตำแหน่งไม่ได้${participant.locationNote ? ` (${participant.locationNote})` : ""} — ทำตามคำสั่งครูและป้ายทางออก`), previous);
      return;
    }
    const constraints = shared ?? this.constraintsFor(incident, participant);
    const field = this.fieldFor(incident, participant.mobility, constraints, loadStep < 0 ? Math.floor(this.now() / 15_000) : loadStep);
    const best = pathFromField(field, location.nodeId, this.registry);
    if (!best) {
      const standard = participant.mobility === "no-stairs" ? pathFromField(this.fieldFor(incident, "standard", constraints, -1), location.nodeId, this.registry) : null;
      if (participant.mobility === "no-stairs" && standard) {
        if (!participant.helpRequestedAt) this.requestHelp(participant, true);
        this.setAdvice(participant, base("mobility-no-route", "จากจุดนี้ไม่มีเส้นทางที่ไม่ต้องใช้บันไดในแผนที่ที่ตรวจสอบแล้ว ระบบแจ้งเจ้าหน้าที่ให้แล้ว — รอความช่วยเหลือตามแผนของโรงเรียน"), previous);
      } else {
        // Someone with no usable route must reach staff even if they never press "help".
        if (!participant.helpRequestedAt) this.requestHelp(participant, true);
        this.setAdvice(participant, base("no-route", "ยังไม่พบเส้นทางไปจุดรวมพลที่ใช้ได้ตามข้อมูลล่าสุด ระบบแจ้งเจ้าหน้าที่แล้ว — แจ้งครูที่อยู่ใกล้ และทำตามคำสั่งของเจ้าหน้าที่"), previous);
      }
      return;
    }
    // Keep the current route if it is still eligible from here and not clearly worse (hysteresis).
    let chosen = best;
    let changeReason: RouteReason | null = null;
    if ((previous !== null && isRouteStatus(previous.status)) && previous.nodeIds.includes(location.nodeId)) {
      const from = previous.nodeIds.indexOf(location.nodeId);
      const remainingNodes = previous.nodeIds.slice(from);
      const remainingEdges = previous.edgeIds.slice(from);
      const bad = firstIneligibleEdge(remainingEdges, remainingNodes, participant.mobility, this.registry, constraints);
      if (!bad) {
        const currentCost = routeCost(remainingEdges, previous.destination?.nodeId ?? "", this.registry, constraints, true);
        // The roleplay player gets crowd-only changes at most every PLAYER_CONGESTION_COOLDOWN_MS so
        // the phone does not flip between two near-equal routes; fire, smoke and closures stay immediate.
        const coolingDown = Boolean(participant.isPlayer) && now - (participant.lastRouteChangeAt ?? 0) < PLAYER_CONGESTION_COOLDOWN_MS;
        if (!clearlyBetter(currentCost, best.cost) || coolingDown) chosen = { nodeIds: remainingNodes, edgeIds: remainingEdges, cost: currentCost, goalId: previous.destination?.nodeId ?? best.goalId };
        else changeReason = incident.simWorld
          ? { code: "congestion", text: `ทางเดิมมีคนแออัด (ข้อมูลจำลอง) เส้นทางใหม่คาดว่าเร็วกว่าประมาณ ${Math.round(currentCost - best.cost)} วินาที` }
          : { code: "congestion", text: `มีผู้ได้รับคำแนะนำให้ใช้ทางเดิมจำนวนมาก เส้นทางใหม่คาดว่าเร็วกว่าประมาณ ${Math.round(currentCost - best.cost)} วินาที` };
      } else if (bad !== "invalid") {
        const closed = incident.closedEdges.get(bad.id);
        changeReason = closed
          ? { code: "closure", text: `${passageLabel(bad.id, this.registry)} ถูกปิด${closed.reason ? ` (${closed.reason})` : ""}` }
          : incident.simWorld?.blocked.has(bad.id)
            ? { code: "hazard", text: `เส้นทางเดิมผ่าน ${passageLabel(bad.id, this.registry)} ซึ่งไฟหรือควันในแบบจำลองปิดอยู่` }
            : { code: "hazard", text: `เส้นทางเดิมผ่าน ${passageLabel(bad.id, this.registry)} ซึ่งอยู่ในพื้นที่ที่เซนเซอร์ตรวจพบเหตุ` };
      }
    } else if ((previous !== null && isRouteStatus(previous.status))) {
      changeReason = reason?.code === "location-changed" ? reason : { code: "location-changed", text: "ตำแหน่งของคุณเปลี่ยนจากเส้นทางเดิม" };
    }
    const sameRoute = (previous !== null && isRouteStatus(previous.status)) && previous.edgeIds.join("|").endsWith(chosen.edgeIds.join("|")) && previous.destination?.nodeId === chosen.goalId;
    const destination = this.registry.nodeMap.get(chosen.goalId);
    const advice: RouteAdvice = {
      ...base(participant.locationState === "stale" ? "stale-location" : "ok",
        participant.locationState === "stale"
          ? "ตำแหน่งที่ใช้คำนวณเป็นข้อมูลเก่า — สแกน QR หรือยืนยันจุดที่อยู่เพื่อให้เส้นทางถูกต้อง"
          : "เดินอพยพอย่างมีสติ ไม่วิ่ง ไม่ผลักกัน และทำตามคำสั่งครู"),
      status: participant.locationState === "stale" ? "stale-location" : "ok",
      destination: destination ? { nodeId: destination.id, name: displayNodeName(destination) } : null,
      nodeIds: chosen.nodeIds,
      edgeIds: chosen.edgeIds,
      maneuvers: buildManeuvers(chosen.nodeIds, chosen.edgeIds, this.registry),
      estimatedSeconds: Math.round(chosen.cost),
    };
    if (sameRoute && previous) {
      // Same route: refresh freshness only (no new revision, no "route changed" screen).
      advice.routeId = previous.routeId;
      advice.routeRevision = previous.routeRevision;
      advice.reason = previous.reason;
      advice.previousRouteId = previous.previousRouteId;
      participant.advice = advice;
      this.touchParticipant(participant);
      return;
    }
    participant.routeRevision += 1;
    participant.lastRouteChangeAt = now;
    advice.routeRevision = participant.routeRevision;
    advice.routeId = `r-${participant.id.slice(2)}-${participant.routeRevision}`;
    advice.previousRouteId = (previous !== null && isRouteStatus(previous.status)) ? previous.routeId : null;
    advice.reason = (previous !== null && isRouteStatus(previous.status)) ? (changeReason ?? reason) : (reason ?? { code: "initial", text: "เริ่มอพยพตามแผน" });
    this.setAdvice(participant, advice, previous);
  }

  private setAdvice(participant: Participant, advice: RouteAdvice, previous: RouteAdvice | null) {
    const routed = isRouteStatus(advice.status);
    const changed = !previous || previous.status !== advice.status || previous.routeId !== advice.routeId
      || (!routed && previous.message !== advice.message);
    if (!routed) {
      if (changed) {
        participant.routeRevision += 1;
        advice.routeRevision = participant.routeRevision;
        advice.routeId = `n-${participant.id.slice(2)}-${participant.routeRevision}`;
      } else if (previous) {
        advice.routeId = previous.routeId;
        advice.routeRevision = previous.routeRevision;
      }
      advice.previousRouteId = previous && isRouteStatus(previous.status) ? previous.routeId : previous?.previousRouteId ?? null;
    }
    participant.advice = advice;
    if (changed) {
      participant.delivery = { ...emptyDelivery(), accepted: this.now() };
      this.log("routing", "system", "advice.issued", `${participant.id} rev ${advice.routeRevision} ${advice.status}${advice.destination ? ` → ${advice.destination.name}` : ""}${advice.reason && previous ? ` (${advice.reason.text})` : ""}`, participant.incidentId);
    }
    this.touchParticipant(participant);
  }

  /** Re-issue fresh advice for everyone evacuating (expiry refresh + load rebalancing). */
  tick() {
    const now = this.now();
    for (const incident of this.incidents.values()) {
      if (incident.phase !== "evacuate") continue;
      const due: Participant[] = [];
      for (const participant of this.participantsOf(incident)) {
        if (participant.location && participant.locationState === "confirmed" && now - participant.location.observedAt > LOCATION_FRESH_MS) participant.locationState = "stale";
        if (!participant.advice || participant.advice.expiresAt - now < ADVICE_TTL_MS / 2) due.push(participant);
      }
      if (due.length) this.recomputeBatch(incident, due, null, false);
    }
    this.markSilentSensors();
  }

  // ------------------------------------------------------------------ views

  incidentSummary(incident: Incident): IncidentSummary {
    return {
      id: incident.id, mode: incident.mode, phase: incident.phase, title: incident.title, joinCode: incident.joinCode,
      createdAt: incident.createdAt, evacuateAt: incident.evacuateAt, endedAt: incident.endedAt,
      hazardRevision: incident.hazardRevision, closureRevision: incident.closureRevision,
      hazards: [
        ...[...incident.sensors.values()].filter((sensor) => sensor.status === "alarm").map((sensor) => ({
          zoneId: sensor.zoneId, label: `${SENSOR_TYPE_TH[sensor.type]} ${zoneLabel(sensor.zoneId)}`, kind: "measured" as const, since: sensor.lastReceivedAt ?? incident.createdAt,
        })),
        ...(incident.mode === "simulation" && incident.simWorld ? incident.simWorld.zones.map((zone) => ({
          zoneId: zone.zoneId, label: `ไฟ/ควันในแบบจำลอง ${zone.label}`, kind: "simulated" as const, since: incident.simWorld!.receivedAt,
        })) : []),
      ],
      simWorld: incident.mode === "simulation" && incident.simWorld ? {
        source: "simulator-ground-truth", receivedAt: incident.simWorld.receivedAt, simTime: incident.simWorld.simTime,
        blockedEdges: incident.simWorld.blocked.size, crowdedEdges: incident.simWorld.crowd.size,
      } : null,
      closedEdgeIds: [...incident.closedEdges.keys()],
      announcements: incident.announcements,
    };
  }

  participantView(participant: Participant): ParticipantView {
    const incident = this.incidents.get(participant.incidentId) ?? null;
    return {
      revision: participant.viewRevision,
      serverTime: this.now(),
      mapVersion: this.registry.mapVersion,
      incident: incident ? this.incidentSummary(incident) : null,
      me: {
        participantId: participant.id, displayName: participant.displayName, isTest: participant.isTest, isPlayer: Boolean(participant.isPlayer), mobility: participant.mobility,
        location: participant.location, locationState: participant.locationState, locationNote: participant.locationNote,
        arrival: participant.arrival, helpRequestedAt: participant.helpRequestedAt,
      },
      advice: participant.advice,
      hazards: incident && incident.phase !== "ended" ? this.hazardMap(incident) : null,
    };
  }

  staffSnapshot(): StaffSnapshot {
    const now = this.now();
    const incident = this.activeIncidentId ? this.incidents.get(this.activeIncidentId) ?? null : null;
    const participants = incident ? this.participantsOf(incident) : [];
    const bots = participants.filter((participant) => participant.isBot);
    const rows: ParticipantRow[] = participants.filter((participant) => !participant.isBot).map((participant) => ({
      participantId: participant.id, displayName: participant.displayName, isTest: participant.isTest, isPlayer: Boolean(participant.isPlayer),
      connected: participant.connections > 0, connections: participant.connections, lastSeenAt: participant.lastSeenAt,
      location: participant.location, locationState: participant.locationState,
      routeId: participant.advice?.routeId ?? null, routeRevision: participant.routeRevision,
      adviceStatus: participant.advice?.status ?? null, destinationName: participant.advice?.destination?.name ?? null,
      nextInstruction: participant.advice?.maneuvers[0]?.text ?? participant.advice?.message ?? null,
      delivery: participant.delivery, arrival: participant.arrival, helpRequestedAt: participant.helpRequestedAt, blockedReports: participant.blockedReports,
    }));
    const occupancy: ZoneOccupancy[] = [];
    const bottlenecks: BottleneckRow[] = [];
    if (incident) {
      const planned = new Map<string, number>();
      this.registry.plannedByRoom.forEach((count, roomId) => {
        const zone = this.registry.zoneOf.get(roomId);
        if (zone) planned.set(zone, (planned.get(zone) ?? 0) + count);
      });
      const byZone = new Map<string, { participants: number; devices: number; routed: number }>();
      for (const participant of participants) {
        const zone = participant.location?.zoneId;
        if (zone && participant.locationState === "confirmed") {
          const entry = byZone.get(zone) ?? { participants: 0, devices: 0, routed: 0 };
          entry.participants += 1;
          if (participant.connections > 0) entry.devices += 1;
          byZone.set(zone, entry);
        }
        for (const nodeId of new Set(isRouteStatus(participant.advice?.status) ? participant.advice!.nodeIds : [])) {
          const zoneOfNode = this.registry.zoneOf.get(nodeId);
          if (!zoneOfNode) continue;
          const entry = byZone.get(zoneOfNode) ?? { participants: 0, devices: 0, routed: 0 };
          entry.routed += 1;
          byZone.set(zoneOfNode, entry);
        }
      }
      const zones = new Set([...planned.keys(), ...byZone.keys(), ...incident.teacherCounts.keys()]);
      for (const zoneId of [...zones].sort()) {
        const live = byZone.get(zoneId) ?? { participants: 0, devices: 0, routed: 0 };
        const teacher = incident.teacherCounts.get(zoneId);
        const teacherFresh = teacher && now - teacher.at < 10 * 60_000 ? teacher : null;
        occupancy.push({
          zoneId, label: zoneLabel(zoneId), participants: live.participants, connectedDevices: live.devices,
          plannedHeadcount: planned.get(zoneId) ?? 0,
          teacherCount: teacher?.count ?? null, teacherCountAt: teacher?.at ?? null,
          // A missing phone report never means an empty zone: without a teacher count we only know a lower bound.
          estimate: teacherFresh ? teacherFresh.count : live.participants > 0 ? live.participants : null,
          coverage: teacherFresh ? "teacher" : live.participants > 0 ? "devices-partial" : (planned.get(zoneId) ?? 0) > 0 ? "plan-only" : "none",
          routedThrough: live.routed,
        });
      }
      const constraints = this.constraintsFor(incident);
      constraints.edgeLoad.forEach((assigned, edgeId) => {
        const edge = this.registry.edgeMap.get(edgeId);
        if (!edge || edge.kind === "outdoor" || edge.kind === "assembly") return;
        const from = this.registry.nodeMap.get(edge.from);
        bottlenecks.push({
          edgeId, label: passageLabel(edgeId, this.registry), buildingId: this.registry.buildingOf.get(edge.from) ?? "site",
          floor: from?.floor ?? 0, widthM: edge.width, capacityPerSecond: edge.capacityPerSecond, assigned,
          clearanceSeconds: Math.round(assigned / Math.max(0.2, edge.capacityPerSecond)),
        });
      });
      bottlenecks.sort((a, b) => b.clearanceSeconds - a.clearanceSeconds);
    }
    const connected = rows.filter((row) => row.connected);
    return {
      revision: this.staffRevision,
      serverTime: now,
      mapVersion: this.registry.mapVersion,
      liveModeAvailable: this.options.liveEnabled,
      liveReadiness: this.options.liveReadiness,
      incidents: [...this.incidents.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map((candidate) => this.incidentSummary(candidate)),
      activeIncidentId: incident?.id ?? null,
      participants: rows.slice(0, 200),
      counts: {
        connectedDevices: connected.length,
        openStreams: rows.reduce((sum, row) => sum + row.connections, 0),
        sessions: rows.length,
        registeredParticipants: rows.filter((row) => !row.isTest).length,
        testParticipants: rows.filter((row) => row.isTest).length,
        withConfirmedLocation: rows.filter((row) => row.locationState === "confirmed").length,
        staleOrUnknownLocation: rows.filter((row) => row.locationState !== "confirmed").length,
        selfReportedArrived: rows.filter((row) => row.arrival.selfReportedAt).length,
        teacherConfirmed: rows.filter((row) => row.arrival.teacherConfirmedAt).length,
        plannedPopulation: [...this.registry.plannedByRoom.values()].reduce((sum, count) => sum + count, 0),
        simBots: bots.length,
        simBotsRouted: bots.filter((bot) => isRouteStatus(bot.advice?.status)).length,
        simBotsArrived: bots.filter((bot) => bot.arrival.selfReportedAt).length,
      },
      occupancy,
      bottlenecks: bottlenecks.slice(0, 10),
      sensors: incident ? [...incident.sensors.values()] : [],
      log: this.recentLog.filter((entry) => !incident || entry.incidentId === incident.id || entry.incidentId === null).slice(-60),
    };
  }
}

const STATUS_TH: Record<SensorState["status"], string> = {
  normal: "ปกติ", alarm: "ตรวจพบเหตุ", fault: "ขัดข้อง", offline: "ออฟไลน์", unknown: "ไม่ทราบ", test: "ทดสอบ/บำรุงรักษา",
};

const SENSOR_TYPE_TH: Record<SensorState["type"], string> = {
  smoke: "ตรวจพบควัน", heat: "ตรวจพบความร้อน", flame: "ตรวจพบเปลวไฟ", "manual-call-point": "มีการกดแจ้งเหตุ", "door-contact": "สถานะประตู", "people-counter": "ตัวนับคน",
};

/** Announcement templates (staff pick one; no free-form emergency text). */
function adjustLoad(constraints: RoutingConstraints, advice: RouteAdvice | null, delta: 1 | -1) {
  if (!advice || !isRouteStatus(advice.status)) return;
  // The batch owns this constraints object and its maps are plain Maps (built in constraintsFor).
  const edgeLoad = constraints.edgeLoad as Map<string, number>;
  const assemblyLoad = constraints.assemblyLoad as Map<string, number>;
  for (const edgeId of advice.edgeIds) edgeLoad.set(edgeId, Math.max(0, (edgeLoad.get(edgeId) ?? 0) + delta));
  const goal = advice.destination?.nodeId;
  if (goal) assemblyLoad.set(goal, Math.max(0, (assemblyLoad.get(goal) ?? 0) + delta));
}

export const ANNOUNCEMENT_TEMPLATES: Record<string, (params: Record<string, string>, registry: MapRegistry) => string | null> = {
  "evacuate-now": () => "เริ่มอพยพ: เดินอพยพอย่างมีสติตามเส้นทางในแอปและป้ายทางออก ไม่วิ่ง ไม่ผลักกัน",
  "avoid-passage": (params, registry) => {
    const group = passageGroups(registry).find((candidate) => candidate.id === params.groupId);
    return group ? `ห้ามใช้ ${group.label} ให้ใช้ทางอื่นตามคำแนะนำ` : null;
  },
  "await-teacher": () => "เมื่อถึงจุดรวมพล ให้อยู่กับกลุ่มและรอครูตรวจนับ ห้ามกลับเข้าอาคาร",
  "help-coming": () => "ผู้ที่ขอความช่วยเหลือ: อยู่ในจุดที่ปลอดภัยที่สุดใกล้ตัว เจ้าหน้าที่กำลังประสานงาน",
  "drill-ended": () => "จบการฝึกซ้อม ขอบคุณที่ร่วมฝึก",
};

export type { DataMode };
