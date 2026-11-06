/**
 * Evacuation guidance backend: one small Node.js process (no framework, no extra dependencies).
 *   - REST API for the dashboard, phones, teachers and the sensor gateway
 *   - Server-Sent Events (/api/stream) for realtime delivery, full snapshot on every (re)connect
 *   - append-only JSONL event log with a retention period
 *   - optional static hosting of the built web app (dist/) incl. /mobile
 * It keeps running when the dashboard tab closes. Run: npm run server  (see MOBILE_GUIDANCE_TH.md)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, extname, normalize, sep } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { ApiError, IncidentService, ANNOUNCEMENT_TEMPLATES, type Participant } from "./incidentService";
import { buildMapPackage, passageGroups } from "../src/evac/mapRegistry";
import type { DataMode, EventLogEntry, IncidentMode, LocationSource, Role, SensorReading, SensorStatus, SensorType, StreamMessage } from "../src/evac/protocol";

// ------------------------------------------------------------------ configuration

const env = process.env;
const PORT = Number(env.EVAC_PORT ?? env.PORT ?? 8787);
const HOST = env.EVAC_HOST ?? "127.0.0.1";
const DATA_DIR = resolve(env.EVAC_DATA_DIR ?? ".evac-data");
const RETENTION_DAYS = Math.max(1, Number(env.EVAC_RETENTION_DAYS ?? 30));
const STATIC_DIR = env.EVAC_STATIC_DIR ? resolve(env.EVAC_STATIC_DIR) : null;
const STAFF_TOKEN = env.EVAC_STAFF_TOKEN ?? randomBytes(18).toString("hex");
const STAFF_TOKEN_GENERATED = !env.EVAC_STAFF_TOKEN;
const SENSOR_KEY = env.EVAC_SENSOR_GATEWAY_KEY ?? null;
const ALLOW_LOOPBACK_STAFF = env.EVAC_ALLOW_LOOPBACK_STAFF !== "0";
const TLS = env.EVAC_TLS_KEY_FILE && env.EVAC_TLS_CERT_FILE ? { key: readFileSync(env.EVAC_TLS_KEY_FILE), cert: readFileSync(env.EVAC_TLS_CERT_FILE) } : null;

/** Live mode is a deliberate, checkable decision — never the default. */
const liveReadiness = [
  { id: "flag", label: "ผู้ดูแลระบบเปิดโหมดเหตุจริง (EVAC_LIVE_ENABLED=1)", ok: env.EVAC_LIVE_ENABLED === "1" },
  { id: "map", label: "แผนที่และ QR ผ่านการสำรวจหน้างาน (EVAC_MAP_SURVEYED=1)", ok: env.EVAC_MAP_SURVEYED === "1" },
  { id: "sensors", label: "ตั้งค่ากุญแจ Sensor Gateway ของอุปกรณ์จริง", ok: Boolean(SENSOR_KEY) },
  { id: "tls", label: "เปิดใช้ HTTPS", ok: Boolean(TLS) },
  { id: "staff", label: "กำหนดรหัสเจ้าหน้าที่เอง (ไม่ใช่รหัสสุ่มชั่วคราว)", ok: !STAFF_TOKEN_GENERATED },
];
const LIVE_ENABLED = liveReadiness.every((item) => item.ok);

// ------------------------------------------------------------------ event log (JSONL, retention)

mkdirSync(DATA_DIR, { recursive: true });
for (const name of readdirSync(DATA_DIR)) {
  const path = join(DATA_DIR, name);
  if (name.startsWith("events-") && Date.now() - statSync(path).mtimeMs > RETENTION_DAYS * 86_400_000) unlinkSync(path);
}
function writeLog(entry: EventLogEntry) {
  const day = new Date(entry.at).toISOString().slice(0, 10);
  try { appendFileSync(join(DATA_DIR, `events-${day}.jsonl`), `${JSON.stringify(entry)}\n`); } catch { /* logging must never stop guidance */ }
}

