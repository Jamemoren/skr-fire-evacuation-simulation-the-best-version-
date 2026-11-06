import { forwardRef, useEffect, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { TARGET_POPULATION } from "../../building1/building1Data";
import { useBuilding1Store } from "../../building1/building1Store";
import { UiIcon, type UiIconName } from "../../components/UiIcon";
import { QualityControls } from "../../rendering/QualityControls";
import { useMapperStore } from "../../store";
import { useEvacuationStore } from "../simulationStore";
import { evacuationRuntime } from "../runtime";
import type { OperationalReadinessReport } from "../operationalReadiness";
import { fmtInt, STATUS_LABEL, type ControlTab, type StartBlock } from "./dashboardModel";
import { repairSimulationWorkspace } from "../../utils/projectFiles";
import { loadSimulationBackup, type ProjectBackup } from "../../utils/idb";
import { downloadBlob } from "../../utils/download";

const TABS: Array<{ id: ControlTab; label: string; icon: UiIconName }> = [
  { id: "scenario", label: "สถานการณ์", icon: "fire" },
  { id: "behavior", label: "พฤติกรรม", icon: "users" },
  { id: "display", label: "แสดงผล", icon: "eye" },
];

function ReadinessCard({ readiness, startBlock, onOpenEditor }: { readiness: OperationalReadinessReport | null; startBlock: StartBlock; onOpenEditor: () => void }) {
  const projectBusy = useMapperStore((state) => state.projectBusy);
  const [repairing, setRepairing] = useState(false);
  const [backup, setBackup] = useState<ProjectBackup | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void loadSimulationBackup().then((saved) => { if (active) setBackup(saved); }).catch(() => { /* Repair reports storage errors before changing the map. */ });
    return () => { active = false; };
  }, []);
  const repair = async () => {
    setRepairing(true);
    setError("");
    try {
      const saved = await repairSimulationWorkspace();
      setBackup(saved);
      downloadBlob(saved.name, saved.blob);
      useMapperStore.getState().addToast("success", "สำรองผังเดิมแล้ว · ใช้ผังมาตรฐานพร้อมจำลอง");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "คืนค่าผังไม่สำเร็จ ผังเดิมยังอยู่");
    } finally { setRepairing(false); }
  };
  const tone = !readiness && startBlock?.kind !== "custom" ? "checking" : startBlock ? "risk" : "safe";
  return (
    <section id="sw-readiness" className={`sw-readiness is-${tone}`} aria-live="polite" tabIndex={-1} aria-label="ความพร้อมก่อนเริ่มการจำลอง">
      <div className="sw-readiness-head">
        <span className="sw-readiness-icon" aria-hidden="true"><UiIcon name={tone === "safe" ? "check" : tone === "risk" ? "alert" : "clock"} size={16} /></span>
        <div>
          <strong>{tone === "safe" ? "พร้อมเริ่มการจำลอง" : tone === "checking" ? "กำลังตรวจความพร้อม…" : "ยังเริ่มการจำลองไม่ได้"}</strong>
          <small>{tone === "safe" ? "โครงข่ายอพยพ ประตู บันได และความจุผ่านการตรวจในเครื่องนี้" : tone === "checking" ? "ตรวจผังอาคาร ประตู บันได และเส้นทางทั้งหมด" : startBlock?.kind === "custom" ? "ผังที่บันทึกไว้ต่างจากโครงข่ายที่ระบบจำลองรองรับ" : "แก้ตามขั้นตอนด้านล่าง แล้วปุ่มเริ่มจะใช้งานได้"}</small>
        </div>
        {readiness && startBlock?.kind !== "custom" && <b className="pi-num">{readiness.passed}/{readiness.total}</b>}
      </div>
      {startBlock?.kind === "custom" && (
        <>
          <ol className="sw-fix-list">{startBlock.issues.map((issue) => <li key={issue}>{issue}</li>)}</ol>
          <p className="sw-repair-help">ระบบจะบันทึกผังเดิมเป็นไฟล์ .skrproject พร้อม node/edge และ Calibration ก่อนใช้ผังมาตรฐาน คุณสามารถนำไฟล์สำรองกลับมาแก้ไขต่อได้</p>
          <div className="sw-repair-actions">
            <button type="button" className="pi-btn is-primary is-sm" disabled={repairing || projectBusy} onClick={() => void repair()}>{repairing ? "กำลังสำรองและเตรียมผัง…" : "สำรองผังเดิมและใช้ผังมาตรฐาน"}</button>
            <button type="button" className="pi-btn is-secondary is-sm" disabled={repairing || projectBusy} onClick={onOpenEditor}><UiIcon name="pencil" size={16} />แก้ไขผังเดิม</button>
          </div>
        </>
      )}
      {startBlock?.kind === "failed" && (
        <ol className="sw-fix-list">
          {startBlock.report.checks.filter((check) => !check.passed).map((check) => <li key={check.id}><strong>{check.label}</strong> — {check.detail}</li>)}
        </ol>
      )}
      {error && <p className="sw-repair-error" role="alert">{error}</p>}
      {backup && <button type="button" className="pi-btn is-secondary is-sm sw-backup-download" onClick={() => downloadBlob(backup.name, backup.blob)}>ดาวน์โหลดผังเดิมที่สำรองล่าสุด</button>}
    </section>
  );
}

