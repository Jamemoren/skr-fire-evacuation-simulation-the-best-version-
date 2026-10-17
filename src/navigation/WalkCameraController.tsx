import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls } from "three-stdlib";
import { floorBase, SLAB_THICKNESS } from "../building1/building1Data";
import { useMapperStore } from "../store";
import { useEvacuationStore } from "../simulation/simulationStore";
import { canWalkAt } from "./walkSurface";
import { clearWalkInput, useWalkStore, walkInput } from "./walkStore";
import { canStartCameraLook } from "./pointerPolicy";

export function WalkCameraController() {
  const enabled = useWalkStore((state) => state.enabled);
  const floor = useWalkStore((state) => state.floor);
  const token = useWalkStore((state) => state.spawnToken);
  const { camera, gl } = useThree();
  const controls = useThree((state) => state.controls) as OrbitControls | null;
  const angles = useRef({ yaw: 0, pitch: 0 });
  const velocity = useRef({ x: 0, forward: 0 });
  const keys = useRef(new Set<string>());
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, "YXZ"), []);

  useEffect(() => {
    if (!enabled) return;
    if (controls) controls.enabled = false;
    camera.position.set(-24, floorBase(floor) + SLAB_THICKNESS + 1.62, floor === 1 ? 15 : 1.86);
    angles.current = { yaw: floor === 1 ? 0 : Math.PI / 2, pitch: -0.025 };
    velocity.current = { x: 0, forward: 0 };
    clearWalkInput(); keys.current.clear();
    gl.domElement.dataset.walkPosition = camera.position.toArray().map((v) => v.toFixed(2)).join(",");
  }, [enabled, floor, token, camera, gl, controls]);

  useEffect(() => {
    if (!enabled) return;
    const reset = () => { clearWalkInput(); keys.current.clear(); velocity.current = { x: 0, forward: 0 }; };
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"].includes(event.code)) { event.preventDefault(); keys.current.add(event.code); }
    };
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    window.addEventListener("blur", reset); document.addEventListener("visibilitychange", reset);
    return () => { reset(); window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", reset); document.removeEventListener("visibilitychange", reset); delete gl.domElement.dataset.walkPosition; };
  }, [enabled, gl]);

  useEffect(() => {
    if (!enabled) return;
    const canvas = gl.domElement;
    let pointer: { id: number; button: number; x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      if (pointer || walkInput.suspended) return;
      if (!canStartCameraLook(event.pointerType, event.button)) return;
      event.preventDefault(); pointer = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id || walkInput.suspended) return;
      walkInput.lookX += event.clientX - pointer.x; walkInput.lookY += event.clientY - pointer.y;
      pointer.x = event.clientX; pointer.y = event.clientY;
    };
    const release = (event?: PointerEvent) => {
      if (!pointer || (event && event.pointerId !== pointer.id)) return;
      if (event?.type === "pointerup" && event.button !== pointer.button) return;
      const id = pointer.id;
      pointer = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    const onBlur = () => release();
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release); canvas.addEventListener("lostpointercapture", release);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => { release(); canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", release); canvas.removeEventListener("pointercancel", release); canvas.removeEventListener("lostpointercapture", release); window.removeEventListener("blur", onBlur); document.removeEventListener("visibilitychange", onBlur); };
  }, [enabled, floor, token, gl]);

  useFrame((_, delta) => {
    if (!enabled || document.hidden || useEvacuationStore.getState().workMode !== "simulation") return;
    if (controls) controls.enabled = false;
    if (walkInput.suspended) { velocity.current.x = 0; velocity.current.forward = 0; clearWalkInput(); return; }
    const dt = Math.min(delta, 0.05);
    angles.current.yaw -= walkInput.lookX * 0.0032;
    angles.current.pitch = THREE.MathUtils.clamp(angles.current.pitch - walkInput.lookY * 0.0032, -1.05, 1.05);
    walkInput.lookX = 0; walkInput.lookY = 0;
    camera.quaternion.setFromEuler(euler.set(angles.current.pitch, angles.current.yaw, 0));
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement || document.activeElement instanceof HTMLTextAreaElement;
    const k = (code: string) => !typing && keys.current.has(code) ? 1 : 0;
    let x = walkInput.x + k("KeyD") + k("ArrowRight") - k("KeyA") - k("ArrowLeft");
    let forward = walkInput.forward + k("KeyW") + k("ArrowUp") - k("KeyS") - k("ArrowDown");
    const length = Math.max(1, Math.hypot(x, forward)); x /= length; forward /= length;
    velocity.current.x = THREE.MathUtils.damp(velocity.current.x, x, 16, dt);
    velocity.current.forward = THREE.MathUtils.damp(velocity.current.forward, forward, 16, dt);
    const speed = walkInput.fast || k("ShiftLeft") || k("ShiftRight") ? 3.4 : 1.7;
    const c = Math.cos(angles.current.yaw), s = Math.sin(angles.current.yaw);
    const dx = (c * velocity.current.x - s * velocity.current.forward) * speed * dt;
    const dz = (-s * velocity.current.x - c * velocity.current.forward) * speed * dt;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.08));
    for (let step = 0; step < steps; step++) {
      if (canWalkAt(camera.position.x + dx / steps, camera.position.z + dz / steps, floor)) { camera.position.x += dx / steps; camera.position.z += dz / steps; }
      else {
        if (canWalkAt(camera.position.x + dx / steps, camera.position.z, floor)) camera.position.x += dx / steps;
        if (canWalkAt(camera.position.x, camera.position.z + dz / steps, floor)) camera.position.z += dz / steps;
      }
    }
    gl.domElement.dataset.walkPosition = camera.position.toArray().map((v) => v.toFixed(2)).join(",");
    // Keep the editor's existing free-flight mode separate from touch exploration.
    if (useMapperStore.getState().cameraMode === "god") useWalkStore.getState().setEnabled(false);
  });
  return null;
}
