import { Html, OrbitControls, PointerLockControls } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import {
  Component,
  Suspense,
  type ComponentRef,
  type ErrorInfo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { useMapperStore } from "../store";
import { modelLocalToWorld } from "../utils/coordinates";
import { surfaceHitFromIntersection } from "../utils/model";
import { AnnotationLayer } from "./AnnotationLayer";
import { ConnectionsLayer } from "./ConnectionsLayer";
import { DemoCampus } from "./DemoCampus";
import { MeasurementLayer } from "./MeasurementLayer";
import { ModelLayer } from "./ModelLayer";
import { DaylightEnvironment } from "./DaylightEnvironment";
import {
  CINEMATIC_INTRO_DURATION_SECONDS,
  CINEMATIC_INTRO_END_POSITION,
  CINEMATIC_INTRO_END_TARGET,
} from "./cinematicConfig";
import { SimulationScene } from "../simulation/SimulationScene";
import { useEvacuationStore } from "../simulation/simulationStore";
import { useBuilding1Store } from "../building1/building1Store";
import { useQualityStore } from "../rendering/qualityStore";
import { QUALITY_PRESETS } from "../rendering/qualityPolicy";
import { usePageVisible } from "../rendering/usePageVisible";
import { fittedViewDistance } from "../rendering/cameraFraming";
import { useWalkStore } from "../navigation/walkStore";
import { STAIR_ZONE_CENTERS } from "../building1/building1Data";
import { WalkCameraController } from "../navigation/WalkCameraController";

function fitCameraPosition(position: THREE.Vector3, target: THREE.Vector3, aspect: number, span: number) {
  const distance = Math.max(0.01, position.distanceTo(target));
  position.sub(target).multiplyScalar(fittedViewDistance(distance, 55, aspect, span) / distance).add(target);
}

interface ErrorBoundaryProps {
  children: ReactNode;
  onError: (message: string) => void;
  resetKey: string;
}

interface ErrorBoundaryState {
  failed: boolean;
}

function FrameTelemetry() {
  const setRenderFps = useEvacuationStore((state) => state.setRenderFps);
  const { gl } = useThree();
  const sample = useRef({ frames: 0, elapsed: 0, smoothedFps: 0 });

  useEffect(() => {
    const resetSample = () => { sample.current.frames = 0; sample.current.elapsed = 0; };
    document.addEventListener("visibilitychange", resetSample);
    return () => document.removeEventListener("visibilitychange", resetSample);
  }, []);

  useFrame((_, delta) => {
    // A suspended/hidden tab can return one very large delta. Drop that one sample instead
    // of clamping every frame to 0.1s, which previously made the display appear locked at 10 FPS.
    if (!Number.isFinite(delta) || delta > 0.5) {
      sample.current.frames = 0;
      sample.current.elapsed = 0;
      return;
    }
    sample.current.frames += 1;
    sample.current.elapsed += delta;
    if (sample.current.elapsed < 1) return;
    const measuredFps = sample.current.frames / sample.current.elapsed;
    sample.current.smoothedFps = sample.current.smoothedFps === 0
      ? measuredFps
      : sample.current.smoothedFps * 0.65 + measuredFps * 0.35;
    setRenderFps(sample.current.smoothedFps);
    useQualityStore.getState().reportFps(measuredFps);
    const renderStats = {
      fps: Math.round(sample.current.smoothedFps),
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
    };
    (window as Window & { __SKR_RENDER_STATS__?: Record<string, number> }).__SKR_RENDER_STATS__ = renderStats;
    gl.domElement.dataset.skrRenderStats = JSON.stringify(renderStats);
    sample.current.frames = 0;
    sample.current.elapsed = 0;
  });
  return null;
}

function StaticShadowRefresh() {
  const tier = useQualityStore((state) => state.tier);
  const { gl } = useThree();
  const modelUrl = useMapperStore((state) => state.modelUrl);
  const viewMode = useBuilding1Store((state) => state.viewMode);
  const selectedFloor = useBuilding1Store((state) => state.selectedFloor);
  const explodeFloors = useBuilding1Store((state) => state.explodeFloors);
  const showInteriorWalls = useBuilding1Store((state) => state.showInteriorWalls);
  const showRoof = useBuilding1Store((state) => state.showRoof);

  useEffect(() => {
    // The campus and building are static. Refresh only after a model/view change instead of
    // rendering thousands of shadow casters again on every animation frame.
    gl.shadowMap.needsUpdate = true;
  }, [explodeFloors, gl, modelUrl, selectedFloor, showInteriorWalls, showRoof, tier, viewMode]);
  return null;
}

class ModelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error.message || "โหลดโมเดล GLB ไม่สำเร็จ");
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) return <DemoCampus />;
    return this.props.children;
  }
}

