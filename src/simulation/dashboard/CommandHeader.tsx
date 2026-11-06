import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { PROJECT_CONTEXT_TH, PROJECT_DESCRIPTION_TH, PROJECT_METHOD_NOTE_TH, PROJECT_NAME_TH, PROJECT_SHORT_NAME_TH } from "../../projectIdentity";
import { UiIcon } from "../../components/UiIcon";
import { useEvacuationStore } from "../simulationStore";
import { openRoleplay } from "../../roleplay/lifecycle";
import { REPLAY_INTRO_EVENT } from "../../components/CinematicIntro";
import { fmtTime, STATUS_LABEL, startBlockSummary, type StartBlock } from "./dashboardModel";
import type { OperationalReadinessReport } from "../operationalReadiness";

const SPEEDS = [1, 2, 5, 10, 25, 50];

interface CommandHeaderProps {
  compact: boolean;
  readiness: OperationalReadinessReport | null;
  startBlock: StartBlock;
  sceneFocus: boolean;
  onToggleFocus: () => void;
  onOpenGuide: () => void;
  onBlockedStart: () => void;
  onStarted: () => void;
  mobileGuidanceOpen: boolean;
  onToggleMobileGuidance: () => void;
}

function ProjectInfo() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); buttonRef.current?.focus(); }
    };
    const onPointer = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);
  return (
    <div className="sw-info" ref={rootRef}>
      <button ref={buttonRef} type="button" className="pi-icon-btn is-on-dark" aria-expanded={open} aria-controls={panelId} aria-label="รายละเอียดโครงการ" data-tip="รายละเอียดโครงการ" onClick={() => setOpen(!open)}>
        <UiIcon name="info" size={18} />
      </button>
      {open && (
        <div id={panelId} className="sw-info-panel pi-popover" role="dialog" aria-label="รายละเอียดโครงการ">
          <span className="pi-overline">ชื่อโครงการ</span>
          <h2>{PROJECT_NAME_TH}</h2>
          <p>{PROJECT_DESCRIPTION_TH}</p>
          <dl className="sw-info-facts">
            <div><dt>อาคาร</dt><dd>อาคาร 1, 3, 4 · 144 ห้องเรียน</dd></div>
            <div><dt>บันไดหลัก</dt><dd>3 จุด</dd></div>
            <div><dt>จุดรวมพล</dt><dd>6 โซน · สนามฟุตบอล</dd></div>
            <div><dt>ประชากรสูงสุด</dt><dd>3,000 คน</dd></div>
          </dl>
          <p className="sw-info-note"><UiIcon name="alert" size={16} />{PROJECT_METHOD_NOTE_TH}</p>
          <button type="button" className="pi-btn is-secondary is-sm sw-info-replay" onClick={() => { setOpen(false); window.dispatchEvent(new Event(REPLAY_INTRO_EVENT)); }}>
            <UiIcon name="play" size={16} /><span>เล่นบทนำอีกครั้ง (มีเสียง)</span>
          </button>
          <div className="sw-info-keys">
            <span><kbd>คลิกขวา</kbd> ค้างแล้วลากเพื่อหันมอง</span>
            <span><kbd>ล้อเมาส์</kbd> ซูม</span>
            <span><kbd>WASD</kbd> เคลื่อนกล้อง</span>
            <span><kbd>Ctrl</kbd> ล็อกเมาส์</span>
          </div>
        </div>
      )}
    </div>
  );
}

function LiveStrip({ readiness, startBlock }: { readiness: OperationalReadinessReport | null; startBlock: StartBlock }) {
  const { status, elapsed, fps } = useEvacuationStore(useShallow((s) => ({ status: s.status, elapsed: s.metrics.elapsed, fps: s.renderFps })));
  const readinessTone = !readiness ? "checking" : startBlock ? "risk" : "safe";
  return (
    <div className="sw-live" aria-label="สถานะการจำลอง">
      <span className={`pi-chip is-status-${status}`} role="status"><i aria-hidden="true" />{STATUS_LABEL[status]}</span>
      <div className="sw-live-stat"><span>เวลาจำลอง</span><strong className="pi-num">{fmtTime(elapsed)}</strong></div>
      <div className={`sw-live-stat is-${readinessTone}`} data-tip="ตรวจผังอาคาร ประตู บันได ความจุ และเส้นทางจริงก่อนเริ่ม">
        <span>ความพร้อม</span>
        <strong>{!readiness ? "กำลังตรวจ" : startBlock ? "ต้องตรวจสอบ" : `ผ่าน ${readiness.passed}/${readiness.total}`}</strong>
      </div>
      <div className="sw-live-stat is-fps" data-tip="อัตราเฟรมที่วัดได้จริง"><span>ภาพ</span><strong className="pi-num">{fps ? `${fps} FPS` : "—"}</strong></div>
    </div>
  );
}

