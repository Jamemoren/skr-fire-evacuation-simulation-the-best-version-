/**
 * Roleplay Evacuation Simulator — page side: setup, the player's phone, menu and results, and the
 * lifecycle of one run on the guidance server.
 *
 * Lifecycle (no duplicates, nothing left behind):
 *  start  → a new simulation incident ("สวมบทอพยพ (SIMULATOR)", not made the control centre's
 *           active incident) → closures → evacuate → player ticket → the player's phone source
 *           (created in an effect, disposed in its cleanup) → simulator adapter (rAF loop, effect).
 *  finish → simulation paused, incident ended, phone/adapter disposed by their effect cleanups.
 *  exit   → the user's own simulation settings, fires and closures are put back.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { evacuationRuntime } from "../simulation/runtime";
import { useEvacuationStore } from "../simulation/simulationStore";
import { useBuilding1Store } from "../building1/building1Store";
import { computeMapVersion, displayNodeName, getMapRegistry } from "../evac/mapRegistry";
import { computeRouteField, pathFromField } from "../evac/routing";
import { staffApi } from "../mobile-host/staffClient";
import { PhoneFrame } from "../mobile-host/PhoneFrame";
import { MobileApp } from "../mobile/MobileApp";
import { createLiveSource, type MobileSource } from "../mobile/client";
import type { Vec3 } from "../simulation/types";
import { restoreSettings } from "./lifecycle";
import { PlayerNavigator, routeLookahead, walkWorld } from "./playerMotion";
import { emptyStats, resetSession, roleplaySession as session } from "./session";
import { useRoleplayStore, type RoleplayResult } from "./roleplayStore";
import { SimulatorWorldAdapter } from "./simulatorAdapter";
import { RoleplaySetup } from "./RoleplaySetup";
import { REAL_MODE_NOT_READY } from "./providers";
import "../mobile/mobile.css";
import "../mobile-host/host.css";
import "./roleplay.css";

const STAFF_TOKEN_KEY = "skr-evac-staff-token";
/** Simulator adapter rhythm: a slice of passages every 50 ms (a full scan ≈ every 0.5 s). */
const ADAPTER_INTERVAL_MS = 50;

