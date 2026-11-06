import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-detour-"));
const files = [
  "src/types.ts",
  "src/building1/building1Data.ts",
  "src/simulation/types.ts",
  "src/simulation/walkable.ts",
  "src/simulation/graph.ts",
  "src/simulation/runtime.ts",
].map((file) => resolve(root, file));

try {
  execFileSync(process.execPath, [tscBin,
    "--outDir", temp,
    "--target", "ES2020",
    "--module", "CommonJS",
    "--moduleResolution", "Node",
    "--esModuleInterop",
    "--skipLibCheck",
    ...files,
  ], { cwd: root, stdio: "pipe", timeout: 60000 });

  const testPath = join(temp, "qa-outdoor-detour.cjs");
  writeFileSync(testPath, `
const { EvacuationRuntime } = require('./simulation/runtime.js');
const { createEvacuationGraph, pointRisk, findPath } = require('./simulation/graph.js');
const graph = createEvacuationGraph();
const requiredNodes = ['sim-field-gate-left','sim-field-gate','sim-field-gate-right'];
for (const id of requiredNodes) if (!graph.nodes.some(n => n.id === id)) throw new Error('missing parallel field gate ' + id);
for (const zone of ['left','center','right']) {
  const alternatives = graph.edges.filter(e => e.from === 'sim-exit-' + zone && e.kind === 'outdoor');
  if (alternatives.length < 3) throw new Error('exit lacks three field-gate alternatives: ' + zone);
}
const config = {
  populationTarget: 12,
  preset: 'balanced',
  walkingSpeed: 8,
  responseDelayMin: 0,
  responseDelayMax: 0,
  rerouteInterval: 0.8,
  distanceWeight: 0.28,
  timeWeight: 1,
  congestionWeight: 20,
  fireWeight: 4200,
  smokeWeight: 1250,
  fireSpreadEnabled: false,
  crowdBehavior: 'grouped',
  ambientTemperatureC: 29,
  heatAvoidThresholdC: 44,
  hardBlockTemperatureC: 62,
  thermalLookAheadEdges: 10,
  thermalWeight: 2400,
};
const runtime = new EvacuationRuntime();
runtime.start(config);
// The expanded campus also has a parking assembly. Explicitly set a field-bound
// scenario so this test cannot silently miss its gate fire when all 12 prefer parking.
let initialFieldRoutes = 0;
const otherGates = new Set(['sim-field-gate-left','sim-field-gate-right']);
const excluded = new Set(runtime.graph.edges.filter(e => otherGates.has(e.from) || otherGates.has(e.to)).map(e => e.id));
const destination = runtime.graph.edges.find(e => e.from === 'sim-field-gate' && e.kind === 'assembly').to;
for (const agent of runtime.agents) {
  if (!agent.roomId.startsWith('b1-')) continue;
  const path = findPath(runtime.graph, agent.route.nodeIds[0], [destination], runtime.config, [], 0, new Map(), excluded);
  if (path && path.nodeIds.includes('sim-field-gate') && runtime.commitRoute(agent, path)) initialFieldRoutes += 1;
}
if (!initialFieldRoutes) throw new Error('test must begin with a physically valid field-bound route');
runtime.addFire([-3, 0.22, 67], { fireRadius: 2.35, smokeRadius: 5.2, spreadRate: 0 });
let observedLocalDetour = false;
for (let i = 0; i < 1200 && runtime.getMetrics().arrived < config.populationTarget; i++) {
  runtime.step(0.15);
  observedLocalDetour ||= runtime.agents.some(agent => agent.detourPath.length > 0);
}
const metrics = runtime.getMetrics();
const contacts = runtime.getAgentSnapshots().filter(agent => pointRisk(agent.position, runtime.fires, runtime.time).blocked).length;
if (metrics.arrived !== config.populationTarget) throw new Error('field-gate fire still traps agents: ' + JSON.stringify(metrics));
if (metrics.blocked !== 0 || metrics.incapacitated !== 0 || contacts !== 0) throw new Error('detour safety failure: ' + JSON.stringify({metrics, contacts}));
if (metrics.topologyViolations !== 0 || metrics.collisionCorrections !== 0) throw new Error('detour violated physical guards: ' + JSON.stringify(metrics));
if (metrics.rerouteCount < 1 && !observedLocalDetour) throw new Error('test did not exercise local avoidance or alternate-gate routing');
console.log(JSON.stringify({arrived:metrics.arrived, initialFieldRoutes, localDetour:observedLocalDetour, reroutes:metrics.rerouteCount, topologyViolations:metrics.topologyViolations, collisionCorrections:metrics.collisionCorrections, fireContacts:contacts, parallelGates:3}));
`);
  const result = execFileSync("node", [testPath], { cwd: temp, encoding: "utf8", timeout: 90000 }).trim();
  console.log(`Outdoor Detour QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Outdoor Detour QA ไม่ผ่าน");
  console.error(error?.stderr?.toString?.() || error?.message || error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
