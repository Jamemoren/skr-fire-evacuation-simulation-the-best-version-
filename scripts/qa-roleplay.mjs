// Regression suite for the roleplay simulator's player movement, spawn validation and guidance
// geometry (headless, deterministic). Usage: node scripts/qa-roleplay.mjs
//
// A scripted "player" steers with the same controller maths the browser uses (speed × capped dt,
// sub-steps, walkable supports) towards the advised route's look-ahead waypoint. It must physically
// reach an assembly area — checked with the runtime's assembly footprint, never by snapping.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-roleplay-"));
process.env.NODE_PATH = resolve(root, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); };

execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck",
  "src/roleplay/playerMotion.ts", "src/roleplay/spawn.ts", "src/simulation/runtime.ts", "src/evac/routing.ts"], { cwd: root, stdio: "inherit" });
const motion = require(join(temp, "roleplay/playerMotion.js"));
const spawn = require(join(temp, "roleplay/spawn.js"));
const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
const { getMapRegistry } = require(join(temp, "evac/mapRegistry.js"));
const { computeRouteField, pathFromField } = require(join(temp, "evac/routing.js"));
const { pointInsideWalkableCorridor } = require(join(temp, "simulation/walkable.js"));

const world = motion.walkWorld();
const registry = getMapRegistry();
const runtime = new EvacuationRuntime();
const noConstraints = { closedEdges: new Set(), hazardBlockedEdges: new Set(), hazardMarginEdges: new Map(), edgeLoad: new Map(), assemblyLoad: new Map() };
const field = computeRouteField(registry, "standard", noConstraints);

/** Inside the walkable world at all (any support containing the point at its height). */
const walkable = (p) => motion.supportsAt(world, p, 0.25).length > 0;

/** Drive a player from `start` along the advised route; returns the outcome and an audit. */
function drive(start, label, { maxSeconds = 900, closed = [] } = {}) {
  const nav = motion.PlayerNavigator.at(world, start);
  if (!nav) return { ok: false, why: "spawn not walkable" };
  const constraints = closed.length ? { ...noConstraints, closedEdges: new Set(closed) } : noConstraints;
  const routeField = closed.length ? computeRouteField(registry, "standard", constraints) : field;
  let route = pathFromField(routeField, nav.nearestNode(), registry);
  if (!route) return { ok: false, why: "no route" };
  const audit = { maxJump: 0, maxRise: 0, maxThreshold: 0, outside: 0, reroutes: 0, distance: 0, usedEdges: new Set(), floorsSeen: new Set() };
  const dt = 1 / 60;
  let yaw = 0;
  for (let t = 0; t < maxSeconds; t += dt) {
    // Same lookahead as the game (back along the current walkway when clearly off the route).
    const look = motion.guideLookahead(world, nav.support, route.nodeIds, route.edgeIds, nav.position, 1.6);
    if (!look) return { ok: false, why: "no lookahead", audit };
    if (look.offRoute > 2.5) {
      const replanned = pathFromField(routeField, nav.nearestNode(), registry);
      if (replanned) { route = replanned; audit.reroutes += 1; }
    }
    const dx = look.waypoint[0] - nav.position[0], dz = look.waypoint[2] - nav.position[2];
    yaw = Math.atan2(-dx, -dz);
    const length = Math.hypot(dx, dz);
    const speed = 1.35 * motion.surfaceSpeedFactor(nav.support) * Math.min(1, length / 0.2);
    const before = [...nav.position];
    const beforeSupport = nav.support.id;
    nav.move((dx / Math.max(1e-6, length)) * speed * dt, (dz / Math.max(1e-6, length)) * speed * dt);
    const jump = Math.hypot(nav.position[0] - before[0], nav.position[2] - before[2]);
    audit.maxJump = Math.max(audit.maxJump, jump);
    {
      // Within one walkway (a stair flight, a corridor) the height must follow the slope smoothly.
      // Moving from one walkway onto the next (a door threshold to the outdoor path) may step a few
      // centimetres, like a real threshold, but never more than half a stair riser.
      const rise = Math.abs(nav.position[1] - before[1]);
      const transition = nav.support.id !== beforeSupport;
      if (!transition && rise > audit.maxRise) { audit.maxRise = rise; audit.riseAt = { at: [...nav.position], from: before, support: nav.support.id }; }
      if (transition && rise > audit.maxThreshold) { audit.maxThreshold = rise; audit.thresholdAt = { at: [...nav.position], from: beforeSupport, to: nav.support.id }; }
    }
    audit.distance += jump;
    if (!walkable(nav.position)) audit.outside += 1;
    if (nav.support.kind === "edge") audit.usedEdges.add(nav.support.edge.id);
    audit.floorsSeen.add(nav.place().floor);
    const area = runtime.assemblyAreaAt(nav.position);
    if (area) return { ok: true, t, area: area.nodeId, audit, label, yaw };
    // Re-plan from where the player stands when the support's nearest node leaves the route.
    if (!route.nodeIds.includes(nav.nearestNode())) {
      const replanned = pathFromField(routeField, nav.nearestNode(), registry);
      if (replanned) { route = replanned; audit.reroutes += 1; }
    }
  }
  return { ok: false, why: "timeout", audit, at: nav.position };
}

