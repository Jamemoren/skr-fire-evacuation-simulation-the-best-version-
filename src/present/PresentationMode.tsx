/**
 * “นำเสนอ” — a 16:9 stage over the live 3D model. Manual by default (arrows, Space, PageUp/Down,
 * Home/End, Esc, T for contents); optional auto-advance and narration. Opening it never creates or
 * starts anything on a server; leaving it puts the view, floor, camera and focus back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useBuilding1Store } from "../building1/building1Store";
import { cancelCameraMove, currentPose, moveCamera, onCameraInterrupt } from "../camera/cameraDirector";
import { sound, useSoundStatus } from "../audio/soundManager";
import { useIntroAudioSettings } from "../audio/introAudioSettings";
import { SoundToggle } from "../audio/SoundToggle";
import { useStoryOverlay } from "./StoryOverlay3D";
import { ClosingPanel, SLIDES } from "./slides";
import { enterFullscreen, enteredFullscreenByUs, fullscreenElement, leaveFullscreen, markFullscreenLeft, usePresentStore } from "./presentStore";
import "./presentation.css";
import { StoryPlayer } from "./story/StoryPlayer";
import "./story/story.css";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MAIN = SLIDES.filter((slide) => slide.group === "main");
const EXTRA = SLIDES.filter((slide) => slide.group === "extra");

export function exitPresentation() {
  const state = usePresentStore.getState();
  if (!state.open) return;
  const saved = state.saved;
  cancelCameraMove();
  useStoryOverlay.getState().clear();
  sound.stopSpeech();
  sound.stopBed("present");
  if (saved) {
    const b1 = useBuilding1Store.getState();
    b1.setExplodeFloors(saved.explode);
    b1.setSelectedFloor(saved.floor);
    b1.setViewMode(saved.viewMode);
    if (saved.pose) void moveCamera(saved.pose, reducedMotion() ? 0 : 700);
  }
  leaveFullscreen();
  state.set({ open: false, mode: "start", suspended: false, tocOpen: false, saved: null });
  document.body.classList.remove("skr-presenting");
  const focus = saved?.focus;
  window.setTimeout(() => {
    if (focus && document.contains(focus)) focus.focus();
    else document.querySelector<HTMLElement>('[data-guide-target="present"]')?.focus();
    if (saved) window.scrollTo(0, saved.scroll);
  }, 0);
}

/** The first thing the presentation shows: start the narrated story, or open the slides. */
function StartScreen({ onStory, onSlides }: { onStory(): void; onSlides(): void }) {
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    startRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); exitPresentation(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="pz-start" role="dialog" aria-modal="true" aria-labelledby="pz-start-title">
      <div className="pz-start-card">
        <p>นำเสนอ · หลักคณิตศาสตร์บนโมเดลจริง</p>
        <h2 id="pz-start-title">ระบบเลือกทางหนีไฟอย่างไร</h2>
        <p className="pz-q">“ถ้าบันไดกลางมีคนรอมากขึ้น เราควรเปลี่ยนไปใช้บันไดอีกทางเมื่อไหร่?”</p>
        <p>กดเริ่มครั้งเดียว แล้วดูต่อเนื่องจนจบ (ประมาณ 3½ นาที) · พัก ย้อนช่วง ปิดเสียง ได้ที่แถบด้านล่าง · ตัวเลขทุกตัวคำนวณสดจากโปรแกรมจำลอง</p>
        <div className="pz-start-actions">
          <button ref={startRef} type="button" className="is-primary" onClick={onStory}>▶ เริ่มการสาธิต</button>
          <button type="button" onClick={onSlides}>ดูแบบสไลด์ (เลื่อนเอง)</button>
          <button type="button" onClick={exitPresentation}>ออก</button>
        </div>
      </div>
    </div>
  );
}

