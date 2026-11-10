import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createRequire,Module} from "node:module";
import * as THREE from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";

const root=resolve(import.meta.dirname,".."),temp=mkdtempSync(join(tmpdir(),"skr-campus-"));
const require=createRequire(import.meta.url);
process.env.NODE_PATH=resolve(root,"node_modules");Module._initPaths();
try {
  execFileSync(process.execPath,[resolve(root,"node_modules/typescript/bin/tsc"),"--outDir",temp,"--target","ES2022","--module","CommonJS","--moduleResolution","Node","--esModuleInterop","--skipLibCheck",
    "src/simulation/runtime.ts","src/simulation/semanticGraph.ts","src/simulation/operationalReadiness.ts","src/utils/portableProject.ts","src/building1/campusBlockWalls.ts"],{cwd:root,stdio:"pipe"});
  const {createEvacuationGraph,findPath,routeIsPhysicallyValid}=require(join(temp,"simulation/graph.js"));
  const {CAMPUS_ROOMS,ALL_CLASSROOMS,CAMPUS_BUILDINGS,BLOCK_LEVELS,BLOCK_GALLERY}=require(join(temp,"simulation/campusData.js"));
  const {studentStartPosition}=require(join(temp,"simulation/studentPlacement.js"));
  const {EvacuationRuntime}=require(join(temp,"simulation/runtime.js"));
  const {buildGeneratedSemanticMap}=require(join(temp,"simulation/semanticGraph.js"));
  const {evaluateOperationalReadiness}=require(join(temp,"simulation/operationalReadiness.js"));
  const {encodeProject,decodeProject,validateMap}=require(join(temp,"utils/portableProject.js"));
  const {rebuildBlockEndWalls}=require(join(temp,"building1/campusBlockWalls.js"));
  const {BRIDGE_FLOOR}=require(join(temp,"simulation/bridge.js"));
  const graph=createEvacuationGraph(),nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  assert.equal(nodes.size,graph.nodes.length);
  assert.equal(new Set(graph.edges.map(e=>e.id)).size,graph.edges.length);
  assert.equal(ALL_CLASSROOMS.length,144);assert.equal(CAMPUS_ROOMS.length,48);
  for(const e of graph.edges){assert(nodes.has(e.from)&&nodes.has(e.to));assert(e.distance>0&&Number.isFinite(e.distance));}
  assert(evaluateOperationalReadiness().ready,"All preflight checks");
  const config={populationTarget:300,preset:"balanced",walkingSpeed:1.32,responseDelayMin:0,responseDelayMax:0,rerouteInterval:2,distanceWeight:.28,timeWeight:1,congestionWeight:20,fireWeight:4200,smokeWeight:1250,fireSpreadEnabled:false,crowdBehavior:"grouped"};
  for(const r of ALL_CLASSROOMS)for(const goals of [
    graph.nodes.filter(n=>n.type==="assembly"&&!n.id.startsWith("campus-")).map(n=>n.id),
    ...(r.buildingId!=="building-1"?[graph.nodes.filter(n=>n.type==="assembly"&&n.id.startsWith("campus-")).map(n=>n.id)]:[])
  ]){
    const path=findPath(graph,r.id,goals,config,[],0);
    assert(path&&routeIsPhysicallyValid(graph,path),"Reachable goal from "+r.id);
  }
  // 2026-11-09: the bridge is on floor 3 (was modelled on floor 4). Same checks, new floor.
  const bridge=graph.edges.find(e=>e.id==="campus-straight-bridge-level-3");
  const a=nodes.get(bridge.from),b=nodes.get(bridge.to);
  assert.equal(a.position[1],b.position[1]);assert.equal(a.position[2],b.position[2]);assert.equal(a.floor,3);
  const blocked=new Set(graph.edges.filter(e=>e.id.startsWith("campus-b3-stair-")&&e.kind==="stair").map(e=>e.id));
  const escape=findPath(graph,"b3-f3-room-1",graph.nodes.filter(n=>n.type==="assembly").map(n=>n.id),config,[],0,new Map(),blocked);
  assert(escape?.edgeIds.includes(bridge.id),"Blocked Building 3 stairs can use the straight bridge");

  // Independent triangle raycasts, not only graph's own envelope checks.
  const raw=readFileSync(resolve(root,"public/models/campus-classroom-block.glb"));
  assert.equal(raw.readUInt32LE(8),raw.length);
  const {scene:prototype}=await new GLTFLoader().parseAsync(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength),"");
  const scene=new THREE.Group();
  // Same end walls as the 3D view (bridge opening on floor 3, inner end only).
  for(const building of CAMPUS_BUILDINGS){const copy=prototype.clone(true);rebuildBlockEndWalls(THREE,copy,building.number===3?1:-1);copy.position.set(building.x,0,building.z);scene.add(copy);}
  function slab(p,s){const mesh=new THREE.Mesh(new THREE.BoxGeometry(...s),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.position.set(...p);scene.add(mesh);}
  for(const building of CAMPUS_BUILDINGS)slab([building.x,.03,building.z],[84,.12,29]);
  slab([-62,BLOCK_LEVELS[BRIDGE_FLOOR-1]-.12,-43+BLOCK_GALLERY],[27,.24,2.7]);
  scene.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])m.side=THREE.DoubleSide;});scene.updateMatrixWorld(true);
  const ray=new THREE.Raycaster();let samples=0;
  // These rays catch the missing head/end walls reported in the reference screenshots.
  for(const building of CAMPUS_BUILDINGS)for(const y of [1.7,6.0,9.3,12.7]){
    for(const side of [-1,1]){
      ray.set(new THREE.Vector3(building.x+side*45,y,building.z-2),new THREE.Vector3(-side,0,0));ray.near=0;ray.far=8;
      assert(ray.intersectObject(scene,true).length,"Continuous end wall "+building.id+" at "+y);
    }
    for(const x of [-30,-12,8,30]){
      ray.set(new THREE.Vector3(building.x+x,y,building.z-12),new THREE.Vector3(0,0,1));ray.near=0;ray.far=5;
      assert(ray.intersectObject(scene,true).length,"Continuous rear wall "+building.id);
    }
  }
  function support(p,label){
    ray.set(new THREE.Vector3(...p).add(new THREE.Vector3(0,.03,0)),new THREE.Vector3(0,-1,0));ray.near=0;ray.far=.65;
    const hits=ray.intersectObject(scene,true);
    assert(hits.length&&hits[0].distance>=.04,label+" needs a supported walking surface at "+p);samples++;
  }
  function clear(a,b,label){
    const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),length=av.distanceTo(bv);
    if(length<.05)return;ray.set(av,bv.sub(av).normalize());ray.near=.025;ray.far=length-.025;
    const hits=ray.intersectObject(scene,true);assert.equal(hits.length,0,label+" hits wall/railing at "+hits[0]?.point.toArray());samples++;
  }
  for(const edge of graph.edges.filter(e=>e.id.startsWith("campus-")&&e.insideBuilding)){
    const pts=[nodes.get(edge.from).position,...edge.waypoints??[],nodes.get(edge.to).position];
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i],count=Math.max(1,Math.ceil(Math.hypot(...b.map((v,k)=>v-a[k]))/.35));
      for(let j=0;j<=count;j++)support(a.map((v,k)=>v+(b[k]-v)*j/count),edge.id);
      for(const height of [.8,1.65])clear(a.map((v,k)=>v+(k===1?height:0)),b.map((v,k)=>v+(k===1?height:0)),edge.id);
    }
  }
  for(const room of CAMPUS_ROOMS)for(let i=0;i<40;i++)support(studentStartPosition(room,i),room.id+" spawn "+i);

  const map=validateMap(buildGeneratedSemanticMap());
  const blob=await encodeProject(map,null);
  const restored=await decodeProject(blob);
  assert.deepEqual(restored.map.connections,map.connections,"Portable project retains bends and edges");
  assert.deepEqual(restored.map.annotations,map.annotations,"Portable project retains all building nodes");
  const corrupt=structuredClone(map);corrupt.connections[0].waypoints=[[NaN,1,1]];
  assert.throws(()=>validateMap(corrupt),"Reject non-finite imported waypoints");

  const population=process.argv.includes("--full")?3000:300;
  const rt=new EvacuationRuntime();rt.start({...config,populationTarget:population});
  assert.equal(rt.agents.length,population);
  for(const prefix of ["b3-","b4-"])assert(rt.getAgentSnapshots().some(a=>a.roomId.startsWith(prefix)));
  for(let i=0;i<6500&&!rt.completed;i++){rt.step(.35);if(i%1000===999)console.log("Progress",rt.time.toFixed(1),rt.getMetrics().arrived+"/"+population);}
  const m=rt.getMetrics();assert.equal(m.arrived,population,"Every student arrives");assert.equal(m.topologyViolations,0);assert.equal(m.collisionCorrections,0);
  for(const agent of rt.getAgentSnapshots())assert(agent.position.every(Number.isFinite));
  const {SITE_LAYOUT,SHRINE_CENTER,SHRINE_CLEARANCE_RADIUS,SHRINE_ROTATION_Y,CAMPUS_AMENITIES,SITE_BOUNDARY}=require(join(temp,"building1/siteLayout.js"));
  assert.equal(SHRINE_ROTATION_Y,-Math.PI/2,"Shrine faces west");
  assert.deepEqual(map.annotations.find(a=>a.id==="site-central-shrine").rotation,[0,SHRINE_ROTATION_Y,0]);
  for(const building of CAMPUS_AMENITIES)assert.equal(map.annotations.find(a=>a.id===building.id).capacity,0,"Context has no fabricated occupancy");
  function inSite(x,z){
    let inside=false;
    for(let i=0,j=SITE_BOUNDARY.length-1;i<SITE_BOUNDARY.length;j=i++){
      const [xi,zi]=SITE_BOUNDARY[i],[xj,zj]=SITE_BOUNDARY[j];
      if((zi>z)!==(zj>z)&&x<(xj-xi)*(z-zi)/(zj-zi)+xi)inside=!inside;
    }
    return inside;
  }
  assert(SITE_LAYOUT.fieldSize[2]>SITE_LAYOUT.fieldSize[0],"Field long axis is north-south");
  assert(graph.nodes.filter(n=>n.id.startsWith("campus-parking-assembly-")).every(n=>n.position[0]<-180&&n.position[2]<0),"Assembly 2 is in the upper-left area");
  for(const e of graph.edges.filter(e=>!e.insideBuilding)){
    const pts=[nodes.get(e.from).position,...e.waypoints??[],nodes.get(e.to).position];
    for(let j=1;j<pts.length;j++)for(let k=0;k<=40;k++){
      const t=k/40,x=pts[j-1][0]+(pts[j][0]-pts[j-1][0])*t,z=pts[j-1][2]+(pts[j][2]-pts[j-1][2])*t;
      assert(Math.hypot(x-SHRINE_CENTER[0],z-SHRINE_CENTER[2])>SHRINE_CLEARANCE_RADIUS,"Evacuation path clears shrine "+e.id);
      assert(inSite(x,z),"Evacuation path stays within white perimeter "+e.id+" at "+[x,z]);
      for(const a of CAMPUS_AMENITIES)assert(Math.abs(x-a.x)>a.width/2+.18||Math.abs(z-a.z)>a.depth/2+.18,"Evacuation path clears amenity "+a.id+" on "+e.id);
    }
  }
  for(const goal of graph.nodes.filter(n=>n.type==="assembly"))assert(rt.agents.filter(a=>a.route.goalId===goal.id).length<=goal.capacity);
  for(const building of CAMPUS_BUILDINGS){
    const fireRuntime=new EvacuationRuntime();
    const room=CAMPUS_ROOMS.find(r=>r.buildingId===building.id&&r.floor===3);
    const fire=fireRuntime.addFire(room.walkPosition,{spreadRate:0});
    assert.equal(fire.floor,3);assert.equal(fire.wing,building.id);
  }
  const hazardRuntime=new EvacuationRuntime();
  assert.equal(hazardRuntime.addFire([SHRINE_CENTER[0],6,SHRINE_CENTER[2]]).floor,0,"Shrine is an outdoor site feature");
  assert.equal(hazardRuntime.addFire([-194,.2,25]).floor,0,"Parking fire is outdoors");
  const bridgeFire=hazardRuntime.addFire([-67,BLOCK_LEVELS[2]+.2,-43+BLOCK_GALLERY]);
  assert.equal(bridgeFire.floor,3);assert(Math.abs(bridgeFire.position[1]-BLOCK_LEVELS[2])<.05,"Bridge fire stays on the floor-3 deck");
  console.log(JSON.stringify({passed:true,rooms:144,campusRooms:48,nodes:graph.nodes.length,edges:graph.edges.length,geometrySamples:samples,portableBytes:blob.size,population,arrived:m.arrived,elapsed:m.elapsed,topologyViolations:m.topologyViolations}));
} finally {rmSync(temp,{recursive:true,force:true});}