function OptionCards<T extends string>({ value, options, onChange, disabled, label, tourId }: {
  value: T;
  options: Array<{ id: T; title: string; detail: string; tone?: "risk" }>;
  onChange: (value: T) => void;
  disabled: boolean;
  label: string;
  tourId?: { option: T; id: string };
}) {
  return (
    <div className="pi-options" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={disabled}
          className={`pi-option${value === option.id ? " is-active" : ""}${option.tone === "risk" ? " is-risk" : ""}`}
          data-tour={tourId?.option === option.id ? tourId.id : undefined}
          onClick={() => onChange(option.id)}
        >
          <i aria-hidden="true" />
          <strong>{option.title}</strong>
          <span>{option.detail}</span>
        </button>
      ))}
    </div>
  );
}

function ScenarioTab({ locked, onPlaceFire }: { locked: boolean; onPlaceFire: () => void }) {
  const s = useEvacuationStore(useShallow((st) => ({
    population: st.populationTarget, preset: st.preset, placeFireMode: st.placeFireMode, spread: st.fireSpreadEnabled, fires: st.fires, elapsed: st.metrics.elapsed,
    closed: st.closedPassages,
    setPopulation: st.setPopulationTarget, setPreset: st.setPreset, setPlaceFireMode: st.setPlaceFireMode, addPresetFire: st.addPresetFire, clearFires: st.clearFires, setSpread: st.setFireSpreadEnabled,
    setPassageClosed: st.setPassageClosed,
  })));
  const passages = evacuationRuntime.passageGroups();
  const primary = s.fires.filter((fire) => fire.origin !== "spread").length;
  const burning = s.fires.filter((fire) => fire.origin === "spread" && fire.startTime <= s.elapsed).length;
  const travelling = s.fires.filter((fire) => fire.origin === "spread" && fire.startTime > s.elapsed).length;
  const fill = ((s.population - 40) / (TARGET_POPULATION - 40)) * 100;
  return (
    <>
      <section className="sw-section" data-guide-target="setup" tabIndex={-1} aria-labelledby="sw-sec-pop">
        <header className="sw-section-head">
          <h3 id="sw-sec-pop"><span className="sw-step">01</span>ประชากรจำลอง</h3>
          <output htmlFor="sw-population" className="pi-value"><span className="pi-num">{fmtInt(s.population)}</span> คน</output>
        </header>
        <div className="pi-seg" role="radiogroup" aria-label="ชุดประชากรสำเร็จรูป">
          <button type="button" role="radio" aria-checked={s.population === TARGET_POPULATION} disabled={locked} className={s.population === TARGET_POPULATION ? "is-active" : ""} onClick={() => s.setPopulation(TARGET_POPULATION)}>จำลองเต็ม 3,000</button>
          <button type="button" role="radio" aria-checked={s.population === 1500} data-tour="population" disabled={locked} className={s.population === 1500 ? "is-active" : ""} onClick={() => s.setPopulation(1500)}>ทดสอบ 1,500</button>
        </div>
        <input id="sw-population" className="pi-range" type="range" aria-label="จำนวนคนจำลอง" style={{ "--fill": `${fill}%` } as CSSProperties} disabled={locked} min="40" max={TARGET_POPULATION} step="20" value={s.population} onChange={(e) => s.setPopulation(Number(e.target.value))} />
        <div className="pi-range-scale" aria-hidden="true"><span>40</span><span>3,000 คน</span></div>
        <p className="pi-help">กระจายประชากร 144 ห้องในอาคาร 1, 3 และ 4 · ใช้บันได ทางเชื่อมชั้น 4 และจุดรวมพล 2 พื้นที่</p>
      </section>

      <section className="sw-section" aria-labelledby="sw-sec-route">
        <header className="sw-section-head"><h3 id="sw-sec-route"><span className="sw-step">02</span>แนวทางเลือกเส้นทาง</h3></header>
        <OptionCards
          label="แนวทางเลือกเส้นทาง"
          value={s.preset}
          disabled={locked}
          onChange={s.setPreset}
          tourId={{ option: "balanced", id: "strategy" }}
          options={[
            { id: "fastest", title: "เร็วที่สุด", detail: "ลดเวลาอพยพโดยรวม" },
            { id: "balanced", title: "สมดุล", detail: "เวลา + คิว + ความเสี่ยง" },
            { id: "safest", title: "ปลอดภัยที่สุด", detail: "ให้น้ำหนักการหลบไฟและควัน" },
          ]}
        />
        <details className="pi-disclosure">
          <summary>ดูลำดับเส้นทางอพยพ</summary>
          <figure className="sw-route-figure">
            <img src="/assets/evacuation-physical-route.png" alt="ภาพลำดับการอพยพจากห้องเรียน ผ่านประตูและบันไดที่มีช่องพื้นจริง ไปยังสนามรวมพล" loading="lazy" />
            <figcaption>ห้องเรียน → ประตู → ช่องบันได → สนามรวมพล</figcaption>
          </figure>
        </details>
      </section>

      <section className="sw-section" aria-labelledby="sw-sec-fire">
        <header className="sw-section-head">
          <h3 id="sw-sec-fire"><span className="sw-step">03</span>ไฟและควัน</h3>
          <span className={`pi-chip ${primary ? "is-risk" : "is-neutral"}`}><UiIcon name="fire" size={14} />{primary} ต้นเพลิง{burning ? ` · ${burning} ลุกลาม` : ""}{travelling ? ` · ${travelling} กำลังลาม` : ""}</span>
        </header>
        <button type="button" className={`pi-btn is-block ${s.placeFireMode ? "is-risk" : "is-secondary"}`} aria-pressed={s.placeFireMode} onClick={() => { s.setPlaceFireMode(!s.placeFireMode); if (!s.placeFireMode) onPlaceFire(); }}>
          <UiIcon name={s.placeFireMode ? "target" : "plus"} size={18} />{s.placeFireMode ? "คลิกบนโมเดลเพื่อวางจุดไฟ… (กดอีกครั้งเพื่อยกเลิก)" : "วางจุดไฟบนโมเดล"}
        </button>
        <div className="pi-chip-row" role="group" aria-label="ตำแหน่งไฟสำเร็จรูป">
          <button type="button" className="pi-btn is-sm is-ghost" data-tour="fire" onClick={() => s.addPresetFire("left")}>ปีกซ้าย</button>
          <button type="button" className="pi-btn is-sm is-ghost" onClick={() => s.addPresetFire("center")}>แกนกลาง</button>
          <button type="button" className="pi-btn is-sm is-ghost" onClick={() => s.addPresetFire("right")}>ปีกขวา</button>
          <button type="button" className="pi-btn is-sm is-ghost is-danger-text" disabled={!s.fires.length} onClick={s.clearFires}><UiIcon name="trash" size={16} />ล้างไฟ</button>
        </div>
        <label className="pi-switch">
          <input type="checkbox" disabled={locked} checked={s.spread} onChange={(e) => s.setSpread(e.target.checked)} />
          <span className="pi-switch-track" aria-hidden="true" />
          <span className="pi-switch-text"><strong>ไฟลามตามโครงสร้างที่เชื่อมต่อ</strong><small>ห้อง → ประตู → ทางเดิน → บันได · ไม่ลามทะลุผนัง</small></span>
        </label>
        <p className="pi-help">{primary ? `บันทึกตำแหน่งไฟ ${primary} จุดอัตโนมัติ · เปิดเว็บครั้งถัดไปใช้ต่อได้` : "วางไฟแล้วระบบจะจำตำแหน่งให้อัตโนมัติ"} · NPC เดินอ้อมเมื่อไฟทับเส้นทาง หากปิดทั้งทางจะหาทางอื่น</p>
      </section>

      <section className="sw-section" aria-labelledby="sw-sec-closed">
        <header className="sw-section-head">
          <h3 id="sw-sec-closed"><span className="sw-step">04</span>ทางที่ถูกปิด</h3>
          <span className={`pi-chip ${s.closed.length ? "is-risk" : "is-neutral"}`}><UiIcon name="lock" size={14} />{s.closed.length ? `ปิด ${s.closed.length}` : "เปิดทั้งหมด"}</span>
        </header>
        <details className="pi-disclosure" open={s.closed.length > 0 || undefined}>
          <summary>เลือกบันได ทางออก หรือทางเชื่อมที่ใช้ไม่ได้</summary>
          <div className="pi-check-grid sw-closures" role="group" aria-label="ทางที่ถูกปิด">
            {passages.map((group) => (
              <label key={group.id} className="pi-check">
                <input type="checkbox" checked={s.closed.includes(group.id)} onChange={(e) => s.setPassageClosed(group.id, e.target.checked)} />
                <span>{group.label}</span>
              </label>
            ))}
          </div>
          <p className="pi-help">เปลี่ยนได้ระหว่างจำลอง · คนจะรู้ว่าทางปิดเมื่อเดินไปเห็นหรือมีคนในบริเวณเดียวกันบอก และจะกลับมาใช้เมื่อเห็นว่าเปิดแล้ว</p>
        </details>
      </section>
    </>
  );
}

