import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CLASSROOMS, FLOOR_COUNT } from "../building1/building1Data";
import { PROJECT_SHORT_NAME_TH, SCHOOL_NAME_TH } from "../projectIdentity";
import {
  CINEMATIC_CAMERA_SETTLE_SECONDS,
  CINEMATIC_HERO_HOLD_SECONDS,
  CINEMATIC_INTRO_DURATION_SECONDS,
  CINEMATIC_REDUCED_DURATION_SECONDS,
} from "./cinematicConfig";
import { getIntroData, type IntroAnchor } from "./intro/introData";
import { introClock, resolveIntroMode } from "./intro/introTimeline";
import { IntroAudioControls } from "./intro/IntroAudioControls";
import { introAudio } from "../audio/introAudio";
import "./cinematic-intro.css";

/** Dispatch on window to play the opening again (handled by App). */
export const REPLAY_INTRO_EVENT = "skr:replay-intro";

interface CinematicIntroProps {
  active: boolean;
  onComplete: () => void;
}

type CutState = "none" | "closing" | "opening";

const TAG_CUES: Record<IntroAnchor["id"], string> = {
  building: "3.35 5.0",
  bottleneck: "6.1 8.15",
  alternative: "7.2 8.35",
  assembly: "8.55 10.05",
};

const TAG_TONE: Record<IntroAnchor["id"], string> = {
  building: "blue",
  bottleneck: "orange",
  alternative: "mint",
  assembly: "gold",
};

declare global {
  interface Window {
    __skrIntro?: { seek: (seconds: number) => void; play: () => void; state: () => { elapsed: number; ready: boolean; level: number } };
  }
}