const service = new IncidentService({ liveEnabled: LIVE_ENABLED, liveReadiness, log: writeLog });
service.log("server", "system", "server.started", `mapVersion ${service.registry.mapVersion}; live ${LIVE_ENABLED ? "available" : "disabled"}`);

// ------------------------------------------------------------------ helpers

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
// EVAC_RATE_LIMIT_SCALE multiplies every limit (load tests from one machine); default 1.
const RATE_SCALE = Math.max(1, Number(process.env.EVAC_RATE_LIMIT_SCALE ?? 1) || 1);
const limits = {
  join: new RateLimiter(0.5 * RATE_SCALE, 20 * RATE_SCALE),
  participant: new RateLimiter(4, 12),
  staff: new RateLimiter(30 * RATE_SCALE, 60 * RATE_SCALE),
  sensor: new RateLimiter(50 * RATE_SCALE, 200 * RATE_SCALE),
  general: new RateLimiter(40 * RATE_SCALE, 80 * RATE_SCALE),
};

/**
 * Address used for rate limiting. Behind the local Vite proxy every phone arrives from 127.0.0.1,
 * so the proxy's X-Forwarded-For hop (the last one, appended by the proxy) is used instead.
 * X-Forwarded-For is only trusted when the socket itself is loopback.
 */
function clientAddress(req: IncomingMessage) {
  const socket = req.socket.remoteAddress ?? "unknown";
  if (socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1") {
    const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return socket;
}
function isLoopback(req: IncomingMessage) {
  const address = req.socket.remoteAddress ?? "unknown";
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const loop = (value: string) => value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
  return loop(address) && forwarded.every(loop);
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface Actor { role: Role; id: string; incidentId?: string }
const teacherTokens = new Map<string, { incidentId: string; createdAt: number }>();

function bearer(req: IncomingMessage) {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
function staffActor(req: IncomingMessage, allowTeacher = false): Actor {
  const value = bearer(req);
  if (value && safeEqual(value, STAFF_TOKEN)) return { role: "staff", id: "staff" };
  const teacher = value ? teacherTokens.get(value) : undefined;
  if (allowTeacher && teacher) return { role: "teacher", id: `teacher-${value.slice(0, 6)}`, incidentId: teacher.incidentId };
  throw new ApiError(401, "staff-only", "ต้องใช้สิทธิ์เจ้าหน้าที่");
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return await new Promise((resolveBody, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new ApiError(413, "too-large", "ข้อมูลใหญ่เกินกำหนด")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!size) return resolveBody({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        resolveBody(parsed as Record<string, unknown>);
      } catch { reject(new ApiError(400, "bad-json", "รูปแบบข้อมูลไม่ถูกต้อง")); }
    });
    req.on("error", reject);
  });
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

// ------------------------------------------------------------------ realtime (SSE)

interface Stream { res: ServerResponse; seq: number; participant?: Participant; staff?: boolean }
const participantStreams = new Map<string, Set<Stream>>();
const staffStreams = new Set<Stream>();
const pendingParticipants = new Set<string>();
let staffDirty = false;
let flushScheduled = false;

function writeEvent(stream: Stream, message: StreamMessage) {
  stream.seq += 1;
  stream.res.write(`id: ${stream.seq}\ndata: ${JSON.stringify(message)}\n\n`);
}

function pushParticipant(participantId: string) {
  const streams = participantStreams.get(participantId);
  if (!streams?.size) return;
  let participant: Participant;
  try { participant = service.getParticipant(participantId); } catch {
    streams.forEach((stream) => { writeEvent(stream, { type: "error", code: "bad-session", message: "เซสชันนี้ถูกล้างแล้ว กรุณาเข้าร่วมใหม่" }); stream.res.end(); });
    participantStreams.delete(participantId);
    return;
  }
  const view = service.participantView(participant);
  streams.forEach((stream) => writeEvent(stream, { type: "participant", view }));
  service.markSent(participant);
}

let lastStaffPush = 0;
function flush() {
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
}
function scheduleFlush(delay = 0) {
  if (flushScheduled) return;
  flushScheduled = true;
  if (delay > 0) setTimeout(flush, delay); else setImmediate(flush);
}
service.onChange((kind, participantId) => {
  if (kind === "participant" && participantId) pendingParticipants.add(participantId);
  staffDirty = true;
  scheduleFlush();
});

function openStream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.flushHeaders?.();
  void req;
}

setInterval(() => {
  const ping = `: ping ${Date.now()}\n\n`;
  participantStreams.forEach((streams) => streams.forEach((stream) => stream.res.write(ping)));
  staffStreams.forEach((stream) => stream.res.write(ping));
}, 15_000).unref();
setInterval(() => service.tick(), 5_000).unref();

// ------------------------------------------------------------------ routes

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void> | void;
const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

route("GET", /^\/api\/health$/, (_req, res) => send(res, 200, {
  ok: true, mapVersion: service.registry.mapVersion, uptimeSeconds: Math.round(process.uptime()),
  incidents: service.incidents.size, participants: service.participants.size,
  streams: [...participantStreams.values()].reduce((sum, set) => sum + set.size, 0) + staffStreams.size,
  memoryMb: Math.round(process.memoryUsage().rss / 1e6), liveModeAvailable: LIVE_ENABLED, tls: Boolean(TLS),
}));

route("GET", /^\/api\/map$/, (req, res) => {
  const etag = `"${service.registry.mapVersion}"`;
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); res.end(); return; }
  const body = JSON.stringify(buildMapPackage(service.registry));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": "no-cache" });
  res.end(body);
});

