import { useEffect, useMemo, useRef } from "react";
import { evacuationRuntime } from "../simulation/runtime";
import { useEvacuationStore } from "../simulation/simulationStore";
import { useBuilding1Store } from "../building1/building1Store";
import { useMapperStore } from "../store";
import { computeRouteField, pathFromField } from "../evac/routing";
import { getMapRegistry } from "../evac/mapRegistry";
import type { Vec3 } from "../simulation/types";
import { BUILDING_LABEL, planSpawn, spawnFloors, spawnLabel, spawnOptions } from "./spawn";
import { PlayerNavigator, walkWorld } from "./playerMotion";
import { useRoleplayStore, type FireScenario, type RoleplayScenario } from "./roleplayStore";
import type { SpawnChoice } from "./spawn";

const NPC_PRESETS = [20, 300, 1000, 3000];
const FIRE_LABEL: Record<FireScenario, string> = {
  none: "ไม่มีไฟ (ฝึกเส้นทาง)",
  left: "ไฟ อาคาร 1 ปีกซ้าย ชั้น 5",
  center: "ไฟ อาคาร 1 บันไดกลาง ชั้น 4",
  right: "ไฟ อาคาร 1 ปีกขวา ชั้น 6",
  "on-route": "ไฟบนเส้นทางแรกของคุณ (ห่างประมาณ 25 ม.)",
};
const BEHAVIOR_LABEL = { surge: "กรูกันไปทางออก (สมจริงเมื่อตื่นตระหนก)", grouped: "เดินเป็นกลุ่มเพื่อน", orderly: "เข้าแถวตามแบบฝึกซ้อม" } as const;

/** A point about `metres` ahead along the first route from the spawn (for the "fire on route" scenario). */
export function pointAlongFirstRoute(spawn: Vec3, metres: number): Vec3 | null {
  const world = walkWorld();
  const navigator = PlayerNavigator.at(world, spawn);
  if (!navigator) return null;
  const registry = getMapRegistry();
  const field = computeRouteField(registry, "standard", { closedEdges: new Set(), hazardBlockedEdges: new Set(), hazardMarginEdges: new Map(), edgeLoad: new Map(), assemblyLoad: new Map() });
  const path = pathFromField(field, navigator.nearestNode(), registry);
  if (!path) return null;
  let travelled = 0;
  let previous = spawn;
  for (const nodeId of path.nodeIds) {
    const node = registry.nodeMap.get(nodeId);
    if (!node) continue;
    travelled += Math.hypot(node.position[0] - previous[0], node.position[1] - previous[1], node.position[2] - previous[2]);
    previous = node.position;
    if (travelled >= metres && node.type !== "assembly" && node.type !== "room") return [...node.position] as Vec3;
  }
  return null;
}

/**
 * Builds the shared world for the run: resets the simulation, applies closures and fire, places
 * the NPCs (start + pause), so the spawn check sees the same fire and the same people the run will.
 */
export function prepareScene(scenario: RoleplayScenario, spawnPoint: Vec3 | null) {
  const sim = useEvacuationStore.getState();
  sim.reset();
  evacuationRuntime.clearFires();
  for (const group of evacuationRuntime.passageGroups()) {
    const closed = scenario.closures.includes(group.id);
    if (group.closed !== closed) evacuationRuntime.setPassageGroupClosed(group.id, closed);
  }
  if (scenario.fire === "left" || scenario.fire === "center" || scenario.fire === "right") evacuationRuntime.addPresetFire(scenario.fire);
  if (scenario.fire === "on-route" && spawnPoint) {
    const point = pointAlongFirstRoute(spawnPoint, 25);
    if (point) evacuationRuntime.addFire(point);
  }
  useEvacuationStore.setState({ populationTarget: scenario.npcCount, crowdBehavior: scenario.crowdBehavior, speedFactor: 1, fireSpreadEnabled: true, placeFireMode: false,
    closedPassages: evacuationRuntime.passageGroups().filter((group) => group.closed).map((group) => group.id) });
  useEvacuationStore.getState().start();
  useEvacuationStore.getState().pause();
}

function npcPositions(): Vec3[] {
  return evacuationRuntime.agents.filter((agent) => agent.status !== "arrived").map((agent) => agent.position);
}