export function CinematicIntro({ active, onComplete }: CinematicIntroProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [mode] = useState(resolveIntroMode);
  const preview = useMemo(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("intro") === "preview", []);
  const [holding, setHolding] = useState(false);
  const [cut, setCut] = useState<CutState>("none");
  const finishedRef = useRef(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  const anchors = useMemo(() => (active && mode === "full" ? getIntroData().anchors : []), [active, mode]);
  const duration = mode === "reduced" ? CINEMATIC_REDUCED_DURATION_SECONDS : CINEMATIC_INTRO_DURATION_SECONDS;

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    completeRef.current();
  }, []);

  // Reset the shared clock before the WebGL director's first frame.
  useLayoutEffect(() => {
    if (!active) return undefined;
    finishedRef.current = false;
    setHolding(false);
    introClock.reset(mode, preview ? CINEMATIC_HERO_HOLD_SECONDS : null);
    introClock.attach(rootRef.current);
    introClock.onComplete = finish;
    introClock.onHoldChange = setHolding;
    document.documentElement.dataset.skrIntro = "playing";
    if (new URLSearchParams(window.location.search).has("introDebug")) {
      window.__skrIntro = {
        seek: (seconds) => introClock.seek(seconds),
        play: () => { introClock.debugPaused = false; },
        state: () => ({ elapsed: introClock.elapsed, ready: introClock.ready, level: introClock.effectLevel }),
      };
    }
    return () => {
      introClock.onComplete = null;
      introClock.onHoldChange = null;
      introClock.stop();
      delete document.documentElement.dataset.skrIntro;
      delete window.__skrIntro;
    };
  }, [active, finish, mode, preview]);

  // Sound follows the same clock. Started and released here so StrictMode's mount → unmount →
  // mount reuses one audio context instead of leaving a second one behind.
  useEffect(() => {
    if (!active) return undefined;
    introAudio.begin(mode);
    return () => introAudio.end();
  }, [active, mode]);

  // DOM-side clock: drives the reduced-motion card, and keeps the opening moving if
  // WebGL stops ticking (context loss, very slow first shader compile).
  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    let last = performance.now();
    const grace = mode === "reduced" ? 0 : 2600;
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const glStalled = now - introClock.lastGlTick > 450;
      if (!document.hidden && glStalled && now - introClock.mountedAt > grace && !introClock.completed) {
        introClock.ready = true;
        introClock.advance(dt);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active, mode]);

  const skip = useCallback(() => {
    if (finishedRef.current || cut !== "none") return;
    introAudio.uiClick();
    if (introClock.release()) return; // preview hold → continue into the hand-off
    introAudio.noteSkip();
    if (mode === "reduced" || introClock.elapsed >= CINEMATIC_CAMERA_SETTLE_SECONDS - 0.25) {
      finish();
      return;
    }
    // A short dip to midnight hides the cut to the operational camera pose.
    setCut("closing");
    window.setTimeout(() => {
      setCut("opening");
      finish();
    }, 260);
  }, [cut, finish, mode]);

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      // Enter/Space on the sound controls belong to those controls, not to "start".
      const inAudio = event.target instanceof Element && Boolean(event.target.closest(".cine-audio"));
      if (event.key === "Escape" || (!inAudio && introClock.holding && (event.key === "Enter" || event.key === " "))) {
        event.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, skip]);

  if (!active) {
    return cut === "opening"
      ? <div className="cine-cut is-opening" aria-hidden="true" onAnimationEnd={() => setCut("none")} />
      : null;
  }

  return (
    <section
      ref={rootRef}
      className="cine"
      data-mode={mode}
      data-holding={holding ? "1" : undefined}
      aria-label={`บทนำ ${PROJECT_SHORT_NAME_TH}`}
      style={{ "--cine-duration": `${duration}s` } as CSSProperties}
    >
      <div className="cine-veil" aria-hidden="true"><i /></div>
      <div className="cine-vignette" aria-hidden="true" />
      <div className="cine-letterbox is-top" aria-hidden="true" />
      <div className="cine-letterbox is-bottom" aria-hidden="true" />

      {mode === "full" ? (
        <>
          <div className="cine-flash is-spark" data-cue="0.04 1.2" aria-hidden="true" />
          <div className="cine-scrim" data-cue="5.1 8.1" aria-hidden="true" />
          <div className="cine-flash is-hero" data-cue="8.86 10.2" aria-hidden="true" />

          <p className="cine-eyebrow" data-cue="0.5 2.2">
            <span>อาคารเรียน 1</span><i aria-hidden="true" /><span>{SCHOOL_NAME_TH}</span>
          </p>

          <div className="cine-lower" data-cue="2.5 4.95">
            <span className="cine-kicker">DIGITAL TWIN · BUILDING 01</span>
            <strong>แบบจำลองดิจิทัลของอาคารจริง</strong>
            <small>{FLOOR_COUNT} ชั้น · {CLASSROOMS.length} ห้องเรียน · สนามรวมพล</small>
          </div>

          <ol className="cine-statements" aria-live="polite">
            <li data-cue="5.2 8.05" style={{ "--tone": "var(--cine-cyan)" } as CSSProperties}><b>01</b><span className="cine-mask"><span>มองเห็นความเสี่ยง</span></span></li>
            <li data-cue="6.05 8.05" style={{ "--tone": "var(--cine-orange)" } as CSSProperties}><b>02</b><span className="cine-mask"><span>วิเคราะห์คอขวด</span></span></li>
            <li data-cue="6.95 8.05" style={{ "--tone": "var(--cine-mint)" } as CSSProperties}><b>03</b><span className="cine-mask"><span>ออกแบบทางรอด</span></span></li>
          </ol>
          <p className="cine-note" data-cue="5.25 8.05">ภาพประกอบแนวคิด · เส้นทางจากกราฟทางเดินจริงของอาคาร (กรณีไม่มีไฟและคิว)</p>

          {anchors.map((anchor) => (
            <div key={anchor.id} className="cine-tag" data-anchor={anchor.id} data-tone={TAG_TONE[anchor.id]} data-cue={TAG_CUES[anchor.id]} aria-hidden="true">
              <i className="cine-tag-dot" />
              <i className="cine-tag-leader" />
              <div className="cine-tag-card"><strong>{anchor.title}</strong><span>{anchor.detail}</span></div>
            </div>
          ))}
        </>
      ) : null}

      <div className="cine-hero" data-cue={mode === "full" ? "8.3 10.15" : `0.25 ${CINEMATIC_REDUCED_DURATION_SECONDS - 0.7}`}>
        <div className="cine-hero-emblem"><img src="/assets/skr-school-emblem.png" alt="" /></div>
        <span className="cine-hero-eyebrow">{SCHOOL_NAME_TH}</span>
        <h1 className="cine-hero-title"><span className="cine-mask"><span>{PROJECT_SHORT_NAME_TH}</span></span></h1>
        <p className="cine-hero-sub"><span className="cine-mask"><span>คณิตศาสตร์ที่ช่วยออกแบบทางรอด</span></span></p>
        <i className="cine-hero-rule" aria-hidden="true" />
      </div>

      <div className="cine-controls" data-cue={`0 ${mode === "full" ? 11 : duration - 0.45}`}>
        <IntroAudioControls />
        {holding && <span className="cine-hold-hint">กด Enter เพื่อเริ่มใช้งาน</span>}
        <button type="button" className="cine-skip" onClick={skip} aria-label={holding ? "เริ่มใช้งานระบบ" : "ข้ามบทนำ (Esc)"}>
          <span className="cine-skip-label">{holding ? "เริ่มใช้งาน" : "ข้าม Intro"}</span>
          <kbd>{holding ? "Enter" : "Esc"}</kbd>
          <span className="cine-skip-track" aria-hidden="true"><i data-intro-progress /></span>
        </button>
      </div>

      {cut === "closing" && <div className="cine-cut is-closing" aria-hidden="true" />}
    </section>
  );
}
