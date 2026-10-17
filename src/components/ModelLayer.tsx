import { useGLTF } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useMapperStore } from "../store";
import { buildModelReport, cloneSceneWithMaterialOverrides } from "../utils/model";
import { Building1DigitalTwin } from "../building1/Building1DigitalTwin";

interface LoadedModelProps {
  url: string;
}

function LoadedModel({ url }: LoadedModelProps) {
  const gltf = useGLTF(url);
  const modelOpacity = useMapperStore((state) => state.modelOpacity);
  const modelSource = useMapperStore((state) => state.modelSource);
  const setModelReport = useMapperStore((state) => state.setModelReport);
  const setModelLoading = useMapperStore((state) => state.setModelLoading);
  const setModelError = useMapperStore((state) => state.setModelError);
  const addToast = useMapperStore((state) => state.addToast);

  const scene = useMemo(
    () => cloneSceneWithMaterialOverrides(gltf.scene, modelOpacity),
    [gltf.scene, modelOpacity],
  );

  useEffect(() => {
    try {
      const report = buildModelReport(
        gltf.scene,
        modelSource.name,
        modelSource.size,
        modelSource.sha256,
      );
      setModelReport(report);
      setModelError(null);
      addToast(
        "success",
        `โหลดโมเดลแล้ว: ${report.meshCount.toLocaleString("th-TH")} Mesh`,
      );
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "วิเคราะห์โมเดลไม่สำเร็จ");
    } finally {
      setModelLoading(false);
    }
  }, [addToast, gltf.scene, modelSource.name, modelSource.sha256, modelSource.size, setModelError, setModelLoading, setModelReport]);

  return <primitive object={scene as THREE.Object3D} />;
}

export function ModelLayer() {
  const modelUrl = useMapperStore((state) => state.modelUrl);
  const showModel = useMapperStore((state) => state.showModel);
  if (!showModel) return null;
  if (!modelUrl) return <Building1DigitalTwin />;
  return <LoadedModel url={modelUrl} />;
}
