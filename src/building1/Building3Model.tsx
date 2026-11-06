import { useGLTF } from "@react-three/drei";
import { useLayoutEffect, useMemo, useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useMapperStore } from "../store";
import { BLOCK_LEVELS } from "../simulation/campusData";
import { BUILDING3_MODEL_URL, BUILDING3_POSITION } from "./campusExtensionData";
import { useBuilding3Store } from "./building3Store";
import type { Vec3 } from "../types";

/** Both buildings share one asset, with independent clipping materials. */
export function ClassroomBlock({ number, position }: { number: 3 | 4; position: Vec3 }) {
  const { scene } = useGLTF(BUILDING3_MODEL_URL);
  const floor = useBuilding3Store(s => s.buildingNumber===number ? s.cutawayFloor : 0);
  const calibration = useMapperStore(s => s.calibration);
  const gl = useThree(s => s.gl);
  const { copy, materials, capGeometry } = useMemo(() => {
    const copy = scene.clone(true), materials: THREE.Material[] = [];
    // The bridge uses the inner end; close the unused outer portal with matching plaster.
    const capGeometry=new THREE.BoxGeometry(.28,14.1-(BLOCK_LEVELS[3]+.025),2.75);
    let facade: THREE.Material | undefined;
    copy.traverse(o=>{if(o instanceof THREE.Mesh){const m=Array.isArray(o.material)?o.material:[o.material];facade??=m.find(m=>m.name==="Reference pink facade");}});
    const cap=new THREE.Mesh(capGeometry,facade);
    cap.name="COMPLETE_OUTER_END_WALL";
    cap.position.set(number===3?-38:38,(14.1+BLOCK_LEVELS[3]+.025)/2,3.025);
    copy.add(cap);
    copy.traverse(o => { if (o instanceof THREE.Mesh) {
      const clone = (m: THREE.Material) => {
        const c=m.clone();
        // Thin double-sided roof faces otherwise shadow themselves in long stripes.
        if(c.name==="Pale cream pitched roof")c.shadowSide=THREE.BackSide;
        materials.push(c);return c;
      };
      o.material=Array.isArray(o.material)?o.material.map(clone):clone(o.material);
      o.castShadow=true;o.receiveShadow=true;
    }});
    return { copy, materials, capGeometry };
  }, [scene,number]);
  useEffect(()=>()=>{materials.forEach(m=>m.dispose());capGeometry.dispose();},[materials,capGeometry]);
  useLayoutEffect(()=>{
    gl.localClippingEnabled=true;
    const transform=new THREE.Matrix4().compose(new THREE.Vector3(...calibration.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...calibration.rotation)),new THREE.Vector3().setScalar(calibration.scale));
    const cut=new THREE.Plane(new THREE.Vector3(0,-1,0),BLOCK_LEVELS[Math.max(0,floor-1)]+1.8).applyMatrix4(transform);
    materials.forEach(m=>{m.clippingPlanes=floor?[cut]:[];m.clipShadows=true;m.needsUpdate=true;});
    gl.shadowMap.needsUpdate=true;
  },[floor,materials,gl,calibration]);
  const texture=useMemo(()=>{
    const canvas=document.createElement("canvas");canvas.width=768;canvas.height=144;
    const ctx=canvas.getContext("2d");
    if(ctx){ctx.fillStyle="#7d5470";ctx.fillRect(0,0,768,144);ctx.textAlign="center";ctx.fillStyle="white";ctx.font='600 68px "Leelawadee UI", sans-serif';ctx.fillText("อาคาร "+number,384,92);}
    const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;return map;
  },[number]);
  useEffect(()=>()=>texture.dispose(),[texture]);
  return <group name={"BUILDING_"+number} position={position}>
    <primitive object={copy} dispose={null} />
    <mesh name={"BUILDING_"+number+"_SIGN"} position={[0,3.3,7.65]}><planeGeometry args={[5.6,1.05]} /><meshBasicMaterial map={texture} toneMapped={false} /></mesh>
  </group>;
}
export function Building3Model(){return <ClassroomBlock number={3} position={BUILDING3_POSITION} />;}