route("GET", /^\/api\/passages$/, (_req, res) => send(res, 200, { groups: passageGroups(service.registry), templates: Object.keys(ANNOUNCEMENT_TEMPLATES) }));
route("GET", /^\/api\/sensors\/registry$/, (_req, res) => send(res, 200, { sensors: service.registry.sensors }));

// Staff token for a dashboard running on the same machine as the server (prototype convenience).
route("GET", /^\/api\/auth\/local-staff$/, (req, res) => {
  if (!ALLOW_LOOPBACK_STAFF || !isLoopback(req)) throw new ApiError(403, "not-local", "รับสิทธิ์อัตโนมัติได้เฉพาะเครื่องที่รันเซิร์ฟเวอร์ — ใส่รหัสเจ้าหน้าที่แทน");
  send(res, 200, { token: STAFF_TOKEN, role: "staff" });
});
route("POST", /^\/api\/auth\/check$/, (req, res) => { const actor = staffActor(req, true); send(res, 200, { role: actor.role }); });

// --- participant
route("POST", /^\/api\/participant\/join$/, async (req, res) => {
  if (!limits.join.take(clientAddress(req))) throw new ApiError(429, "rate-limited", "ลองใหม่อีกครั้งในอีกสักครู่");
  const body = await readJson(req);
  const participant = service.join({
    joinCode: str(body, "joinCode", 12, true),
    previewTicket: str(body, "previewTicket", 64, true),
    deviceKey: str(body, "deviceKey", 64)!,
    displayName: str(body, "displayName", 40, true),
    mobility: oneOf(body, "mobility", ["standard", "no-stairs"] as const, true),
  });
  send(res, 200, { token: participant.token, participantId: participant.id, incidentId: participant.incidentId, mapVersion: service.registry.mapVersion });
});

function participantFromRequest(req: IncomingMessage) {
  const participant = service.participantByToken(bearer(req));
  if (!limits.participant.take(participant.id)) throw new ApiError(429, "rate-limited", "ส่งข้อมูลถี่เกินไป");
  return participant;
}

