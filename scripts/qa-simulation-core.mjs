import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-core-"));
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

  const testPath = join(temp, "qa.cjs");
  writeFileSync(testPath, `
const { createEvacuationGraph, allocatePopulation, pointRisk, fireRadiusAt, smokeRadiusAt, routeIsPhysicallyValid, traversalPoints, FIELD_GATE_POSITION, walkY } = require('./simulation/graph.js');
const { pointClearsExteriorBuilding, pointClearsCentralLiftBank } = require('./simulation/walkable.js');
const { EvacuationRuntime } = require('./simulation/runtime.js');
const config = { populationTarget:3000, preset:'balanced', walkingSpeed:1.32, responseDelayMin:0, responseDelayMax:1, rerouteInterval:1, distanceWeight:.28, timeWeight:1, congestionWeight:20, fireWeight:4200, smokeWeight:1250 };
const graph = createEvacuationGraph();
const graphNodeMap = new Map(graph.nodes.map(node => [node.id, node]));
const isolatedFloorFire = {
  id:'qa-floor-fire', position:[2.75, walkY(5) + 0.25, -0.5], startTime:0, intensity:1,
  fireRadius:3.2, smokeRadius:8.5, spreadRate:0, enabled:true, floor:5, wing:'core',
  origin:'primary', generation:0, hasSpread:false,
};
const sameFloorRisk = pointRisk([2.75, walkY(5) + 0.25, -0.5], [isolatedFloorFire], 10);
const upperFloorRisk = pointRisk([2.75, walkY(6) + 0.25, -0.5], [isolatedFloorFire], 10);
const lowerFloorRisk = pointRisk([2.75, walkY(4) + 0.25, -0.5], [isolatedFloorFire], 10);
if (!sameFloorRisk.blocked || sameFloorRisk.fire <= 0 || sameFloorRisk.smoke <= 0 || sameFloorRisk.heat <= 0) throw new Error('Same-floor fire no longer produces a physical hazard');
for (const [label, risk] of [['upper', upperFloorRisk], ['lower', lowerFloorRisk]]) {
  if (risk.blocked || risk.fire !== 0 || risk.smoke !== 0 || risk.heat !== 0) throw new Error(label + ' floor received hazard through concrete slab: ' + JSON.stringify(risk));
}

const verticalSpreadRuntime = new EvacuationRuntime();
verticalSpreadRuntime.start({ ...config, populationTarget:600 });
verticalSpreadRuntime.addFire([2.75, walkY(5) + 0.25, -0.5], { fireRadius:1.2, smokeRadius:3.4, spreadRate:.02 });
for (let i=0;i<100;i++) verticalSpreadRuntime.step(1);
const spreadFloors = new Set(verticalSpreadRuntime.fires.filter(fire => fire.origin === 'spread').map(fire => fire.floor));
if (!spreadFloors.has(4) || !spreadFloors.has(6)) throw new Error('Expected shaft spread to both adjacent floors: ' + JSON.stringify({floors:[...spreadFloors],time:verticalSpreadRuntime.time,completed:verticalSpreadRuntime.completed,attachments:verticalSpreadRuntime.fires.map(f=>({node:f.attachmentNodeId,start:f.startTime}))}));
const spreadFires = verticalSpreadRuntime.fires.filter(fire => fire.origin === 'spread');
const burningAttachmentIds = spreadFires.map(fire => fire.attachmentNodeId).filter(Boolean);
if (new Set(burningAttachmentIds).size !== burningAttachmentIds.length) throw new Error('Multiple spread fires occupied the same physical school object');
for (const fire of spreadFires) {
  const parent = verticalSpreadRuntime.fires.find(candidate => candidate.id === fire.parentId);
  if (!parent?.attachmentNodeId || !fire.attachmentNodeId || !fire.attachmentKind) throw new Error('Spread fire is not attached to a physical school object: ' + JSON.stringify(fire));
  const connected = graph.edges.some(edge => edge.insideBuilding && ((edge.from === parent.attachmentNodeId && edge.to === fire.attachmentNodeId) || (edge.to === parent.attachmentNodeId && edge.from === fire.attachmentNodeId)));
  if (!connected) throw new Error('Fire crossed a wall instead of a connected object edge: ' + parent.attachmentNodeId + ' -> ' + fire.attachmentNodeId);
  if (!Array.isArray(fire.spreadPath) || fire.spreadPath.length < 2 || fire.spreadTravelStartTime == null || fire.startTime <= fire.spreadTravelStartTime) {
    throw new Error('Spread fire teleported instead of travelling along a physical edge: ' + JSON.stringify(fire));
  }
  const pathStart = fire.spreadPath[0];
  const pathEnd = fire.spreadPath[fire.spreadPath.length - 1];
  const startGap = Math.hypot(pathStart[0] - parent.position[0], pathStart[1] - parent.position[1], pathStart[2] - parent.position[2]);
  const endGap = Math.hypot(pathEnd[0] - fire.position[0], pathEnd[1] - fire.position[1], pathEnd[2] - fire.position[2]);
  if (startGap > 0.05 || endGap > 0.05) throw new Error('Spread path is detached from its parent or target: ' + JSON.stringify({ startGap, endGap, fire }));
  const beforeArrival = fire.spreadTravelStartTime + (fire.startTime - fire.spreadTravelStartTime) * 0.5;
  // Smoke and heat may arrive ahead of the visible flame; they never cause injury.
  const prematureRisk = pointRisk(fire.position, [fire], beforeArrival);
  if (prematureRisk.blocked) {
    throw new Error('Travelling fire front harmed an occupant before reaching the target: ' + JSON.stringify({ fire, prematureRisk }));
  }
}
if (fireRadiusAt(isolatedFloorFire, 10000) > isolatedFloorFire.fireRadius + 1e-6) throw new Error('Local flame envelope still expands without bound');
if (smokeRadiusAt(isolatedFloorFire, 10000) > isolatedFloorFire.smokeRadius + 1e-6) throw new Error('Local smoke envelope still expands without bound');

const casualtyRuntime = new EvacuationRuntime();
casualtyRuntime.start({ ...config, populationTarget:600, responseDelayMin:60, responseDelayMax:60, fireSpreadEnabled:false });
const sameFloorVictim = casualtyRuntime.getAgentSnapshots().find(agent => agent.floor === 5);
if (!sameFloorVictim) throw new Error('Missing floor-5 occupant for casualty isolation QA');
// Keep this person well outside the flame envelope but inside a deliberately broad local
// smoke/thermal envelope, so the test cannot confuse remote exposure with flame contact.
casualtyRuntime.addFire([sameFloorVictim.position[0] + 4.5, sameFloorVictim.position[1], sameFloorVictim.position[2]], { fireRadius:2.4, smokeRadius:12, spreadRate:0, startTime:-90 });
let sensorySmoke = false, sensoryVisibility = false, sensoryHeat = false;
for (let i=0;i<100;i++) {
  casualtyRuntime.step(1);
  const person = casualtyRuntime.getAgentSnapshots().find(agent => agent.id === sameFloorVictim.id);
  sensorySmoke ||= ['smelled','visible'].includes(person.smokeAwareness);
  sensoryVisibility ||= person.visibility < .99;
  sensoryHeat ||= ['sensed','painful'].includes(person.heatAwareness);
}
const smokeOnlyVictim = casualtyRuntime.getAgentSnapshots().find(agent => agent.id === sameFloorVictim.id);
if (!smokeOnlyVictim || smokeOnlyVictim.smokeDose <= 0 || smokeOnlyVictim.heatDose <= 0) throw new Error('Smoke/thermal exposure did not accumulate for the isolated victim: ' + JSON.stringify(smokeOnlyVictim));
if (!sensorySmoke || !sensoryVisibility || !sensoryHeat) throw new Error('Known local smoke/heat fixture did not activate sensory perception: ' + JSON.stringify({sensorySmoke,sensoryVisibility,sensoryHeat}));
if (smokeOnlyVictim.status === 'incapacitated' || smokeOnlyVictim.health < 0.999 || smokeOnlyVictim.flameContactSeconds !== 0) throw new Error('Smoke or radiant heat incapacitated an agent without direct flame contact: ' + JSON.stringify(smokeOnlyVictim));
casualtyRuntime.addFire(smokeOnlyVictim.position, { fireRadius:3.2, smokeRadius:8.5, spreadRate:0 });
for (let i=0;i<3;i++) casualtyRuntime.step(1);
const casualtyMetrics = casualtyRuntime.getMetrics();
const casualtyFloors = new Set(casualtyRuntime.getAgentSnapshots().filter(agent => agent.status === 'incapacitated').map(agent => agent.floor));
const directContactVictim = casualtyRuntime.getAgentSnapshots().find(agent => agent.id === sameFloorVictim.id);
if (directContactVictim?.status === 'incapacitated'
  && (!pointRisk(directContactVictim.position, casualtyRuntime.fires, casualtyRuntime.time, 0.18).blocked || directContactVictim.flameContactSeconds < 0.9)) throw new Error('Casualty without sustained flame contact: ' + JSON.stringify(directContactVictim));
if ([...casualtyFloors].some(floor => floor !== 5)) throw new Error('Fire incapacitated occupants on a different floor: ' + JSON.stringify([...casualtyFloors]));
if (FIELD_GATE_POSITION[2] <= 60.5) throw new Error('Assembly gate still overlaps the blue end tower footprint');
for (const edge of graph.edges.filter(edge => edge.kind === 'outdoor' || (edge.kind === 'exit' && !edge.insideBuilding))) {
  const points = traversalPoints(edge, graphNodeMap, edge.from, edge.to);
  for (let segment=1; segment<points.length; segment++) {
    const a = points[segment-1], b = points[segment];
    for (let sample=0; sample<=20; sample++) {
      const t = sample/20;
      const point = [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
      if (!pointClearsExteriorBuilding(point)) throw new Error('Exterior route enters solid tower footprint: ' + edge.id + ' at ' + JSON.stringify(point));
    }
  }
}
for (const edge of graph.edges.filter(edge => edge.insideBuilding && edge.kind !== 'room')) {
  const points = traversalPoints(edge, graphNodeMap, edge.from, edge.to);
  for (let segment=1; segment<points.length; segment++) {
    const a = points[segment-1], b = points[segment];
    for (let sample=0; sample<=16; sample++) {
      const t = sample/16;
      const point = [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
      if (!pointClearsCentralLiftBank(point)) throw new Error('Indoor route intersects central lift bank: ' + edge.id + ' at ' + JSON.stringify(point));
    }
  }
}
const allocation = allocatePopulation(graph, config, [], 0);
const assigned = allocation.bundles.reduce((sum, bundle) => sum + bundle.peopleCount, 0);
if (assigned !== 3000) throw new Error('Population allocation expected 3000, got ' + assigned);
if (allocation.bundles.some(bundle => !routeIsPhysicallyValid(graph, bundle.path))) throw new Error('Allocator returned a route that leaves a physical door/corridor/stair envelope');
for (const zone of ['a','b','c','d','e','f']) {
  const count = allocation.zoneLoads.get('sim-zone-' + zone) || 0;
  if (count !== 500) throw new Error('Zone ' + zone + ' expected 500, got ' + count);
}

const baseline = new EvacuationRuntime();
baseline.start(config);
const gendersByRoom = new Map();
for (const agent of baseline.getAgentSnapshots()) {
  const genders = gendersByRoom.get(agent.roomId) || new Set();
  genders.add(agent.gender);
  gendersByRoom.set(agent.roomId, genders);
}
if ([...gendersByRoom.values()].some(genders => !genders.has('male') || !genders.has('female'))) throw new Error('Expected mixed male/female students in every occupied room');
for (let i=0;i<120;i++) baseline.step(.2);
let base = baseline.getMetrics();
if (base.topologyViolations !== 0) throw new Error('Baseline topology violations: ' + base.topologyViolations);
if (base.collisionCorrections !== 0) throw new Error('Baseline wall collision corrections: ' + base.collisionCorrections);
const activeBaseline = baseline.getAgentSnapshots().filter(agent => agent.status === 'evacuating' || agent.status === 'queueing' || agent.status === 'rerouting');
const occupiedPositions = new Map();
for (const agent of activeBaseline) {
  const key = agent.position.map(value => value.toFixed(3)).join(':');
  occupiedPositions.set(key, (occupiedPositions.get(key) || 0) + 1);
}
const exactActiveOverlaps = [...occupiedPositions.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
if (exactActiveOverlaps > 0) throw new Error('Active students share the exact same position: ' + exactActiveOverlaps);

const groupedRuntime = new EvacuationRuntime();
groupedRuntime.start({ ...config, populationTarget:600, crowdBehavior:'grouped' });
for (let i=0;i<180;i++) groupedRuntime.step(.25);
const groupedMetrics = groupedRuntime.getMetrics();
if (groupedMetrics.topologyViolations !== 0 || groupedMetrics.collisionCorrections !== 0) throw new Error('Grouped crowd left physical walkways: ' + JSON.stringify({ topology:groupedMetrics.topologyViolations, collisions:groupedMetrics.collisionCorrections }));

const surgeRuntime = new EvacuationRuntime();
surgeRuntime.start({ ...config, populationTarget:400, crowdBehavior:'surge' });
for (let i=0;i<140;i++) surgeRuntime.step(.25);
const surgeMetrics = surgeRuntime.getMetrics();
if (surgeMetrics.topologyViolations !== 0 || surgeMetrics.collisionCorrections !== 0) throw new Error('Surge crowd left physical walkways: ' + JSON.stringify({ topology:surgeMetrics.topologyViolations, collisions:surgeMetrics.collisionCorrections }));

const runtime = new EvacuationRuntime();
runtime.start(config);
for (let i=0;i<20;i++) runtime.step(1);
runtime.addPresetFire('center');
if (runtime.getAgentSnapshots().some(a => a.knownFireCount !== 0)) throw new Error('Agents received omniscient fire location at ignition time');
let everSmokeSensed = 0, everLowVisibility = 0, everHeatSensed = 0;
for (let i=0;i<20;i++) {
  runtime.step(1);
  const snapshots = runtime.getAgentSnapshots();
  everSmokeSensed = Math.max(everSmokeSensed,snapshots.filter(a=>a.smokeAwareness==='smelled' || a.smokeAwareness==='visible').length);
  everLowVisibility = Math.max(everLowVisibility,snapshots.filter(a=>a.visibility<.99).length);
  everHeatSensed = Math.max(everHeatSensed,snapshots.filter(a=>a.heatAwareness==='sensed' || a.heatAwareness==='painful').length);
}
const locallyAware = runtime.getAgentSnapshots().filter(a => a.knownFireCount > 0).length;
if (locallyAware <= 0) throw new Error('No nearby agent perceived the center fire');
if (locallyAware >= runtime.getAgentSnapshots().length) throw new Error('All agents became omniscient instead of local awareness');
const directAware = runtime.getAgentSnapshots().filter(a => a.hazardAwareness === 'direct').length;
const reportedAware = runtime.getAgentSnapshots().filter(a => a.hazardAwareness === 'reported').length;
const smokeHazardAware = runtime.getAgentSnapshots().filter(a => a.hazardAwareness === 'smoke').length;
const heatHazardAware = runtime.getAgentSnapshots().filter(a => a.hazardAwareness === 'heat').length;
const smokeAware = runtime.getAgentSnapshots().filter(a => a.smokeAwareness !== 'none').length;
const smokeSensed = runtime.getAgentSnapshots().filter(a => a.smokeAwareness === 'smelled' || a.smokeAwareness === 'visible').length;
const lowVisibility = runtime.getAgentSnapshots().filter(a => a.visibility < 0.99).length;
const heatAware = runtime.getAgentSnapshots().filter(a => a.heatAwareness !== 'none').length;
const heatSensed = runtime.getAgentSnapshots().filter(a => a.heatAwareness === 'sensed' || a.heatAwareness === 'painful').length;
const stressed = runtime.getAgentSnapshots().filter(a => a.stress > 0.01).length;
if (directAware + smokeHazardAware + heatHazardAware <= 0 || reportedAware <= 0) throw new Error('Expected both sensory and reported human hazard awareness: ' + JSON.stringify({ directAware, smokeHazardAware, heatHazardAware, reportedAware }));
if (smokeAware <= 0 || smokeAware >= runtime.getAgentSnapshots().length) throw new Error('Smoke awareness must be local, not absent or omniscient: ' + smokeAware);
// Direct sensory activation is asserted above while a known person is exposed inside the
// smoke envelope. A moving crowd can avoid that envelope before this later snapshot.
if (heatAware <= 0) throw new Error('Heat warning knowledge did not propagate');
if (stressed <= 0) throw new Error('Human stress response did not activate near fire/smoke');
for (let i=0;i<340;i++) runtime.step(1);
const fire = runtime.getMetrics();
if (fire.rerouteCount <= 0) throw new Error('Expected dynamic rerouting after center fire');
if (fire.topologyViolations !== 0) throw new Error('Fire topology violations: ' + fire.topologyViolations);
if (fire.collisionCorrections !== 0) throw new Error('Fire wall collision corrections: ' + fire.collisionCorrections + ' ' + JSON.stringify(runtime.getCollisionCorrectionSamples()));
const invalidExterior = runtime.getAgentSnapshots().filter(a => (a.phase === 'outdoor' || a.phase === 'assembly' || a.status === 'arrived') && !a.hasExitedBuilding).length;
if (invalidExterior > 0) throw new Error('Agents reached exterior without a physical exit portal: ' + invalidExterior);
const invalidRoomExit = runtime.getAgentSnapshots().filter(a => a.phase !== 'room' && !a.hasPassedRoomDoor).length;
if (invalidRoomExit > 0) throw new Error('Agents left a classroom without its physical door: ' + invalidRoomExit);
const invalidIncapacitations = runtime.getAgentSnapshots().filter(a => a.status === 'incapacitated'
  && (!pointRisk(a.position, runtime.fires, runtime.time, 0.18).blocked || a.flameContactSeconds < 0.9));
if (invalidIncapacitations.length > 0) throw new Error('Casualty without sustained flame contact: ' + JSON.stringify(invalidIncapacitations.slice(0, 3)));
if (reportedAware <= directAware + smokeHazardAware + heatHazardAware) throw new Error('Progressive human warning network did not spread beyond direct sensory detections');
const contacts = runtime.getAgentSnapshots().filter(a => pointRisk(a.position, runtime.fires, runtime.time).blocked && a.status !== 'blocked' && a.status !== 'incapacitated').length;
if (contacts > 0) throw new Error('Moving agents inside active fire radius: ' + contacts);
console.log(JSON.stringify({assigned, zones:Object.fromEntries(allocation.zoneLoads), mixedGenderRooms:gendersByRoom.size, floorIsolation:true, verticalSpreadFloors:[...spreadFloors].sort(), isolatedCasualties:casualtyMetrics.incapacitated, casualtyFloors:[...casualtyFloors], baselineActive:activeBaseline.length, exactActiveOverlaps, locallyAware, directAware, smokeHazardAware, heatHazardAware, reportedAware, smokeAware, smokeSensed, heatAware, heatSensed, lowVisibility, stressed, invalidExterior, invalidRoomExit, incapacitated:fire.incapacitated, groupedCollisionCorrections:groupedMetrics.collisionCorrections, surgeCollisionCorrections:surgeMetrics.collisionCorrections, baselineQueue:base.queueing, fireReroutes:fire.rerouteCount, blockedSafeStops:fire.blocked, smokeExposure:fire.exposedToSmoke, heatExposure:fire.exposedToHeat, collisionCorrections:fire.collisionCorrections, topologyViolations:fire.topologyViolations, peakEdgeDensity:fire.peakEdgeDensity}));
`);
  const result = execFileSync("node", [testPath], { cwd: temp, encoding: "utf8", timeout: 180000 }).trim();
  console.log(`Simulation Core QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Simulation Core QA ไม่ผ่าน");
  if (error?.stdout) console.error(String(error.stdout));
  if (error?.stderr) console.error(String(error.stderr));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
