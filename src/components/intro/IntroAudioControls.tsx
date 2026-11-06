import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { introAudio, type IntroAudioStatus, type SoundName } from "../../audio/introAudio";
import { useIntroAudioSettings } from "../../audio/introAudioSettings";

const SOUND_TH: Record<SoundName, string> = {
  score: "เพลงประกอบ", bed: "เสียงบรรยากาศ", ignite: "เสียงเปิดฉาก", whoosh: "เสียงกล้องเคลื่อน", scan: "เสียงสแกน",
  pulse: "เสียงข้อความสำคัญ", title: "เสียงชื่อโครงงาน", outro: "เสียงปิดท้าย", ui: "เสียงปุ่ม",
};

function statusText(status: IntroAudioStatus, missing: SoundName[]): string {
  switch (status) {
    case "off": return "ปิดเสียงอยู่";
    case "loading": return "กำลังโหลดเสียง…";
    case "blocked": return "เบราว์เซอร์ยังไม่อนุญาตให้เล่นเสียง — กด “เปิดเสียง”";
    case "playing": return "เปิดเสียงอยู่";
    case "partial": return `เปิดเสียงอยู่ · โหลดไม่สำเร็จ: ${missing.map((name) => SOUND_TH[name]).join(", ")}`;
    case "error": return "โหลดไฟล์เสียงไม่สำเร็จ — บทนำเล่นต่อได้โดยไม่มีเสียง";
    case "unsupported": return "เบราว์เซอร์นี้เล่นเสียงประกอบไม่ได้";
  }
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" />
      {on
        ? <path d="M15.2 8.6a4.6 4.6 0 0 1 0 6.8M17.8 6a8.2 8.2 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        : <path d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * Sound controls of the intro: one clear on/off button (it becomes “เปิดเสียง” whenever sound is
 * not actually playing) and a small panel with separate music / effects levels and the status.
 * Choices are remembered in this browser.
 */
export function IntroAudioControls() {
  const status = useSyncExternalStore(introAudio.subscribe, introAudio.getStatus, introAudio.getStatus);
  const { music, sfx, setEnabled, setMusic, setSfx } = useIntroAudioSettings();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const levelsButton = useRef<HTMLButtonElement>(null);
  const firstSlider = useRef<HTMLInputElement>(null);
  const sounding = status === "playing" || status === "partial";
  const unavailable = status === "error" || status === "unsupported";

  useEffect(() => { if (open) firstSlider.current?.focus(); }, [open]);

  const toggle = () => {
    if (sounding) { setEnabled(false); return; }
    void introAudio.unlock().then(() => introAudio.uiClick());
  };

  const onPanelKey = (event: KeyboardEvent) => {
    // Esc closes the panel only; it must not also skip the intro.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      levelsButton.current?.focus();
    }
  };

  return (
    <div className="cine-audio" data-status={status} onKeyDown={open ? onPanelKey : undefined}>
      <button
        type="button"
        className={`cine-audio-toggle${status === "blocked" || status === "off" ? " is-invite" : ""}`}
        onClick={toggle}
        disabled={unavailable}
        aria-pressed={sounding}
        aria-label={sounding ? "ปิดเสียงบทนำ" : "เปิดเสียงบทนำ"}
      >
        <SpeakerIcon on={sounding} />
        <span className="cine-audio-label">{sounding ? "ปิดเสียง" : "เปิดเสียง"}</span>
      </button>
      <button
        ref={levelsButton}
        type="button"
        className="cine-audio-levels"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="ปรับระดับเสียงเพลงและเสียงประกอบ"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M5 7h8M17 7h2M5 17h2M11 17h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="15" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="9" cy="17" r="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="cine-audio-panel" role="group" aria-label="ระดับเสียงบทนำ">
          <label className="cine-audio-slider">
            <span>เพลง</span>
            <input ref={firstSlider} type="range" min={0} max={100} step={5} value={Math.round(music * 100)}
              onChange={(event) => setMusic(Number(event.target.value) / 100)} aria-valuetext={`${Math.round(music * 100)} เปอร์เซ็นต์`} />
            <output>{Math.round(music * 100)}%</output>
          </label>
          <label className="cine-audio-slider">
            <span>เสียงประกอบ</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(sfx * 100)}
              onChange={(event) => setSfx(Number(event.target.value) / 100)} aria-valuetext={`${Math.round(sfx * 100)} เปอร์เซ็นต์`} />
            <output>{Math.round(sfx * 100)}%</output>
          </label>
          <p className="cine-audio-note">จำค่าที่เลือกไว้สำหรับครั้งถัดไป · เพลงและเสียงประกอบสร้างขึ้นใหม่สำหรับโครงงานนี้</p>
        </div>
      )}
      <p className="cine-audio-status" role="status" aria-live="polite">{statusText(status, introAudio.missing)}</p>
    </div>
  );
}
