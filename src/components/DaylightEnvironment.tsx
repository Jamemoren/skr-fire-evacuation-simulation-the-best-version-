import { Sky } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useQualityStore } from "../rendering/qualityStore";
import { QUALITY_PRESETS } from "../rendering/qualityPolicy";

export function DaylightEnvironment() {
  const tier = useQualityStore((state) => state.tier);
  const quality = QUALITY_PRESETS[tier];
  const sun = useRef<THREE.DirectionalLight>(null);
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    if (sun.current) { sun.current.shadow.map?.dispose(); sun.current.shadow.map = null; }
    gl.shadowMap.needsUpdate = true;
  }, [gl, tier]);
  return (
    <>
      <color attach="background" args={["#6ec5f5"]} />
      <fog attach="fog" args={["#c3e6f2", 520, 1800]} />

      <ambientLight intensity={0.38} color="#eef8ff" />
      <hemisphereLight args={["#e7f6ff", "#60845c", 1.18]} />
      <directionalLight
        ref={sun}
        position={[132, 154, 72]}
        intensity={2.5}
        color="#fff0d5"
        castShadow={quality.shadows}
        shadow-mapSize-width={quality.shadowSize}
        shadow-mapSize-height={quality.shadowSize}
        shadow-camera-near={1}
        shadow-camera-far={620}
        shadow-camera-left={-210}
        shadow-camera-right={210}
        shadow-camera-top={210}
        shadow-camera-bottom={-210}
        shadow-bias={-0.00006}
      />
      <directionalLight position={[-110, 94, -95]} intensity={0.5} color="#acd7f6" />

      <Sky
        distance={450000}
        sunPosition={[132, 94, 48]}
        inclination={0.55}
        azimuth={0.17}
        turbidity={2.1}
        rayleigh={1.8}
        mieCoefficient={0.0062}
        mieDirectionalG={0.84}
      />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.09, 70]} receiveShadow>
        <planeGeometry args={[1050, 1050]} />
        <meshStandardMaterial color="#d5e7d9" roughness={0.98} metalness={0} side={THREE.DoubleSide} />
      </mesh>
    </>
  );
}
