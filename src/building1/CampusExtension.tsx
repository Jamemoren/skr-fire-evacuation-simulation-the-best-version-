import { Component, Suspense, type ReactNode } from "react";
import { useBuilding1Store } from "./building1Store";
import { useMapperStore } from "../store";
import { EXTENSION_POSITION } from "./campusExtensionData";
import { CampusLamp } from "../components/CampusLandscape";
import { Building3Model, ClassroomBlock } from "./Building3Model";
import { Building34Bridge } from "./Building34Bridge";
import { PARKING_ROAD, PARKING_PLAZA, SITE_LAYOUT } from "./siteLayout";
import { ShrinePavilion } from "./ShrinePavilion";
import { CampusAmenities } from "./CampusAmenities";

class ExtensionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { useMapperStore.getState().addToast("error", "โหลดอาคารเพิ่มเติมไม่สำเร็จ กรุณารีเฟรชเว็บ อาคารเรียน 1 ยังใช้งานได้"); }
  render() { return this.state.failed ? null : this.props.children; }
}


function Slab({ name, position, size, color }: { name: string; position: [number, number, number]; size: [number, number, number]; color: string }) {
  return <mesh name={name} position={position} receiveShadow><boxGeometry args={size} /><meshStandardMaterial color={color} roughness={0.9} /></mesh>;
}

function ParkingRoad() {
  // Local Z follows the road; rotate it west-east to fit the marked upper-left area.
  const stalls=Array.from({length:42},(_,i)=>-60+i*3).filter(z=>Math.abs(z-56)>5);
  return <group name="PARKING_ROAD_AND_PEDESTRIAN_ASSEMBLY">
    <group position={[PARKING_ROAD.x,0,PARKING_ROAD.z]} rotation-y={Math.PI/2}>
      <Slab name="ASSEMBLY_2_ROAD_BASE" position={[0,-.12,0]} size={[34,.2,128]} color="#d0d1c8" />
      <Slab name="ASSEMBLY_2_ROAD" position={[0,.01,0]} size={[24,.08,124]} color="#858f94" />
      {[-12,12].map(x=><Slab key={x} name="PARKING_EDGE" position={[x,.065,0]} size={[.14,.02,124]} color="#f4f0dc" />)}
      {stalls.flatMap((z,i)=>[-1,1].map(side=><group key={i+"-"+side}>
        <Slab name="PARKING_BAY_LINE" position={[side*9,.065,z]} size={[6,.02,.12]} color="#e8ebdf" />
      </group>))}
      {Array.from({length:15},(_,i)=>-58+i*8).filter(z=>Math.abs(z-56)>5).map(z=><Slab key={z} name="ROAD_CENTER_DASH" position={[0,.065,z]} size={[.15,.02,4]} color="#e7d995" />)}
      {Array.from({length:15},(_,i)=><Slab key={i} name="PARKING_ZEBRA_CROSSING" position={[-11.5+i*1.6,.07,56]} size={[.8,.025,3]} color="#f4f2df" />)}
    </group>
    <Slab name="ASSEMBLY_2_PEDESTRIAN_PLAZA" position={[PARKING_PLAZA.x,.05,PARKING_PLAZA.z]} size={[PARKING_PLAZA.width,.12,PARKING_PLAZA.depth]} color="#d4d8cf" />
    <Slab name="ASSEMBLY_2_PEDESTRIAN_APPROACH" position={[-230,.12,-25]} size={[124,.02,3]} color="#bacbc1" />
    <Slab name="PARKING_PEDESTRIAN_DIVIDER" position={[-230,.12,-29.5]} size={[124,.24,.3]} color="#ebe9d8" />
    {SITE_LAYOUT.parkingZones.map(([x,,z],i)=><group key={i} name={"ASSEMBLY_2_PEDESTRIAN_ZONE_"+(i+1)}>
      <Slab name="SAFE_ZONE_PAINT" position={[x,.125,z]} size={[14,.02,18]} color="#77aa97" />
      {[-9,9].map(dz=><Slab key={dz} name="SAFE_ZONE_BOUNDARY" position={[x,.14,z+dz]} size={[14,.015,.12]} color="#f1edce" />)}
    </group>)}
  </group>;
}

/** Campus layout shares metre coordinates with the evacuation graph. */
export function CampusExtension() {
  const mode = useBuilding1Store((state) => state.viewMode);
  if (mode === "interior" || mode === "single-floor" || mode === "structure") return null;
  return <group name="CAMPUS_EXTENSION_CONTEXT">
    <Slab name="BUILDING_4_PLAZA" position={[-20, 0.03, -43]} size={[84, 0.12, 29]} color="#c5c9c6" />
    <Slab name="BUILDING_3_PLAZA" position={[-112, 0.03, -43]} size={[84,.12,29]} color="#c5c9c6" />
    <Slab name="SHRINE_PEDESTRIAN_APPROACH" position={[-141.5,.05,16]} size={[31,.12,5]} color="#c8cbc9" />
    <Slab name="CAMPUS_FIELD_APPROACH" position={[-66,.05,18.5]} size={[3.8,.12,87]} color="#d2cfc4" />
    <Slab name="CAMPUS_FIELD_TURN" position={[-37.5,.05,62]} size={[60.8,.12,3.8]} color="#d2cfc4" />
    <Slab name="PARKING_CROSSING_APPROACH" position={[-176,.045,-25]} size={[36,.12,3.8]} color="#aeb4b0" />
    <Slab name="NORTH_CAMPUS_WALK" position={[-65, .05, -25]} size={[190,.12,4]} color="#d2cfc4" />
    <ParkingRoad />
    {[-138,-96,-54,-10].map((x) => <CampusLamp key={x} position={[x,.15,-22]} />)}
    {[-132,-110,-88].map((x) => <group key={x} position={[x, 0.12, -18]} name={`NORTH_CAMPUS_SEATING_${x}`}>
      <Slab name="PLANTER" position={[0, 0.25, 0]} size={[2, 0.5, 3]} color="#aeb9ac" />
      <Slab name="GREENERY" position={[0, 0.65, 0]} size={[1.7, 0.45, 2.7]} color="#518349" />
      <Slab name="BENCH" position={[2.5, 0.45, 0]} size={[0.65, 0.18, 2.7]} color="#826953" />
    </group>)}
    <ExtensionBoundary><Suspense fallback={null}><ClassroomBlock number={4} position={EXTENSION_POSITION} /></Suspense></ExtensionBoundary>
    <ExtensionBoundary><Suspense fallback={null}><Building3Model /></Suspense></ExtensionBoundary>
    <Building34Bridge />
    <ShrinePavilion />
    <CampusAmenities />
  </group>;
}
