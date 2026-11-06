import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useMapperStore } from "../../store";
import { calibrationMatrix } from "../../utils/coordinates";
import { useQualityStore } from "../../rendering/qualityStore";
import { getIntroData } from "./introData";
import { IntroLayers, scanHeightAt } from "./introLayers";
import { introClock, resolveIntroMode, type IntroEffectLevel } from "./introTimeline";

/**
 * Directs the WebGL side of the opening: advances the shared clock with frame delta
 * time, compiles both clipping variants during an invisible warm-up, drives the scan
 * reveal through one global clipping plane, adapts effect density to the measured frame
 * rate and restores every renderer/scene setting on unmount.
 */
export function CinematicIntroScene() {
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const calibration = useMapperStore((state) => state.calibration);
  const full = useMemo(() => resolveIntroMode() === "full", []);
  const [layers, setLayers] = useState<IntroLayers | null>(null);
  const localRoot = useRef<THREE.Group | null>(null);
  const runtime = useRef({ frames: 0, fpsEma: 60, slowFor: 0, level: 2 as IntroEffectLevel });
  const clipPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), []);
  const localPlane = useMemo(() => new THREE.Plane(), []);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const drawingBuffer = useMemo(() => new THREE.Vector2(), []);

  useEffect(() => {
    if (!full) return undefined;
    const { tier, touch } = useQualityStore.getState();
    let level: IntroEffectLevel = tier === "high" ? 2 : tier === "balanced" ? 1 : 0;
    if (touch && level > 1) level = 1;
    runtime.current = { frames: 0, fpsEma: 60, slowFor: 0, level };
    introClock.effectLevel = level;
    if (new URLSearchParams(window.location.search).has("introDebug")) {
      // QA hook only: lets automated checks verify renderer/scene restoration after the intro.
      (window as Window & { __skrIntroRenderer?: unknown }).__skrIntroRenderer = { gl, scene };
    }
    const created = new IntroLayers(getIntroData(), scene, gl, level);
    setLayers(created);
    return () => {
      gl.clippingPlanes = [];
      created.dispose();
      setLayers(null);
    };
  }, [full, gl, scene]);

  useEffect(() => () => {
    // Belt and braces: never leave the reveal plane on the renderer.
    gl.clippingPlanes = [];
  }, [gl]);

  // Priority -1: run before the camera controller so it reads this frame's story time.
  useFrame((state, delta) => {
    if (!full || !layers) return;
    const rt = runtime.current;
    rt.frames += 1;
    if (rt.frames >= 2) layers.noteRendered();
    // Frame 1 renders without the clipping plane, frame 2 with it: both shader variants
    // exist before the show starts, so removing the plane at the end does not recompile.
    if (rt.frames >= 3 && !introClock.ready) introClock.ready = true;
    if (introClock.ready) {
      const dt = rt.frames <= 3 ? 1 / 60 : Math.min(Math.max(delta, 0), 0.1);
      introClock.lastGlTick = performance.now();
      introClock.advance(dt);
      if (introClock.elapsed > 0.6 && delta > 0 && delta < 0.5) {
        rt.fpsEma = rt.fpsEma * 0.9 + (1 / delta) * 0.1;
        rt.slowFor = rt.fpsEma < 26 ? rt.slowFor + delta : Math.max(0, rt.slowFor - delta * 0.5);
        if (rt.slowFor > 0.9 && rt.level > 0) {
          rt.level = (rt.level - 1) as IntroEffectLevel;
          rt.slowFor = 0;
          introClock.effectLevel = rt.level;
        }
      }
    }

    const t = introClock.elapsed;
    matrix.copy(calibrationMatrix(calibration));
    if (rt.frames === 1) {
      gl.clippingPlanes = [];
    } else {
      const h = scanHeightAt(t);
      if (h > 1e4) {
        clipPlane.set(new THREE.Vector3(0, -1, 0), 1e6);
      } else {
        localPlane.set(new THREE.Vector3(0, -1, 0), h);
        clipPlane.copy(localPlane).applyMatrix4(matrix);
      }
      if (gl.clippingPlanes[0] !== clipPlane) gl.clippingPlanes = [clipPlane];
    }

    gl.getDrawingBufferSize(drawingBuffer);
    layers.update({
      t,
      motion: introClock.motion,
      camera: state.camera as THREE.PerspectiveCamera,
      drawingBuffer,
      pixelRatio: gl.getPixelRatio(),
      level: rt.level,
    });
  }, -1);

  if (!full || !layers) return null;
  return (
    <>
      <primitive object={layers.world} />
      <group ref={localRoot} position={calibration.position} rotation={calibration.rotation} scale={calibration.scale}>
        <primitive object={layers.local} />
      </group>
      <IntroLabelProjector />
    </>
  );
}

/**
 * Projects the 3D anchors of the glass tags into screen space after the camera moved
 * this frame, writing transforms straight to the DOM so tags never lag the scene.
 */
function IntroLabelProjector() {
  const calibration = useMapperStore((state) => state.calibration);
  const anchors = useMemo(() => getIntroData().anchors, []);
  const scratch = useMemo(() => ({ v: new THREE.Vector3(), m: new THREE.Matrix4(), root: null as HTMLElement | null, els: new Map<string, HTMLElement | null>() }), []);
  useFrame((state) => {
    const root = introClock.root;
    if (!root) return;
    if (scratch.root !== root) {
      scratch.root = root;
      scratch.els.clear();
      for (const anchor of anchors) scratch.els.set(anchor.id, root.querySelector<HTMLElement>(`[data-anchor="${anchor.id}"]`));
    }
    const { width, height, left, top } = state.size;
    scratch.m.copy(calibrationMatrix(calibration));
    for (const anchor of anchors) {
      const el = scratch.els.get(anchor.id);
      if (!el || !el.hasAttribute("data-on")) continue;
      scratch.v.set(...anchor.position).applyMatrix4(scratch.m).project(state.camera);
      const x = (scratch.v.x * 0.5 + 0.5) * width + left;
      const y = (-scratch.v.y * 0.5 + 0.5) * height + top;
      const visible = scratch.v.z < 1 && Math.abs(scratch.v.x) < 1.05 && Math.abs(scratch.v.y) < 1.05;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      el.dataset.visible = visible ? "1" : "0";
      el.dataset.side = x > left + width * 0.6 ? "left" : "right";
      el.dataset.vertical = y < top + height * 0.34 ? "below" : "above";
    }
  });
  return null;
}
