import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Vec3 } from "../types";

/** Merge static architecture by finish, keeping the campus inexpensive to draw. */
export function siteGeometry(name: string) {
  const group = new THREE.Group(); group.name = name;
  const batches = new Map<THREE.MeshStandardMaterial, THREE.BufferGeometry[]>();
  const materials: THREE.MeshStandardMaterial[] = [];
  function finish(name: string, color: string, paint = false) {
    const mat = new THREE.MeshStandardMaterial({name, color, roughness: .88,
      polygonOffset: paint, polygonOffsetFactor: paint ? -1 : 0, polygonOffsetUnits: paint ? -2 : 0});
    materials.push(mat); return mat;
  }
  function add(geometry: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial, position: Vec3 = [0,0,0], yaw = 0) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    g.rotateY(yaw); g.translate(...position);
    const batch = batches.get(mat) ?? []; batch.push(g); batches.set(mat, batch);
  }
  const box = (mat: THREE.MeshStandardMaterial, position: Vec3, size: Vec3, yaw = 0) => add(new THREE.BoxGeometry(...size), mat, position, yaw);
  function roof(mat: THREE.MeshStandardMaterial, x: number, z: number, width: number, depth: number, eave: number, rise: number) {
    const w=width/2,d=depth/2, ridge=Math.max(0,d-w*.5);
    const v: Vec3[]=[[-w,eave,-d],[w,eave,-d],[w,eave,d],[-w,eave,d],[0,eave+rise,-ridge],[0,eave+rise,ridge]];
    const positions = [0,4,1, 1,4,5, 1,5,2, 2,5,3, 3,5,4, 3,4,0].flatMap(i=>v[i]);
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
    g.computeVertexNormals();
    // All four roof faces remain visible from both above and a low courtyard camera.
    mat.side=THREE.DoubleSide;mat.shadowSide=THREE.BackSide;add(g,mat,[x,0,z]);
  }
  function build() {
    for (const [mat, parts] of batches) {
      const geometry=mergeGeometries(parts); parts.forEach(g=>g.dispose());
      if (!geometry) throw new Error("Cannot merge campus geometry: "+mat.name);
      const mesh=new THREE.Mesh(geometry,mat);mesh.name=mat.name;
      mesh.castShadow=!mat.polygonOffset;mesh.receiveShadow=true; group.add(mesh);
    }
    return {group, dispose:()=>{group.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();});materials.forEach(m=>m.dispose());}};
  }
  return {finish,add,box,roof,build};
}