function usePortrait() {
  const [portrait, setPortrait] = useState(() => window.matchMedia("(max-aspect-ratio: 1/1)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-aspect-ratio: 1/1)");
    const update = () => setPortrait(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return portrait;
}

export function PresentationMode() {
  const { index, autoplay, tocOpen, suspended, mode, set } = usePresentStore();
  const narration = useIntroAudioSettings((state) => state.narration);
  const setNarration = useIntroAudioSettings((state) => state.setNarration);
  const speaking = useSoundStatus((state) => state.speaking);
  const portrait = usePortrait();
  const rootRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(() => !!fullscreenElement());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const slide = SLIDES[Math.min(index, SLIDES.length - 1)];
  const number = index + 1;

  // Save what we change, once per opening (survives the editor-demo round trip).
  useEffect(() => {
    const state = usePresentStore.getState();
    if (!state.saved) {
      const b1 = useBuilding1Store.getState();
      state.set({ saved: { viewMode: b1.viewMode, floor: b1.selectedFloor, explode: b1.explodeFloors, pose: currentPose(), focus: document.activeElement as HTMLElement | null, scroll: window.scrollY } });
    }
  }, []);

  useEffect(() => {
    if (suspended) { document.body.classList.remove("skr-presenting"); return; }
    document.body.classList.add("skr-presenting");
    sound.startBed("present", 0.32);
    rootRef.current?.focus({ preventScroll: true });
    return () => { document.body.classList.remove("skr-presenting"); };
  }, [suspended]);

  // Leaving browser fullscreen (Esc / F11) ends the presentation, like a slide-show app.
  useEffect(() => {
    const onChange = () => {
      const on = !!fullscreenElement();
      setFullscreen(on);
      if (!on && enteredFullscreenByUs()) {
        markFullscreenLeft();
        if (!usePresentStore.getState().suspended) exitPresentation();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => { document.removeEventListener("fullscreenchange", onChange); document.removeEventListener("webkitfullscreenchange", onChange); };
  }, []);

  // Enter the slide: set up the 3D scene, speak, and (if on) schedule the next slide.
  useEffect(() => {
    if (suspended || mode !== "slides") return;
    let alive = true;
    setBusy(true);
    setNote("");
    sound.stopSpeech();
    useStoryOverlay.getState().clear(); // nothing from the previous slide lingers while the camera moves
    const entered = slide.enter({ alive: () => alive }).catch(() => { if (alive) setNote("ฉาก 3 มิติของสไลด์นี้แสดงไม่ได้ — ข้อความยังครบ"); }).finally(() => { if (alive) setBusy(false); });
    const spoken = sound.speak(slide.narration);
    let timer = 0;
    if (autoplay) {
      const wait = new Promise<void>((resolve) => { timer = window.setTimeout(resolve, slide.seconds * 1000); });
      void Promise.all([wait, entered, spoken]).then(() => {
        if (!alive) return;
        const state = usePresentStore.getState();
        if (state.index < MAIN.length - 1) state.set({ index: state.index + 1 });
        else state.set({ autoplay: false });
      });
    }
    return () => { alive = false; window.clearTimeout(timer); };
  }, [slide, autoplay, suspended, mode]);

  // Grabbing the camera pauses auto-advance (the presenter is exploring).
  useEffect(() => onCameraInterrupt(() => {
    if (usePresentStore.getState().autoplay) { usePresentStore.getState().set({ autoplay: false }); setNote("หยุดเล่นอัตโนมัติ เพราะมีการหมุนกล้อง — กด ▶ เพื่อเล่นต่อ"); }
  }), []);

  const go = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, next));
    if (clamped !== usePresentStore.getState().index) { sound.effect("ui", 0.3); set({ index: clamped, tocOpen: false }); }
  }, [set]);

  useEffect(() => {
    if (suspended || mode !== "slides") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, .m-app")) return;
      const i = usePresentStore.getState().index;
      const keys: Record<string, () => void> = {
        ArrowRight: () => go(i + 1), PageDown: () => go(i + 1), " ": () => go(i + 1),
        ArrowLeft: () => go(i - 1), PageUp: () => go(i - 1),
        Home: () => go(0), End: () => go(MAIN.length - 1),
        Escape: () => (usePresentStore.getState().tocOpen ? set({ tocOpen: false }) : exitPresentation()),
        t: () => set({ tocOpen: !usePresentStore.getState().tocOpen }), T: () => set({ tocOpen: !usePresentStore.getState().tocOpen }),
      };
      const action = keys[event.key];
      if (!action) return;
      if (event.key === " " && target?.closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, set, suspended, mode]);

  useEffect(() => { if (tocOpen) tocRef.current?.querySelector<HTMLElement>("[aria-current='true'], button")?.focus(); }, [tocOpen]);

  if (suspended) return null;
  if (mode === "story") return <StoryPlayer onExit={exitPresentation} onSlides={() => { useStoryOverlay.getState().clear(); set({ mode: "slides", index: 0 }); }} />;
  if (mode === "start") return <StartScreen onStory={() => set({ mode: "story" })} onSlides={() => set({ mode: "slides", index: 0 })} />;
  const Panel = slide.Panel;
  const isExtra = slide.group === "extra";
  const position = isExtra ? `เสริม ${EXTRA.indexOf(slide) + 1}/${EXTRA.length}` : `${number}/${MAIN.length}`;

  return (
    <div ref={rootRef} className={`pz-root${fullscreen ? " is-fullscreen" : " is-windowed"}${portrait ? " is-portrait" : ""}`} role="dialog" aria-modal="true" aria-label={`โหมดนำเสนอ · สไลด์ ${position}: ${slide.title}`} tabIndex={-1}>
      <div className={`pz-stage${slide.wide ? " is-wide" : ""}${reducedMotion() ? " is-still" : ""}`}>
        <header className="pz-top" data-camera-inset="top">
          <span className="pz-brand">สวนกุหลาบฯ รังสิต · การอพยพ</span>
          <ol className="pz-dots" aria-label="ความคืบหน้า">
            {MAIN.map((item, i) => (
              <li key={item.id}><button type="button" className={i === index ? "is-on" : i < index ? "is-done" : ""} aria-label={`ไปสไลด์ ${i + 1}: ${item.title}`} aria-current={i === index} onClick={() => go(i)} /></li>
            ))}
          </ol>
          <span className="pz-count" aria-live="polite">{position}</span>
          <button type="button" className="pz-icon" onClick={() => set({ tocOpen: !tocOpen })} aria-expanded={tocOpen} aria-controls="pz-toc" title="สารบัญ (T)">☰ สารบัญ</button>
          <SoundToggle compact className="pz-sound" />
          {!fullscreen && <button type="button" className="pz-icon" onClick={() => void enterFullscreen()} title="เต็มจอ">⛶ เต็มจอ</button>}
          <button type="button" className="pz-icon is-exit" onClick={exitPresentation} title="ออกจากโหมดนำเสนอ (Esc)">✕ ออก</button>
        </header>

        <section key={slide.id} className={`pz-panel${slide.id === "title" ? " is-title" : ""}`} data-camera-inset={portrait ? "bottom" : "left"} aria-labelledby="pz-title">
          <p className="pz-kicker">{slide.kicker}{isExtra ? " · ฉากเสริม" : ""}</p>
          <h2 id="pz-title">{slide.title}</h2>
          {slide.id === "closing" ? <ClosingPanel onExit={exitPresentation} /> : <Panel />}
          {note && <p className="pz-note" role="status">{note}</p>}
        </section>

        <footer className="pz-bottom" data-camera-inset="bottom">
          <button type="button" className="pz-nav" onClick={() => go(index - 1)} disabled={index === 0} aria-label="สไลด์ก่อนหน้า">‹ ก่อนหน้า</button>
          <p className="pz-caption" aria-live="off">{busy ? "กำลังจัดกล้อง… " : ""}{slide.narration}</p>
          <div className="pz-play">
            <button type="button" className={`pz-toggle${autoplay ? " is-on" : ""}`} aria-pressed={autoplay} onClick={() => { set({ autoplay: !autoplay }); setNote(""); }} title="เลื่อนสไลด์อัตโนมัติ">{autoplay ? "❚❚ หยุดเล่นอัตโนมัติ" : "▶ เล่นอัตโนมัติ"}</button>
            {sound.narrationAvailable() && <button type="button" className={`pz-toggle${narration ? " is-on" : ""}`} aria-pressed={narration} onClick={() => { if (narration) sound.stopSpeech(); setNarration(!narration); }} title="อ่านคำบรรยายออกเสียง (ภาษาไทย ถ้าเครื่องมีเสียงไทย)">{speaking ? "🔊 กำลังบรรยาย" : narration ? "🔊 บรรยาย: เปิด" : "🔈 บรรยาย: ปิด"}</button>}
          </div>
          <button type="button" className="pz-nav is-next" onClick={() => go(index + 1)} disabled={index === SLIDES.length - 1} aria-label="สไลด์ถัดไป">ถัดไป ›</button>
        </footer>
      </div>

      {tocOpen && (
        <div id="pz-toc" ref={tocRef} className="pz-toc" role="navigation" aria-label="สารบัญสไลด์">
          <h3>ลำดับการนำเสนอ</h3>
          <ol>{MAIN.map((item) => { const i = SLIDES.indexOf(item); return <li key={item.id}><button type="button" aria-current={i === index} onClick={() => go(i)}><b>{i + 1}</b><span>{item.title}</span><small>{item.kicker} · ~{item.seconds} วิ</small></button></li>; })}</ol>
          <h3>ฉากเสริม (เปิดเมื่อกรรมการถาม)</h3>
          <ul>{EXTRA.map((item) => { const i = SLIDES.indexOf(item); return <li key={item.id}><button type="button" aria-current={i === index} onClick={() => go(i)}><b>+</b><span>{item.title}</span></button></li>; })}</ul>
          <p className="pz-small">แป้นลัด: ← → เปลี่ยนสไลด์ · Home/End · T สารบัญ · Esc ออก</p>
        </div>
      )}
    </div>
  );
}