route("GET", /^\/api\/participant\/me$/, (req, res) => {
  const participant = service.participantByToken(bearer(req));
  participant.lastSeenAt = Date.now();
  send(res, 200, service.participantView(participant));
});

route("POST", /^\/api\/participant\/location$/, async (req, res) => {
  const participant = participantFromRequest(req);
  const body = await readJson(req);
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
  send(res, 200, { ok: true, view: service.participantView(participant) });
});

route("POST", /^\/api\/participant\/ack$/, async (req, res) => {
  const participant = participantFromRequest(req);
  const body = await readJson(req);
  const current = service.acknowledge(participant, str(body, "routeId", 64)!, oneOf(body, "stage", ["received", "viewed", "confirmed"] as const)!);
  send(res, 200, { ok: true, current });
});

route("POST", /^\/api\/participant\/help$/, (req, res) => { const p = participantFromRequest(req); service.requestHelp(p); send(res, 200, { ok: true }); });
route("POST", /^\/api\/participant\/blocked$/, async (req, res) => {
  const participant = participantFromRequest(req);
  const body = await readJson(req);
  service.reportBlocked(participant, str(body, "edgeId", 80, true) ?? null);
  send(res, 200, { ok: true });
});
route("POST", /^\/api\/participant\/arrived$/, async (req, res) => {
  const participant = participantFromRequest(req);
  const body = await readJson(req);
  service.reportArrived(participant, str(body, "assemblyId", 80, true) ?? null);
  send(res, 200, { ok: true });
});
route("POST", /^\/api\/participant\/profile$/, async (req, res) => {
  const participant = participantFromRequest(req);
  const body = await readJson(req);
  service.setMobility(participant, oneOf(body, "mobility", ["standard", "no-stairs"] as const)!);
  send(res, 200, { ok: true });
});
route("POST", /^\/api\/participant\/leave$/, (req, res) => {
  const participant = service.participantByToken(bearer(req));
  service.log(participant.id, participant.isTest ? "preview" : "participant", "participant.left", "ออกจากรอบ", participant.incidentId);
  service.removeParticipant(participant);
  send(res, 200, { ok: true });
});

// --- realtime stream (EventSource cannot send headers: the session token comes in the query and is never logged)
route("GET", /^\/api\/stream$/, (req, res, _params, url) => {
  const participantToken = url.searchParams.get("participant");
  const staffToken = url.searchParams.get("staff");
  if (participantToken) {
    const participant = service.participantByToken(participantToken);
    openStream(req, res);
    const stream: Stream = { res, seq: 0, participant };
    const set = participantStreams.get(participant.id) ?? new Set<Stream>();
    set.add(stream);
    participantStreams.set(participant.id, set);
    service.connectionOpened(participant);
    writeEvent(stream, { type: "participant", view: service.participantView(participant) });
    service.markSent(participant);
    req.on("close", () => {
      set.delete(stream);
      if (!set.size) participantStreams.delete(participant.id);
      service.connectionClosed(participant);
    });
    return;
  }
  if (staffToken && safeEqual(staffToken, STAFF_TOKEN)) {
    openStream(req, res);
    const stream: Stream = { res, seq: 0, staff: true };
    staffStreams.add(stream);
    writeEvent(stream, { type: "staff", snapshot: service.staffSnapshot() });
    req.on("close", () => staffStreams.delete(stream));
    return;
  }
  throw new ApiError(401, "bad-session", "ต้องเข้าร่วมก่อนจึงรับข้อมูลสดได้");
});

// --- staff / incident control
function staffGuard(req: IncomingMessage, allowTeacher = false) {
  const actor = staffActor(req, allowTeacher);
  if (!limits.staff.take(actor.id)) throw new ApiError(429, "rate-limited", "สั่งงานถี่เกินไป");
  return actor;
}

