import { BLOCK_GALLERY, BLOCK_LEVELS } from "../simulation/campusData";
import { BRIDGE_FLOOR } from "../simulation/bridge";
import { useBuilding3Store } from "./building3Store";
function Box({name,p,s,color="#d7b3c6"}:{name:string;p:[number,number,number];s:[number,number,number];color?:string}){
  return <mesh name={name} position={p} castShadow receiveShadow><boxGeometry args={s}/><meshStandardMaterial color={color} roughness={.74}/></mesh>;
}
/** Straight, level and open at both ends; clear walking width 2.5 m. On floor BRIDGE_FLOOR (3). */
export function Building34Bridge(){
  const floor=useBuilding3Store(s=>s.cutawayFloor);
  if(floor>0&&floor<BRIDGE_FLOOR)return null;
  const x=-62,y=BLOCK_LEVELS[BRIDGE_FLOOR-1],z=-43+BLOCK_GALLERY,length=27;
  // Canopy stays under the next floor's gallery slab.
  const canopy=Math.min(3.1,(BLOCK_LEVELS[BRIDGE_FLOOR]??y+3.4)-y-.4);
  return <group name={`BUILDING_3_4_LEVEL_${BRIDGE_FLOOR}_BRIDGE`}>
    <Box name="B34_STRAIGHT_DECK" p={[x,y-.12,z]} s={[length,.24,2.7]} color="#dadbd4"/>
    <Box name="B34_STRAIGHT_CANOPY" p={[x,y+canopy,z]} s={[length+.5,.15,3.2]} color="#e4e7c2"/>
    {[-1,1].map(side=><group key={side}>
      <Box name="B34_HANDRAIL" p={[x,y+1.1,z+side*1.32]} s={[length,.07,.07]} color="#91a39c"/>
      {Array.from({length:25},(_,i)=><Box key={i} name="B34_BALUSTER" p={[x-length/2+i*length/24,y+.55,z+side*1.32]} s={[.045,1.1,.045]} color="#b9c6bd"/>)}
      {[-70,-62,-54].map(px=><Box key={px} name="B34_CANOPY_POST" p={[px,y+canopy/2,z+side*1.32]} s={[.12,canopy,.12]} color="#edf0e9"/>)}
    </group>)}
    {[-70,-62].map(px=><Box key={px} name="B34_SUPPORT_COLUMN" p={[px,(y-.24)/2,z]} s={[.5,y-.24,.5]}/>)}
  </group>;
}
