import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire,Module} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),temp=mkdtempSync(join(tmpdir(),'skr-adaptive-fire-'));
process.env.NODE_PATH=join(root,'node_modules');Module._initPaths();const require=createRequire(import.meta.url);
try {
  execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--outDir',temp,'--target','ES2022','--module','CommonJS','--moduleResolution','Node','--esModuleInterop','--skipLibCheck','src/simulation/runtime.ts'],{cwd:root,stdio:'pipe'});
  const {EvacuationRuntime}=require(join(temp,'simulation/runtime.js'));
  const {edgeRiskSnapshot,traversalPoints,pointRisk,segmentTouchesFlame,findPath}=require(join(temp,'simulation/graph.js'));
  const {planFireDetour,segmentInsideWalkway}=require(join(temp,'simulation/localNavigation.js'));
  const {PEDESTRIAN_RADIUS,pointClearsExteriorBuilding}=require(join(temp,'simulation/walkable.js'));
  const fireAt=(id,position,radius=3.2,floor=0)=>({id,position,startTime:0,fireRadius:radius,smokeRadius:radius*1.8,spreadRate:0,intensity:1,enabled:true,floor,wing:'outdoor',origin:'primary',generation:0,hasSpread:false});
  const make=()=>{const r=new EvacuationRuntime();r.start({populationTarget:1,walkingSpeed:2,responseDelayMin:0,responseDelayMax:0,fireSpreadEnabled:false,seed:31});r.time=100;return r;};
  const runtime=make(),edge=runtime.graph.edges.find(e=>e.id==='campus-b3-to-field-0');
  const nodes=new Map(runtime.graph.nodes.map(n=>[n.id,n])),path=traversalPoints(edge,nodes,edge.from,edge.to);
  const [a,b]=[path[0],path.at(-1)];
  const fire=fireAt('plaza-midpoint',[(a[0]+b[0])/2,.22,-25]);
  const sources=[fire];
  const options={riskAt:p=>pointRisk(p,sources,100,.26),segmentBlocked:(a,b)=>segmentTouchesFlame(a,b,sources,100,.26)};
  const detour=planFireDetour(path,edge,options),risk=edgeRiskSnapshot(runtime.graph,edge.id,sources,100);
  if(process.argv.includes('--probe')){console.log(JSON.stringify({scenario:'campus paved plaza, fire radius 3.2 m',edge:edge.id,detour:detour?.length??0,blocked:risk.blocked}));process.exitCode=detour&&!risk.blocked?0:2;}
  else {
    assert(detour,'paved plaza incorrectly treated as a narrow impassable corridor');
    assert(!risk.blocked,'graph planner rejected the physically walkable bypass');
    for(let i=1;i<detour.length;i++){
      assert(segmentInsideWalkway(detour[i-1],detour[i],path,edge));
      assert(!segmentTouchesFlame(detour[i-1],detour[i],sources,100,.26));
    }
    const goals=runtime.graph.nodes.filter(n=>n.type==='assembly'&&n.id.startsWith('sim-')).map(n=>n.id);
    const tail=findPath(runtime.graph,edge.to,goals,runtime.config,[],100,new Map(),new Set([edge.id]));assert(tail);
    const agent=runtime.agents[0];
    runtime.commitRoute(agent,{...tail,nodeIds:[edge.from,...tail.nodeIds],edgeIds:[edge.id,...tail.edgeIds]});
    Object.assign(agent,{position:[...a],floor:0,wing:'outdoor',phase:'outdoor',currentNodeId:edge.from,hasPassedRoomDoor:true,hasExitedBuilding:true,edgeIndex:0,responseDelay:0,status:'evacuating',speed:2});
    assert(runtime.prepareEdge(agent,edge,nodes));runtime.fires=sources;
    let observedDetour=false,maxSide=0,steps=0;
    for(;steps<2400&&agent.status!=='arrived';steps++){
      const before=[...agent.position];runtime.step(.1);
      observedDetour ||= agent.detourPath.length>0;
      if(agent.edgeIndex===0)maxSide=Math.max(maxSide,Math.abs(agent.position[2]+25));
      assert(!segmentTouchesFlame(before,agent.position,sources,runtime.time,PEDESTRIAN_RADIUS),'runtime walked into fire');
      assert(Math.hypot(...agent.position.map((v,j)=>v-before[j]))<.45,'runtime teleported');
      assert.notEqual(agent.status,'incapacitated');
    }
    assert(observedDetour,'runtime never tried a local bypass');
    assert.equal(agent.status,'arrived','agent still freezes in front of an avoidable plaza fire: '+JSON.stringify({position:agent.position,status:agent.status,reason:agent.reason,route:agent.route.edgeIds,edgeIndex:agent.edgeIndex}));
    assert.equal(runtime.getMetrics().topologyViolations,0);
    assert.equal(runtime.getMetrics().collisionCorrections,0);
    // A genuine full-width indoor obstruction remains impassable.
    const narrow={...edge,id:'qa-indoor',kind:'corridor',insideBuilding:true,width:1.15,floorFrom:2,floorTo:2};
    const indoor=[[-42,3.7,1.86],[-30,3.7,1.86]],wall=[fireAt('wall',[-36,3.7,1.86],2,2)];
    assert.equal(planFireDetour(indoor,narrow,{riskAt:p=>pointRisk(p,wall,100,.26),segmentBlocked:(a,b)=>segmentTouchesFlame(a,b,wall,100,.26)}),null);
    assert(!pointClearsExteriorBuilding([-108,.22,16]),'shrine obstacle lost');
    const roomResults=[];
    for(const building of [1,3,4]) {
      const r=make();
      if(building===1){r.reset(false);r.start({populationTarget:144,walkingSpeed:2,responseDelayMin:0,responseDelayMax:0,fireSpreadEnabled:false,seed:31});r.time=100;}
      const p=building===1?r.agents.find(a=>a.roomId==='b1-f3-pink-3'):r.agents[0];assert(p);
      if(building===1)r.agents.forEach(a=>{if(a!==p)a.status='arrived';});
      const room=r.graph.nodes.find(n=>n.id===(building===1?p.roomId:`b${building}-f2-room-5`));
      const door=r.graph.nodes.find(n=>n.id===`sim-door-${room.id}`);
      const roomFire=r.addFire([door.position[0]+4,door.position[1],building===1?1.86:door.position[2]+.3],{fireRadius:building===1?2.1:1.5,smokeRadius:3,spreadRate:0,startTime:0});
      assert(!pointRisk(door.position,[roomFire],100,.26).blocked,'fixture must leave the classroom door open');
      const excluded=new Set(r.graph.edges.filter(e=>building===1?e.id.includes('edge-pink-outer-left-stair-'):e.id.startsWith(`campus-b${building}-stair-access-0`)).map(e=>e.id));
      const original=findPath(r.graph,room.id,r.graph.nodes.filter(n=>n.type==='assembly').map(n=>n.id),r.config,[],100,new Map(),excluded);assert(original);
      r.commitRoute(p,original);
      Object.assign(p,{roomId:room.id,position:building===1?[...p.position]:[...room.position],floor:room.floor,wing:room.wing,phase:'room',currentNodeId:room.id,hasPassedRoomDoor:false,hasExitedBuilding:false,edgeIndex:0,edgeEntered:false,responseDelay:0,status:'evacuating',speed:2.5});
      assert(r.prepareEdge(p,r.edgeMap.get(original.edgeIds[0]),r.nodeMap));
      let usedOtherStair=false;
      for(let k=0;k<4500&&p.status!=='arrived';k++){
        const before=[...p.position];r.step(.1);
        usedOtherStair ||= building===1?p.route.edgeIds.some(id=>/^edge-stair-left-/.test(id)):p.route.edgeIds.includes(`campus-b${building}-stair-0-down-2`);
        assert(!segmentTouchesFlame(before,p.position,r.fires,r.time,PEDESTRIAN_RADIUS),'room-front fire contact');
        assert.notEqual(p.status,'incapacitated');
      }
      assert.equal(p.status,'arrived',`building ${building} room-front fire still freezes agent: `+JSON.stringify({position:p.position,state:p.status,reason:p.reason,route:p.route.edgeIds,edgeIndex:p.edgeIndex}));
      assert(usedOtherStair,'room-front fire did not cause an alternate-stair choice: '+JSON.stringify({building,room,fire:roomFire,route:p.route.edgeIds}));
      roomResults.push({building,arrived:true,usedOtherStair,reroutes:r.rerouteCount,collisionCorrections:r.getMetrics().collisionCorrections});
    }
    const result={pass:true,detourWaypoints:detour.length,runtimeArrived:true,observedDetour,maxSide,seconds:steps*.1,roomResults};
    const out=join(root,'artifacts/adaptive-fire');mkdirSync(out,{recursive:true});
    const sourceHashes=Object.fromEntries(['runtime.ts','graph.ts','localNavigation.ts','walkable.ts'].map(name=>[name,createHash('sha256').update(readFileSync(join(root,'src/simulation',name))).digest('hex')]));
    writeFileSync(join(out,'regression.json'),JSON.stringify({...result,sourceHashes},null,2));
    console.log(JSON.stringify(result));
  }
} finally {rmSync(temp,{recursive:true,force:true});}
