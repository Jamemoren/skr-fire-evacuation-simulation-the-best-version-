import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-topology-"));
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
  ], { cwd: root, stdio: "pipe", timeout: 30000 });

  const testPath = join(temp, "qa-topology.cjs");
  writeFileSync(testPath, `
const { createEvacuationGraph, allocatePopulation, findPath, pointRisk, fireRadiusAt } = require('./simulation/graph.js');
const { EvacuationRuntime } = require('./simulation/runtime.js');
const { CLASSROOMS, STAIR_EXIT_DOOR_CENTERS, STAIR_EXIT_DOOR_WIDTH } = require('./building1/building1Data.js');
const config = { populationTarget:3000, preset:'balanced', walkingSpeed:1.32, responseDelayMin:0, responseDelayMax:0, rerouteInterval:1.25, distanceWeight:.28, timeWeight:1, congestionWeight:20, fireWeight:4200, smokeWeight:1250 };
const graph = createEvacuationGraph();
const nodeMap = new Map(graph.nodes.map(n => [n.id,n]));
const goals = graph.nodes.filter(n => n.type === 'assembly').map(n => n.id);

if (graph.edges.some(e => nodeMap.get(e.from)?.type === 'room' && nodeMap.get(e.to)?.type === 'stair')) throw new Error('พบ room -> stair shortcut');
for (const zone of ['left','center','right']) {
  const door = nodeMap.get('sim-stair-exit-door-' + zone);
  const expected = STAIR_EXIT_DOOR_CENTERS[zone];
  if (!door || door.type !== 'door') throw new Error('missing physical stair exit portal ' + zone);
  const error = Math.hypot(door.position[0]-expected[0], door.position[1]-expected[1], door.position[2]-expected[2]);
  if (error > 0.001) throw new Error('portal/model coordinate mismatch ' + zone);
  const approach = graph.edges.find(e => e.id === 'edge-' + zone + '-stair-door');
  if (!approach || approach.to !== door.id || approach.width > STAIR_EXIT_DOOR_WIDTH) throw new Error('approach path bypasses physical door ' + zone);
  const clearing = graph.edges.find(e => e.id === 'edge-' + zone + '-door-exit');
  if (!clearing || clearing.from !== door.id) throw new Error('exit path does not clear physical door ' + zone);
}
for (const e of graph.edges) {
  const from = nodeMap.get(e.from), to = nodeMap.get(e.to);
  if (!from || !to) throw new Error('edge node missing ' + e.id);
  if (e.kind === 'stair' && !(from.floor > 1 && to.floor === from.floor - 1)) throw new Error('stair floor violation ' + e.id);
  if (!['stair','outdoor'].includes(e.kind) && e.kind !== 'assembly' && from.floor !== to.floor) throw new Error('cross-floor non-stair ' + e.id);
  if (e.kind === 'outdoor' && !(from.floor === 1 && to.floor === 0)) throw new Error('outdoor before floor1 ' + e.id);
  if (e.kind === 'stair' && (!e.waypoints || e.waypoints.length < 20)) throw new Error('stair lacks 8+8 polyline ' + e.id);
}

for (const room of CLASSROOMS) {
  const roomDoor = nodeMap.get('sim-door-' + room.id);
  const expectedDoor = room.side === 'pink'
    ? [room.position[0] - 2.25, roomDoor?.position[1], -0.06]
    : [0.06, roomDoor?.position[1], room.position[2] - 2.25];
  if (!roomDoor || roomDoor.type !== 'door') throw new Error('missing classroom door portal ' + room.id);
  const doorError = Math.hypot(roomDoor.position[0] - expectedDoor[0], roomDoor.position[2] - expectedDoor[2]);
  if (doorError > 0.001) throw new Error('classroom door/model coordinate mismatch ' + room.id);
  const path = findPath(graph, room.id, goals, config, [], 0, new Map());
  if (!path) throw new Error('no route for ' + room.id);
  const pathNodes = path.nodeIds.map(id => nodeMap.get(id));
  if (!pathNodes.some(n => n?.type === 'door')) throw new Error('route missing door ' + room.id);
  if (!pathNodes.some(n => n?.type === 'corridor')) throw new Error('route missing corridor ' + room.id);
  if (!pathNodes.some(n => n?.type === 'stair')) throw new Error('route missing stair ' + room.id);
  if (!pathNodes.some(n => n?.id.startsWith('sim-stair-exit-door-'))) throw new Error('route bypasses physical stair exit door ' + room.id);
  const firstOutdoor = pathNodes.findIndex(n => n?.phase === 'outdoor' || n?.phase === 'assembly');
  if (firstOutdoor >= 0 && pathNodes.slice(0, firstOutdoor).some(n => (n?.floor || 0) > 1 && (n?.phase === 'outdoor' || n?.phase === 'assembly'))) throw new Error('route topology violation ' + room.id);
}

const allocation = allocatePopulation(graph, config, [], 0);
const assigned = allocation.bundles.reduce((sum,b) => sum + b.peopleCount, 0);
if (assigned !== 3000) throw new Error('expected 3000 allocation, got ' + assigned);
for (const zone of ['a','b','c','d','e','f']) if ((allocation.zoneLoads.get('sim-zone-'+zone)||0) !== 500) throw new Error('zone '+zone+' capacity mismatch');

const runtime = new EvacuationRuntime();
runtime.start({ ...config, populationTarget:600 });
for (let i=0;i<100;i++) runtime.step(.2);
let m = runtime.getMetrics();
if (m.topologyViolations !== 0) throw new Error('baseline topology violations ' + m.topologyViolations);
if (m.collisionCorrections !== 0) throw new Error('baseline wall collision corrections ' + m.collisionCorrections);
if (m.outdoorAgents > 0 && m.floorPopulation.slice(2).reduce((a,b)=>a+b,0) + m.stairAgents < 1) throw new Error('unexpected floor accounting');

runtime.addFire([2.8, 4.1, -0.5], { fireRadius:2.0, smokeRadius:5.2, spreadRate:.01 });
for (let i=0;i<90;i++) runtime.step(.2);
m = runtime.getMetrics();
if (m.topologyViolations !== 0) throw new Error('fire topology violations ' + m.topologyViolations);
if (m.collisionCorrections !== 0) throw new Error('fire wall collision corrections ' + m.collisionCorrections + ' ' + JSON.stringify(runtime.getCollisionCorrectionSamples()));
const contactAgents = runtime.getAgentSnapshots().filter(a => pointRisk(a.position, runtime.fires, runtime.time).blocked);
const contacts = contactAgents.length;
if (contacts > 0) throw new Error('agents inside active fire radius: ' + JSON.stringify({ agents:contactAgents.slice(0,4), fires:runtime.fires.map(f => ({id:f.id,floor:f.floor,position:f.position,radius:fireRadiusAt(f,runtime.time),node:f.attachmentNodeId})) }));

const highSpeedRuntime = new EvacuationRuntime();
highSpeedRuntime.start({ ...config, populationTarget:120, walkingSpeed:250 });
if (highSpeedRuntime.config.walkingSpeed !== 250) throw new Error('walking speed was still capped at startup');
const speedBeforeLiveChange = highSpeedRuntime.agents[0]?.speed || 0;
highSpeedRuntime.setWalkingSpeed(10000);
if (highSpeedRuntime.config.walkingSpeed !== 10000) throw new Error('live walking speed was capped');
if ((highSpeedRuntime.agents[0]?.speed || 0) < speedBeforeLiveChange * 39.9) throw new Error('active agent speeds were not scaled live');
highSpeedRuntime.setWalkingSpeed(Number.POSITIVE_INFINITY);
if (highSpeedRuntime.config.walkingSpeed !== 10000) throw new Error('non-finite walking speed corrupted active config');
for (let i=0;i<60;i++) highSpeedRuntime.step(.12);
const highSpeedMetrics = highSpeedRuntime.getMetrics();
if (highSpeedMetrics.topologyViolations !== 0) throw new Error('high-speed topology violations ' + highSpeedMetrics.topologyViolations);
if (highSpeedMetrics.collisionCorrections !== 0) throw new Error('high-speed wall collision corrections ' + highSpeedMetrics.collisionCorrections);

console.log(JSON.stringify({nodes:graph.nodes.length,edges:graph.edges.length,assigned,agents:600,topologyViolations:m.topologyViolations,fireContacts:contacts,reroutes:m.rerouteCount,inside:m.indoorAgents,stairs:m.stairAgents,outside:m.outdoorAgents,uncappedWalkingSpeed:highSpeedRuntime.config.walkingSpeed,highSpeedTopologyViolations:highSpeedMetrics.topologyViolations}));
`);
  const result = execFileSync("node", [testPath], { cwd: temp, encoding: "utf8", timeout: 30000 }).trim();
  console.log(`Topology QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Topology QA ไม่ผ่าน");
  if (error?.stdout) console.error(String(error.stdout));
  if (error?.stderr) console.error(String(error.stderr));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
