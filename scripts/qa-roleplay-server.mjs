// QA for the roleplay simulator's server side: player ticket, simulator positions, the simulator
// adapter (sim-world), re-routing and its limits. Starts its OWN server on a spare port with a
// temporary data folder (never touches a running drill).   node scripts/qa-roleplay-server.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const STAFF = "qa-staff-token-not-secret";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };

const server = spawn(process.execPath, [join(root, "scripts/evac-server.mjs"), `--port=${PORT}`, `--data=${mkdtempSync(join(tmpdir(), "evac-rp-"))}`], {
  cwd: root, env: { ...process.env, EVAC_STAFF_TOKEN: STAFF, EVAC_HOST: "127.0.0.1", EVAC_RATE_LIMIT_SCALE: "50" }, stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (chunk) => { log += chunk; });
server.stderr.on("data", (chunk) => { log += chunk; });
process.on("exit", () => { try { server.kill(); } catch { /* gone */ } });

function request(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
      res.on("end", () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", (error) => resolve({ status: 0, json: { error: String(error) } }));
    if (data) req.write(data);
    req.end();
  });
}
const post = (path, body, token = STAFF) => request("POST", path, body ?? {}, token);
const get = (path, token = STAFF) => request("GET", path, undefined, token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 100 && !log.includes("backend http"); i += 1) await sleep(200);
const map = (await get("/api/map")).json;
check("server up with the shared map", map?.mapVersion, map?.mapVersion);

// ------------------------------------------------------------------ tickets and modes
const control = (await post("/api/admin/incidents", { mode: "drill", title: "QA control" })).json.incident;
const drill = control;
const sim = (await post("/api/admin/incidents", { mode: "simulation", title: "สวมบทอพยพ (SIMULATOR)", activate: false })).json.incident;
const snap0 = (await get("/api/admin/snapshot")).json;
check("a roleplay incident does not take over the control centre's active incident", snap0.activeIncidentId === control.id, snap0.activeIncidentId);
const drillTicket = await post(`/api/admin/incidents/${drill.id}/player-ticket`, {});
check("a player ticket is refused for a drill (simulation only)", drillTicket.status >= 400, `${drillTicket.status} ${drillTicket.json?.error}`);
const noStaff = await post(`/api/admin/incidents/${sim.id}/player-ticket`, {}, "wrong");
check("a player ticket needs staff rights", noStaff.status === 401, noStaff.status);
await post(`/api/admin/incidents/${sim.id}/evacuate`, {});
const ticket = (await post(`/api/admin/incidents/${sim.id}/player-ticket`, {})).json.ticket;
const join1 = (await request("POST", "/api/participant/join", { previewTicket: ticket, deviceKey: "qa-device-player", displayName: "x" })).json;
check("the player joins its simulation incident", join1?.incidentId === sim.id, join1?.incidentId);
const join2 = (await request("POST", "/api/participant/join", { previewTicket: ticket, deviceKey: "qa-device-player", displayName: "x" })).json;
check("re-joining with the same device key does not create a second player", join2?.participantId === join1.participantId, `${join1.participantId} / ${join2?.participantId}`);
const player = join1.token;

// ------------------------------------------------------------------ simulator positions
const location = (body, token = player) => post("/api/participant/location", { observedAt: Date.now(), clientSeq: Date.now() + Math.random(), mapVersion: map.mapVersion, ...body }, token);
const pos = await location({ source: "simulator", nodeId: "sim-corr-pink-f5-b1", position: [-12.5, 14.2, 1.9], headingDeg: 90 });
check("the player reports its character's position (source simulator)", pos.status === 200 && pos.json.view.me.location.source === "simulator", pos.status);
check("…with position and heading stored, and a route issued", pos.json?.view.me.location.position?.length === 3 && pos.json.view.me.location.headingDeg === 90 && pos.json.view.advice?.status === "ok", pos.json?.view.advice?.status);
const jump = await location({ source: "simulator", nodeId: "campus-b3-stair-0-f3", position: [-130, 8, -40], headingDeg: 0 });
check("a simulator position is the character's own (no plausibility rejection for a game reset)", jump.status === 200 && jump.json.view.me.locationState === "confirmed", jump.json?.view.me.locationState);
await location({ source: "simulator", nodeId: "sim-corr-pink-f5-b1", position: [-12.5, 14.2, 1.9], headingDeg: 0 });

