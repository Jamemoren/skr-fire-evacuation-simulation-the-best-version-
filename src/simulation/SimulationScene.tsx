import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { evacuationRuntime } from "./runtime";
import { useEvacuationStore } from "./simulationStore";
import { createStudentGeometry } from "./studentGeometry";
import { useQualityStore } from "../rendering/qualityStore";
import { useBuilding1Store } from "../building1/building1Store";
import { FireEffects } from "./FireEffects";
import { QUALITY_PRESETS } from "../rendering/qualityPolicy";
import { createWaitingStudents } from "./studentPlacement";
import { studentWorldBounds, yOffsetForRender } from "./studentVisibility";
import { uploadInstanceRange } from "../rendering/instanceBuffers";
import { attachStudentMotion, createStudentMaterial, STUDENT_INSTANCE_CAPACITY, studentTransitionBuffers, uploadStudentMotion } from "./studentMaterial";
import { advanceStudentAnimationClock, sampleStudentAnimation, type StudentAnimationTrack } from "./studentAnimation";
import { activeFrameDelta } from "../rendering/frameClock";

function DynamicRoutes() {
  const showRoutes = useEvacuationStore((state) => state.showRoutes);
  const token = useEvacuationStore((state) => state.snapshotToken);
  const routes = useMemo(() => showRoutes ? evacuationRuntime.getRoutePolylines() : [], [showRoutes, token]);
  if (!showRoutes) return null;
  return (
    <group name="SIM_OPTIMAL_ROUTES">
      {routes.map((route, index) => (
        <Line
          key={route.id}
          points={route.points.map((point) => [point[0], point[1] + 0.16, point[2]])}
          color={route.risk > 0.2 ? "#ef7b54" : index < 5 ? "#0f84d8" : "#46a982"}
          lineWidth={Math.max(1.0, Math.min(3.6, 1.0 + route.people / 220))}
          transparent
          opacity={index < 8 ? 0.72 : 0.30}
          dashed={index >= 8}
          dashSize={1.0}
          gapSize={0.6}
        />
      ))}
    </group>
  );
}

