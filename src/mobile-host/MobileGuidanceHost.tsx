import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import type { MapPackage, ParticipantRow, ParticipantView, SensorState, StaffSnapshot } from "../evac/protocol";
import { MobileApp } from "../mobile/MobileApp";
import { createReadonlySource, type HostMessage, type PreviewMessage } from "../mobile/client";
import { PhoneFrame, PHONE_SIZES, type PhoneSize } from "./PhoneFrame";
import { encodeQr, qrSvgPath } from "./qr";
import { useStaffConnection } from "./staffClient";
import { useBotPhoneBridge } from "./simBridge";
import { useBackendMode } from "../evac-local/useBackendMode";
import { useEvacuationStore } from "../simulation/simulationStore";
import { evacuationRuntime } from "../simulation/runtime";
import "../mobile/mobile.css";
import "./host.css";

export type HostMode = "docked" | "minimized" | "presentation";

interface HostProps {
  mode: HostMode;
  /** Closed panels stay mounted (hidden) so reopening keeps the same preview session and form state. */
  open: boolean;
  compact: boolean;
  onMode: (mode: HostMode) => void;
  onClose: () => void;
  panelRef?: React.Ref<HTMLElement>;
  onWidth?: (width: number) => void;
}

const WIDTH_KEY = "skr-evac-host-width";
const MIN_W = 560;
function maxWidth() { return Math.max(MIN_W, Math.round(window.innerWidth * 0.72)); }

const PREVIEW_KEY = "skr-evac-preview-ticket";
const MODE_TH = { simulation: "สถานการณ์จำลอง", drill: "ฝึกซ้อม", live: "เหตุจริง" } as const;
const PHASE_TH = { standby: "เตรียมพร้อม", evacuate: "กำลังอพยพ", ended: "ยุติแล้ว" } as const;
const STATE_TH = { confirmed: "ยืนยันแล้ว", stale: "เก่า", uncertain: "ไม่แน่นอน", unknown: "ไม่ทราบ" } as const;
const SENSOR_STATUS_TH = { normal: "ปกติ", alarm: "ตรวจพบเหตุ", fault: "ขัดข้อง", offline: "ออฟไลน์", unknown: "ไม่ทราบ", test: "ทดสอบ" } as const;