const testerTicket = (await post(`/api/admin/incidents/${sim.id}/preview-ticket`, {})).json.ticket;
const tester = (await request("POST", "/api/participant/join", { previewTicket: testerTicket, deviceKey: "qa-device-tester" })).json.token;
const fake = await location({ source: "simulator", nodeId: "sim-corr-pink-f5-b1", position: [0, 0, 0], headingDeg: 0 }, tester);
check("the old tester phone cannot send simulator positions", fake.status === 403 && fake.json?.error === "simulator-only", `${fake.status} ${fake.json?.error}`);
const drillJoin = (await request("POST", "/api/participant/join", { joinCode: drill.joinCode, deviceKey: "qa-real-phone" })).json.token;
const realFake = await location({ source: "simulator", nodeId: "sim-corr-pink-f5-b1", position: [0, 0, 0], headingDeg: 0 }, drillJoin);
check("a real participant can never send simulator positions (no ground truth into real use)", realFake.status === 403, `${realFake.status} ${realFake.json?.error}`);

// ------------------------------------------------------------------ simulator adapter: sim-world
const drillWorld = await post(`/api/admin/incidents/${drill.id}/sim-world`, { blocked: [], margins: {}, crowd: {}, simTime: 1 });
check("simulator ground truth is refused for a drill", drillWorld.status === 403, drillWorld.status);
const me0 = (await get("/api/participant/me", player)).json;
const route0 = me0.advice;
check("initial advice exists", route0?.status === "ok" && route0.edgeIds.length > 2, route0?.routeId);
const blockedEdge = route0.edgeIds.find((edgeId) => edgeId.includes("stair")) ?? route0.edgeIds[2];
const world = await post(`/api/admin/incidents/${sim.id}/sim-world`, { blocked: [blockedEdge], margins: {}, crowd: {}, simTime: 12 });
check("sim-world accepted for the simulation incident", world.status === 200 && world.json.blocked === 1, world.json);
const me1 = (await get("/api/participant/me", player)).json;
check("a passage blocked by simulated fire re-routes at once with the reason", me1.advice.routeId !== route0.routeId && !me1.advice.edgeIds.includes(blockedEdge) && /แบบจำลอง/.test(me1.advice.reason?.text ?? ""), me1.advice.reason?.text);
check("the incident summary labels it as simulated, with the snapshot's source", me1.incident.hazards.some((h) => h.kind === "simulated") && me1.incident.simWorld?.source === "simulator-ground-truth", me1.incident.simWorld);
const routeBeforeCrowd = me1.advice.routeId;
const crowdEdges = Object.fromEntries(me1.advice.edgeIds.slice(1, 6).map((edgeId) => [edgeId, 400]));
await post(`/api/admin/incidents/${sim.id}/sim-world`, { blocked: [blockedEdge], margins: {}, crowd: crowdEdges, simTime: 13 });
const me2 = (await get("/api/participant/me", player)).json;
check("a crowd change right after a re-route waits for the cooldown (no flip-flop)", me2.advice.routeId === routeBeforeCrowd, `${routeBeforeCrowd} → ${me2.advice.routeId}`);
console.log("      (waiting 8.5 s for the crowd cooldown)");
await sleep(8500);
await post(`/api/admin/incidents/${sim.id}/sim-world`, { blocked: [blockedEdge], margins: {}, crowd: crowdEdges, simTime: 22 });
const me3 = (await get("/api/participant/me", player)).json;
check("after the cooldown a heavy simulated crowd moves the player to a clearly faster route", me3.advice.routeId !== routeBeforeCrowd && me3.advice.reason?.code === "congestion", me3.advice.reason?.text);
// No exit: block every passage out of the floor.
const allStairs = map.edges.filter((edge) => edge.kind === "stair" || /stair/.test(edge.id)).map((edge) => edge.id);
await post(`/api/admin/incidents/${sim.id}/sim-world`, { blocked: allStairs, margins: {}, crowd: {}, simTime: 30 });
const me4 = (await get("/api/participant/me", player)).json;
check("with every stair blocked the phone says there is no route (never a path through fire)", me4.advice.status === "no-route" && me4.advice.edgeIds.length === 0, me4.advice.message);
await post(`/api/admin/incidents/${sim.id}/sim-world`, { blocked: [], margins: {}, crowd: {}, simTime: 31 });
const me5 = (await get("/api/participant/me", player)).json;
check("when the simulated fire no longer blocks, guidance returns", me5.advice.status === "ok", me5.advice.status);

// ------------------------------------------------------------------ end of run
await post(`/api/admin/incidents/${sim.id}/end`, {});
const ended = (await get("/api/participant/me", player)).json;
check("ending the run ends the incident the phone sees", ended.incident.phase === "ended", ended.incident.phase);
const endedWorld = await post(`/api/admin/incidents/${sim.id}/sim-world`, { blocked: [], margins: {}, crowd: {}, simTime: 40 });
check("sim-world after the end is refused", endedWorld.status === 409, endedWorld.status);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
server.kill();
if (failed.length) { console.log("Failed: " + failed.map((r) => r.name).join(" | ")); process.exit(1); }