function SurvivalIntelligence() {
  const { smoke, heat, reroutes, running } = useEvacuationStore(useShallow((s) => ({ smoke: s.metrics.smokeAware, heat: s.metrics.heatAware, reroutes: s.metrics.rerouteCount, running: s.status === "running" })));
  const steps: Array<[string, string]> = [["ตรวจจับ", "ควัน · ความร้อน · คำเตือน"], ["ประเมิน", "แนวลาม · เวลา · คิว"], ["เลือกเส้นทาง", "เทียบเวลาและความเสี่ยง"], ["ปฏิบัติ", "หนี · หันกลับ · ก้มต่ำ"]];
  return (
    <div className={`sw-pipeline${running ? " is-live" : ""}`} aria-label="กระบวนการประเมินความเสี่ยงและเลือกเส้นทาง">
      <div className="sw-pipeline-head"><strong>การตัดสินใจของนักเรียนจำลอง</strong><span className={`pi-chip ${running ? "is-safe" : "is-neutral"}`}>{running ? "กำลังทำงาน" : "พร้อมใช้งาน"}</span></div>
      <ol>{steps.map(([title, detail], i) => <li key={title}><b className="pi-num">{String(i + 1).padStart(2, "0")}</b><strong>{title}</strong><small>{detail}</small></li>)}</ol>
      <dl className="sw-pipeline-live">
        <div><dt>รับรู้ควัน</dt><dd className="pi-num">{fmtInt(smoke)}</dd></div>
        <div><dt>รับรู้ความร้อน</dt><dd className="pi-num">{fmtInt(heat)}</dd></div>
        <div><dt>เปลี่ยนเส้นทาง</dt><dd className="pi-num">{fmtInt(reroutes)}</dd></div>
      </dl>
    </div>
  );
}

