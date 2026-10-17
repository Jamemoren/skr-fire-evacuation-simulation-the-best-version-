import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
const temp = mkdtempSync(join(tmpdir(), "skr-survival-"));
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

  const testPath = join(temp, "qa-survival-guard.cjs");
  writeFileSync(testPath, `
const { EvacuationRuntime } = require('./simulation/runtime.js');
const { pointRisk, fireRadiusAt, walkY } = require('./simulation/graph.js');
const { flameCellsAt, cellContactRadius, bodySegmentTouchesFlame } = require('./simulation/fireField.js');
const assert = require('node:assert/strict');
const config = {
  populationTarget: 8,
  preset: 'safest', walkingSpeed: 3.2,
  responseDelayMin: 0, responseDelayMax: 0, rerouteInterval: 0.4,
  distanceWeight: 0.28, timeWeight: 1, congestionWeight: 20,
  fireWeight: 5600, smokeWeight: 1700, fireSpreadEnabled: false,
  crowdBehavior: 'grouped', ambientTemperatureC: 29,
  heatAvoidThresholdC: 42, hardBlockTemperatureC: 60,
  thermalLookAheadEdges: 12, thermalWeight: 3000,
};
const runtime = new EvacuationRuntime();
runtime.start(config);
const victim = runtime.getAgentSnapshots()[0];
runtime.addFire([...victim.position], { fireRadius: 1.15, smokeRadius: 2.6, spreadRate: 0, intensity: 1 });
for (let i = 0; i < 260; i++) runtime.step(0.05);
const metrics = runtime.getMetrics();
const after = runtime.getAgentSnapshots().find(a => a.id === victim.id);
const contact = after ? pointRisk(after.position, runtime.fires, runtime.time, 0.18).blocked : true;
const invalidCasualties = runtime.getAgentSnapshots().filter(a => a.status === 'incapacitated'
  && (!pointRisk(a.position, runtime.fires, runtime.time, 0.18).blocked || a.flameContactSeconds < 0.9));
if (invalidCasualties.length) throw new Error('casualty without sustained body contact: ' + JSON.stringify(invalidCasualties));
if (after?.status !== 'incapacitated' && contact) throw new Error('emergency escape failed to move victim out of the flame envelope: ' + JSON.stringify(after));
console.log(JSON.stringify({victim: victim.id, status: after?.status, health: after?.health, flameContactSeconds: after?.flameContactSeconds, incapacitated: metrics.incapacitated, blocked: metrics.blocked, contact}));

const y = walkY(2);
const source = { id:'visible-origin',position:[-40,y+.05,1.86],startTime:0,intensity:1,fireRadius:3.2,smokeRadius:12,spreadRate:.028,enabled:true,floor:2,wing:'pink',origin:'primary',generation:0,hasSpread:false };
assert.equal(pointRisk([-38.8,y,1.86],[source],0,.18).blocked,false,'old invisible mature sphere still injures outside the seed flame');
assert.ok(fireRadiusAt(source,1)<fireRadiusAt(source,10) && fireRadiusAt(source,10)<fireRadiusAt(source,40),'fire must grow continuously');
for(const time of [0,.1,1,10,40]) for(const cell of flameCellsAt(source,time)) {
  assert.ok(cellContactRadius(cell,cell.position[1])<=cell.radius*.72,'contact extends outside the visible base');
  assert.equal(cellContactRadius(cell,cell.position[1]+cell.height*.9),-1,'contact extends above shortest flickering flame');
}
const front = {...source,id:'visible-front',origin:'spread',position:[-32,y+.05,1.86],startTime:40,spreadTravelStartTime:0,fireRadius:.72,spreadPath:[[-40,y+.05,1.86],[-32,y+.05,1.86]]};
assert.ok(flameCellsAt(front,10).every(c=>c.position[0]<=-38+1e-6),'front jumped ahead of its travel distance');
assert.equal(pointRisk([-39,y,1.86],[front],10,.18).blocked,true,'visible travelling flame is harmless');
assert.equal(pointRisk([-32,y,1.86],[front],10,.18).blocked,false,'unreached destination harms NPC');
assert.equal(pointRisk([-39,y,1.86],[front],50,.18).blocked,true,'burning trail vanished when target ignited');
assert.equal(bodySegmentTouchesFlame([-39,y,1.0],[-39,y,2.7],[front],10,.18),true,'swept collision missed the travelling front');
assert.equal(pointRisk([-39,y+3.5,1.86],[front],10,.18).blocked,false,'front harms occupants through a slab');
const early = new EvacuationRuntime(); early.start({...config,populationTarget:1,walkingSpeed:.01,responseDelayMin:60,responseDelayMax:60});
const earlyAgent=early.getAgentSnapshots()[0];
early.addFire([earlyAgent.position[0]+1.2,earlyAgent.position[1],earlyAgent.position[2]],{fireRadius:3.2,smokeRadius:20});
for(let i=0;i<20;i++)early.step(.05);
const earlyAfter=early.getAgentSnapshots()[0];
assert.equal(earlyAfter.health,1,'NPC lost health before visible flame arrived');
assert.equal(earlyAfter.flameContactSeconds,0,'NPC accumulated contact in empty space');
for(const visual of early.getFireVisuals()) assert.deepEqual(visual.flameCells,flameCellsAt(early.fires.find(f=>f.id===visual.id),early.time),'render snapshot differs from collision field');
console.log('Visible flame parity: seed growth, moving front, persistent trail, body contact, floor isolation and smoke-only survival passed');

`);
  const result = execFileSync("node", [testPath], { cwd: temp, encoding: "utf8", timeout: 90000 }).trim();
  console.log(`Direct Flame Contact QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Direct Flame Contact QA ไม่ผ่าน");
  console.error(error?.stderr?.toString?.() || error?.message || error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
