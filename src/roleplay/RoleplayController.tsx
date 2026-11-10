/**
 * First-person control of the roleplay character (inside the 3D canvas).
 *
 * - W/S/A/D move, mouse looks (Pointer Lock; drag-to-look when the browser refuses it), hold Shift
 *   to run (4.4 m/s; walking 1.35 m/s). Diagonals are normalised; keys are released on blur/visibility change and ignored
 *   while typing.
 * - Every step goes through PlayerNavigator: the same walkways, stairs and walls as the simulated
 *   people, real height from the walkway (no flying, no falling through floors, no teleport).
 *   The frame step is capped (dt ≤ 50 ms) and sub-stepped at 6 cm, so a dropped frame never
 *   becomes a jump through a wall.
 * - The old walk mode is switched off while this runs; only one controller moves the camera.
 */
import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls } from "three-stdlib";
import { evacuationRuntime } from "../simulation/runtime";
import { useEvacuationStore } from "../simulation/simulationStore";
import { pointRisk, modeledTemperatureFromHeat } from "../simulation/graph";
import { useWalkStore } from "../navigation/walkStore";
import { EYE_HEIGHT, guideLookahead, headingDegFromYaw, PlayerNavigator, relativeBearing, surfaceSpeedFactor } from "./playerMotion";
import { FLAME_LIMIT_S, roleplaySession as session } from "./session";
import { useRoleplayStore } from "./roleplayStore";
import type { Vec3 } from "../simulation/types";
import { exposeRoleplayForQa } from "./lifecycle";

