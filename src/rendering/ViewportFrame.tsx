import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import type * as THREE from "three";
import { useViewportFrameStore } from "../simulation/dashboard/dashboardModel";
import { useEvacuationStore } from "../simulation/simulationStore";

/**
 * Re-centres the perspective projection on the part of the canvas that floating panels
 * leave free, so the model sits in the visible area without moving the camera itself.
 * Orbit, picking and HTML labels stay correct because the offset lives in the projection.
 */
export function ViewportFrame() {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const size = useThree((state) => state.size);
  const offset = useRef({ x: 0, y: 0, w: 0, h: 0 });
  useFrame((_, delta) => {
    if (!camera.isPerspectiveCamera) return;
    const { insets } = useViewportFrameStore.getState();
    const active = useEvacuationStore.getState().workMode === "simulation";
    const tx = active ? (insets.left - insets.right) / 2 : 0;
    const ty = active ? (insets.top - insets.bottom) / 2 : 0;
    const o = offset.current;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 9);
    let x = o.x + (tx - o.x) * k;
    let y = o.y + (ty - o.y) * k;
    if (Math.abs(tx - x) < 0.25) x = tx;
    if (Math.abs(ty - y) < 0.25) y = ty;
    const resized = o.w !== size.width || o.h !== size.height;
    if (!resized && x === o.x && y === o.y) return;
    offset.current = { x, y, w: size.width, h: size.height };
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) {
      if (camera.view?.enabled) camera.clearViewOffset();
      return;
    }
    camera.setViewOffset(size.width, size.height, -x, -y, size.width, size.height);
  });
  return null;
}

/** Aspect of the free area for distance fitting (free width over full height). */
export function freeAreaAspect(width: number, height: number): number {
  const { insets } = useViewportFrameStore.getState();
  if (useEvacuationStore.getState().workMode !== "simulation") return width / Math.max(1, height);
  return Math.max(0.3, (width - insets.left - insets.right) / Math.max(1, height));
}
