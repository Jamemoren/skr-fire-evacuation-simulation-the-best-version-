/**
 * Transport-neutral API: every /api route, the realtime streams and their auth rules, with no
 * Node.js dependency. Two adapters drive it:
 *   - server/index.ts — real HTTP + Server-Sent Events (phones on the network, Render, LAN);
 *   - src/evac-local/localBackend.ts — inside the browser, so the website's simulated phone and the
 *     roleplay phone work without starting a separate server (nothing leaves the page).
 * Both run exactly this code, so behaviour cannot drift between them.
 */
import { ApiError, ANNOUNCEMENT_TEMPLATES, type IncidentService, type Participant } from "./incidentService";
import { buildMapPackage, passageGroups } from "../src/evac/mapRegistry";
import type { DataMode, IncidentMode, LocationSource, Role, SensorReading, SensorStatus, SensorType, StreamMessage } from "../src/evac/protocol";

export interface ApiRequest {
  method: string;
  url: URL;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  /** Address used for rate limiting. */
  clientAddress: string;
  /** True when the caller is on the same machine (the server's own dashboard, or the in-browser backend). */
  loopback: boolean;
  /** Parsed JSON object body; rejects bodies over `limit` bytes or that are not a JSON object. */
  readJson(limit?: number): Promise<Record<string, unknown>>;
}

/** One realtime connection. `send` carries a numbered event, `comment` a keep-alive line. */
export interface StreamSink {
  send(id: number, message: StreamMessage): void;
  comment(text: string): void;
  end(): void;
}

export type ApiOutcome =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "not-modified"; headers: Record<string, string> }
  /** Open a realtime stream; returns the function to call when the client disconnects. */
  | { kind: "stream"; attach(sink: StreamSink): () => void };

export interface ApiCoreOptions {
  service: IncidentService;
  staffToken: string;
  sensorKey: string | null;
  allowLoopbackStaff: boolean;
  liveEnabled: boolean;
  /** Constant-time string comparison (timing-safe on the server). */
  safeEqual(a: string, b: string): boolean;
  randomHex(bytes: number): string;
  /** Multiplies every rate limit (load tests from one machine). */
  rateScale?: number;
  /** Extra platform fields for /api/health (uptime, memory, TLS…). */
  health?(): Record<string, unknown>;
  /** Run later; 0 = as soon as possible (setImmediate on Node, a macrotask in the browser). */
  schedule(fn: () => void, delayMs: number): void;
}

class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private ratePerSecond: number, private burst: number) {}
  take(key: string) {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.ratePerSecond);
    bucket.at = now;
    if (bucket.tokens < 1) { this.buckets.set(key, bucket); return false; }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 20_000) this.buckets.clear();
    return true;
  }
}

