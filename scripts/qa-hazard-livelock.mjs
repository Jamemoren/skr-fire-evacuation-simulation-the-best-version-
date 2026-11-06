// Regression: occupants near a fire must not step up to a doorway and back again forever.
//
// Found in artifacts/fire-building-trace/results.json: fire in Building 3, floor 3, room 5 — agents 103
// and 105 in the neighbouring rooms prepared their door edge and retreated 149/150 times in 120 s.
// Cause: the per-step smoke rule refused any step into thicker smoke, even when that doorway was the
// only way out to the smoke-free gallery; the planner kept choosing the same door.
//
//   node scripts/qa-hazard-livelock.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-livelock-"));
process.env.NODE_PATH = resolve(root, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };

try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck", "src/simulation/runtime.ts"], { cwd: root, stdio: "inherit" });
  const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
  const { pointRisk } = require(join(temp, "simulation/graph.js"));

  /** Counts prepare/retreat per agent and checks every position against the true fire each step. */
  function run({ fireNode, seconds, watch, population = 144, seed = 31 }) {
    const rt = new EvacuationRuntime();
    rt.start({ populationTarget: population, seed, crowdBehavior: "grouped", fireSpreadEnabled: false, responseDelayMin: 0, responseDelayMax: 2 });
    rt.addFire([...rt.nodeMap.get(fireNode).position], { startTime: -30, spreadRate: 0 });
    const counts = new Map(watch.map((id) => [id, { prepare: 0, retreat: 0, inFlame: 0, rooms: new Set() }]));
    for (const name of ["prepareEdge", "beginRetreat"]) {
      const original = rt[name].bind(rt);
      rt[name] = (...args) => {
        const result = original(...args);
        const entry = counts.get(args[0].id);
        if (entry && (name === "beginRetreat" || result === true)) entry[name === "prepareEdge" ? "prepare" : "retreat"] += 1;
        return result;
      };
    }
    for (let step = 0; step < seconds * 10; step += 1) {
      rt.advance(0.1, 10);
      for (const id of watch) {
        const agent = rt.agents[id];
        if (pointRisk(agent.position, rt.fires, rt.time).blocked) counts.get(id).inFlame += 1;
      }
    }
    return { rt, counts };
  }

  // ---------------------------------------------------------------- 1. the recorded livelock
  {
    const { rt, counts } = run({ fireNode: "b3-f3-room-5", seconds: 120, watch: [103, 105] });
    for (const id of [103, 105]) {
      const agent = rt.agents[id];
      const c = counts.get(id);
      check(`L1 agent ${id} (room next to the fire) no longer steps up to its door and back (retreats ≤ 3 in 120 s, was ~150)`, c.retreat <= 3, c);
      check(`L1 agent ${id} actually leaves its smoky room through the door`, agent.currentNodeId !== agent.roomId && agent.hasPassedRoomDoor, { node: agent.currentNodeId, status: agent.status });
      check(`L1 agent ${id} never stands in flame`, c.inFlame === 0, c.inFlame);
    }
    const m = rt.getMetrics();
    check("L1 no topology violation or state inconsistency", m.topologyViolations === 0 && m.stateInconsistencies === 0, { topology: m.topologyViolations, state: m.stateInconsistencies });
  }

  // ---------------------------------------------------------------- 2. the way-out judgement itself
  {
    const rt = new EvacuationRuntime();
    rt.start({ populationTarget: 144, seed: 31, crowdBehavior: "grouped", fireSpreadEnabled: false });
    const fire = rt.addFire([...rt.nodeMap.get("b3-f3-room-5").position], { startTime: -30, spreadRate: 0 });
    const agent = rt.agents[103];
    const edge = rt.edgeMap.get("campus-door-b3-f3-room-4");
    const route = { nodeIds: ["b3-f3-room-4", "sim-door-b3-f3-room-4", "campus-b3-f3-gallery-5"], edgeIds: ["campus-door-b3-f3-room-4", "campus-door-gallery-b3-f3-room-4"] };
    const probe = (position, path, edgeId = edge.id) => {
      const fake = { ...agent, position, edgePath: path, segmentIndex: 0, edgeIndex: 0, route, smokeExitCache: undefined, smokeSensitivity: 1 };
      return rt.smokeExitAhead(fake, rt.edgeMap.get(edgeId), [fire], rt.nodeMap, rt.edgeMap);
    };
    const room = rt.nodeMap.get("b3-f3-room-4").position, door = rt.nodeMap.get("sim-door-b3-f3-room-4").position;
    check("W1 from the smoky room, the door edge counts as a way out to cleaner air", probe([...room], [[...room], [...door]]) === true);
    const towardFire = [[...room], [...rt.nodeMap.get("b3-f3-room-5").position]];
    check("W2 a path that runs toward the fire is never treated as a way out", probe([...room], towardFire) === false);
    const roomPos = rt.nodeMap.get("b3-f3-room-5").position;
    check("W3 a path that starts at the fire itself is refused (flame/heat along the way)", probe([roomPos[0] + 0.3, roomPos[1], roomPos[2]], [[roomPos[0] + 0.3, roomPos[1], roomPos[2]], [...door]]) === false);
  }

  // ---------------------------------------------------------------- 3. a door that really is impassable
  {
    // Fire on the room's own door: there is no safe way out of that room. The person must end in an
    // honest stuck state with a reason — never "arrived", never through the flame, and without
    // stepping up and back every second.
    const target = 103;
    const { rt, counts } = run({ fireNode: "sim-door-b3-f3-room-4", seconds: 120, watch: [target] });
    const agent = rt.agents[target];
    const c = counts.get(target);
    check("S1 with the room's only door on fire the occupant does not reach an assembly area", agent.status !== "arrived", agent.status);
    check("S1 never walks through the flame", c.inFlame === 0, c.inFlame);
    check("S1 no rapid door shuffle (≤ 40 approaches in 120 s, the old loop made ~150)", c.prepare <= 40 && c.retreat <= 40, c);
    const reason = agent.reason?.code;
    check("S1 the stuck state carries a reason the result screen can show", ["holding-repeat-hazard", "holding-hazard", "no-route-reassess", "incapacitated-flame"].includes(reason) || agent.status === "incapacitated", { status: agent.status, reason, text: agent.reasonText ?? "" });
  }

  // ---------------------------------------------------------------- 4. warm (not hot) gallery outside the door
  // Fire in the Building 4 floor 3 gallery. Rooms 3 and 5 open 6–7 m from it (≈ 32 °C, light smoke at the
  // door, clean gallery beyond); the "getting warmer" cue used to send them back ~245 times in 200 s.
  // Room 4's door opens straight into the flame: that person must stay put, not loop and not pass the fire.
  {
    const { rt, counts } = run({ fireNode: "campus-b4-f3-gallery-5", seconds: 200, watch: [110, 111, 112] });
    for (const id of [110, 112]) {
      const agent = rt.agents[id];
      const c = counts.get(id);
      check(`L2 agent ${id} leaves through a warm-but-passable doorway (retreats ≤ 3, was ~240)`, c.retreat <= 3 && agent.currentNodeId !== agent.roomId, { ...c, node: agent.currentNodeId, status: agent.status });
      check(`L2 agent ${id} never stands in flame`, c.inFlame === 0, c.inFlame);
    }
    const trapped = rt.agents[111], c = counts.get(111);
    check("L2 agent 111 (door opens into the flame) is not counted as arrived and never crosses the flame", trapped.status !== "arrived" && c.inFlame === 0, { status: trapped.status, reason: trapped.reason?.code, ...c });
  }

  // ---------------------------------------------------------------- 5. honest hold, no inflated reroute count
  // Fire at the Building 1 floor 9 centre stair: the door corridor of room blue-1 reaches ~43 °C and dense
  // smoke. The occupant may hold (shelter) but must not shuffle every second or log hundreds of "reroutes".
  {
    const { rt, counts } = run({ fireNode: "sim-stair-center-f9", seconds: 120, watch: [6] });
    const agent = rt.agents[6], c = counts.get(6);
    check("H1 agent 6 never stands in flame", c.inFlame === 0, c.inFlame);
    check("H1 no rapid shuffle at the door (≤ 40 approaches in 120 s)", c.prepare <= 40, c);
    check("H1 shows an honest state: arrived, or held/retrying with a reason", agent.status === "arrived" || ["holding-repeat-hazard", "retry-same-route", "holding-hazard", "no-route-reassess"].includes(agent.reason?.code), { status: agent.status, reason: agent.reason?.code });
    const metrics = rt.getMetrics();
    const reroutes = metrics.rerouteCount;
    const listed = metrics.stuckReasons.reduce((sum, r) => sum + r.count, 0);
    check("H1 results-screen metric lists why people are stuck (stuckReasons covers every holding person, ≤ 5 groups)", metrics.holding === 0 || listed === metrics.holding || metrics.stuckReasons.length === 5, { holding: metrics.holding, stuckReasons: metrics.stuckReasons });
    check("H1 retrying the same passage is not counted as a route change (scenario reroutes ≤ 30)", reroutes <= 30, reroutes);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("Failed: " + failed.map((r) => r.name).join(" | ")); process.exit(1); }