function BehaviorTab({ locked }: { locked: boolean }) {
  const s = useEvacuationStore(useShallow((st) => ({
    crowd: st.crowdBehavior, walkingSpeed: st.walkingSpeed, reroute: st.rerouteInterval, avoid: st.heatAvoidThresholdC, block: st.hardBlockTemperatureC, look: st.thermalLookAheadEdges, weight: st.thermalWeight, maxTemp: st.metrics.maxModeledTemperatureC,
    mode: st.decisionMode, seed: st.seed,
    setCrowd: st.setCrowdBehavior, setWalkingSpeed: st.setWalkingSpeed, setReroute: st.setRerouteInterval, setThermal: st.setThermalModel, setMode: st.setDecisionMode, setSeed: st.setSeed,
  })));
  return (
    <>
      <section className="sw-section" aria-labelledby="sw-sec-mode">
        <header className="sw-section-head"><h3 id="sw-sec-mode">ใครตัดสินใจเส้นทาง</h3></header>
        <OptionCards
          label="ข้อมูลที่ใช้เลือกเส้นทาง"
          value={s.mode}
          disabled={locked}
          onChange={s.setMode}
          options={[
            { id: "occupant", title: "ผู้ใช้อาคารตัดสินใจเอง", detail: "รู้เฉพาะสิ่งที่เห็น ได้กลิ่น หรือได้รับแจ้ง" },
            { id: "coordinated", title: "ผู้ควบคุมสั่งการ", detail: "จัดสรรเส้นทางจากข้อมูลทั้งอาคาร" },
          ]}
        />
        <p className="pi-help">{s.mode === "occupant"
          ? "แต่ละคนเลือกบันไดที่คุ้นเคย เห็นคิวเฉพาะในระยะสายตา รู้เรื่องไฟเมื่อเห็น/ได้กลิ่น/มีคนบอก และเปลี่ยนทางเมื่อได้ประโยชน์ชัดเจนเท่านั้น"
          : "โหมดเปรียบเทียบ: ผู้ควบคุมรู้คิวทุกจุด ทางที่ปิดทุกจุด และตำแหน่งไฟหลังตรวจพบ 20 วินาที แล้วสั่งเส้นทางให้ทุกคน"}</p>
      </section>

      <section className="sw-section" aria-labelledby="sw-sec-crowd">
        <header className="sw-section-head"><h3 id="sw-sec-crowd">พฤติกรรมฝูงชน</h3></header>
        <OptionCards
          label="พฤติกรรมฝูงชน"
          value={s.crowd}
          disabled={locked}
          onChange={s.setCrowd}
          options={[
            { id: "orderly", title: "ซ้อมเป็นระเบียบ", detail: "ต่อแถวทีละคน" },
            { id: "grouped", title: "แข่งขัน", detail: "แทรกช่องว่างหน้าทางออก" },
            { id: "surge", title: "แข่งขันสูง", detail: "เบียดแย่งหนาแน่นสูง", tone: "risk" },
          ]}
        />
        <p className="pi-help">{s.crowd === "orderly"
          ? "การซ้อมที่ครูคุมแถว: ทยอยเข้าประตูและบันไดตามลำดับที่มาถึง ไม่มีใครแซง"
          : s.crowd === "grouped"
            ? "สมมติสถานการณ์ที่คนแข่งขันเข้าช่องว่างหน้าประตูและบันได ตำแหน่ง ความเร่งรีบ และช่องว่างมีผลต่อการผ่าน อาจเกิดการอัดติดชั่วคราว พฤติกรรมนี้ไม่ได้เกิดกับทุกคนในทุกเหตุการณ์"
            : "สมมติการแข่งขันและความหนาแน่นสูง เพื่อศึกษาการติดขัดและความเสี่ยงจากการเบียด เป็นแบบจำลองที่ต้องปรับเทียบกับข้อมูลจริง"}</p>
      </section>

      <section className="sw-section" aria-labelledby="sw-sec-move">
        <header className="sw-section-head"><h3 id="sw-sec-move">การเคลื่อนที่</h3></header>
        <div className="pi-field-grid">
          <label className="pi-field">
            <span>ความเร็วการเดิน <em>ม./วินาที · ปรับระหว่างจำลองได้</em></span>
            <input type="number" min="0.01" step="0.1" value={s.walkingSpeed} onChange={(e) => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value)) s.setWalkingSpeed(value); }} />
          </label>
          <label className="pi-field">
            <span>รอบคำนวณเส้นทางใหม่ <em>วินาที</em></span>
            <input disabled={locked} type="number" min="0.5" max="10" step="0.5" value={s.reroute} onChange={(e) => s.setReroute(Number(e.target.value))} />
          </label>
          <label className="pi-field">
            <span>Seed ลักษณะบุคคล <em>ค่าเดิม = ผลเดิม</em></span>
            <input disabled={locked} type="number" min="0" step="1" value={s.seed} onChange={(e) => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value)) s.setSeed(value); }} />
          </label>
        </div>
      </section>

      <details className="pi-disclosure sw-section">
        <summary>ค่าขั้นสูง · แบบจำลองความร้อนเชิงประมาณ <span className="pi-chip is-neutral pi-num">สูงสุด {s.maxTemp.toFixed(1)}°C</span></summary>
        <div className="pi-field-grid">
          <label className="pi-field"><span>เริ่มหลีกเลี่ยง <em>°C</em></span><input disabled={locked} type="number" min="30" max="120" step="1" value={s.avoid} onChange={(e) => s.setThermal({ heatAvoidThresholdC: Number(e.target.value) })} /></label>
          <label className="pi-field"><span>ห้ามผ่าน <em>°C</em></span><input disabled={locked} type="number" min="31" max="200" step="1" value={s.block} onChange={(e) => s.setThermal({ hardBlockTemperatureC: Number(e.target.value) })} /></label>
          <label className="pi-field"><span>ช่วงเส้นทางที่ตรวจล่วงหน้า <em>ช่วง</em></span><input disabled={locked} type="number" min="4" max="20" step="1" value={s.look} onChange={(e) => s.setThermal({ thermalLookAheadEdges: Number(e.target.value) })} /></label>
          <label className="pi-field"><span>น้ำหนักความร้อนในการเลือกเส้นทาง</span><input disabled={locked} type="number" min="0" max="20000" step="100" value={s.weight} onChange={(e) => s.setThermal({ thermalWeight: Number(e.target.value) })} /></label>
        </div>
        <p className="pi-help">ค่าอุณหภูมิมาจาก heat field เชิงประมาณ ไม่ใช่ CFD/FDS และไม่ควรใช้แทนแบบจำลองวิศวกรรมอัคคีภัยที่สอบเทียบแล้ว</p>
      </details>

      <section className="sw-section" aria-label="กระบวนการตัดสินใจ"><SurvivalIntelligence /></section>
    </>
  );
}

