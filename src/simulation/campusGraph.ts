import { campusBuildingsFor, campusRoomsFor, BLOCK_LEVELS, BLOCK_GALLERY, BLOCK_STAIRS, campusStairPoints } from "./campusData";
import type { SimGraph, SimNode, SimEdge, Vec3 } from "./types";
import { SITE_LAYOUT, parkingApproach, type SiteLayout } from "../building1/siteLayout";

/** Same model-metre calibration as the shared block asset; every bend is an explicit waypoint. */
export function appendCampusGraph(graph:SimGraph,layout:SiteLayout=SITE_LAYOUT):SimGraph {
  const CAMPUS_BUILDINGS=campusBuildingsFor(layout),CAMPUS_ROOMS=campusRoomsFor(layout);
  const nodes:SimNode[]=[...graph.nodes],edges:SimEdge[]=[...graph.edges];
  const node=(id:string,name:string,type:SimNode["type"],position:Vec3,floor:number,wing:SimNode["wing"],phase:SimNode["phase"],capacity=12)=>{nodes.push({id,name,type,position,floor,wing,phase,capacity});return id;};
  const edge=(id:string,from:string,to:string,kind:SimEdge["kind"],width:number,waypoints:Vec3[]=[],twoWay=true,insideBuilding=true)=>{
    const a=nodes.find(n=>n.id===from)!,b=nodes.find(n=>n.id===to)!;const pts=[a.position,...waypoints,b.position];
    edges.push({id,from,to,kind,width,waypoints,twoWay,insideBuilding,distance:pts.slice(1).reduce((s,p,i)=>s+Math.hypot(...p.map((v,j)=>v-pts[i][j]) as Vec3),0),floorFrom:a.floor,floorTo:b.floor,capacityPerSecond:Math.max(.8,width*1.1),speedMultiplier:kind==="stair"?.55:1});
  };
  for(const b of CAMPUS_BUILDINGS){
    const wing=b.id;const columns=[...new Set([...CAMPUS_ROOMS.filter(r=>r.buildingId===b.id&&r.floor===2).map(r=>r.doorPosition![0]-b.x),...BLOCK_STAIRS,-28.5,36.5])].sort((a,c)=>a-c);
    for(let f=1;f<=4;f++){
      const ids=columns.map((x,i)=>node(`campus-b${b.number}-f${f}-gallery-${i}`,`ตึก ${b.number} ชั้น ${f} ระเบียง ${i+1}`,"corridor",[b.x+x,BLOCK_LEVELS[f-1]+.2,b.z+BLOCK_GALLERY],f,wing,f===1?"ground":"corridor"));
      for(let i=1;i<ids.length;i++)edge(`campus-b${b.number}-f${f}-gallery-edge-${i}`,ids[i-1],ids[i],f===1?"exit":"corridor",1.15);
      for(const room of CAMPUS_ROOMS.filter(r=>r.buildingId===b.id&&r.floor===f)){
        node(room.id,room.name,"room",room.walkPosition!,f,wing,"room",40);
        const door=node(`sim-door-${room.id}`,`ประตู ${room.name}`,"door",room.doorPosition!,f,wing,"room",1.1);
        const g=ids[columns.reduce((best,x,i)=>Math.abs(x-(room.doorPosition![0]-b.x))<Math.abs(columns[best]-(room.doorPosition![0]-b.x))?i:best,0)];
        edge(`campus-door-${room.id}`,room.id,door,"room",1.0,[],false);
        edge(`campus-door-gallery-${room.id}`,door,g,"corridor",1.0,[],false);
      }
      for(let s=0;s<2;s++){
        const x=BLOCK_STAIRS[s],g=ids[columns.indexOf(x)];
        const stair=node(`campus-b${b.number}-stair-${s}-f${f}`,`บันได ${s+1} อาคาร ${b.number} ชั้น ${f}`,"stair",[b.x+x,BLOCK_LEVELS[f-1]+.2,b.z+BLOCK_GALLERY-.08],f,wing,f===1?"ground":"stair",2.1);
        edge(`campus-b${b.number}-stair-access-${s}-f${f}`,g,stair,f===1?"exit":"junction",1.15);
        if(f>1)edge(`campus-b${b.number}-stair-${s}-down-${f}`,stair,`campus-b${b.number}-stair-${s}-f${f-1}`,"stair",1.5,campusStairPoints(b,x,f).slice(1,-1),false);
        if(f===1){
          const exit=node(`campus-b${b.number}-exit-${s}`,`ช่องทางออกตึก ${b.number} บันได ${s+1}`,"door",[b.x+x,.36,-30],1,wing,"ground",3);
          const exterior=node(`campus-b${b.number}-exterior-${s}`,`พ้นอาคาร ${b.number} บันได ${s+1}`,"exit",[b.x+x,.36,-28],1,wing,"ground",3);
          const apron=node(`campus-b${b.number}-apron-${s}`,`ลานหน้าตึก ${b.number}`,"gate",[b.x+x,.22,-25],0,"outdoor","outdoor",6);
          edge(`campus-b${b.number}-exit-door-${s}`,stair,exit,"exit",2.1,[],false);
          edge(`campus-b${b.number}-exit-threshold-${s}`,exit,exterior,"exit",2.1,[],false,false);
          edge(`campus-b${b.number}-exit-out-${s}`,exterior,apron,"outdoor",2.1,[],false,false);
        }
      }
    }
  }
  const gallery=(b:number,x:number)=>nodes.filter(n=>n.id.startsWith(`campus-b${b}-f4-gallery-`)).sort((a,c)=>Math.abs(a.position[0]-x)-Math.abs(c.position[0]-x))[0].id;
  const leftBuilding=layout.buildingX[3]<layout.buildingX[4]?3:4,rightBuilding=leftBuilding===3?4:3;
  edge('campus-straight-bridge-level-4',gallery(leftBuilding,-75.5),gallery(rightBuilding,-48.5),'corridor',2.5);
  node('campus-north-walk','ทางเดินหน้าตึก 3–4','gate',[layout.campusWalkX,.22,-25],0,'outdoor','outdoor',20);
  node('campus-parking-crossing','ทางข้ามถนนจอดรถ','gate',[-158,.22,-25],0,'outdoor','outdoor',12);
  for(const b of CAMPUS_BUILDINGS)for(let s=0;s<2;s++){
    edge(`campus-b${b.number}-to-field-${s}`,`campus-b${b.number}-apron-${s}`,'campus-north-walk','assembly',2.7,[],true,false);
    edge(`campus-b${b.number}-to-parking-${s}`,`campus-b${b.number}-apron-${s}`,'campus-parking-crossing','assembly',2.7,[],true,false);
  }
  edge('campus-to-field-north','campus-north-walk','sim-field-gate-left','assembly',3,[[layout.campusWalkX,.22,62],[-9,.22,62]],false,false);
  for(let i=0;i<3;i++){
    const position=layout.parkingZones[i];
    node(`campus-parking-assembly-${i+1}`,`จุดรวมพล 2 · เขตคนเดิน ${i+1}`,'assembly',position,0,'assembly','assembly',100);
    edge(`campus-parking-safe-route-${i+1}`,'campus-parking-crossing',`campus-parking-assembly-${i+1}`,'assembly',2.5,parkingApproach(position,layout),false,false);
  }
  return {nodes,edges};
}
