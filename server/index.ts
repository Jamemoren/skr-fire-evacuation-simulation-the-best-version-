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
import { ApiError, IncidentService, setRandomSource } from "./incidentService";
import { createApiCore, type StreamSink } from "./apiCore";
import type { EventLogEntry, StreamMessage } from "../src/evac/protocol";

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

setRandomSource((count) => new Uint8Array(randomBytes(count)));
const service = new IncidentService({ liveEnabled: LIVE_ENABLED, liveReadiness, log: writeLog });
service.log("server", "system", "server.started", `mapVersion ${service.registry.mapVersion}; live ${LIVE_ENABLED ? "available" : "disabled"}`);

// ------------------------------------------------------------------ API (shared with the in-browser backend)

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const api = createApiCore({
  service,
  staffToken: STAFF_TOKEN,
  sensorKey: SENSOR_KEY,
  allowLoopbackStaff: ALLOW_LOOPBACK_STAFF,
  liveEnabled: LIVE_ENABLED,
  safeEqual,
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  // EVAC_RATE_LIMIT_SCALE multiplies every limit (load tests from one machine); default 1.
  rateScale: Math.max(1, Number(process.env.EVAC_RATE_LIMIT_SCALE ?? 1) || 1),
  health: () => ({ uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1e6), tls: Boolean(TLS) }),
  schedule: (fn, delay) => { if (delay > 0) setTimeout(fn, delay); else setImmediate(fn); },
});

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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers, "content-length": String(Buffer.byteLength(data)) });
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

/** Server-Sent Events transport for one realtime connection. */
function openStream(req: IncomingMessage, res: ServerResponse, attach: (sink: StreamSink) => () => void) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.flushHeaders?.();
  const sink: StreamSink = {
    send: (id, message: StreamMessage) => { res.write(`id: ${id}\ndata: ${JSON.stringify(message)}\n\n`); },
    comment: (text) => { res.write(`: ${text}\n\n`); },
    end: () => { res.end(); },
  };
  const detach = attach(sink);
  req.on("close", detach);
}

setInterval(() => api.pingStreams(), 15_000).unref();
setInterval(() => service.tick(), 5_000).unref();

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
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      const outcome = await api.handle({
        method: req.method ?? "GET", url, headers, clientAddress: clientAddress(req), loopback: isLoopback(req),
        readJson: (limit) => readJson(req, limit),
      });
      if (outcome.kind === "stream") { openStream(req, res, outcome.attach); return; }
      if (outcome.kind === "not-modified") { res.writeHead(304, outcome.headers); res.end(); return; }
      send(res, outcome.status, outcome.body, outcome.headers);
      return;
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