function DisplayTab() {
  const s = useEvacuationStore(useShallow((st) => ({
    agents: st.showAgents, fire: st.showFire, routes: st.showRoutes, smoke: st.showSmoke, heat: st.showHeatZones,
    setAgents: st.setShowAgents, setFire: st.setShowFire, setRoutes: st.setShowRoutes, setSmoke: st.setShowSmoke, setHeat: st.setShowHeatZones,
  })));
  const b = useBuilding1Store(useShallow((st) => ({
    zones: st.showAssemblyZones, track: st.showTrackLanes, rooms: st.showRoomVolumes,
    setZones: st.setShowAssemblyZones, setTrack: st.setShowTrackLanes, setRooms: st.setShowRoomVolumes,
  })));
  const grid = useMapperStore((st) => st.showGrid);
  const setGrid = useMapperStore((st) => st.setShowGrid);
  const toggles: Array<[string, boolean, (value: boolean) => void]> = [
    ["นักเรียนจำลอง", s.agents, s.setAgents], ["เปลวไฟ", s.fire, s.setFire], ["ควัน", s.smoke, s.setSmoke],
    ["เส้นทางที่คำนวณ", s.routes, s.setRoutes], ["ขอบเขตความเสี่ยง", s.heat, s.setHeat], ["จุดรวมพล A–F", b.zones, b.setZones],
    ["ลู่วิ่ง", b.track, b.setTrack], ["ขอบเขตห้อง", b.rooms, b.setRooms], ["Grid อ้างอิง", grid, setGrid],
  ];
  return (
    <>
      <section className="sw-section" aria-labelledby="sw-sec-layers">
        <header className="sw-section-head"><h3 id="sw-sec-layers">ชั้นข้อมูลในฉาก</h3></header>
        <div className="pi-check-grid">
          {toggles.map(([label, checked, set]) => (
            <label key={label} className="pi-check"><input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} /><span>{label}</span></label>
          ))}
        </div>
      </section>
      <section className="sw-section" aria-label="คุณภาพภาพ"><QualityControls /></section>
    </>
  );
}

