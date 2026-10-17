import { Html, Line } from "@react-three/drei";
import { useMemo } from "react";
import { useMapperStore } from "../store";
import { distanceBetween } from "../utils/coordinates";

export function MeasurementLayer() {
  const measurement = useMapperStore((state) => state.measurement);
  const midpoint = useMemo(() => {
    if (!measurement.start || !measurement.end) return null;
    return measurement.start.map((value, index) => (value + measurement.end![index]) / 2) as [number, number, number];
  }, [measurement]);
  if (!measurement.start) return null;

  return (
    <group name="MEASUREMENT" userData={{ semanticOverlay: true }}>
      <mesh position={measurement.start}>
        <sphereGeometry args={[0.25, 12, 10]} />
        <meshBasicMaterial color="#fbbf24" depthTest={false} />
      </mesh>
      {measurement.end && (
        <>
          <mesh position={measurement.end}>
            <sphereGeometry args={[0.25, 12, 10]} />
            <meshBasicMaterial color="#fbbf24" depthTest={false} />
          </mesh>
          <Line points={[measurement.start, measurement.end]} color="#fbbf24" lineWidth={2} />
          {midpoint && (
            <Html position={midpoint} center distanceFactor={12}>
              <div className="measurement-label">
                {distanceBetween(measurement.start, measurement.end).toFixed(3)} หน่วยโมเดล
              </div>
            </Html>
          )}
        </>
      )}
    </group>
  );
}
