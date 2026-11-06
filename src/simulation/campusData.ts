import { CLASSROOMS, TARGET_POPULATION, balancedOccupancyAt, type RoomModuleDefinition } from "../building1/building1Data";
import type { Vec3 } from "./types";
import { SITE_LAYOUT, type SiteLayout } from "../building1/siteLayout";

export const BLOCK_SCALE=.416;
export const BLOCK_CX=-9.367340088;
export const BLOCK_CZ=2.737880974;
export const BLOCK_LEVELS=[.16,11.43*11.2/28.2,19.8*11.2/28.2,28.233*11.2/28.2];
export const BLOCK_GALLERY=(10-BLOCK_CZ)*BLOCK_SCALE;
export const BLOCK_FRONT=(8-BLOCK_CZ)*BLOCK_SCALE;
export const BLOCK_BACK=(-2-BLOCK_CZ)*BLOCK_SCALE;
export const BLOCK_STAIRS=[-53,53].map(x=>(x-BLOCK_CX)*BLOCK_SCALE);
export function campusBuildingsFor(layout: SiteLayout) {
  return [{id:"building-3",number:3,x:layout.buildingX[3],z:-43},{id:"building-4",number:4,x:layout.buildingX[4],z:-43}] as const;
}
export const CAMPUS_BUILDINGS=campusBuildingsFor(SITE_LAYOUT);
export const BLOCK_ROOMS_SOURCE=[[-80,-57.7,-68],[-45.5,-33.9,-42.8],[-30.9,-18.4,-27.2],[-15.6,-2,-11.6],[1.1,15.2,5.4],[18.4,30.8,22],[34,46,37.8],[60,80,69]];
export function campusRoomsFor(layout: SiteLayout): RoomModuleDefinition[] {return campusBuildingsFor(layout).flatMap(b=>[2,3,4].flatMap(floor=>BLOCK_ROOMS_SOURCE.map(([a,c,door],index)=>({
  id:`b${b.number}-f${floor}-room-${index+1}`,name:`อาคาร ${b.number} ชั้น ${floor} ห้อง ${index+1}`,buildingId:b.id,floor,side:"pink" as const,index,
  position:[b.x+((a+c)/2-BLOCK_CX)*BLOCK_SCALE,BLOCK_LEVELS[floor-1]+1.5,b.z+(-3.5-BLOCK_CZ)*BLOCK_SCALE] as Vec3,
  walkPosition:[b.x+(door-BLOCK_CX)*BLOCK_SCALE,BLOCK_LEVELS[floor-1]+.2,b.z+(-3.5-BLOCK_CZ)*BLOCK_SCALE] as Vec3,
  doorPosition:[b.x+(door-BLOCK_CX)*BLOCK_SCALE,BLOCK_LEVELS[floor-1]+.2,b.z+(8.7-BLOCK_CZ)*BLOCK_SCALE] as Vec3,
  rotation:[0,0,0] as Vec3,size:[(c-a)*BLOCK_SCALE,3.2,9.2] as Vec3,roomType:"classroom" as const,peopleCount:0,capacity:40,
}))));}
export const CAMPUS_ROOMS=campusRoomsFor(SITE_LAYOUT);
export const ALL_CLASSROOMS: RoomModuleDefinition[]=[...CLASSROOMS.map(r=>({...r,buildingId:"building-1"})),...CAMPUS_ROOMS].map((r,i,a)=>({...r,peopleCount:balancedOccupancyAt(i,TARGET_POPULATION,a.length)}));
export function campusBuildingAt(p:Vec3) {
  const building=CAMPUS_BUILDINGS.find(b=>Math.abs(p[0]-b.x)<42 && p[2]>b.z-10 && p[2]<b.z+10);
  const onBridge=p[0]>-75.6 && p[0]<-48.4 && Math.abs(p[2]-(-43+BLOCK_GALLERY))<1.4 && p[1]>=BLOCK_LEVELS[3]-.4;
  return building ?? (onBridge ? CAMPUS_BUILDINGS[0] : undefined);
}
export function campusFloorAt(p:Vec3):number|undefined {
  if(!campusBuildingAt(p))return undefined;
  for(let i=3;i>=0;i--)if(p[1]>=BLOCK_LEVELS[i]-.2)return i+1;
  return 1;
}
export function campusStairPoints(building:typeof CAMPUS_BUILDINGS[number],center:number,upperFloor:number):Vec3[] {
  const upper=BLOCK_LEVELS[upperFloor-1]+.2,lower=BLOCK_LEVELS[upperFloor-2]+.2,mid=(upper+lower)/2;
  const p=(x:number,y:number,z:number):Vec3=>[building.x+x,y,building.z+z];
  return [p(center,upper,BLOCK_GALLERY),p(center+1.28,upper,BLOCK_FRONT),p(center+1.28,mid,BLOCK_BACK),p(center+1.28,mid,BLOCK_BACK-.5),p(center-1.28,mid,BLOCK_BACK-.5),p(center-1.28,mid,BLOCK_BACK),p(center-1.28,lower,BLOCK_FRONT),p(center,lower,BLOCK_GALLERY)];
}