route("POST", /^\/api\/admin\/incidents$/, async (req, res) => {
  const actor = staffGuard(req);
  const body = await readJson(req);
  const incident = service.createIncident(oneOf(body, "mode", ["simulation", "drill", "live"] as const satisfies readonly IncidentMode[])!, str(body, "title", 80, true) ?? "", actor.id, body.activate !== false);
  send(res, 200, { incident: service.incidentSummary(incident) });
});
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/active$/, (req, res, [id]) => { staffGuard(req); service.setActive(id); send(res, 200, { ok: true }); });
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/evacuate$/, (req, res, [id]) => { const a = staffGuard(req); service.startEvacuation(id, a.id); send(res, 200, { ok: true }); });
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/end$/, (req, res, [id]) => { const a = staffGuard(req); service.endIncident(id, a.id); send(res, 200, { ok: true }); });
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/reset-test$/, async (req, res, [id]) => { const a = staffGuard(req); const body = await readJson(req); service.resetTestScenario(id, a.id, oneOf(body, "scope", ["all", "bots"] as const, true) ?? "all"); send(res, 200, { ok: true }); });
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/closures$/, async (req, res, [id]) => {
  const actor = staffGuard(req);
  const body = await readJson(req);
  const edgeIds = Array.isArray(body.edgeIds) ? body.edgeIds.filter((value): value is string => typeof value === "string").slice(0, 50) : undefined;
  service.setClosure(id, { groupId: str(body, "groupId", 40, true), edgeIds }, body.closed !== false, str(body, "reason", 80, true) ?? "", actor.id, actor.role);
  send(res, 200, { ok: true });
});
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/announce$/, async (req, res, [id]) => {
  const actor = staffGuard(req);
  const body = await readJson(req);
  const params: Record<string, string> = {};
  if (body.params && typeof body.params === "object") for (const [key, value] of Object.entries(body.params as Record<string, unknown>)) if (typeof value === "string" && value.length < 60) params[key] = value;
  send(res, 200, { announcement: service.announce(id, str(body, "templateId", 40)!, params, actor.id) });
});
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/preview-ticket$/, (req, res, [id]) => {
  const actor = staffGuard(req);
  send(res, 200, { ticket: service.createPreviewTicket(id, actor.id), incidentId: id });
});
// Roleplay simulator: a ticket for the person the user controls (simulation incidents only).
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/player-ticket$/, (req, res, [id]) => {
  const actor = staffGuard(req);
  send(res, 200, { ticket: service.createPreviewTicket(id, actor.id, "player"), incidentId: id });
});
// Simulator adapter: ground truth of the 3D simulation (fire/smoke-blocked passages, margins, crowd).
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/sim-world$/, async (req, res, [id]) => {
  const actor = staffActor(req);
  const body = await readJson(req, 256 * 1024);
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.length < 100).slice(0, max);
  const record = (value: unknown) => {
    const out: Record<string, number> = {};
    if (value && typeof value === "object") for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 2000)) if (key.length < 100 && typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    return out;
  };
  send(res, 200, service.applySimWorld(id, { blocked: list(body.blocked, 2000), margins: record(body.margins), crowd: record(body.crowd), simTime: num(body, "simTime", 0, 1e7) ?? 0 }, actor.id));
});
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/teacher-token$/, (req, res, [id]) => {
  const actor = staffGuard(req);
  service.getIncident(id);
  const value = randomBytes(18).toString("hex");
  teacherTokens.set(value, { incidentId: id, createdAt: Date.now() });
  service.log(actor.id, "staff", "teacher.token", "ออกสิทธิ์ครูสำหรับยืนยันตัวและนับคน", id);
  send(res, 200, { token: value });
});
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/zone-count$/, async (req, res, [id]) => {
  const actor = staffGuard(req, true);
  if (actor.incidentId && actor.incidentId !== id) throw new ApiError(403, "wrong-incident", "สิทธิ์ครูใช้ได้เฉพาะรอบที่ออกให้");
  const body = await readJson(req);
  service.recordTeacherCount(id, str(body, "zoneId", 60)!, num(body, "count", 0, 2000)!, actor.id, actor.role);
  send(res, 200, { ok: true });
});
// Simulator A: bots of the 3D crowd simulation carrying a simulated phone (simulation incidents only).
route("POST", /^\/api\/admin\/incidents\/([\w-]+)\/sim-bots$/, async (req, res, [id]) => {
  const actor = staffActor(req);
  const body = await readJson(req, 512 * 1024);
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
  send(res, 200, service.syncSimBots(id, bots, bool(body, "full"), actor.id, bool(body, "replace")));
});
route("GET", /^\/api\/admin\/incidents\/([\w-]+)\/sim-bots\/(\d+)$/, (req, res, [id, botId]) => {
  staffGuard(req);
  send(res, 200, { participantId: service.simBotParticipant(id, Number(botId)) });
});
route("POST", /^\/api\/admin\/participants\/([\w-]+)\/confirm-arrival$/, (req, res, [id]) => {
  const actor = staffGuard(req, true);
  const participant = service.getParticipant(id);
  if (actor.incidentId && actor.incidentId !== participant.incidentId) throw new ApiError(403, "wrong-incident", "สิทธิ์ครูใช้ได้เฉพาะรอบที่ออกให้");
  service.confirmArrival(participant, actor.id, actor.role);
  send(res, 200, { ok: true });
});
// Demo controls act only on test participants (created through a preview ticket).
route("POST", /^\/api\/admin\/participants\/([\w-]+)\/demo$/, async (req, res, [id]) => {
  const actor = staffGuard(req);
  const participant = service.getParticipant(id);
  if (!participant.isTest) throw new ApiError(403, "not-test-participant", "ควบคุมได้เฉพาะผู้ทดสอบในกรอบจำลอง ไม่ส่งตำแหน่งปลอมแทนอุปกรณ์จริง");
  const body = await readJson(req);
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
  send(res, 200, { ok: true, view: service.participantView(participant) });
});
route("GET", /^\/api\/admin\/log$/, (req, res, _params, url) => {
  staffGuard(req);
  const incidentId = url.searchParams.get("incidentId");
  send(res, 200, { entries: service.recentLog.filter((entry) => !incidentId || entry.incidentId === incidentId) });
});
route("GET", /^\/api\/admin\/snapshot$/, (req, res) => { staffGuard(req); send(res, 200, service.staffSnapshot()); });
route("GET", /^\/api\/admin\/participants\/([\w-]+)\/view$/, (req, res, [id]) => {
  staffGuard(req);
  send(res, 200, service.participantView(service.getParticipant(id)));
});

