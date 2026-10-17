import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useBuilding1Store } from "./building1Store";

/** Small architectural accents above head height, outside the evacuation collision surface. */
export function CampusIdentity() {
  const mode = useBuilding1Store((state) => state.viewMode);
  const sign = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1536; canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#153f5a"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.textAlign = "center";
      context.fillStyle = "#ffffff";
      context.font = '600 49px "Leelawadee UI", "Noto Sans Thai", sans-serif';
      context.fillText("โรงเรียนสวนกุหลาบวิทยาลัย รังสิต", 768, 62);
      context.fillStyle = "#afdae7";
      context.font = '500 22px "Segoe UI", sans-serif';
      context.fillText("SUANKULARB WITTAYALAI RANGSIT  ·  BUILDING 1", 768, 103);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
  useEffect(() => () => sign.dispose(), [sign]);
  if (mode === "interior" || mode === "single-floor" || mode === "structure") return null;
  return (
    <group name="CAMPUS_ARCHITECTURAL_IDENTITY">
      <group position={[-25, 3.04, 3.7]} name="SCHOOL_ENTRY_IDENTITY">
        <mesh position={[0, 0, 0]} castShadow><boxGeometry args={[17.4, 0.98, 0.18]} /><meshStandardMaterial color="#143e58" roughness={0.52} metalness={0.16} /></mesh>
        <mesh position={[0, 0, 0.095]}><planeGeometry args={[17, 0.9]} /><meshBasicMaterial map={sign} toneMapped={false} /></mesh>
        <mesh position={[0, 0.62, 0.7]} castShadow receiveShadow><boxGeometry args={[18.2, 0.14, 2.4]} /><meshStandardMaterial color="#e8f1f2" roughness={0.48} metalness={0.12} /></mesh>
        <mesh position={[0, 0.55, 1.92]}><boxGeometry args={[18.2, 0.12, 0.08]} /><meshStandardMaterial color="#d88679" roughness={0.6} /></mesh>
      </group>
    </group>
  );
}