function clock(at: number | null | undefined) {
  return at ? new Date(at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

function QrImage({ text, label }: { text: string; label: string }) {
  const { path, size } = useMemo(() => qrSvgPath(encodeQr(text)), [text]);
  return (
    <svg className="mh-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#0f1f36" />
    </svg>
  );
}

function useMapPackage(enabled: boolean) {
  const [map, setMap] = useState<MapPackage | null>(null);
  useEffect(() => {
    if (!enabled || map) return;
    let cancelled = false;
    const load = () => fetch("/api/map").then((response) => (response.ok ? response.json() : Promise.reject(new Error("map")))).then((data: MapPackage) => { if (!cancelled) setMap(data); })
      .catch(() => { if (!cancelled) window.setTimeout(load, 4000); });
    load();
    return () => { cancelled = true; };
  }, [enabled, map]);
  return map;
}

// ------------------------------------------------------------------ demo controls

interface DemoProps {
  snapshot: StaffSnapshot | null;
  map: MapPackage | null;
  call: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  previewParticipantId: string | null;
  networkOnline: boolean;
  setNetwork: (online: boolean) => void;
  run: (label: string, task: () => Promise<unknown>) => Promise<void>;
  autoWalk: ReturnType<typeof useAutoWalk>;
}

function SessionControls({ snapshot, call, run }: Pick<DemoProps, "snapshot" | "call" | "run">) {
  const incident = snapshot?.incidents.find((candidate) => candidate.id === snapshot.activeIncidentId) ?? null;
  return (
    <section className="mh-group" aria-labelledby="mh-g-session">
      <h3 id="mh-g-session">1 · รอบฝึกซ้อม</h3>
      {incident ? (
        <div className="mh-incident">
          <div><b>{incident.title}</b><span className={`mh-chip is-${incident.mode}`}>{MODE_TH[incident.mode]}</span><span className={`mh-chip is-phase-${incident.phase}`}>{PHASE_TH[incident.phase]}</span></div>
          <small>รหัสเข้าร่วม <code>{incident.joinCode}</code> · สร้างเมื่อ {clock(incident.createdAt)}</small>
        </div>
      ) : <p className="mh-muted">ยังไม่มีรอบ — สร้างรอบก่อน แล้วกรอบมือถือจะเข้าร่วมเป็น “ผู้ทดสอบ” ให้อัตโนมัติ</p>}
      <div className="mh-buttons">
        <button type="button" className="mh-btn" onClick={() => void run("สร้างรอบฝึกซ้อม", () => call("/api/admin/incidents", { mode: "drill", title: "รอบฝึกซ้อมอพยพ" }))}>สร้างรอบฝึกซ้อม</button>
        <button type="button" className="mh-btn" onClick={() => void run("สร้างสถานการณ์จำลอง", () => call("/api/admin/incidents", { mode: "simulation", title: "สถานการณ์จำลอง (ไม่มีผู้ใช้จริง)" }))}>สร้างสถานการณ์จำลอง</button>
        {incident && incident.phase === "standby" && <button type="button" className="mh-btn is-primary" onClick={() => void run("เริ่มอพยพ", () => call(`/api/admin/incidents/${incident.id}/evacuate`, {}))}>เริ่มอพยพในรอบนี้</button>}
        {incident && incident.phase !== "ended" && <button type="button" className="mh-btn" onClick={() => void run("ยุติรอบ", () => call(`/api/admin/incidents/${incident.id}/end`, {}))}>ยุติรอบ</button>}
        {incident && <button type="button" className="mh-btn is-quiet" onClick={() => void run("ล้างสถานการณ์ทดสอบ", () => call(`/api/admin/incidents/${incident.id}/reset-test`, {}))}>รีเซ็ตเฉพาะสถานการณ์ทดสอบ</button>}
      </div>
      {snapshot && snapshot.incidents.length > 1 && (
        <label className="mh-field"><span>รอบที่กำลังดู</span>
          <select value={snapshot.activeIncidentId ?? ""} onChange={(event) => void run("เปลี่ยนรอบ", () => call(`/api/admin/incidents/${event.target.value}/active`, {}))}>
            {snapshot.incidents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {MODE_TH[candidate.mode]} · {PHASE_TH[candidate.phase]} · {clock(candidate.createdAt)}</option>)}
          </select>
        </label>
      )}
    </section>
  );
}

function TesterControls({ snapshot, map, call, previewParticipantId, networkOnline, setNetwork, run, autoWalk }: DemoProps) {
  const row = snapshot?.participants.find((participant) => participant.participantId === previewParticipantId) ?? null;
  const [buildingId, setBuildingId] = useState("building-1");
  const floors = map?.buildings.find((building) => building.id === buildingId)?.floors ?? [];
  const [floor, setFloor] = useState(9);
  const [checkpointId, setCheckpointId] = useState("");
  useEffect(() => { if (floors.length && !floors.includes(floor)) setFloor(floors[floors.length - 1]); }, [buildingId, floors, floor]);
  const options = useMemo(() => (map?.checkpoints ?? []).filter((checkpoint) => checkpoint.buildingId === buildingId && checkpoint.floor === floor)
    .sort((a, b) => (a.kind === "room" ? 0 : 1) - (b.kind === "room" ? 0 : 1) || a.name.localeCompare(b.name, "th")), [map, buildingId, floor]);
  useEffect(() => { if (options.length && !options.some((option) => option.id === checkpointId)) setCheckpointId(options[0].id); }, [options, checkpointId]);
  const demo = (body: unknown, label: string) => run(label, () => call(`/api/admin/participants/${previewParticipantId}/demo`, body));
  return (
    <section className="mh-group" aria-labelledby="mh-g-tester">
      <h3 id="mh-g-tester">2 · ผู้ทดสอบในกรอบมือถือ <span className="mh-tag">ข้อมูลจำลอง</span></h3>
      {!previewParticipantId ? <p className="mh-muted">กรอบมือถือยังไม่ได้เข้าร่วมรอบ</p> : (
        <>
          <p className="mh-muted">{row ? `ตำแหน่ง: ${row.location ? `${map?.nodes.find((node) => node.id === row.location?.nodeId)?.name ?? row.location.nodeId} (${STATE_TH[row.locationState]})` : "ยังไม่ทราบ"} · เส้นทางฉบับ ${row.routeRevision}` : "กำลังโหลด…"}</p>
          <div className="mh-row3">
            <label className="mh-field"><span>อาคาร</span>
              <select value={buildingId} onChange={(event) => setBuildingId(event.target.value)}>{map?.buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select>
            </label>
            <label className="mh-field"><span>ชั้น</span>
              <select value={floor} onChange={(event) => setFloor(Number(event.target.value))}>{floors.map((value) => <option key={value} value={value}>{value === 0 ? "ภายนอก" : `ชั้น ${value}`}</option>)}</select>
            </label>
            <label className="mh-field"><span>จุด (checkpoint)</span>
              <select value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)}>{options.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.id}</option>)}</select>
            </label>
          </div>
          <div className="mh-buttons">
            <button type="button" className="mh-btn is-primary" disabled={!checkpointId} onClick={() => void demo({ action: "place", checkpointId }, "วางผู้ทดสอบ")}>วางผู้ทดสอบที่จุดนี้</button>
            <button type="button" className="mh-btn" onClick={() => void demo({ action: "advance" }, "เดินไปจุดถัดไป")}>เดินไปจุดสังเกตถัดไปตามเส้นทาง</button>
            <button type="button" className="mh-btn" onClick={() => void demo({ action: "uncertain" }, "ตำแหน่งไม่แน่นอน")}>จำลองตำแหน่งไม่แน่นอน</button>
            <button type="button" className={`mh-btn${networkOnline ? "" : " is-warn"}`} aria-pressed={!networkOnline} onClick={() => setNetwork(!networkOnline)}>{networkOnline ? "จำลองขาดการเชื่อมต่อ" : "เชื่อมต่อกลับ"}</button>
          </div>
          <div className="mh-autowalk">
            <button type="button" className={`mh-btn${autoWalk.on ? " is-warn" : " is-primary"}`} aria-pressed={autoWalk.on} onClick={() => autoWalk.setOn(!autoWalk.on)}>
              {autoWalk.on ? "หยุดเดินอัตโนมัติ" : "เดินอัตโนมัติตามเส้นทาง"}
            </button>
            <label className="mh-field mh-inline"><span>ความเร็วจำลอง</span>
              <select value={autoWalk.pace} onChange={(event) => autoWalk.setPace(Number(event.target.value))}>
                {[1, 3, 5, 10].map((value) => <option key={value} value={value}>{value === 1 ? "เวลาจริง" : `เร็วขึ้น ${value}×`}</option>)}
              </select>
            </label>
            <p className="mh-muted" role="status">{autoWalk.status}</p>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Simulator B: the framed test participant walks its own route. Each step waits the time a person
 * would take to walk it (step length ÷ 1.25 m/s, divided by the chosen speed-up) and then reports
 * the next landmark through the same staff demo endpoint — so a closure or a new hazard mid-walk
 * changes the route exactly as for a real phone. Clearly a simulation: real phones only advance
 * on a scan, a pick or the person's own confirmation.
 */
function useAutoWalk(participantId: string | null, call: DemoProps["call"], networkOnline: boolean) {
  const [on, setOn] = useState(false);
  const [pace, setPace] = useState(5);
  const [status, setStatus] = useState("");
  const paceRef = useRef(pace);
  paceRef.current = pace;
  useEffect(() => {
    if (!on || !participantId) return undefined;
    if (!networkOnline) { setStatus("หยุดรอ: มือถือขาดการเชื่อมต่อ"); return undefined; }
    let cancelled = false;
    let timer = 0;
    let progress: { key: string; distance: number; at: number } | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        const view = await call<ParticipantView>(`/api/admin/participants/${participantId}/view`);
        if(cancelled)return;
        const advice = view.advice;
        const here = view.me.location?.nodeId ?? null;
        if (view.me.arrival.selfReportedAt || (advice?.destination && here === advice.destination.nodeId)) { setStatus("ถึงจุดรวมพลแล้ว — หยุดเดินอัตโนมัติ"); setOn(false); return; }
        if (!advice || advice.status !== "ok") {
          progress=null;
          setStatus(advice?.status === "not-evacuating" || !advice ? "ยังไม่มีคำสั่งอพยพ — รอเริ่มอพยพ" : `หยุดรอ: ${advice.message}`);
          timer = window.setTimeout(tick, 1500);
          return;
        }
        const step = advice.maneuvers.find((maneuver) => here !== null && maneuver.nodeIds.includes(here) && maneuver.nodeIds[maneuver.nodeIds.length - 1] !== here) ?? advice.maneuvers[0];
        if(!step){setStatus("ยังไม่มีขั้นตอนให้เดินต่อ");timer=window.setTimeout(tick,1000);return;}
        const now=performance.now(),key=JSON.stringify([here,step.nodeIds]);
        if(!progress||progress.key!==key)progress={key,distance:0,at:now};
        const elapsed=Math.min(1,Math.max(0,(now-progress.at)/1000));progress.at=now;
        progress.distance+=elapsed*1.25*paceRef.current;
        const remaining=Math.max(0,step.distanceM-progress.distance);
        setStatus(`กำลังเดิน: ${step.text} (เหลือ ~${Math.round(remaining)} ม. · ${paceRef.current}× · ข้อมูลจำลอง)`);
        if(remaining<=0){
          // The server checks this revision atomically before moving the demo checkpoint.
          // A mid-walk closure cannot advance an old instruction into a changed route.
          await call(`/api/admin/participants/${participantId}/demo`, {action:"advance",expectedRouteRevision:advice.routeRevision});
          progress=null;
        }
        if(!cancelled)timer=window.setTimeout(tick,500);
      } catch (error) {
        if(cancelled)return;
        progress=null;
        setStatus(`อ่านสถานะไม่สำเร็จ: ${(error as Error).message}`);
        timer = window.setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [on, participantId, call, networkOnline]);
  useEffect(() => { if (!on) setStatus((current) => (current.startsWith("ถึง") ? current : "")); }, [on]);
  return { on, setOn, pace, setPace, status };
}

function SensorControls({ snapshot, call, run }: Pick<DemoProps, "snapshot" | "call" | "run">) {
  const incident = snapshot?.incidents.find((candidate) => candidate.id === snapshot.activeIncidentId) ?? null;
  const sensors = snapshot?.sensors ?? [];
  const [sensorId, setSensorId] = useState("SIM-B1-F5-CORE-SMK");
  const sensor = sensors.find((candidate) => candidate.sensorId === sensorId) ?? sensors[0];
  const send = (status: SensorState["status"]) => {
    if (!incident || !sensor) return;
    const value = sensor.type === "heat" ? (status === "alarm" ? 78 : 31) : sensor.type === "smoke" ? (status === "alarm" ? 12 : 0.2) : null;
    const unit = sensor.type === "heat" ? "°C" : sensor.type === "smoke" ? "%/m" : null;
    void run(`เซนเซอร์ ${SENSOR_STATUS_TH[status]}`, () => call("/api/sensors/events", {
      incidentId: incident.id,
      readings: [{
        sensorId: sensor.sensorId, type: sensor.type, value, unit, status, eventId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sequence: sensor.lastSequence + 1, observedAt: Date.now(), quality: "good", mode: incident.mode === "drill" ? "drill" : "simulated",
      }],
    }));
  };
  return (
    <section className="mh-group" aria-labelledby="mh-g-sensor">
      <h3 id="mh-g-sensor">3 · จำลองเหตุจากเซนเซอร์ <span className="mh-tag">ข้อมูลจำลอง</span></h3>
      <p className="mh-muted">ส่งผ่าน Sensor Gateway (สัญญาเดียวกับอุปกรณ์จริง) ไม่เกี่ยวกับตู้แจ้งเหตุเพลิงไหม้ของอาคาร</p>
      <label className="mh-field"><span>เซนเซอร์</span>
        <select value={sensor?.sensorId ?? ""} onChange={(event) => setSensorId(event.target.value)} disabled={!incident}>
          {sensors.map((candidate) => <option key={candidate.sensorId} value={candidate.sensorId}>{candidate.label} · {SENSOR_STATUS_TH[candidate.status]}</option>)}
        </select>
      </label>
      <div className="mh-buttons">
        <button type="button" className="mh-btn is-danger" disabled={!incident} onClick={() => send("alarm")}>ตรวจพบเหตุ</button>
        <button type="button" className="mh-btn" disabled={!incident} onClick={() => send("normal")}>ปกติ</button>
        <button type="button" className="mh-btn" disabled={!incident} onClick={() => send("fault")}>ขัดข้อง</button>
        <button type="button" className="mh-btn" disabled={!incident} onClick={() => send("offline")}>ออฟไลน์</button>
      </div>
    </section>
  );
}

function ClosureControls({ snapshot, call, run }: Pick<DemoProps, "snapshot" | "call" | "run">) {
  const incident = snapshot?.incidents.find((candidate) => candidate.id === snapshot.activeIncidentId) ?? null;
  const [groups, setGroups] = useState<Array<{ id: string; label: string; edgeIds: string[] }>>([]);
  const [templates, setTemplates] = useState<string[]>([]);
  useEffect(() => { void fetch("/api/passages").then((response) => response.json()).then((data: { groups: typeof groups; templates: string[] }) => { setGroups(data.groups); setTemplates(data.templates); }).catch(() => undefined); }, []);
  const closed = new Set(incident?.closedEdgeIds ?? []);
  const TEMPLATE_TH: Record<string, string> = { "evacuate-now": "เริ่มอพยพ", "avoid-passage": "ห้ามใช้ทางที่ปิด", "await-teacher": "รอครูที่จุดรวมพล", "help-coming": "เจ้าหน้าที่กำลังไปช่วย", "drill-ended": "จบการฝึก" };
  const firstClosed = groups.find((group) => group.edgeIds.every((edgeId) => closed.has(edgeId)));
  return (
    <>
      <section className="mh-group" aria-labelledby="mh-g-closure">
        <h3 id="mh-g-closure">4 · ปิด/เปิดทางในรอบนี้</h3>
        <div className="mh-checks">
          {groups.map((group) => {
            const isClosed = group.edgeIds.every((edgeId) => closed.has(edgeId));
            return (
              <label key={group.id} className={`mh-check${isClosed ? " is-on" : ""}`}>
                <input type="checkbox" checked={isClosed} disabled={!incident} onChange={(event) => void run(event.target.checked ? `ปิด${group.label}` : `เปิด${group.label}`, () => call(`/api/admin/incidents/${incident!.id}/closures`, { groupId: group.id, closed: event.target.checked, reason: "กำหนดในรอบฝึกซ้อม" }))} />
                <span>{group.label}</span>
              </label>
            );
          })}
        </div>
      </section>
      <section className="mh-group" aria-labelledby="mh-g-announce">
        <h3 id="mh-g-announce">5 · ประกาศตามแบบ</h3>
        <div className="mh-buttons">
          {templates.map((templateId) => (
            <button key={templateId} type="button" className="mh-btn is-quiet" disabled={!incident || (templateId === "avoid-passage" && !firstClosed)}
              onClick={() => void run("ส่งประกาศ", () => call(`/api/admin/incidents/${incident!.id}/announce`, { templateId, params: firstClosed ? { groupId: firstClosed.id } : {} }))}>
              {TEMPLATE_TH[templateId] ?? templateId}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ simulator A: bots carrying phones

interface ComparisonRow { id: string; label: string; seed: number; scenario: string; behavior: string; phones: number; compliance: number; agents: number; arrived: number; delivered: number; p50: number | null; p95: number | null; final: number | null; dangerSeconds: number; clogs: number; followed: number; incapacitated: number }
const COMPARISON_KEY = "skr-evac-bot-comparison-v2";
const BEHAVIOR_TH: Record<string, string> = { orderly: "ซ้อมเป็นระเบียบ", grouped: "แข่งขัน", surge: "แข่งขันสูง" };

/** State of simulator A, owned by the panel so it keeps running whichever tab is open. */
function useBotSimulator(snapshot: StaffSnapshot | null, map: MapPackage | null, call: DemoProps["call"]) {
  const incident = snapshot?.incidents.find((candidate) => candidate.id === snapshot.activeIncidentId) ?? null;
  const [enabled, setEnabled] = useState(false);
  const [adoption, setAdoption] = useState(60);
  const [compliance, setCompliance] = useState(75);
  const status = useBotPhoneBridge({ enabled, adoption, compliance, incident, map, sensors: snapshot?.sensors ?? [], call });
  const simStatus = useEvacuationStore((state) => state.status);
  const locked = simStatus === "running" || simStatus === "paused";
  const [rows, setRows] = useState<ComparisonRow[]>(() => { try { return JSON.parse(window.sessionStorage.getItem(COMPARISON_KEY) ?? "[]") as ComparisonRow[]; } catch { return []; } });
  const recorded = useRef<string | null>(null);
  const run = useRef<{ first: object; id: string; enabled: boolean; adoption: number; compliance: number; scenario: string; delivered: number } | null>(null);
  useEffect(() => {
    const runtime = evacuationRuntime;
    if (simStatus === "running" && runtime.agents[0] && run.current?.first !== runtime.agents[0]) {
      run.current = { first: runtime.agents[0], id: crypto.randomUUID(), enabled, adoption, compliance,
        scenario: JSON.stringify([runtime.config, runtime.fires, [...runtime.closedEdges].sort(), map?.mapVersion]), delivered: 0 };
    }
    if (run.current && run.current.first === runtime.agents[0]) run.current.delivered = Math.max(run.current.delivered, status.routesDelivered);
  }, [simStatus, enabled, adoption, compliance, status.routesDelivered, map?.mapVersion]);
  // Every finished 3D run is recorded with its phone setting, so runs with and without phones can be compared.
  useEffect(() => {
    if (simStatus !== "completed") { if (simStatus === "running") recorded.current = null; return; }
    const state = useEvacuationStore.getState();
    const m = state.metrics;
    const setting = run.current;
    if (!setting || setting.first !== evacuationRuntime.agents[0]) return;
    const key = setting.id;
    if (recorded.current === key) return;
    recorded.current = key;
    const row: ComparisonRow = {
      id: key, label: setting.enabled ? `มือถือ ${setting.adoption}% · ทำตาม ${setting.compliance}%${setting.delivered ? "" : " · ยังไม่ได้รับเส้นทาง"}` : "ไม่มีมือถือ",
      seed: m.seed, scenario: setting.scenario, behavior: state.crowdBehavior, phones: setting.enabled ? setting.adoption : 0, compliance: setting.enabled ? setting.compliance : 0, agents: m.total, arrived: m.arrived, delivered: setting.delivered,
      p50: m.arrived >= Math.ceil(m.total * .5) ? m.p50Arrival : null, p95: m.arrived >= Math.ceil(m.total * .95) ? m.p95Arrival : null,
      final: m.arrived === m.total ? m.finalArrival : null, dangerSeconds: Math.round(m.dangerousCrowdSeconds), clogs: m.clogEvents, followed: m.phoneFollowed, incapacitated: m.incapacitated,
    };
    setRows((current) => {
      const next = [row, ...current].slice(0, 8);
      try { window.sessionStorage.setItem(COMPARISON_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [simStatus, enabled, adoption, compliance, status.state]);
  const clearRows = () => { setRows([]); try { window.sessionStorage.removeItem(COMPARISON_KEY); } catch { /* ignore */ } };
  return { incident, enabled, setEnabled, adoption, setAdoption, compliance, setCompliance, status, rows, clearRows, locked };
}

function BotPhoneControls({ bots, call, onViewParticipant }: { bots: ReturnType<typeof useBotSimulator>; call: DemoProps["call"]; onViewParticipant: (id: string | null) => void }) {
  const { incident, enabled, setEnabled, adoption, setAdoption, compliance, setCompliance, status, rows, clearRows, locked } = bots;
  const [note, setNote] = useState("");
  const viewSelected = async () => {
    const id = useEvacuationStore.getState().inspectedAgentId;
    if (id == null) { setNote("เลือกคนในโมเดล 3 มิติก่อน (คลิกที่ตัวคน หรือใช้ปุ่มค้นหาในแผงเหตุการณ์)"); return; }
    if (!incident) return;
    try {
      const result = await call<{ participantId: string | null }>(`/api/admin/incidents/${incident.id}/sim-bots/${id}`);
      if (!result.participantId) { setNote(`คนที่ #${id} ไม่ได้ถือมือถือในรอบนี้`); return; }
      setNote(`เปิดหน้าจอมือถือของบอท #${id} แบบอ่านอย่างเดียวแล้ว`);
      onViewParticipant(result.participantId);
    } catch (error) { setNote((error as Error).message); }
  };

  const fmt = (value: number | null) => (value == null ? "—" : `${Math.round(value)} วิ`);
  return (
    <section className="mh-group" aria-labelledby="mh-g-bots">
      <h3 id="mh-g-bots">6 · บอทถือมือถือ <span className="mh-tag">ข้อมูลจำลอง</span></h3>
      <p className="mh-muted">คนในโมเดล 3 มิติบางส่วนถือมือถือ ได้เส้นทางจากเซิร์ฟเวอร์จริงตัวเดียวกับมือถือจริง และทำตามบ้าง/ไม่ทำตามบ้าง ระบบรู้ไฟจากเซนเซอร์จำลองเท่านั้น ใช้ได้กับรอบ “สถานการณ์จำลอง” เท่านั้น</p>
      <div className="mh-row3">
        <label className="mh-field"><span>คนที่ถือมือถือ {adoption}%</span>
          <input type="range" min={0} max={100} step={5} disabled={locked} value={adoption} onChange={(event) => setAdoption(Number(event.target.value))} />
        </label>
        <label className="mh-field"><span>ทำตามคำแนะนำ {compliance}%</span>
          <input type="range" min={0} max={100} step={5} disabled={locked} value={compliance} onChange={(event) => setCompliance(Number(event.target.value))} />
        </label>
      </div>
      <div className="mh-buttons">
        <button type="button" className={`mh-btn${enabled ? " is-warn" : " is-primary"}`} aria-pressed={enabled} disabled={locked || !incident || incident.mode !== "simulation"} onClick={() => setEnabled(!enabled)}>
          {enabled ? "หยุดเชื่อมบอท" : "เชื่อมบอทกับระบบมือถือ"}
        </button>
        <button type="button" className="mh-btn" disabled={!enabled} onClick={() => void viewSelected()}>ดูมือถือของคนที่เลือกในโมเดล</button>
      </div>
      {locked && <p className="mh-muted">ตั้งค่ามือถือก่อนเริ่มรอบใหม่ — รีเซ็ตการจำลองเพื่อเปลี่ยนค่า แล้วใช้ seed และสถานการณ์เดิมสำหรับการเปรียบเทียบ</p>}
      {(!incident || incident.mode !== "simulation") && <p className="mh-warn">สร้าง “สถานการณ์จำลอง” ในข้อ 1 ก่อน</p>}
      {status.text && <p className={status.state === "error" ? "mh-warn" : "mh-muted"} role="status">{status.text}</p>}
      {note && <p className="mh-muted">{note}</p>}
      {rows.length > 0 && (
        <div className="mh-table-wrap">
          <table className="mh-table">
            <caption className="mh-sr">ผลการจำลองแต่ละรอบ เทียบกรณีมีและไม่มีมือถือ</caption>
            <thead><tr><th>รอบ</th><th>ถึง / ทั้งหมด</th><th>P50 ผู้ที่ถึง</th><th>P95 ผู้ที่ถึง</th><th>ครบทุกคน</th><th>อัดแน่นอันตราย</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}<br /><small>seed {row.seed} · {BEHAVIOR_TH[row.behavior] ?? row.behavior}{row.followed ? ` · เปลี่ยนทางตามมือถือ ${row.followed}` : ""} · ส่งเส้นทาง {row.delivered}</small></td>
                  <td>{row.arrived} / {row.agents}</td><td>{fmt(row.p50)}</td><td>{fmt(row.p95)}</td><td>{fmt(row.final)}{row.incapacitated ? <><br /><small className="mh-warn">ช่วยเหลือ {row.incapacitated}</small></> : null}</td>
                  <td>{row.dangerSeconds} ช่องทาง·วิ<br /><small>ติดขัด {row.clogs} ครั้ง</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && <p className="mh-muted">เทียบได้ตรงเมื่อใช้ seed จำนวนคน จุดไฟ และพฤติกรรมเดียวกัน · ผลนี้มาจากแบบจำลอง ไม่ใช่การวัดจริง <button type="button" className="mh-btn is-xs" onClick={clearRows}>ล้างตาราง</button></p>}
    </section>
  );
}

// ------------------------------------------------------------------ checkpoint QR sheet

function CheckpointQrSheet({ map, onClose }: { map: MapPackage; onClose: () => void }) {
  const [buildingId, setBuildingId] = useState(map.buildings[0]?.id ?? "");
  const floors = map.buildings.find((building) => building.id === buildingId)?.floors ?? [];
  const [floor, setFloor] = useState<number>(floors[floors.length - 1] ?? 1);
  useEffect(() => { if (floors.length && !floors.includes(floor)) setFloor(floors[floors.length - 1]); }, [floors, floor]);
  const checkpoints = map.checkpoints.filter((checkpoint) => checkpoint.buildingId === buildingId && checkpoint.floor === floor);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="mh-print" role="dialog" aria-modal="true" aria-label="ป้าย QR จุดยืนยันตำแหน่ง">
      <div className="mh-print-bar">
        <b>ป้าย QR จุดยืนยันตำแหน่ง · แผนที่ {map.mapVersion}</b>
        <select value={buildingId} onChange={(event) => setBuildingId(event.target.value)} aria-label="อาคาร">{map.buildings.filter((building) => building.floors.some((value) => value > 0)).map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select>
        <select value={floor} onChange={(event) => setFloor(Number(event.target.value))} aria-label="ชั้น">{floors.map((value) => <option key={value} value={value}>{value === 0 ? "ภายนอก" : `ชั้น ${value}`}</option>)}</select>
        <button type="button" className="mh-btn is-primary" onClick={() => window.print()}>พิมพ์</button>
        <button ref={closeRef} type="button" className="mh-btn" onClick={onClose}>ปิด</button>
      </div>
      <p className="mh-muted mh-print-note">QR มีเพียงลิงก์ <code>/mobile?cp=รหัสจุด</code> ไม่มีรหัสผ่านหรือข้อมูลส่วนตัว ต้องติดตั้งตรงตำแหน่งจริงและตรวจกับแปลนก่อนใช้ ตำแหน่งจุดในแผนที่ยังมาจากแบบจำลอง ไม่ได้สำรวจภาคสนาม</p>
      <div className="mh-print-grid">
        {checkpoints.map((checkpoint) => {
          const url = `${window.location.origin}/mobile?cp=${encodeURIComponent(checkpoint.id)}`;
          return (
            <figure key={checkpoint.id} className="mh-print-card">
              <QrImage text={url} label={`QR ${checkpoint.name}`} />
              <figcaption><b>{checkpoint.name}</b><span>{map.buildings.find((building) => building.id === checkpoint.buildingId)?.name} · ชั้น {checkpoint.floor}</span><code>{checkpoint.id}</code><small>สแกนเพื่อยืนยันว่าคุณอยู่ที่จุดนี้</small></figcaption>
            </figure>
          );
        })}
        {!checkpoints.length && <p className="mh-muted">ชั้นนี้ไม่มีจุดยืนยันตำแหน่ง</p>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ control centre

function DeliveryDots({ row }: { row: ParticipantRow }) {
  const stages: Array<[keyof ParticipantRow["delivery"], string]> = [["accepted", "ระบบรับคำสั่ง"], ["sent", "ส่งแล้ว"], ["received", "อุปกรณ์ได้รับ"], ["viewed", "เปิดดู"], ["confirmed", "ผู้ใช้ยืนยัน"]];
  return (
    <span className="mh-delivery" aria-label={stages.map(([key, label]) => `${label}: ${row.delivery[key] ? clock(row.delivery[key]) : "ยัง"}`).join(", ")}>
      {stages.map(([key, label]) => <i key={key} className={row.delivery[key] ? "is-on" : ""} title={`${label} ${clock(row.delivery[key])}`}>{row.delivery[key] ? "●" : "○"}</i>)}
    </span>
  );
}

function ControlCentre({ snapshot, map, call, run, onViewParticipant, viewingId }: { snapshot: StaffSnapshot | null; map: MapPackage | null; call: DemoProps["call"]; run: DemoProps["run"]; onViewParticipant: (id: string | null) => void; viewingId: string | null }) {
  const incident = snapshot?.incidents.find((candidate) => candidate.id === snapshot.activeIncidentId) ?? null;
  const backendMode = useBackendMode();
  const joinUrl = incident ? `${window.location.origin}/mobile?join=${incident.joinCode}` : null;
  const nodeName = (id: string | null | undefined) => (id && map?.nodes.find((node) => node.id === id)?.name) || "—";
  const [countZone, setCountZone] = useState("");
  const [countValue, setCountValue] = useState("");
  const [printOpen, setPrintOpen] = useState(false);
  if (!snapshot) return <p className="mh-muted">กำลังรับข้อมูลจากเซิร์ฟเวอร์…</p>;
  const c = snapshot.counts;
  return (
    <div className="mh-centre">
      {printOpen && map && <CheckpointQrSheet map={map} onClose={() => setPrintOpen(false)} />}
      <div className="mh-buttons mh-centre-tools"><button type="button" className="mh-btn" disabled={!map} onClick={() => setPrintOpen(true)}>ป้าย QR จุดยืนยันตำแหน่ง (พิมพ์)</button></div>
      {incident && joinUrl && (
        <section className="mh-group mh-join" aria-labelledby="mh-g-join">
          <h3 id="mh-g-join">เข้าร่วมด้วยมือถือจริง</h3>
          <div className="mh-join-body">
            <QrImage text={joinUrl} label={`QR เข้าร่วมรอบ รหัส ${incident.joinCode}`} />
            <div>
              <p>รหัส <code className="mh-code">{incident.joinCode}</code></p>
              <p className="mh-link"><a href={joinUrl} target="_blank" rel="noreferrer">{joinUrl}</a></p>
              <p className="mh-muted">QR นี้มีเพียงลิงก์และรหัสรอบ ไม่มีรหัสเจ้าหน้าที่ มือถือต้องอยู่ในเครือข่ายเดียวกับเครื่องนี้ {window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "— ตอนนี้เปิดผ่าน localhost มือถือจะเปิดลิงก์นี้ไม่ได้ ให้เปิดเว็บด้วย IP ของเครื่อง" : ""}</p>
              {incident.mode === "simulation" && <p className="mh-warn">โหมดสถานการณ์จำลองไม่รับมือถือจริง — สร้างรอบฝึกซ้อมเพื่อทดสอบกับมือถือ</p>}
              {backendMode === "browser" && <p className="mh-warn">ตอนนี้ระบบทำงานในเบราว์เซอร์นี้เท่านั้น (ไม่มีเซิร์ฟเวอร์) มือถือเครื่องอื่นจึงยังเข้าร่วมด้วย QR นี้ไม่ได้ ใช้มือถือจำลองในหน้านี้ได้ตามปกติ หากต้องการให้มือถือจริงเข้าร่วม ให้รัน <code>npm run server:lan</code> แล้วเปิดหน้านี้ใหม่</p>}
            </div>
          </div>
        </section>
      )}
      <section className="mh-group" aria-labelledby="mh-g-counts">
        <h3 id="mh-g-counts">จำนวน (แยกตามที่มาของข้อมูล)</h3>
        <dl className="mh-counts">
          <div><dt>อุปกรณ์ที่เชื่อมต่ออยู่</dt><dd>{c.connectedDevices}</dd></div>
          <div><dt>สตรีมที่เปิด (หลายแท็บนับแยก)</dt><dd>{c.openStreams}</dd></div>
          <div><dt>เซสชันในรอบ</dt><dd>{c.sessions}</dd></div>
          <div><dt>ผู้เข้าร่วมจริง</dt><dd>{c.registeredParticipants}</dd></div>
          <div><dt>ผู้ทดสอบ (ไม่นับเป็นประชากร)</dt><dd>{c.testParticipants}</dd></div>
          <div><dt>ตำแหน่งยืนยันสด</dt><dd>{c.withConfirmedLocation}</dd></div>
          <div><dt>ตำแหน่งเก่า/ไม่ทราบ</dt><dd>{c.staleOrUnknownLocation}</dd></div>
          <div><dt>แจ้งถึงจุดรวมพลเอง</dt><dd>{c.selfReportedArrived}</dd></div>
          <div><dt>ครูยืนยันแล้ว</dt><dd>{c.teacherConfirmed}</dd></div>
          <div><dt>ประชากรตามแผนห้องเรียน</dt><dd>{c.plannedPopulation.toLocaleString("th-TH")}</dd></div>
        </dl>
        <p className="mh-muted">มือถือหนึ่งเครื่องไม่เท่ากับหนึ่งคน คนที่ไม่มีมือถือหรือแบตหมดจะไม่ปรากฏในตัวเลขอุปกรณ์ — ใช้การนับของครูประกอบเสมอ</p>
      </section>
      <section className="mh-group" aria-labelledby="mh-g-people">
        <h3 id="mh-g-people">ผู้เข้าร่วมและสถานะการส่ง <small>(●=ระบบรับ · ส่ง · ได้รับ · เปิดดู · ยืนยัน)</small></h3>
        <div className="mh-table-wrap">
          <table className="mh-table">
            <thead><tr><th>ผู้เข้าร่วม</th><th>ตำแหน่ง</th><th>คำแนะนำ</th><th>การส่ง</th><th>จุดรวมพล</th><th /></tr></thead>
            <tbody>
              {snapshot.participants.map((row) => (
                <tr key={row.participantId} className={row.helpRequestedAt ? "is-help" : ""}>
                  <td><b>{row.displayName}</b>{row.isTest && <span className="mh-tag">ทดสอบ</span>}<br /><small>{row.connected ? `เชื่อมต่อ (${row.connections})` : `ออฟไลน์ · ล่าสุด ${clock(row.lastSeenAt)}`}</small>{row.helpRequestedAt && <><br /><span className="mh-warn">ขอความช่วยเหลือ {clock(row.helpRequestedAt)}</span></>}</td>
                  <td>{nodeName(row.location?.nodeId)}<br /><small>{STATE_TH[row.locationState]}{row.location ? ` · ${clock(row.location.observedAt)}` : ""}</small></td>
                  <td>{row.adviceStatus ? `ฉบับ ${row.routeRevision}` : "—"}<br /><small>{row.destinationName ?? row.nextInstruction ?? ""}</small></td>
                  <td><DeliveryDots row={row} />{row.blockedReports > 0 && <><br /><small className="mh-warn">แจ้งทางใช้ไม่ได้ {row.blockedReports}</small></>}</td>
                  <td><small>{row.arrival.selfReportedAt ? `แจ้งเอง ${clock(row.arrival.selfReportedAt)}` : "—"}<br />{row.arrival.teacherConfirmedAt ? `ครูยืนยัน ${clock(row.arrival.teacherConfirmedAt)}` : ""}</small>
                    {!row.arrival.teacherConfirmedAt && <button type="button" className="mh-btn is-xs" onClick={() => void run("ครูยืนยัน", () => call(`/api/admin/participants/${row.participantId}/confirm-arrival`, {}))}>ครูยืนยัน</button>}</td>
                  <td>{!row.isTest && <button type="button" className="mh-btn is-xs" aria-pressed={viewingId === row.participantId} onClick={() => onViewParticipant(viewingId === row.participantId ? null : row.participantId)}>{viewingId === row.participantId ? "เลิกดู" : "ดูหน้าจอ"}</button>}</td>
                </tr>
              ))}
              {!snapshot.participants.length && <tr><td colSpan={6} className="mh-muted">ยังไม่มีผู้เข้าร่วม</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="mh-group" aria-labelledby="mh-g-zones">
        <h3 id="mh-g-zones">ประมาณจำนวนคนตามโซน</h3>
        <div className="mh-table-wrap">
          <table className="mh-table">
            <thead><tr><th>โซน</th><th>จากมือถือ</th><th>ตามแผน</th><th>ครูนับ</th><th>ประมาณการ</th><th>แนะนำผ่าน</th></tr></thead>
            <tbody>
              {snapshot.occupancy.filter((zone) => zone.participants || zone.teacherCount !== null || zone.routedThrough).slice(0, 30).map((zone) => (
                <tr key={zone.zoneId}>
                  <td>{zone.label}</td><td>{zone.participants}</td><td>{zone.plannedHeadcount}</td>
                  <td>{zone.teacherCount ?? "—"}{zone.teacherCountAt ? <small> · {clock(zone.teacherCountAt)}</small> : null}</td>
                  <td>{zone.estimate === null ? <small>ไม่ทราบ</small> : zone.coverage === "devices-partial" ? `อย่างน้อย ${zone.estimate}` : zone.estimate}</td>
                  <td>{zone.routedThrough}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="mh-inline-form" onSubmit={(event) => { event.preventDefault(); if (incident && countZone) void run("บันทึกจำนวนจากครู", () => call(`/api/admin/incidents/${incident.id}/zone-count`, { zoneId: countZone, count: Number(countValue) })); }}>
          <select value={countZone} onChange={(event) => setCountZone(event.target.value)} aria-label="โซนที่ครูนับ">
            <option value="">เลือกโซนที่ครูนับ…</option>
            {snapshot.occupancy.map((zone) => <option key={zone.zoneId} value={zone.zoneId}>{zone.label}</option>)}
          </select>
          <input type="number" min={0} max={2000} value={countValue} onChange={(event) => setCountValue(event.target.value)} aria-label="จำนวนคน" placeholder="จำนวน" />
          <button type="submit" className="mh-btn is-xs" disabled={!countZone || countValue === ""}>บันทึก</button>
        </form>
      </section>
      <section className="mh-group" aria-labelledby="mh-g-bottle">
        <h3 id="mh-g-bottle">ทางที่มีคนได้รับคำแนะนำมาก</h3>
        {snapshot.bottlenecks.length ? (
          <ul className="mh-bars">{snapshot.bottlenecks.map((row) => (
            <li key={row.edgeId}><span>{row.label}</span><b>{row.assigned} คน · ~{row.clearanceSeconds} วินาที</b><i style={{ width: `${Math.min(100, row.clearanceSeconds)}%` }} aria-hidden="true" /></li>
          ))}</ul>
        ) : <p className="mh-muted">ยังไม่มี — ค่านี้คือจำนวนคนที่ระบบแนะนำให้ใช้ทาง ÷ ความจุ ไม่ใช่ความยาวคิวที่วัดได้จริง</p>}
      </section>
      <section className="mh-group" aria-labelledby="mh-g-sensors">
        <h3 id="mh-g-sensors">เซนเซอร์ในรอบนี้ <span className="mh-tag">ทั้งหมดเป็นตัวจำลอง</span></h3>
        <ul className="mh-sensors">
          {snapshot.sensors.filter((sensor) => sensor.status !== "unknown" || sensor.issues.length).slice(0, 12).map((sensor) => (
            <li key={sensor.sensorId} className={`is-${sensor.status}`}><b>{SENSOR_STATUS_TH[sensor.status]}</b> {sensor.label}{sensor.lastValue !== null ? ` · ${sensor.lastValue} ${sensor.unit ?? ""}` : ""}{sensor.issues.length ? <small> · {sensor.issues.join(", ")}</small> : null}</li>
          ))}
          {!snapshot.sensors.some((sensor) => sensor.status !== "unknown") && <li className="mh-muted">ยังไม่มีข้อมูลเข้ามา (ไม่ทราบสถานะ ≠ ปลอดภัย)</li>}
        </ul>
      </section>
      <section className="mh-group" aria-labelledby="mh-g-log">
        <h3 id="mh-g-log">บันทึกเหตุการณ์</h3>
        <ol className="mh-log">{[...snapshot.log].reverse().slice(0, 30).map((entry) => <li key={entry.seq}><time>{clock(entry.at)}</time><span>{entry.detail}</span></li>)}</ol>
      </section>
      <section className="mh-group" aria-labelledby="mh-g-live">
        <h3 id="mh-g-live">โหมดเหตุจริง: {snapshot.liveModeAvailable ? "เปิดได้ตามการตั้งค่า (ยังไม่ใช่การรับรองว่าใช้จริงได้)" : "ปิดอยู่"}</h3>
        <ul className="mh-ready">{snapshot.liveReadiness.map((item) => <li key={item.id} className={item.ok ? "is-ok" : ""}>{item.ok ? "✓" : "✗"} {item.label}</li>)}</ul>
        <p className="mh-muted">ต้นแบบนี้ไม่สั่งงานอุปกรณ์ฉุกเฉินหรือส่งการแจ้งเตือนเหตุจริงอัตโนมัติ · รายการด้านบนตรวจได้แค่ "ตั้งค่าแล้ว" ไม่ได้พิสูจน์ว่าแผนที่ เซนเซอร์ ตำแหน่งมือถือ และการแจ้งเตือนทำงานถูกต้องในอาคารจริง ต้องทดสอบหน้างานและมีช่องทางสำรอง (เสียงตามสาย ครู ป้าย) เสมอ</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ host

export function MobileGuidanceHost({ mode, open, compact, onMode, onClose, panelRef, onWidth }: HostProps) {
  const [width, setWidth] = useState(() => { try { const saved = Number(window.sessionStorage.getItem(WIDTH_KEY)); return saved >= MIN_W ? Math.min(saved, maxWidth()) : 760; } catch { return 760; } });
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { try { window.sessionStorage.setItem(WIDTH_KEY, String(width)); } catch { /* ignore */ } onWidth?.(width); }, [width, onWidth]);
  useEffect(() => { const onResize = () => setWidth((current) => Math.min(current, maxWidth())); window.addEventListener("resize", onResize); return () => window.removeEventListener("resize", onResize); }, []);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startW = width;
    const move = (moveEvent: PointerEvent) => setWidth(Math.max(MIN_W, Math.min(maxWidth(), Math.round(startW + (startX - moveEvent.clientX)))));
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); document.body.classList.remove("mh-resizing"); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    document.body.classList.add("mh-resizing");
  };
  const connection = useStaffConnection(true);
  const { snapshot, call } = connection;
  const map = useMapPackage(connection.status === "online");
  const bots = useBotSimulator(snapshot, map, call);
  const [size, setSize] = useState<PhoneSize>("standard");
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const [tab, setTab] = useState<"demo" | "centre">("demo");
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [preview, setPreview] = useState<{ incidentId: string; ticket: string } | null>(() => { try { const raw = window.sessionStorage.getItem(PREVIEW_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; } });
  const [previewParticipantId, setPreviewParticipantId] = useState<string | null>(null);
  const [networkOnline, setNetworkOnline] = useState(true);
  const autoWalk=useAutoWalk(previewParticipantId,call,networkOnline);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [readonlyView, setReadonlyView] = useState<{ view: ParticipantView; at: number } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ticketRequest = useRef<string | null>(null);
  const activeIncident = snapshot?.incidents.find((candidate) => candidate.id === snapshot.activeIncidentId) ?? null;

  const run = useCallback(async (label: string, task: () => Promise<unknown>) => {
    try { await task(); setToast({ text: `${label}: เซิร์ฟเวอร์รับคำสั่งแล้ว`, tone: "ok" }); }
    catch (error) { setToast({ text: `${label} ไม่สำเร็จ: ${(error as Error).message}`, tone: "error" }); }
  }, []);
  useEffect(() => { if (!toast) return undefined; const id = window.setTimeout(() => setToast(null), 4200); return () => window.clearTimeout(id); }, [toast]);

  // One preview (test) participant per incident: the ticket is kept for this tab so reopening the
  // panel, resizing or switching modes never creates another session.
  useEffect(() => {
    if (!activeIncident || activeIncident.phase === "ended" || connection.status !== "online") return;
    if (preview?.incidentId === activeIncident.id || ticketRequest.current === activeIncident.id) return;
    ticketRequest.current = activeIncident.id;
    void call<{ ticket: string; incidentId: string }>(`/api/admin/incidents/${activeIncident.id}/preview-ticket`, {}).then((data) => {
      const next = { incidentId: data.incidentId, ticket: data.ticket };
      try { window.sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      setPreview(next);
      setPreviewParticipantId(null);
      setNetworkOnline(true);
    }).catch((error: Error) => { ticketRequest.current = null; setToast({ text: `เชื่อมกรอบมือถือไม่สำเร็จ: ${error.message}`, tone: "error" }); });
  }, [activeIncident, preview, connection.status, call]);

  // Messages from our own iframe only.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as Partial<PreviewMessage> | null;
      if (!data || data.source !== "skr-evac-mobile") return;
      if (data.type === "session" && typeof data.participantId === "string") setPreviewParticipantId(data.participantId);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const setNetwork = useCallback((online: boolean) => {
    setNetworkOnline(online);
    const message: HostMessage = { source: "skr-evac-host", type: "set-network", online };
    iframeRef.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);

  // Read-only view of a real participant (staff permission; never sends positions for that device).
  useEffect(() => {
    if (!viewingId) { setReadonlyView(null); return undefined; }
    let cancelled = false;
    const load = () => void call<ParticipantView>(`/api/admin/participants/${viewingId}/view`).then((view) => { if (!cancelled) setReadonlyView({ view, at: Date.now() }); }).catch(() => undefined);
    load();
    const id = window.setInterval(load, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [viewingId, call]);

  // Escape leaves presentation mode (and only that).
  useEffect(() => {
    if (mode !== "presentation" || !open) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onMode("docked"); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, onMode, open]);
  useEffect(() => { if (open && mode !== "minimized") headingRef.current?.focus(); }, [mode, open]);

  const iframeSrc = preview ? `/mobile?embed=1&incident=${encodeURIComponent(preview.incidentId)}&ticket=${encodeURIComponent(preview.ticket)}` : "";
  const readonlySource = useMemo(() => (readonlyView ? createReadonlySource(readonlyView.view, map, readonlyView.at) : null), [readonlyView, map]);
  const viewingRow = snapshot?.participants.find((row) => row.participantId === viewingId) ?? null;

  const backendMode = useBackendMode();
  const statusLine = connection.status === "online" && backendMode === "browser" ? "จำลองในเบราว์เซอร์ · ไม่ต้องรันเซิร์ฟเวอร์" : connection.status === "online" ? "เชื่อมต่อศูนย์ข้อมูลแล้ว" : connection.status === "no-backend" ? "ยังไม่พบเซิร์ฟเวอร์ (npm run server)" : connection.status === "need-token" ? "ต้องใส่รหัสเจ้าหน้าที่" : connection.status === "offline" ? "ขาดการเชื่อมต่อเซิร์ฟเวอร์" : "กำลังเชื่อมต่อ…";
  const demoProps: DemoProps = { snapshot, map, call, previewParticipantId, networkOnline, setNetwork, run, autoWalk };

  return (
    <section
      ref={panelRef}
      hidden={!open}
      className={`mh-root is-${mode}${compact ? " is-compact" : ""}${drawer ? " has-drawer" : ""}`}
      style={{ "--mh-w": `${width}px` } as React.CSSProperties}
      aria-label="ระบบนำทางมือถือ"
      role={mode === "presentation" || compact ? "dialog" : "region"}
      aria-modal={mode === "presentation" || compact ? true : undefined}
    >
      {mode === "docked" && !compact && (
        <div className="mh-resize" role="separator" aria-orientation="vertical" aria-label="ปรับความกว้างแผง" aria-valuemin={MIN_W} aria-valuemax={maxWidth()} aria-valuenow={width} tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(event) => { if (event.key === "ArrowLeft") setWidth((w) => Math.min(maxWidth(), w + 24)); else if (event.key === "ArrowRight") setWidth((w) => Math.max(MIN_W, w - 24)); }} />
      )}
      <header className="mh-head">
        <div className="mh-title">
          <h2 ref={headingRef} tabIndex={-1}>ระบบนำทางมือถือ</h2>
          <span className={`mh-status is-${connection.status}`}><i aria-hidden="true" />{statusLine}</span>
        </div>
        {mode !== "minimized" && !compact && (
          <div className="mh-tools">
            <label className="mh-select"><span className="mh-sr">ขนาดหน้าจอทดสอบ</span>
              <select value={size} onChange={(event) => setSize(event.target.value as PhoneSize)}>
                {(Object.keys(PHONE_SIZES) as PhoneSize[]).map((key) => <option key={key} value={key}>{PHONE_SIZES[key].label} {PHONE_SIZES[key].width}×{PHONE_SIZES[key].height}</option>)}
              </select>
            </label>
            <button type="button" className="mh-btn is-quiet-dark" aria-pressed={zoom === "actual"} onClick={() => setZoom(zoom === "fit" ? "actual" : "fit")}>{zoom === "fit" ? "ขนาดจริง 100%" : "ย่อให้พอดี"}</button>
          </div>
        )}
        <div className="mh-window">
          {compact && <button type="button" className="mh-btn is-quiet-dark" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>{drawer ? "ซ่อนแผงควบคุม" : "แผงควบคุม"}</button>}
          {mode === "presentation"
            ? <button type="button" className="mh-btn is-primary" onClick={() => onMode("docked")}>กลับไปเว็บหลัก <kbd>Esc</kbd></button>
            : !compact && <button type="button" className="mh-btn is-quiet-dark" onClick={() => onMode("presentation")}>โหมดนำเสนอ</button>}
          {mode !== "presentation" && !compact && <button type="button" className="mh-btn is-quiet-dark" onClick={() => onMode(mode === "minimized" ? "docked" : "minimized")} aria-label={mode === "minimized" ? "ขยายแผงนำทางมือถือ" : "ย่อแผงนำทางมือถือ"}>{mode === "minimized" ? "ขยาย" : "ย่อ"}</button>}
          {mode !== "presentation" && <button type="button" className="mh-btn is-quiet-dark" onClick={onClose} aria-label="ปิดแผงนำทางมือถือ (ระบบยังทำงานต่อ)">ปิด</button>}
        </div>
      </header>
      <div className="mh-body">
        {mode === "presentation" && (
          <aside className="mh-story" aria-label="สถานการณ์">
            <span className="mh-overline">กำลังสาธิต</span>
            <h3>{activeIncident ? activeIncident.title : "ยังไม่มีรอบ"}</h3>
            {activeIncident && <p><span className={`mh-chip is-${activeIncident.mode}`}>{MODE_TH[activeIncident.mode]}</span> <span className={`mh-chip is-phase-${activeIncident.phase}`}>{PHASE_TH[activeIncident.phase]}</span></p>}
            <p>หน้าจอในกรอบคือหน้า <code>/mobile</code> ตัวเดียวกับที่มือถือจริงเปิด เชื่อมกับเซิร์ฟเวอร์เดียวกัน ผู้ทดสอบในกรอบถูกแยกเป็นข้อมูลจำลองและไม่นับเป็นประชากรจริง</p>
            {activeIncident && activeIncident.hazards.length > 0 && <ul>{activeIncident.hazards.map((hazard) => <li key={hazard.zoneId + hazard.label}>{hazard.label}</li>)}</ul>}
            {snapshot && <p className="mh-muted">ผู้เข้าร่วมจริง {snapshot.counts.registeredParticipants} · อุปกรณ์เชื่อมต่อ {snapshot.counts.connectedDevices} · แจ้งถึงจุดรวมพล {snapshot.counts.selfReportedArrived} · ครูยืนยัน {snapshot.counts.teacherConfirmed}</p>}
          </aside>
        )}
        <div className="mh-phone-col">
          {viewingId && (
            <div className="mh-readonly-bar" role="status">
              ดูหน้าจอของ {viewingRow?.displayName ?? viewingId} แบบอ่านอย่างเดียว · ข้อมูลเมื่อ {clock(readonlyView?.at)}
              <button type="button" className="mh-btn is-xs" onClick={() => setViewingId(null)}>กลับไปกรอบทดสอบ</button>
            </div>
          )}
          <PhoneFrame size={size} zoom={zoom} bare={compact} label={viewingId ? "หน้าจอผู้เข้าร่วม (อ่านอย่างเดียว)" : "กรอบมือถือจำลอง"}>
            {/* The preview only ever runs with a staff-issued test ticket, so it can never join as a real participant. */}
            {preview && preview.incidentId === activeIncident?.id ? (
              <iframe
                ref={iframeRef}
                key={preview.incidentId}
                className="mh-iframe"
                src={iframeSrc}
                title="หน้าจอมือถือของระบบนำทางอพยพ (ผู้ทดสอบ)"
                hidden={Boolean(viewingId)}
              />
            ) : !viewingId && (
              <div className="mh-placeholder" role="status">
                <b>ยังไม่มีผู้ทดสอบในกรอบนี้</b>
                <span>{connection.status !== "online" ? "รอเชื่อมต่อเซิร์ฟเวอร์ระบบนำทาง" : activeIncident && activeIncident.phase !== "ended" ? "กำลังเตรียมผู้ทดสอบ…" : "สร้างรอบฝึกซ้อมหรือสถานการณ์จำลองในแผงควบคุม แล้วหน้าจอมือถือจะเข้าร่วมเป็นผู้ทดสอบให้อัตโนมัติ"}</span>
              </div>
            )}
            {viewingId && readonlySource && <div className="mh-readonly"><MobileApp source={readonlySource} /></div>}
          </PhoneFrame>
        </div>
        <div className="mh-side">
          {connection.status === "need-token" ? (
            <form className="mh-group" onSubmit={(event) => { event.preventDefault(); connection.login(tokenInput); }}>
              <h3>เข้าสู่ระบบเจ้าหน้าที่</h3>
              <p className="mh-muted">เครื่องนี้ไม่ใช่เครื่องที่รันเซิร์ฟเวอร์ ใส่รหัสเจ้าหน้าที่ที่แสดงในหน้าต่างเซิร์ฟเวอร์ (หรือค่า EVAC_STAFF_TOKEN)</p>
              <input className="mh-input" type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" aria-label="รหัสเจ้าหน้าที่" />
              <button type="submit" className="mh-btn is-primary">เข้าสู่ระบบ</button>
            </form>
          ) : connection.status === "no-backend" ? (
            <div className="mh-group">
              <h3>ยังไม่พบเซิร์ฟเวอร์ระบบนำทาง</h3>
              <p className="mh-muted">เปิดอีกหน้าต่างแล้วรัน <code>npm run server</code> (หรือ <code>npm run server:lan</code> เพื่อให้มือถือในเครือข่ายเดียวกันเข้าได้) — การจำลอง 3 มิติยังใช้งานได้ตามปกติ</p>
            </div>
          ) : (
            <>
              <div className="mh-tabs" role="tablist" aria-label="แผงควบคุม">
                <button type="button" role="tab" aria-selected={tab === "demo"} onClick={() => setTab("demo")}>ควบคุมการสาธิต</button>
                <button type="button" role="tab" aria-selected={tab === "centre"} onClick={() => setTab("centre")}>ศูนย์ควบคุม</button>
              </div>
              <div className="mh-side-scroll">
                {tab === "demo" ? (
                  <>
                    <p className="mh-note">แผงนี้สำหรับเจ้าหน้าที่ทดสอบระบบ ไม่ปรากฏในหน้าจอนักเรียน ทุกค่าที่ส่งจากที่นี่ถูกติดป้ายว่าเป็นข้อมูลจำลอง</p>
                    <SessionControls snapshot={snapshot} call={call} run={run} />
                    <TesterControls {...demoProps} />
                    <SensorControls snapshot={snapshot} call={call} run={run} />
                    <ClosureControls snapshot={snapshot} call={call} run={run} />
                    <BotPhoneControls bots={bots} call={call} onViewParticipant={setViewingId} />
                  </>
                ) : (
                  <ControlCentre snapshot={snapshot} map={map} call={call} run={run} onViewParticipant={setViewingId} viewingId={viewingId} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {toast && <div className={`mh-toast is-${toast.tone}`} role="status">{toast.text}</div>}
    </section>
  );
}