// ---------------------------------------------------------------- A. walking out from each building
for (const [choice, label] of [
  [{ buildingId: "building-1", floor: 9, kind: "room", id: "b1-f9-pink-1" }, "B1 floor 9 classroom"],
  [{ buildingId: "building-1", floor: 5, kind: "room", id: "b1-f5-blue-2" }, "B1 floor 5 blue-wing classroom"],
  [{ buildingId: "building-3", floor: 3, kind: "room", id: "b3-f3-room-2" }, "B3 floor 3 classroom"],
  [{ buildingId: "building-4", floor: 4, kind: "room", id: "b4-f4-room-1" }, "B4 floor 4 classroom"],
]) {
  const plan = spawn.planSpawn(choice, [], []);
  check(`A ${label}: spawn is valid on the chosen building/floor`, plan.requested.ok, plan.requested.reasons.join("; "));
  if (!plan.requested.ok) continue;
  const result = drive(plan.requested.point, label);
  check(`A ${label}: walks out to an assembly area by moving, not snapping`, result.ok, result.ok ? `${result.area} after ${result.t.toFixed(0)} s, ${result.audit.distance.toFixed(0)} m` : `${result.why} ${JSON.stringify(result.at ?? "")}`);
  if (!result.audit) continue;
  check(`A ${label}: never off the walkable geometry`, result.audit.outside === 0, result.audit.outside);
  check(`A ${label}: no jump (largest frame step ≤ 2.5 cm at 1.35 m/s, 60 fps)`, result.audit.maxJump <= 0.025, result.audit.maxJump.toFixed(4));
  check(`A ${label}: height follows each walkway smoothly, stairs included (≤ 3 cm per frame)`, result.audit.maxRise <= 0.03, `${result.audit.maxRise.toFixed(4)}${result.audit.maxRise > 0.03 ? " " + JSON.stringify(result.audit.riseAt) : ""}`);
  check(`A ${label}: stepping from one walkway to the next is at most a threshold (≤ 8 cm, half a riser)`, result.audit.maxThreshold <= 0.08, `${result.audit.maxThreshold.toFixed(4)}${result.audit.maxThreshold > 0.08 ? " " + JSON.stringify(result.audit.thresholdAt) : ""}`);
  const floors = [...result.audit.floorsSeen].sort((a, b) => a - b);
  check(`A ${label}: every floor passed on the way down (no floor skipped)`, floors.every((f, i) => i === 0 || f - floors[i - 1] === 1), floors.join(","));
}

// ---------------------------------------------------------------- B. the B3–B4 bridge on floor 3
// (2026-11-09: the bridge is on floor 3; it was modelled on floor 4 before. Same check, new floor.)
{
  const choice = { buildingId: "building-3", floor: 3, kind: "room", id: "b3-f3-room-1" };
  const plan = spawn.planSpawn(choice, [], []);
  const b3Stairs = registry.graph.edges.filter((edge) => edge.kind === "stair" && registry.buildingOf.get(edge.from) === "building-3").map((edge) => edge.id);
  const result = plan.requested.ok ? drive(plan.requested.point, "B3 floor 3 with B3 stairs closed", { closed: b3Stairs }) : { ok: false, why: plan.requested.reasons.join(";") };
  check("B with every B3 stair closed, a B3 floor-3 player crosses the bridge to B4 and gets out", result.ok && result.audit.usedEdges.has("campus-straight-bridge-level-3"), result.ok ? `${result.area} · bridge used: ${result.audit.usedEdges.has("campus-straight-bridge-level-3")}` : result.why);
}

