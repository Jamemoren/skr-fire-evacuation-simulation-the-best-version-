import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "skr-audit-"));
try {
  const files = ["simulation/runtime", "simulation/simulationStore", "simulation/studentGeometry", "simulation/studentVisibility",
    "simulation/studentAnimation", "simulation/studentMaterial", "rendering/frameClock",
    "rendering/instanceBuffers", "navigation/pointerPolicy", "navigation/walkSurface", "navigation/walkStore", "building1/building1Store"];
  const configPath = join(temp, "tsconfig.json");
  writeFileSync(configPath, JSON.stringify({ compilerOptions: { outDir: temp, rootDir: resolve(root, "src"),
    target: "ES2020", module: "CommonJS", moduleResolution: "Node", esModuleInterop: true, skipLibCheck: true,
    paths: { "three/addons/*": [resolve(root, "node_modules/@types/three/examples/jsm/*")] },
  }, files: files.map(file => resolve(root, `src/${file}.ts`)) }));
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--project", configPath],
    { cwd: root, stdio: "pipe", timeout: 180000 });
  const testPath = join(temp, "audit.cjs");
  writeFileSync(testPath, `
const assert = require('node:assert/strict');
const THREE = require('three');
const { uploadInstanceRange } = require('./rendering/instanceBuffers.js');
const { createStudentGeometry } = require('./simulation/studentGeometry.js');
const { AGENT_BODY_HEIGHT, flameCellsAt } = require('./simulation/fireField.js');
const { yOffsetForRender } = require('./simulation/studentVisibility.js');
const { canStartCameraLook } = require('./navigation/pointerPolicy.js');
const { canWalkAt } = require('./navigation/walkSurface.js');
const { createEvacuationGraph, edgeRiskSnapshot, findPath, routeIsPhysicallyValid, walkY } = require('./simulation/graph.js');
const { EvacuationRuntime, evacuationRuntime } = require('./simulation/runtime.js');
const { useEvacuationStore } = require('./simulation/simulationStore.js');
const { sampleStudentAnimation, advanceStudentAnimationClock, STUDENT_ANIMATION_PERIOD } = require('./simulation/studentAnimation.js');
const { attachStudentMotion, studentTransitionBuffers, uploadStudentMotion, STUDENT_INSTANCE_CAPACITY } = require('./simulation/studentMaterial.js');
const { activeFrameDelta } = require('./rendering/frameClock.js');
const { canEndPointerGesture, releasePointerCapture } = require('./navigation/pointerPolicy.js');
const { useWalkStore } = require('./navigation/walkStore.js');
const { useBuilding1Store } = require('./building1/building1Store.js');

for (const gender of ['male','female']) for (const compact of [false,true]) {
  const geometry = createStudentGeometry(gender,compact);
  const box = geometry.boundingBox;
  assert.ok(Math.abs(box.max.y - AGENT_BODY_HEIGHT)<1e-6,'Visible head must match contact height');
  assert.ok(Math.abs(walkY(3) + box.min.y - 7.24)<.01,'Feet must meet the finished floor');
  assert.ok(box.max.x < .3 && box.min.x > -.3,'Height correction must retain body width');
  const motion = attachStudentMotion(geometry), buffers = studentTransitionBuffers(geometry);
  for (const buffer of [motion,buffers.transition,buffers.blend]) {
    assert.equal(buffer.count,STUDENT_INSTANCE_CAPACITY);
    for (const count of [0,1,1500,STUDENT_INSTANCE_CAPACITY,0,2]) {
      const version = buffer.version;
      assert.equal(uploadStudentMotion(buffer,count),count*16);
      assert.equal(buffer.version,version+(count ? 1 : 0));
      assert.deepEqual(buffer.updateRanges,count ? [{start:0,count:count*4}] : []);
    }
  }
  geometry.dispose();
}
const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial(),200);
for (const count of [1,150,0,2,200,0]) {
  const version = mesh.instanceMatrix.version;
  for (let i=0;i<count;i++) mesh.setMatrixAt(i,new THREE.Matrix4().makeTranslation(i,2,3));
  const bytes = uploadInstanceRange(mesh,count);
  assert.equal(mesh.count,count); assert.equal(bytes,count*64);
  assert.equal(mesh.instanceMatrix.usage,THREE.DynamicDrawUsage);
  assert.equal(mesh.instanceMatrix.version,version+(count ? 1 : 0));
  assert.deepEqual(mesh.instanceMatrix.updateRanges,count ? [{start:0,count:count*16}] : []);
  if (count) { const m = new THREE.Matrix4(); mesh.getMatrixAt(count-1,m); assert.equal(m.elements[12],count-1); }
}
mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose();

assert.equal(canStartCameraLook('mouse',0),false);
assert.equal(canStartCameraLook('mouse',1),false);
assert.equal(canStartCameraLook('mouse',2),true);
assert.equal(canStartCameraLook('touch',0),true);
assert.equal(canStartCameraLook('pen',0),true);
assert.equal(canStartCameraLook('pen',2),false);
assert.equal(canWalkAt(-24,1.86,3),true);
assert.equal(canWalkAt(-24,-5,3),true);
assert.equal(canWalkAt(-26.25,.12,3),true,'Classroom doorway must remain open');
assert.equal(canWalkAt(-24,.12,3),false,'Window wall cannot be crossed');
assert.equal(canWalkAt(-24,7,3),false,'Do not walk off the balcony');
assert.equal(canWalkAt(-2.15,-7.9,3),false,'Lift shafts remain solid');

const graph = createEvacuationGraph();
const nodes = new Map(graph.nodes.map(n => [n.id,n]));
const edges = new Map(graph.edges.map(e => [e.id,e]));
const fire = {id:'audit',position:[-24,walkY(3)+.25,1.8],startTime:0,intensity:1,fireRadius:1.2,smokeRadius:3,
  spreadRate:.03,enabled:true,floor:3,wing:'pink',origin:'primary',generation:0,hasSpread:false};
let indexedChecks=0;
for (const time of [0,5,30]) for (const edge of graph.edges) {
  assert.deepEqual(edgeRiskSnapshot(graph,edge.id,[fire],time),edgeRiskSnapshot(graph,edge.id,[fire],time,nodes,edges));
  indexedChecks++;
}
const runtime = new EvacuationRuntime(); runtime.start({populationTarget:40}); runtime.pause();
for (const path of runtime.bundles.map(b => b.path)) {
  assert.equal(routeIsPhysicallyValid(runtime.graph,path),true);
  assert.equal(routeIsPhysicallyValid(runtime.graph,path,new Map(runtime.graph.nodes.map(n=>[n.id,n])),new Map(runtime.graph.edges.map(e=>[e.id,e]))),true);
}
const sampleArrivals=[9,2,7,3,18,1,6,11];
sampleArrivals.forEach((at,i)=>{ runtime.agents[i].arrivedAt=at; runtime.agents[i].status='arrived'; });
const metrics=runtime.getMetrics(); const sorted=[...sampleArrivals].sort((a,b)=>a-b);
for (const [key,p] of [['p50Arrival',.5],['p90Arrival',.9],['p95Arrival',.95]]) assert.equal(metrics[key],sorted[Math.ceil(p*sorted.length)-1]);
assert.equal(metrics.averageArrival,sampleArrivals.reduce((a,b)=>a+b,0)/sampleArrivals.length);

for (const floor of [0,1,2,5,9]) {
  const view={viewMode:'exterior',selectedFloor:9,explodeFloors:true};
  assert.equal(yOffsetForRender(floor,view),Math.max(0,floor-1)*1.1);
}
for (const mode of ['exterior','cutaway','interior']) {
  const view={viewMode:mode,selectedFloor:3,explodeFloors:true};
  for (const cell of flameCellsAt(fire,20)) {
    const offset=yOffsetForRender(cell.floor,view);
    assert.equal(offset,2.2);
    assert.ok(Math.abs(cell.position[1]+offset-(fire.position[1]+2.2))<1e-6);
  }
}
const store=useEvacuationStore;
store.getState().setPopulationTarget(1500);
store.getState().start(); assert.equal(store.getState().metrics.total,1500);
store.getState().pause(); assert.equal(store.getState().status,'paused');
store.getState().syncFromRuntime(); const before=store.getState();
store.getState().syncFromRuntime(); assert.equal(store.getState().fires,before.fires); assert.equal(store.getState().events,before.events);
let notices=0; const unsubscribe=store.subscribe(()=>notices++);
store.getState().setRenderFps(60); const n=notices; store.getState().setRenderFps(60.1); assert.equal(notices,n); unsubscribe();
store.getState().addPresetFire('left'); assert.equal(store.getState().fires.length,1);
store.getState().clearFires(); assert.equal(store.getState().fires.length,0);
store.getState().reset(); assert.equal(store.getState().status,'idle'); assert.equal(store.getState().metrics.elapsed,0);

// Repeated or stale UI handlers must not erase a drill or enter a phantom paused/running state.
store.getState().pause(); store.getState().resume(); assert.equal(store.getState().status,'idle');
assert.equal(evacuationRuntime.running,false);
store.getState().setPopulationTarget(40); store.getState().start();
const revision = evacuationRuntime.revision, population = evacuationRuntime.agents;
evacuationRuntime.step(.05); const simTime = evacuationRuntime.time;
store.getState().start(); assert.equal(evacuationRuntime.revision,revision);
assert.equal(evacuationRuntime.agents,population); assert.equal(evacuationRuntime.time,simTime);
store.getState().setPopulationTarget(3000); assert.equal(store.getState().populationTarget,40);
store.getState().pause(); store.getState().start(); assert.equal(store.getState().status,'paused');
store.getState().resume(); assert.equal(store.getState().status,'running');
for (const invalid of [NaN,Infinity,-Infinity,0,-1]) {
  evacuationRuntime.step(invalid); assert.equal(evacuationRuntime.time,simTime);
}
store.getState().setPlaceFireMode(true); store.getState().reset();
assert.equal(store.getState().placeFireMode,false);
store.getState().start(); assert.ok(evacuationRuntime.revision>revision);
assert.notEqual(evacuationRuntime.agents,population); assert.equal(evacuationRuntime.time,0);
evacuationRuntime.completed=true; evacuationRuntime.running=false; store.getState().syncFromRuntime();
store.getState().pause(); store.getState().resume(); assert.equal(store.getState().status,'completed');
store.getState().reset();

// Non-finite numeric values must preserve valid controls, floors, metrics and physics time.
for (const invalid of [NaN,Infinity,-Infinity]) {
  const before=store.getState();
  store.getState().setSpeedFactor(invalid); store.getState().setRerouteInterval(invalid);
  store.getState().setResponseDelays(invalid,invalid); store.getState().setRenderFps(invalid);
  store.getState().setThermalModel({ambientTemperatureC:invalid,heatAvoidThresholdC:invalid,hardBlockTemperatureC:invalid,thermalLookAheadEdges:invalid,thermalWeight:invalid});
  for (const key of ['speedFactor','rerouteInterval','responseDelayMin','responseDelayMax','renderFps','ambientTemperatureC','heatAvoidThresholdC','hardBlockTemperatureC','thermalLookAheadEdges','thermalWeight']) {
    assert.equal(store.getState()[key],before[key],key+' must keep a finite setting');
  }
}
store.getState().setResponseDelays(-10,-4);
assert.equal(store.getState().responseDelayMin,0); assert.equal(store.getState().responseDelayMax,0);
store.getState().setThermalModel({ambientTemperatureC:45,heatAvoidThresholdC:20,hardBlockTemperatureC:15,thermalLookAheadEdges:4.6});
assert.ok(store.getState().hardBlockTemperatureC>store.getState().heatAvoidThresholdC);
assert.ok(store.getState().heatAvoidThresholdC>store.getState().ambientTemperatureC);
assert.equal(store.getState().thermalLookAheadEdges,5);
useWalkStore.getState().goToFloor(4.7); useBuilding1Store.getState().setSelectedFloor(4.7);
assert.equal(useWalkStore.getState().floor,5); assert.equal(useBuilding1Store.getState().selectedFloor,5);
for (const invalid of [NaN,Infinity,-Infinity]) {
  useWalkStore.getState().goToFloor(invalid); useBuilding1Store.getState().setSelectedFloor(invalid);
  assert.equal(useWalkStore.getState().floor,5); assert.equal(useBuilding1Store.getState().selectedFloor,5);
}

// R3F resets its elapsed clock to zero on never/always changes. Active time must not rewind.
for (const delta of [NaN,Infinity,-Infinity,-1,0]) assert.equal(activeFrameDelta(delta),0);
for (const delta of [.2,4,3600]) assert.equal(activeFrameDelta(delta),.1,'Slow frames must be bounded, not frozen');
let activeTime=30, lastVisual=30;
for (const rawElapsed of [30.016,0,.016,.032]) {
  activeTime+=activeFrameDelta(.02);
  assert.ok(activeTime-lastVisual>.018,'Frame limiter must remain due after a renderer clock reset');
  lastVisual=activeTime;
}

// Preserve pointer ownership with two fingers, mixed mouse buttons and canceled captures.
const owner={id:7,button:2};
assert.equal(canEndPointerGesture(owner,{pointerId:8,button:2,type:'pointerup'}),false);
assert.equal(canEndPointerGesture(owner,{pointerId:7,button:0,type:'pointerup'}),false);
assert.equal(canEndPointerGesture(owner,{pointerId:7,button:2,type:'pointerup'}),true);
assert.equal(canEndPointerGesture(owner,{pointerId:7,button:-1,type:'pointercancel'}),true);
assert.equal(canEndPointerGesture(null,{pointerId:7,button:2,type:'lostpointercapture'}),false);
const captures=new Set([7,8]);
const target={hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)};
releasePointerCapture(target,7); releasePointerCapture(target,7); assert.deepEqual([...captures],[8]);
releasePointerCapture(target,8); assert.equal(captures.size,0);

// Id reuse, same-time floor changes and long-lived shader clocks must not reuse another pose.
const agent={id:1,gender:'male',roomId:'room-a',position:[0,7.2,0],status:'evacuating',floor:3,phase:'corridor',incapacitatedAt:null,protectivePosture:false};
let track=sampleStudentAnimation(undefined,agent,0,0,true);
agent.position=[.04,7.2,0]; track=sampleStudentAnimation(track,agent,.04,.04,true);
assert.ok(track.strideTo>0); assert.ok(Math.abs(track.offsetX)<.22);
const reused=sampleStudentAnimation(track,{...agent,roomId:'room-b',position:[-24,7.2,-5]},.04,.04,true);
assert.notEqual(reused,track); assert.equal(reused.strideTo,0); assert.equal(reused.offsetX,0);
assert.deepEqual([reused.x,reused.y,reused.z],[-24,7.2,-5]);
const moved=sampleStudentAnimation(track,{...agent,position:[.04,10.7,0],floor:4},.04,.04,true);
assert.equal(moved.floor,4); assert.equal(moved.y,10.7); assert.equal(moved.offsetY,0);
const rewind=sampleStudentAnimation(moved,agent,0,.05,true);
assert.notEqual(rewind,moved); assert.equal(rewind.strideFrom,0);
const dead=sampleStudentAnimation(rewind,{...agent,status:'incapacitated'},.1,.1,true);
assert.equal(dead.offsetX,0); assert.equal(dead.strideTo,0); assert.equal(dead.strideFrom,0);
const facing=sampleStudentAnimation(undefined,{...agent,position:[0,7.2,0]},0,0,true); facing.yaw=Math.PI-.02;
const heading=-Math.PI+.02;
const turned=sampleStudentAnimation(facing,{...agent,position:[Math.sin(heading)*.04,7.2,Math.cos(heading)*.04]},.04,.04,true);
assert.ok(Math.abs(turned.yawOffset)<.05,'Crossing PI must take the short rotation');
const period=STUDENT_ANIMATION_PERIOD;
const phaseTrack={...rewind,started:period-.04,sampleClock:period-.03};
const wrapped=advanceStudentAnimationClock(period-.01,.03,[phaseTrack]);
assert.ok(wrapped>=0 && wrapped<period); assert.ok(Math.abs((wrapped-phaseTrack.started)-.06)<1e-9);
for (const frequency of [.63,.8,1.35,1.7,8.2]) {
  assert.ok(Math.abs(Math.sin((period+.02)*frequency+2.399963)-Math.sin(wrapped*frequency+2.399963))<1e-9);
}
// Fire ids must remain unique when add/remove/clear happen within one millisecond.
const fireIds=new Set(), fireRuntime=new EvacuationRuntime(), originalNow=Date.now;
try {
  Date.now=()=>123456789;
  const first=fireRuntime.addPresetFire('left'), second=fireRuntime.addPresetFire('center');
  fireIds.add(first.id); fireIds.add(second.id); fireRuntime.removeFire(first.id);
  const third=fireRuntime.addPresetFire('right'); fireIds.add(third.id);
  assert.equal(fireIds.size,3); fireRuntime.removeFire(third.id);
  assert.equal(fireRuntime.fires.length,1); assert.equal(fireRuntime.fires[0].id,second.id);
  fireRuntime.clearFires(); fireIds.add(fireRuntime.addPresetFire('left').id);
  fireRuntime.reset(false); fireIds.add(fireRuntime.addPresetFire('left').id);
  assert.equal(fireIds.size,5);
} finally { Date.now=originalNow; }
console.log(JSON.stringify({studentModels:4,headHeight:AGENT_BODY_HEIGHT,indexedRiskChecks:indexedChecks,bufferRanges:true,
  pointerPolicy:true,walkableDoors:true,explodedGround:true,metricsPercentiles:true,storeLifecycle:true,
  animationBuffers:true,lifecycleReentry:true,invalidNumbers:true,rendererClockReset:true,pointerRelease:true,poseIdentity:true,longSessionPhase:true,uniqueFireIds:true}));
`);
  const result = execFileSync(process.execPath, [testPath], {
    cwd: root, encoding: "utf8", timeout: 180000, env: { ...process.env, NODE_PATH: resolve(root, "node_modules") },
  }).trim();
  console.log(`Detailed Audit QA ผ่าน: ${result}`);
} catch (error) {
  console.error("Detailed Audit QA ไม่ผ่าน");
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
