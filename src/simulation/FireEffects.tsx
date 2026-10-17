import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { flameCellsAt, type FlameCell } from "./fireField";
import { evacuationRuntime } from "./runtime";
import { useEvacuationStore } from "./simulationStore";
import { useQualityStore } from "../rendering/qualityStore";
import { useBuilding1Store } from "../building1/building1Store";
import { uploadInstanceRange } from "../rendering/instanceBuffers";
import { yOffsetForRender } from "./studentVisibility";
import { activeFrameDelta } from "../rendering/frameClock";

const vertexShader = `
  uniform float uTime;
  varying float vHeight;
  varying float vPhase;
  void main() {
    vec3 p = position;
    vHeight = clamp(p.y, 0.0, 1.0);
    vPhase = instanceMatrix[3].x * 1.73 + instanceMatrix[3].z * 2.31;
    float tip = vHeight * vHeight;
    p.x += sin(uTime * 5.1 + vPhase + vHeight * 8.0) * .16 * tip;
    p.z += cos(uTime * 4.3 + vPhase * 1.3 + vHeight * 6.0) * .13 * tip;
    p.y *= .95 + sin(uTime * 7.1 + vPhase) * .05;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const fragmentShader = `
  precision highp float;
  uniform float uTime;
  varying float vHeight;
  varying float vPhase;
  void main() {
    float turbulence = sin(vHeight * 23.0 - uTime * 8.0 + vPhase) * .5 + .5;
    float hot = pow(1.0 - vHeight, .8);
    vec3 orange = vec3(1.0, .22, .018);
    vec3 yellow = vec3(1.0, .78, .15);
    vec3 color = mix(orange, yellow, hot * (.6 + turbulence * .32));
    float alpha = (.77 + turbulence * .15) * (1.0 - smoothstep(.83, 1.0, vHeight));
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One flame field for every quality tier. Only decorative tongues/smoke are reduced.
 * The large base cone contains the contact core used by fireField.ts.
 */
export function FireEffects() {
  const fires = useEvacuationStore((state) => state.fires);
  const showFire = useEvacuationStore((state) => state.showFire);
  const showSmoke = useEvacuationStore((state) => state.showSmoke);
  const tier = useQualityStore((state) => state.tier);
  const viewMode = useBuilding1Store((state) => state.viewMode);
  const selectedFloor = useBuilding1Store((state) => state.selectedFloor);
  const explodeFloors = useBuilding1Store((state) => state.explodeFloors);
  const buildingView = { viewMode, selectedFloor, explodeFloors };
  const visibleFloor = (floor: number) => yOffsetForRender(floor, buildingView) !== null;
  const gl = useThree((state) => state.gl);
  const capacity = Math.max(8192, fires.reduce((sum, fire) => sum + Math.ceil(4 * (fire.fireRadius / .4) ** 2) + 256, 4096));
  const flames = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.InstancedMesh>(null);
  const smoke = useRef<THREE.InstancedMesh>(null);
  const material = useRef<THREE.ShaderMaterial>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);
  const geometry = useMemo(() => new THREE.ConeGeometry(1, 1, 9, 5).translate(0, .5, 0), []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const smokeCells = useRef<FlameCell[]>([]);
  const previousField = useRef<{
    time: number; sources: typeof evacuationRuntime.fires; sourceCount: number; signature: string;
    flames: THREE.InstancedMesh; glow: THREE.InstancedMesh; smoke: THREE.InstancedMesh;
  } | null>(null);
  const fieldWork = useRef({ fieldUpdates: 0, smokeUpdates: 0, activeUploadBytes: 0, reportedAt: -Infinity });
  const frameClock = useRef(0);
  useFrame((_state, delta) => {
    if (document.hidden) return;
    frameClock.current += activeFrameDelta(delta);
    if (!flames.current || !glow.current || !smoke.current) return;
    const time = evacuationRuntime.time;
    const animationTime = frameClock.current;
    const sources = evacuationRuntime.fires;
    const signature = [tier, viewMode, selectedFloor, explodeFloors, showFire, showSmoke].join("|");
    const previous = previousField.current;
    const fieldChanged = !previous || (sources.length > 0 && previous.time !== time) || previous.sources !== sources
      || previous.sourceCount !== sources.length || previous.signature !== signature
      || previous.flames !== flames.current || previous.glow !== glow.current || previous.smoke !== smoke.current;
    // Flame flicker runs in the shader every frame. Geometry changes only when the
    // physical field or the selected view changes; no contact cells are dropped.
    if (fieldChanged) {
      previousField.current = { time, sources, sourceCount: sources.length, signature,
        flames: flames.current, glow: glow.current, smoke: smoke.current };
      fieldWork.current.fieldUpdates += 1;
      smokeCells.current.length = 0;
      let flameCount = 0, glowCount = 0, cellCount = 0;
      const lobes = tier === "high" ? 3 : tier === "balanced" ? 2 : 1;
      for (const fire of sources) {
        for (const cell of flameCellsAt(fire, time)) {
          cellCount++;
          const floorOffset = yOffsetForRender(cell.floor, buildingView);
          if (floorOffset === null) continue;
          if (showFire) {
            for (let lobe = 0; lobe < lobes; lobe++) {
              const phase = cell.seed * 2.399963 + lobe * 2.1;
              const secondary = lobe > 0;
              dummy.position.set(cell.position[0] + (secondary ? Math.sin(phase) * cell.radius * .35 : 0),
                cell.position[1] + floorOffset, cell.position[2] + (secondary ? Math.cos(phase) * cell.radius * .35 : 0));
              dummy.rotation.set(0, phase, 0);
              const width = cell.radius * (secondary ? .43 : 1);
              dummy.scale.set(width, cell.height * (secondary ? 1.1 : 1), width);
              dummy.updateMatrix();
              flames.current.setMatrixAt(flameCount++, dummy.matrix);
            }
            dummy.position.set(cell.position[0], cell.position[1] + floorOffset + .012, cell.position[2]);
            dummy.rotation.set(-Math.PI / 2, 0, 0);
            dummy.scale.setScalar(cell.radius * 1.05);
            dummy.updateMatrix(); glow.current.setMatrixAt(glowCount++, dummy.matrix);
          }
          if (showSmoke && cell.seed % (tier === "economy" ? 11 : 6) === 0) smokeCells.current.push(cell);
        }
      }
      fieldWork.current.activeUploadBytes += uploadInstanceRange(flames.current, flameCount)
        + uploadInstanceRange(glow.current, glowCount);
      smoke.current.count = smokeCells.current.length;
      gl.domElement.dataset.simFireField = JSON.stringify({ time, cells: cellCount, renderedCells: glowCount,
        sources: sources.length, geometry: "shared-visible-flame-cells", tier });
    }
    if (material.current) material.current.uniforms.uTime.value = animationTime % (Math.PI * 20);
    if (smokeCells.current.length) {
      let smokeCount = 0;
      for (const cell of smokeCells.current) {
        const cycle = (animationTime * .12 + cell.seed * .137) % 1;
        const floorOffset = yOffsetForRender(cell.floor, buildingView) ?? 0;
        dummy.position.set(cell.position[0] + cycle * .35, cell.position[1] + floorOffset + cell.height * .7 + cycle * 1.5, cell.position[2]);
        dummy.rotation.set(0, cell.seed, cycle * .2);
        const size = .22 + cell.radius * (1.1 + cycle);
        dummy.scale.set(size * 1.12, size * .8, size);
        dummy.updateMatrix(); smoke.current.setMatrixAt(smokeCount++, dummy.matrix);
      }
      fieldWork.current.smokeUpdates += 1;
      fieldWork.current.activeUploadBytes += uploadInstanceRange(smoke.current, smokeCount);
    }
    if (animationTime - fieldWork.current.reportedAt >= 0.5) {
      fieldWork.current.reportedAt = animationTime;
      const { fieldUpdates, smokeUpdates, activeUploadBytes } = fieldWork.current;
      gl.domElement.dataset.simFireWork = JSON.stringify({ fieldUpdates, smokeUpdates, activeUploadBytes });
    }
  });
  return <group name="SIM_SHARED_VISIBLE_FLAME_FIELD">
    <instancedMesh ref={flames} geometry={geometry} args={[undefined, undefined, capacity * 3]} count={0} frustumCulled={false} renderOrder={8}>
      <shaderMaterial ref={material} uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader}
        transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
    </instancedMesh>
    <instancedMesh ref={glow} args={[undefined, undefined, capacity]} count={0} frustumCulled={false} renderOrder={7}>
      <circleGeometry args={[1, 12]} /><meshBasicMaterial color="#ed6418" transparent opacity={.17} depthWrite={false} side={THREE.DoubleSide} />
    </instancedMesh>
    <instancedMesh ref={smoke} args={[undefined, undefined, capacity]} count={0} frustumCulled={false} renderOrder={6}>
      <icosahedronGeometry args={[1, 1]} /><meshBasicMaterial color="#5c6265" transparent opacity={.11} depthWrite={false} />
    </instancedMesh>
    {fires.filter((fire) => fire.origin === "primary" && fire.enabled && visibleFloor(fire.floor)).map((fire, i) => <group key={fire.id} position={[fire.position[0], fire.position[1] + (yOffsetForRender(fire.floor, buildingView) ?? 0), fire.position[2]]}>
      {showFire && tier !== "economy" && i < 2 && <pointLight position={[0, .8, 0]} color="#ff8c2e" intensity={1.8} distance={7} decay={2} />}
      <Html center position={[0, 3, 0]} distanceFactor={9}>
        <div className="sim-world-fire-label"><strong>จุดต้นเพลิง</strong><span>{fire.floor ? `ชั้น ${fire.floor}` : "ภายนอกอาคาร"} · กำลังลาม</span></div>
      </Html>
    </group>)}
  </group>;
}
