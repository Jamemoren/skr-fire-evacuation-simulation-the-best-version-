// Measured CPU cost of the roleplay simulator's parts, without rendering (Node, this machine):
// simulation step with 20 and 3,000 NPCs (with the player's body in the crowd), the player's own
// movement + guide, the simulator adapter's scan, and the size of one world snapshot.
//   node scripts/perf-roleplay.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire, Module } from "node:module";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-roleplay-perf-"));
process.env.NODE_PATH = resolve(root, "node_modules"); Module._initPaths();
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", temp, "--target", "ES2022", "--module", "CommonJS", "--moduleResolution", "Node", "--esModuleInterop", "--skipLibCheck",
  "src/roleplay/playerMotion.ts", "src/roleplay/spawn.ts", "src/roleplay/simulatorAdapter.ts", "src/simulation/runtime.ts", "src/evac/routing.ts"], { cwd: root, stdio: "inherit" });
const motion = require(join(temp, "roleplay/playerMotion.js"));
const spawn = require(join(temp, "roleplay/spawn.js"));
const { SimulatorWorldAdapter } = require(join(temp, "roleplay/simulatorAdapter.js"));
const { EvacuationRuntime } = require(join(temp, "simulation/runtime.js"));
const { getMapRegistry } = require(join(temp, "evac/mapRegistry.js"));
const { computeRouteField, pathFromField } = require(join(temp, "evac/routing.js"));

const registry = getMapRegistry();
const world = motion.walkWorld();
const quantile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const out = {};
for (const npc of [20, 3000]) {
  const runtime = new EvacuationRuntime();
  runtime.addPresetFire("center");
  runtime.start({ populationTarget: npc, crowdBehavior: "surge", seed: 7 });
  const plan = spawn.planSpawn({ buildingId: "building-1", floor: 5, kind: "room", id: "b1-f5-blue-2" }, runtime.fires, runtime.agents.map((a) => a.position));
  const nav = motion.PlayerNavigator.at(world, plan.requested.point ?? plan.suggestion.point);
  const field = computeRouteField(registry, "standard", { closedEdges: new Set(), hazardBlockedEdges: new Set(), hazardMarginEdges: new Map(), edgeLoad: new Map(), assemblyLoad: new Map() });
  const route = pathFromField(field, nav.nearestNode(), registry);
  const sends = [];
  const adapter = new SimulatorWorldAdapter(runtime, (payload) => { sends.push(JSON.stringify(payload).length); return Promise.resolve(); });
  const simMs = [], playerMs = [], guideMs = [], adapterMs = [];
  const dt = 1 / 60;
  let guideClock = 0;
  // 30 s of simulated time at 60 frames/s; the adapter runs every 3rd frame (≈ its 50 ms timer)
  // and the event loop turns between calls so its sends complete like in the page.
  for (let frame = 0; frame < 60 * 30; frame += 1) {
    runtime.playerBody = [...nav.position];
    let t = performance.now(); runtime.advance(dt, 4); simMs.push(performance.now() - t);
    t = performance.now();
    const look = motion.guideLookahead(world, nav.support, route.nodeIds, route.edgeIds, nav.position, 1.6);
    const dx = look.waypoint[0] - nav.position[0], dz = look.waypoint[2] - nav.position[2], len = Math.hypot(dx, dz) || 1;
    const near = runtime.agents.filter((a) => a.status !== "arrived" && Math.abs(a.position[0] - nav.position[0]) < 2 && Math.abs(a.position[2] - nav.position[2]) < 2 && Math.abs(a.position[1] - nav.position[1]) < 1.2).map((a) => a.position);
    const v = 1.35 * motion.surfaceSpeedFactor(nav.support) * dt;
    nav.move(dx / len * v, dz / len * v, near.length ? (from, to) => near.some((p) => { const d = Math.hypot(p[0] - to[0], p[2] - to[2]); return d < 0.42 && d < Math.hypot(p[0] - from[0], p[2] - from[2]); }) : undefined);
    playerMs.push(performance.now() - t);
    guideClock += dt;
    if (guideClock >= 0.15) {
      guideClock = 0;
      t = performance.now();
      motion.guideLookahead(world, nav.support, route.nodeIds, route.edgeIds, nav.position, 3);
      runtime.peopleAround(nav.position, 2.5);
      guideMs.push(performance.now() - t);
    }
    if (frame % 3 === 0) { t = performance.now(); adapter.step(Date.now()); adapterMs.push(performance.now() - t); await new Promise((r) => setTimeout(r, 0)); }
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  out[`${npc} NPCs`] = {
    agents: runtime.agents.length,
    "simulation step ms (avg / p95 per 1/60 s)": [round(simMs.reduce((a, b) => a + b, 0) / simMs.length), round(quantile(simMs, 0.95))],
    "player move+collision ms (avg / p95 per frame)": [round(playerMs.reduce((a, b) => a + b, 0) / playerMs.length), round(quantile(playerMs, 0.95))],
    "guide update ms (avg per 0.15 s)": round(guideMs.reduce((a, b) => a + b, 0) / guideMs.length),
    "adapter slice ms (avg / p95 per call)": [round(adapterMs.reduce((a, b) => a + b, 0) / adapterMs.length), round(quantile(adapterMs, 0.95))],
    "world snapshot bytes (avg / max)": [Math.round(sends.reduce((a, b) => a + b, 0) / Math.max(1, sends.length)), Math.max(0, ...sends)],
    "snapshots sent (30 s simulated, wall-clock paced)": sends.length,
  };
}
console.log(JSON.stringify(out, null, 2));
