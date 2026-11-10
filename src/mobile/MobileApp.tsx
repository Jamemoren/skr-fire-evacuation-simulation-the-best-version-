import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Maneuver, MapPackage, ParticipantView, RouteAdvice } from "../evac/protocol";
import { adviceIsCurrent, type ClientState, type MobileActions, type MobileSource, type PreviewMessage } from "./client";
import { MiniMap } from "./MiniMap";
import { QrScanner } from "./QrScanner";

const SCHOOL = "โรงเรียนสวนกุหลาบวิทยาลัย รังสิต";
const SYSTEM = "ระบบนำทางอพยพ";

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(id); }, [intervalMs]);
  return now;
}

function ago(at: number | null | undefined, now: number) {
  if (!at) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds} วินาทีก่อน`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} นาทีก่อน` : `${Math.round(minutes / 60)} ชั่วโมงก่อน`;
}

function clock(at: number | null | undefined) {
  return at ? new Date(at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
}

const MODE_LABEL = { simulation: "สถานการณ์จำลอง", drill: "ฝึกซ้อม", live: "เหตุจริง" } as const;
const SOURCE_LABEL = { qr: "สแกน QR", manual: "เลือกเอง", geolocation: "GPS", teacher: "ครูยืนยัน", "demo-simulated": "ข้อมูลจำลอง (ผู้ทดสอบ)", simulator: "ตัวละครในแบบจำลอง (SIMULATOR)" } as const;

/**
 * What the roleplay host knows about its character and passes to the player's phone: the
 * direction to the next point of the advised route relative to where the character looks.
 * Simulation data only — a real phone never receives this.
 */
export interface PlayerGuide {
  /** Bearing of the next waypoint relative to the view, degrees (0 ahead, +90 right). Null = no route. */
  bearingDeg: number | null;
  /** Metres to that waypoint along the plan. */
  distanceM: number | null;
  vertical: "up" | "down" | null;
  targetFloor: number | null;
  /** The character is clearly away from the advised walkway (m). */
  offRouteM: number;
  /** Where the character stands (from the walkway it is on, not from x/z alone). */
  place: { buildingId: string; floor: number; nodeId: string };
  position: [number, number, number];
  headingDeg: number;
  /** People within 2.5 m of the character in the simulation. */
  crowdNearby: number;
  /** Fire/smoke on the walkway the character stands on (0–1), simulation ground truth. */
  hazardHere: number;
}

function buildingName(map: MapPackage | null, buildingId: string | undefined) {
  return map?.buildings.find((building) => building.id === buildingId)?.name ?? "ไม่ทราบอาคาร";
}

function nodeName(map: MapPackage | null, nodeId: string | null | undefined) {
  return (nodeId && map?.nodes.find((node) => node.id === nodeId)?.name) || "ไม่ทราบจุด";
}

/** The step the person is on, from their latest confirmed position on the route (never a timer). */
function currentStepIndex(advice: RouteAdvice, nodeId: string | null | undefined) {
  if (!nodeId) return 0;
  const index = advice.maneuvers.findIndex((step) => {
    const at = step.nodeIds.indexOf(nodeId);
    return at >= 0 && at < step.nodeIds.length - 1;
  });
  return index >= 0 ? index : Math.max(0, advice.maneuvers.findIndex((step) => step.nodeIds[step.nodeIds.length - 1] === nodeId) + 1);
}

function StepIcon({ kind }: { kind: Maneuver["kind"] }) {
  // Symbols only — no arrow that could read as "turn left/right" (the phone does not know the heading).
  const path = kind === "stair-down" ? "M5 19h4v-4h4v-4h4V7h3" : kind === "stair-up" ? "M5 7h4v4h4v4h4v4h3"
    : kind === "exit" ? "M4 21h16M7 21V3h10v18M7 3l6 2.5V21" : kind === "assembly" ? "M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z"
      : kind === "bridge" ? "M3 15h18M5 15V9h14v6M8 9v6m4-6v6m4-6v6" : kind === "leave-room" ? "M4 21h16M7 21V3h10v18M14 12h.5"
        : "M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z";
  return <svg className="m-step-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

// ------------------------------------------------------------------ chrome

function TopBar({ state, view }: { state: ClientState; view: ParticipantView | null }) {
  const mode = view?.incident?.mode;
  const connection = state.simulatedOffline ? "ขาดการเชื่อมต่อ (จำลอง)" : state.connection === "online" ? "เชื่อมต่อแล้ว" : state.connection === "connecting" ? "กำลังเชื่อมต่อ" : "ขาดการเชื่อมต่อ";
  return (
    <header className="m-top">
      <div className="m-top-title">
        <img src="/assets/skr-school-emblem.png" alt="" width="28" height="28" />
        <div><strong>{SYSTEM}</strong><span>{SCHOOL}</span></div>
      </div>
      <div className="m-top-badges">
        {mode && <span className={`m-badge is-${mode}`}>{MODE_LABEL[mode]}</span>}
        {state.kind === "player"
          ? <span className="m-badge is-player">SIMULATOR · มือถือผู้เล่น</span>
          : (state.kind !== "device" || view?.me.isTest) && <span className="m-badge is-test">{state.kind === "readonly" ? "ดูอย่างเดียว" : "ผู้ทดสอบ · ข้อมูลจำลอง"}</span>}
        <span className={`m-conn is-${state.simulatedOffline ? "offline" : state.connection}`} role="status"><i aria-hidden="true" />{connection}</span>
      </div>
    </header>
  );
}

function ErrorLine({ state, actions }: { state: ClientState; actions: MobileActions | null }) {
  if (!state.error) return null;
  return (
    <div className="m-alert is-error" role="alert">
      <span>{state.error}</span>
      {actions && <button type="button" className="m-btn is-ghost is-sm" onClick={actions.clearError}>ปิด</button>}
    </div>
  );
}

// ------------------------------------------------------------------ location sheet

function LocationPicker({ map, onPick, onClose }: { map: MapPackage; onPick: (checkpointId: string) => void; onClose: () => void }) {
  const [buildingId, setBuildingId] = useState(map.buildings[0]?.id ?? "building-1");
  const floors = map.buildings.find((building) => building.id === buildingId)?.floors ?? [];
  const [floor, setFloor] = useState<number>(floors[floors.length - 1] ?? 1);
  useEffect(() => { if (!floors.includes(floor)) setFloor(floors[floors.length - 1] ?? 0); }, [buildingId]); // eslint-disable-line react-hooks/exhaustive-deps
  const order: Record<string, number> = { room: 0, stair: 1, junction: 2, corridor: 3, exit: 4, gate: 5, assembly: 6 };
  const options = map.checkpoints
    .filter((checkpoint) => checkpoint.buildingId === buildingId && checkpoint.floor === floor)
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.name.localeCompare(b.name, "th"));
  return (
    <section className="m-sheet" aria-label="เลือกตำแหน่งด้วยตัวเอง">
      <header className="m-sheet-head">
        <h2>เลือกจุดที่คุณอยู่</h2>
        <button type="button" className="m-btn is-ghost" onClick={onClose}>ปิด</button>
      </header>
      <div className="m-seg" role="radiogroup" aria-label="อาคาร">
        {map.buildings.map((building) => (
          <button key={building.id} type="button" role="radio" aria-checked={building.id === buildingId} onClick={() => setBuildingId(building.id)}>{building.name}</button>
        ))}
      </div>
      {buildingId !== "site" && (
        <div className="m-seg is-floors" role="radiogroup" aria-label="ชั้น">
          {floors.map((value) => <button key={value} type="button" role="radio" aria-checked={value === floor} onClick={() => setFloor(value)}>ชั้น {value}</button>)}
        </div>
      )}
      <ul className="m-list">
        {options.map((checkpoint) => (
          <li key={checkpoint.id}>
            <button type="button" onClick={() => onPick(checkpoint.id)}>
              <span>{checkpoint.name}</span>
              <small>{checkpoint.id}</small>
            </button>
          </li>
        ))}
        {!options.length && <li className="m-fine">ไม่มีจุดในชั้นนี้</li>}
      </ul>
      <p className="m-fine">การเลือกเองมีความน่าเชื่อถือปานกลาง ถ้ามีป้าย QR ใกล้ตัว ให้สแกนจะแม่นกว่า</p>
    </section>
  );
}

// ------------------------------------------------------------------ screens

function SetupScreen({ state, actions, joinCodeHint }: { state: ClientState; actions: MobileActions; joinCodeHint: string }) {
  const [code, setCode] = useState(joinCodeHint);
  const [name, setName] = useState("");
  return (
    <div className="m-screen">
      <section className="m-card is-hero">
        <h1>เข้าร่วมรอบฝึกซ้อม</h1>
        <p>สแกน QR หรือเปิดลิงก์จากครู/เจ้าหน้าที่ หรือพิมพ์รหัสเข้าร่วม 6 ตัว</p>
        <label className="m-field"><span>รหัสเข้าร่วม</span>
          <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={8} autoCapitalize="characters" placeholder="เช่น K7Q2MX" />
        </label>
        <label className="m-field"><span>ชื่อที่แสดงให้เจ้าหน้าที่ (ไม่บังคับ)</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="เช่น ม.4/2 เลขที่ 15" />
        </label>
        <button type="button" className="m-btn is-primary is-block" disabled={state.busy || code.trim().length < 4} onClick={() => void actions.join(code, name)}>เข้าร่วม</button>
        {state.pendingCheckpoint && <p className="m-note">จะยืนยันตำแหน่งจุด {state.pendingCheckpoint} ให้หลังเข้าร่วม</p>}
      </section>
      <PermissionCard state={state} actions={actions} />
      <section className="m-card is-quiet">
        <h2>ข้อมูลที่ระบบเก็บ</h2>
        <p className="m-fine">เก็บเฉพาะรหัสเซสชันแบบสุ่ม จุดที่คุณยืนยัน (อาคาร ชั้น จุดตรวจ เวลา) และการตอบรับคำแนะนำ เพื่อใช้ในรอบนี้เท่านั้น เจ้าหน้าที่เห็นตำแหน่งรายคนได้ ผู้เข้าร่วมคนอื่นไม่เห็น บันทึกถูกลบตามระยะเวลาที่โรงเรียนกำหนด</p>
      </section>
    </div>
  );
}

function PermissionCard({ state, actions }: { state: ClientState; actions: MobileActions | null }) {
  const caps = state.capabilities;
  return (
    <section className="m-card is-quiet" aria-label="ความสามารถของอุปกรณ์นี้">
      <h2>อุปกรณ์นี้ใช้อะไรได้บ้าง</h2>
      <ul className="m-caps">
        <li className={caps.barcodeDetector && caps.camera ? "is-ok" : "is-no"}><b>{caps.barcodeDetector && caps.camera ? "ได้" : "ไม่ได้"}</b> สแกน QR ในหน้านี้ {caps.barcodeDetector && caps.camera ? "" : "— ใช้แอปกล้องหรือพิมพ์รหัสแทน"}</li>
        <li className={caps.geolocation ? "is-ok" : "is-no"}><b>{caps.geolocation ? "ได้" : "ไม่ได้"}</b> อ่าน GPS {caps.geolocation ? "(ใช้ระบุอาคาร/ชั้นไม่ได้ จนกว่าจะเทียบพิกัดแผนที่)" : "— ต้องเปิดผ่าน HTTPS"}</li>
        <li className={caps.notifications === "granted" ? "is-ok" : "is-no"}>
          <b>{caps.notifications === "granted" ? "อนุญาต" : caps.notifications === "unsupported" ? "ไม่รองรับ" : caps.notifications === "denied" ? "ปฏิเสธแล้ว" : "ยังไม่อนุญาต"}</b> การแจ้งเตือน
          {actions && caps.notifications === "default" && <button type="button" className="m-btn is-ghost is-sm" onClick={() => void actions.requestNotifications()}>ขออนุญาต</button>}
        </li>
      </ul>
      <p className="m-fine">หน้านี้อัปเดตสดขณะเปิดอยู่เท่านั้น ถ้าปิดหน้าจอหรือปิดเบราว์เซอร์ อาจไม่ได้รับข้อความ — ฟังสัญญาณเตือนภัยของอาคาร ครู และเจ้าหน้าที่เป็นหลักเสมอ</p>
    </section>
  );
}

function LocationCard({ state, view, onScan, onPick, onGps, actions }: { state: ClientState; view: ParticipantView; onScan: () => void; onPick: () => void; onGps: () => void; actions: MobileActions | null }) {
  const now = useNow();
  const fix = view.me.location;
  const stateLabel = { confirmed: "ยืนยันแล้ว", stale: "ข้อมูลเก่า", uncertain: "ไม่แน่นอน", unknown: "ยังไม่ทราบ" }[view.me.locationState];
  return (
    <section className="m-card" aria-label="ตำแหน่งของคุณ">
      <div className="m-row"><h2>ตำแหน่งของคุณ</h2><span className={`m-pill is-${view.me.locationState}`}>{stateLabel}</span></div>
      {fix ? (
        <dl className="m-facts">
          <div><dt>อาคาร / ชั้น</dt><dd>{buildingName(state.map, fix.buildingId)}{fix.buildingId !== "site" ? ` ชั้น ${fix.floor}` : ""}</dd></div>
          <div><dt>จุดที่ยืนยันล่าสุด</dt><dd>{nodeName(state.map, fix.nodeId)}{fix.checkpointId ? ` · ${fix.checkpointId}` : ""}</dd></div>
          <div><dt>วิธียืนยัน</dt><dd>{SOURCE_LABEL[fix.source]}</dd></div>
          <div><dt>อัปเดตตำแหน่ง</dt><dd>{clock(fix.observedAt)} ({ago(fix.observedAt - state.serverOffsetMs, now)})</dd></div>
        </dl>
      ) : <p className="m-note">ยังไม่ได้ยืนยันตำแหน่ง</p>}
      {view.me.locationNote && <p className="m-alert is-warn">{view.me.locationNote}</p>}
      {state.kind === "player" && <p className="m-fine">ตำแหน่งมาจากตัวละครที่คุณควบคุมในแบบจำลองโดยอัตโนมัติ (ไม่ใช่ตำแหน่งจริง)</p>}
      {actions && state.kind !== "player" && (
        <div className="m-actions">
          <button type="button" className="m-btn is-primary" onClick={onScan}>สแกน QR จุดตรวจ</button>
          <button type="button" className="m-btn" onClick={onPick}>เลือกตำแหน่งเอง</button>
          <button type="button" className="m-btn is-ghost" onClick={onGps} disabled={!state.capabilities.geolocation}>ใช้ GPS</button>
        </div>
      )}
    </section>
  );
}

function ReadyScreen({ state, view, actions, sheets }: { state: ClientState; view: ParticipantView; actions: MobileActions | null; sheets: SheetControls }) {
  const incident = view.incident;
  const ended = incident?.phase === "ended";
  return (
    <div className="m-screen">
      <section className={`m-card is-status ${ended ? "is-ended" : "is-standby"}`}>
        <span className="m-overline">{incident ? incident.title : "ยังไม่มีรอบ"}</span>
        <h1>{ended ? "รอบนี้ยุติแล้ว" : "เตรียมพร้อม"}</h1>
        <p>{ended ? "ขอบคุณที่ร่วมฝึก — ไม่มีคำสั่งอพยพในรอบนี้แล้ว" : "ยังไม่มีคำสั่งอพยพ เมื่อเจ้าหน้าที่สั่งเริ่ม หน้านี้จะเปลี่ยนเป็นคำแนะนำทันทีขณะเปิดอยู่"}</p>
        {incident && <p className="m-fine">รหัสรอบ {incident.joinCode} · {view.me.displayName}</p>}
      </section>
      <LocationCard state={state} view={view} actions={actions} onScan={sheets.openQr} onPick={sheets.openPicker} onGps={() => void actions?.reportGeolocation()} />
      {actions && (
        <section className="m-card is-quiet">
          <h2>ข้อจำกัดการเคลื่อนที่</h2>
          <label className="m-switch">
            <input type="checkbox" checked={view.me.mobility === "no-stairs"} onChange={(event) => void actions.setMobility(event.target.checked ? "no-stairs" : "standard")} />
            <span>ฉันใช้บันไดไม่ได้ (แจ้งเจ้าหน้าที่ให้ช่วยเมื่อไม่มีเส้นทางที่เหมาะ)</span>
          </label>
        </section>
      )}
      <PermissionCard state={state} actions={actions} />
      {actions && <button type="button" className="m-btn is-ghost is-block" onClick={() => void actions.leave()}>ออกจากรอบนี้</button>}
    </div>
  );
}

function IncidentScreen({ view, onContinue }: { view: ParticipantView; onContinue: () => void }) {
  const incident = view.incident!;
  return (
    <div className="m-screen">
      <section className={`m-card is-alarm is-${incident.mode}`} role="alert">
        <span className="m-overline">{MODE_LABEL[incident.mode]}{incident.mode !== "live" ? " — ไม่ใช่เหตุจริง" : ""}</span>
        <h1>เริ่มอพยพตามแผน</h1>
        <p>เดินอพยพอย่างมีสติ ไม่วิ่ง ไม่แซง ไม่ผลักกัน และทำตามคำสั่งครู</p>
        {incident.hazards.length > 0 && (
          <ul className="m-hazards">{incident.hazards.map((hazard) => <li key={hazard.zoneId + hazard.label}>{hazard.label}</li>)}</ul>
        )}
        {incident.announcements.slice(-2).map((announcement) => <p key={announcement.id} className="m-announce">{announcement.text}</p>)}
        <button type="button" className="m-btn is-primary is-block is-lg" onClick={onContinue}>ดูคำแนะนำเส้นทาง</button>
      </section>
    </div>
  );
}

function FreshnessLine({ advice, state }: { advice: RouteAdvice; state: ClientState }) {
  const now = useNow();
  const serverNow = now + state.serverOffsetMs;
  const current = adviceIsCurrent(advice, state);
  return (
    <p className={`m-fresh${current ? "" : " is-stale"}`} role="status">
      {current
        ? `คำแนะนำออกเมื่อ ${ago(advice.issuedAt, serverNow)} · ฉบับที่ ${advice.routeRevision}`
        : `ไม่ใช่ข้อมูลสด — ได้รับล่าสุดเมื่อ ${ago(advice.issuedAt, serverNow)} (ฉบับที่ ${advice.routeRevision})`}
      {state.kind === "player" && state.poseAcceptedAt && <span className="m-fresh-sub"> · ส่งตำแหน่งล่าสุด {ago(state.poseAcceptedAt, now)}{state.poseRoundTripMs !== null ? ` (ไป-กลับ ${state.poseRoundTripMs} ms)` : ""}</span>}
    </p>
  );
}

const FLOOR_WORD = (floor: number | null) => (floor === null ? "" : floor <= 1 ? "ชั้น 1 (ชั้นล่าง)" : `ชั้น ${floor}`);

/** Arrow relative to where the character looks, or the stair to take. Never says "run". */
function PlayerArrow({ guide, current, map }: { guide: PlayerGuide; current: boolean; map: MapPackage | null }) {
  const stair = guide.vertical !== null;
  const bearing = guide.bearingDeg;
  const side = bearing === null ? "" : Math.abs(bearing) < 25 ? "ตรงไป" : Math.abs(bearing) > 150 ? "หันกลับ" : bearing > 0 ? (bearing > 65 ? "เลี้ยวขวา" : "เบี่ยงขวา") : (bearing < -65 ? "เลี้ยวซ้าย" : "เบี่ยงซ้าย");
  const text = bearing === null ? "ยังไม่มีทิศทางให้"
    : stair ? `${guide.vertical === "down" ? "ลงบันได" : "ขึ้นบันได"}ไป${FLOOR_WORD(guide.targetFloor)}`
      : side;
  return (
    <section className={`m-card is-player-arrow${current ? "" : " is-stale"}`} aria-label="ทิศทางจากมุมมองของตัวละคร" data-bearing={bearing === null ? "" : Math.round(bearing)} data-vertical={guide.vertical ?? ""}>
      <div className="m-arrow-row">
        <svg className="m-arrow" viewBox="0 0 64 64" aria-hidden="true" style={{ transform: `rotate(${bearing ?? 0}deg)` }}>
          <circle cx="32" cy="32" r="30" className="m-arrow-ring" />
          {bearing !== null && <path d="M32 8 L48 36 L36 33 L36 54 L28 54 L28 33 L16 36 Z" className="m-arrow-head" />}
        </svg>
        <div>
          <strong className="m-arrow-text">{text}</strong>
          {stair && <span className="m-arrow-sub">{side ? `${side} แล้ว` : ""}{guide.vertical === "down" ? "ลง" : "ขึ้น"}บันไดอย่างระมัดระวัง จับราวบันได</span>}
          {guide.distanceM !== null && !stair && <span className="m-arrow-sub">อีกประมาณ {Math.max(1, Math.round(guide.distanceM))} ม. ตามทางเดิน</span>}
        </div>
      </div>
      <p className="m-fine">อยู่ที่ {buildingName(map, guide.place.buildingId)}{guide.place.buildingId !== "site" ? ` ชั้น ${guide.place.floor}` : ""} · {nodeName(map, guide.place.nodeId)}</p>
      {guide.offRouteM > 2.5 && <p className="m-alert is-warn">คุณออกนอกเส้นทางที่แนะนำ — ระบบกำลังคำนวณเส้นทางจากจุดที่คุณอยู่</p>}
      <ul className="m-player-status">
        <li className={guide.hazardHere > 0.05 ? "is-bad" : ""}><b>ไฟ/ควันตรงนี้</b>{guide.hazardHere > 0.5 ? "รุนแรง — ถอยออกจากบริเวณนี้" : guide.hazardHere > 0.05 ? "มีควัน — ก้มต่ำและออกจากบริเวณนี้" : "ไม่พบ"}</li>
        <li className={guide.crowdNearby >= 6 ? "is-warn" : ""}><b>คนรอบตัว</b>{guide.crowdNearby} คน{guide.crowdNearby >= 6 ? " — เดินเว้นระยะ ไม่ผลักกัน" : ""}</li>
      </ul>
      <p className="m-fine">ข้อมูลจำลอง: ลูกศรอ้างอิงทิศที่ตัวละครหันหน้าในแบบจำลองเท่านั้น</p>
    </section>
  );
}

function NavigateScreen({ state, view, actions, sheets, guide }: { state: ClientState; view: ParticipantView; actions: MobileActions | null; sheets: SheetControls; guide?: PlayerGuide | null }) {
  const advice = view.advice!;
  const fix = view.me.location;
  const stepIndex = currentStepIndex(advice, fix?.nodeId);
  const step = advice.maneuvers[Math.min(stepIndex, advice.maneuvers.length - 1)];
  const upcoming = advice.maneuvers.slice(stepIndex + 1, stepIndex + 3);
  const changed = Boolean(advice.reason && advice.previousRouteId && !state.confirmedRouteIds.includes(advice.routeId));
  const current = adviceIsCurrent(advice, state);
  useEffect(() => { if (current) actions?.markViewed(advice.routeId); }, [advice.routeId, current, actions]);
  if (!step) return null;
  const mapFloor = fix?.buildingId === step.buildingId ? fix.floor : step.floor;
  return (
    <div className="m-screen">
      {changed && (
        <section className="m-card is-changed" role="alert" aria-live="assertive">
          <span className="m-overline">เปลี่ยนคำแนะนำแล้ว</span>
          <p className="m-reason"><b>เหตุผล:</b> {advice.reason!.text}</p>
          {actions && <button type="button" className="m-btn is-primary is-sm" onClick={() => void actions.confirmRoute(advice.routeId)}>รับทราบเส้นทางใหม่</button>}
        </section>
      )}
      {advice.status === "stale-location" && <p className="m-alert is-warn">{advice.message}</p>}
      {guide && <PlayerArrow guide={guide} current={current} map={state.map} />}
      <section className={`m-card is-instruction${current ? "" : " is-stale"}`} aria-live="polite">
        <span className="m-overline">ขั้นที่ {Math.min(stepIndex, advice.maneuvers.length - 1) + 1} จาก {advice.maneuvers.length}</span>
        <div className="m-instruction"><StepIcon kind={step.kind} /><h1>{step.text}</h1></div>
        <p className="m-where">{buildingName(state.map, step.buildingId)}{step.buildingId !== "site" ? ` · ชั้น ${step.floor}` : ""} · จุดสังเกต: <b>{step.landmark}</b></p>
        {state.kind !== "player" && <p className="m-fine">ระบบไม่ทราบทิศที่คุณหันหน้า — ดูป้ายทางออกและชื่อจุดสังเกต</p>}
        <FreshnessLine advice={advice} state={state} />
        {actions && current && state.kind !== "player" && (
          <button type="button" className="m-btn is-primary is-block" onClick={() => void actions.reportNode(step.nodeIds[step.nodeIds.length - 1])}>
            ถึง{step.landmark}แล้ว
          </button>
        )}
      </section>
      {state.map && (
        <MiniMap map={state.map} buildingId={guide ? guide.place.buildingId : step.buildingId} floor={guide ? guide.place.floor : mapFloor} routeNodeIds={advice.nodeIds} currentNodeId={fix?.nodeId}
          targetNodeId={step.nodeIds[step.nodeIds.length - 1]} muted={!current}
          player={guide ? { x: guide.position[0], z: guide.position[2], headingDeg: guide.headingDeg } : null}
          hazards={view.hazards ?? null}
          label={`แผนผัง${buildingName(state.map, guide ? guide.place.buildingId : step.buildingId)} ชั้น ${guide ? guide.place.floor : mapFloor} แสดงเส้นทางช่วงนี้`} />
      )}
      {upcoming.length > 0 && (
        <section className="m-card is-quiet" aria-label="ขั้นต่อไป">
          <h2>ต่อไป</h2>
          <ol className="m-steps">{upcoming.map((next) => <li key={next.index}><StepIcon kind={next.kind} /><span>{next.text}</span></li>)}</ol>
          {advice.destination && <p className="m-fine">ปลายทาง: <b>{advice.destination.name}</b>{advice.estimatedSeconds ? ` · ประมาณ ${Math.max(1, Math.round(advice.estimatedSeconds / 60))} นาทีถ้าทางไม่ติด` : ""}</p>}
        </section>
      )}
      {actions && (
        <div className="m-actions is-bottom">
          <button type="button" className="m-btn" onClick={() => void actions.reportBlocked(step.edgeIds[0] ?? null)}>ทางนี้ใช้ไม่ได้</button>
          <button type="button" className="m-btn is-danger" onClick={() => void actions.requestHelp()}>{view.me.helpRequestedAt ? "ขอความช่วยเหลือแล้ว" : "ขอความช่วยเหลือ"}</button>
          {state.kind !== "player" && <button type="button" className="m-btn is-ghost" onClick={sheets.openQr}>สแกน QR</button>}
          {state.kind !== "player" && <button type="button" className="m-btn is-ghost" onClick={() => void actions.reportArrived(advice.destination?.nodeId ?? null)}>ถึงจุดรวมพลแล้ว</button>}
        </div>
      )}
    </div>
  );
}

function UncertainScreen({ state, view, actions, sheets }: { state: ClientState; view: ParticipantView; actions: MobileActions | null; sheets: SheetControls }) {
  const fix = view.me.location;
  return (
    <div className="m-screen">
      <section className="m-card is-uncertain" role="alert">
        <span className="m-overline">ตำแหน่งไม่แน่นอน</span>
        <h1>ยังไม่ทราบจุดหรือชั้นที่แน่ชัด</h1>
        <p>{view.advice?.message ?? "ช่วยยืนยันตำแหน่งเพื่อให้ระบบแนะนำเส้นทาง"}</p>
        {fix && <p className="m-fine">จุดล่าสุดที่ยืนยันได้: {nodeName(state.map, fix.nodeId)} ({clock(fix.observedAt)}) — ระบบจะไม่เดาตำแหน่งให้</p>}
        {actions && (
          <div className="m-actions">
            <button type="button" className="m-btn is-primary" onClick={sheets.openQr}>สแกน QR ใกล้ตัว</button>
            <button type="button" className="m-btn" onClick={sheets.openPicker}>เลือกจุดที่อยู่</button>
            {fix?.nodeId && view.me.locationNote && <button type="button" className="m-btn is-ghost" onClick={() => void actions.reportNode(fix.nodeId!, true)}>ยังอยู่ที่ {nodeName(state.map, fix.nodeId)}</button>}
          </div>
        )}
      </section>
      <p className="m-alert is-info">ระหว่างนี้เดินตามป้ายทางออกและคำสั่งครูอย่างมีสติ</p>
    </div>
  );
}

function NoRouteScreen({ view, actions }: { view: ParticipantView; actions: MobileActions | null }) {
  const advice = view.advice!;
  return (
    <div className="m-screen">
      <section className="m-card is-alarm" role="alert">
        <span className="m-overline">{advice.status === "mobility-no-route" ? "ต้องการความช่วยเหลือ" : "ไม่มีเส้นทางที่ใช้ได้"}</span>
        <h1>{advice.status === "mobility-no-route" ? "ไม่มีเส้นทางที่ไม่ใช้บันได" : "ยังไม่พบเส้นทางที่ใช้ได้"}</h1>
        <p>{advice.message}</p>
        {actions && <button type="button" className="m-btn is-danger is-block is-lg" onClick={() => void actions.requestHelp()} disabled={Boolean(view.me.helpRequestedAt)}>{view.me.helpRequestedAt ? `แจ้งเจ้าหน้าที่แล้ว ${clock(view.me.helpRequestedAt)}` : "ขอความช่วยเหลือ"}</button>}
      </section>
    </div>
  );
}

function OfflineScreen({ state, view }: { state: ClientState; view: ParticipantView | null }) {
  const now = useNow();
  const advice = view?.advice ?? null;
  const fix = view?.me.location ?? null;
  return (
    <div className="m-screen">
      <section className="m-card is-offline" role="alert">
        <span className="m-overline">{state.simulatedOffline ? "ขาดการเชื่อมต่อ (จำลอง)" : "ขาดการเชื่อมต่อ"}</span>
        <h1>ไม่ได้รับข้อมูลสด</h1>
        <p>รับข้อมูลล่าสุดเมื่อ {clock(state.lastMessageAt)} ({ago(state.lastMessageAt, now)}) — ทำตามคำสั่งครู เจ้าหน้าที่ และป้ายทางออก</p>
        {advice && advice.maneuvers.length > 0 && (
          <div className="m-stale-route">
            <h2>คำแนะนำล่าสุดที่ได้รับ (ไม่ยืนยันว่ายังใช้ได้)</h2>
            <ol className="m-steps is-muted">{advice.maneuvers.slice(0, 4).map((step) => <li key={step.index}><StepIcon kind={step.kind} /><span>{step.text}</span></li>)}</ol>
          </div>
        )}
      </section>
      {state.map && fix && (
        <section className="m-card is-quiet">
          <h2>แผนผังอ้างอิงแบบออฟไลน์</h2>
          <p className="m-fine">{state.map.offlineNote} (แผนที่รุ่น {state.map.mapVersion})</p>
          <MiniMap map={state.map} buildingId={fix.buildingId} floor={fix.floor} currentNodeId={fix.nodeId} muted hazards={view?.hazards ?? null} label="แผนผังอ้างอิงแบบออฟไลน์" />
        </section>
      )}
    </div>
  );
}

function AssemblyScreen({ state, view, actions }: { state: ClientState; view: ParticipantView; actions: MobileActions | null }) {
  const arrival = view.me.arrival;
  const destination = view.advice?.destination ?? null;
  const atAssembly = view.me.location?.nodeId && state.map?.nodes.find((node) => node.id === view.me.location?.nodeId)?.type === "assembly";
  return (
    <div className="m-screen">
      <section className="m-card is-assembly">
        <span className="m-overline">จุดรวมพล</span>
        <h1>{destination?.name ?? nodeName(state.map, arrival.selfReportedAssemblyId)}</h1>
        <ul className="m-proof">
          <li className={atAssembly ? "is-ok" : ""}><b>{atAssembly ? "✓" : "–"}</b> ตำแหน่งที่ยืนยันอยู่ในจุดรวมพล</li>
          <li className={arrival.selfReportedAt ? "is-ok" : ""}><b>{arrival.selfReportedAt ? "✓" : "–"}</b> คุณแจ้งว่าถึงแล้ว{arrival.selfReportedAt ? ` (${clock(arrival.selfReportedAt)})` : ""}</li>
          <li className={arrival.teacherConfirmedAt ? "is-ok" : ""}><b>{arrival.teacherConfirmedAt ? "✓" : "–"}</b> ครูยืนยันตัวแล้ว{arrival.teacherConfirmedAt ? ` (${clock(arrival.teacherConfirmedAt)})` : " — รอครูตรวจนับ"}</li>
        </ul>
        <p className="m-fine">การกดแจ้งถึงเป็นข้อมูลจากคุณเท่านั้น ไม่ใช่การยืนยันความปลอดภัยของทุกคน อยู่กับกลุ่มและห้ามกลับเข้าอาคาร</p>
        {actions && !arrival.selfReportedAt && <button type="button" className="m-btn is-primary is-block" onClick={() => void actions.reportArrived(destination?.nodeId ?? null)}>ฉันถึงจุดรวมพลแล้ว</button>}
      </section>
    </div>
  );
}

/** What the simulator adapter last told the server (player phone only). */
function SimWorldCard({ incident }: { incident: NonNullable<ParticipantView["incident"]> }) {
  const now = useNow();
  const world = incident.simWorld ?? null;
  return (
    <section className="m-card is-quiet" aria-label="สถานการณ์ในแบบจำลอง">
      <h2>ไฟ · ทางปิด · ความแออัด (ข้อมูลจำลอง)</h2>
      {incident.hazards.length > 0
        ? <ul className="m-hazards">{incident.hazards.slice(0, 4).map((hazard) => <li key={hazard.zoneId + hazard.label}>{hazard.label}</li>)}</ul>
        : <p className="m-fine">ยังไม่มีไฟหรือควันปิดทางในแบบจำลอง</p>}
      <p className="m-fine">
        ทางที่เจ้าหน้าที่ปิด {incident.closedEdgeIds.length} ช่วง
        {world ? ` · ทางที่ไฟ/ควันปิด ${world.blockedEdges} ช่วง · ทางที่มีคนหนาแน่น ${world.crowdedEdges} ช่วง · ข้อมูลแบบจำลองล่าสุด ${ago(world.receivedAt, now)}` : " · ยังไม่ได้รับข้อมูลจากแบบจำลอง"}
      </p>
      <p className="m-fine">ที่มา: ค่าจริงภายในแบบจำลอง 3 มิติ (ground truth ของ SIMULATOR) ไม่ใช่เซนเซอร์จริง</p>
    </section>
  );
}

// ------------------------------------------------------------------ app

interface SheetControls { openQr: () => void; openPicker: () => void }

export function MobileApp({ source, joinCodeHint = "", playerGuide = null }: { source: MobileSource; joinCodeHint?: string; playerGuide?: PlayerGuide | null }) {
  const state = useSyncExternalStore(source.subscribe, source.getState, source.getState);
  const actions = source.actions;
  const view = state.view;
  const [sheet, setSheet] = useState<"qr" | "picker" | null>(null);
  const [alertSeenFor, setAlertSeenFor] = useState<string | null>(null);
  const sheets = useMemo<SheetControls>(() => ({ openQr: () => setSheet("qr"), openPicker: () => setSheet("picker") }), []);
  const onCheckpoint = useCallback((checkpointId: string) => { setSheet(null); void actions?.reportCheckpoint(checkpointId, "qr"); }, [actions]);

  const incident = view?.incident ?? null;
  const evacuating = incident?.phase === "evacuate";
  const evacuationKey = incident && incident.evacuateAt ? `${incident.id}:${incident.evacuateAt}` : null;
  const online = state.connection === "online" && !state.simulatedOffline;
  const fixNode = view?.me.location?.nodeId ? state.map?.nodes.find((node) => node.id === view.me.location?.nodeId) : undefined;

  let screen: string;
  if (state.kind !== "readonly" && !state.session) screen = "setup";
  else if (!view) screen = state.connection === "offline" || state.simulatedOffline ? "offline" : "loading";
  else if (!evacuating) screen = "ready";
  else if (!online) screen = "offline";
  // The roleplay player is already walking when the alarm starts: no full-screen stop.
  else if (evacuationKey && alertSeenFor !== evacuationKey && state.kind !== "readonly" && state.kind !== "player") screen = "incident";
  else if (view.me.arrival.selfReportedAt || fixNode?.type === "assembly") screen = "assembly";
  else if (!view.advice || view.advice.status === "no-location") screen = "uncertain";
  else if (view.advice.status === "no-route" || view.advice.status === "mobility-no-route") screen = "no-route";
  else screen = "navigate";

  useEffect(() => {
    if (state.kind !== "preview" || window.parent === window) return;
    const message: PreviewMessage = { source: "skr-evac-mobile", type: "screen", screen, routeRevision: view?.advice?.routeRevision ?? null };
    window.parent.postMessage(message, window.location.origin);
  }, [screen, state.kind, view?.advice?.routeRevision]);

  return (
    <div className={`m-app is-${screen}${evacuating ? " is-evacuating" : ""}`} data-screen={screen}>
      <TopBar state={state} view={view} />
      <main className="m-body" id="m-main">
        <ErrorLine state={state} actions={actions} />
        {state.mapNote && <p className="m-alert is-warn">{state.mapNote}</p>}
        {screen === "setup" && actions && <SetupScreen state={state} actions={actions} joinCodeHint={joinCodeHint} />}
        {screen === "loading" && <div className="m-screen"><p className="m-note" role="status">กำลังเชื่อมต่อระบบ…</p></div>}
        {screen === "ready" && view && <ReadyScreen state={state} view={view} actions={actions} sheets={sheets} />}
        {screen === "offline" && <OfflineScreen state={state} view={view} />}
        {screen === "incident" && view && <IncidentScreen view={view} onContinue={() => setAlertSeenFor(evacuationKey)} />}
        {screen === "assembly" && view && <AssemblyScreen state={state} view={view} actions={actions} />}
        {screen === "uncertain" && view && <UncertainScreen state={state} view={view} actions={actions} sheets={sheets} />}
        {screen === "no-route" && view && <NoRouteScreen view={view} actions={actions} />}
        {screen === "navigate" && view && <NavigateScreen state={state} view={view} actions={actions} sheets={sheets} guide={state.kind === "player" ? playerGuide : null} />}
        {state.kind === "player" && screen === "navigate" && view?.incident && <SimWorldCard incident={view.incident} />}
      </main>
      {sheet === "qr" && actions && <QrScanner supported={state.capabilities.barcodeDetector && state.capabilities.camera} onCheckpoint={onCheckpoint} onClose={() => setSheet(null)} />}
      {sheet === "picker" && actions && state.map && <LocationPicker map={state.map} onPick={(checkpointId) => { setSheet(null); void actions.reportCheckpoint(checkpointId, "manual"); }} onClose={() => setSheet(null)} />}
      {state.busy && <div className="m-busy" role="status" aria-label="กำลังส่งข้อมูล" />}
    </div>
  );
}