const WALK_SPEED = 1.35;
/** Shift = run. 4.4 m/s is a fast run (walk 1.35); still sub-stepped at 6 cm, so never through a wall. */
const HURRY_SPEED = 4.4;
const LOOK_SENSITIVITY = 0.0022;
const BODY_RADIUS = 0.42;
const GUIDE_EVERY_S = 0.15;
const HEARTBEAT_MS = 2000;
const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"];

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** A field that takes typed text (a focused checkbox or button does not stop walking). */
function isTyping(target: EventTarget | null) {
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** Exposed for automated tests: the same input path as the keyboard. */
export const roleplayKeys = new Set<string>();
exposeRoleplayForQa({ keys: roleplayKeys, session, store: useRoleplayStore, runtime: evacuationRuntime, sim: useEvacuationStore });

/** Longest step taken in one frame (s): a dropped frame never becomes a long jump. */
export const MAX_FRAME_DT = 0.05;
const velocity = { x: 0, forward: 0 };
const look = { dx: 0, dy: 0 };
let guideClock = 0;
/** Seconds the character has been held back by people only (not walls). */
let squeezeClock = 0;
const SQUEEZE_AFTER_S = 1.2;
const SQUEEZE_SPEED = 0.35;

/**
 * One step of the character: look, move (walls/stairs/people), crowd/smoke exposure, phone pose,
 * arrival. Called by the frame loop with the frame's (capped) dt; nothing here depends on the
 * renderer, so automated tests can drive the same function when the renderer is too slow.
 */
export function stepRoleplay(dt: number) {
  const navigator = session.navigator;
  if (!navigator || useRoleplayStore.getState().phase !== "playing") return;
  const store = useRoleplayStore.getState();
  const sim = useEvacuationStore.getState();
  const started = performance.now();

  // Look.
  session.yaw -= look.dx * LOOK_SENSITIVITY;
  session.pitch = THREE.MathUtils.clamp(session.pitch - look.dy * LOOK_SENSITIVITY, -1.2, 1.2);
  look.dx = 0; look.dy = 0;

  // Move (only while the shared simulation clock runs and the menu is closed).
  const moving = sim.status === "running" && !store.menuOpen;
  const typing = isTyping(document.activeElement);
  const k = (code: string) => (!typing && moving && roleplayKeys.has(code) ? 1 : 0);
  let x = k("KeyD") + k("ArrowRight") - k("KeyA") - k("ArrowLeft");
  let forward = k("KeyW") + k("ArrowUp") - k("KeyS") - k("ArrowDown");
  const length = Math.hypot(x, forward);
  if (length > 1) { x /= length; forward /= length; }
  velocity.x = THREE.MathUtils.damp(velocity.x, x, 14, dt);
  velocity.forward = THREE.MathUtils.damp(velocity.forward, forward, 14, dt);
  const hurry = k("ShiftLeft") || k("ShiftRight");
  const speed = (hurry ? HURRY_SPEED : WALK_SPEED) * surfaceSpeedFactor(navigator.support);
  const c = Math.cos(session.yaw), s = Math.sin(session.yaw);
  const dx = (c * velocity.x - s * velocity.forward) * speed * dt;
  const dz = (-s * velocity.x - c * velocity.forward) * speed * dt;
  if (moving && Math.hypot(dx, dz) > 1e-5) {
    // Simulated people within reach: the character cannot walk through them.
    const here = navigator.position;
    const near: Vec3[] = [];
    for (const agent of evacuationRuntime.agents) {
      if (agent.status === "arrived" || agent.status === "incapacitated") continue;
      if (Math.abs(agent.position[1] - here[1]) > 1.2) continue;
      if (Math.abs(agent.position[0] - here[0]) > 2 || Math.abs(agent.position[2] - here[2]) > 2) continue;
      near.push(agent.position);
    }
    const blockedByPerson = (from: Vec3, to: Vec3) => near.some((p) => {
      const after = Math.hypot(p[0] - to[0], p[2] - to[2]);
      return after < BODY_RADIUS && after < Math.hypot(p[0] - from[0], p[2] - from[2]);
    });
    const before: Vec3 = [...navigator.position];
    // Stuck against people for over a second (two people facing each other on a stair), the
    // character squeezes past slowly, as people do — walls and floors still apply in full.
    const squeezing = squeezeClock > SQUEEZE_AFTER_S;
    const result = squeezing ? navigator.move(dx * SQUEEZE_SPEED, dz * SQUEEZE_SPEED) : navigator.move(dx, dz, near.length ? blockedByPerson : undefined);
    const requested = Math.hypot(dx, dz);
    if (!squeezing && near.length && result.blocked && result.travelled < requested * 0.2) {
      // Blocked by a wall too? Only people count: try the same step ignoring people.
      const probe = new PlayerNavigator(navigator.world, [...before] as Vec3, navigator.support);
      const free = probe.move(dx, dz);
      squeezeClock = free.travelled > requested * 0.5 ? squeezeClock + dt : 0;
    } else if (!result.blocked) squeezeClock = 0;
    session.stats.distance += Math.hypot(navigator.position[0] - before[0], navigator.position[2] - before[2]);
  }
  evacuationRuntime.playerBody = [...navigator.position];

  session.perf.frames += 1;
  session.perf.clock += dt;
  session.perf.moveMs += performance.now() - started;

  // Guide, exposure, pose reports: a few times a second, never per frame.
  guideClock += dt;
  if (guideClock < GUIDE_EVERY_S) return;
  const step = guideClock;
  guideClock = 0;
  const guideStarted = performance.now();
  const position = navigator.position;
  const place = navigator.place();
  const stats = session.stats;
  const counting = sim.status === "running" && !store.menuOpen;
  const crowd = evacuationRuntime.peopleAround(position, 2.5);
  const risk = pointRisk(position, evacuationRuntime.fires, evacuationRuntime.time);
  const temperature = modeledTemperatureFromHeat(risk.heat, evacuationRuntime.config.ambientTemperatureC ?? 29);
  if (counting) {
    if (crowd >= 6) stats.crowdedSeconds += step;
    if (risk.smoke > 0.05) { stats.smokeSeconds += step; stats.smokeIndex += risk.smoke * step; }
    stats.maxTemperatureC = Math.max(stats.maxTemperatureC, temperature);
    stats.flameSeconds = risk.blocked || risk.fire > 0.5 ? stats.flameSeconds + step : 0;
  }
  const route = session.route;
  const lookahead = route && route.nodeIds.length > 1 ? guideLookahead(navigator.world, navigator.support, route.nodeIds, route.edgeIds, position, 3) : null;
  if (counting && lookahead) {
    if (lookahead.offRoute <= 2.5) stats.followedSeconds += step; else stats.offRouteSeconds += step;
  }
  const headingDeg = headingDegFromYaw(session.yaw);
  store.set({
    guide: {
      bearingDeg: lookahead ? relativeBearing(position, lookahead.waypoint, session.yaw) : null,
      distanceM: lookahead ? lookahead.remainingM : null,
      vertical: lookahead?.vertical ?? null,
      targetFloor: lookahead?.targetFloor ?? null,
      offRouteM: lookahead?.offRoute ?? 0,
      place,
      position: [...position],
      headingDeg,
      crowdNearby: crowd,
      hazardHere: Math.min(1, Math.max(risk.smoke, risk.fire, risk.blocked ? 1 : 0)),
    },
    hud: {
      seconds: Math.max(0, evacuationRuntime.time - stats.startSimTime),
      distance: stats.distance,
      reroutes: stats.reroutes.length,
      crowdedSeconds: stats.crowdedSeconds,
      smokeSeconds: stats.smokeSeconds,
      running: counting,
    },
  });
  // The phone learns where the character is: on a new graph node at once, else every 2 s.
  const now = Date.now();
  if (session.reportPose && (place.nodeId !== session.lastReportedNode || now - session.lastReportedAt >= HEARTBEAT_MS)) {
    session.lastReportedNode = place.nodeId;
    session.lastReportedAt = now;
    session.reportPose({ nodeId: place.nodeId, position: [...position], headingDeg: Math.round(headingDeg) });
  }
  session.perf.guideMs += performance.now() - guideStarted;
  session.perf.guides += 1;
  if (counting) {
    const area = evacuationRuntime.assemblyAreaAt(position);
    if (area) session.onArrive?.(area.nodeId);
    else if (stats.flameSeconds >= FLAME_LIMIT_S) session.onFail?.("ตัวละครสัมผัสเปลวไฟ/ความร้อนสูงในแบบจำลองต่อเนื่อง — จบรอบ");
  }
}

/**
 * Automated tests (`?qa=1`) only: advance the shared world and the character by `seconds` in
 * 1/60 s steps — the same runtime.advance the scene calls and the same stepRoleplay the frame loop
 * calls — for headless browsers whose software renderer draws under 1 frame per second.
 */
function qaTick(seconds: number) {
  const steps = Math.max(1, Math.round(seconds * 60));
  for (let index = 0; index < steps; index += 1) {
    if (useEvacuationStore.getState().status === "running") evacuationRuntime.advance(1 / 60, 4);
    stepRoleplay(1 / 60);
  }
}
exposeRoleplayForQa({ tick: qaTick });

export function RoleplayController() {
  const phase = useRoleplayStore((state) => state.phase);
  const active = phase === "playing";
  const { camera, gl, scene } = useThree();
  const controls = useThree((state) => state.controls) as OrbitControls | null;
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, "YXZ"), []);
  const temp = useMemo(() => ({ local: new THREE.Vector3(), root: new THREE.Quaternion(), view: new THREE.Quaternion() }), []);

  // Keyboard: one listener set while playing, released on blur, ignored while typing.
  useEffect(() => {
    if (!active) return undefined;
    useWalkStore.getState().setEnabled(false);
    velocity.x = 0; velocity.forward = 0; look.dx = 0; look.dy = 0; guideClock = 0; squeezeClock = 0;
    const release = () => { roleplayKeys.clear(); velocity.x = 0; velocity.forward = 0; };
    const down = (event: KeyboardEvent) => {
      if (isTyping(event.target)) { roleplayKeys.clear(); return; }
      if (event.code === "Escape") {
        // With the pointer locked the browser releases it itself (no keydown reaches us). Unlocked,
        // Esc opens/closes the menu.
        const store = useRoleplayStore.getState();
        if (!document.pointerLockElement) { event.preventDefault(); store.set({ menuOpen: !store.menuOpen }); }
        return;
      }
      if (MOVE_KEYS.includes(event.code)) { event.preventDefault(); roleplayKeys.add(event.code); }
    };
    const up = (event: KeyboardEvent) => roleplayKeys.delete(event.code);
    const focus = (event: FocusEvent) => { if (isTyping(event.target)) release(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    window.addEventListener("focusin", focus);
    document.addEventListener("visibilitychange", release);
    return () => {
      release();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      window.removeEventListener("focusin", focus);
      document.removeEventListener("visibilitychange", release);
    };
  }, [active]);

  // Mouse look: Pointer Lock on click; if unsupported or refused, drag with the mouse to look.
  useEffect(() => {
    if (!active) return undefined;
    const canvas = gl.domElement;
    const supported = typeof canvas.requestPointerLock === "function";
    useRoleplayStore.getState().set({ pointer: supported ? "free" : "unsupported" });
    let refused = !supported;
    let drag: { id: number; x: number; y: number } | null = null;
    const onLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      useRoleplayStore.getState().set({ pointer: locked ? "locked" : refused ? "unsupported" : "free" });
    };
    const onLockError = () => { refused = true; useRoleplayStore.getState().set({ pointer: "unsupported" }); };
    const onClick = () => {
      if (refused || document.pointerLockElement === canvas || useRoleplayStore.getState().menuOpen) return;
      try {
        const result = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (result && typeof result.catch === "function") result.catch(onLockError);
      } catch { onLockError(); }
    };
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      look.dx += event.movementX; look.dy += event.movementY;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!refused || event.pointerType === "touch" || drag) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      look.dx += event.clientX - drag.x; look.dy += event.clientY - drag.y;
      drag.x = event.clientX; drag.y = event.clientY;
    };
    const endDrag = (event?: PointerEvent) => {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      if (canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
      drag = null;
    };
    const onBlur = () => endDrag();
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    canvas.addEventListener("click", onClick);
    document.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", onBlur);
    return () => {
      endDrag();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      canvas.removeEventListener("click", onClick);
      document.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, gl]);

  // The menu releases the mouse.
  const menuOpen = useRoleplayStore((state) => state.menuOpen);
  useEffect(() => { if (menuOpen && document.pointerLockElement === gl.domElement) document.exitPointerLock(); }, [menuOpen, gl]);

  // Leaving the run: give the camera back and remove the body from the crowd.
  useEffect(() => {
    if (!active) return undefined;
    return () => {
      evacuationRuntime.playerBody = null;
      if (controls) controls.enabled = true;
      delete gl.domElement.dataset.roleplayPosition;
    };
  }, [active, controls, gl]);

  useFrame((_, delta) => {
    if (!active || document.hidden) return;
    const navigator = session.navigator;
    if (!navigator) return;
    if (controls) controls.enabled = false;
    stepRoleplay(Math.min(delta, MAX_FRAME_DT));
    // Camera: eye height smoothed for comfort (the body's height itself is never smoothed).
    const dt = Math.min(delta, MAX_FRAME_DT);
    const eyeTarget = navigator.position[1] + EYE_HEIGHT;
    session.eyeY = session.eyeY === null ? eyeTarget : THREE.MathUtils.damp(session.eyeY, eyeTarget, 18, dt);
    const root = scene.getObjectByName("CALIBRATED_MODEL_ROOT");
    temp.local.set(navigator.position[0], session.eyeY, navigator.position[2]);
    if (root) { root.updateWorldMatrix(true, false); root.localToWorld(temp.local); root.getWorldQuaternion(temp.root); } else temp.root.identity();
    camera.position.copy(temp.local);
    temp.view.setFromEuler(euler.set(session.pitch, session.yaw, 0));
    camera.quaternion.copy(temp.root).multiply(temp.view);
    gl.domElement.dataset.roleplayPosition = navigator.position.map((v) => v.toFixed(2)).join(",");
  });

  return null;
}