// --- sensor gateway (HTTP). Real hardware: Bearer EVAC_SENSOR_GATEWAY_KEY. Simulator: staff token, test data only.
route("POST", /^\/api\/sensors\/events$/, async (req, res) => {
  const value = bearer(req);
  const gateway = SENSOR_KEY && value && safeEqual(value, SENSOR_KEY);
  const staff = value && safeEqual(value, STAFF_TOKEN);
  if (!gateway && !staff) throw new ApiError(401, "sensor-auth", "ต้องใช้กุญแจ Sensor Gateway");
  if (!limits.sensor.take(gateway ? "gateway" : "simulator")) throw new ApiError(429, "rate-limited", "ส่งข้อมูลถี่เกินไป");
  const body = await readJson(req, 256 * 1024);
  const incident = service.getIncident(str(body, "incidentId", 60)!);
  const raw = Array.isArray(body.readings) ? body.readings : null;
  if (!raw || raw.length === 0 || raw.length > 200) throw new ApiError(400, "bad-readings", "ต้องส่ง readings 1–200 รายการ");
  const readings = raw.map(parseReading);
  if (staff && !gateway) {
    if (incident.mode === "live") throw new ApiError(403, "simulator-in-live", "ตัวจำลองเซนเซอร์ใช้กับเหตุจริงไม่ได้");
    if (readings.some((reading) => reading.mode === "live")) throw new ApiError(403, "simulator-live-data", "ตัวจำลองส่งข้อมูลโหมด live ไม่ได้");
  }
  const results = service.ingestSensorReadings(incident, readings, gateway ? "sensor-gateway" : "sensor-simulator", gateway ? "sensor-gateway" : "staff");
  send(res, 200, { results });
});