async function staffToken(): Promise<string> {
  try { const stored = window.sessionStorage.getItem(STAFF_TOKEN_KEY); if (stored) return stored; } catch { /* storage blocked */ }
  const response = await fetch("/api/auth/local-staff", { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 403 ? "ต้องเข้าสู่ระบบเจ้าหน้าที่ในแผงระบบนำทางมือถือก่อน" : "ไม่พบเซิร์ฟเวอร์ระบบนำทาง");
  const data = await response.json() as { token: string };
  try { window.sessionStorage.setItem(STAFF_TOKEN_KEY, data.token); } catch { /* storage blocked */ }
  return data.token;
}

function fmt(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Yaw that looks along the first route from a point (falls back to −Z). */
function initialYaw(navigator: PlayerNavigator): number {
  const registry = getMapRegistry();
  const field = computeRouteField(registry, "standard", { closedEdges: new Set(), hazardBlockedEdges: new Set(), hazardMarginEdges: new Map(), edgeLoad: new Map(), assemblyLoad: new Map() });
  const path = pathFromField(field, navigator.nearestNode(), registry);
  const look = path && path.edgeIds.length ? routeLookahead(navigator.world, path.nodeIds, path.edgeIds, navigator.position, 2) : null;
  if (!look) return 0;
  return Math.atan2(-(look.waypoint[0] - navigator.position[0]), -(look.waypoint[2] - navigator.position[2]));
}

/** A route node about `metres` ahead of the character (for "fire ahead" during a run). */
function nodeAhead(metres: number): Vec3 | null {
  const navigator = session.navigator;
  const route = session.route;
  if (!navigator || !route) return null;
  const registry = getMapRegistry();
  let from = navigator.position;
  let travelled = 0;
  const here = route.nodeIds.indexOf(navigator.nearestNode());
  for (const nodeId of route.nodeIds.slice(Math.max(0, here + 1))) {
    const node = registry.nodeMap.get(nodeId);
    if (!node) continue;
    travelled += Math.hypot(node.position[0] - from[0], node.position[2] - from[2]);
    from = node.position;
    if (travelled >= metres && node.type !== "assembly") return [...node.position] as Vec3;
  }
  return null;
}

interface Run { incidentId: string; ticket: string; token: string }

export function RoleplayHost() {
  const phase = useRoleplayStore((state) => state.phase);
  const menuOpen = useRoleplayStore((state) => state.menuOpen);
  const result = useRoleplayStore((state) => state.result);
  const backend = useRoleplayStore((state) => state.backend);
  const set = useRoleplayStore((state) => state.set);
  const [run, setRun] = useState<Run | null>(null);
  const [source, setSource] = useState<MobileSource | null>(null);
  const runRef = useRef<Run | null>(null);
  runRef.current = run;
  const finishing = useRef(false);

  // ---------------------------------------------------------------- run end
  const endIncident = useCallback((current: Run | null) => {
    if (!current) return;
    void staffApi(current.token, `/api/admin/incidents/${current.incidentId}/end`, {}).catch(() => undefined);
  }, []);

  const finish = useCallback((outcome: RoleplayResult["outcome"], reason: string, assemblyNodeId: string | null) => {
    if (finishing.current) return;
    finishing.current = true;
    const sim = useEvacuationStore.getState();
    if (sim.status === "running") sim.pause();
    const stats = session.stats;
    const followed = stats.followedSeconds + stats.offRouteSeconds;
    const assembly = assemblyNodeId ? getMapRegistry().nodeMap.get(assemblyNodeId) : undefined;
    const outcomeResult: RoleplayResult = {
      outcome, reason, assemblyNodeId, assemblyName: assembly ? displayNodeName(assembly) : null,
      seconds: Math.max(0, evacuationRuntime.time - stats.startSimTime), distance: stats.distance, reroutes: [...stats.reroutes],
      crowdedSeconds: stats.crowdedSeconds, smokeSeconds: stats.smokeSeconds, smokeIndex: stats.smokeIndex, maxTemperatureC: stats.maxTemperatureC,
      followedShare: followed > 0 ? stats.followedSeconds / followed : null,
    };
    // Tell the server where the run ended (the arrival point is the character's own position).
    if (assemblyNodeId && session.navigator) session.reportPose?.({ nodeId: assemblyNodeId, position: [...session.navigator.position], headingDeg: 0 });
    session.reportPose = null; session.onArrive = null; session.onFail = null;
    if (document.pointerLockElement) void document.exitPointerLock();
    const current = runRef.current;
    window.setTimeout(() => endIncident(current), assemblyNodeId ? 600 : 0);
    setRun(null);
    set({ phase: "result", result: outcomeResult, menuOpen: false });
  }, [endIncident, set]);

  // ---------------------------------------------------------------- start
  const start = useCallback(async () => {
    const state = useRoleplayStore.getState();
    const plan = state.plan;
    const spawn = plan?.requested.ok ? plan.requested.point : state.acceptSuggestion ? plan?.suggestion?.point ?? null : null;
    if (!spawn) return;
    const navigator = PlayerNavigator.at(walkWorld(), spawn);
    if (!navigator) { set({ backend: { state: "unavailable", text: "จุดเกิดไม่อยู่บนพื้นที่เดินได้" } }); return; }
    resetSession();
    finishing.current = false;
    session.navigator = navigator;
    session.yaw = initialYaw(navigator);
    session.stats = emptyStats(evacuationRuntime.time);
    session.onArrive = (nodeId) => finish("arrived", "ถึงพื้นที่จุดรวมพลด้วยการเดินของตัวละคร", nodeId);
    session.onFail = (reason) => finish("failed", reason, null);
    set({ phase: "starting", menuOpen: false, guide: null, result: null, backend: { state: "connecting", text: "กำลังเปิดรอบจำลองบนเซิร์ฟเวอร์…" } });

    let next: Run | null = null;
    try {
      const token = await staffToken();
      const map = await fetch("/api/map", { cache: "no-store" }).then((response) => (response.ok ? response.json() as Promise<{ mapVersion: string }> : Promise.reject(new Error("map"))));
      if (map.mapVersion !== computeMapVersion(evacuationRuntime.graph)) throw new Error(`แผนที่ของโมเดล 3 มิติไม่ตรงกับเซิร์ฟเวอร์ (${map.mapVersion})`);
      const { incident } = await staffApi<{ incident: { id: string } }>(token, "/api/admin/incidents", { mode: "simulation", title: "สวมบทอพยพ (SIMULATOR)", activate: false });
      for (const group of evacuationRuntime.passageGroups()) {
        if (group.closed) await staffApi(token, `/api/admin/incidents/${incident.id}/closures`, { edgeIds: group.edgeIds.slice(0, 50), closed: true, reason: `${group.label} ปิดในแบบจำลอง` });
      }
      await staffApi(token, `/api/admin/incidents/${incident.id}/evacuate`, {});
      const { ticket } = await staffApi<{ ticket: string }>(token, `/api/admin/incidents/${incident.id}/player-ticket`, {});
      next = { incidentId: incident.id, ticket, token };
    } catch (error) {
      set({ backend: { state: "unavailable", text: `มือถือผู้เล่นใช้ไม่ได้ในรอบนี้: ${error instanceof Error ? error.message : "เชื่อมต่อไม่สำเร็จ"} — ยังเดินอพยพในแบบจำลองได้ แต่ไม่มีคำแนะนำจากระบบ` } });
    }
    if (useRoleplayStore.getState().phase !== "starting") { endIncident(next); return; }
    if (next) set({ backend: { state: "ready", text: "" }, incidentId: next.incidentId });
    setRun(next);
    const floor = navigator.place().floor;
    // The whole building stays drawn (every floor), not only the character's floor and below.
    if (navigator.place().buildingId === "building-1") useBuilding1Store.getState().setSelectedFloor(floor);
    useBuilding1Store.getState().setViewMode("exterior");
    useEvacuationStore.getState().setSpeedFactor(1);
    useEvacuationStore.getState().resume();
    set({ phase: "playing" });
  }, [endIncident, finish, set]);

  // ---------------------------------------------------------------- player phone (effect-owned)
  useEffect(() => {
    if (!run) return undefined;
    const live = createLiveSource({ kind: "player", previewTicket: run.ticket, incidentId: run.incidentId });
    setSource(live);
    session.reportPose = (pose) => live.actions?.reportSimulatorPose?.(pose);
    let lastRtt: number | null = null;
    const unsubscribe = live.subscribe(() => {
      const state = live.getState();
      const advice = state.view?.advice ?? null;
      if (advice && (advice.status === "ok" || advice.status === "stale-location") && advice.nodeIds.length > 1) {
        if (!session.route || session.route.routeId !== advice.routeId) {
          if (session.route && advice.routeRevision > session.route.revision) {
            session.stats.reroutes.push({ at: Math.max(0, evacuationRuntime.time - session.stats.startSimTime), reason: advice.reason?.text ?? "เปลี่ยนเส้นทาง" });
          }
          session.route = { routeId: advice.routeId, revision: advice.routeRevision, nodeIds: advice.nodeIds, edgeIds: advice.edgeIds, destinationId: advice.destination?.nodeId ?? null };
        }
      } else if (advice && (advice.status === "no-route" || advice.status === "mobility-no-route")) {
        session.route = null;
      }
      if (state.poseRoundTripMs !== lastRtt) {
        lastRtt = state.poseRoundTripMs;
        useRoleplayStore.setState((current) => ({ perf: { ...current.perf, poseRttMs: lastRtt } }));
      }
    });
    return () => {
      unsubscribe();
      if (session.reportPose) session.reportPose = null;
      session.route = null;
      live.dispose();
      setSource(null);
    };
  }, [run]);

  // Simulated network cut of the player's phone.
  const networkOnline = useRoleplayStore((state) => state.phone.networkOnline);
  useEffect(() => { source?.actions?.setSimulatedNetwork?.(networkOnline); }, [source, networkOnline]);

  // ---------------------------------------------------------------- simulator adapter (effect-owned)
  useEffect(() => {
    if (!run || phase !== "playing") return undefined;
    const adapter = new SimulatorWorldAdapter(evacuationRuntime, (payload) => staffApi(run.token, `/api/admin/incidents/${run.incidentId}/sim-world`, payload));
    // A timer, not the render loop: the world snapshot keeps its rhythm even when frames drop.
    let lastPerf = performance.now();
    const loop = () => {
      if (useEvacuationStore.getState().status === "running") adapter.step();
      const now = performance.now();
      if (now - lastPerf > 1000) {
        lastPerf = now;
        const frames = Math.max(1, session.perf.frames);
        useRoleplayStore.setState((current) => ({ perf: { ...current.perf,
          moveMs: session.perf.moveMs / frames, guideMs: session.perf.guideMs / Math.max(1, session.perf.guides),
          adapterMs: adapter.averageScanMs(), worldRttMs: adapter.stats.lastRttMs, worldRttAvgMs: adapter.averageRttMs(), worldSends: adapter.stats.sends } }));
      }
    };
    const timer = window.setInterval(loop, ADAPTER_INTERVAL_MS);
    return () => { window.clearInterval(timer); adapter.dispose(); };
  }, [run, phase]);

  // Closures changed during the run are sent to the server as closures (not as fire).
  useEffect(() => {
    if (!run) return undefined;
    let previous = new Set(useEvacuationStore.getState().closedPassages);
    return useEvacuationStore.subscribe((state) => {
      if (state.closedPassages === undefined) return;
      const now = new Set(state.closedPassages);
      const changed = evacuationRuntime.passageGroups().filter((group) => now.has(group.id) !== previous.has(group.id));
      previous = now;
      for (const group of changed) {
        void staffApi(run.token, `/api/admin/incidents/${run.incidentId}/closures`, { edgeIds: group.edgeIds.slice(0, 50), closed: now.has(group.id), reason: `${group.label} ปิดในแบบจำลอง` }).catch(() => undefined);
      }
    });
  }, [run]);

  // Menu pauses the shared clock; closing it resumes.
  useEffect(() => {
    if (phase !== "playing") return;
    const sim = useEvacuationStore.getState();
    if (menuOpen && sim.status === "running") sim.pause();
    if (!menuOpen && sim.status === "paused") sim.resume();
  }, [menuOpen, phase]);

  // Building 1: keep the floor selector in step with the character, but draw the whole building
  // (all nine floors) — the player asked to see the building around them, not a cut-away slice.
  const playerFloor = useRoleplayStore((state) => (state.phase === "playing" && state.guide?.place.buildingId === "building-1" ? state.guide.place.floor : null));
  useEffect(() => {
    if (playerFloor === null) return;
    const building = useBuilding1Store.getState();
    building.setSelectedFloor(playerFloor);
    if (building.viewMode !== "exterior") building.setViewMode("exterior");
  }, [playerFloor]);

  // Unmounting mid-run ends the incident. (A closed tab cannot: its incident stays until staff end it.)
  useEffect(() => () => endIncident(runRef.current), [endIncident]);

  const exit = useCallback(() => {
    if (useRoleplayStore.getState().phase === "playing" || useRoleplayStore.getState().phase === "starting") {
      finishing.current = true;
      endIncident(runRef.current);
      setRun(null);
    }
    if (document.pointerLockElement) void document.exitPointerLock();
    resetSession();
    useRoleplayStore.getState().close();
    restoreSettings();
  }, [endIncident]);

  const restart = useCallback(() => {
    if (useRoleplayStore.getState().phase === "playing") { finishing.current = true; endIncident(runRef.current); setRun(null); }
    if (document.pointerLockElement) void document.exitPointerLock();
    resetSession();
    useRoleplayStore.getState().open();
  }, [endIncident]);

  if (phase === "off") return null;
  return (
    <div className="rp-root" data-phase={phase}>
      {phase === "setup" && <RoleplaySetup onStart={() => void start()} onCancel={exit} backendNote="ทุกอย่างในโหมดนี้เป็นข้อมูลจำลอง (SIMULATOR) ไม่ใช่เหตุจริงและไม่ส่งสัญญาณเตือนใด ๆ · การเข้าโหมดนี้รีเซ็ตการจำลองที่ค้างอยู่ ค่าตั้งเดิม ไฟ และทางปิดของคุณจะกลับมาเมื่อออกจากโหมด" />}
      {phase === "starting" && <div className="rp-toast" role="status">{backend.text || "กำลังเริ่ม…"}</div>}
      {(phase === "playing" || phase === "starting") && <PlayHud source={source} onMenu={() => set({ menuOpen: true })} />}
      {phase === "playing" && menuOpen && <Menu onResume={() => set({ menuOpen: false })} onRestart={restart} onExit={exit} />}
      {phase === "result" && result && <Results result={result} onRestart={restart} onExit={exit} />}
    </div>
  );
}

// ------------------------------------------------------------------ HUD + phone

function PlayHud({ source, onMenu }: { source: MobileSource | null; onMenu: () => void }) {
  const hud = useRoleplayStore((state) => state.hud);
  const pointer = useRoleplayStore((state) => state.pointer);
  const guide = useRoleplayStore((state) => state.guide);
  const backend = useRoleplayStore((state) => state.backend);
  const phone = useRoleplayStore((state) => state.phone);
  const set = useRoleplayStore((state) => state.set);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { id: event.pointerId, x: event.clientX, width: phone.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const width = Math.max(300, Math.min(Math.round(window.innerWidth * 0.5), drag.current.width + drag.current.x - event.clientX));
    set({ phone: { ...phone, width } });
  };
  const onResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const width = Math.max(300, Math.min(Math.round(window.innerWidth * 0.5), phone.width + (event.key === "ArrowLeft" ? 24 : -24)));
    set({ phone: { ...phone, width } });
  };
  return (
    <>
      <div className="rp-crosshair" aria-hidden="true" />
      <section className="rp-hud" aria-label="สถานะผู้เล่น">
        <span className="rp-tag">SIMULATOR · ผู้เล่นสวมบท</span>
        <dl>
          <div><dt>เวลา</dt><dd>{fmt(hud.seconds)}</dd></div>
          <div><dt>ระยะเดิน</dt><dd>{Math.round(hud.distance)} ม.</dd></div>
          <div><dt>เปลี่ยนเส้นทาง</dt><dd>{hud.reroutes} ครั้ง</dd></div>
          <div><dt>อยู่ในที่แออัด</dt><dd>{Math.round(hud.crowdedSeconds)} วิ</dd></div>
        </dl>
        {guide && <p className="rp-place">ตำแหน่ง: {guide.place.buildingId === "site" ? "ภายนอกอาคาร" : `${guide.place.buildingId.replace("building-", "อาคาร ")} ชั้น ${guide.place.floor}`}</p>}
        <p className="rp-help">
          <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> เดิน · <kbd>Shift</kbd> เร่ง · {pointer === "locked" ? <>เมาส์หันมอง · <kbd>Esc</kbd> ปลดเมาส์</> : pointer === "unsupported" ? <>ลากเมาส์ค้างเพื่อหันมอง (เบราว์เซอร์ไม่อนุญาต Pointer Lock)</> : <>คลิกฉากเพื่อหันมองด้วยเมาส์ · <kbd>Esc</kbd> เมนู</>}
        </p>
        <button type="button" className="rp-btn is-sm" onClick={onMenu}>เมนู / หยุดชั่วคราว</button>
      </section>
      <aside className={`rp-phone${phone.minimized ? " is-min" : ""}`} style={{ width: phone.minimized ? undefined : phone.width }} aria-label="มือถือผู้เล่น (SIMULATOR)">
        {!phone.minimized && (
          <div className="rp-phone-resize" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างแผงมือถือ (ลูกศรซ้าย/ขวา)" tabIndex={0}
            onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={() => { drag.current = null; }} onKeyDown={onResizeKey} />
        )}
        <header className="rp-phone-head">
          <strong>มือถือผู้เล่น</strong>
          <span className="rp-tag is-small">SIMULATOR · ไม่ใช่มือถือผู้ทดสอบเดิม</span>
          <div className="rp-phone-tools">
            <label className="rp-switch" title="จำลองเครือข่ายขาด">
              <input type="checkbox" checked={phone.networkOnline} onChange={(event) => set({ phone: { ...phone, networkOnline: event.target.checked } })} />
              <span>{phone.networkOnline ? "เครือข่ายปกติ" : "เครือข่ายขาด (จำลอง)"}</span>
            </label>
            <button type="button" className="rp-btn is-sm" aria-expanded={!phone.minimized} onClick={() => set({ phone: { ...phone, minimized: !phone.minimized } })}>{phone.minimized ? "แสดงมือถือ" : "ย่อ"}</button>
          </div>
        </header>
        {!phone.minimized && (
          <div className="rp-phone-body">
            {source ? (
              <PhoneFrame size="standard" zoom="fit" label="มือถือผู้เล่น (SIMULATOR)">
                <MobileApp source={source} playerGuide={guide} />
              </PhoneFrame>
            ) : (
              <p className="rp-alert is-warn" role="status">{backend.text || "กำลังเชื่อมมือถือผู้เล่น…"}</p>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

function Menu({ onResume, onRestart, onExit }: { onResume: () => void; onRestart: () => void; onExit: () => void }) {
  const perf = useRoleplayStore((state) => state.perf);
  const fps = useEvacuationStore((state) => state.renderFps);
  const agents = evacuationRuntime.agents.length;
  const [note, setNote] = useState("");
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstButton.current?.focus(); }, []);
  const addFireAhead = () => {
    const point = nodeAhead(15);
    if (!point) { setNote("ไม่มีเส้นทางข้างหน้าให้วางไฟ"); return; }
    evacuationRuntime.addFire(point);
    useEvacuationStore.getState().syncFromRuntime();
    setNote("เพิ่มไฟบนเส้นทางข้างหน้าแล้ว (ข้อมูลจำลอง) — ปิดเมนูเพื่อดูมือถือเปลี่ยนเส้นทาง");
  };
  const closeAhead = () => {
    const route = session.route;
    if (!route) { setNote("ยังไม่มีเส้นทาง"); return; }
    const here = Math.max(0, route.nodeIds.indexOf(session.navigator?.nearestNode() ?? ""));
    const ahead = new Set(route.edgeIds.slice(here));
    const group = evacuationRuntime.passageGroups().find((candidate) => !candidate.closed && candidate.edgeIds.some((edgeId) => ahead.has(edgeId)));
    if (!group) { setNote("ไม่มีบันได/ทางออกที่ปิดได้บนเส้นทางข้างหน้า"); return; }
    useEvacuationStore.getState().setPassageClosed(group.id, true);
    setNote(`ปิด${group.label}แล้ว (ข้อมูลจำลอง)`);
  };
  const portal = typeof document !== "undefined" ? document.body : null;
  const content = (
    <div className="rp-modal" role="dialog" aria-modal="true" aria-labelledby="rp-menu-title" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onResume(); } }}>
      <div className="rp-modal-card">
        <h2 id="rp-menu-title">หยุดชั่วคราว</h2>
        <p className="rp-muted">เวลาในแบบจำลองหยุดอยู่ NPC และไฟไม่เคลื่อนที่จนกว่าจะเล่นต่อ</p>
        <div className="rp-actions is-column">
          <button ref={firstButton} type="button" className="rp-btn is-primary" onClick={onResume}>เล่นต่อ</button>
          <button type="button" className="rp-btn" onClick={addFireAhead}>ทดสอบ: เพิ่มไฟบนเส้นทางข้างหน้า</button>
          <button type="button" className="rp-btn" onClick={closeAhead}>ทดสอบ: ปิดบันได/ทางออกบนเส้นทางข้างหน้า</button>
          <button type="button" className="rp-btn" onClick={onRestart}>เริ่มใหม่ (เลือกจุดเกิด)</button>
          <button type="button" className="rp-btn is-danger" onClick={onExit}>ออกจากโหมดสวมบท</button>
        </div>
        {note && <p className="rp-note" role="status">{note}</p>}
        <details className="rp-perf">
          <summary>ประสิทธิภาพที่วัดได้ (รอบนี้)</summary>
          <ul>
            <li>ภาพ: {fps ? `${fps} FPS` : "—"} · NPC {agents.toLocaleString("th-TH")} คน</li>
            <li>การเดินของผู้เล่น + ชนกำแพง/คน: {perf.moveMs.toFixed(2)} ms/เฟรม</li>
            <li>อัปเดตลูกศร/ความเสี่ยง: {perf.guideMs.toFixed(2)} ms/ครั้ง</li>
            <li>ตัวแปลงข้อมูลแบบจำลอง: {perf.adapterMs.toFixed(2)} ms/รอบ (ทุก 50 ms) · ส่ง {perf.worldSends} ครั้ง · ไป-กลับ {perf.worldRttMs ?? "—"} ms (เฉลี่ย {perf.worldRttAvgMs ? perf.worldRttAvgMs.toFixed(0) : "—"})</li>
            <li>มือถือผู้เล่นส่งตำแหน่ง ไป-กลับ: {perf.poseRttMs ?? "—"} ms</li>
          </ul>
        </details>
        <details className="rp-perf">
          <summary>โหมดใช้งานจริง (Real Mode): ยังไม่พร้อม</summary>
          <ul>{REAL_MODE_NOT_READY.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      </div>
    </div>
  );
  return portal ? createPortal(content, portal) : content;
}

function Results({ result, onRestart, onExit }: { result: RoleplayResult; onRestart: () => void; onExit: () => void }) {
  const title = result.outcome === "arrived" ? "ถึงจุดรวมพลแล้ว" : result.outcome === "failed" ? "จบรอบ" : "ออกจากรอบ";
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstButton.current?.focus(); }, []);
  return (
    <div className="rp-modal" role="dialog" aria-modal="true" aria-labelledby="rp-result-title">
      <div className={`rp-modal-card rp-result is-${result.outcome}`}>
        <span className="rp-tag">SIMULATOR · ผลจากแบบจำลอง</span>
        <h2 id="rp-result-title">{title}</h2>
        <p>{result.reason}</p>
        <dl className="rp-result-grid">
          <div><dt>เวลาในแบบจำลอง</dt><dd>{fmt(result.seconds)}</dd></div>
          <div><dt>ระยะที่เดิน</dt><dd>{Math.round(result.distance)} ม.</dd></div>
          <div><dt>จุดรวมพล</dt><dd>{result.assemblyName ?? "—"}</dd></div>
          <div><dt>เปลี่ยนเส้นทาง</dt><dd>{result.reroutes.length} ครั้ง</dd></div>
          <div><dt>อยู่ในที่แออัด (≥ 6 คนในรัศมี 2.5 ม.)</dt><dd>{Math.round(result.crowdedSeconds)} วินาที</dd></div>
          <div><dt>อยู่ในควัน (แบบจำลอง)</dt><dd>{Math.round(result.smokeSeconds)} วินาที · ดัชนี {result.smokeIndex.toFixed(1)}</dd></div>
          <div><dt>อุณหภูมิสูงสุดที่ตัวละครเจอ</dt><dd>{result.maxTemperatureC ? `${Math.round(result.maxTemperatureC)} °C` : "—"}</dd></div>
          <div><dt>เดินตามคำแนะนำ</dt><dd>{result.followedShare === null ? "ไม่มีคำแนะนำ" : `${Math.round(result.followedShare * 100)}% ของเวลา`}</dd></div>
        </dl>
        {result.reroutes.length > 0 && (
          <ol className="rp-reroutes">{result.reroutes.map((item, index) => <li key={index}><b>{fmt(item.at)}</b> {item.reason}</li>)}</ol>
        )}
        <p className="rp-muted">ตัวเลขทั้งหมดมาจากแบบจำลอง ใช้ฝึกและเปรียบเทียบสถานการณ์เท่านั้น ไม่ใช่การรับรองความปลอดภัยของเส้นทางจริง</p>
        <div className="rp-actions">
          <button ref={firstButton} type="button" className="rp-btn is-primary" onClick={onRestart}>เล่นอีกครั้ง</button>
          <button type="button" className="rp-btn" onClick={onExit}>ออก</button>
        </div>
      </div>
    </div>
  );
}