interface ControlPanelProps {
  open: boolean;
  tab: ControlTab;
  onTab: (tab: ControlTab) => void;
  onToggle: () => void;
  onClose: () => void;
  readiness: OperationalReadinessReport | null;
  startBlock: StartBlock;
  onStartTutorial: () => void;
  onPlaceFire: () => void;
}

export const ControlPanel = forwardRef<HTMLElement, ControlPanelProps>(function ControlPanel(
  { open, tab, onTab, onToggle, onClose, readiness, startBlock, onStartTutorial, onPlaceFire },
  ref,
) {
  const status = useEvacuationStore((s) => s.status);
  const setWorkMode = useEvacuationStore((s) => s.setWorkMode);
  const locked = status === "running" || status === "paused";
  return (
    <aside ref={ref} className={`sw-panel sw-panel-left${open ? " is-open" : " is-collapsed"}`} aria-label="ตั้งค่าการจำลอง" data-sheet="controls">
      <div className="sw-rail" aria-hidden={open}>
        <button type="button" className="pi-icon-btn" tabIndex={open ? -1 : 0} aria-label="เปิดแผงตั้งค่า" data-tip="เปิดแผงตั้งค่า" data-tip-side="right" onClick={onToggle}><UiIcon name="panelLeft" /></button>
        {TABS.map((item) => (
          <button key={item.id} type="button" className="pi-icon-btn" tabIndex={open ? -1 : 0} aria-label={`ตั้งค่า: ${item.label}`} data-tip={item.label} data-tip-side="right" onClick={() => { onTab(item.id); onToggle(); }}><UiIcon name={item.icon} /></button>
        ))}
      </div>
      <div className="sw-panel-body" inert={!open || undefined}>
        <header className="sw-panel-head">
          <div><span className="pi-overline">ตั้งค่ารอบจำลอง · {STATUS_LABEL[status]}</span><h2>วางแผนการอพยพ</h2></div>
          <button type="button" className="pi-icon-btn sw-collapse" aria-label="ย่อแผงตั้งค่า" data-tip="ย่อแผง" onClick={onToggle}><UiIcon name="chevronLeft" /></button>
          <button type="button" className="pi-icon-btn sw-sheet-close" aria-label="ปิดแผง กลับไปดูโมเดล" onClick={onClose}><UiIcon name="close" /></button>
        </header>
        <ReadinessCard readiness={readiness} startBlock={startBlock} onOpenEditor={() => setWorkMode("editor")} />
        {locked && <p className="sw-lock-note"><UiIcon name="lock" size={16} />ค่าสถานการณ์ถูกล็อกระหว่างจำลอง กด “รีเซ็ต” เพื่อแก้ไข</p>}
        <div className="pi-tabs" role="tablist" aria-label="หมวดการตั้งค่า">
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" id={`sw-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="sw-tabpanel" tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? "is-active" : ""}
              onClick={() => onTab(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                const index = TABS.findIndex((t) => t.id === tab);
                const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                onTab(next.id);
                requestAnimationFrame(() => document.getElementById(`sw-tab-${next.id}`)?.focus());
              }}>
              <UiIcon name={item.icon} size={16} />{item.label}
            </button>
          ))}
        </div>
        <div id="sw-tabpanel" className="sw-panel-scroll" role="tabpanel" aria-labelledby={`sw-tab-${tab}`} tabIndex={0}>
          {tab === "scenario" && <ScenarioTab locked={locked} onPlaceFire={onPlaceFire} />}
          {tab === "behavior" && <BehaviorTab locked={locked} />}
          {tab === "display" && <DisplayTab />}
          <button type="button" className="sw-tour-link" onClick={onStartTutorial}><UiIcon name="play" size={16} /><span>เริ่มบทเรียนชี้จุด<small>ลองใช้ปุ่มจริงทีละขั้น</small></span><UiIcon name="chevronRight" size={16} /></button>
        </div>
      </div>
    </aside>
  );
});
