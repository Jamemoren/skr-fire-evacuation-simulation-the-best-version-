// Regression for competitive landing deadlock, plus complete seed-7 evacuation matrix.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire,Module} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'skr-competitive-'));
process.env.NODE_PATH=join(root,'node_modules');Module._initPaths();const require=createRequire(import.meta.url);
execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--outDir',temp,'--target','ES2022','--module','CommonJS','--moduleResolution','Node','--esModuleInterop','--skipLibCheck','src/simulation/runtime.ts'],{cwd:root,stdio:'pipe'});
const {EvacuationRuntime,FIXED_SIMULATION_DT:DT}=require(join(temp,'simulation/runtime.js'));
const {findPath}=require(join(temp,'simulation/graph.js'));
const {pointInsideWalkableCorridor}=require(join(temp,'simulation/walkable.js'));
const output=resolve(root,'qa-output/competitive');mkdirSync(output,{recursive:true});
const args=Object.fromEntries(process.argv.slice(2).filter(x=>x.includes('=')).map(x=>x.replace(/^--/,'').split('=')));
const base={preset:'balanced',seed:7,responseDelayMin:3,responseDelayMax:10};
if(!args.n){
 const fixtures=JSON.parse(readFileSync(join(root,'scripts/fixtures/competitive-landings.json'),'utf8'));
 const rt=new EvacuationRuntime();rt.start({...base,populationTarget:1500,crowdBehavior:'grouped'});rt.agents.forEach(a=>a.status='arrived');
 for(const f of fixtures){
  const agent=rt.agents[f.id],edge=rt.edgeMap.get(f.edgeId),nodeId=f.nodeId;
  const path=findPath(rt.graph,nodeId,rt.graph.nodes.filter(n=>n.type==='assembly').map(n=>n.id),rt.config,[],0);assert(path);
  Object.assign(agent,{route:path,edgeIndex:0,edgeEntered:false,position:[...f.position],arrivalEdgeId:f.incomingEdge,arrivalFromNodeId:f.incomingFrom,queueKey:`${f.edgeId}|${nodeId}`,lastProgressAt:-100,status:'queueing'});
  const queue=rt.queueFor(edge,nodeId);queue.waiting=[agent.id];rt.stationaryGrid.clear();rt.forwardGapByAgentCache.clear();
  const incoming=rt.incomingPassage(agent),incomingPath=rt.passagePath(incoming.edge,incoming.fromId,incoming.toId);
  let previous=rt.queueRemaining(agent);
  for(let i=0;i<200;i++){
   const before=[...agent.position];rt.time+=DT;rt.queueRemainingCache.clear();rt.positionInCrowd(agent,edge,nodeId,queue,DT);
   assert(Math.hypot(...agent.position.map((v,k)=>v-before[k]))<=agent.speed*DT*1.1+.02,'Bounded physical step');
   assert(pointInsideWalkableCorridor(agent.position,incomingPath,incoming.edge),'Inside incoming walkway');
   const remaining=rt.queueRemaining(agent);assert(remaining<=previous+.011,'No backwards queue progress');previous=remaining;
  }
  assert(rt.queueRemaining(agent)<.31,'Regressed landing pose must reach the portal: '+f.id);agent.status='arrived';
 }
 console.log('PASS landing fixtures:',fixtures.length);
 const corner=JSON.parse(readFileSync(join(root,'scripts/fixtures/concave-apron.json'),'utf8'));
 const isolated=new EvacuationRuntime();isolated.reset(false);isolated.start({...base,populationTarget:40,crowdBehavior:'grouped'});
 isolated.agents.forEach(a=>a.status='arrived');const person=isolated.agents[0];
 Object.assign(person,{...corner,roomId:'b1-f6-pink-3',floor:6,phase:'corridor',status:'evacuating',edgeIndex:0,edgeEntered:false,hasPassedRoomDoor:true,position:[...corner.position]});
 assert(isolated.prepareEdge(person,isolated.edgeMap.get(person.route.edgeIds[0]),isolated.nodeMap));
 assert.equal(person.edgePath[1][0],corner.position[0],'Rejoin through a safe elbow before turning');
 for(let i=0;i<200;i++)isolated.advance(DT);
 assert.equal(isolated.getMetrics().collisionCorrections,0,'Concave apron must not retreat into the stair void');
 console.log('PASS concave apron movement');
 const turn=JSON.parse(readFileSync(join(root,'scripts/fixtures/switchback-lane.json'),'utf8'));
 const turning=new EvacuationRuntime();turning.reset(false);turning.start({...base,populationTarget:1500,crowdBehavior:'surge'});
 turning.agents.forEach(a=>a.status='arrived');const leader=turning.agents[turn.agent.id];Object.assign(leader,turn.agent);turning.time=turn.time;
 let previousPosition=[...leader.position];
 for(let i=0;i<500;i++){turning.advance(DT);assert(Math.hypot(...leader.position.map((v,k)=>v-previousPosition[k]))<=leader.speed*DT*2.5+.35,'No teleport at switchback');previousPosition=[...leader.position];}
 assert(leader.edgeIndex>turn.agent.edgeIndex||leader.segmentIndex>turn.agent.segmentIndex+1,'Unblocked lane leader must round the switchback');
 assert.equal(turning.getMetrics().collisionCorrections,0);
 console.log('PASS switchback lane integration');
 // Two waiting people converged onto the same final riser in the 1,500-person run.
 // Keep the next opening temporarily clogged; separation must work without admission.
 const packed=new EvacuationRuntime();packed.start({...base,populationTarget:40,crowdBehavior:'grouped'});packed.time=100;
 packed.agents.forEach(a=>a.status='arrived');
 const incomingId='edge-stair-center-9-8',mouthId='sim-stair-center-f8',nextId='edge-stair-center-8-7';
 const nextEdge=packed.edgeMap.get(nextId),incoming=packed.edgeMap.get(incomingId);
 const tail=findPath(packed.graph,'sim-stair-center-f7',packed.graph.nodes.filter(n=>n.type==='assembly').map(n=>n.id),packed.config,[],100,new Map(),new Set([nextId]));assert(tail);
 const route={...tail,nodeIds:[mouthId,...tail.nodeIds],edgeIds:[nextId,...tail.edgeIds]};
 const poses=[[2.4434124042052328,24.78766874979802,2.3575806408854163],[2.444609736589737,24.80401045865128,2.3554030923887974]];
 const queue=packed.queueFor(nextEdge,mouthId);queue.clogUntil=1000;
 poses.forEach((position,i)=>{
  const person=packed.agents[i];packed.commitRoute(person,route);
  Object.assign(person,{position:[...position],status:'queueing',floor:8,phase:'stair',currentNodeId:mouthId,edgeIndex:0,edgeEntered:false,arrivalEdgeId:incomingId,arrivalFromNodeId:'sim-stair-center-f9',queueKey:queue.key,hasPassedRoomDoor:true,hasExitedBuilding:false,responseDelay:0});
 });
 queue.waiting=[0,1];
 const incomingPath=packed.passagePath(incoming,'sim-stair-center-f9',mouthId);
 for(let i=0;i<60;i++){
  const before=packed.agents.slice(0,2).map(a=>[...a.position]);packed.advance(DT);
  for(let k=0;k<2;k++){
   const person=packed.agents[k];assert(pointInsideWalkableCorridor(person.position,incomingPath,incoming));
   assert(Math.hypot(...person.position.map((v,j)=>v-before[k][j]))<.3,'Separation is a physical step');
  }
 }
 const separation=Math.hypot(packed.agents[0].position[0]-packed.agents[1].position[0],packed.agents[0].position[2]-packed.agents[1].position[2]);
 assert(separation>=.119,'Waiting people must not overlap persistently: '+separation);
 console.log('PASS post-movement waiting separation:',separation);
}else{
 const n=Number(args.n),behavior=args.b||'grouped',rt=new EvacuationRuntime();rt.reset(false);rt.start({...base,populationTarget:n,crowdBehavior:behavior});
 let guards=0;const retreat=rt.beginRetreat.bind(rt);
 rt.beginRetreat=(agent,nodes)=>{if(rt.collisionCorrections>guards){guards=rt.collisionCorrections;console.log('GUARD',rt.time,rt.getCollisionCorrectionSamples());if(guards===1)writeFileSync(join(output,`guard-${behavior}-${n}.json`),JSON.stringify({agent,time:rt.time,edge:rt.edgeMap.get(agent.route.edgeIds[agent.edgeIndex])}));}return retreat(agent,nodes);};
 let maxStep=0,lastLog=0;const previous=rt.agents.map(a=>[...a.position]),started=performance.now();
 while(!rt.completed&&rt.time<2600){
  rt.advance(DT);
  for(const a of rt.agents){
   assert(a.position.every(Number.isFinite));const step=Math.hypot(...a.position.map((v,k)=>v-previous[a.id][k]));maxStep=Math.max(maxStep,step);
   assert(step<=a.speed*DT*2.5+.35,'No teleport '+a.id+' at '+rt.time);previous[a.id]=[...a.position];
  }
  if(rt.time>=lastLog){lastLog+=300;console.log(`${behavior}/${n}: t=${rt.time.toFixed(0)} arrived=${rt.getMetrics().arrived}`);}
 }
 const m=rt.getMetrics(),result={behavior,n,metrics:m,samples:rt.getCollisionCorrectionSamples(),maxStep,wallSeconds:(performance.now()-started)/1000};
 writeFileSync(join(output,`${behavior}-${n}.json`),JSON.stringify(result,null,2));
 assert.equal(m.arrived,n,'All uninjured people with open exits arrive');assert.equal(m.collisionCorrections,0);assert.equal(m.topologyViolations,0);
 assert.equal(m.stateInconsistencies,0);console.log('PASS',JSON.stringify({behavior,n,arrived:m.arrived,time:m.elapsed,maxStep,wallSeconds:result.wallSeconds}));
}
