import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";

type TreeSpec = [x: number, z: number, scale: number, hue: number];

const TREE_SPECS: TreeSpec[] = [
  [-70.6, -16, 1.15, 0], // kept 4.6 m off the campus north walk (x=-66), whose path it used to block [-55, -18, 0.9, 1], [-43, -17, 1.05, 2], [-30, -18, 0.82, 0], [-17, -19, 1.08, 1],
  [16, -15, 0.92, 2], [27, -9, 1.12, 0], [34, 3, 0.86, 1], [38, 17, 1.08, 2], [41, 34, 0.96, 0],
  [-88, -5, 0.86, 1], [-78, -5, 1.0, 2], [-68, -5, 0.94, 0],
  [-31, 82, .72, 2], [-31, 106, .76, 0], [-31, 134, .7, 1], [-31, 159, .78, 2],
  [-21, 174, .8, 1], [0, 174, .76, 2], [21, 174, .82, 0],
  [58, 82, .9, 0],
  [30, 55, 0.76, 1], [20, 56, 0.82, 2], [-46, 55, 0.8, 0], [-56, 47, 0.76, 1],
];

function InstancedTrees() {
  const trunks = useRef<THREE.InstancedMesh | null>(null);
  const lowerCrowns = useRef<THREE.InstancedMesh | null>(null);
  const upperCrowns = useRef<THREE.InstancedMesh | null>(null);

  useLayoutEffect(() => {
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const lowerColors = ["#39754d", "#47864e", "#326d51"];
    const upperColors = ["#79aa55", "#69a15c", "#88ad58"];
    TREE_SPECS.forEach(([x, z, scale, hue], index) => {
      const yaw = ((index * 37) % 360) * Math.PI / 180;
      quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));

      matrix.compose(new THREE.Vector3(x, 1.65 * scale, z), quaternion, new THREE.Vector3(0.8 * scale, 3.3 * scale, 0.8 * scale));
      trunks.current?.setMatrixAt(index, matrix);

      matrix.compose(new THREE.Vector3(x, 4.4 * scale, z), quaternion, new THREE.Vector3(2.7 * scale, 2.25 * scale, 2.7 * scale));
      lowerCrowns.current?.setMatrixAt(index, matrix);

      matrix.compose(new THREE.Vector3(x + 0.25 * scale, 6.0 * scale, z - 0.15 * scale), quaternion, new THREE.Vector3(2.05 * scale, 1.9 * scale, 2.05 * scale));
      upperCrowns.current?.setMatrixAt(index, matrix);
      lowerCrowns.current?.setColorAt(index, new THREE.Color(lowerColors[hue]));
      upperCrowns.current?.setColorAt(index, new THREE.Color(upperColors[hue]));
    });

    [trunks.current, lowerCrowns.current, upperCrowns.current].forEach((mesh) => {
      if (!mesh) return;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }, []);

  return (
    <group name="CAMPUS_MATURE_TREES">
      <instancedMesh ref={trunks} args={[undefined, undefined, TREE_SPECS.length]} castShadow receiveShadow>
        <cylinderGeometry args={[0.3, 0.52, 1, 9]} />
        <meshStandardMaterial color="#70523a" roughness={0.96} />
      </instancedMesh>
      <instancedMesh ref={lowerCrowns} args={[undefined, undefined, TREE_SPECS.length]} castShadow>
        <dodecahedronGeometry args={[1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.94} />
      </instancedMesh>
      <instancedMesh ref={upperCrowns} args={[undefined, undefined, TREE_SPECS.length]}>
        <icosahedronGeometry args={[1, 2]} />
        <meshStandardMaterial color="#ffffff" roughness={0.93} />
      </instancedMesh>
    </group>
  );
}

export function CampusLamp({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 2.8, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.09, 5.6, 10]} />
        <meshStandardMaterial color="#44545b" metalness={0.72} roughness={0.33} />
      </mesh>
      <mesh position={[0, 5.6, 0]} castShadow>
        <boxGeometry args={[0.48, 0.16, 0.26]} />
        <meshStandardMaterial color="#273941" metalness={0.48} roughness={0.36} />
      </mesh>
      <mesh position={[0, 5.49, 0]}>
        <boxGeometry args={[0.38, 0.035, 0.18]} />
        <meshStandardMaterial color="#fff4cf" emissive="#ffe9ae" emissiveIntensity={0.52} />
      </mesh>
    </group>
  );
}

export function CampusLandscape() {
  return (
    <group name="CAMPUS_LANDSCAPE">
      <mesh name="EVACUATION_PROMENADE" position={[-8.5, 0.06, 38]} receiveShadow>
        <boxGeometry args={[6.8, 0.1, 48]} />
        <meshStandardMaterial color="#c8c5bb" roughness={0.88} />
      </mesh>
      <mesh name="PROMENADE_CENTER_GUIDE" position={[-8.5, 0.118, 38]} receiveShadow>
        <boxGeometry args={[0.11, 0.018, 48]} />
        <meshStandardMaterial color="#e6d36b" roughness={0.78} />
      </mesh>

      {[-12.05, -4.95].map((x) => (
        <mesh key={x} position={[x, 0.11, 38]} castShadow receiveShadow>
          <boxGeometry args={[0.18, 0.22, 48]} />
          <meshStandardMaterial color="#ece9df" roughness={0.84} />
        </mesh>
      ))}

      <mesh name="CAMPUS_ACCESS_ROAD" position={[31.5, 0.045, 83]} receiveShadow>
        <boxGeometry args={[9, 0.08, 180]} />
        <meshStandardMaterial color="#687176" roughness={0.95} />
      </mesh>
      <mesh name="ROAD_CENTER_LINE" position={[31.5, 0.094, 83]} receiveShadow>
        <boxGeometry args={[0.12, 0.016, 176]} />
        <meshStandardMaterial color="#f1d65d" roughness={0.72} />
      </mesh>

      {[-51, -42, -33, -24, 8, 17, 26].map((x) => (
        <mesh key={x} position={[x, 0.12, 57.2]} castShadow receiveShadow>
          <boxGeometry args={[5.2, 0.24, 1.05]} />
          <meshStandardMaterial color="#315d3b" roughness={0.96} />
        </mesh>
      ))}

      {[
        [-12.7, 16, 0], [-4.3, 27, Math.PI], [-12.7, 39, 0], [-4.3, 50, Math.PI],
        [27, 17, Math.PI / 2], [27, 46, Math.PI / 2], [27, 75, Math.PI / 2],
      ].map(([x, z, rotation], index) => (
        <CampusLamp key={index} position={[x, 0, z]} rotation={rotation} />
      ))}

      <InstancedTrees />
    </group>
  );
}
