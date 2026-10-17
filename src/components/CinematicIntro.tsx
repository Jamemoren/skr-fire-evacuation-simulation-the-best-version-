import { type CSSProperties, useEffect, useState } from "react";
import { CINEMATIC_INTRO_DURATION_SECONDS } from "./cinematicConfig";

interface CinematicIntroProps {
  active: boolean;
  onComplete: () => void;
}

export function CinematicIntro({ active, onComplete }: CinematicIntroProps) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!active) return;
    setLeaving(false);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const previewMode = new URLSearchParams(window.location.search).get("intro") === "preview";
    const presentationTime = previewMode ? 30000 : reducedMotion ? 1500 : CINEMATIC_INTRO_DURATION_SECONDS * 1000;
    const fadeTimer = window.setTimeout(() => setLeaving(true), presentationTime);
    const completeTimer = window.setTimeout(onComplete, presentationTime + (reducedMotion ? 120 : 650));
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(completeTimer);
    };
  }, [active, onComplete]);

  if (!active) return null;
  return (
    <section
      className={`cinematic-intro${leaving ? " is-leaving" : ""}`}
      aria-label="บทนำระบบจำลองการอพยพ"
      style={{ "--intro-duration": `${CINEMATIC_INTRO_DURATION_SECONDS}s` } as CSSProperties}
    >
      <div className="cinematic-intro-vignette" />
      <div className="cinematic-intro-scan" />
      <div className="cinematic-intro-content">
        <div className="cinematic-intro-emblem">
          <img src="/assets/skr-school-emblem.png" alt="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต" />
        </div>
        <span className="cinematic-intro-eyebrow">โรงเรียนสวนกุหลาบวิทยาลัย รังสิต</span>
        <h1>FIRE EVACUATION<br /><em>SIMULATION SYSTEM</em></h1>
        <p>แบบจำลองอาคาร 9 ชั้น · ระบบอพยพ 3,000 คน · การรับรู้ไฟ ควัน และความร้อน</p>
        <div className="cinematic-intro-capabilities" aria-label="ความสามารถของระบบ">
          <span><i /> PHYSICAL TOPOLOGY</span>
          <span><i /> RISK-AWARE ROUTE PLANNING</span>
          <span><i /> CROWD FLOW SIMULATION</span>
        </div>
        <div className="cinematic-intro-progress"><i /></div>
      </div>
      <div className="cinematic-intro-meta"><span>อาคารเรียน 1</span><strong>แบบจำลองดิจิทัลเพื่อการอพยพ</strong></div>
      <button type="button" className="cinematic-intro-skip" onClick={() => { setLeaving(true); window.setTimeout(onComplete, 420); }}>ข้ามบทนำ <span>→</span></button>
    </section>
  );
}
