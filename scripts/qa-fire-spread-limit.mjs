import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-fire-limit-"));
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
  ], { cwd: root, stdio: "pipe", timeout: 90000 });

  const testPath = join(temp, "qa-fire-spread-limit.cjs");
  writeFileSync(testPath, `
const { EvacuationRuntime } = require('./simulation/runtime.js');
const { traversalPoints } = require('./simulation/graph.js');
const config = {
  populationTarget: 80,
  preset: 'safest', walkingSpeed: 1.8,
  responseDelayMin: 0, responseDelayMax: 0, rerouteInterval: 0.6,
  distanceWeight: 0.28, timeWeight: 1, congestionWeight: 20,
  fireWeight: 5600, smokeWeight: 1700, fireSpreadEnabled: true,
  crowdBehavior: 'grouped', ambientTemperatureC: 29,
  heatAvoidThresholdC: 42, hardBlockTemperatureC: 60,
  thermalLookAheadEdges: 12, thermalWeight: 3000,
};
const runtime = new EvacuationRuntime();
runtime.start(config);
runtime.addPresetFire('center');
for (let i = 0; i < 560; i++) runtime.step(0.25);
const fires = runtime.fires;
const spread = fires.filter(f => f.origin === 'spread');
if (!spread.length) throw new Error('limited-spread model produced no propagated source');
if (fires.length > 16) throw new Error('fire patch cap exceeded: ' + fires.length);
const maxGeneration = Math.max(...fires.map(f => f.generation || 0));
if (maxGeneration > 12) throw new Error('fire generation cap exceeded: ' + maxGeneration);
const byId = new Map(fires.map(f => [f.id, f]));
let maxHorizontal = 0;
let maxVertical = 0;
let minTravelDuration = Infinity;
for (const fire of spread) {
  const path = fire.spreadPath || [];
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i][0]-path[i-1][0], path[i][1]-path[i-1][1], path[i][2]-path[i-1][2]);
  }
  const parent = fire.parentId ? byId.get(fire.parentId) : null;
  const vertical = parent && parent.floor !== fire.floor;
  if (vertical) maxVertical = Math.max(maxVertical, length);
  else maxHorizontal = Math.max(maxHorizontal, length);
  if (!vertical && length > 12.05) throw new Error('horizontal fire transfer too long: ' + length.toFixed(3));
  if (vertical) {
    const separation = Math.hypot(...fire.position.map((value,index)=>value-parent.position[index]));
    if (separation > 11.55) throw new Error('adjacent stair objects too far apart: ' + separation.toFixed(3));
    if (Math.abs(parent.floor-fire.floor)!==1) throw new Error('fire skipped a concrete floor');
    const connection = runtime.graph.edges.find(edge=>edge.kind==='stair' &&
      ((edge.from===parent.attachmentNodeId && edge.to===fire.attachmentNodeId) || (edge.to===parent.attachmentNodeId && edge.from===fire.attachmentNodeId)));
    if (!connection) throw new Error('vertical fire lacks a physical stair connection');
    const nodes = new Map(runtime.graph.nodes.map(node=>[node.id,node]));
    const expected = traversalPoints({...connection,twoWay:true},nodes,parent.attachmentNodeId,fire.attachmentNodeId);
    const interior = expected.slice(1,-1);
    for (const point of interior) {
      if (!path.some(p=>Math.hypot(p[0]-point[0],p[1]-point[1]-.05,p[2]-point[2])<.04)) throw new Error('flame front skipped a stair tread or landing');
    }
  }
  if (fire.spreadTravelStartTime != null) {
    const duration = fire.startTime - fire.spreadTravelStartTime;
    minTravelDuration = Math.min(minTravelDuration, duration);
    if (duration < 5.95) throw new Error('fire front travels too fast: ' + duration.toFixed(3));
  }
}
console.log(JSON.stringify({
  totalFires: fires.length,
  spreadFires: spread.length,
  maxGeneration,
  maxHorizontalTransferM: +maxHorizontal.toFixed(2),
  maxVerticalTransferM: +maxVertical.toFixed(2),
  minTravelDurationS: +minTravelDuration.toFixed(2),
  simulationTimeS: runtime.time,
}));
`);
  const result = execFileSync("node", [testPath], { cwd: temp, encoding: "utf8", timeout: 120000 }).trim();
  console.log(`Limited Fire Spread QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Limited Fire Spread QA ไม่ผ่าน");
  console.error(error?.stderr?.toString?.() || error?.message || error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
