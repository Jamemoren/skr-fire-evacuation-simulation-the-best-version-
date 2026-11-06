// Scenario sweep: fire at a room / in front of a door / corridor / stair / on the 3–4 bridge while
// people use it / at an exit, plus spread, two fires, closures, populations and seeds.
// Records what actually happened; it asserts only physical rules (no flame entry, no teleport,
// no topology violation, population accounting). "Stuck" is reported, not failed — a stuck person
// with an honest reason is a valid outcome when the layout really has no safe way.
//
//   node scripts/qa-scenario-sweep.mjs [repoRoot] [outputName]
//   SWEEP_ONLY=id1,id2  SWEEP_SECONDS=600
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";
import assert from "node:assert/strict";

const here = resolve(import.meta.dirname, "..");
const root = resolve(process.argv[2] ?? here);
const outName = process.argv[3] ?? "scenario-sweep";
const temp = mkdtempSync(join(tmpdir(), "skr-sweep-"));
process.env.NODE_PATH = resolve(here, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
const SECONDS = Number(process.env.SWEEP_SECONDS || 600);

const B3F4_STAIRS = ["campus-b3-stair-access-0-f4", "campus-b3-stair-access-1-f4"];
const BRIDGE = "campus-straight-bridge-level-4";
// fire: node id or explicit position; start (s, relative to alarm at 0; negative = already burning)
const SCENARIOS = [
  { id: "b3-room", fires: [{ node: "b3-f3-room-5" }] },
  { id: "b3-door-front", fires: [{ node: "sim-door-b3-f3-room-5" }] },
  { id: "b3-corridor", fires: [{ node: "campus-b3-f3-gallery-5" }] },
  { id: "b3-stair", fires: [{ node: "campus-b3-stair-0-f3" }] },
  { id: "b3-exit", fires: [{ node: "campus-b3-exit-0" }] },
  { id: "b4-corridor", fires: [{ node: "campus-b4-f3-gallery-5" }] },
  { id: "b4-corridor-spread", fires: [{ node: "campus-b4-f3-gallery-5" }], spread: true },
  { id: "b1-room", fires: [{ node: "b1-f5-pink-3" }] },
  { id: "b1-door-front", fires: [{ node: "sim-door-b1-f5-pink-3" }] },
  { id: "b1-corridor", fires: [{ node: "sim-corr-pink-f5-b3" }] },
  { id: "b1-corridor-spread", fires: [{ node: "sim-corr-pink-f5-b3" }], spread: true },
  { id: "b1-stair", fires: [{ node: "sim-stair-center-f5" }] },
  { id: "b1-exit", fires: [{ node: "sim-stair-exit-door-center" }] },
  { id: "two-fires-b1-b3", fires: [{ node: "sim-corr-pink-f5-b3" }, { node: "campus-b3-f3-gallery-5" }] },
  // Bridge in use: both Building 3 floor-4 stair accesses closed, so floor-4 occupants must cross to Building 4.
  { id: "bridge-in-use", closed: B3F4_STAIRS, population: 600 },
  // …and the bridge catches fire 40 s after the alarm while people are on/near it.
  { id: "bridge-fire-while-used", closed: B3F4_STAIRS, population: 600, fires: [{ bridge: true, start: 40 }] },
  { id: "b1-left-exit-closed", closed: ["edge-left-stair-door"], fires: [{ node: "sim-stair-center-f5" }] },
  { id: "b3-corridor-pop600", fires: [{ node: "campus-b3-f3-gallery-5" }], population: 600 },
  { id: "b1-corridor-seed7", fires: [{ node: "sim-corr-pink-f5-b3" }], seed: 7 },
  { id: "b3-room-seed7-spread", fires: [{ node: "b3-f3-room-5" }], seed: 7, spread: true },
];

try {
  execFileSync(process.execPath, [resolve(here, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck", join(root, "src/simulation/runtime.ts")], { cwd: root, stdio: "inherit" });
  const base = join(temp, "simulation");
  const { EvacuationRuntime } = require(join(base, "runtime.js"));
  const { pointRisk, segmentTouchesFlame } = require(join(base, "graph.js"));
  const { PEDESTRIAN_RADIUS } = require(join(base, "walkable.js"));
  assert(PEDESTRIAN_RADIUS > 0, "pedestrian radius not loaded");
  const { describeReasonTh } = require(join(base, "agentReasons.js"));
  const runtimeHash = createHash("sha256").update(readFileSync(join(root, "src/simulation/runtime.ts"))).digest("hex").slice(0, 12);
  const only = process.env.SWEEP_ONLY ? new Set(process.env.SWEEP_ONLY.split(",")) : null;
  const rows = [];
  for (const sc of SCENARIOS.filter((s) => !only || only.has(s.id))) {
    const rt = new EvacuationRuntime();
    const config = { populationTarget: sc.population ?? 144, seed: sc.seed ?? 31, crowdBehavior: "grouped", fireSpreadEnabled: !!sc.spread, responseDelayMin: 0, responseDelayMax: 2 };
    rt.start(config);
    if (sc.closed) rt.setPassageClosed(sc.closed, true);
    for (const f of sc.fires ?? []) {
      let pos;
      if (f.bridge) { const e = rt.edgeMap.get(BRIDGE); const a = rt.nodeMap.get(e.from).position, b = rt.nodeMap.get(e.to).position; pos = a.map((v, i) => (v + b[i]) / 2); }
      else pos = [...rt.nodeMap.get(f.node).position];
      rt.addFire(pos, { startTime: f.start ?? -30, spreadRate: sc.spread ? 0.028 : 0 });
    }
    const crossed = { bridge: new Set() };
    const completeEdge = rt.completeEdge.bind(rt);
    rt.completeEdge = (agent, edge) => { if (edge?.id === BRIDGE) crossed.bridge.add(agent.id); return completeEdge(agent, edge); };
    let enteredFlame = 0, maxStep = 0, teleports = 0, peakMs = 0;
    const t0 = Date.now();
    for (let step = 0; step < SECONDS * 10 && !rt.completed; step += 1) {
      const before = rt.agents.map((a) => [...a.position]);
      const wasBlocked = rt.agents.map((a) => pointRisk(a.position, rt.fires, rt.time, PEDESTRIAN_RADIUS).blocked);
      const s0 = performance.now();
      rt.advance(0.1);
      peakMs = Math.max(peakMs, performance.now() - s0);
      rt.agents.forEach((a, i) => {
        const d = Math.hypot(...a.position.map((v, j) => v - before[i][j]));
        maxStep = Math.max(maxStep, d);
        if (d > a.speed * 0.1 * 2.5 + 0.35) teleports += 1;
        if (!wasBlocked[i] && !pointRisk(before[i], rt.fires, rt.time, PEDESTRIAN_RADIUS).blocked && d > 1e-7 && segmentTouchesFlame(before[i], a.position, rt.fires, rt.time, PEDESTRIAN_RADIUS)) enteredFlame += 1;
      });
    }
    const m = rt.getMetrics();
    const remaining = rt.agents.filter((a) => a.status !== "arrived" && a.status !== "incapacitated");
    const reasons = {};
    for (const a of remaining) reasons[a.reason?.code ?? "?"] = (reasons[a.reason?.code ?? "?"] ?? 0) + 1;
    const lastArrival = Math.max(0, ...rt.agents.filter((a) => a.status === "arrived").map((a) => a.arrivedAt ?? a.reason?.at ?? 0));
    const row = {
      id: sc.id, population: rt.agents.length, seed: config.seed, spread: !!sc.spread, closed: sc.closed ?? [], fires: (sc.fires ?? []).length,
      arrived: m.arrived, incapacitated: m.incapacitated, stuck: remaining.length, simulatedSeconds: +rt.time.toFixed(1), lastArrival: +lastArrival.toFixed(1), completed: rt.completed,
      reroutes: m.rerouteCount, stuckReasons: reasons, stuckSample: remaining.slice(0, 3).map((a) => ({ id: a.id, room: a.roomId, status: a.status, text: describeReasonTh(a.reason) })),
      bridgeCrossings: crossed.bridge.size, enteredFlame, teleports, maxStep: +maxStep.toFixed(3), topologyViolations: m.topologyViolations, stateInconsistencies: m.stateInconsistencies,
      wallSeconds: +((Date.now() - t0) / 1000).toFixed(1), peakStepMs: +peakMs.toFixed(1),
    };
    rows.push(row);
    console.log(`${row.id.padEnd(24)} arrived ${row.arrived}/${row.population} incap ${row.incapacitated} stuck ${row.stuck} t=${row.simulatedSeconds} rr=${row.reroutes} bridge=${row.bridgeCrossings} flame=${row.enteredFlame} tele=${row.teleports} topo=${row.topologyViolations} wall=${row.wallSeconds}s ${JSON.stringify(row.stuckReasons)}`);
    assert.equal(m.arrived + m.incapacitated + remaining.length, rt.agents.length, "population accounting " + sc.id);
  }
  mkdirSync(join(here, "artifacts", outName), { recursive: true });
  writeFileSync(join(here, "artifacts", outName, "results.json"), JSON.stringify({ root, runtimeHash, seconds: SECONDS, rows }, null, 2));
  const bad = rows.filter((r) => r.enteredFlame || r.teleports || r.topologyViolations || r.stateInconsistencies);
  console.log(`\nruntime ${runtimeHash}: ${rows.length} scenarios, physical-rule violations in ${bad.length}`);
  if (bad.length) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
