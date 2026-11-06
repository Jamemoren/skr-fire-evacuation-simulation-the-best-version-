import { useGLTF } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo } from "react";
import * as THREE from "three";
import { useMapperStore } from "../store";
import { buildModelReport, cloneSceneWithMaterialOverrides } from "../utils/model";
import { useThree } from "@react-three/fiber";
import { prepareEditableModel } from "../utils/editableModel";
import { Building1DigitalTwin } from "../building1/Building1DigitalTwin";
import { CampusExtension } from "../building1/CampusExtension";
import { SiteGround } from "../building1/SiteGround";

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
  const objects = useMapperStore((state) => state.objects);
  const gl = useThree((state) => state.gl);

  const scene = useMemo(
    () => cloneSceneWithMaterialOverrides(gltf.scene, modelOpacity),
    [gltf.scene, modelOpacity],
  );

  const editable = useMemo(() => prepareEditableModel(scene), [scene]);
  useLayoutEffect(() => {
    useMapperStore.setState({ modelObjects: editable.apply(objects) });
    gl.shadowMap.needsUpdate = true;
  }, [editable, objects, gl]);

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
  const modelSource = useMapperStore((state) => state.modelSource);
  const showModel = useMapperStore((state) => state.showModel);
  if (!showModel) return null;
  if (!modelUrl) return modelSource.source === "generated" || modelSource.source === "demo" ? <><SiteGround /><Building1DigitalTwin /><CampusExtension /></> : null;
  return <LoadedModel url={modelUrl} />;
}