export function RoleplaySetup({ onStart, onCancel, backendNote }: { onStart: () => void; onCancel: () => void; backendNote: string }) {
  const choice = useRoleplayStore((state) => state.choice);
  const scenario = useRoleplayStore((state) => state.scenario);
  const plan = useRoleplayStore((state) => state.plan);
  const prepared = useRoleplayStore((state) => state.prepared);
  const preparing = useRoleplayStore((state) => state.preparing);
  const acceptSuggestion = useRoleplayStore((state) => state.acceptSuggestion);
  const setChoice = useRoleplayStore((state) => state.setChoice);
  const setScenario = useRoleplayStore((state) => state.setScenario);
  const set = useRoleplayStore((state) => state.set);
  const groups = useMemo(() => evacuationRuntime.passageGroups().map(({ id, label }) => ({ id, label })), []);
  const floors = useMemo(() => spawnFloors(choice.buildingId), [choice.buildingId]);
  const options = useMemo(() => spawnOptions(choice.buildingId, choice.floor), [choice.buildingId, choice.floor]);
  const firstHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { firstHeading.current?.focus(); }, []);
  // Keep building → floor → point consistent.
  useEffect(() => { if (floors.length && !floors.includes(choice.floor)) setChoice({ floor: floors.includes(5) ? 5 : floors[floors.length - 1] }); }, [floors, choice.floor, setChoice]);
  useEffect(() => {
    if (!options.length) return;
    if (!options.some((option) => option.id === choice.id && option.kind === choice.kind)) setChoice({ id: options[0].id, kind: options[0].kind });
  }, [options, choice.id, choice.kind, setChoice]);

  // Prepare the shared world (debounced) whenever the scenario changes.
  const scenarioKey = JSON.stringify(scenario);
  const choiceKey = `${choice.buildingId}|${choice.floor}|${choice.kind}|${choice.id}`;
  useEffect(() => {
    if (!choice.id) return undefined;
    let cancelled = false;
    set({ preparing: true, prepared: false });
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      // A "fire on route" needs the spawn first: plan without NPCs/fire, then place the fire, then re-plan.
      const draft = planSpawn(choice, [], []);
      prepareScene(scenario, draft.requested.point ?? draft.suggestion?.point ?? null);
      if (cancelled) return;
      const next = planSpawn(choice, evacuationRuntime.fires, npcPositions());
      set({ plan: next, prepared: true, preparing: false });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [scenarioKey, choiceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the chosen floor and point.
  useEffect(() => {
    const point = plan?.requested.point ?? plan?.suggestion?.point;
    if (!point) return;
    const building = useBuilding1Store.getState();
    if (choice.buildingId === "building-1") { building.setSelectedFloor(choice.floor); building.setViewMode(choice.floor === 1 ? "exterior" : "single-floor"); }
    else building.setViewMode("exterior");
    useMapperStore.getState().setCameraMode("isometric");
    useMapperStore.getState().requestCameraFocus([point[0], point[1] + 1, point[2]]);
  }, [plan, choice.buildingId, choice.floor]);

  const requested = plan?.requested ?? null;
  const usable = Boolean(prepared && !preparing && requested && (requested.ok || (acceptSuggestion && plan?.suggestion)));
  const touchOnly = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches;

  return (
    <section className="rp-setup" role="dialog" aria-modal="false" aria-labelledby="rp-setup-title">
      <header className="rp-setup-head">
        <span className="rp-tag">SIMULATOR · ข้อมูลจำลอง</span>
        <h2 id="rp-setup-title" ref={firstHeading} tabIndex={-1}>สวมบทอพยพ — เลือกจุดเกิด</h2>
        <p>คุณจะควบคุมนักเรียน 1 คนในมุมมองบุคคลที่หนึ่ง เดินอพยพไปพร้อม NPC และดูมือถือที่แนะนำทางตามตำแหน่งของคุณเอง</p>
      </header>
      {touchOnly && <p className="rp-alert is-warn" role="alert">โหมดนี้ต้องใช้คีย์บอร์ดและเมาส์ (W/A/S/D + เมาส์) — อุปกรณ์สัมผัสอย่างเดียวยังไม่รองรับ</p>}
      <div className="rp-grid">
        <label className="rp-field"><span>อาคาร</span>
          <select value={choice.buildingId} onChange={(event) => setChoice({ buildingId: event.target.value, id: "" })}>
            {Object.entries(BUILDING_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="rp-field"><span>ชั้น</span>
          <select value={choice.floor} onChange={(event) => setChoice({ floor: Number(event.target.value), id: "" })}>
            {floors.map((floor) => <option key={floor} value={floor}>ชั้น {floor}</option>)}
          </select>
        </label>
        <label className="rp-field is-wide"><span>ห้อง / จุดตรวจ</span>
          <select value={`${choice.kind}:${choice.id}`} onChange={(event) => { const [kind, ...rest] = event.target.value.split(":"); setChoice({ kind: kind as SpawnChoice["kind"], id: rest.join(":") }); }}>
            {options.map((option) => <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>{option.kind === "room" ? "ห้อง" : "จุด"} · {option.label}</option>)}
          </select>
        </label>
        <label className="rp-field"><span>จำนวน NPC</span>
          <select value={scenario.npcCount} onChange={(event) => setScenario({ npcCount: Number(event.target.value) })}>
            {NPC_PRESETS.map((count) => <option key={count} value={count}>{count.toLocaleString("th-TH")} คน</option>)}
          </select>
        </label>
        <label className="rp-field"><span>พฤติกรรมฝูงชน</span>
          <select value={scenario.crowdBehavior} onChange={(event) => setScenario({ crowdBehavior: event.target.value as RoleplayScenario["crowdBehavior"] })}>
            {(Object.keys(BEHAVIOR_LABEL) as Array<keyof typeof BEHAVIOR_LABEL>).map((key) => <option key={key} value={key}>{BEHAVIOR_LABEL[key]}</option>)}
          </select>
        </label>
        <label className="rp-field is-wide"><span>สถานการณ์ไฟ</span>
          <select value={scenario.fire} onChange={(event) => setScenario({ fire: event.target.value as FireScenario })}>
            {(Object.keys(FIRE_LABEL) as Array<keyof typeof FIRE_LABEL>).map((key) => <option key={key} value={key}>{FIRE_LABEL[key]}</option>)}
          </select>
        </label>
        <fieldset className="rp-field is-wide rp-closures">
          <legend>ปิดทางตั้งแต่เริ่ม</legend>
          <div>
            {groups.map((group) => (
              <label key={group.id} className="rp-check">
                <input type="checkbox" checked={scenario.closures.includes(group.id)} onChange={(event) => setScenario({ closures: event.target.checked ? [...scenario.closures, group.id] : scenario.closures.filter((id) => id !== group.id) })} />
                <span>{group.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="rp-check-result" aria-live="polite">
        {preparing || !prepared ? <p className="rp-muted">กำลังเตรียมฉาก วาง NPC และตรวจจุดเกิด…</p> : requested && (
          requested.ok ? (
            <p className="rp-ok"><b>จุดเกิดใช้ได้</b> — {BUILDING_LABEL[choice.buildingId]} ชั้น {choice.floor} · {spawnLabel(choice)} (เครื่องหมายสีเขียวในฉาก)</p>
          ) : (
            <div className="rp-bad">
              <p><b>จุดนี้ใช้เป็นจุดเกิดไม่ได้</b> (เครื่องหมายสีส้ม)</p>
              <ul>{requested.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              {plan?.suggestion ? (
                <label className="rp-check">
                  <input type="checkbox" checked={acceptSuggestion} onChange={(event) => set({ acceptSuggestion: event.target.checked })} />
                  <span>ใช้จุดที่แนะนำแทน: {spawnLabel(plan.suggestion.choice)} (ชั้นเดิม เครื่องหมายสีน้ำเงิน)</span>
                </label>
              ) : <p>ไม่มีจุดที่ใช้ได้ในชั้นนี้ — เลือกชั้นหรือสถานการณ์อื่น</p>}
            </div>
          )
        )}
      </div>
      <ul className="rp-keys" aria-label="วิธีควบคุม">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> เดิน</li>
        <li><kbd>เมาส์</kbd> หันมอง (คลิกฉากเพื่อล็อกเมาส์)</li>
        <li><kbd>Shift</kbd> ค้างไว้เพื่อเร่ง</li>
        <li><kbd>Esc</kbd> ปลดเมาส์ / เปิดเมนู</li>
      </ul>
      {backendNote && <p className="rp-muted">{backendNote}</p>}
      <div className="rp-actions">
        <button type="button" className="rp-btn" onClick={onCancel}>ยกเลิก</button>
        <button type="button" className="rp-btn is-primary" disabled={!usable} onClick={onStart}>เริ่มอพยพ (ความเร็ว 1×)</button>
      </div>
    </section>
  );
}
