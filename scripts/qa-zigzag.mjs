import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-zigzag-"));
try {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"),
    "--outDir", temp, "--target", "ES2020", "--module", "CommonJS", "--moduleResolution", "Node",
    "--skipLibCheck", resolve(root, "src/simulation/runtime.ts"),
  ], { cwd: root, stdio: "pipe", timeout: 60000 });
  const script = join(temp, "zigzag.cjs");
  writeFileSync(script, `
const assert = require('node:assert/strict');
const { planFireDetour, segmentInsideWalkway } = require('./simulation/localNavigation.js');
const { pointRisk, segmentTouchesFlame, walkY, edgeRiskSnapshot, findPath, traversalPoints } = require('./simulation/graph.js');
const { PEDESTRIAN_RADIUS } = require('./simulation/walkable.js');
const { EvacuationRuntime } = require('./simulation/runtime.js');
const y = walkY(2);
const path = [[-40,y,1.86],[-28,y,1.86]];
const edge = {id:'zigzag-corridor',from:'a',to:'b',kind:'corridor',distance:12,width:3.2,capacityPerSecond:8,speedMultiplier:1,twoWay:true,insideBuilding:true,floorFrom:2,floorTo:2};
const fireAt = (id,position,radius=1.1) => ({id,position,fireRadius:radius,smokeRadius:4,spreadRate:0,startTime:0,enabled:true,floor:2,wing:'pink',origin:'primary',generation:0,hasSpread:false,intensity:1});
const fires = [fireAt('left',[-36,y,2.58]),fireAt('right',[-32,y,1.14])];
const plan = (sources) => planFireDetour(path,edge,{
  riskAt:p=>pointRisk(p,sources,100,0.26),
  segmentBlocked:(a,b)=>segmentTouchesFlame(a,b,sources,100,0.26),
});
const route = plan(fires);
assert.ok(route,'staggered fires must leave a connected zigzag');
assert.ok(route.some(p=>p[2]<1.2) && route.some(p=>p[2]>2.52),'route must alternate sides');
for(let i=1;i<route.length;i++) {
  assert.ok(segmentInsideWalkway(route[i-1],route[i],path,edge),'detour crossed a wall');
  assert.ok(!segmentTouchesFlame(route[i-1],route[i],fires,100,0.26),'detour cut through fire');
}
const wall = [fireAt('wall',[-34,y,1.86],1.85)];
assert.equal(plan(wall),null,'full-width fire must not be crossed');
const graph = {nodes:[{id:'a',position:path[0]},{id:'b',position:path[1]}],edges:[edge]};
assert.equal(edgeRiskSnapshot(graph,edge.id,fires,100).blocked,false,'graph rejected a feasible zigzag');
assert.equal(edgeRiskSnapshot(graph,edge.id,wall,100).blocked,true,'graph ignored a short full-width obstruction');
const tinyFire = [fireAt('tiny',[-34,y,1.86],0.12)];
assert.equal(pointRisk(path[0],tinyFire,100).blocked,false);
assert.equal(pointRisk(path[1],tinyFire,100).blocked,false);
assert.equal(segmentTouchesFlame(path[0],path[1],tinyFire,100),true,'swept collision missed fire between endpoints');
assert.equal(segmentTouchesFlame(path[0],path[1],tinyFire.map(f=>({...f,floor:3})),100),false,'fire crossed a concrete floor');

const runtime = new EvacuationRuntime();
runtime.start({populationTarget:1,walkingSpeed:2,responseDelayMin:0,responseDelayMax:0,fireSpreadEnabled:false});
runtime.time = 100;
const liveEdge = runtime.graph.edges.find(e=>e.kind==='corridor' && !e.id.includes('door') && e.floorFrom===2 && e.id.includes('pink'));
const nodes = new Map(runtime.graph.nodes.map(n=>[n.id,n]));
const livePath = traversalPoints(liveEdge,nodes,liveEdge.from,liveEdge.to);
const start = livePath[0], end = livePath[livePath.length-1];
const tail = findPath(runtime.graph,liveEdge.to,runtime.graph.nodes.filter(n=>n.type==='assembly').map(n=>n.id),runtime.config,[],100,new Map(),new Set([liveEdge.id]));
assert.ok(tail);
const agent = runtime.agents[0];
Object.assign(agent,{position:[...start],floor:2,wing:'pink',phase:'corridor',currentNodeId:liveEdge.from,hasPassedRoomDoor:true,
  route:{...tail,nodeIds:[liveEdge.from,...tail.nodeIds],edgeIds:[liveEdge.id,...tail.edgeIds]},edgeIndex:0,
  edgeEntered:true,edgePath:livePath,segmentIndex:0,segmentProgress:0,responseDelay:0,status:'evacuating',speed:2});
const dx=end[0]-start[0], dz=end[2]-start[2], len=Math.hypot(dx,dz);
const nx=-dz/len,nz=dx/len;
runtime.fires=[0.32,0.68].map((t,i)=>fireAt('live-'+i,[start[0]+dx*t+nx*(i?-.72:.72),y,start[2]+dz*t+nz*(i?-.72:.72)],1.0));
let minSide=Infinity,maxSide=-Infinity;
for(let i=0;i<900 && agent.edgeIndex===0;i++) {
  const previous=[...agent.position];
  runtime.step(.05);
  const side=(agent.position[0]-start[0])*nx+(agent.position[2]-start[2])*nz;
  minSide=Math.min(minSide,side);maxSide=Math.max(maxSide,side);
  assert.ok(!segmentTouchesFlame(previous,agent.position,runtime.fires,runtime.time,PEDESTRIAN_RADIUS),'runtime crossed flame');
  assert.ok(Math.hypot(...agent.position.map((v,j)=>v-previous[j]))<.25,'runtime teleported');
  assert.equal(agent.status==='incapacitated',false,'flame-free NPC collapsed');
  assert.equal(agent.health,1,'smoke or heat reduced health without contact');
}
assert.ok(agent.edgeIndex>0,'NPC failed to traverse a corridor with a feasible zigzag');
assert.ok(minSide<-.45 && maxSide>.45,'runtime failed to alternate sides');

const nodeRuntime = new EvacuationRuntime();
nodeRuntime.start({populationTarget:1,walkingSpeed:2,responseDelayMin:0,responseDelayMax:0,fireSpreadEnabled:false});
nodeRuntime.time=100;
const nodeAgent=nodeRuntime.agents[0];
Object.assign(nodeAgent,{position:[...start],floor:2,wing:'pink',phase:'corridor',currentNodeId:liveEdge.from,hasPassedRoomDoor:true,
  route:{...tail,nodeIds:[liveEdge.from,...tail.nodeIds],edgeIds:[liveEdge.id,...tail.edgeIds]},edgeIndex:0,
  edgeEntered:true,edgePath:livePath,segmentIndex:0,segmentProgress:0,responseDelay:0,status:'evacuating',speed:2});
nodeRuntime.fires=[fireAt('burning-node',[...end],.75)];
for(let i=0;i<1200 && nodeAgent.edgeIndex<2;i++) {
  const previous=[...nodeAgent.position];nodeRuntime.step(.05);
  assert.ok(!segmentTouchesFlame(previous,nodeAgent.position,nodeRuntime.fires,nodeRuntime.time),'node transition crossed fire');
  assert.equal(nodeAgent.health,1,'burning centerline node harmed a pedestrian passing to its side');
}
assert.ok(nodeAgent.edgeIndex>=2,'NPC was forced back to a burning graph-node center');

const blockedRuntime = new EvacuationRuntime();
blockedRuntime.start({populationTarget:1,walkingSpeed:2,responseDelayMin:0,responseDelayMax:0,fireSpreadEnabled:false});
blockedRuntime.time=100;
const stopped=blockedRuntime.agents[0];
Object.assign(stopped,{position:[...start],floor:2,wing:'pink',phase:'corridor',currentNodeId:liveEdge.from,hasPassedRoomDoor:true,
  route:{...tail,nodeIds:[liveEdge.from,...tail.nodeIds],edgeIds:[liveEdge.id,...tail.edgeIds]},edgeIndex:0,
  edgeEntered:true,edgePath:livePath,segmentIndex:0,segmentProgress:0,responseDelay:0,status:'evacuating',speed:2});
blockedRuntime.fires=[fireAt('full-block',[start[0]+dx*.5,y,start[2]+dz*.5],1.85)];
for(let i=0;i<240;i++) {
  const previous=[...stopped.position];blockedRuntime.step(.05);
  assert.ok(!segmentTouchesFlame(previous,stopped.position,blockedRuntime.fires,blockedRuntime.time),'blocked NPC walked through fire');
  assert.notEqual(stopped.status,'incapacitated','blocked NPC collapsed before flame contact');
  assert.equal(stopped.health,1);
}
assert.ok(stopped.smokeDose>0,'full-block fixture did not exercise smoke exposure');

const interrupted = new EvacuationRuntime();
interrupted.start({populationTarget:1,walkingSpeed:.01,responseDelayMin:60,responseDelayMax:60,fireSpreadEnabled:false});
const brieflyExposed=interrupted.agents[0];
const contactFire=fireAt('brief-contact',[...brieflyExposed.position],3);contactFire.floor=brieflyExposed.floor;
interrupted.fires=[contactFire];
for(let i=0;i<4;i++) interrupted.step(.1);
assert.ok(brieflyExposed.flameContactSeconds>0 && brieflyExposed.flameContactSeconds<.9);
interrupted.clearFires();interrupted.step(.03);
assert.equal(brieflyExposed.flameContactSeconds,0,'safe position retained an old contact timer');
assert.equal(brieflyExposed.health,1,'old contact caused off-fire injury');
interrupted.fires=[{...contactFire,position:[...brieflyExposed.position]}];
for(let i=0;i<5;i++) interrupted.step(.1);
assert.notEqual(brieflyExposed.status,'incapacitated','separate brief contacts accumulated into a casualty');

const trapped = new EvacuationRuntime();
trapped.start({populationTarget:1,walkingSpeed:.01,responseDelayMin:60,responseDelayMax:60,fireSpreadEnabled:false});
const victim=trapped.agents[0];
trapped.fires=[fireAt('contact',[...victim.position],3)];trapped.fires[0].floor=victim.floor;
for(let i=0;i<40 && victim.status!=='incapacitated';i++) trapped.step(.05);
assert.equal(victim.status,'incapacitated','sustained direct contact was ignored');
assert.ok(victim.flameContactSeconds>=.9);
assert.ok(pointRisk(victim.position,trapped.fires,trapped.time,PEDESTRIAN_RADIUS).blocked,'casualty occurred without body contact');
console.log(JSON.stringify({zigzagWaypoints:route.length,fullBlock:true,sweptCollision:true,runtimeCrossed:true,minSide,maxSide,burningNodePassed:true,blockedNpcSurvived:true,contactOnly:true}));
`);
  console.log(execFileSync(process.execPath, [script], { cwd: temp, encoding: "utf8", timeout: 90000 }).trim());
} catch (error) {
  console.error(error?.stderr?.toString() || error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
