import { forwardRef, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { UiIcon, type UiIconName } from "../../components/UiIcon";
import { useEvacuationStore } from "../simulationStore";
import { evacuationRuntime } from "../runtime";
import { fmtInt, fmtTime, type MonitorTab } from "./dashboardModel";
import { useBuilding1Store } from "../../building1/building1Store";
import { useBuilding3Store } from "../../building1/building3Store";
import { useMapperStore } from "../../store";
import { yOffsetForRender } from "../studentVisibility";

const TABS: Array<{ id: MonitorTab; label: string; icon: UiIconName }> = [
  { id: "bottlenecks", label: "คอขวด", icon: "alert" },
  { id: "floors", label: "รายชั้น", icon: "layers" },
  { id: "events", label: "เหตุการณ์", icon: "activity" },
  { id: "reasons", label: "เหตุผล", icon: "search" },
];

function Bottlenecks() {
  const items = useEvacuationStore((s) => s.metrics.bottlenecks);
  if (!items.length) return <div className="pi-empty"><UiIcon name="check" /><strong>ยังไม่พบคอขวดเด่นชัด</strong><span>ระบบจะจัดอันดับจุดที่มีคิวสะสมเมื่อเริ่มจำลอง</span></div>;
  return (
    <ol className="sw-bottlenecks">
      {items.map((item, index) => {
        const utilization = Math.min(1, item.utilization);
        const tone = utilization >= 0.9 ? "danger" : utilization >= 0.6 ? "risk" : "safe";
        return (
          <li key={item.edgeId} className={`is-${tone}`}>
            <div className="sw-bn-row"><b className="pi-num">#{index + 1}</b><strong>{item.name}</strong><span className="pi-num" aria-label={`เวลารอคิว ${item.queueSeconds.toFixed(1)} วินาที`}>{item.queueSeconds.toFixed(1)} s</span></div>
            <div className="pi-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(utilization * 100)} aria-label="อัตราการใช้ความจุ"><i style={{ width: `${utilization * 100}%` }} /></div>
            <small className="pi-num">ใช้ความจุ {Math.round(item.utilization * 100)}% · {item.capacityPerSecond.toFixed(2)} คน/วินาที · {fmtInt(item.reservedPeople)} คนรอ</small>
          </li>
        );
      })}
    </ol>
  );
}

function Floors() {
  const { floors, total, wing, violations } = useEvacuationStore(useShallow((s) => ({ floors: s.metrics.floorPopulation, total: s.metrics.total, wing: s.metrics.wingPopulation, violations: s.metrics.topologyViolations })));
  return (
    <>
      <div className="sw-floor-head"><span>จำนวนคนตามชั้น</span><span className={`pi-chip ${violations === 0 ? "is-safe" : "is-danger"}`}>{violations === 0 ? "เส้นทางปกติ" : `ตรวจพบ ${violations}`}</span></div>
      <ul className="sw-floors">
        {Array.from({ length: 9 }, (_, i) => 9 - i).map((floor) => {
          const count = floors[floor] ?? 0;
          return (
            <li key={floor}>
              <span>ชั้น {floor}</span>
              <div className="pi-meter is-quiet"><i style={{ width: `${total ? Math.min(100, (count / total) * 260) : 0}%` }} /></div>
              <strong className="pi-num">{fmtInt(count)}</strong>
            </li>
          );
        })}
      </ul>
      <dl className="sw-wings">
        <div><dt>อาคาร 3</dt><dd className="pi-num">{fmtInt(wing["building-3"])}</dd></div>
        <div><dt>อาคาร 4</dt><dd className="pi-num">{fmtInt(wing["building-4"])}</dd></div>
        <div><dt>ปีกชมพู</dt><dd className="pi-num">{fmtInt(wing.pink)}</dd></div>
        <div><dt>ปีกฟ้า</dt><dd className="pi-num">{fmtInt(wing.blue)}</dd></div>
        <div><dt>แกนกลาง</dt><dd className="pi-num">{fmtInt(wing.core)}</dd></div>
        <div><dt>ชั้นล่าง</dt><dd className="pi-num">{fmtInt(wing.ground)}</dd></div>
        <div><dt>นอกอาคาร</dt><dd className="pi-num">{fmtInt(wing.outdoor)}</dd></div>
        <div><dt>จุดรวมพล</dt><dd className="pi-num">{fmtInt(wing.assembly)}</dd></div>
      </dl>
    </>
  );
}

const SEVERITY_LABEL = { info: "ข้อมูล", warning: "เฝ้าระวัง", danger: "ฉุกเฉิน", success: "สำเร็จ" } as const;

function Events() {
  const events = useEvacuationStore((s) => s.events);
  if (!events.length) return <div className="pi-empty"><UiIcon name="activity" /><strong>ยังไม่มีเหตุการณ์</strong><span>กด “เริ่มการจำลอง” แล้วเหตุการณ์สำคัญจะแสดงที่นี่</span></div>;
  return (
    <ol className="sw-events" aria-live="polite">
      {events.slice(0, 20).map((event) => (
        <li key={event.id} className={`is-${event.severity}`}>
          <time className="pi-num">{fmtTime(event.time)}</time>
          <div><strong><span className="sw-sev">{SEVERITY_LABEL[event.severity]}</span>{event.title}</strong><span>{event.detail}</span></div>
        </li>
      ))}
    </ol>
  );
}


const SOURCE_LABEL = { direct: "เห็นเปลวไฟเอง", heat: "รู้สึกความร้อน", smoke: "ได้กลิ่น/เห็นควัน", reported: "ได้รับแจ้ง" } as const;
const QUICK_PICKS = [
  { id: "rerouted", label: "เพิ่งเปลี่ยนทาง" },
  { id: "queueing", label: "รอคิว/เบียด" },
  { id: "holding", label: "ไปต่อไม่ได้" },
  { id: "aware-of-fire", label: "รู้เรื่องไฟ" },
] as const;

/** Decision inspector: shows only fields the runtime actually used for this person's choice. */
function Inspector() {
  const { token, status, inspected, setInspected, total } = useEvacuationStore(useShallow((s) => ({
    token: s.snapshotToken, status: s.status, inspected: s.inspectedAgentId, setInspected: s.setInspectedAgentId, total: s.metrics.total,
  })));
  const requestCameraFocus = useMapperStore((s) => s.requestCameraFocus);
  const [message, setMessage] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const info = useMemo(() => (inspected != null ? evacuationRuntime.inspectAgent(inspected) : null), [inspected, token]);
  if (status === "idle" || !total) {
    return <div className="pi-empty"><UiIcon name="search" /><strong>ยังไม่มีผู้จำลอง</strong><span>เริ่มการจำลองแล้วเลือกคนเพื่อดูว่าเขารับรู้อะไรและเลือกทางเพราะอะไร</span></div>;
  }
  const pick = (kind: (typeof QUICK_PICKS)[number]["id"]) => {
    const found = evacuationRuntime.findAgents(kind, 40);
    if (!found.length) { setMessage("ตอนนี้ยังไม่มีคนในกลุ่มนี้"); return; }
    const index = inspected != null ? (found.indexOf(inspected) + 1) % found.length : 0;
    setMessage("");
    setInspected(found[Math.max(0, index)]);
  };
  const locate = () => {
    if (!info) return;
    const building = info.roomId.startsWith("b3-") ? 3 : info.roomId.startsWith("b4-") ? 4 : 1;
    const outdoor = info.floor === 0;
    const b1 = useBuilding1Store.getState();
    if (outdoor) b1.setViewMode("exterior");
    else if (building === 1) { b1.setSelectedFloor(info.floor); b1.setViewMode("cutaway"); }
    else useBuilding3Store.setState({ inspecting: true, cutawayFloor: info.floor, buildingNumber: building });
    const offset = building === 1 && !outdoor ? yOffsetForRender(info.floor, useBuilding1Store.getState()) ?? 0 : 0;
    requestCameraFocus([info.position[0], info.position[1] + offset, info.position[2]]);
  };
  return (
    <div className="sw-inspector">
      <div className="sw-inspector-pick">
        <label className="pi-field">
          <span>หมายเลขผู้จำลอง <em>0–{fmtInt(Math.max(0, total - 1))}</em></span>
          <input type="number" min="0" max={Math.max(0, total - 1)} step="1" value={inspected ?? ""} placeholder="เช่น 120"
            onChange={(e) => { const value = e.currentTarget.valueAsNumber; setInspected(Number.isFinite(value) ? Math.min(total - 1, Math.max(0, value)) : null); }} />
        </label>
        <div className="pi-chip-row" role="group" aria-label="เลือกตัวอย่างอย่างรวดเร็ว">
          {QUICK_PICKS.map((item) => <button key={item.id} type="button" className="pi-btn is-sm is-ghost" onClick={() => pick(item.id)}>{item.label}</button>)}
        </div>
        {message ? <p className="pi-help" role="status">{message}</p> : null}
      </div>
      {!info ? (
        <div className="pi-empty"><UiIcon name="users" /><strong>เลือกคนที่ต้องการตรวจ</strong><span>ใส่หมายเลข หรือกดปุ่มตัวอย่างด้านบน คนที่เลือกจะมีวงแหวนสีฟ้าในฉาก</span></div>
      ) : (
        <article className="sw-inspector-card" aria-live="polite" aria-label={`เหตุผลการตัดสินใจของผู้จำลองหมายเลข ${info.id}`}>
          <header>
            <strong>#{info.id} · {info.roomId}</strong>
            <span className={`pi-chip ${info.behavior === "arrived" ? "is-safe" : info.behavior === "holding" || info.behavior === "incapacitated" ? "is-danger" : info.behavior === "queueing" || info.behavior === "crowding" || info.behavior === "replanning" ? "is-risk" : "is-neutral"}`}>{info.behaviorLabel}</span>
          </header>
          <p className="sw-inspector-reason"><UiIcon name="info" size={16} />{info.reasonText}</p>
          <dl className="sw-inspector-facts">
            <div><dt>รับรู้เหตุจาก</dt><dd>{info.awarenessLabel}{info.awareAt != null ? <small className="pi-num"> · {fmtTime(info.awareAt)}</small> : null}</dd></div>
            <div><dt>เส้นทางที่ใช้</dt><dd>{info.viaLabel} → {info.goalLabel}</dd></div>
            <div><dt>เหตุผลที่เลือกเส้นทางนี้</dt><dd>{info.routeReasonText}</dd></div>
            <div><dt>ช่วงทางถัดไป</dt><dd>{info.nextPassage ?? "—"}</dd></div>
            <div><dt>ประเมินเส้นทางล่าสุด</dt><dd className="pi-num">{info.lastEvaluationAt != null ? `${fmtTime(info.lastEvaluationAt)} (${Math.round(info.time - info.lastEvaluationAt)} วินาทีก่อน)` : "ยังไม่เคยประเมินใหม่"}</dd></div>
            <div><dt>เปลี่ยนเส้นทางแล้ว</dt><dd className="pi-num">{info.routeSwitches} ครั้ง</dd></div>
          </dl>
          <h4>คิวที่คนนี้มองเห็น/จำได้</h4>
          {info.perceivedQueues.length ? (
            <ul className="sw-inspector-list">{info.perceivedQueues.map((q) => <li key={q.edgeId}><span>{q.label}</span><span className="pi-num">~{Math.round(q.waitSeconds)} วิ · เห็นเมื่อ {Math.round(q.ageSeconds)} วิก่อน</span></li>)}</ul>
          ) : <p className="pi-help">ยังไม่เห็นคิวที่ต้องรอ</p>}
          <h4>อันตรายที่คนนี้รู้</h4>
          {info.knownFires.length || info.knownClosed.length ? (
            <ul className="sw-inspector-list">
              {info.knownFires.map((f) => <li key={f.fireId}><span>ไฟ · {f.controller ? "ผู้ควบคุมแจ้ง" : SOURCE_LABEL[f.source]}</span><span className="pi-num">ความมั่นใจ {Math.round(f.confidence * 100)}% · ±{f.uncertaintyMeters.toFixed(0)} ม. · {Math.round(f.ageSeconds)} วิก่อน</span></li>)}
              {info.knownClosed.map((label) => <li key={label}><span>ทางปิด · {label}</span><span>รู้แล้ว</span></li>)}
            </ul>
          ) : <p className="pi-help">ยังไม่รู้ตำแหน่งไฟหรือทางที่ปิด{info.perceivedSmoke > 0.02 ? ` · รับรู้ควัน ${Math.round(info.perceivedSmoke * 100)}%` : ""}</p>}
          <details className="pi-disclosure">
            <summary>ลักษณะเฉพาะบุคคล (จาก seed)</summary>
            <dl className="sw-inspector-facts is-compact pi-num">
              <div><dt>ความเร็วที่ต้องการ</dt><dd>{info.traits.speed.toFixed(2)} ม./วิ</dd></div>
              <div><dt>เริ่มเคลื่อนที่</dt><dd>{fmtTime(info.traits.responseDelay)}</dd></div>
              <div><dt>ความคุ้นเคยเส้นทาง</dt><dd>{Math.round(info.traits.familiarity * 100)}%</dd></div>
              <div><dt>ความระวังอันตราย</dt><dd>{Math.round(info.traits.riskAversion * 100)}%</dd></div>
              <div><dt>การตามกลุ่ม</dt><dd>{Math.round(info.traits.groupCohesion * 100)}%</dd></div>
              <div><dt>ต้องได้เวลาคืนก่อนเปลี่ยนทาง</dt><dd>{info.traits.switchCostSeconds.toFixed(1)} วิ</dd></div>
            </dl>
          </details>
          <div className="pi-chip-row">
            <button type="button" className="pi-btn is-sm is-secondary" onClick={locate}><UiIcon name="target" size={16} />ไปที่ตำแหน่ง</button>
            <button type="button" className="pi-btn is-sm is-ghost" onClick={() => setInspected(null)}>เลิกเลือก</button>
          </div>
        </article>
      )}
    </div>
  );
}

interface MonitorPanelProps {
  open: boolean;
  tab: MonitorTab;
  onTab: (tab: MonitorTab) => void;
  onToggle: () => void;
  onClose: () => void;
}

export const MonitorPanel = forwardRef<HTMLElement, MonitorPanelProps>(function MonitorPanel({ open, tab, onTab, onToggle, onClose }, ref) {
  const { bottlenecks, events } = useEvacuationStore(useShallow((s) => ({ bottlenecks: s.metrics.bottlenecks.length, events: s.events.length })));
  const counts: Record<MonitorTab, number | null> = { bottlenecks, floors: null, events, reasons: null };
  return (
    <aside ref={ref} className={`sw-panel sw-panel-right${open ? " is-open" : " is-collapsed"}`} aria-label="ติดตามสถานการณ์" data-sheet="activity">
      <div className="sw-rail" aria-hidden={open}>
        <button type="button" className="pi-icon-btn" tabIndex={open ? -1 : 0} aria-label="เปิดแผงติดตามสถานการณ์" data-tip="ติดตามสถานการณ์" data-tip-side="left" onClick={onToggle}><UiIcon name="panelRight" /></button>
        {TABS.map((item) => (
          <button key={item.id} type="button" className="pi-icon-btn has-badge" tabIndex={open ? -1 : 0} aria-label={`${item.label}${counts[item.id] ? ` ${counts[item.id]} รายการ` : ""}`} data-tip={item.label} data-tip-side="left" onClick={() => { onTab(item.id); onToggle(); }}>
            <UiIcon name={item.icon} />{counts[item.id] ? <b className="pi-badge pi-num">{counts[item.id]}</b> : null}
          </button>
        ))}
      </div>
      <div className="sw-panel-body" inert={!open || undefined}>
        <header className="sw-panel-head">
          <div><span className="pi-overline">ระหว่างจำลอง</span><h2>ติดตามสถานการณ์</h2></div>
          <button type="button" className="pi-icon-btn sw-collapse" aria-label="ย่อแผงติดตามสถานการณ์" data-tip="ย่อแผง" onClick={onToggle}><UiIcon name="chevronRight" /></button>
          <button type="button" className="pi-icon-btn sw-sheet-close" aria-label="ปิดแผง กลับไปดูโมเดล" onClick={onClose}><UiIcon name="close" /></button>
        </header>
        <div className="pi-tabs" role="tablist" aria-label="ข้อมูลติดตาม">
          {TABS.map((item) => (
            <button key={item.id} type="button" role="tab" id={`sw-mtab-${item.id}`} aria-selected={tab === item.id} aria-controls="sw-mtabpanel" tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? "is-active" : ""}
              onClick={() => onTab(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                const index = TABS.findIndex((t) => t.id === tab);
                const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                onTab(next.id);
                requestAnimationFrame(() => document.getElementById(`sw-mtab-${next.id}`)?.focus());
              }}>
              {item.label}{counts[item.id] ? <b className="pi-badge is-inline pi-num">{counts[item.id]}</b> : null}
            </button>
          ))}
        </div>
        <div id="sw-mtabpanel" className="sw-panel-scroll" role="tabpanel" aria-labelledby={`sw-mtab-${tab}`} tabIndex={0} data-tour={tab === "bottlenecks" ? "bottlenecks" : undefined}>
          {tab === "bottlenecks" && <Bottlenecks />}
          {tab === "floors" && <Floors />}
          {tab === "events" && <Events />}
          {tab === "reasons" && <Inspector />}
        </div>
      </div>
    </aside>
  );
});
