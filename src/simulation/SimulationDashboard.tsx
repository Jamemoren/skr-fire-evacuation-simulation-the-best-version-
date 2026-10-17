import { useEffect, useState } from "react";
import { FIELD_CENTER, TARGET_POPULATION, STAIR_ZONE_CENTERS, type StairZone, floorBase } from "../building1/building1Data";
import { useBuilding1Store } from "../building1/building1Store";
import { useMapperStore } from "../store";
import { evaluateOperationalReadiness, type OperationalReadinessReport } from "./operationalReadiness";
import { useEvacuationStore } from "./simulationStore";
import { UiIcon } from "../components/UiIcon";
import { QualityControls } from "../rendering/QualityControls";
import { useQualityStore } from "../rendering/qualityStore";
import { useWalkStore } from "../navigation/walkStore";
import { TouchWalkControls } from "../navigation/TouchWalkControls";

type MobilePanel = "scene" | "controls" | "metrics" | "activity";
function SheetHeading({ title, close }: { title: string; close: () => void }) {
  return <div className="sim-sheet-heading"><strong>{title}</strong><button type="button" onClick={close} aria-label="ปิดแผง กลับไปดูโมเดล"><UiIcon name="close" /></button></div>;
}

function fmtTime(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const min = Math.floor(value / 60);
  const sec = Math.floor(value % 60);
  return min > 0 ? `${min}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

function MetricCard({ label, value, sub, tone = "default" }: { label: string; value: string; sub?: string; tone?: "default" | "good" | "warn" | "danger" }) {
  return <div className={`sim-kpi-card tone-${tone}`}><span>{label}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</div>;
}

function HumanDecisionVisual() {
  return (
    <figure className="sim-human-decision-visual" aria-label="ลำดับการรับรู้และตัดสินใจของนักเรียน">
      <svg viewBox="0 0 280 62" role="img" aria-hidden="true">
        <defs><linearGradient id="decisionFlow" x1="0" x2="1"><stop stopColor="#df6f51" /><stop offset=".5" stopColor="#2694bc" /><stop offset="1" stopColor="#269670" /></linearGradient></defs>
        <path className="flow-line" d="M30 31H250" />
        <g transform="translate(28 31)"><circle r="17" /><path d="M-8 8c8-5-3-9 5-15M0 9c9-6-2-10 6-16M8 8c7-5-1-8 5-13" /></g>
        <g transform="translate(102 31)"><circle r="17" /><path d="M-11 0c7-9 15-9 22 0-7 9-15 9-22 0Z" /><circle r="4" /></g>
        <g transform="translate(176 31)"><circle r="17" /><circle cx="-6" cy="-3" r="4" /><circle cx="7" cy="-3" r="4" /><path d="M-11 10v-5m0 0h10M2 5h10m0 0v5" /></g>
        <g transform="translate(250 31)"><circle r="17" /><path d="M-9 12V-12H8V12M-2 0h10" /><path className="exit-arrow" d="M-13 0H3m0 0-5-5m5 5-5 5" /></g>
      </svg>
      <figcaption><span>รับรู้ควัน/ความร้อน</span><span>คาดการณ์แนวลาม</span><span>คัดทางรอดที่ ETA สั้นสุด</span><span>หนีผ่านประตูจริง</span></figcaption>
    </figure>
  );
}

function SurvivalIntelligence({ smokeAware, heatAware, reroutes, running }: { smokeAware: number; heatAware: number; reroutes: number; running: boolean }) {
  return (
    <div className={`sim-risk-routing ${running ? "is-live" : ""}`} aria-label="กระบวนการประเมินความเสี่ยงและเลือกเส้นทางอพยพ">
      <div className="sim-survival-head"><span><i /> การวางแผนเส้นทางตามความเสี่ยง</span><strong>{running ? "กำลังทำงาน" : "พร้อมใช้งาน"}</strong></div>
      <div className="sim-survival-flow">
        <div><b>01</b><i className="sense-icon" /><span>ตรวจจับ</span><small>ควัน · ความร้อน · คำเตือน</small></div>
        <div><b>02</b><i className="assess-icon" /><span>ประเมิน</span><small>แนวลาม · เวลา · ความเสี่ยง · คิว</small></div>
        <div><b>03</b><i className="route-icon" /><span>เลือกเส้นทาง</span><small>เปรียบเทียบเวลาและความเสี่ยง</small></div>
        <div><b>04</b><i className="act-icon" /><span>ปฏิบัติ</span><small>หนี · หันกลับ · ก้มต่ำ · แยกกลุ่ม</small></div>
      </div>
      <div className="sim-survival-live"><span>รับรู้ควัน <strong>{smokeAware.toLocaleString("th-TH")}</strong></span><span>รับรู้ความร้อน <strong>{heatAware.toLocaleString("th-TH")}</strong></span><span>เปลี่ยนเส้นทาง <strong>{reroutes.toLocaleString("th-TH")}</strong></span></div>
    </div>
  );
}

export function SimulationDashboard() {
  const walking = useWalkStore((state) => state.enabled);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("scene");
  const [sceneFocus, setSceneFocus] = useState(false);
  const tier = useQualityStore((state) => state.tier);
  const touch = useQualityStore((state) => state.touch);
  const [readiness, setReadiness] = useState<OperationalReadinessReport | null>(null);
  const state = useEvacuationStore();
  const requestCameraFocus = useMapperStore((s) => s.requestCameraFocus);
  const setCameraMode = useMapperStore((s) => s.setCameraMode);
  const setShowGrid = useMapperStore((s) => s.setShowGrid);
  const building = useBuilding1Store();
  const showGrid = useMapperStore((s) => s.showGrid);
  const isRunning = state.status === "running";
  const canResume = state.status === "paused";
  const isScenarioLocked = isRunning || canResume;
  const m = state.metrics;
  const primaryFireCount = state.fires.filter((fire) => fire.origin !== "spread").length;
  const activeSpreadFireCount = state.fires.filter((fire) => fire.origin === "spread" && fire.startTime <= m.elapsed).length;
  const travellingFireFrontCount = state.fires.filter((fire) => fire.origin === "spread" && fire.startTime > m.elapsed).length;
  const preflightReady = readiness?.ready === true;
  const readinessTone = readiness === null ? "checking" : readiness.ready ? "ready" : "failed";

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const report = evaluateOperationalReadiness();
      if (active) setReadiness(report);
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const focusBuilding = () => { useWalkStore.getState().setEnabled(false); building.setViewMode("exterior"); setCameraMode("isometric"); requestCameraFocus([-19, 15, 20]); };
  const focusField = () => { useWalkStore.getState().setEnabled(false); building.setViewMode("exterior"); setCameraMode("isometric"); requestCameraFocus(FIELD_CENTER); };
  const focusInterior = (floor = building.selectedFloor, room = false) => {
    setCameraMode("isometric");
    requestCameraFocus(room ? [-24, floorBase(floor) + 1.2, -5] : [-20, floorBase(floor) + 0.4, 18]);
  };
  const interiorView = building.viewMode === "interior" || building.viewMode === "single-floor";
  const floorView = interiorView || building.viewMode === "cutaway";
  const statusLabel = { idle: "พร้อมใช้งาน", running: "กำลังจำลอง", paused: "หยุดชั่วคราว", completed: "สิ้นสุดการจำลอง" }[state.status];
  const closePanel = () => setMobilePanel("scene");
  const startWalking = () => {
    const floor = floorView ? building.selectedFloor : 1;
    state.setPlaceFireMode(false); closePanel(); setSceneFocus(true); setCameraMode("isometric");
    building.setExplodeFloors(false); building.setSelectedFloor(floor); building.setViewMode(floor === 1 ? "exterior" : "cutaway");
    if (document.pointerLockElement) void document.exitPointerLock();
    useWalkStore.getState().setEnabled(true, floor);
  };
  const stopWalking = () => { focusBuilding(); setSceneFocus(false); };
  useEffect(() => () => useWalkStore.getState().setEnabled(false), []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMobilePanel("scene"); useEvacuationStore.getState().setPlaceFireMode(false); useWalkStore.getState().setEnabled(false); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const quickRun = () => {
    if (isRunning) state.pause();
    else if (canResume) state.resume();
    else if (preflightReady) { state.start(); closePanel(); }
  };

  return (
    <div className="simulation-ui-root sim-white-ui sim-campus-ui" data-panel={mobilePanel} data-focus={sceneFocus} data-walking={walking}>
      {mobilePanel !== "scene" && <button type="button" className="sim-sheet-scrim" onClick={closePanel} aria-label="ปิดแผงและดูโมเดล" />}
      <header className="sim-command-header">
        <div className="sim-brand">
          <div className="sim-brand-mark" title="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต">
            <img src="/assets/skr-school-emblem.png" alt="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต" />
          </div>
          <div><span>ระบบจำลองการอพยพหนีไฟ · อาคารเรียน 1</span><strong>โรงเรียนสวนกุหลาบวิทยาลัย รังสิต</strong></div>
        </div>
        <div className="sim-header-stats">
          <div><span>ประชากร · ชั้น 2–9</span><strong>{(m.total || state.populationTarget).toLocaleString("th-TH")}</strong></div>
          <div><span>ถึงจุดรวมพล</span><strong>{m.arrived.toLocaleString("th-TH")}</strong></div>
          <div><span>เวลาจำลอง</span><strong>{fmtTime(m.elapsed)}</strong></div>
          <div className={`sim-bottleneck-stat ${m.bottlenecks.length ? "is-warning" : ""}`}><span>คอขวด</span><strong>{m.bottlenecks.length}</strong></div>
          <div className="sim-fps-stat" title="วัดเฟรมเรตจริง · เลือกคุณภาพภาพได้ในแผงควบคุม">
            <span>อัตราเฟรม</span><strong>{state.renderFps || "—"} FPS</strong>
          </div>
          <div className={`sim-readiness-stat is-${readinessTone}`} title="ตรวจผังอาคาร ประตู บันได ความจุ และเส้นทางจริงก่อนเริ่มจำลอง">
            <span>ตรวจความพร้อม</span><strong>{readiness === null ? "กำลังตรวจ" : readiness.ready ? "ผ่าน" : "ตรวจสอบ"}</strong>
          </div>
        </div>
        <div className="sim-header-actions">
          <button type="button" className="sim-focus-toggle" aria-pressed={sceneFocus} onClick={() => setSceneFocus(!sceneFocus)}><UiIcon name="eye" /><span>{sceneFocus ? "แสดงแผง" : "ดูเต็มฉาก"}</span></button>
          <button type="button" onClick={focusBuilding}>ตึก 1</button>
          <button type="button" onClick={focusField}>สนามรวมพล</button>
          <button type="button" onClick={() => { setCameraMode("top"); requestCameraFocus([-8, 0, 52]); }}>มุมมองด้านบน</button>
          <button type="button" className="sim-editor-button" onClick={() => state.setWorkMode("editor")}>แก้ไขแบบจำลอง</button>
        </div>
      </header>

      <div className="sim-scene-toolbar" role="group" aria-label="มุมมองโมเดลโรงเรียน">
        <button type="button" onClick={() => { focusBuilding(); closePanel(); }}><UiIcon name="campus" /><span>อาคาร</span></button>
        <button type="button" onClick={() => { focusField(); closePanel(); }}><UiIcon name="field" /><span>สนาม</span></button>
        <button type="button" onClick={() => { useWalkStore.getState().setEnabled(false); setCameraMode("top"); requestCameraFocus([-8, 0, 52]); closePanel(); }}><UiIcon name="top" /><span>ด้านบน</span></button>
        <button type="button" className="sim-walk-toggle" onClick={walking ? stopWalking : startWalking} aria-pressed={walking}><UiIcon name="walk" /><span>{walking ? "ออกจากโหมดเดิน" : "เดินสำรวจ"}</span></button>
        <span className="sim-toolbar-divider" />
        <select aria-label="รูปแบบการแสดงอาคาร" value={building.viewMode} onChange={(event) => {
          const mode = event.target.value as typeof building.viewMode;
          useWalkStore.getState().setEnabled(false);
          building.setViewMode(mode);
          if (mode === "interior") focusInterior(); else { setCameraMode("isometric"); requestCameraFocus([-19, 15, 20]); }
          closePanel();
        }}>
          <option value="exterior">ภายนอกอาคาร</option><option value="cutaway">เปิดอาคาร</option><option value="interior">ภายในชั้น</option>
          {(building.viewMode === "structure" || building.viewMode === "single-floor") && <option value={building.viewMode}>มุมมองจากตัวแก้ไข</option>}
        </select>
        {floorView && <select aria-label="เลือกชั้นที่ต้องการแสดง" value={building.selectedFloor} onChange={(event) => { const floor = Number(event.target.value); building.setSelectedFloor(floor); if (interiorView) focusInterior(floor); }}>{Array.from({ length: 9 }, (_, i) => <option value={i + 1} key={i}>ชั้น {i + 1}</option>)}</select>}
        {interiorView && <select aria-label="ดูรายละเอียดบันได" value="" onChange={(event) => {
          const zone = event.target.value as StairZone;
          if (!zone) return;
          useWalkStore.getState().setEnabled(false);
          building.setStairFocus(zone);
          const c = STAIR_ZONE_CENTERS[zone];
          setCameraMode("isometric");
          requestCameraFocus([c[0], floorBase(building.selectedFloor) + .4, c[2]]);
          closePanel();
        }}><option value="">ดูบันได</option><option value="left">บันไดซ้าย</option><option value="center">บันไดกลาง</option><option value="right">บันไดขวา</option></select>}
        {interiorView && building.selectedFloor > 1 && <button type="button" className="sim-room-focus" aria-label="ห้องเรียน" title="ดูห้องเรียน" onClick={() => { focusInterior(building.selectedFloor, true); closePanel(); }}><UiIcon name="eye" /><span>ห้องเรียน</span></button>}
      </div>
      {walking && <TouchWalkControls blocked={mobilePanel !== "scene" || state.placeFireMode} onExit={stopWalking} />}
      <div className="sim-scene-caption"><span className="sim-live-dot" /><strong>อาคารเรียน 1</strong><span>{floorView ? `ชั้น ${building.selectedFloor}${interiorView ? " · มุมมองภายใน" : " · ภาพตัดอาคาร"}` : "9 ชั้น · 96 ห้องเรียน"}</span><small>{touch ? "ลากเพื่อหมุน · สองนิ้วเพื่อซูมและเลื่อน" : "คลิกซ้ายเพื่อกด · ลากคลิกขวาเพื่อหันมอง · เลื่อนล้อเมาส์เพื่อซูม"}</small></div>
      {state.placeFireMode && <div className="sim-placement-banner" role="status"><span>{touch ? "แตะ" : "คลิก"}บนอาคารเพื่อวางจุดไฟ</span><button type="button" onClick={() => state.setPlaceFireMode(false)}>ยกเลิก</button></div>}

      <aside className="sim-control-panel glass-panel">
        <SheetHeading title="ตั้งค่าการจำลอง" close={closePanel} />
        <div className="sim-panel-head"><div><span>การควบคุมการจำลอง</span><strong>การเลือกเส้นทางโดยคำนึงถึงเวลาและความเสี่ยง</strong></div><div className={`sim-status status-${state.status}`}>{statusLabel}</div></div>
        <div className={`sim-readiness-strip is-${readinessTone}`} aria-live="polite">
          <i aria-hidden="true" />
          <span>
            <strong>ความพร้อมก่อนเริ่มการจำลอง</strong>
            <small>{readiness === null ? "กำลังตรวจผัง ประตู บันได และเส้นทางทั้งหมด…" : readiness.ready ? "โครงข่ายอพยพพร้อมใช้งานและผ่านการตรวจในเครื่องนี้" : "พบรายการที่ต้องแก้ก่อนเริ่มการจำลอง"}</small>
          </span>
          <b>{readiness ? `${readiness.passed}/${readiness.total}` : "…"}</b>
        </div>
        {readiness && !readiness.ready && (
          <ul className="sim-readiness-errors">
            {readiness.checks.filter((check) => !check.passed).map((check) => <li key={check.id}><strong>{check.label}</strong><span>{check.detail}</span></li>)}
          </ul>
        )}

        <section className="sim-model-summary" aria-label="ข้อมูลแบบจำลองอาคาร"><span>ข้อมูลแบบจำลอง</span><strong>อาคารเรียน 1</strong><p>9 ชั้น · 96 ห้องเรียน · บันไดหลัก 3 จุด</p><div><span>ประชากรสูงสุด <b>3,000 คน</b></span><span>จุดรวมพล <b>6 โซน</b></span></div></section>

        <QualityControls />

        <section className="sim-control-section">
          <label>ประชากรจำลอง <strong>{state.populationTarget.toLocaleString("th-TH")} คน</strong></label>
          <div className="sim-segmented">
            <button type="button" disabled={isScenarioLocked} className={state.populationTarget === TARGET_POPULATION ? "active" : ""} onClick={() => state.setPopulationTarget(TARGET_POPULATION)}>การจำลองเต็ม 3,000</button>
            <button type="button" disabled={isScenarioLocked} className={state.populationTarget === 1500 ? "active" : ""} onClick={() => state.setPopulationTarget(1500)}>ทดสอบระบบ 1,500</button>
          </div>
          <input type="range" aria-label="จำนวนคนจำลอง" disabled={isScenarioLocked} min="40" max={TARGET_POPULATION} step="20" value={state.populationTarget} onChange={(e) => state.setPopulationTarget(Number(e.target.value))} />
          <p className="sim-hint neutral">ระบบกระจายประชากรอย่างสมดุลครบทั้ง 96 ห้องและทุกชั้น ไม่ปล่อยชั้น 9 ว่าง</p>
        </section>

        <section className="sim-control-section">
          <label>รูปแบบการเลือกเส้นทาง</label>
          <div className="sim-strategy-grid">
            <button type="button" disabled={isScenarioLocked} className={state.preset === "fastest" ? "active" : ""} onClick={() => state.setPreset("fastest")}><strong>เร็วที่สุด</strong><span>ลดเวลาอพยพโดยรวม</span></button>
            <button type="button" disabled={isScenarioLocked} className={state.preset === "balanced" ? "active" : ""} onClick={() => state.setPreset("balanced")}><strong>สมดุล</strong><span>เวลา + คิว + ความเสี่ยง</span></button>
            <button type="button" disabled={isScenarioLocked} className={state.preset === "safest" ? "active" : ""} onClick={() => state.setPreset("safest")}><strong>ปลอดภัยที่สุด</strong><span>ให้น้ำหนักการหลบไฟและควัน</span></button>
          </div>
          <figure className="sim-route-visual">
            <img src="/assets/evacuation-physical-route.png" alt="ภาพลำดับการอพยพจากห้องเรียน ผ่านประตูและบันไดที่มีช่องพื้นจริง ไปยังสนามรวมพล" />
            <figcaption><span>ห้องเรียน</span><i aria-hidden="true">→</i><span>ประตู</span><i aria-hidden="true">→</i><span>ช่องบันได</span><i aria-hidden="true">→</i><span>สนาม</span></figcaption>
          </figure>
        </section>

        <section className="sim-control-section sim-crowd-section">
          <div className="sim-section-title"><span>พฤติกรรมฝูงชน</span><strong>กำหนดรูปแบบการเคลื่อนตัว</strong></div>
          <div className="sim-crowd-modes">
            <button type="button" disabled={isScenarioLocked} className={state.crowdBehavior === "orderly" ? "active" : ""} onClick={() => state.setCrowdBehavior("orderly")}><strong>เป็นระเบียบ</strong><span>รักษาระยะและทยอยเดิน</span></button>
            <button type="button" disabled={isScenarioLocked} className={state.crowdBehavior === "grouped" ? "active" : ""} onClick={() => state.setCrowdBehavior("grouped")}><strong>เป็นกลุ่ม</strong><span>เคลื่อนตัวใกล้กลุ่มเดิม</span></button>
            <button type="button" disabled={isScenarioLocked} className={state.crowdBehavior === "surge" ? "active danger" : ""} onClick={() => state.setCrowdBehavior("surge")}><strong>หนาแน่น</strong><span>การไหลของคนมีความหนาแน่นสูง</span></button>
          </div>
          <p className={`sim-hint crowd-${state.crowdBehavior}`}>{state.crowdBehavior === "orderly" ? "รักษาระยะและทยอยเข้าประตู เหมาะกับการซ้อมตามแผน" : state.crowdBehavior === "grouped" ? "เริ่มเดินเป็นระลอกเดียวกับกลุ่มเพื่อนและรวมกลุ่มเมื่อถึงสนาม" : "จำลองการตอบสนองแบบตื่นตระหนก: เข้าเส้นทางเป็นระลอกหนาแน่นและกระจุกตัวสูง"}</p>
          <HumanDecisionVisual />
          <SurvivalIntelligence smokeAware={m.smokeAware} heatAware={m.heatAware} reroutes={m.rerouteCount} running={isRunning} />
        </section>

        <section className="sim-control-section sim-two-col">
          <label className="sim-unbounded-speed"><span>ความเร็วการเดิน <em>กำหนดได้</em></span><input aria-label="Walking speed" title="กรอกความเร็วบอทได้ทุกค่าที่มากกว่า 0 และปรับสดระหว่างการจำลองได้" type="number" min="0.01" step="0.1" value={state.walkingSpeed} onChange={(e) => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value)) state.setWalkingSpeed(value); }} /></label>
          <label>ช่วงเวลาคำนวณเส้นทางใหม่<input disabled={isScenarioLocked} type="number" min="0.5" max="10" step="0.5" value={state.rerouteInterval} onChange={(e) => state.setRerouteInterval(Number(e.target.value))} /></label>
        </section>

        <section className="sim-control-section">
          <div className="sim-section-title"><span>แบบจำลองความร้อนเชิงประมาณ</span><strong>{m.maxModeledTemperatureC.toFixed(1)}°C max</strong></div>
          <div className="sim-two-col">
            <label>อุณหภูมิเริ่มหลีกเลี่ยง (°C)<input disabled={isScenarioLocked} type="number" min="30" max="120" step="1" value={state.heatAvoidThresholdC} onChange={(e) => state.setThermalModel({ heatAvoidThresholdC: Number(e.target.value) })} /></label>
            <label>อุณหภูมิห้ามผ่าน (°C)<input disabled={isScenarioLocked} type="number" min="31" max="200" step="1" value={state.hardBlockTemperatureC} onChange={(e) => state.setThermalModel({ hardBlockTemperatureC: Number(e.target.value) })} /></label>
            <label>จำนวนช่วงเส้นทางที่ตรวจล่วงหน้า<input disabled={isScenarioLocked} type="number" min="4" max="20" step="1" value={state.thermalLookAheadEdges} onChange={(e) => state.setThermalModel({ thermalLookAheadEdges: Number(e.target.value) })} /></label>
            <label>ค่าน้ำหนักความร้อนในการเลือกเส้นทาง<input disabled={isScenarioLocked} type="number" min="0" max="20000" step="100" value={state.thermalWeight} onChange={(e) => state.setThermalModel({ thermalWeight: Number(e.target.value) })} /></label>
          </div>
          <p className="sim-hint neutral">อุณหภูมิเป็นค่าจำลองเพื่อการตัดสินใจจาก heat field ไม่ใช่ CFD/FDS และไม่ควรใช้แทนแบบจำลองวิศวกรรมอัคคีภัยที่ผ่านการสอบเทียบ</p>
        </section>

        <section className="sim-control-section">
          <div className="sim-section-title"><span>สถานการณ์ไฟและควัน</span><strong>{primaryFireCount} ต้นกำเนิด · {activeSpreadFireCount} ติดไฟ{travellingFireFrontCount > 0 ? ` · ${travellingFireFrontCount} กำลังลาม` : ""}</strong></div>
          <button type="button" className={state.placeFireMode ? "sim-fire-place active" : "sim-fire-place"} onClick={() => { state.setPlaceFireMode(!state.placeFireMode); if (!state.placeFireMode) setMobilePanel("scene"); }}>{state.placeFireMode ? "คลิกบนโมเดลเพื่อวาง จุดกำเนิดไฟ…" : "+ วางจุดไฟบนโมเดล"}</button>
          <div className="sim-fire-presets">
            <button type="button" onClick={() => state.addPresetFire("left")}>ปีกซ้าย</button>
            <button type="button" onClick={() => state.addPresetFire("center")}>แกนกลาง</button>
            <button type="button" onClick={() => state.addPresetFire("right")}>ปีกขวา</button>
            <button type="button" onClick={state.clearFires}>ล้างไฟ</button>
          </div>
          <div className={`sim-pattern-memory ${primaryFireCount ? "is-saved" : ""}`}><i /><span><strong>บันทึกตำแหน่งไฟ</strong><small>{primaryFireCount ? `บันทึกอัตโนมัติ ${primaryFireCount} จุด · เปิดเว็บครั้งถัดไปใช้งานต่อได้` : "วางไฟหนึ่งครั้ง ระบบจะจำตำแหน่งให้อัตโนมัติ"}</small></span></div>
          <label className="sim-spread-toggle"><input disabled={isScenarioLocked} type="checkbox" checked={state.fireSpreadEnabled} onChange={(e) => state.setFireSpreadEnabled(e.target.checked)} /><span><strong>การลามของไฟตามโครงสร้างที่เชื่อมต่อ</strong><small>ห้อง → ประตู → ทางเดิน → บันได · ไม่ลามทะลุผนัง</small></span></label>
          <p className="sim-hint neutral">NPC เดินอ้อมหรือซิกแซกในพื้นที่ว่างเมื่อไฟทับเส้นทาง หากถูกปิดเต็มทางจะหยุดหรือหาทางอื่น · ไม่สัมผัสเปลวไฟจะไม่หมดสติ</p>
          {state.placeFireMode && <p className="sim-hint">จุดกำเนิดไฟผูกกับชั้นและปีกของอาคาร ระบบตรวจช่องว่างสำหรับเดินอ้อมก่อนเปลี่ยนเส้นทาง</p>}
        </section>

        <section className="sim-control-section">
          <div className="sim-section-title"><span>การแสดงผล</span></div>
          <div className="sim-toggle-grid">
            <label><input type="checkbox" checked={state.showAgents} onChange={(e) => state.setShowAgents(e.target.checked)} /> คน</label>
            <label><input type="checkbox" checked={state.showFire} onChange={(e) => state.setShowFire(e.target.checked)} /> เปลวไฟ</label>
            <label><input type="checkbox" checked={state.showRoutes} onChange={(e) => state.setShowRoutes(e.target.checked)} /> เส้นทางคำนวณ</label>
            <label><input type="checkbox" checked={state.showSmoke} onChange={(e) => state.setShowSmoke(e.target.checked)} /> ควัน</label>
            <label><input type="checkbox" checked={state.showHeatZones} onChange={(e) => state.setShowHeatZones(e.target.checked)} /> ขอบเขตความเสี่ยง</label>
            <label><input type="checkbox" checked={building.showAssemblyZones} onChange={(e) => building.setShowAssemblyZones(e.target.checked)} /> จุดรวมพล A–F</label>
            <label><input type="checkbox" checked={building.showTrackLanes} onChange={(e) => building.setShowTrackLanes(e.target.checked)} /> ลู่วิ่ง</label>
            <label><input type="checkbox" checked={building.showRoomVolumes} onChange={(e) => building.setShowRoomVolumes(e.target.checked)} /> ขอบเขตห้อง</label>
            <label><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Grid</label>
          </div>
        </section>

        <div className="sim-run-controls">
          {state.status === "idle" || state.status === "completed" ? <button type="button" className="sim-run primary" disabled={!preflightReady} title={preflightReady ? "เริ่มการจำลองอพยพ" : "รอให้ระบบตรวจผังอาคารและเส้นทางผ่านก่อน"} onClick={state.start}>{readiness === null ? "กำลังตรวจระบบ…" : readiness.ready ? "เริ่มการจำลอง" : "ต้องแก้รายการตรวจสอบก่อน"}</button> : null}
          {isRunning && <button type="button" className="sim-run pause" onClick={state.pause}>หยุดชั่วคราว</button>}
          {canResume && <button type="button" className="sim-run primary" onClick={state.resume}>ทำต่อ</button>}
          <button type="button" className="sim-run reset" onClick={state.reset}>เริ่มใหม่</button>
        </div>
        <div className="sim-speed-row"><span>ความเร็วการจำลอง</span>{[1, 2, 5, 10, 25, 50].map((speed) => <button type="button" key={speed} className={state.speedFactor === speed ? "active" : ""} onClick={() => state.setSpeedFactor(speed)}>{speed}×</button>)}</div>
      </aside>

      <section className="sim-bottom-console glass-panel">
        <SheetHeading title="ผลการอพยพ" close={closePanel} />
        <div className="sim-progress-row"><span>ความคืบหน้าการอพยพไปยังจุดรวมพล</span><strong>{Math.round(m.progress * 100)}%</strong><div className="sim-progress-track"><i style={{ width: `${m.progress * 100}%` }} /></div></div>
        <div className="sim-kpi-grid">
          <MetricCard label="ถึงจุดรวมพล" value={m.arrived.toLocaleString("th-TH")} sub="เข้าแถวจุดรวมพล" tone="good" />
          <MetricCard label="กำลังรอ" value={m.queueing.toLocaleString("th-TH")} sub="รอประตู/บันได" tone={m.queueing > 150 ? "warn" : "default"} />
          <MetricCard label="เวลาคาดการณ์คนสุดท้าย" value={fmtTime(m.estimatedMakespan)} sub="เวลาสิ้นสุดโดยประมาณ" />
          <MetricCard label="คำนวณเส้นทางใหม่" value={m.rerouteCount.toLocaleString("th-TH")} sub={`thermal ${m.thermalRerouteCount.toLocaleString("th-TH")}`} />
          <MetricCard label="ตรวจขอบเขตการเดิน" value={m.topologyViolations === 0 && m.collisionCorrections === 0 ? "PASS" : `${m.collisionCorrections}`} sub="ไม่เดินทะลุกำแพง" tone={m.topologyViolations === 0 ? "good" : "danger"} />
          <MetricCard label="ความหนาแน่นสูงสุด" value={`${m.peakEdgeDensity.toFixed(2)}`} sub="คน / ตร.ม. (ค่าจำลอง)" tone={m.peakEdgeDensity > 2.2 ? "warn" : "default"} />
          <MetricCard label="T95" value={fmtTime(m.p95Arrival)} sub={`queue max ${m.maxQueue.toFixed(1)}s · avg ${m.averageQueue.toFixed(1)}s`} />
          <MetricCard label="อุณหภูมิจำลอง" value={`${m.maxModeledTemperatureC.toFixed(1)}°C`} sub={`${m.blockedThermalEdges} ปิดจากความร้อน · ${m.fireBlockedEdges} ปิดจากเปลวไฟ`} tone={m.blockedThermalEdges || m.fireBlockedEdges ? "danger" : m.maxModeledTemperatureC >= state.heatAvoidThresholdC ? "warn" : "good"} />
          <MetricCard label="การรับรู้ความเสี่ยง" value={`${m.smokeAware.toLocaleString("th-TH")} / ${m.heatAware.toLocaleString("th-TH")}`} sub={`ควัน / ความร้อน · สัมผัสจริง ${m.exposedToSmoke + m.exposedToHeat}`} tone={m.exposedToSmoke || m.exposedToHeat ? "danger" : m.smokeAware || m.heatAware ? "warn" : "good"} />
          <MetricCard label="ต้องการความช่วยเหลือ" value={m.incapacitated.toLocaleString("th-TH")} sub="สัมผัสเปลวไฟต่อเนื่อง ≥ 0.9 วินาที" tone={m.incapacitated ? "danger" : "good"} />
          <MetricCard label="ภายในอาคาร" value={m.indoorAgents.toLocaleString("th-TH")} sub={`บันได ${m.stairAgents.toLocaleString("th-TH")} · นอกตึก ${m.outdoorAgents.toLocaleString("th-TH")}`} />
        </div>
      </section>

      <aside className="sim-analysis-panel glass-panel">
        <SheetHeading title="สถานการณ์และเหตุการณ์" close={closePanel} />
        <div className="sim-analysis-title"><span>การวิเคราะห์คอขวด</span><strong>สถานะปัจจุบัน</strong></div>
        <div className="sim-bottleneck-list">
          {m.bottlenecks.length === 0 ? <div className="sim-empty">ยังไม่พบคอขวดเด่นชัด</div> : m.bottlenecks.map((item, index) => (
            <div className="sim-bottleneck-item" key={item.edgeId}>
              <div><b>#{index + 1}</b><span>{item.name}</span><strong>{item.queueSeconds.toFixed(1)}s</strong></div>
              <div className="sim-util-bar"><i style={{ width: `${Math.min(100, item.utilization * 100)}%` }} /></div>
              <small>{item.capacityPerSecond.toFixed(2)} คน/s · {item.reservedPeople} คนรอ</small>
            </div>
          ))}
        </div>

        <div className="sim-analysis-title floor-title"><span>จำนวนคนตามชั้นและพื้นที่</span><strong>{m.topologyViolations === 0 ? "ปกติ" : "ตรวจสอบ"}</strong></div>
        <div className="sim-floor-monitor">
          {Array.from({ length: 9 }, (_, i) => 9 - i).map((floor) => (
            <div className="sim-floor-row" key={floor}>
              <span>F{floor}</span>
              <div><i style={{ width: `${m.total ? Math.min(100, (m.floorPopulation[floor] / m.total) * 260) : 0}%` }} /></div>
              <strong>{(m.floorPopulation[floor] ?? 0).toLocaleString("th-TH")}</strong>
            </div>
          ))}
          <div className="sim-wing-summary"><span>Pink {m.wingPopulation.pink}</span><span>Blue {m.wingPopulation.blue}</span><span>Core {m.wingPopulation.core}</span><span>Outside {m.wingPopulation.outdoor + m.wingPopulation.assembly}</span></div>
        </div>

        <div className="sim-analysis-title event-title"><span>บันทึกเหตุการณ์</span><strong>{state.events.length}</strong></div>
        <div className="sim-event-log">
          {state.events.slice(0, 10).map((event) => <div className={`sim-event ${event.severity}`} key={event.id}><time>{fmtTime(event.time)}</time><div><strong>{event.title}</strong><span>{event.detail}</span></div></div>)}
          {!state.events.length && <div className="sim-empty">กด “เริ่มการจำลอง” เพื่อเริ่มระบบ</div>}
        </div>
      </aside>

      <nav className="sim-mobile-nav" aria-label="เมนูการจำลอง">
        {([{ id: "scene", label: "โมเดล", icon: "scene" }, { id: "controls", label: "ตั้งค่า", icon: "controls" }, { id: "metrics", label: "ผลอพยพ", icon: "metrics" }, { id: "activity", label: "เหตุการณ์", icon: "activity" }] as const).map((item) =>
          <button type="button" key={item.id} aria-pressed={mobilePanel === item.id} onClick={() => setMobilePanel(mobilePanel === item.id ? "scene" : item.id)}><UiIcon name={item.icon} /><span>{item.label}</span></button>)}
        <button type="button" className="sim-mobile-run" disabled={!isRunning && !canResume && !preflightReady} onClick={quickRun} aria-label={isRunning ? "หยุดการจำลองชั่วคราว" : canResume ? "จำลองต่อ" : "เริ่มการจำลอง"}><UiIcon name={isRunning ? "pause" : "play"} /><span>{isRunning ? "หยุด" : canResume ? "ทำต่อ" : "เริ่ม"}</span></button>
      </nav>
      <div className="sim-mobile-status"><span className={isRunning ? "is-running" : ""}>{isRunning ? "กำลังจำลอง" : canResume ? "หยุดชั่วคราว" : "พร้อมสำรวจ"}</span><strong>{m.arrived.toLocaleString("th-TH")} / {(m.total || state.populationTarget).toLocaleString("th-TH")}</strong><small>{fmtTime(m.elapsed)} · {tier === "high" ? "คมชัด" : tier === "balanced" ? "สมดุล" : "ประหยัด"}</small></div>

      <div className="sim-method-badge">
        <strong>แบบจำลองการอพยพอาคาร 9 ชั้น · พิจารณาเส้นทาง ความหนาแน่น ไฟ ควัน และความร้อน</strong>
        <span>ห้องเรียน → ประตู → ทางเดิน → บันได → ทางออก → จุดรวมพล · ตรวจความเสี่ยงและคำนวณเส้นทางใหม่ตามสถานการณ์</span>
        <small><kbd>คลิกซ้าย</kbd> กด / เลือก · <kbd>ลากขวา</kbd> หันมอง · <kbd>CTRL</kbd> ล็อกเมาส์แบบ Roblox · <kbd>WASD</kbd> เคลื่อนกล้อง · <kbd>Q/E</kbd> ขึ้น/ลง · <kbd>SHIFT</kbd> เร่ง</small>
      </div>
    </div>
  );
}
