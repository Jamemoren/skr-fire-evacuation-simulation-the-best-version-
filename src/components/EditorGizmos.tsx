import { TransformControls } from "@react-three/drei";
import { createPortal, useThree } from "@react-three/fiber";
import { type ComponentRef, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useMapperStore } from "../store";
import type { Vec3 } from "../types";

const tuple = (value: THREE.Vector3 | THREE.Euler): Vec3 => [value.x, value.y, value.z];

export function EditorGizmos({ calibratedRoot }: { calibratedRoot: RefObject<THREE.Group | null> }) {
  const state = useMapperStore();
  const scene = useThree((root) => root.scene);
  const gl = useThree((root) => root.gl);
  const controls = useRef<ComponentRef<typeof TransformControls>>(null);
  const nodeProxy = useRef<THREE.Group>(null);
  const edgeProxy = useRef<THREE.Group>(null);
  const edgeStart = useRef<{ matrix: THREE.Matrix4; positions: Map<string, Vec3> } | null>(null);
  const [controlKey, setControlKey] = useState(0);
  const [target, setTarget] = useState<THREE.Object3D | null>(null);

  useLayoutEffect(() => {
    if (state.transformDragging) return;
    if (state.transformTarget === "model") { setTarget(calibratedRoot.current); return; }
    const annotation = state.annotations.find((item) => item.id === state.selectedAnnotationId);
    if (annotation && nodeProxy.current && !annotation.locked) {
      nodeProxy.current.position.fromArray(annotation.position);
      nodeProxy.current.rotation.set(...annotation.rotation);
      nodeProxy.current.scale.fromArray(annotation.size);
      nodeProxy.current.updateMatrix();
      setTarget(nodeProxy.current);
      return;
    }
    const connection = state.connections.find((item) => item.id === state.selectedConnectionId);
    if (connection && edgeProxy.current) {
      const endpoints = state.annotations.filter((item) => item.id === connection.fromId || item.id === connection.toId);
      if (endpoints.length === 2 && endpoints.every((item) => !item.locked)) {
        edgeProxy.current.position.fromArray(endpoints[0].position).add(new THREE.Vector3(...endpoints[1].position)).multiplyScalar(0.5);
        edgeProxy.current.rotation.set(0, 0, 0);
        edgeProxy.current.scale.setScalar(1);
        edgeProxy.current.updateMatrix();
        setTarget(edgeProxy.current);
        return;
      }
    }
    let object: THREE.Object3D | null = null;
    if (state.selectedObjectId && !state.objects[state.selectedObjectId]?.locked && !state.objects[state.selectedObjectId]?.deleted) {
      scene.traverse((item) => { if (item.userData.editorId === state.selectedObjectId) object = item; });
    }
    setTarget(object);
  }, [state.annotations, state.connections, state.objects, state.modelObjects, state.selectedAnnotationId, state.selectedConnectionId, state.selectedObjectId, state.transformTarget, state.transformDragging, calibratedRoot, scene]);

  useEffect(() => {
    const cancel = () => {
      if (!useMapperStore.getState().transformDragging) return;
      controls.current?.reset();
      setControlKey((value) => value + 1);
      useMapperStore.getState().cancelTransform();
    };
    const key = (event: KeyboardEvent) => {
      if ((event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z")) && useMapperStore.getState().transformDragging) {
        event.preventDefault(); event.stopImmediatePropagation(); cancel();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointercancel", cancel);
      cancel();
    };
  }, []);

  const start = () => {
    const current = useMapperStore.getState();
    current.beginTransform();
    if (target && target === edgeProxy.current) {
      target.updateMatrix();
      edgeStart.current = {
        matrix: target.matrix.clone(),
        positions: new Map(current.annotations.map((item) => [item.id, [...item.position] as Vec3])),
      };
    }
  };
  const change = () => {
    if (!target) return;
    const current = useMapperStore.getState();
    if (!current.transformDragging) return;
    if (current.transformTarget === "model") {
      const changedScale = target.scale.toArray().find((value) => Math.abs(value - current.calibration.scale) > 0.000001);
      const scale = Math.max(0.00001, changedScale ?? current.calibration.scale);
      target.scale.setScalar(scale);
      current.previewTransform({ calibration: { position: tuple(target.position), rotation: tuple(target.rotation), scale } });
    } else if (current.selectedAnnotationId) {
      current.previewTransform({
        annotations: current.annotations.map((item) => item.id === current.selectedAnnotationId
          ? { ...item, position: tuple(target.position), rotation: tuple(target.rotation), size: tuple(target.scale).map((value) => Math.max(0.00001, value)) as Vec3 }
          : item),
      });
    } else if (current.selectedConnectionId && edgeStart.current) {
      const edge = current.connections.find((item) => item.id === current.selectedConnectionId);
      target.updateMatrix();
      const delta = target.matrix.clone().multiply(edgeStart.current.matrix.clone().invert());
      current.previewTransform({
        annotations: current.annotations.map((item) => {
          if (item.id !== edge?.fromId && item.id !== edge?.toId) return item;
          const original = edgeStart.current?.positions.get(item.id);
          return original ? { ...item, position: tuple(new THREE.Vector3(...original).applyMatrix4(delta)) } : item;
        }),
      });
    } else if (current.selectedObjectId) {
      current.previewTransform({
        objects: { ...current.objects, [current.selectedObjectId]: {
          ...current.objects[current.selectedObjectId], position: tuple(target.position), rotation: tuple(target.rotation),
          scale: tuple(target.scale).map((value) => Math.max(0.00001, value)) as Vec3,
        } },
      });
    }
    gl.shadowMap.needsUpdate = true;
  };
  return <>
    <group ref={nodeProxy} name="EDITOR_NODE_PROXY" userData={{ semanticOverlay: true }} />
    <group ref={edgeProxy} name="EDITOR_EDGE_PROXY" userData={{ semanticOverlay: true }} />
    {target && createPortal(
      <TransformControls key={controlKey} ref={controls} object={target} mode={state.transformMode} space={state.transformSpace}
        size={0.8} translationSnap={state.snapEnabled ? state.snapSize : null}
        rotationSnap={state.snapEnabled ? Math.PI / 12 : null} scaleSnap={state.snapEnabled ? 0.1 : null}
        onMouseDown={start} onObjectChange={change} onMouseUp={() => useMapperStore.getState().finishTransform()} />,
      scene,
    )}
  </>;
}