/** Marker of the planned spawn point during setup (green = valid, orange = invalid, blue = suggestion). */
export function RoleplaySpawnMarker() {
  const phase = useRoleplayStore((state) => state.phase);
  const plan = useRoleplayStore((state) => state.plan);
  if (phase !== "setup" || !plan) return null;
  const marks: Array<{ point: Vec3; color: string; key: string }> = [];
  if (plan.requested.point) marks.push({ point: plan.requested.point, color: plan.requested.ok ? "#1f9d63" : "#e0661b", key: "requested" });
  if (plan.suggestion?.point) marks.push({ point: plan.suggestion.point, color: "#2f7de1", key: "suggestion" });
  return (
    <group name="ROLEPLAY_SPAWN_MARKER">
      {marks.map((mark) => (
        <group key={mark.key} position={mark.point}>
          {/* Drawn over walls (depthTest off) so the point is visible from outside the building. */}
          <mesh position={[0, 0.9, 0]} renderOrder={20}>
            <cylinderGeometry args={[0.28, 0.28, 1.8, 20]} />
            <meshBasicMaterial color={mark.color} transparent opacity={0.6} depthWrite={false} depthTest={false} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} renderOrder={20}>
            <ringGeometry args={[0.42, 0.62, 32]} />
            <meshBasicMaterial color={mark.color} transparent opacity={0.9} depthWrite={false} depthTest={false} />
          </mesh>
          <mesh position={[0, 2.4, 0]} rotation={[Math.PI, 0, 0]} renderOrder={20}>
            <coneGeometry args={[0.32, 0.6, 16]} />
            <meshBasicMaterial color={mark.color} transparent opacity={0.95} depthWrite={false} depthTest={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