export function RunControls({ startBlock, onBlockedStart, onStarted, compact = false }: { startBlock: StartBlock; onBlockedStart: () => void; onStarted: () => void; compact?: boolean }) {
  const { status, speed, start, pause, resume, reset, setSpeed } = useEvacuationStore(useShallow((s) => ({
    status: s.status, speed: s.speedFactor, start: s.start, pause: s.pause, resume: s.resume, reset: s.reset, setSpeed: s.setSpeedFactor,
  })));
  const blocked = Boolean(startBlock) && (status === "idle" || status === "completed" || status === "paused");
  const reason = startBlockSummary(startBlock);
  const primary = status === "running"
    ? { label: "หยุดชั่วคราว", icon: "pause" as const, tone: "is-pause", run: pause }
    : status === "paused"
      ? { label: "ทำต่อ", icon: "play" as const, tone: "is-primary", run: resume }
      : { label: status === "completed" ? "เริ่มรอบใหม่" : "เริ่มการจำลอง", icon: "play" as const, tone: "is-primary", run: () => { start(); onStarted(); } };
  return (
    <div className="sw-run" role="group" aria-label="ควบคุมการจำลอง" data-tour="run" data-guide-target="run" tabIndex={-1}>
      <span className="sw-run-primary-wrap">
      <button
        type="button"
        className={`pi-btn ${primary.tone} sw-run-primary${blocked ? " is-blocked" : ""}`}
        aria-disabled={blocked ? "true" : undefined}
        aria-describedby={blocked ? "sw-run-reason" : undefined}
        onClick={() => { if (blocked) onBlockedStart(); else primary.run(); }}
      >
        <UiIcon name={primary.icon} size={18} />
        <span>{startBlock?.kind === "checking" && status === "idle" ? "กำลังตรวจระบบ…" : primary.label}</span>
      </button>
      {blocked && <span className="sw-run-blocked-badge" aria-hidden="true" />}
      </span>
      {blocked && <span id="sw-run-reason" className="pi-sr-only">{reason}</span>}
      <button type="button" className="pi-btn is-quiet-dark sw-run-reset" onClick={reset} aria-label="รีเซ็ตการจำลอง" data-tip="รีเซ็ตกลับก่อนเริ่ม">
        <UiIcon name="reset" size={18} />{!compact && <span>รีเซ็ต</span>}
      </button>
      <label className="sw-speed" data-tip="ความเร็วการจำลอง">
        <UiIcon name="speed" size={18} />
        <span className="pi-sr-only">ความเร็วการจำลอง</span>
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
    </div>
  );
}

export function CommandHeader({ compact, readiness, startBlock, sceneFocus, onToggleFocus, onOpenGuide, onBlockedStart, onStarted, mobileGuidanceOpen, onToggleMobileGuidance }: CommandHeaderProps) {
  const setWorkMode = useEvacuationStore((s) => s.setWorkMode);
  return (
    <header className="sw-header">
      <div className="sw-brand">
        <span className="sw-brand-mark"><img src="/assets/skr-school-emblem.png" alt="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต" /></span>
        <div className="sw-brand-copy">
          <h1 className="pi-brand-title" title={PROJECT_NAME_TH}>{PROJECT_SHORT_NAME_TH}</h1>
          <span>{PROJECT_CONTEXT_TH}</span>
        </div>
        <ProjectInfo />
      </div>
      <LiveStrip readiness={readiness} startBlock={startBlock} />
      {!compact && <RunControls startBlock={startBlock} onBlockedStart={onBlockedStart} onStarted={onStarted} />}
      <nav className="sw-header-actions" aria-label="คำสั่งทั่วไป">
        <button type="button" className="pi-btn is-primary sw-roleplay-button" onClick={openRoleplay} data-tip="ควบคุมนักเรียน 1 คนแบบมุมมองบุคคลที่หนึ่ง เดินอพยพพร้อม NPC และดูมือถือนำทางของตัวเอง (SIMULATOR)"><UiIcon name="walk" size={18} /><span>สวมบทอพยพ</span></button>
        <button type="button" className="pi-btn is-quiet-dark sw-mobile-guidance-button" aria-expanded={mobileGuidanceOpen} onClick={onToggleMobileGuidance} data-tip="ตัวอย่างหน้าจอมือถือ ระบบฝึกซ้อม และศูนย์ควบคุม"><UiIcon name="phone" size={18} /><span>ระบบนำทางมือถือ</span></button>
        <button type="button" className="pi-btn is-quiet-dark sw-guide-button" onClick={onOpenGuide} aria-haspopup="dialog"><UiIcon name="guide" size={18} /><span>คู่มือ</span></button>
        <button type="button" className="pi-btn is-quiet-dark" aria-pressed={sceneFocus} onClick={onToggleFocus}><UiIcon name="expand" size={18} /><span>{sceneFocus ? "แสดงแผง" : "เต็มฉาก"}</span></button>
        <button type="button" className="pi-btn is-outline-dark" data-guide-target="editor" onClick={() => setWorkMode("editor")}><UiIcon name="pencil" size={18} /><span>แก้ไขแบบจำลอง</span></button>
      </nav>
    </header>
  );
}
