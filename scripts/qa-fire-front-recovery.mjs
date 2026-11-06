import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire,Module} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'skr-fire-front-'));
process.env.NODE_PATH=join(root,'node_modules');Module._initPaths();const require=createRequire(import.meta.url);
try{
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--outDir',temp,'--target','ES2022','--module','CommonJS','--moduleResolution','Node','--esModuleInterop','--skipLibCheck','src/simulation/runtime.ts'],{cwd:root,stdio:'pipe'});
 const baseline=process.argv.find(arg=>arg.startsWith('--runtime-file='))?.slice('--runtime-file='.length);
 if(baseline){const ts=require('typescript');writeFileSync(join(temp,'simulation/runtime.js'),ts.transpileModule(readFileSync(baseline,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);}
 const {EvacuationRuntime}=require(join(temp,'simulation/runtime.js'));
 const {findPath,segmentTouchesFlame,pointRisk,traversalPoints}=require(join(temp,'simulation/graph.js'));
 const {PEDESTRIAN_RADIUS}=require(join(temp,'simulation/walkable.js'));
 const results=[];
 for(const scenario of [{count:1},{count:8},{count:1,smallFireBehind:true},{count:1,lateFire:true},{count:1,approachBlocked:true},{count:1,stair:true},{count:1,allBlocked:true}]){
  const {count}=scenario;
  const r=new EvacuationRuntime();r.start({populationTarget:40,walkingSpeed:2,responseDelayMin:0,responseDelayMax:0,fireSpreadEnabled:false,seed:31});r.time=100;
  r.agents.forEach(a=>Object.assign(a,{status:'arrived',phase:'assembly',floor:0,hasPassedRoomDoor:true,hasExitedBuilding:true}));
  const current=scenario.stair?'sim-stair-center-f3':'sim-corr-pink-f3-b3',previous=scenario.stair?'sim-stair-center-f4':'sim-corr-pink-f3-b2',next=scenario.stair?'sim-junction-f3':'sim-corr-pink-f3-b4';
  const incomingId=scenario.stair?'edge-stair-center-4-3':'edge-pink-corr-f3-2-3';
  const edge=r.edgeMap.get(scenario.stair?'edge-junction-center-stair-f3':'edge-pink-corr-f3-3-4'),origin=r.nodeMap.get(current).position;
  if(scenario.stair)r.fires=[{id:'stair-front',position:[origin[0],origin[1]+.01,origin[2]],startTime:0,intensity:1,fireRadius:3.2,smokeRadius:4,spreadRate:0,enabled:true,floor:3,wing:'core',origin:'primary',generation:0,hasSpread:false,attachmentNodeId:current,attachmentKind:'stair'}];
  const incomingPath=traversalPoints(r.edgeMap.get(incomingId),r.nodeMap,previous,current);
  const stairPosition=scenario.stair?[...incomingPath].reverse().find(p=>Math.hypot(...p.map((v,j)=>v-origin[j]))>1&&!pointRisk(p,r.fires,r.time,.26).blocked):null;
  if(scenario.stair)assert(stairPosition);
  const tail=findPath(r.graph,next,r.graph.nodes.filter(n=>n.type==='assembly').map(n=>n.id),r.config,[],100,new Map(),new Set([edge.id]));assert(tail);
  const path={...tail,nodeIds:[current,...tail.nodeIds],edgeIds:[edge.id,...tail.edgeIds]};
  const people=r.agents.slice(0,count);
  people.forEach((a,i)=>{
   r.commitRoute(a,path);
   Object.assign(a,{position:scenario.stair?[...stairPosition]:[origin[0]+4+(i%4)*.7,origin[1],origin[2]+(count===1?0:(i<4?-.5:.5))],floor:3,wing:'pink',phase:scenario.stair?'stair':'corridor',currentNodeId:current,arrivalEdgeId:incomingId,arrivalFromNodeId:previous,edgeIndex:0,edgeEntered:false,status:'evacuating',responseDelay:0,hasPassedRoomDoor:true,hasExitedBuilding:false,speed:2});
   assert(r.prepareEdge(a,edge,r.nodeMap));
  });
  if(!scenario.stair)r.fires=[0,-8,-16].map((offset,i)=>({id:'corridor-front-'+i,position:[origin[0]+offset,origin[1]+.01,origin[2]],startTime:0,intensity:1,fireRadius:3.2,smokeRadius:6,spreadRate:0,enabled:true,floor:3,wing:'pink',origin:'primary',generation:0,hasSpread:false,attachmentNodeId:current,attachmentKind:'corridor'}));
  if(scenario.approachBlocked)Object.assign(r.fires[0],{position:[origin[0]+1.6,origin[1]+.01,origin[2]],fireRadius:1.1});
  if(scenario.smallFireBehind||scenario.allBlocked)r.fires.push({...r.fires[0],id:'behind',position:[origin[0]+(scenario.allBlocked?8:6),origin[1]+.01,origin[2]],fireRadius:scenario.allBlocked?3.2:.55,smokeRadius:1});
  assert.equal(pointRisk(origin,r.fires,r.time,PEDESTRIAN_RADIUS).blocked,!scenario.approachBlocked,'fixture decision-node state');
  assert(people.every(a=>!pointRisk(a.position,r.fires,r.time,PEDESTRIAN_RADIUS).blocked),'people must start outside flame');
  const recovered=new Set();let maxStep=0;
  for(let k=0;k<(scenario.allBlocked?300:2600)&&people.some(a=>a.status!=='arrived');k++){
   if(scenario.lateFire&&k===5)r.fires.push({...r.fires[0],id:'late-block',position:[origin[0]+6,origin[1]+.01,origin[2]],fireRadius:.55,smokeRadius:1});
   const before=people.map(a=>[...a.position]);r.step(.1);
   people.forEach((a,i)=>{
    const step=Math.hypot(...a.position.map((v,j)=>v-before[i][j]));maxStep=Math.max(maxStep,step);
    assert(step<.4,'recovery teleported a pedestrian');
    assert(!segmentTouchesFlame(before[i],a.position,r.fires,r.time,PEDESTRIAN_RADIUS),'recovery crossed active flame');
    assert(a.status!=='incapacitated','flame-free pedestrian collapsed');
    if(a.route.nodeIds[0]===previous)recovered.add(a.id);
   });
  }
  const result={...scenario,arrived:people.filter(a=>a.status==='arrived').length,recovered:recovered.size,maxStep,collisionCorrections:r.getMetrics().collisionCorrections,topologyViolations:r.getMetrics().topologyViolations};
  results.push(result);
  if(!process.argv.includes('--probe')){
   assert.equal(result.arrived,scenario.allBlocked?0:count,'burning node strands a person still on the safe incoming corridor: '+JSON.stringify(people.map(a=>({id:a.id,status:a.status,position:a.position,edge:a.route.edgeIds[a.edgeIndex],retreat:a.retreating,reason:a.reason}))));
   if(!scenario.allBlocked)assert.equal(result.recovered,count);
   assert.equal(result.collisionCorrections,0);assert.equal(result.topologyViolations,0);
  }
 }
 const out=join(root,'artifacts/fire-front-recovery');mkdirSync(out,{recursive:true});
 writeFileSync(join(out,process.argv.includes('--probe')?'before.json':'regression.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results));
}finally{rmSync(temp,{recursive:true,force:true});}
