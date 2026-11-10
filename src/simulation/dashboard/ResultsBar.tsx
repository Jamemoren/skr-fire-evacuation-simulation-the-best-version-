import { forwardRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { UiIcon } from "../../components/UiIcon";
import { useEvacuationStore } from "../simulationStore";
import type { SimulationMetrics } from "../types";
import { fmtInt, fmtTime } from "./dashboardModel";

type Tone = "neutral" | "safe" | "risk" | "danger";

function Kpi({ label, value, unit, sub, tone = "neutral", first }: { label: string; value: string; unit?: string; sub?: string; tone?: Tone; first?: boolean }) {
  return (
    <div className={`pi-kpi is-${tone}`} data-kpi={first ? "first" : undefined}>
      <span className="pi-kpi-label">{tone !== "neutral" && <i aria-hidden="true" />}{label}</span>
      <strong className="pi-kpi-value pi-num">{value}{unit && <small>{unit}</small>}</strong>
      {sub && <span className="pi-kpi-sub">{sub}</span>}
    </div>
  );
}

function KpiGroups({ m, avoidC }: { m: SimulationMetrics; avoidC: number }) {
  const exposed = m.exposedToSmoke + m.exposedToHeat;
  return (
    <div className="sw-kpi-groups" data-tour="metrics">
      <section aria-label="ความคืบหน้า">
        <h3>ความคืบหน้า</h3>
        <div className="sw-kpi-grid">
          <Kpi first label="ถึงจุดรวมพล" value={fmtInt(m.arrived)} unit="คน" sub="เข้าแถวที่จุดรวมพลแล้ว" tone="safe" />
          <Kpi label="กำลังรอคิว" value={fmtInt(m.queueing)} unit="คน" sub="รอที่ประตู/บันได" tone={m.queueing > 150 ? "risk" : "neutral"} />
          <Kpi label="ภายในอาคาร" value={fmtInt(m.indoorAgents)} unit="คน" sub={`บนบันได ${fmtInt(m.stairAgents)} · นอกอาคาร ${fmtInt(m.outdoorAgents)}`} />
          <Kpi label="ติดค้าง/ไปต่อไม่ได้" value={fmtInt(m.holding)} unit="คน" sub="ยังไม่มีทางที่ปลอดภัยตามที่รู้ — รอประเมินใหม่ (ไม่นับว่าอพยพสำเร็จ)" tone={m.holding ? "danger" : "safe"} />
        </div>
      </section>
      <WhyPanel m={m} />
      <section aria-label="เวลา">
        <h3>เวลา</h3>
        <div className="sw-kpi-grid">
          <Kpi label="เวลาคาดการณ์คนสุดท้าย" value={fmtTime(m.estimatedMakespan)} sub="เวลาสิ้นสุดโดยประมาณ" />
          <Kpi label="T95" value={fmtTime(m.p95Arrival)} sub="95% ถึงจุดรวมพล" />
          <Kpi label="คนแรก · มัธยฐาน" value={`${fmtTime(m.firstArrival)} · ${fmtTime(m.p50Arrival)}`} sub="เวลาถึงจุดรวมพล" />
          <Kpi label="เวลารอคิว" value={`${m.maxQueue.toFixed(1)}`} unit="s สูงสุด" sub={`เฉลี่ย ${m.averageQueue.toFixed(1)} s`} tone={m.maxQueue > 60 ? "risk" : "neutral"} />
        </div>
      </section>
      <section aria-label="ความเสี่ยงและความถูกต้อง">
        <h3>ความเสี่ยงและความถูกต้อง</h3>
        <div className="sw-kpi-grid">
          <Kpi label="อุณหภูมิจำลองสูงสุด" value={m.maxModeledTemperatureC.toFixed(1)} unit="°C" sub={`${m.blockedThermalEdges} ปิดจากความร้อน · ${m.fireBlockedEdges} ปิดจากเปลวไฟ`} tone={m.blockedThermalEdges || m.fireBlockedEdges ? "danger" : m.maxModeledTemperatureC >= avoidC ? "risk" : "safe"} />
          <Kpi label="รับรู้ควัน / ความร้อน" value={`${fmtInt(m.smokeAware)} / ${fmtInt(m.heatAware)}`} unit="คน" sub={`สัมผัสจริง ${fmtInt(exposed)} คน`} tone={exposed ? "danger" : m.smokeAware || m.heatAware ? "risk" : "safe"} />
          <Kpi label="ต้องการความช่วยเหลือ" value={fmtInt(m.incapacitated)} unit="คน" sub="สัมผัสเปลวไฟต่อเนื่อง ≥ 0.9 วินาที" tone={m.incapacitated ? "danger" : "safe"} />
          <Kpi label="ความหนาแน่นสูงสุด" value={m.peakEdgeDensity.toFixed(2)} unit="คน/ตร.ม." sub="ค่าจำลองบนช่วงทางเดิน" tone={m.peakEdgeDensity > 2.2 ? "risk" : "neutral"} />
          {m.competitiveness > 0 && (
            <>
              <Kpi label="อัดแน่นหน้าทางออก" value={m.peakMouthDensity.toFixed(1)} unit="คน/ตร.ม." sub={`≥ 6 คน/ตร.ม. รวมทุกช่องทาง ${Math.round(m.dangerousCrowdSeconds)} ช่องทาง·วินาที`} tone={m.dangerousCrowdSeconds > 0 ? "danger" : m.peakMouthDensity >= 4 ? "risk" : "neutral"} />
              <Kpi label="ช่องทางติดขัด" value={fmtInt(m.clogEvents)} unit="ครั้ง" sub={`รวม ${Math.round(m.cloggedSeconds)} วินาทีที่ไม่มีใครผ่านได้`} tone={m.clogEvents ? "risk" : "neutral"} />
            </>
          )}
          <Kpi label="คำนวณเส้นทางใหม่" value={fmtInt(m.rerouteCount)} unit="ครั้ง" sub={`จากความร้อน ${fmtInt(m.thermalRerouteCount)} ครั้ง`} />
          <Kpi label="ตรวจขอบเขตการเดิน" value={m.topologyViolations === 0 && m.collisionCorrections === 0 ? "ผ่าน" : fmtInt(m.collisionCorrections)} sub="ไม่เดินทะลุกำแพง" tone={m.topologyViolations === 0 ? "safe" : "danger"} />
        </div>
      </section>
    </div>
  );
}

function ReasonList({ title, empty, items }: { title: string; empty: string; items: Array<{ key: string; label: string; value: string }> }) {
  return (
    <div className="sw-why-list">
      <h4>{title}</h4>
      {items.length ? (
        <ul>{items.map((item) => <li key={item.key}><span>{item.label}</span><strong className="pi-num">{item.value}</strong></li>)}</ul>
      ) : <p>{empty}</p>}
    </div>
  );
}

/** Why people are not out yet: stuck reasons, the slowest passages, and why routes changed. */
function WhyPanel({ m }: { m: SimulationMetrics }) {
  return (
    <section aria-label="สาเหตุและคอขวด">
      <h3>ทำไมยังไม่ถึง · คอขวด · เหตุผลที่เปลี่ยนทาง</h3>
      <div className="sw-why-grid">
        <ReasonList title={`ติดค้าง ${fmtInt(m.holding)} คน`} empty="ไม่มีคนติดค้างตอนนี้"
          items={m.stuckReasons.map((r) => ({ key: r.code, label: r.label, value: `${fmtInt(r.count)} คน` }))} />
        <ReasonList title="คอขวด (รอนานสุด)" empty="ยังไม่มีจุดที่ต้องรอ"
          items={m.bottlenecks.slice(0, 3).map((b) => ({ key: b.edgeId, label: b.name, value: `${b.queueSeconds.toFixed(0)} s · ${fmtInt(b.reservedPeople)} คน` }))} />
        <ReasonList title={`เปลี่ยนเส้นทาง ${fmtInt(m.rerouteCount)} ครั้ง`} empty="ยังไม่มีใครเปลี่ยนเส้นทาง"
          items={m.rerouteReasons.map((r) => ({ key: r.code, label: r.label, value: `${fmtInt(r.count)}` }))} />
      </div>
    </section>
  );
}

interface ResultsBarProps {
  expanded: boolean;
  onToggle: () => void;
  onClose: () => void;
}

export const ResultsBar = forwardRef<HTMLElement, ResultsBarProps>(function ResultsBar({ expanded, onToggle, onClose }, ref) {
  const { m, status, population, avoidC } = useEvacuationStore(useShallow((s) => ({ m: s.metrics, status: s.status, population: s.populationTarget, avoidC: s.heatAvoidThresholdC })));
  const total = m.total || population;
  const pct = Math.round(m.progress * 100);
  const abnormal = m.holding + m.incapacitated;
  const stateLine = status === "idle"
    ? "พร้อมเริ่ม — กดปุ่ม “เริ่มการจำลอง” เพื่อเริ่มรอบใหม่"
    : status === "completed"
      ? `จำลองเสร็จสิ้น · คนสุดท้ายถึงที่ ${fmtTime(m.finalArrival)}${m.incapacitated ? ` · ต้องช่วยเหลือ ${fmtInt(m.incapacitated)} คน (ไม่นับว่าอพยพสำเร็จ)` : ""}`
      : abnormal > 0 && m.arrived + abnormal >= total
        ? `ยังไม่เสร็จ: ถึงจุดรวมพล ${fmtInt(m.arrived)} คน · ติดค้าง ${fmtInt(m.holding)} · ต้องช่วยเหลือ ${fmtInt(m.incapacitated)} — ไม่มีการนับคนที่ติดว่าอพยพสำเร็จ`
      : status === "paused" ? "หยุดชั่วคราว — ค่าทั้งหมดคงไว้ตามเวลาจำลอง" : "กำลังจำลอง — ค่าอัปเดตตามเวลาจริงของแบบจำลอง";
  return (
    <section ref={ref} className={`sw-results${expanded ? " is-expanded" : ""} is-${status}`} aria-label="ผลการอพยพ" data-guide-target="results" tabIndex={-1} data-sheet="metrics" data-camera-inset="bottom">
      <div className="sw-results-bar">
        <div className="sw-progress">
          <div className="sw-progress-label">
            <span>อพยพถึงจุดรวมพล</span>
            <strong className="pi-num">{pct}%</strong>
            <small className="pi-num">{fmtInt(m.arrived)} / {fmtInt(total)} คน</small>
          </div>
          <div className="pi-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="ความคืบหน้าการอพยพ"><i style={{ transform: `scaleX(${m.progress})` }} /></div>
        </div>
        <dl className="sw-summary">
          <div className={m.queueing > 150 ? "is-risk" : undefined}><dt>รอคิว</dt><dd className="pi-num">{fmtInt(m.queueing)}</dd></div>
          <div className={m.bottlenecks.length ? "is-risk" : undefined}><dt>คอขวด</dt><dd className="pi-num">{m.bottlenecks.length}</dd></div>
          <div><dt>{status === "completed" ? "คนสุดท้าย" : "คาดการณ์จบ"}</dt><dd className="pi-num">{fmtTime(status === "completed" ? m.finalArrival : m.estimatedMakespan)}</dd></div>
          {m.holding > 0 && <div className="is-danger" title={m.stuckReasons[0]?.label}><dt>ติดค้าง</dt><dd className="pi-num">{fmtInt(m.holding)}</dd></div>}
          {m.incapacitated > 0 && <div className="is-danger"><dt>ต้องช่วยเหลือ</dt><dd className="pi-num">{fmtInt(m.incapacitated)}</dd></div>}
        </dl>
        <button type="button" className="pi-btn is-quiet-dark sw-results-toggle" data-tour="results-detail" aria-expanded={expanded} aria-controls="sw-results-detail" onClick={onToggle}>
          <span>{expanded ? "ซ่อนรายละเอียด" : "รายละเอียด"}</span><UiIcon name={expanded ? "chevronDown" : "chevronUp"} size={18} />
        </button>
        <button type="button" className="pi-icon-btn is-on-dark sw-sheet-close" aria-label="ปิดแผง กลับไปดูโมเดล" onClick={onClose}><UiIcon name="close" /></button>
      </div>
      <div id="sw-results-detail" className="sw-results-detail" inert={!expanded || undefined}>
        <p className="sw-results-state" role="status"><UiIcon name={status === "completed" ? "check" : status === "running" ? "activity" : "info"} size={16} />{stateLine}</p>
        <KpiGroups m={m} avoidC={avoidC} />
      </div>
    </section>
  );
});