// ---------------------------------------------------------------- C. walls and voids
{
  const plan = spawn.planSpawn({ buildingId: "building-1", floor: 5, kind: "checkpoint", id: registry.checkpoints.find((c) => c.buildingId === "building-1" && c.floor === 5 && c.kind === "corridor")?.id ?? "" }, [], []);
  const nav = plan.requested.ok ? motion.PlayerNavigator.at(world, plan.requested.point) : null;
  check("C a corridor checkpoint spawn is valid", Boolean(nav), plan.requested.reasons.join("; "));
  if (nav) {
    let outside = 0;
    // Push hard into all four directions for 6 s each.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let i = 0; i < 360; i += 1) { nav.move(dx * 1.35 / 60, dz * 1.35 / 60); if (!walkable(nav.position)) outside += 1; }
    }
    check("C pushing into walls in four directions never leaves the walkway", outside === 0, outside);
    const edge = nav.support.kind === "edge" ? nav.support : null;
    check("C the player is still on a floor-5 walkway (no slab fall-through)", nav.place().floor === 5, nav.place());
    if (edge) check("C still inside its passage corridor", pointInsideWalkableCorridor(nav.position, edge.path, edge.edge), nav.position.map((v) => v.toFixed(2)).join(","));
  }
  // A long frame (2 s hitch) is split into sub-steps: one call never moves further than requested.
  if (nav) {
    const before = [...nav.position];
    const beforeSupport = nav.support.id;
    nav.move(2.6 * 0.05, 0);
    check("C one capped frame (dt 0.05 s running) moves at most 13 cm", Math.hypot(nav.position[0] - before[0], nav.position[2] - before[2]) <= 0.1301);
  }
}

// ---------------------------------------------------------------- D. spawn validation
{
  const { CORE_LIFT_X, CORE_LIFT_Z } = require(join(temp, "building1/building1Data.js"));
  const y6 = registry.nodeMap.get("sim-junction-f6")?.position[1] ?? 17.7;
  const liftReasons = spawn.checkSpawnPoint([CORE_LIFT_X[0], y6, CORE_LIFT_Z], { buildingId: "building-1", floor: 6, kind: "checkpoint", id: "x" }, [], []);
  check("D a point inside the lift bank is rejected with a reason", liftReasons.length > 0, liftReasons.join("; "));
  const airReasons = spawn.checkSpawnPoint([-20, y6, -30], { buildingId: "building-1", floor: 6, kind: "checkpoint", id: "x" }, [], []);
  check("D a point outside the building in mid-air is rejected", airReasons.length > 0, airReasons.join("; "));
  const underReasons = spawn.checkSpawnPoint([-8, y6 - 1.5, -5], { buildingId: "building-1", floor: 6, kind: "room", id: "b1-f6-pink-1" }, [], []);
  check("D a point below the floor slab is rejected", underReasons.length > 0, underReasons.join("; "));
  const room = { buildingId: "building-1", floor: 9, kind: "room", id: "b1-f9-pink-1" };
  const planOk = spawn.planSpawn(room, [], []);
  const wrongFloor = spawn.checkSpawnPoint(planOk.requested.point, { ...room, floor: 8 }, [], []);
  check("D a point on floor 9 checked as floor 8 is rejected (wrong floor)", wrongFloor.some((r) => r.includes("ชั้น")), wrongFloor.join("; "));
  const wrongBuilding = spawn.checkSpawnPoint(planOk.requested.point, { ...room, buildingId: "building-3" }, [], []);
  check("D wrong building is rejected", wrongBuilding.some((r) => r.includes("อาคาร")), wrongBuilding.join("; "));
  const p = planOk.requested.point;
  const fireRuntime = new EvacuationRuntime(); fireRuntime.reset(false);
  const fire = fireRuntime.addFire([p[0], p[1], p[2]]);
  const burning = spawn.planSpawn(room, [fire], []);
  const inFlames = spawn.checkSpawnPoint(p, room, [fire], []);
  check("D a point inside a fire is rejected", inFlames.some((r) => r.includes("เปลวไฟ")), inFlames.join("; "));
  check("D the suggestion away from the fire stays on the same building and floor", !burning.suggestion || (burning.suggestion.choice.buildingId === "building-1" && burning.suggestion.choice.floor === 9), burning.suggestion ? `${burning.suggestion.label}` : "no suggestion needed (another point in the room is valid)");
  const crowded = spawn.checkSpawnPoint(p, room, [], [[p[0] + 0.2, p[1], p[2]]]);
  check("D a point on top of a simulated person is rejected", crowded.some((r) => r.includes("ซ้อน")), crowded.join("; "));
}

