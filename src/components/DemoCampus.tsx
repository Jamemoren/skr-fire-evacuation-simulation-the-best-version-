import { Text } from "@react-three/drei";

export function DemoCampus() {
  return (
    <group name="DEMO_CAMPUS">
      <mesh name="Demo_Ground" position={[0, -0.5, 0]} receiveShadow>
        <boxGeometry args={[140, 1, 100]} />
        <meshStandardMaterial color="#26343d" />
      </mesh>
      <mesh name="Demo_Building_A" position={[-34, 10, -12]}>
        <boxGeometry args={[38, 20, 26]} />
        <meshStandardMaterial color="#526875" />
      </mesh>
      <mesh name="Demo_Building_B" position={[10, 13, -18]}>
        <boxGeometry args={[30, 26, 32]} />
        <meshStandardMaterial color="#607784" />
      </mesh>
      <mesh name="Demo_Building_C" position={[-18, 7, 26]}>
        <boxGeometry args={[46, 14, 22]} />
        <meshStandardMaterial color="#4d6471" />
      </mesh>
      <mesh name="Demo_Football_Field" position={[39, 0.03, 25]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[52, 32]} />
        <meshStandardMaterial color="#2f7446" />
      </mesh>
      <Text
        position={[0, 30, 0]}
        fontSize={4}
        color="#f5c451"
        anchorX="center"
        anchorY="middle"
      >
        DEMO MODEL — นำเข้าไฟล์ GLB จริง
      </Text>
    </group>
  );
}
