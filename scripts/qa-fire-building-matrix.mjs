// Reproducible stratified fire assessment; does not change production incidents or saved maps.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire,Module} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'skr-fire-matrix-'));
process.env.NODE_PATH=join(root,'node_modules');Module._initPaths();const require=createRequire(import.meta.url);
const output=join(root,'artifacts',process.env.MATRIX_OUTPUT||'fire-building-matrix');mkdirSync(output,{recursive:true});
try{
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--outDir',temp,'--target','ES2022','--module','CommonJS','--moduleResolution','Node','--esModuleInterop','--skipLibCheck','src/simulation/runtime.ts'],{cwd:root,stdio:'pipe'});
 const {EvacuationRuntime}=require(join(temp,'simulation/runtime.js'));
 const {findPath,edgeBlockedByFire,pointRisk,segmentTouchesFlame}=require(join(temp,'simulation/graph.js'));
 const {PEDESTRIAN_RADIUS}=require(join(temp,'simulation/walkable.js'));
 const sourceHashes=Object.fromEntries(['runtime.ts','graph.ts','walkable.ts','fireField.ts','localNavigation.ts'].map(name=>[name,createHash('sha256').update(readFileSync(join(root,'src/simulation',name))).digest('hex')]));
 const setup=new EvacuationRuntime();setup.start({populationTarget:40,seed:31,fireSpreadEnabled:false});
 const cases=[];
 for(const building of [1,3,4])for(let floor=2;floor<=(building===1?9:4);floor++){
  const ids=building===1?[`b1-f${floor}-pink-3`,`sim-corr-pink-f${floor}-b3`,`sim-stair-center-f${floor}`]:[`b${building}-f${floor}-room-5`,`campus-b${building}-f${floor}-gallery-5`,`campus-b${building}-stair-0-f${floor}`];
  ids.forEach((nodeId,i)=>cases.push({id:`b${building}-f${floor}-${['room','corridor','stair'][i]}`,building,floor,kind:['room','corridor','stair'][i],nodeId}));
 }
 for(const zone of ['left','center','right']){
  cases.push({id:`b1-f1-stair-${zone}`,building:1,floor:1,kind:'stair',nodeId:`sim-stair-${zone}-f1`});
  cases.push({id:`b1-f1-exit-${zone}`,building:1,floor:1,kind:'exit',nodeId:`sim-stair-exit-door-${zone}`});
 }
 for(const building of [3,4])for(const [kind,nodeId] of [['corridor',`campus-b${building}-f1-gallery-5`],['stair',`campus-b${building}-stair-0-f1`],['exit',`campus-b${building}-exit-0`]])cases.push({id:`b${building}-f1-${kind}`,building,floor:1,kind,nodeId});
 cases.push({id:'b34-bridge',building:'3-4',floor:4,kind:'bridge',position:[-67,11.413106382978722,-39.98]});
 const goals=setup.graph.nodes.filter(n=>n.type==='assembly').map(n=>n.id);
 const sampleRooms=setup.graph.nodes.filter(n=>n.type==='room'&&(process.env.MATRIX_ALL_ROOMS==='1'||(((n.id.startsWith('b1-')&&[2,5,9].includes(n.floor))||((n.id.startsWith('b3-')||n.id.startsWith('b4-'))&&[2,4].includes(n.floor)))&&(/pink-3$|blue-3$|room-5$/.test(n.id)))));
 assert(sampleRooms.length>=8);
 const staticResults=[];
 for(const c of cases){
  setup.clearFires();const node=c.nodeId?setup.nodeMap.get(c.nodeId):null;assert(node||c.position,'missing fixture '+c.id);
  const fire=setup.addFire([...(node?.position??c.position)],{startTime:-60,spreadRate:0});
  if(c.kind!=='exit')assert.equal(fire.floor,c.floor,'fire placed on wrong floor '+c.id);
  if(c.kind!=='exit'&&(c.building===3||c.building===4))assert.equal(fire.wing,`building-${c.building}`,'fire attached to wrong building '+c.id);
  let routes=0,noRoute=0,unsafe=0;const noRouteRooms=[];
  for(const room of sampleRooms){
   const route=findPath(setup.graph,room.id,goals,setup.config,setup.fires,100,new Map());
   if(!route){noRoute++;noRouteRooms.push(room.id);continue;} routes++;
   if(route.edgeIds.some(id=>edgeBlockedByFire(setup.graph,id,setup.fires,100)))unsafe++;
  }
  assert.equal(unsafe,0,'planner returned an edge blocked by fire: '+c.id);
  staticResults.push({...c,actual:{position:fire.position,floor:fire.floor,wing:fire.wing,attachment:fire.attachmentNodeId},sampleRooms:sampleRooms.length,routes,noRoute,noRouteRooms,unsafe});
  console.log(`STATIC ${c.id}: ${routes}/${sampleRooms.length} sampled rooms have routes`);
 }
 const dynamicIds=['b1-f2-room','b1-f5-corridor','b1-f9-stair','b3-f3-room','b4-f3-corridor','b34-bridge'].map(id=>({id,spread:false}));
 dynamicIds.push(...['b1-f1-stair-center','b3-f1-stair','b4-f1-stair'].map(id=>({id,spread:false})));
 dynamicIds.push(...['b1-f5-corridor','b3-f3-room','b4-f3-corridor'].map(id=>({id,spread:true})));
 const dynamicResults=[];
 for(const scenario of dynamicIds.filter(c=>(!process.env.MATRIX_ONLY||c.id===process.env.MATRIX_ONLY)&&(!process.env.MATRIX_SPREAD||String(c.spread)===process.env.MATRIX_SPREAD))){
  const {id,spread}=scenario;
  const c=cases.find(x=>x.id===id),rt=new EvacuationRuntime();
  const config={populationTarget:144,seed:31,crowdBehavior:'grouped',fireSpreadEnabled:spread,responseDelayMin:0,responseDelayMax:2};
  rt.start(config);const node=c.nodeId?rt.nodeMap.get(c.nodeId):null;
  rt.addFire([...(node?.position??c.position)],{startTime:-30,spreadRate:spread?.028:0});
  const debugCounts={};
  if(process.env.MATRIX_TRACE_IDS){
   const ids=new Set(process.env.MATRIX_TRACE_IDS.split(',').map(Number));
   for(const name of ['prepareEdge','beginRetreat','retreatAlongIncomingPassage']){
    const original=rt[name].bind(rt);rt[name]=(...args)=>{const result=original(...args);if(ids.has(args[0].id)){const key=`${args[0].id}:${name}:${String(result)}`;debugCounts[key]=(debugCounts[key]||0)+1;}return result;};
   }
  }
  let enteredFlame=0,maxStep=0,peakFireSources=0;const everAware=new Set(),t0=Date.now();
  const anchors=rt.agents.map(a=>[...a.position]),lastMoved=rt.agents.map(()=>0);
  for(let step=0;step<10*Number(process.env.MATRIX_SECONDS||900)&&!rt.completed;step++){
   const before=rt.agents.map(a=>[...a.position]);const wasBlocked=rt.agents.map(a=>pointRisk(a.position,rt.fires,rt.time,PEDESTRIAN_RADIUS).blocked);
   rt.advance(.1);
   peakFireSources=Math.max(peakFireSources,rt.fires.length);
   rt.agents.forEach((a,i)=>{
    if(a.knownFireIds.size)everAware.add(a.id);
    const d=Math.hypot(...a.position.map((v,j)=>v-before[i][j]));maxStep=Math.max(maxStep,d);
    if(Math.hypot(...a.position.map((v,j)=>v-anchors[i][j]))>=.15){anchors[i]=[...a.position];lastMoved[i]=rt.time;}
    if(!wasBlocked[i]&&!pointRisk(before[i],rt.fires,rt.time,PEDESTRIAN_RADIUS).blocked&&d>1e-7&&segmentTouchesFlame(before[i],a.position,rt.fires,rt.time,PEDESTRIAN_RADIUS))enteredFlame++;
    assert(a.position.every(Number.isFinite),'non-finite position '+id);
    assert(d<=a.speed*.1*2.5+.35,'teleport '+id+' agent '+a.id);
   });
  }
  const m=rt.getMetrics(),remaining=rt.agents.filter(a=>a.status!=='arrived'&&a.status!=='incapacitated');
  const statuses=Object.fromEntries([...new Set(remaining.map(a=>a.status))].map(status=>[status,remaining.filter(a=>a.status===status).length]));
  const remainingDetails=remaining.map(a=>{const i=rt.agents.indexOf(a);return {id:a.id,status:a.status,position:a.position,floor:a.floor,roomId:a.roomId,currentNodeId:a.currentNodeId,stillSeconds:+(rt.time-lastMoved[i]).toFixed(1),knownFires:[...a.knownFireIds],blockedByFire:pointRisk(a.position,rt.fires,rt.time,PEDESTRIAN_RADIUS).blocked,graphRouteAvailable:!!findPath(rt.graph,a.currentNodeId,goals,rt.config,rt.fires,rt.time,new Map()),reason:a.reason,queueKey:a.queueKey,queue:a.queueKey?rt.edgeQueues.get(a.queueKey):null,incoming:rt.incomingPassage(a)?.edge.id,squeezing:rt.squeezing(a),edgeIndex:a.edgeIndex,edgeEntered:a.edgeEntered,routeEdges:a.route.edgeIds.slice(a.edgeIndex, a.edgeIndex+3)};});
  assert.equal(m.arrived+m.incapacitated+remaining.length,rt.agents.length,'population accounting '+id);
  const result={id,config,ignitionTime:-30,simulatedSeconds:+rt.time.toFixed(1),wallSeconds:+((Date.now()-t0)/1000).toFixed(1),arrived:m.arrived,incapacitated:m.incapacitated,remaining:remaining.length,statuses,remainingDetails,debugCounts,everAware:everAware.size,fireSources:rt.fires.length,peakFireSources,reroutes:m.rerouteCount,collisionCorrections:m.collisionCorrections,topologyViolations:m.topologyViolations,stateInconsistencies:m.stateInconsistencies,enteredFlame,maxStep,completed:rt.completed};
  dynamicResults.push(result);
  writeFileSync(join(output,'results.json'),JSON.stringify({sourceHashes,staticResults,dynamicResults},null,2));
  console.log('DYNAMIC '+JSON.stringify(result));
  assert.equal(m.topologyViolations,0,'topology violations '+id);
  assert.equal(m.stateInconsistencies,0,'inconsistent agent state '+id);
  assert.equal(enteredFlame,0,'agent entered an existing flame '+id);
  if(id==='b1-f1-stair-center'&&!spread&&Number(process.env.MATRIX_SECONDS||900)>=900){
   assert(everAware.size>0,'no one detected smoke at the connected landing');
   assert.equal(m.arrived,144,'the controlled stair-smoke regression did not evacuate');
  }
 }
 writeFileSync(join(output,'results.json'),JSON.stringify({sourceHashes,staticResults,dynamicResults},null,2));
 console.log(`FINISHED ${staticResults.length} static cases, ${dynamicResults.length} dynamic cases`);
}finally{rmSync(temp,{recursive:true,force:true});}