// Small schema helpers: every field is checked; unknown values are rejected, not coerced.
const str = (body: Record<string, unknown>, key: string, max = 120, optional = false): string | undefined => {
  const value = body[key];
  if (value === undefined || value === null || value === "") { if (optional) return undefined; throw new ApiError(400, "missing-field", `ต้องระบุ ${key}`); }
  if (typeof value !== "string" || value.length > max) throw new ApiError(400, "bad-field", `${key} ไม่ถูกต้อง`);
  return value;
};
const num = (body: Record<string, unknown>, key: string, min: number, max: number, optional = false): number | undefined => {
  const value = body[key];
  if (value === undefined || value === null) { if (optional) return undefined; throw new ApiError(400, "missing-field", `ต้องระบุ ${key}`); }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ApiError(400, "bad-field", `${key} อยู่นอกช่วงที่รับได้`);
  return value;
};
const oneOf = <T extends string>(body: Record<string, unknown>, key: string, values: readonly T[], optional = false): T | undefined => {
  const value = body[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw new ApiError(400, "bad-field", `${key} ไม่ถูกต้อง`);
  return value as T;
};
const bool = (body: Record<string, unknown>, key: string) => body[key] === true;

const SENSOR_TYPES = ["smoke", "heat", "flame", "manual-call-point", "door-contact", "people-counter"] as const satisfies readonly SensorType[];
const SENSOR_STATUSES = ["normal", "alarm", "fault", "offline", "unknown", "test"] as const satisfies readonly SensorStatus[];
const DATA_MODES = ["simulated", "drill", "live"] as const satisfies readonly DataMode[];
const LOCATION_SOURCES = ["qr", "manual", "geolocation", "simulator"] as const satisfies readonly LocationSource[];

function parseReading(raw: unknown): SensorReading {
  if (!raw || typeof raw !== "object") throw new ApiError(400, "bad-reading", "ข้อมูลเซนเซอร์ไม่ถูกต้อง");
  const body = raw as Record<string, unknown>;
  const value = body.value === null ? null : num(body, "value", -1e6, 1e6);
  return {
    sensorId: str(body, "sensorId", 80)!,
    type: oneOf(body, "type", SENSOR_TYPES)!,
    value: value ?? null,
    unit: body.unit === null ? null : str(body, "unit", 16, true) ?? null,
    status: oneOf(body, "status", SENSOR_STATUSES)!,
    eventId: str(body, "eventId", 80)!,
    sequence: num(body, "sequence", 0, Number.MAX_SAFE_INTEGER)!,
    observedAt: num(body, "observedAt", 0, 8.64e15)!,
    quality: oneOf(body, "quality", ["good", "suspect", "bad"] as const, true) ?? "good",
    mode: oneOf(body, "mode", DATA_MODES)!,
  };
}

interface Actor { role: Role; id: string; incidentId?: string }
interface Stream { sink: StreamSink; seq: number; participant?: Participant; staff?: boolean }
type Handler = (req: ApiRequest, params: string[]) => Promise<ApiOutcome> | ApiOutcome;

const json = (status: number, body: unknown, headers?: Record<string, string>): ApiOutcome => ({ kind: "json", status, body, headers });

export function createApiCore(options: ApiCoreOptions) {
  const { service, staffToken, sensorKey, safeEqual } = options;
  const scale = Math.max(1, options.rateScale ?? 1);
  const limits = {
    join: new RateLimiter(0.5 * scale, 20 * scale),
    participant: new RateLimiter(4, 12),
    staff: new RateLimiter(30 * scale, 60 * scale),
    sensor: new RateLimiter(50 * scale, 200 * scale),
    general: new RateLimiter(40 * scale, 80 * scale),
  };
  const teacherTokens = new Map<string, { incidentId: string; createdAt: number }>();

  const bearer = (req: ApiRequest) => {
    const header = String(req.headers.authorization ?? "");
    return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  };
  const staffActor = (req: ApiRequest, allowTeacher = false): Actor => {
    const value = bearer(req);
    if (value && safeEqual(value, staffToken)) return { role: "staff", id: "staff" };
    const teacher = value ? teacherTokens.get(value) : undefined;
    if (allowTeacher && teacher) return { role: "teacher", id: `teacher-${value.slice(0, 6)}`, incidentId: teacher.incidentId };
    throw new ApiError(401, "staff-only", "ต้องใช้สิทธิ์เจ้าหน้าที่");
  };
  const staffGuard = (req: ApiRequest, allowTeacher = false) => {
    const actor = staffActor(req, allowTeacher);
    if (!limits.staff.take(actor.id)) throw new ApiError(429, "rate-limited", "สั่งงานถี่เกินไป");
    return actor;
  };
  const participantFromRequest = (req: ApiRequest) => {
    const participant = service.participantByToken(bearer(req));
    if (!limits.participant.take(participant.id)) throw new ApiError(429, "rate-limited", "ส่งข้อมูลถี่เกินไป");
    return participant;
  };

  // ---------------------------------------------------------------- realtime streams
  const participantStreams = new Map<string, Set<Stream>>();
  const staffStreams = new Set<Stream>();
  const pendingParticipants = new Set<string>();
  let staffDirty = false;
  let flushScheduled = false;
  let lastStaffPush = 0;

  const writeEvent = (stream: Stream, message: StreamMessage) => { stream.seq += 1; stream.sink.send(stream.seq, message); };
  const pushParticipant = (participantId: string) => {
    const streams = participantStreams.get(participantId);
    if (!streams?.size) return;
    let participant: Participant;
    try { participant = service.getParticipant(participantId); } catch {
      streams.forEach((stream) => { writeEvent(stream, { type: "error", code: "bad-session", message: "เซสชันนี้ถูกล้างแล้ว กรุณาเข้าร่วมใหม่" }); stream.sink.end(); });
      participantStreams.delete(participantId);
      return;
    }
    const view = service.participantView(participant);
    streams.forEach((stream) => writeEvent(stream, { type: "participant", view }));
    service.markSent(participant);
  };
  const flush = () => {
    flushScheduled = false;
    pendingParticipants.forEach(pushParticipant);
    pendingParticipants.clear();
    if (staffDirty && staffStreams.size) {
      const now = Date.now();
      if (now - lastStaffPush < 400) { scheduleFlush(400 - (now - lastStaffPush)); return; }
      lastStaffPush = now;
      staffDirty = false;
      const snapshot = service.staffSnapshot();
      staffStreams.forEach((stream) => writeEvent(stream, { type: "staff", snapshot }));
    }
  };
  function scheduleFlush(delay = 0) {
    if (flushScheduled) return;
    flushScheduled = true;
    options.schedule(flush, delay);
  }
  service.onChange((kind, participantId) => {
    if (kind === "participant" && participantId) pendingParticipants.add(participantId);
    staffDirty = true;
    scheduleFlush();
  });

  // ---------------------------------------------------------------- routes
  const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
  const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

  route("GET", /^\/api\/health$/, () => json(200, {
    ok: true, mapVersion: service.registry.mapVersion,
    incidents: service.incidents.size, participants: service.participants.size,
    streams: [...participantStreams.values()].reduce((sum, set) => sum + set.size, 0) + staffStreams.size,
    liveModeAvailable: options.liveEnabled,
    ...(options.health?.() ?? {}),
  }));

  route("GET", /^\/api\/map$/, (req) => {
    const etag = `"${service.registry.mapVersion}"`;
    if (req.headers["if-none-match"] === etag) return { kind: "not-modified", headers: { etag } };
    return json(200, buildMapPackage(service.registry), { etag, "cache-control": "no-cache" });
  });

  route("GET", /^\/api\/passages$/, () => json(200, { groups: passageGroups(service.registry), templates: Object.keys(ANNOUNCEMENT_TEMPLATES) }));
  route("GET", /^\/api\/sensors\/registry$/, () => json(200, { sensors: service.registry.sensors }));

  // Staff token for a dashboard running on the same machine as the server (prototype convenience).
  route("GET", /^\/api\/auth\/local-staff$/, (req) => {
    if (!options.allowLoopbackStaff || !req.loopback) throw new ApiError(403, "not-local", "รับสิทธิ์อัตโนมัติได้เฉพาะเครื่องที่รันเซิร์ฟเวอร์ — ใส่รหัสเจ้าหน้าที่แทน");
    return json(200, { token: staffToken, role: "staff" });
  });
  route("POST", /^\/api\/auth\/check$/, (req) => { const actor = staffActor(req, true); return json(200, { role: actor.role }); });

  // --- participant
  route("POST", /^\/api\/participant\/join$/, async (req) => {
    if (!limits.join.take(req.clientAddress)) throw new ApiError(429, "rate-limited", "ลองใหม่อีกครั้งในอีกสักครู่");
    const body = await req.readJson();
    const participant = service.join({
      joinCode: str(body, "joinCode", 12, true),
      previewTicket: str(body, "previewTicket", 64, true),
      deviceKey: str(body, "deviceKey", 64)!,
      displayName: str(body, "displayName", 40, true),
      mobility: oneOf(body, "mobility", ["standard", "no-stairs"] as const, true),
    });
    return json(200, { token: participant.token, participantId: participant.id, incidentId: participant.incidentId, mapVersion: service.registry.mapVersion });
  });

  route("GET", /^\/api\/participant\/me$/, (req) => {
    const participant = service.participantByToken(bearer(req));
    participant.lastSeenAt = Date.now();
    return json(200, service.participantView(participant));
  });

  route("POST", /^\/api\/participant\/location$/, async (req) => {
    const participant = participantFromRequest(req);
    const body = await req.readJson();
    const source = oneOf(body, "source", LOCATION_SOURCES)!;
    const geo = source === "geolocation" && body.geo && typeof body.geo === "object" ? body.geo as Record<string, unknown> : null;
    service.reportLocation(participant, {
      source,
      checkpointId: str(body, "checkpointId", 24, true) ?? null,
      nodeId: str(body, "nodeId", 80, true) ?? null,
      observedAt: num(body, "observedAt", 0, 8.64e15)!,
      clientSeq: num(body, "clientSeq", 0, Number.MAX_SAFE_INTEGER)!,
      mapVersion: str(body, "mapVersion", 40)!,
      accuracyM: num(body, "accuracyM", 0, 100_000, true) ?? null,
      confirmJump: bool(body, "confirmJump"),
      geo: geo ? { lat: num(geo, "lat", -90, 90)!, lon: num(geo, "lon", -180, 180)!, accuracy: num(geo, "accuracy", 0, 100_000)! } : null,
      position: source === "simulator" && Array.isArray(body.position) && body.position.length === 3 && body.position.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 10_000)
        ? [body.position[0] as number, body.position[1] as number, body.position[2] as number] : null,
      headingDeg: source === "simulator" ? num(body, "headingDeg", -720, 720, true) ?? null : null,
    });
    return json(200, { ok: true, view: service.participantView(participant) });
  });

  route("POST", /^\/api\/participant\/ack$/, async (req) => {
    const participant = participantFromRequest(req);
    const body = await req.readJson();
    const current = service.acknowledge(participant, str(body, "routeId", 64)!, oneOf(body, "stage", ["received", "viewed", "confirmed"] as const)!);
    return json(200, { ok: true, current });
  });

  route("POST", /^\/api\/participant\/help$/, (req) => { const p = participantFromRequest(req); service.requestHelp(p); return json(200, { ok: true }); });
  route("POST", /^\/api\/participant\/blocked$/, async (req) => {
    const participant = participantFromRequest(req);
    const body = await req.readJson();
    service.reportBlocked(participant, str(body, "edgeId", 80, true) ?? null);
    return json(200, { ok: true });
  });
  route("POST", /^\/api\/participant\/arrived$/, async (req) => {
    const participant = participantFromRequest(req);
    const body = await req.readJson();
    service.reportArrived(participant, str(body, "assemblyId", 80, true) ?? null);
    return json(200, { ok: true });
  });
  route("POST", /^\/api\/participant\/profile$/, async (req) => {
    const participant = participantFromRequest(req);
    const body = await req.readJson();
    service.setMobility(participant, oneOf(body, "mobility", ["standard", "no-stairs"] as const)!);
    return json(200, { ok: true });
  });
  route("POST", /^\/api\/participant\/leave$/, (req) => {
    const participant = service.participantByToken(bearer(req));
    service.log(participant.id, participant.isTest ? "preview" : "participant", "participant.left", "ออกจากรอบ", participant.incidentId);
    service.removeParticipant(participant);
    return json(200, { ok: true });
  });

  // --- realtime stream (EventSource cannot send headers: the session token comes in the query and is never logged)
  route("GET", /^\/api\/stream$/, (req) => {
    const participantToken = req.url.searchParams.get("participant");
    const staffQuery = req.url.searchParams.get("staff");
    if (participantToken) {
      const participant = service.participantByToken(participantToken);
      return {
        kind: "stream",
        attach(sink) {
          const stream: Stream = { sink, seq: 0, participant };
          const set = participantStreams.get(participant.id) ?? new Set<Stream>();
          set.add(stream);
          participantStreams.set(participant.id, set);
          service.connectionOpened(participant);
          writeEvent(stream, { type: "participant", view: service.participantView(participant) });
          service.markSent(participant);
          return () => {
            set.delete(stream);
            if (!set.size) participantStreams.delete(participant.id);
            service.connectionClosed(participant);
          };
        },
      };
    }
    if (staffQuery && safeEqual(staffQuery, staffToken)) {
      return {
        kind: "stream",
        attach(sink) {
          const stream: Stream = { sink, seq: 0, staff: true };
          staffStreams.add(stream);
          writeEvent(stream, { type: "staff", snapshot: service.staffSnapshot() });
          return () => { staffStreams.delete(stream); };
        },
      };
    }
    throw new ApiError(401, "bad-session", "ต้องเข้าร่วมก่อนจึงรับข้อมูลสดได้");
  });

  // --- staff / incident control
  route("POST", /^\/api\/admin\/incidents$/, async (req) => {
    const actor = staffGuard(req);
    const body = await req.readJson();
    const incident = service.createIncident(oneOf(body, "mode", ["simulation", "drill", "live"] as const satisfies readonly IncidentMode[])!, str(body, "title", 80, true) ?? "", actor.id, body.activate !== false);
    return json(200, { incident: service.incidentSummary(incident) });
  });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/active$/, (req, [id]) => { staffGuard(req); service.setActive(id); return json(200, { ok: true }); });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/evacuate$/, (req, [id]) => { const a = staffGuard(req); service.startEvacuation(id, a.id); return json(200, { ok: true }); });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/end$/, (req, [id]) => { const a = staffGuard(req); service.endIncident(id, a.id); return json(200, { ok: true }); });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/reset-test$/, async (req, [id]) => { const a = staffGuard(req); const body = await req.readJson(); service.resetTestScenario(id, a.id, oneOf(body, "scope", ["all", "bots"] as const, true) ?? "all"); return json(200, { ok: true }); });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/closures$/, async (req, [id]) => {
    const actor = staffGuard(req);
    const body = await req.readJson();
    const edgeIds = Array.isArray(body.edgeIds) ? body.edgeIds.filter((value): value is string => typeof value === "string").slice(0, 50) : undefined;
    service.setClosure(id, { groupId: str(body, "groupId", 40, true), edgeIds }, body.closed !== false, str(body, "reason", 80, true) ?? "", actor.id, actor.role);
    return json(200, { ok: true });
  });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/announce$/, async (req, [id]) => {
    const actor = staffGuard(req);
    const body = await req.readJson();
    const params: Record<string, string> = {};
    if (body.params && typeof body.params === "object") for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) if (typeof value === "string" && value.length < 60) params[key] = value;
    return json(200, { announcement: service.announce(id, str(body, "templateId", 40)!, params, actor.id) });
  });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/preview-ticket$/, (req, [id]) => {
    const actor = staffGuard(req);
    return json(200, { ticket: service.createPreviewTicket(id, actor.id), incidentId: id });
  });
  // Roleplay simulator: a ticket for the person the user controls (simulation incidents only).
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/player-ticket$/, (req, [id]) => {
    const actor = staffGuard(req);
    return json(200, { ticket: service.createPreviewTicket(id, actor.id, "player"), incidentId: id });
  });
  // Simulator adapter: ground truth of the 3D simulation (fire/smoke-blocked passages, margins, crowd).
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/sim-world$/, async (req, [id]) => {
    const actor = staffActor(req);
    const body = await req.readJson(256 * 1024);
    const list = (value: unknown, max: number) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.length < 100).slice(0, max);
    const record = (value: unknown) => {
      const out: Record<string, number> = {};
      if (value && typeof value === "object") for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 2000)) if (key.length < 100 && typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
      return out;
    };
    return json(200, service.applySimWorld(id, { blocked: list(body.blocked, 2000), margins: record(body.margins), crowd: record(body.crowd), simTime: num(body, "simTime", 0, 1e7) ?? 0 }, actor.id));
  });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/teacher-token$/, (req, [id]) => {
    const actor = staffGuard(req);
    service.getIncident(id);
    const value = options.randomHex(18);
    teacherTokens.set(value, { incidentId: id, createdAt: Date.now() });
    service.log(actor.id, "staff", "teacher.token", "ออกสิทธิ์ครูสำหรับยืนยันตัวและนับคน", id);
    return json(200, { token: value });
  });
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/zone-count$/, async (req, [id]) => {
    const actor = staffGuard(req, true);
    if (actor.incidentId && actor.incidentId !== id) throw new ApiError(403, "wrong-incident", "สิทธิ์ครูใช้ได้เฉพาะรอบที่ออกให้");
    const body = await req.readJson();
    service.recordTeacherCount(id, str(body, "zoneId", 60)!, num(body, "count", 0, 2000)!, actor.id, actor.role);
    return json(200, { ok: true });
  });
  // Simulator A: bots of the 3D crowd simulation carrying a simulated phone (simulation incidents only).
  route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/sim-bots$/, async (req, [id]) => {
    const actor = staffActor(req);
    const body = await req.readJson(512 * 1024);
    const raw = Array.isArray(body.bots) ? body.bots : null;
    if (!raw || raw.length > 4000) throw new ApiError(400, "bad-bots", "ต้องส่ง bots ไม่เกิน 4,000 รายการ");
    const bots = raw.map((entry: unknown) => {
      const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return {
        botId: num(item, "botId", 0, 100_000)!,
        nodeId: item.nodeId === null ? null : str(item, "nodeId", 80, true) ?? null,
        mobility: oneOf(item, "mobility", ["standard", "no-stairs"] as const, true),
      };
    });
    return json(200, service.syncSimBots(id, bots, bool(body, "full"), actor.id, bool(body, "replace")));
  });
  route("GET", /^\/api\/admin\/incidents\/([\w-]+)\/sim-bots\/(\d+)$/, (req, [id, botId]) => {
    staffGuard(req);
    return json(200, { participantId: service.simBotParticipant(id, Number(botId)) });
  });
  route("POST", /^\/api\/admin\/participants\/([\w-]+)\/confirm-arrival$/, (req, [id]) => {
    const actor = staffGuard(req, true);
    const participant = service.getParticipant(id);
    if (actor.incidentId && actor.incidentId !== participant.incidentId) throw new ApiError(403, "wrong-incident", "สิทธิ์ครูใช้ได้เฉพาะรอบที่ออกให้");
    service.confirmArrival(participant, actor.id, actor.role);
    return json(200, { ok: true });
  });
  // Demo controls act only on test participants (created through a preview ticket).
  route("POST", /^\/api\/admin\/participants\/([\w-]+)\/demo$/, async (req, [id]) => {
    const actor = staffGuard(req);
    const participant = service.getParticipant(id);
    if (!participant.isTest) throw new ApiError(403, "not-test-participant", "ควบคุมได้เฉพาะผู้ทดสอบในกรอบจำลอง ไม่ส่งตำแหน่งปลอมแทนอุปกรณ์จริง");
    const body = await req.readJson();
    const action = oneOf(body, "action", ["place", "advance", "uncertain"] as const)!;
    if (action === "uncertain") service.markUncertain(participant, actor.id);
    else {
      let nodeId = str(body, "nodeId", 80, true) ?? null;
      const checkpointId = str(body, "checkpointId", 24, true) ?? null;
      if (action === "advance") {
        const advice = participant.advice;
        const expected = num(body, "expectedRouteRevision", 0, Number.MAX_SAFE_INTEGER, true);
        if (expected !== undefined && expected !== advice?.routeRevision) throw new ApiError(409, "route-changed", "เส้นทางเปลี่ยนแล้ว กรุณาอ่านคำแนะนำใหม่");
        if (!advice || advice.status !== "ok") throw new ApiError(409, "no-route", "ยังไม่มีเส้นทางปัจจุบันให้เดินต่อ");
        const at = participant.location?.nodeId ? advice?.nodeIds.indexOf(participant.location.nodeId) ?? -1 : -1;
        // Next landmark: end of the current instruction step (not a guessed timer).
        const step = advice?.maneuvers.find((maneuver) => maneuver.nodeIds.indexOf(participant.location?.nodeId ?? "") >= 0 && maneuver.nodeIds[maneuver.nodeIds.length - 1] !== participant.location?.nodeId)
          ?? advice?.maneuvers.find((maneuver) => advice.nodeIds.indexOf(maneuver.nodeIds[0]) >= at);
        nodeId = step ? step.nodeIds[step.nodeIds.length - 1] : null;
        if (!nodeId) throw new ApiError(409, "no-route", "ยังไม่มีเส้นทางให้เดินต่อ");
      }
      service.reportLocation(participant, {
        source: "demo-simulated", checkpointId: nodeId ? null : checkpointId, nodeId, observedAt: Date.now(),
        clientSeq: participant.lastClientSeq + 1, mapVersion: service.registry.mapVersion, confirmJump: true,
      }, "staff");
    }
    return json(200, { ok: true, view: service.participantView(participant) });
  });
  route("GET", /^\/api\/admin\/log$/, (req) => {
    staffGuard(req);
    const incidentId = req.url.searchParams.get("incidentId");
    return json(200, { entries: service.recentLog.filter((entry) => !incidentId || entry.incidentId === incidentId) });
  });
  route("GET", /^\/api\/admin\/snapshot$/, (req) => { staffGuard(req); return json(200, service.staffSnapshot()); });
  route("GET", /^\/api\/admin\/participants\/([\w-]+)\/view$/, (req, [id]) => {
    staffGuard(req);
    return json(200, service.participantView(service.getParticipant(id)));
  });

  // --- sensor gateway (HTTP). Real hardware: Bearer EVAC_SENSOR_GATEWAY_KEY. Simulator: staff token, test data only.
  route("POST", /^\/api\/sensors\/events$/, async (req) => {
    const value = bearer(req);
    const gateway = sensorKey && value && safeEqual(value, sensorKey);
    const staff = value && safeEqual(value, staffToken);
    if (!gateway && !staff) throw new ApiError(401, "sensor-auth", "ต้องใช้กุญแจ Sensor Gateway");
    if (!limits.sensor.take(gateway ? "gateway" : "simulator")) throw new ApiError(429, "rate-limited", "ส่งข้อมูลถี่เกินไป");
    const body = await req.readJson(256 * 1024);
    const incident = service.getIncident(str(body, "incidentId", 60)!);
    const raw = Array.isArray(body.readings) ? body.readings : null;
    if (!raw || raw.length === 0 || raw.length > 200) throw new ApiError(400, "bad-readings", "ต้องส่ง readings 1–200 รายการ");
    const readings = raw.map(parseReading);
    if (staff && !gateway) {
      if (incident.mode === "live") throw new ApiError(403, "simulator-in-live", "ตัวจำลองเซนเซอร์ใช้กับเหตุจริงไม่ได้");
      if (readings.some((reading) => reading.mode === "live")) throw new ApiError(403, "simulator-live-data", "ตัวจำลองส่งข้อมูลโหมด live ไม่ได้");
    }
    const results = service.ingestSensorReadings(incident, readings, gateway ? "sensor-gateway" : "sensor-simulator", gateway ? "sensor-gateway" : "staff");
    return json(200, { results });
  });

  /** Route one /api request. Errors become the same JSON error bodies on every transport. */
  async function handle(req: ApiRequest): Promise<ApiOutcome> {
    try {
      if (!limits.general.take(req.clientAddress)) throw new ApiError(429, "rate-limited", "คำขอถี่เกินไป");
      for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        const match = candidate.pattern.exec(req.url.pathname);
        if (match) return await candidate.handler(req, match.slice(1));
      }
      throw new ApiError(404, "not-found", "ไม่พบ API นี้");
    } catch (error) {
      if (error instanceof ApiError) return json(error.status, { error: error.code, message: error.message, detail: error.detail });
      service.log("server", "system", "server.error", error instanceof Error ? error.message : String(error));
      return json(500, { error: "internal", message: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
    }
  }

  /** Keep-alive for idle connections (proxies close silent streams). */
  function pingStreams() {
    const text = `ping ${Date.now()}`;
    participantStreams.forEach((streams) => streams.forEach((stream) => stream.sink.comment(text)));
    staffStreams.forEach((stream) => stream.sink.comment(text));
  }

  return { handle, pingStreams, streamCount: () => [...participantStreams.values()].reduce((sum, set) => sum + set.size, 0) + staffStreams.size };
}

export type ApiCore = ReturnType<typeof createApiCore>;