interface GodModeControllerProps {
  surfaceRootRef: RefObject<THREE.Group | null>;
  calibratedRootRef: RefObject<THREE.Group | null>;
}

function GodModeController({ surfaceRootRef, calibratedRootRef }: GodModeControllerProps) {
  const cameraMode = useMapperStore((state) => state.cameraMode);
  const godSpeed = useMapperStore((state) => state.godSpeed);
  const setTargetHit = useMapperStore((state) => state.setTargetHit);
  const openDraftFromHit = useMapperStore((state) => state.openDraftFromHit);
  const setMeasurementPoint = useMapperStore((state) => state.setMeasurementPoint);
  const targetHit = useMapperStore((state) => state.targetHit);
  const draft = useMapperStore((state) => state.draft);
  const toolMode = useMapperStore((state) => state.toolMode);
  const placementType = useMapperStore((state) => state.placementType);
  const { camera } = useThree();
  const keys = useRef(new Set<string>());
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const lastRaycastAt = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) return;
      keys.current.add(event.code);
      if (event.code === "KeyF" && !event.repeat && cameraMode === "god" && !draft && targetHit) {
        event.preventDefault();
        if (toolMode === "measure") {
          setMeasurementPoint(targetHit.position);
        } else {
          openDraftFromHit(targetHit, placementType);
          void document.exitPointerLock();
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keys.current.delete(event.code);
    const onBlur = () => keys.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [cameraMode, draft, openDraftFromHit, placementType, setMeasurementPoint, targetHit, toolMode]);

  useFrame((_state, delta) => {
    if (cameraMode !== "god") return;
    const activeTime = performance.now() / 1000;
    const surface = surfaceRootRef.current;
    const calibratedRoot = calibratedRootRef.current;
    if (surface && calibratedRoot && activeTime - lastRaycastAt.current > 0.06) {
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const intersections = raycaster.intersectObject(surface, true);
      setTargetHit(
        intersections[0]
          ? surfaceHitFromIntersection(intersections[0], calibratedRoot)
          : null,
      );
      lastRaycastAt.current = activeTime;
    }

    if (!document.pointerLockElement) return;
    const multiplier = keys.current.has("ShiftLeft") || keys.current.has("ShiftRight") ? 3.5 : 1;
    const precision = keys.current.has("ControlLeft") || keys.current.has("ControlRight") ? 0.2 : 1;
    const distance = godSpeed * multiplier * precision * Math.min(delta, 0.05);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward).normalize();
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    const movement = new THREE.Vector3();
    if (keys.current.has("KeyW")) movement.add(forward);
    if (keys.current.has("KeyS")) movement.sub(forward);
    if (keys.current.has("KeyD")) movement.add(right);
    if (keys.current.has("KeyA")) movement.sub(right);
    if (keys.current.has("KeyE")) movement.y += 1;
    if (keys.current.has("KeyQ")) movement.y -= 1;
    if (movement.lengthSq() > 0) camera.position.add(movement.normalize().multiplyScalar(distance));
  });

  if (cameraMode !== "god") return null;
  return <PointerLockControls selector="#god-lock-button" />;
}