function AgentInstances() {
  const tier = useQualityStore((state) => state.tier);
  const viewMode = useBuilding1Store((state) => state.viewMode);
  const showAgents = useEvacuationStore((state) => state.showAgents);
  const populationTarget = useEvacuationStore((state) => state.populationTarget);
  const waitingStudents = useMemo(() => createWaitingStudents(populationTarget), [populationTarget]);
  const maleRef = useRef<THREE.InstancedMesh | null>(null);
  const femaleRef = useRef<THREE.InstancedMesh | null>(null);
  const studentRoot = useRef<THREE.Group | null>(null);
  const compact = tier === "economy" || viewMode === "exterior" || viewMode === "cutaway";
  const maleGeometry = useMemo(() => createStudentGeometry("male", compact), [compact]);
  const femaleGeometry = useMemo(() => createStudentGeometry("female", compact), [compact]);
  const maleMotion = useMemo(() => attachStudentMotion(maleGeometry), [maleGeometry]);
  const femaleMotion = useMemo(() => attachStudentMotion(femaleGeometry), [femaleGeometry]);
  const maleTransitions = useMemo(() => studentTransitionBuffers(maleGeometry), [maleGeometry, maleMotion]);
  const femaleTransitions = useMemo(() => studentTransitionBuffers(femaleGeometry), [femaleGeometry, femaleMotion]);
  const studentSurface = useMemo(createStudentMaterial, []);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  const rotation = useMemo(() => new THREE.Quaternion(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const scale = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const upAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const fallAxis = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const fallRotation = useMemo(() => new THREE.Quaternion(), []);
  const cameraProjection = useMemo(() => new THREE.Matrix4(), []);
  const viewFrustum = useMemo(() => new THREE.Frustum(), []);
  const visibilitySphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 0.9), []);
  const animations = useRef(new Map<number, StudentAnimationTrack>());
  const animationClock = useRef(0);
  const frameClock = useRef(0);
  const seenRevision = useRef(-1);
  const skipResumedFrame = useRef(false);
  const lastSync = useRef(0);
  const lastVisualUpdate = useRef(0);
  const simulationAccumulator = useRef(0);
  const previousCameraProjection = useMemo(() => new THREE.Matrix4(), []);
  const previousModelWorld = useMemo(() => new THREE.Matrix4(), []);
  const previousVisual = useRef<{
    agents: ReturnType<typeof evacuationRuntime.getAgentRenderViews>; time: number; status: string;
    mode: string; floor: number; exploded: boolean; tier: string; show: boolean;
    male: THREE.InstancedMesh; female: THREE.InstancedMesh;
  } | null>(null);
  const visualWork = useRef({ updates: 0, skipped: 0, uploadedBytes: 0, reportedAt: -Infinity });

  useLayoutEffect(() => {
    previousVisual.current = null;
    for (const mesh of [maleRef.current, femaleRef.current]) {
      if (mesh) { mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
    }
  }, [maleGeometry, femaleGeometry]);

  useEffect(() => {
    const onVisibilityChange = () => {
      skipResumedFrame.current = true;
      simulationAccumulator.current = 0;
      lastSync.current = -Infinity;
      lastVisualUpdate.current = -Infinity;
      previousVisual.current = null;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useFrame((state, delta) => {
    if (document.hidden) return;
    const dt = skipResumedFrame.current ? 0 : activeFrameDelta(delta);
    skipResumedFrame.current = false;
    // Fiber resets clock.elapsedTime when switching never/always after page visibility
    // changes. Our local active-time clock must remain monotonic across that reset.
    frameClock.current += dt;
    const frameTime = frameClock.current;
    if (seenRevision.current !== evacuationRuntime.revision) {
      seenRevision.current = evacuationRuntime.revision;
      animations.current.clear();
      animationClock.current = 0;
      simulationAccumulator.current = 0;
      lastSync.current = -Infinity;
      lastVisualUpdate.current = -Infinity;
      previousVisual.current = null;
    }
    const store = useEvacuationStore.getState();
    if (store.status === "running") {
      simulationAccumulator.current += Math.min(dt, 0.1) * store.speedFactor;
      const updateInterval = store.speedFactor <= 2 ? 1 / 30 : store.speedFactor <= 10 ? 1 / 24 : 1 / 20;
      if (simulationAccumulator.current >= updateInterval) {
        // Fast-forward is CPU-budgeted: use a few bounded physical substeps instead of eight
        // expensive full-population passes every rendered frame. Strict Survival Guard and the
        // movement guard still run on every accepted substep.
        const simulatedSlice = Math.min(store.speedFactor >= 25 ? 0.36 : 0.30, simulationAccumulator.current);
        const maxSubstep = store.speedFactor >= 25 ? 0.09 : store.speedFactor >= 10 ? 0.085 : 0.09;
        const maxSubsteps = store.speedFactor >= 25 ? 4 : store.speedFactor >= 10 ? 4 : 3;
        const substeps = Math.max(1, Math.min(maxSubsteps, Math.ceil(simulatedSlice / maxSubstep)));
        const substepDt = simulatedSlice / substeps;
        for (let step = 0; step < substeps; step += 1) evacuationRuntime.step(substepDt);
        simulationAccumulator.current = Math.max(0, simulationAccumulator.current - simulatedSlice);
        simulationAccumulator.current = Math.min(simulationAccumulator.current, store.speedFactor >= 25 ? 0.24 : 0.32);
      }
    } else {
      simulationAccumulator.current = 0;
    }
    const syncInterval = store.speedFactor >= 25 ? 0.55 : store.speedFactor >= 10 ? 0.42 : 0.3;
    if ((store.status === "running" || (evacuationRuntime.completed && store.status !== "completed"))
      && frameTime - lastSync.current > syncInterval) {
      store.syncFromRuntime();
      lastSync.current = frameTime;
    }
    // A frame clock keeps limbs moving between physics ticks. Pause freezes the pose;
    // fast-forward has a bounded cadence so arms/legs remain readable rather than flickering.
    if (store.status !== "paused") {
      const rate = store.status === "running" ? Math.min(2.25, Math.sqrt(store.speedFactor)) : 1;
      const nextClock = advanceStudentAnimationClock(animationClock.current, Math.min(dt, .05) * rate, animations.current.values());
      if (nextClock < animationClock.current) previousVisual.current = null;
      animationClock.current = nextClock;
    }
    studentSurface.time.value = animationClock.current;
    studentSurface.detail.value = compact ? 0 : 1;
    const visualHz = Math.min(QUALITY_PRESETS[tier].agentHz, store.speedFactor >= 25 ? 18 : store.speedFactor >= 10 ? 26 : store.speedFactor >= 2 ? 40 : 55);
    if (frameTime - lastVisualUpdate.current < 1 / visualHz) return;
    lastVisualUpdate.current = frameTime;
    if (!maleRef.current || !femaleRef.current || !studentRoot.current) return;
    const agents = store.status === "idle" ? waitingStudents : evacuationRuntime.getAgentRenderViews();
    const building = useBuilding1Store.getState();
    const t = evacuationRuntime.time;
    state.camera.updateMatrixWorld();
    state.camera.matrixWorldInverse.copy(state.camera.matrixWorld).invert();
    cameraProjection.multiplyMatrices(state.camera.projectionMatrix, state.camera.matrixWorldInverse);
    studentRoot.current.updateWorldMatrix(true, false);
    const previousVisualState = previousVisual.current;
    const unchanged = previousVisualState
      && previousVisualState.agents === agents && previousVisualState.time === t && previousVisualState.status === store.status
      && previousVisualState.mode === building.viewMode && previousVisualState.floor === building.selectedFloor
      && previousVisualState.exploded === building.explodeFloors && previousVisualState.tier === tier
      && previousVisualState.show === showAgents && previousVisualState.male === maleRef.current && previousVisualState.female === femaleRef.current
      && previousCameraProjection.equals(cameraProjection) && previousModelWorld.equals(studentRoot.current.matrixWorld);
    const publishWork = () => {
      if (frameTime - visualWork.current.reportedAt < 0.5) return;
      visualWork.current.reportedAt = frameTime;
      const { updates, skipped, uploadedBytes } = visualWork.current;
      state.gl.domElement.dataset.simAgentWork = JSON.stringify({ updates, skipped, uploadedBytes });
    };
    if (unchanged) {
      visualWork.current.skipped += 1;
      publishWork();
      return;
    }
    previousVisual.current = { agents, time: t, status: store.status, mode: building.viewMode, floor: building.selectedFloor,
      exploded: building.explodeFloors, tier, show: showAgents, male: maleRef.current, female: femaleRef.current };
    previousCameraProjection.copy(cameraProjection);
    previousModelWorld.copy(studentRoot.current.matrixWorld);
    visualWork.current.updates += 1;
    const reportPopulation = (eligible: number, rendered: number) => {
      const view = useBuilding1Store.getState();
      const report = JSON.stringify({ status: store.status, total: agents.length, eligible, rendered, visible: showAgents,
        viewMode: view.viewMode, floor: view.selectedFloor, tier, exploded: view.explodeFloors });
      if (state.gl.domElement.dataset.simPopulation !== report) state.gl.domElement.dataset.simPopulation = report;
    };
    if (!showAgents) {
      maleRef.current.count = 0;
      femaleRef.current.count = 0;
      reportPopulation(0, 0);
      publishWork();
      return;
    }
    // PER_AGENT_CAMERA_FRUSTUM: compact the instance buffers to students that can affect this frame.
    // The simulation still updates every student, while offscreen models consume no draw-instance budget.
    viewFrustum.setFromProjectionMatrix(cameraProjection);
    let maleCount = 0;
    let femaleCount = 0;
    let eligible = 0;
    agents.forEach((agent) => {
      const floorOffset = yOffsetForRender(agent.floor, building);
      if (floorOffset === null) return;
      eligible += 1;
      studentWorldBounds(visibilitySphere, agent.position, floorOffset, studentRoot.current!.matrixWorld);
      if (!viewFrustum.intersectsSphere(visibilitySphere)) return;
      const incapacitated = agent.status === "incapacitated";
      const animation = sampleStudentAnimation(animations.current.get(agent.id), agent, t, animationClock.current, store.speedFactor <= 2);
      animations.current.set(agent.id, animation);
      const protectiveDrop = agent.protectivePosture && !incapacitated ? 0.13 : 0;
      position.set(agent.position[0], agent.position[1] + floorOffset + (incapacitated ? 0.055 : 0) - protectiveDrop, agent.position[2]);
      rotation.setFromAxisAngle(upAxis, animation.yaw);
      if (incapacitated) {
        const elapsed = Math.max(0, evacuationRuntime.time - (agent.incapacitatedAt ?? evacuationRuntime.time));
        const progress = Math.min(1, elapsed / 0.9);
        const eased = 1 - Math.pow(1 - progress, 3);
        const fallSide = agent.id % 2 === 0 ? 1 : -1;
        fallRotation.setFromAxisAngle(fallAxis, fallSide * Math.PI * 0.5 * eased);
        rotation.multiply(fallRotation);
      }
      scale.set(1, agent.protectivePosture && !incapacitated ? 0.82 : 1, 1);
      matrix.compose(position, rotation, scale);
      const phase = agent.id * 2.399963;
      const skin = .28 + ((agent.id * 37) % 101) / 140;
      const hair = ((agent.id * 17) % 97) / 97;
      const buffers = agent.gender === "female" ? femaleTransitions : maleTransitions;
      const instanceIndex = agent.gender === "female" ? femaleCount : maleCount;
      const c = Math.cos(animation.yaw), s = Math.sin(animation.yaw);
      buffers.transition.setXYZW(instanceIndex,
        c * animation.offsetX - s * animation.offsetZ, animation.offsetY,
        s * animation.offsetX + c * animation.offsetZ, animation.started);
      buffers.blend.setXYZW(instanceIndex, animation.yawOffset, animation.strideFrom, animation.duration, incapacitated ? 0 : 1);
      if (agent.gender === "female") {
        femaleMotion.setXYZW(femaleCount, phase, animation.strideTo, skin, hair);
        femaleRef.current!.setMatrixAt(femaleCount++, matrix);
      } else {
        maleMotion.setXYZW(maleCount, phase, animation.strideTo, skin, hair);
        maleRef.current!.setMatrixAt(maleCount++, matrix);
      }
    });
    visualWork.current.uploadedBytes += uploadInstanceRange(maleRef.current, maleCount)
      + uploadInstanceRange(femaleRef.current, femaleCount)
      + uploadStudentMotion(maleMotion, maleCount) + uploadStudentMotion(femaleMotion, femaleCount)
      + uploadStudentMotion(maleTransitions.transition, maleCount) + uploadStudentMotion(maleTransitions.blend, maleCount)
      + uploadStudentMotion(femaleTransitions.transition, femaleCount) + uploadStudentMotion(femaleTransitions.blend, femaleCount);
    reportPopulation(eligible, maleCount + femaleCount);
    publishWork();
  });

  useEffect(() => () => {
    maleGeometry.dispose();
    femaleGeometry.dispose();
  }, [femaleGeometry, maleGeometry]);

  useEffect(() => () => studentSurface.material.dispose(), [studentSurface]);

  return (
    <group ref={studentRoot} name="SIMULATION_STUDENT_AGENTS">
      <instancedMesh ref={maleRef} name="SIM_STUDENTS_MALE" args={[maleGeometry, studentSurface.material, STUDENT_INSTANCE_CAPACITY]} frustumCulled={false} />
      <instancedMesh ref={femaleRef} name="SIM_STUDENTS_FEMALE" args={[femaleGeometry, studentSurface.material, STUDENT_INSTANCE_CAPACITY]} frustumCulled={false} />
    </group>
  );
}

export function SimulationScene() {
  const workMode = useEvacuationStore((state) => state.workMode);
  const status = useEvacuationStore((state) => state.status);
  if (workMode !== "simulation" && status === "idle") return null;
  return (
    <group name="EVACUATION_SIMULATION_SCENE">
      <DynamicRoutes />
      <AgentInstances />
      <FireEffects />
    </group>
  );
}
