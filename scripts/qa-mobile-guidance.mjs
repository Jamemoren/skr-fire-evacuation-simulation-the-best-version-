// QA for the mobile guidance backend: API end-to-end, data quality, routing and a load test.
// It starts its OWN server on a spare port with a temporary data folder, so it never touches a
// running drill. Usage:  npm run qa:mobile            (or)  node scripts/qa-mobile-guidance.mjs --sessions=3000
// Every check prints PASS/FAIL with the measured value. Nothing here talks to real alarm equipment.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "1"]));
const SESSIONS = Number(args.sessions ?? 3000);
const PORT = Number(args.port ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const STAFF = "qa-staff-token-not-secret";
const SENSOR_KEY = "qa-sensor-key-not-secret";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? ` — ${detail}` : ""}`);
};

// ------------------------------------------------------------------ server lifecycle
const dataDir = mkdtempSync(join(tmpdir(), "evac-qa-"));
const server = spawn(process.execPath, [join(root, "scripts/evac-server.mjs"), `--port=${PORT}`, `--data=${dataDir}`], {
  cwd: root,
  env: { ...process.env, EVAC_STAFF_TOKEN: STAFF, EVAC_SENSOR_GATEWAY_KEY: SENSOR_KEY, EVAC_RATE_LIMIT_SCALE: "1000", EVAC_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on("exit", stop);

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
function request(method, path, { token, body } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(BASE + path, { method, agent, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, json, ms: performance.now() - started });
      });
    });
    req.on("error", (error) => resolve({ status: 0, json: { error: String(error) }, ms: performance.now() - started }));
    if (data) req.write(data);
    req.end();
  });
}
const get = (path, token) => request("GET", path, { token });
const post = (path, body, token) => request("POST", path, { body: body ?? {}, token });

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    const health = await get("/api/health");
    if (health.status === 200) return health.json;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("server did not start:\n" + serverLog);
}

/** SSE client: resolves `first` on the first event, keeps the latest participant view. */
function openStream(query) {
  const stream = { views: [], latest: null, closed: false, req: null };
  stream.first = new Promise((resolve) => {
    const req = http.get(`${BASE}/api/stream?${query}`, { agent: false }, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = block.split("\n").find((part) => part.startsWith("data: "));
          if (!line) continue;
          try {
            const message = JSON.parse(line.slice(6));
            if (message.type === "participant") { stream.latest = message.view; stream.views.push(message.view.revision); }
            if (message.type === "staff") stream.latest = message.snapshot;
            resolve(stream);
          } catch { /* ignore */ }
        }
      });
      res.on("end", () => { stream.closed = true; });
    });
    req.on("error", () => { stream.closed = true; resolve(stream); });
    stream.req = req;
  });
  stream.close = () => stream.req?.destroy();
  return stream;
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poolMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) { const index = next++; out[index] = await fn(items[index], index); }
  }));
  return out;
}

// ------------------------------------------------------------------ main
async function main() {
  const health = await waitForServer();
  const map = (await get("/api/map")).json;
  const groups = (await get("/api/passages")).json.groups;
  const nodeById = new Map(map.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(map.edges.map((edge) => [edge.id, edge]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const cp = (prefix) => map.checkpoints.find((checkpoint) => checkpoint.id.startsWith(prefix) && checkpoint.kind === "room") ?? map.checkpoints.find((checkpoint) => checkpoint.id.startsWith(prefix));
  let seq = 1;
  const report = (token, body) => post("/api/participant/location", { observedAt: Date.now(), clientSeq: seq++, mapVersion: map.mapVersion, ...body }, token);
  const join = (joinCode, deviceKey, extra = {}) => post("/api/participant/join", { joinCode, deviceKey, ...extra });
  const view = async (token) => (await get("/api/participant/me", token)).json;

  // ---- map / graph integrity (forbidden-edge checks) --------------------------------------
  const crossBuilding = map.edges.filter((edge) => nodeById.get(edge.from).buildingId !== nodeById.get(edge.to).buildingId);
  const bridgeEdges = new Set(groupById.get("b34-bridge")?.edgeIds ?? []);
  const badCross = crossBuilding.filter((edge) => !["exit", "outdoor", "assembly"].includes(edge.kind) && !bridgeEdges.has(edge.id));
  check("D0a edges between buildings exist only at exits/outdoors or the B3–B4 bridge", badCross.length === 0, `${crossBuilding.length} cross edges, ${badCross.length} not allowed ${badCross.slice(0, 3).map((e) => e.id).join(",")}`);
  const floorJumps = map.edges.filter((edge) => edge.floorFrom !== edge.floorTo && edge.kind !== "stair" && !(edge.kind === "exit" || edge.kind === "outdoor" || edge.kind === "assembly"));
  check("D0b floor changes only on stair edges", floorJumps.length === 0, `${floorJumps.length} edges`);
  const stairSkips = map.edges.filter((edge) => edge.kind === "stair" && Math.abs(edge.floorFrom - edge.floorTo) > 1);
  check("D0c stair edges never skip a floor", stairSkips.length === 0, `${stairSkips.length}`);
  check("D0d no node belongs to the shrine or other unsurveyed interiors", !map.nodes.some((node) => /ศาล|shrine/i.test(node.name + node.id)), "graph contains only the modelled buildings, corridors and site paths");

  // ---- auth / roles --------------------------------------------------------------------------
  const noAuth = await post("/api/admin/incidents", { mode: "drill" });
  check("S1 creating an incident needs staff rights", noAuth.status === 401, noAuth.status);
  const liveTry = await post("/api/admin/incidents", { mode: "live", title: "x" }, STAFF);
  check("S2 live mode refused while readiness checks fail", liveTry.status >= 400, `${liveTry.status} ${liveTry.json?.error ?? ""}`);
  const sim = (await post("/api/admin/incidents", { mode: "simulation", title: "QA sim" }, STAFF)).json;
  const simJoin = await join(sim.incident?.joinCode ?? sim.joinCode, "qa-device-sim");
  check("S3 a simulation incident refuses real devices", simJoin.status === 403, simJoin.status);
  const drillRes = await post("/api/admin/incidents", { mode: "drill", title: "QA drill" }, STAFF);
  const drill = drillRes.json.incident ?? drillRes.json;
  check("B0 drill created with a join code", drillRes.status === 200 && /^[A-Z0-9]{4,}$/.test(drill.joinCode), drill.joinCode);

  // ---- two sessions at different points ------------------------------------------------------
  const a = (await join(drill.joinCode, "qa-device-a", { displayName: "QA A" })).json;
  const b = (await join(drill.joinCode, "qa-device-b", { displayName: "QA B" })).json;
  const a2 = (await join(drill.joinCode, "qa-device-a")).json;
  check("B1 same device joining twice (second tab) reuses the participant", a2.participantId === a.participantId);
  const participantAdmin = await post(`/api/admin/incidents/${drill.id}/evacuate`, {}, a.token);
  check("S4 a participant token cannot start an evacuation", participantAdmin.status === 401, participantAdmin.status);
  const participantSensor = await post("/api/sensors/events", { incidentId: drill.id, readings: [] }, a.token);
  check("S5 a participant token cannot send sensor data", participantSensor.status === 401, participantSensor.status);
  const demoReal = await post(`/api/admin/participants/${a.participantId}/demo`, { action: "place", checkpointId: "B1F9-001" }, STAFF);
  check("S6 staff cannot inject a simulated position into a real participant", demoReal.status === 403, demoReal.status);

  const cpA = cp("B1F9-"), cpB = cp("B3F4-");
  const repA = await report(a.token, { source: "qr", checkpointId: cpA.id });
  const repB = await report(b.token, { source: "manual", checkpointId: cpB.id });
  check("B2 positions accepted (QR and manual pick)", repA.status === 200 && repB.status === 200, `${repA.status}/${repB.status}`);
  const streamA = await openStream(`participant=${a.token}`).first;
  const streamA2 = await openStream(`participant=${a.token}`).first;
  const streamB = await openStream(`participant=${b.token}`).first;
  check("B3 SSE stream sends a full snapshot on connect", streamA.latest?.me?.participantId === a.participantId && streamB.latest?.me?.participantId === b.participantId);
  const ev = await post(`/api/admin/incidents/${drill.id}/evacuate`, {}, STAFF);
  await sleep(300);
  const va = await view(a.token), vb = await view(b.token);
  check("B4 both phones receive a route after evacuate", ev.status === 200 && va.advice?.status === "ok" && vb.advice?.status === "ok", `${va.advice?.status}/${vb.advice?.status}`);
  check("B5 different start points give different routes", va.advice?.routeId !== vb.advice?.routeId && va.advice?.destination?.name, `${va.advice?.destination?.name} | ${vb.advice?.destination?.name}`);
  const fields = ["incidentId", "routeId", "mapVersion", "hazardRevision", "routeRevision", "issuedAt", "expiresAt", "start", "nodeIds", "edgeIds", "maneuvers", "reason"];
  check("B6 advice carries the required fields", fields.every((field) => field in va.advice), fields.filter((field) => !(field in va.advice)).join(","));
  check("B7 SSE delivered the new revision to both tabs of phone A", streamA.latest?.advice?.routeId === va.advice.routeId && streamA2.latest?.advice?.routeId === va.advice.routeId);
  const monotonic = streamA.views.every((value, index, list) => index === 0 || value > list[index - 1]);
  check("B8 view revisions on a stream only increase", monotonic, streamA.views.join(","));
  const onGraph = (advice) => advice.edgeIds.every((edgeId, index) => {
    const edge = edgeById.get(edgeId);
    if (!edge) return false;
    const from = advice.nodeIds[index], to = advice.nodeIds[index + 1];
    return (edge.from === from && edge.to === to) || (edge.twoWay && edge.from === to && edge.to === from);
  });
  check("D1 routes follow existing edges only, node to node", onGraph(va.advice) && onGraph(vb.advice));
  const noLR = (advice) => !advice.maneuvers.some((maneuver) => /ซ้าย|ขวา/.test(maneuver.text) && !/บันไดซ้าย|บันไดขวา|บันได(ซ้าย|ขวา)/.test(maneuver.text));
  check("D2 instructions contain no left/right turns (no trusted heading)", noLR(va.advice) && noLR(vb.advice), va.advice.maneuvers.map((m) => m.text).join(" / "));

  // ---- delivery stages -----------------------------------------------------------------------
  await post("/api/participant/ack", { routeId: va.advice.routeId, stage: "received" }, a.token);
  await post("/api/participant/ack", { routeId: va.advice.routeId, stage: "viewed" }, a.token);
  await post("/api/participant/ack", { routeId: va.advice.routeId, stage: "confirmed" }, a.token);
  let snap = (await get("/api/admin/snapshot", STAFF)).json;
  const rowA = snap.participants.find((row) => row.participantId === a.participantId);
  check("B9 staff sees accepted/sent/received/viewed/confirmed for phone A", ["accepted", "sent", "received", "viewed", "confirmed"].every((stage) => rowA.delivery[stage]), JSON.stringify(rowA.delivery));

  // ---- closure -> revision with reason, old ack ignored ---------------------------------------
  const usedGroup = groups.find((group) => group.id.includes("stair") && group.edgeIds.some((edgeId) => va.advice.edgeIds.includes(edgeId)));
  const before = va.advice;
  await post(`/api/admin/incidents/${drill.id}/closures`, { groupId: usedGroup.id, closed: true, reason: "QA" }, STAFF);
  await sleep(300);
  const va2 = await view(a.token);
  check("D3 closing the stair in use changes the route immediately", va2.advice.routeRevision > before.routeRevision && !usedGroup.edgeIds.some((edgeId) => va2.advice.edgeIds.includes(edgeId)), `${usedGroup.label}: rev ${before.routeRevision}->${va2.advice.routeRevision}`);
  check("D4 the change carries a reason from the system", va2.advice.reason?.code === "closure" && va2.advice.reason.text.includes(usedGroup.label), va2.advice.reason?.text);
  check("B10 SSE pushed the revised route", streamA.latest?.advice?.routeRevision === va2.advice.routeRevision);
  const oldAck = await post("/api/participant/ack", { routeId: before.routeId, stage: "confirmed" }, a.token);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  check("B11 a confirmation of the OLD route does not count for the new one", oldAck.json?.current === false && !snap.participants.find((row) => row.participantId === a.participantId).delivery.confirmed, JSON.stringify(oldAck.json));
  const vb2 = await view(b.token);
  check("D5 a participant not using that stair keeps the same route (no needless churn)", vb2.advice.routeId === vb.advice.routeId, `${vb.advice.routeRevision}->${vb2.advice.routeRevision}`);

  // ---- bridge closed (B3/B4 floor 3; was floor 4 before 2026-11-09) -------------------------------
  const c = (await join(drill.joinCode, "qa-device-c")).json;
  await report(c.token, { source: "manual", checkpointId: cp("B4F3-").id });
  const vc = await view(c.token);
  await post(`/api/admin/incidents/${drill.id}/closures`, { groupId: "b34-bridge", closed: true, reason: "QA" }, STAFF);
  await sleep(200);
  const vc2 = await view(c.token);
  check("D6 with the bridge closed no route uses it", vc2.advice.status === "ok" && !(groupById.get("b34-bridge").edgeIds.some((edgeId) => vc2.advice.edgeIds.includes(edgeId))), `${vc.advice.destination?.name} -> ${vc2.advice.destination?.name}`);
  await post(`/api/admin/incidents/${drill.id}/closures`, { groupId: "b34-bridge", closed: false, reason: "QA" }, STAFF);

  // ---- no route --------------------------------------------------------------------------------
  const b1Exits = groups.filter((group) => group.id.startsWith("b1-exit") || group.id.startsWith("b1-stair"));
  for (const group of b1Exits) await post(`/api/admin/incidents/${drill.id}/closures`, { groupId: group.id, closed: true, reason: "QA" }, STAFF);
  await sleep(300);
  const va3 = await view(a.token);
  check("D7 with every B1 stair/exit closed the phone says there is no route (no invented safe area)", va3.advice.status === "no-route" && va3.advice.edgeIds.length === 0 && va3.advice.destination === null, `${va3.advice.status}: ${va3.advice.message}`);
  check("D8 no-route asks for help automatically", Boolean(va3.me.helpRequestedAt));
  check("D9 position is not moved (no teleport)", va3.me.location?.nodeId === va.me.location?.nodeId);
  for (const group of b1Exits) await post(`/api/admin/incidents/${drill.id}/closures`, { groupId: group.id, closed: false, reason: "QA" }, STAFF);
  await sleep(200);
  const va4 = await view(a.token);
  check("D10 reopening passages restores a route", va4.advice.status === "ok", va4.advice.status);

  // ---- mobility (no stairs) --------------------------------------------------------------------
  await post("/api/participant/profile", { mobility: "no-stairs" }, b.token);
  await sleep(200);
  const vb3 = await view(b.token);
  check("D11 no-stairs profile on an upper floor: no stair route is offered", vb3.advice.status === "mobility-no-route" && !vb3.advice.edgeIds.some((edgeId) => edgeById.get(edgeId)?.kind === "stair"), `${vb3.advice.status}: ${vb3.advice.message}`);
  const d = (await join(drill.joinCode, "qa-device-d", { mobility: "no-stairs" })).json;
  await report(d.token, { source: "manual", checkpointId: cp("B3F1-").id });
  const vd = await view(d.token);
  check("D12 no-stairs on the ground floor still gets a step-free route", vd.advice.status === "ok" && !vd.advice.edgeIds.some((edgeId) => edgeById.get(edgeId)?.kind === "stair"), vd.advice.status);

  // ---- location validation ------------------------------------------------------------------
  const mismatch = await post("/api/participant/location", { source: "qr", checkpointId: cpA.id, observedAt: Date.now(), clientSeq: seq++, mapVersion: "skr-map-old" }, a.token);
  check("E1 map version mismatch is refused (409)", mismatch.status === 409 && mismatch.json?.error === "map-version-mismatch", mismatch.status);
  const replay = await post("/api/participant/location", { source: "qr", checkpointId: cpA.id, observedAt: Date.now(), clientSeq: 1, mapVersion: map.mapVersion }, a.token);
  check("E2 replayed/old location report is refused (409)", replay.status === 409, replay.status);
  const jump = await report(a.token, { source: "manual", checkpointId: cp("B4F1-").id });
  check("E3 implausible jump (other building in <1 s) is not trusted", jump.json?.view?.me?.locationState === "uncertain", jump.json?.view?.me?.locationState);
  const vaJump = await view(a.token);
  check("E4 uncertain position: the old route is withdrawn (no-location), the position is not guessed", vaJump.advice?.status === "no-location" && vaJump.me.location?.nodeId === va4.me.location?.nodeId, `${vaJump.advice?.status} · ${vaJump.me.locationNote ?? ""}`);
  const reconfirm = await report(a.token, { source: "qr", checkpointId: cp("B4F1-").id, confirmJump: true });
  check("E4b an explicit re-confirmation (scan from the uncertain screen) is accepted", reconfirm.json?.view?.me?.locationState === "confirmed" && reconfirm.json.view.advice?.status === "ok", reconfirm.json?.view?.advice?.status);
  const geo = await report(c.token, { source: "geolocation", geo: { lat: 14.03, lon: 100.73, accuracy: 35 } });
  check("E5 browser geolocation is stored as a note, not mapped to a floor (no georeference)", geo.status === 200 && geo.json.view.me.location?.nodeId === vc2.me.location?.nodeId, geo.json?.view?.me?.locationNote ?? "");
  const badSchema = await post("/api/participant/location", { source: "teleport", observedAt: "x" }, c.token);
  check("S7 schema validation rejects malformed input", badSchema.status === 400, badSchema.status);

  // ---- sensors / data quality ---------------------------------------------------------------
  const registry = (await get("/api/sensors/registry")).json.sensors;
  const smoke = registry.find((sensor) => sensor.type === "smoke" && sensor.buildingId === "building-1" && sensor.floor === 5) ?? registry.find((sensor) => sensor.type === "smoke");
  const heat = registry.find((sensor) => sensor.type === "heat");
  const reading = (sensor, extra) => ({ sensorId: sensor.sensorId, type: sensor.type, value: 12, unit: "%/m", status: "alarm", eventId: `e-${Math.random().toString(36).slice(2)}`, sequence: 1, observedAt: Date.now(), quality: "good", mode: "drill", ...extra });
  const alarm = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(smoke, { sequence: 10 })] }, SENSOR_KEY);
  check("C1 sensor gateway key accepted", alarm.status === 200 && alarm.json.results[0].accepted, JSON.stringify(alarm.json?.results));
  await sleep(200);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  const drillSummary = snap.incidents.find((incident) => incident.id === drill.id);
  check("C2 alarm becomes a measured hazard and bumps hazardRevision", drillSummary.hazards.some((hazard) => hazard.kind === "measured") && drillSummary.hazardRevision > 0, drillSummary.hazards.map((hazard) => hazard.label).join(", "));
  const dup = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(smoke, { sequence: 10, status: "normal", value: 0.1 })] }, SENSOR_KEY);
  check("C3 duplicate sequence is rejected", dup.json.results[0].issue === "duplicate", dup.json.results[0].issue);
  const late = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(smoke, { sequence: 5, status: "normal", value: 0.1 })] }, SENSOR_KEY);
  check("C4 out-of-order (late) reading does not override the newer alarm", late.json.results[0].issue === "out-of-order", late.json.results[0].issue);
  const unit = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(heat, { sequence: 1, value: 80, unit: "°F", status: "alarm" })] }, SENSOR_KEY);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  const heatState = snap.sensors.find((sensor) => sensor.sensorId === heat.sensorId);
  check("C5 wrong unit is flagged and the sensor marked fault (not alarm)", heatState.status === "fault" && heatState.issues.some((issue) => issue.includes("หน่วย")), `${heatState.status} ${heatState.issues.join(";")}`);
  const range = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(heat, { sequence: 2, value: 5000, unit: "°C" })] }, SENSOR_KEY);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  check("C6 out-of-range value is flagged", snap.sensors.find((sensor) => sensor.sensorId === heat.sensorId).issues.some((issue) => issue.includes("นอกช่วง")), unit.status + "/" + range.status);
  const liveData = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(smoke, { sequence: 11, mode: "live" })] }, SENSOR_KEY);
  check("C7 live-mode data is not accepted into a drill (incident isolation)", liveData.json.results[0].issue === "live-data-in-test-incident", liveData.json.results[0].issue);
  const simLive = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(smoke, { sequence: 12, mode: "live" })] }, STAFF);
  check("C8 the simulator (staff token) cannot send live-mode data", simLive.status === 403, simLive.status);
  const offline = await post("/api/sensors/events", { incidentId: drill.id, readings: [reading(smoke, { sequence: 13, status: "offline", value: null, unit: null })] }, SENSOR_KEY);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  const smokeState = snap.sensors.find((sensor) => sensor.sensorId === smoke.sensorId);
  check("C9 offline is reported as offline (not normal/safe)", offline.status === 200 && smokeState.status === "offline", smokeState.status);
  const unknownSensors = snap.sensors.filter((sensor) => sensor.status === "unknown").length;
  check("C10 sensors without data stay 'unknown' (not normal)", unknownSensors > 0, `${unknownSensors} unknown`);
  check("C11 every registered sensor is labelled as simulator-only (no real hardware yet)", registry.every((sensor) => sensor.simulatedOnly), `${registry.length} sensors`);

  // ---- counting ---------------------------------------------------------------------------------
  streamB.close();
  await sleep(400);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  const rowB = snap.participants.find((row) => row.participantId === b.participantId);
  check("F1 a closed connection (no heartbeat) does not remove the person", rowB && !rowB.connected && snap.counts.registeredParticipants >= 4, `connected=${rowB?.connected} registered=${snap.counts.registeredParticipants}`);
  check("F2 two tabs on one phone are one participant, two streams", snap.counts.openStreams >= 2 && snap.participants.filter((row) => row.participantId === a.participantId).length === 1, `streams=${snap.counts.openStreams}`);
  const emptyZone = snap.occupancy.find((zone) => zone.participants === 0 && zone.plannedHeadcount > 0);
  check("F3 a zone with no phones is not reported as empty (plan-only estimate)", emptyZone && emptyZone.coverage === "plan-only" && emptyZone.estimate !== 0, emptyZone && `${emptyZone.label}: ${emptyZone.coverage} ${emptyZone.estimate}`);
  const zoneForCount = snap.occupancy.find((zone) => zone.plannedHeadcount > 0);
  await post(`/api/admin/incidents/${drill.id}/zone-count`, { zoneId: zoneForCount.zoneId, count: 31 }, STAFF);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  const counted = snap.occupancy.find((zone) => zone.zoneId === zoneForCount.zoneId);
  check("F4 a teacher headcount overrides the device estimate and is labelled", counted.coverage === "teacher" && counted.estimate === 31, counted.coverage);
  await post("/api/participant/arrived", {}, c.token);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  check("F5 self-reported arrival is not counted as teacher-confirmed", snap.counts.selfReportedArrived === 1 && snap.counts.teacherConfirmed === 0, JSON.stringify({ self: snap.counts.selfReportedArrived, teacher: snap.counts.teacherConfirmed }));
  await post(`/api/admin/participants/${c.participantId}/confirm-arrival`, {}, STAFF);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  check("F6 teacher confirmation recorded separately", snap.counts.teacherConfirmed === 1);
  check("F7 no MAC address or device identifier is exposed to staff", !JSON.stringify(snap).match(/qa-device-|([0-9a-f]{2}:){5}[0-9a-f]{2}/i));

  // ---- preview isolation + reset-test ------------------------------------------------------------
  const ticket = (await post(`/api/admin/incidents/${drill.id}/preview-ticket`, {}, STAFF)).json.ticket;
  const preview = (await post("/api/participant/join", { previewTicket: ticket, deviceKey: "qa-preview" })).json;
  await post(`/api/admin/participants/${preview.participantId}/demo`, { action: "place", checkpointId: cp("B1F3-").id }, STAFF);
  await post(`/api/admin/participants/${preview.participantId}/demo`, { action: "advance" }, STAFF);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  const realBefore = snap.counts.registeredParticipants;
  check("G1 preview tester is counted separately from real participants", snap.counts.testParticipants === 1, JSON.stringify({ tests: snap.counts.testParticipants, real: realBefore }));
  await post(`/api/admin/incidents/${drill.id}/reset-test`, {}, STAFF);
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  check("G2 'reset test scenario' leaves real participants untouched", snap.counts.registeredParticipants === realBefore, `${realBefore} -> ${snap.counts.registeredParticipants}`);
  const beforeStaffView = await view(a.token);
  const staffView = await get(`/api/admin/participants/${a.participantId}/view`, STAFF);
  const after = await view(a.token);
  check("G3 the read-only staff view does not change the participant's location", staffView.status === 200 && after.me.location?.nodeId === beforeStaffView.me.location?.nodeId && after.revision === beforeStaffView.revision);
  [streamA, streamA2].forEach((stream) => stream.close());
  await post(`/api/admin/incidents/${drill.id}/end`, {}, STAFF);

  // ---- Simulator A: isolation, delivery, closures, roster and restart ------------------------------
  {
  const simId=sim.incident?.id??sim.id;
  check("SB1 bots rejected in a drill", (await post(`/api/admin/incidents/${drill.id}/sim-bots`,{bots:[]},STAFF)).status===403);
  await post(`/api/admin/incidents/${simId}/active`,{},STAFF);
  const sync=(bots=[],extra={})=>post(`/api/admin/incidents/${simId}/sim-bots`,{bots,...extra},STAFF);
  const bots=[{botId:0,nodeId:cpA.nodeId},{botId:1,nodeId:cpB.nodeId}];
  check("SB2 invalid bot batch rejected before mutation",(await sync([{botId:.5,nodeId:cpA.nodeId}])).status===400 && (await sync([{botId:2,nodeId:'missing-node'}])).status===400);
  check("SB3 duplicate bot ids rejected",(await sync([bots[0],bots[0]])).status===400);
  check("SB4 bot roster accepted",(await sync(bots,{full:true,replace:true})).status===200);
  await post(`/api/admin/incidents/${simId}/evacuate`,{},STAFF);
  const advice=(await sync()).json.advice;
  check("SB5 both bots receive real backend routes",advice.length===2&&advice.every(a=>a.status==='ok'&&a.edgeIds.length>0),advice.map(a=>a.botId+':'+a.routeRevision).join(' '));
  check("SB6 unchanged advice is not redelivered",(await sync()).json.advice.length===0);
  check("SB7 full delivery recovers a lost response",(await sync(bots,{full:true})).json.advice.length===2);
  let botSnap=(await get('/api/admin/snapshot',STAFF)).json;
  check("SB8 simulated bots excluded from real participant table/counts",botSnap.counts.simBots===2&&botSnap.counts.registeredParticipants===0&&botSnap.participants.length===0,JSON.stringify(botSnap.counts));
  check("SB9 simulated occupancy and bottlenecks include bots",botSnap.occupancy.some(z=>z.participants>0)&&botSnap.bottlenecks.length>0);
  const b0=advice.find(a=>a.botId===0),b1Stair=groups.find(g=>g.id.startsWith('b1-stair')&&g.edgeIds.some(e=>b0.edgeIds.includes(e)));
  await post(`/api/admin/incidents/${simId}/closures`,{groupId:b1Stair.id,closed:true,reason:'QA stationary bot closure'},STAFF);
  const changed=(await sync()).json.advice.find(a=>a.botId===0);
  check("SB10 closure reroutes a stationary bot without another position update",changed?.routeRevision>b0.routeRevision&&!changed.edgeIds.some(e=>b1Stair.edgeIds.includes(e)));
  const pid=(await get(`/api/admin/incidents/${simId}/sim-bots/0`,STAFF)).json.participantId;
  const botView=(await get(`/api/admin/participants/${pid}/view`,STAFF)).json;
  check("SB11 selected bot can be viewed as simulated read-only data",botView.me.isTest&&botView.me.participantId===pid&&botView.advice?.nodeIds.length>0);
  check("SB12 stale auto-walk revision cannot advance",(await post(`/api/admin/participants/${pid}/demo`,{action:'advance',expectedRouteRevision:0},STAFF)).status===409);
  await sync([bots[0]],{full:true,replace:true});
  check("SB13 lowering phone adoption removes only omitted bots",(await get('/api/admin/snapshot',STAFF)).json.counts.simBots===1);
  const ticket=(await post(`/api/admin/incidents/${simId}/preview-ticket`,{},STAFF)).json.ticket;
  const preview=(await post('/api/participant/join',{incidentId:simId,previewTicket:ticket,deviceKey:'sim-reset-preview'})).json;
  await post(`/api/admin/incidents/${simId}/reset-test`,{scope:'bots'},STAFF);
  check("SB14 restarting bot run preserves phone-preview session",(await get(`/api/admin/participants/${preview.participantId}/view`,STAFF)).status===200&&(await get('/api/admin/snapshot',STAFF)).json.counts.simBots===0);
  await post(`/api/admin/incidents/${simId}/end`,{},STAFF);
  }

  // ---- load: N sessions --------------------------------------------------------------------------
  const loadIncident = (await post("/api/admin/incidents", { mode: "drill", title: `QA load ${SESSIONS}` }, STAFF)).json;
  const load = loadIncident.incident ?? loadIncident;
  const roomCheckpoints = map.checkpoints.filter((checkpoint) => checkpoint.kind === "room");
  const memBefore = (await get("/api/health")).json.memoryMb;
  const joinStart = performance.now();
  const joined = await poolMap(Array.from({ length: SESSIONS }, (_, index) => index), 64, (index) => join(load.joinCode, `load-${index}`));
  const joinSeconds = (performance.now() - joinStart) / 1000;
  const tokens = joined.filter((r) => r.status === 200).map((r) => r.json.token);
  const joinErrors = joined.filter((r) => r.status !== 200).length;
  check(`L1 ${SESSIONS} joins`, joinErrors === 0, `${joinErrors} errors · p50 ${percentile(joined.map((r) => r.ms), 50).toFixed(1)} ms · p95 ${percentile(joined.map((r) => r.ms), 95).toFixed(1)} ms · ${joinSeconds.toFixed(1)} s total`);
  const located = await poolMap(tokens, 64, (token, index) => report(token, { source: "qr", checkpointId: roomCheckpoints[index % roomCheckpoints.length].id }));
  const locErrors = located.filter((r) => r.status !== 200).length;
  check(`L2 ${tokens.length} location reports`, locErrors === 0, `${locErrors} errors · p50 ${percentile(located.map((r) => r.ms), 50).toFixed(1)} ms · p95 ${percentile(located.map((r) => r.ms), 95).toFixed(1)} ms · p99 ${percentile(located.map((r) => r.ms), 99).toFixed(1)} ms`);
  const streams = [];
  const streamStart = performance.now();
  await poolMap(tokens, 200, async (token) => { const stream = openStream(`participant=${token}`); streams.push(stream); await stream.first; });
  const openSeconds = (performance.now() - streamStart) / 1000;
  const healthStreams = (await get("/api/health")).json.streams;
  check(`L3 ${tokens.length} SSE streams open`, healthStreams >= tokens.length, `${healthStreams} open in ${openSeconds.toFixed(1)} s`);
  const evStart = performance.now();
  const evRes = await post(`/api/admin/incidents/${load.id}/evacuate`, {}, STAFF);
  const evMs = performance.now() - evStart;
  const waitAll = async (predicate, timeoutMs) => {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (streams.every((stream) => predicate(stream.latest))) return performance.now() - started;
      await sleep(50);
    }
    return null;
  };
  const allRouted = await waitAll((latest) => latest?.advice && latest.advice.status !== "not-evacuating", 60_000);
  check("L4 evacuate: every phone receives advice over SSE", evRes.status === 200 && allRouted !== null, `request ${evMs.toFixed(0)} ms · all delivered after ${allRouted === null ? "timeout" : `${allRouted.toFixed(0)} ms`}`);
  const routedOk = streams.filter((stream) => stream.latest?.advice?.status === "ok").length;
  check("L5 phones with a confirmed room position got a route", routedOk === streams.length, `${routedOk}/${streams.length} ok`);
  // Load spreading: phones in Building 1 should not all be sent to the same stair.
  const firstStair = new Map();
  streams.forEach((stream) => {
    const advice = stream.latest?.advice;
    if (!advice || advice.status !== "ok" || !advice.start.nodeId || nodeById.get(advice.start.nodeId)?.buildingId !== "building-1") return;
    const group = groups.find((candidate) => candidate.id.startsWith("b1-stair") && candidate.edgeIds.some((edgeId) => advice.edgeIds.includes(edgeId)));
    if (group) firstStair.set(group.label, (firstStair.get(group.label) ?? 0) + 1);
  });
  const shares = [...firstStair.values()];
  check("L6 load is spread over the B1 stairs (not everyone on one)", shares.length >= 2 && Math.max(...shares) / shares.reduce((x, y) => x + y, 0) < 0.8, JSON.stringify(Object.fromEntries(firstStair)));
  snap = (await get("/api/admin/snapshot", STAFF)).json;
  check("L7 bottlenecks list assigned people per passage (not a measured queue)", snap.bottlenecks.length > 0 && snap.bottlenecks.every((row) => row.assigned > 0 && row.clearanceSeconds >= 0), snap.bottlenecks.slice(0, 3).map((row) => `${row.label}:${row.assigned}`).join(", "));
  const revBefore = new Map(streams.map((stream) => [stream, stream.latest?.advice?.routeRevision ?? 0]));
  const closeStart = performance.now();
  await post(`/api/admin/incidents/${load.id}/closures`, { groupId: "b1-stair-center", closed: true, reason: "QA load" }, STAFF);
  const centreEdges = new Set(groupById.get("b1-stair-center").edgeIds);
  const affected = streams.filter((stream) => stream.latest?.advice?.edgeIds?.some((edgeId) => centreEdges.has(edgeId)));
  const changedAfter = await (async () => {
    const started = performance.now();
    while (performance.now() - started < 60_000) {
      if (affected.every((stream) => (stream.latest?.advice?.routeRevision ?? 0) > revBefore.get(stream) && !stream.latest.advice.edgeIds.some((edgeId) => centreEdges.has(edgeId)))) return performance.now() - started;
      await sleep(50);
    }
    return null;
  })();
  check(`L8 closure with ${tokens.length} phones: every affected phone gets a new route`, changedAfter !== null, `${affected.length} affected · delivered after ${changedAfter === null ? "timeout" : `${changedAfter.toFixed(0)} ms`} (request at ${(performance.now() - closeStart).toFixed(0)} ms)`);
  const memAfter = (await get("/api/health")).json.memoryMb;
  check("L9 server memory (RSS) with all sessions connected", memAfter < 1024, `${memBefore} MB -> ${memAfter} MB`);
  const pingLatency = [];
  for (let i = 0; i < 20; i += 1) pingLatency.push((await get("/api/health")).ms);
  check("L10 server still responsive under load", percentile(pingLatency, 95) < 500, `health p95 ${percentile(pingLatency, 95).toFixed(1)} ms`);
  streams.forEach((stream) => stream.close());
  await sleep(500);
  const closedStreams = (await get("/api/health")).json.streams;
  check("L11 streams are released when phones disconnect", closedStreams <= 5, `${closedStreams} left open`);

  // ---- event log on disk -------------------------------------------------------------------------
  const log = (await get("/api/admin/log?limit=50", STAFF)).json;
  check("H1 event log records actions with actor and time", Array.isArray(log.entries ?? log) && (log.entries ?? log).length > 0);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error(error);
  results.push({ name: "harness error", ok: false, detail: String(error) });
} finally {
  stop();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (Node ${process.version}, ${SESSIONS} sessions, same machine as the server)`);
  if (failed.length) { console.log("Failed: " + failed.map((result) => result.name).join(" | ")); exitCode = 1; }
  const outDir = join(root, "qa-output");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "mobile-guidance-results.json"), JSON.stringify({ at: new Date().toISOString(), sessions: SESSIONS, results }, null, 1));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(exitCode), 200);
}