function CameraController({ cinematicIntro = false }: { cinematicIntro?: boolean }) {
  const walking = useWalkStore((state) => state.enabled);
  const viewMode = useBuilding1Store((state) => state.viewMode);
  const touch = useQualityStore((state) => state.touch);
  const cameraMode = useMapperStore((state) => state.cameraMode);
  const cameraFocus = useMapperStore((state) => state.cameraFocus);
  const cameraFocusToken = useMapperStore((state) => state.cameraFocusToken);
  const calibration = useMapperStore((state) => state.calibration);
  const modelReport = useMapperStore((state) => state.modelReport);
  const workMode = useEvacuationStore((state) => state.workMode);
  const { camera, gl, size } = useThree();
  const orbitRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const [ctrlLockActive, setCtrlLockActive] = useState(false);
  const ctrlLockFallback = useRef(false);
  const navigationKeys = useRef(new Set<string>());
  const appliedFocus = useRef(false);
  const focusSize = useRef({ width: 0, height: 0 });
  const focusMotion = useRef<{ from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; startedAt: number } | null>(null);
  const firstPersonLook = useRef({
    active: false,
    pointerId: -1,
    x: 0,
    y: 0,
    targetDistance: 24,
    previousCursor: "",
  });
  const introElapsed = useRef(0);
  const introWasActive = useRef(cinematicIntro);
  const introHandoffFocusToken = useRef<number | null>(null);
  const introCameraPath = useMemo(() => new THREE.CatmullRomCurve3([
    new THREE.Vector3(92, 62, 118),
    new THREE.Vector3(28, 57, 154),
    new THREE.Vector3(-72, 53, 132),
    new THREE.Vector3(-108, 48, 48),
    new THREE.Vector3(-78, 50, -42),
    new THREE.Vector3(20, 54, -66),
    new THREE.Vector3(96, 59, -8),
    new THREE.Vector3(112, 64, 74),
    new THREE.Vector3(...CINEMATIC_INTRO_END_POSITION),
  ], false, "catmullrom", 0.46), []);
  const introLookPath = useMemo(() => new THREE.CatmullRomCurve3([
    new THREE.Vector3(-18, 12, 42),
    new THREE.Vector3(-18, 14, 47),
    new THREE.Vector3(-14, 13, 50),
    new THREE.Vector3(...CINEMATIC_INTRO_END_TARGET),
  ], false, "catmullrom", 0.5), []);
  const introVectors = useMemo(() => ({
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
  }), []);
  const navigationVectors = useMemo(() => ({
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    movement: new THREE.Vector3(),
  }), []);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"].includes(event.code)) {
        navigationKeys.current.add(event.code);
        if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => navigationKeys.current.delete(event.code);
    const onBlur = () => navigationKeys.current.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const surface = gl.domElement;
    const look = firstPersonLook.current;

    const syncOrbitTargetToView = () => {
      if (useWalkStore.getState().enabled) return;
      const controls = orbitRef.current;
      if (!controls) return;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      controls.target.copy(camera.position).addScaledVector(forward, look.targetDistance);
    };

    const finishFirstPersonLook = (event?: PointerEvent) => {
      if (!look.active) return;
      if (event && event.pointerId !== look.pointerId) return;
      syncOrbitTargetToView();
      look.active = false;
      if (surface.hasPointerCapture(look.pointerId)) surface.releasePointerCapture(look.pointerId);
      look.pointerId = -1;
      surface.style.cursor = look.previousCursor;
      if (orbitRef.current) {
        orbitRef.current.enabled = !useWalkStore.getState().enabled && !cinematicIntro && document.pointerLockElement !== surface;
        if (!useWalkStore.getState().enabled) orbitRef.current.update();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (useWalkStore.getState().enabled || event.button !== 2 || cameraMode === "god" || cinematicIntro || document.pointerLockElement === surface) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const controls = orbitRef.current;
      look.active = true;
      look.pointerId = event.pointerId;
      look.x = event.clientX;
      look.y = event.clientY;
      look.targetDistance = controls
        ? THREE.MathUtils.clamp(camera.position.distanceTo(controls.target), 2, 5000)
        : 24;
      look.previousCursor = surface.style.cursor;
      surface.style.cursor = "grabbing";
      surface.setPointerCapture(event.pointerId);
      if (controls) controls.enabled = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      const ctrlLocked = document.pointerLockElement === surface || ctrlLockFallback.current;
      if (!ctrlLocked && (!look.active || event.pointerId !== look.pointerId)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const dx = ctrlLocked ? event.movementX : event.clientX - look.x;
      const dy = ctrlLocked ? event.movementY : event.clientY - look.y;
      if (!ctrlLocked) {
        look.x = event.clientX;
        look.y = event.clientY;
      }
      const orientation = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      orientation.y -= dx * 0.0022;
      orientation.x = THREE.MathUtils.clamp(
        orientation.x - dy * 0.0022,
        -Math.PI * 0.495,
        Math.PI * 0.495,
      );
      orientation.z = 0;
      camera.quaternion.setFromEuler(orientation);
      camera.updateMatrixWorld();
      syncOrbitTargetToView();
    };

    const onPointerUp = (event: PointerEvent) => finishFirstPersonLook(event);
    const onContextMenu = (event: MouseEvent) => {
      if (cameraMode === "god") return;
      event.preventDefault();
    };
    const finishCtrlLock = () => {
      ctrlLockFallback.current = false;
      setCtrlLockActive(false);
      surface.dataset.ctrlLock = "inactive";
      document.documentElement.classList.remove("ctrl-lock-active");
      syncOrbitTargetToView();
      surface.style.cursor = look.previousCursor;
      if (orbitRef.current) {
        orbitRef.current.enabled = !useWalkStore.getState().enabled && !cinematicIntro;
        if (!useWalkStore.getState().enabled) orbitRef.current.update();
      }
    };
    const setPointerLockFailed = () => {
      // Embedded/automated browsers can deny the native Pointer Lock API. Keep
      // the Roblox-style camera usable with a soft lock driven by movementX/Y.
      ctrlLockFallback.current = true;
      setCtrlLockActive(true);
      surface.dataset.ctrlLock = "fallback";
      document.documentElement.classList.add("ctrl-lock-active");
      look.previousCursor = surface.style.cursor;
      surface.style.cursor = "none";
      if (orbitRef.current) orbitRef.current.enabled = false;
    };
    const onPointerLockChange = () => {
      const active = document.pointerLockElement === surface;
      setCtrlLockActive(active);
      surface.dataset.ctrlLock = active ? "active" : "inactive";
      if (active) {
        ctrlLockFallback.current = false;
        document.documentElement.classList.add("ctrl-lock-active");
        finishFirstPersonLook();
        const controls = orbitRef.current;
        look.targetDistance = controls
          ? THREE.MathUtils.clamp(camera.position.distanceTo(controls.target), 2, 5000)
          : 24;
        look.previousCursor = surface.style.cursor;
        surface.style.cursor = "none";
        if (controls) controls.enabled = false;
      } else {
        finishCtrlLock();
      }
    };
    const onCtrlToggle = (event: KeyboardEvent) => {
      const ctrlKey = event.code === "ControlLeft" || event.code === "ControlRight";
      const fallbackEscape = event.code === "Escape" && ctrlLockFallback.current;
      if (
        event.repeat
        || (!ctrlKey && !fallbackEscape)
        || workMode !== "simulation"
        || cameraMode === "god"
        || useWalkStore.getState().enabled
        || cinematicIntro
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
        || document.querySelector('[role="dialog"]')
      ) return;
      event.preventDefault();
      event.stopPropagation();
      if (ctrlLockFallback.current) {
        finishCtrlLock();
        return;
      }
      if (document.pointerLockElement === surface) {
        void document.exitPointerLock();
        return;
      }
      const controls = orbitRef.current;
      look.targetDistance = controls
        ? THREE.MathUtils.clamp(camera.position.distanceTo(controls.target), 2, 5000)
        : 24;
      Promise.resolve(surface.requestPointerLock()).catch(setPointerLockFailed);
    };
    const onWindowBlur = () => {
      finishFirstPersonLook();
      if (document.pointerLockElement === surface) void document.exitPointerLock();
      else if (ctrlLockFallback.current) finishCtrlLock();
    };

    surface.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    surface.addEventListener("pointerup", onPointerUp, true);
    surface.addEventListener("pointercancel", onPointerUp, true);
    surface.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    document.addEventListener("pointerlockerror", setPointerLockFailed);
    window.addEventListener("keydown", onCtrlToggle, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      finishFirstPersonLook();
      if (document.pointerLockElement === surface) void document.exitPointerLock();
      finishCtrlLock();
      surface.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      surface.removeEventListener("pointerup", onPointerUp, true);
      surface.removeEventListener("pointercancel", onPointerUp, true);
      surface.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", setPointerLockFailed);
      window.removeEventListener("keydown", onCtrlToggle, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [camera, cameraMode, cinematicIntro, gl, workMode]);

  useEffect(() => {
    if (cinematicIntro) {
      introElapsed.current = 0;
      introWasActive.current = true;
      introHandoffFocusToken.current = null;
      gl.domElement.dataset.introState = "running";
      delete gl.domElement.dataset.introPose;
      return;
    }
    if (!introWasActive.current) return;

    introWasActive.current = false;
    introCameraPath.getPointAt(1, introVectors.position);
    introLookPath.getPointAt(1, introVectors.target);
    fitCameraPosition(introVectors.position, introVectors.target, size.width / size.height, 190);
    camera.position.copy(introVectors.position);
    camera.lookAt(introVectors.target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    orbitRef.current?.target.copy(introVectors.target);
    orbitRef.current?.update();
    introHandoffFocusToken.current = cameraFocusToken;
    gl.domElement.dataset.introState = "held";
    gl.domElement.dataset.introPose = `${camera.position.toArray().map((value) => value.toFixed(3)).join(",")}|${introVectors.target.toArray().map((value) => value.toFixed(3)).join(",")}`;
  }, [camera, cameraFocusToken, cinematicIntro, gl, introCameraPath, introLookPath, introVectors, size.width, size.height]);

  useFrame((_, delta) => {
    if (!cinematicIntro) return;
    introElapsed.current += Math.min(delta, 0.08);
    const progress = Math.min(1, introElapsed.current / CINEMATIC_INTRO_DURATION_SECONDS);
    // Quintic smootherstep reaches zero velocity and zero acceleration at both ends.
    const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
    introCameraPath.getPointAt(eased, introVectors.position);
    introLookPath.getPointAt(eased, introVectors.target);
    fitCameraPosition(introVectors.position, introVectors.target, size.width / size.height, 190);
    camera.position.copy(introVectors.position);
    camera.lookAt(introVectors.target);
    camera.updateMatrixWorld();
    orbitRef.current?.target.copy(introVectors.target);
    if (progress >= 1) {
      gl.domElement.dataset.introState = "settled";
      gl.domElement.dataset.introPose = `${camera.position.toArray().map((value) => value.toFixed(3)).join(",")}|${introVectors.target.toArray().map((value) => value.toFixed(3)).join(",")}`;
    }
  });

  useFrame(() => {
    const motion = focusMotion.current;
    if (!motion) return;
    if (walking || cinematicIntro || ctrlLockActive || cameraMode === "god" || navigationKeys.current.size > 0) { focusMotion.current = null; return; }
    const t = Math.min(1, (performance.now() - motion.startedAt) / 600);
    const eased = t * t * (3 - 2 * t);
    camera.position.lerpVectors(motion.from, motion.to, eased);
    const target = motion.fromTarget.clone().lerp(motion.toTarget, eased);
    camera.lookAt(target);
    orbitRef.current?.target.copy(target);
    orbitRef.current?.update();
    if (t >= 1) focusMotion.current = null;
  });

  useFrame((_, delta) => {
    if (walking || cameraMode === "god" || !orbitRef.current || navigationKeys.current.size === 0) return;
    const { forward, right, movement } = navigationVectors;
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.01) forward.set(0, 0, -1);
    else forward.normalize();
    right.crossVectors(forward, camera.up).normalize();
    movement.set(0, 0, 0);
    if (navigationKeys.current.has("KeyW")) movement.add(forward);
    if (navigationKeys.current.has("KeyS")) movement.sub(forward);
    if (navigationKeys.current.has("KeyD")) movement.add(right);
    if (navigationKeys.current.has("KeyA")) movement.sub(right);
    if (navigationKeys.current.has("KeyE")) movement.y += 1;
    if (navigationKeys.current.has("KeyQ")) movement.y -= 1;
    if (movement.lengthSq() === 0) return;
    const target = orbitRef.current.target;
    const viewDistance = camera.position.distanceTo(target);
    const boost = navigationKeys.current.has("ShiftLeft") || navigationKeys.current.has("ShiftRight") ? 2.4 : 1;
    const speed = Math.max(7, Math.min(58, viewDistance * 0.42)) * boost * Math.min(delta, 0.05);
    movement.normalize().multiplyScalar(speed);
    camera.position.add(movement);
    target.add(movement);
    orbitRef.current.update();
  });

  useEffect(() => {
    if (walking || cameraMode === "god") return;
    // Simulation has an explicit operational focus. Do not let the asynchronous model-report
    // auto-fit override it and place the camera inside a stair tower after first load.
    if (workMode === "simulation" && cameraFocus) return;
    const localCenter = (modelReport?.boundsCenter ?? [0, 0, 0]) as [number, number, number];
    const center = new THREE.Vector3(...modelLocalToWorld(localCenter, calibration));
    const extent = Math.max(...(modelReport?.boundsSize ?? [100, 100, 100])) * calibration.scale;
    if (cameraMode === "top") {
      camera.position.set(center.x, center.y + Math.max(80, extent * 1.2), center.z + 0.01);
    } else if (cameraMode === "isometric") {
      camera.position.copy(center).add(new THREE.Vector3(extent * 0.85, extent * 0.65, extent * 0.85));
    }
    if (cameraMode === "top" || cameraMode === "isometric") {
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      orbitRef.current?.target.copy(center);
      orbitRef.current?.update();
    }
  }, [calibration, camera, cameraFocus, cameraMode, cinematicIntro, modelReport, workMode, walking]);

  useEffect(() => { introHandoffFocusToken.current = null; }, [size.width, size.height]);

  useEffect(() => {
    if (walking || !cameraFocus || cinematicIntro) return;
    // Ignore only the stale focus request that existed before the intro. A later
    // explicit view command changes the token and is still honoured normally.
    if (introHandoffFocusToken.current === cameraFocusToken) return;
    introHandoffFocusToken.current = null;
    const target = new THREE.Vector3(...modelLocalToWorld(cameraFocus, calibration));
    const interior = viewMode === "interior" || viewMode === "single-floor";
    const stairFocus = interior && Object.values(STAIR_ZONE_CENTERS).some((c) => Math.abs(c[0] - cameraFocus[0]) < .01 && Math.abs(c[2] - cameraFocus[2]) < .01);
    const roomFocus = interior && !stairFocus && cameraFocus[2] < 0;
    let offset: THREE.Vector3;
    if (cameraMode === "top") {
      offset = new THREE.Vector3(0, workMode === "simulation" ? 125 : 35, 0.01);
    } else if (stairFocus) {
      offset = new THREE.Vector3(-10, 12, 15);
    } else if (workMode === "simulation" && interior) {
      offset = roomFocus ? new THREE.Vector3(-5, 7, 10) : new THREE.Vector3(-49, 58, 64);
    } else if (workMode === "simulation") {
      offset = cameraFocus[2] > 70
        ? new THREE.Vector3(-62, 52, 66)
        : cameraFocus[2] > 38
          ? new THREE.Vector3(-100, 78, 112)
          : new THREE.Vector3(-72, 50, 72);
    } else {
      offset = new THREE.Vector3(14, 10, 14);
    }
    const span = stairFocus ? 22 : workMode === "simulation" ? interior ? roomFocus ? 14 : 96 : cameraFocus[2] > 70 ? 112 : cameraFocus[2] > 38 ? 190 : 120 : 45;
    offset.setLength(fittedViewDistance(offset.length(), 55, size.width / size.height, span));
    const destination = target.clone().add(offset);
    const resized = focusSize.current.width !== size.width || focusSize.current.height !== size.height;
    focusSize.current = { width: size.width, height: size.height };
    if (appliedFocus.current && !resized && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      focusMotion.current = { from: camera.position.clone(), to: destination, fromTarget: orbitRef.current?.target.clone() ?? target.clone(), toTarget: target, startedAt: performance.now() };
    } else {
      focusMotion.current = null;
      camera.position.copy(destination);
      camera.lookAt(target);
      orbitRef.current?.target.copy(target);
      orbitRef.current?.update();
    }
    appliedFocus.current = true;
    camera.updateProjectionMatrix();
  }, [calibration, camera, cameraFocus, cameraFocusToken, cameraMode, cinematicIntro, workMode, viewMode, size.width, size.height, walking]);

  if (cameraMode === "god") return null;
  return (
    <>
      <OrbitControls
        ref={orbitRef}
        makeDefault
        onStart={() => { focusMotion.current = null; }}
        enabled={!walking && !cinematicIntro && !ctrlLockActive}
        enableDamping={!walking}
        dampingFactor={0.08}
        screenSpacePanning
        enablePan={touch}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        minDistance={0.5}
        maxDistance={5000}
        maxPolarAngle={walking ? Math.PI : cameraMode === "top" ? 0.04 : Math.PI * 0.495}
        minPolarAngle={walking ? 0 : cameraMode === "top" ? 0 : 0.02}
        zoomSpeed={1.5}
        panSpeed={1.35}
        rotateSpeed={0.85}
        mouseButtons={{ LEFT: undefined, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
      />
      {ctrlLockActive && (
        <Html fullscreen zIndexRange={[35, 20]} style={{ pointerEvents: "none" }}>
          <div className="ctrl-lock-overlay" aria-hidden="true">
            <span className="ctrl-lock-reticle" />
            <div className="ctrl-lock-pill">
              <strong>CTRL LOCK</strong>
              <small>ขยับเมาส์เพื่อหันกล้อง · CTRL / ESC เพื่อปลด</small>
            </div>
          </div>
        </Html>
      )}
    </>
  );
}

function SceneContents({ cinematicIntro = false }: { cinematicIntro?: boolean }) {
  const focusMode = useBuilding1Store((state) => state.focusMode);
  const calibration = useMapperStore((state) => state.calibration);
  const showGrid = useMapperStore((state) => state.showGrid);
  const cameraMode = useMapperStore((state) => state.cameraMode);
  const toolMode = useMapperStore((state) => state.toolMode);
  const placementType = useMapperStore((state) => state.placementType);
  const modelUrl = useMapperStore((state) => state.modelUrl);
  const setInspectedHit = useMapperStore((state) => state.setInspectedHit);
  const openDraftFromHit = useMapperStore((state) => state.openDraftFromHit);
  const setMeasurementPoint = useMapperStore((state) => state.setMeasurementPoint);
  const setModelError = useMapperStore((state) => state.setModelError);
  const setModelLoading = useMapperStore((state) => state.setModelLoading);
  const workMode = useEvacuationStore((state) => state.workMode);
  const placeFireMode = useEvacuationStore((state) => state.placeFireMode);
  const addSimulationFire = useEvacuationStore((state) => state.addFire);
  const calibratedRootRef = useRef<THREE.Group | null>(null);
  const surfaceRootRef = useRef<THREE.Group | null>(null);

  const tapStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const pointers = useRef(new Set<number>());
  const multiTouch = useRef(false);
  const canPickSurface = placeFireMode || workMode === "editor";
  const canvasElement = useThree((state) => state.gl.domElement);
  useEffect(() => {
    const reset = () => { tapStart.current = null; pointers.current.clear(); multiTouch.current = false; };
    reset();
    if (!canPickSurface) return;
    const down = (event: PointerEvent) => {
      pointers.current.add(event.pointerId);
      if (pointers.current.size > 1) multiTouch.current = true;
    };
    const release = (event: PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (tapStart.current?.id === event.pointerId) tapStart.current = null;
      if (!pointers.current.size) multiTouch.current = false;
    };
    // Track the whole canvas, including sky taps and releases outside the model. A pinch
    // must never be interpreted as placing a fire when only one finger hits geometry.
    canvasElement.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", reset);
    window.addEventListener("blur", reset);
    return () => {
      canvasElement.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("blur", reset);
      reset();
    };
  }, [canvasElement, canPickSurface]);
  const onSurfacePointerDown = (event: ThreeEvent<PointerEvent>) => {
    pointers.current.add(event.pointerId);
    if (pointers.current.size > 1) multiTouch.current = true;
    tapStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onSurfacePointerUp = (event: ThreeEvent<PointerEvent>) => {
    pointers.current.delete(event.pointerId);
    const start = tapStart.current;
    const wasMultiTouch = multiTouch.current;
    if (!pointers.current.size) multiTouch.current = false;
    tapStart.current = null;
    if (!start || start.id !== event.pointerId || wasMultiTouch
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 7) return;
    if (cameraMode === "god" || event.button !== 0) return;
    const intersection = event.intersections.find((item) => !item.object.userData.semanticOverlay);
    if (!intersection || !calibratedRootRef.current) return;
    const hit = surfaceHitFromIntersection(intersection, calibratedRootRef.current);
    if (placeFireMode) {
      event.stopPropagation();
      addSimulationFire(hit.position);
      return;
    }
    // Left clicks are reserved for actions and editor selection. Camera look belongs
    // to the right button; touch gestures are configured separately in OrbitControls.
    if (workMode !== "editor") return;
    event.stopPropagation();
    if (toolMode === "inspect") setInspectedHit(hit);
    if (toolMode === "annotate") openDraftFromHit(hit, placementType);
    if (toolMode === "measure") setMeasurementPoint(hit.position);
  };

  return (
    <>
      <DaylightEnvironment />
      <FrameTelemetry />
      <StaticShadowRefresh />
      {showGrid && <gridHelper args={[1200, 240, "#3c6074", "#162b36"]} position={[0, -0.02, 0]} />}
      {showGrid && <axesHelper args={[12]} />}
      <group
        ref={calibratedRootRef}
        name="CALIBRATED_MODEL_ROOT"
        position={calibration.position}
        rotation={calibration.rotation}
        scale={calibration.scale}
      >
        <group ref={surfaceRootRef} name="MODEL_SURFACE"
          onPointerDown={canPickSurface ? onSurfacePointerDown : undefined}
          onPointerUp={canPickSurface ? onSurfacePointerUp : undefined}
          onPointerCancel={canPickSurface ? () => { tapStart.current = null; pointers.current.clear(); multiTouch.current = false; } : undefined}>
          <Suspense fallback={null}>
            <ModelErrorBoundary
              resetKey={modelUrl ?? "demo"}
              onError={(message) => {
                setModelError(message);
                setModelLoading(false);
              }}
            >
              <ModelLayer />
            </ModelErrorBoundary>
          </Suspense>
        </group>
        {workMode === "editor" && !focusMode && <ConnectionsLayer />}
        {workMode === "editor" && !focusMode && <AnnotationLayer />}
        {workMode === "editor" && <MeasurementLayer />}
        <SimulationScene />
      </group>
      <CameraController cinematicIntro={cinematicIntro} />
      <WalkCameraController />
      <GodModeController surfaceRootRef={surfaceRootRef} calibratedRootRef={calibratedRootRef} />
    </>
  );
}

export function SceneCanvas({ cinematicIntro = false }: { cinematicIntro?: boolean }) {
  // Keep the initial camera options stable. Recreating the position array on a quality or
  // visibility change makes Fiber reset a camera the user has already moved.
  const initialCamera = useMemo(() => ({ position: [85, 70, 85] as [number, number, number], fov: 55, near: 0.03, far: 10000 }), []);
  const snapshotMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("snapshot");
  const tier = useQualityStore((state) => state.tier);
  const preset = QUALITY_PRESETS[tier];
  const visible = usePageVisible();
  return (
    <Canvas
      shadows={preset.shadows}
      frameloop={!visible ? "never" : snapshotMode ? "demand" : "always"}
      dpr={Math.min(window.devicePixelRatio || 1, preset.dpr)}
      camera={initialCamera}
      gl={{ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: snapshotMode }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.04;
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.shadowMap.enabled = preset.shadows;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        gl.shadowMap.autoUpdate = false;
        gl.shadowMap.needsUpdate = true;
      }}
      onPointerMissed={() => {
        useMapperStore.getState().selectAnnotation(null);
        useMapperStore.getState().selectConnection(null);
      }}
    >
      <SceneContents cinematicIntro={cinematicIntro} />
    </Canvas>
  );
}