// ---------------------------------------------------------------- E. arrow bearing in four directions
{
  const at = [0, 0, 0];
  const cases = [
    ["ahead (target −Z, yaw 0)", [0, 0, -5], 0, 0],
    ["right (target +X, yaw 0)", [5, 0, 0], 0, 90],
    ["left (target −X, yaw 0)", [-5, 0, 0], 0, -90],
    ["behind (target +Z, yaw 0)", [0, 0, 5], 0, 180],
    ["ahead after turning left 90° (target −X, yaw +π/2)", [-5, 0, 0], Math.PI / 2, 0],
    ["right after turning around (target −X, yaw π)", [-5, 0, 0], Math.PI, 90],
  ];
  for (const [name, target, yaw, expected] of cases) {
    const bearing = motion.relativeBearing(at, target, yaw);
    const diff = Math.abs(((bearing - expected + 540) % 360) - 180);
    check(`E arrow points ${name}`, diff < 0.5, bearing.toFixed(1));
  }
}

// ---------------------------------------------------------------- F. closure of the flight the character stands on
{
  // Found in the browser QA: halfway down the B1 centre stair (floor 4→3) the stair is closed; the
  // new route starts at the floor-4 stair node. The arrow must lead back up the flight, never
  // straight at the node through the stair wall.
  const closed = registry.graph.edges.filter((edge) => edge.id.startsWith("edge-stair-center-")).map((edge) => edge.id);
  const constraints = { ...noConstraints, closedEdges: new Set(closed) };
  const closedField = computeRouteField(registry, "standard", constraints);
  const nav = motion.PlayerNavigator.at(world, [3.47, 10.56, 0.25]);
  check("F the mid-flight point is on the closed stair flight", nav && nav.support.id === "edge:edge-stair-center-4-3", nav?.support.id);
  const route = pathFromField(closedField, "sim-stair-center-f4", registry);
  const walked = motion.routeFromSupport(nav.support, route.nodeIds, route.edgeIds);
  check("F the walk back starts on the flight itself", walked.edgeIds[0] === "edge-stair-center-4-3" && walked.nodeIds[1] === "sim-stair-center-f4", walked.nodeIds.slice(0, 3).join(" → "));
  const look = motion.guideLookahead(world, nav.support, route.nodeIds, route.edgeIds, nav.position, 3);
  check("F the arrow points up the flight (waypoint higher, on the walkway)", look.waypoint[1] > nav.position[1] && walkable(look.waypoint), look.waypoint.map((v) => v.toFixed(2)).join(","));
  let outside = 0, reached = false;
  for (let t = 0; t < 30 && !reached; t += 1 / 60) {
    const l = motion.guideLookahead(world, nav.support, route.nodeIds, route.edgeIds, nav.position, 1.6);
    const dx = l.waypoint[0] - nav.position[0], dz = l.waypoint[2] - nav.position[2], len = Math.hypot(dx, dz) || 1;
    const v = 1.35 * motion.surfaceSpeedFactor(nav.support) / 60 * Math.min(1, len / 0.2);
    nav.move(dx / len * v, dz / len * v);
    if (!walkable(nav.position)) outside += 1;
    reached = nav.nearestNode() === "sim-junction-f4" || route.nodeIds.indexOf(nav.nearestNode()) >= 2;
  }
  check("F following that arrow gets back onto the new route within 30 s, never off the walkway", reached && outside === 0, `${nav.nearestNode()} · outside ${outside}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("Failed: " + failed.map((r) => r.name).join(" | ")); process.exit(1); }