// ------------------------------------------------------------------ static hosting (production)

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!STATIC_DIR) return false;
  let path = decodeURIComponent(url.pathname);
  if (path === "/mobile" || path.startsWith("/mobile/")) path = "/mobile.html";
  if (path === "/") path = "/index.html";
  const file = normalize(join(STATIC_DIR, path));
  if (!file.startsWith(STATIC_DIR + sep) && file !== STATIC_DIR) return false;
  const target = existsSync(file) && statSync(file).isFile() ? file : join(STATIC_DIR, "index.html");
  const type = MIME[extname(target)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "content-type": type, "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };
  headers["cache-control"] = target.includes(`${sep}assets${sep}`) && /-[\w-]{8}\.\w+$/.test(target) ? "public, max-age=31536000, immutable" : "no-cache";
  if (target.endsWith("mobile-sw.js")) headers["service-worker-allowed"] = "/";
  res.writeHead(200, headers);
  res.end(readFileSync(target));
  void req;
  return true;
}

// ------------------------------------------------------------------ server

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (!limits.general.take(clientAddress(req))) throw new ApiError(429, "rate-limited", "คำขอถี่เกินไป");
      for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        const match = candidate.pattern.exec(url.pathname);
        if (match) { await candidate.handler(req, res, match.slice(1), url); return; }
      }
      throw new ApiError(404, "not-found", "ไม่พบ API นี้");
    }
    if (req.method === "GET" && serveStatic(req, res, url)) return;
    send(res, 404, { error: "not-found" });
  } catch (error) {
    if (error instanceof ApiError) send(res, error.status, { error: error.code, message: error.message, detail: error.detail });
    else {
      service.log("server", "system", "server.error", error instanceof Error ? error.message : String(error));
      send(res, 500, { error: "internal", message: "เกิดข้อผิดพลาดในเซิร์ฟเวอร์" });
    }
  }
}

const server = TLS ? createHttpsServer(TLS, (req, res) => void handle(req, res)) : createHttpServer((req, res) => void handle(req, res));
server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE" ? `พอร์ต ${PORT} ถูกใช้อยู่แล้ว — ตั้ง EVAC_PORT เป็นพอร์ตอื่น` : error.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const scheme = TLS ? "https" : "http";
  const lan = Object.values(networkInterfaces()).flat().filter((entry): entry is { address: string; family: string | number; internal: boolean } => Boolean(entry && !entry.internal && (entry.family === "IPv4" || entry.family === 4)));
  console.log(`[evac] backend ${scheme}://${HOST}:${PORT}  mapVersion ${service.registry.mapVersion}`);
  if (HOST === "0.0.0.0") lan.forEach((entry) => console.log(`[evac]   LAN: ${scheme}://${entry.address}:${PORT}`));
  console.log(`[evac] staff token: ${STAFF_TOKEN_GENERATED ? `${STAFF_TOKEN} (สุ่มชั่วคราว — ตั้ง EVAC_STAFF_TOKEN เพื่อใช้จริง)` : "(จาก EVAC_STAFF_TOKEN)"}`);
  console.log(`[evac] live mode: ${LIVE_ENABLED ? "เปิดได้ตามการตั้งค่า (ไม่ใช่การรับรองว่าใช้จริงได้ — ต้องทดสอบหน้างาน)" : "ปิด (ค่าเริ่มต้น)"} · data: ${DATA_DIR}`);
});

const shutdown = () => { service.log("server", "system", "server.stopped", "ปิดเซิร์ฟเวอร์"); server.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
