import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-thermal-"));
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
  ], { cwd: root, stdio: "pipe", timeout: 180000 });

  const testPath = join(temp, "qa-thermal.cjs");
  writeFileSync(testPath, `
const {
  createEvacuationGraph,
  findPath,
  dijkstraPath,
  edgeRiskSnapshot,
  modeledTemperatureFromHeat,
  routeIsPhysicallyValid,
  traversalPoints,
} = require('./simulation/graph.js');
const { CLASSROOMS } = require('./building1/building1Data.js');
const { EvacuationRuntime } = require('./simulation/runtime.js');

const baseConfig = {
  populationTarget:3000, preset:'balanced', walkingSpeed:1.32,
  responseDelayMin:0, responseDelayMax:0, rerouteInterval:.75,
  distanceWeight:.28, timeWeight:1, congestionWeight:20,
  fireWeight:4200, smokeWeight:1250, fireSpreadEnabled:false,
  crowdBehavior:'grouped', ambientTemperatureC:29,
  heatAvoidThresholdC:34, hardBlockTemperatureC:40,
  thermalLookAheadEdges:12, thermalWeight:5000,
};
const graph = createEvacuationGraph();
const nodeMap = new Map(graph.nodes.map(n => [n.id,n]));
const goals = graph.nodes.filter(n => n.type === 'assembly').map(n => n.id);

let selected = null;
for (const room of CLASSROOMS) {
  const safeConfig = {...baseConfig, hardBlockTemperatureC:200};
  const path = findPath(graph, room.id, goals, safeConfig, [], 0);
  if (!path) continue;
  for (const edgeId of path.edgeIds) {
    const candidate = graph.edges.find(e => e.id === edgeId);
    if (!candidate || candidate.kind !== 'stair' || candidate.floorFrom < 3) continue;
    const alternate = findPath(graph, room.id, goals, safeConfig, [], 0, new Map(), new Set([candidate.id]));
    if (alternate) { selected = {room, path, edge:candidate, alternate}; break; }
  }
  if (selected) break;
}
if (!selected) throw new Error('Could not find a baseline indoor route for thermal QA');
const edgePoints = traversalPoints(selected.edge, nodeMap, selected.edge.from, selected.edge.to);
const hotPoint = edgePoints[0] || nodeMap.get(selected.edge.from).position;
const hotFloor = selected.edge.floorFrom;
const hotNode = nodeMap.get(selected.edge.from);
const fire = {
  id:'qa-thermal-fire', position:[...hotPoint], startTime:0, intensity:2.4,
  fireRadius:0.55, smokeRadius:1.2, spreadRate:0, enabled:true,
  floor:hotFloor, wing:hotNode.wing, origin:'primary', generation:0, hasSpread:false,
  attachmentNodeId:hotNode.id, attachmentKind:['room','door','corridor','junction','stair'].includes(hotNode.type) ? hotNode.type : undefined,
};
const hotRisk = edgeRiskSnapshot(graph, selected.edge.id, [fire], 30);
const hotTemperature = modeledTemperatureFromHeat(hotRisk.heat, baseConfig.ambientTemperatureC);
if (!(hotTemperature >= baseConfig.hardBlockTemperatureC)) throw new Error('Thermal field did not hard-block the heated edge: '+JSON.stringify({hotTemperature, hotRisk, edge:selected.edge.id}));

const thermalPath = findPath(graph, selected.room.id, goals, baseConfig, [fire], 30);
if (!thermalPath) throw new Error('A* failed to find an alternate thermal-safe route');
if (!routeIsPhysicallyValid(graph, thermalPath)) throw new Error('Thermal A* returned a physically invalid route');
if (thermalPath.edgeIds.includes(selected.edge.id)) throw new Error('Thermal A* still used the hard-blocked heated edge');
for (const edgeId of thermalPath.edgeIds) {
  const risk = edgeRiskSnapshot(graph, edgeId, [fire], 30);
  const t = modeledTemperatureFromHeat(risk.heat, baseConfig.ambientTemperatureC);
  if (t >= baseConfig.hardBlockTemperatureC) throw new Error('Thermal A* route contains a hard-blocked edge '+edgeId+' at '+t.toFixed(1)+'C');
}
const dijkstra = dijkstraPath(graph, selected.room.id, goals, baseConfig, [fire], 30);
if (!dijkstra || !routeIsPhysicallyValid(graph, dijkstra)) throw new Error('Dijkstra thermal route failed');
if (dijkstra.edgeIds.some(id => modeledTemperatureFromHeat(edgeRiskSnapshot(graph,id,[fire],30).heat, baseConfig.ambientTemperatureC) >= baseConfig.hardBlockTemperatureC)) throw new Error('Dijkstra used a hard thermal-blocked edge');

const runtime = new EvacuationRuntime();
runtime.start({...baseConfig, populationTarget:240, hardBlockTemperatureC:38, heatAvoidThresholdC:32, thermalWeight:7000});
for (let i=0;i<12;i++) runtime.step(.25);
runtime.addPresetFire('center');
for (let i=0;i<360;i++) runtime.step(.25);
const metrics = runtime.getMetrics();
if (metrics.maxModeledTemperatureC <= 29.1) throw new Error('Runtime max modeled temperature never increased');
if (metrics.blockedThermalEdges <= 0) throw new Error('Runtime did not expose any thermal-blocked edge');
if (metrics.thermalRerouteCount <= 0) throw new Error('Runtime did not execute a thermal-triggered reroute');
if (metrics.topologyViolations !== 0) throw new Error('Thermal rerouting caused topology violations: '+metrics.topologyViolations);

console.log(JSON.stringify({
  baselineRoom:selected.room.id,
  heatedEdge:selected.edge.id,
  hotTemperature:Number(hotTemperature.toFixed(1)),
  aStarEdges:thermalPath.edgeIds.length,
  dijkstraEdges:dijkstra.edgeIds.length,
  thermalReroutes:metrics.thermalRerouteCount,
  maxModeledTemperatureC:Number(metrics.maxModeledTemperatureC.toFixed(1)),
  blockedThermalEdges:metrics.blockedThermalEdges,
  topologyViolations:metrics.topologyViolations,
}));
`);

  const result = execFileSync("node", [testPath], { cwd: temp, encoding: "utf8", timeout: 180000 }).trim();
  console.log(`Thermal Routing QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Thermal Routing QA ไม่ผ่าน");
  if (error?.stdout) console.error(String(error.stdout));
  if (error?.stderr) console.error(String(error.stderr));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
