import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import { UiIcon } from "../components/UiIcon";
import { UserGuide, type GuideTarget } from "../components/UserGuide";
import { GuidedTour, type TourPanel } from "../components/GuidedTour";
import type { Lesson } from "../guide/lessons";
import { TouchWalkControls } from "../navigation/TouchWalkControls";
import { useRoleplayStore } from "../roleplay/roleplayStore";
import { useWalkStore } from "../navigation/walkStore";
import { useQualityStore } from "../rendering/qualityStore";
import { useMapperStore } from "../store";
import { useEvacuationStore } from "./simulationStore";
import { CommandHeader, RunControls } from "./dashboard/CommandHeader";
import { ControlPanel } from "./dashboard/ControlPanel";
import { MonitorPanel } from "./dashboard/MonitorPanel";
import { ResultsBar } from "./dashboard/ResultsBar";
import { useSceneCommands, ViewDock } from "./dashboard/ViewDock";
import {
  loadPanelPrefs,
  resetSceneInsets,
  savePanelPrefs,
  startBlockOf,
  startBlockSummary,
  STATUS_LABEL,
  useReadiness,
  useTemplateIssues,
  useViewportFrameStore,
  type ControlTab,
  type MobilePanel,
  type MonitorTab,
} from "./dashboard/dashboardModel";
import "./dashboard/workspace.css";
import { lazy, Suspense } from "react";
import type { HostMode } from "../mobile-host/MobileGuidanceHost";

const MobileGuidanceHost = lazy(() => import("../mobile-host/MobileGuidanceHost").then((module) => ({ default: module.MobileGuidanceHost })));

const guidePanels: Record<GuideTarget, MobilePanel> = {
  scene: "scene",
  setup: "controls",
  run: "controls",
  results: "metrics",
  editor: "scene",
  roleplay: "scene",
  mobile: "scene",
  present: "scene",
};

const COMPACT_QUERY = "(max-width: 1179px)";

interface SimulationDashboardProps {
  tutorialActive: boolean;
  /** The opening film is playing; the first-visit guide waits for it to finish. */
  introActive?: boolean;
  onStartTutorial: () => void;
  onEndTutorial: () => void;
}

const GUIDE_SEEN_KEY = "skr-guide-seen";
function guideSeen(): boolean {
  // ?intro=0 / ?guide=0 (automated checks, presentations) skip the first-visit welcome.
  const params = new URLSearchParams(window.location.search);
  if (params.get("guide") === "0" || params.get("intro") === "0") return true;
  try { return window.localStorage.getItem(GUIDE_SEEN_KEY) === "1"; } catch { return true; }
}

export function SimulationDashboard({ tutorialActive, introActive = false, onStartTutorial, onEndTutorial }: SimulationDashboardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLElement>(null);
  const rightRef = useRef<HTMLElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const mobileHostRef = useRef<HTMLElement>(null);
  // The mobile guidance panel is mounted on first open and then only hidden, so closing it never
  // drops the preview session; it lives beside the 3D simulation and never touches its store.
  const [mobileHost, setMobileHost] = useState<{ mounted: boolean; open: boolean; mode: HostMode }>({ mounted: false, open: false, mode: "docked" });
  const [mobileHostWidth, setMobileHostWidth] = useState(760);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia(COMPACT_QUERY).matches);
  const [prefs, setPrefs] = useState(loadPanelPrefs);
  const [controlTab, setControlTab] = useState<ControlTab>("scenario");
  const [monitorTab, setMonitorTab] = useState<MonitorTab>("bottlenecks");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("scene");
  const [sceneFocus, setSceneFocus] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // First visit: open the guide once (welcome layout) after the opening film; keep the header
  // button highlighted until the guide has been opened.
  const [guideNew, setGuideNew] = useState(() => !guideSeen());
  const [guideWelcome, setGuideWelcome] = useState(false);
  /** A lesson being practised on the real screen, and the panel to return to afterwards. */
  const [lessonTour, setLessonTour] = useState<{ lesson: Lesson; returnPanel: MobilePanel } | null>(null);
  const [guideResume, setGuideResume] = useState(false);
  const openGuide = useCallback((welcome = false, resume = false) => {
    setGuideWelcome(welcome);
    setGuideResume(resume);
    setGuideOpen(true);
    setGuideNew(false);
    try { window.localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    if (!guideNew || introActive || tutorialActive) return undefined;
    const timer = window.setTimeout(() => openGuide(true), 600);
    return () => window.clearTimeout(timer);
  }, [guideNew, introActive, tutorialActive, openGuide]);
  const walking = useWalkStore((s) => s.enabled);
  const touch = useQualityStore((s) => s.touch);
  const { status, placeFireMode, setPlaceFireMode } = useEvacuationStore(useShallow((s) => ({ status: s.status, placeFireMode: s.placeFireMode, setPlaceFireMode: s.setPlaceFireMode })));
  const readiness = useReadiness();
  const templateIssues = useTemplateIssues();
  const startBlock = startBlockOf(readiness, templateIssues);
  const cmd = useSceneCommands();

  useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const setLeftOpen = useCallback((left: boolean) => setPrefs((p) => { const next = { ...p, left }; savePanelPrefs(next); return next; }), []);
  const setRightOpen = useCallback((right: boolean, chosen = true) => setPrefs((p) => { const next = { ...p, right, rightChosen: p.rightChosen || chosen }; savePanelPrefs(next); return next; }), []);
  const closeSheet = useCallback(() => setMobilePanel("scene"), []);

  const startWalking = () => { closeSheet(); setSceneFocus(true); cmd.startWalking(); };
  const stopWalking = () => { cmd.focusBuilding(); setSceneFocus(false); };
  useEffect(() => () => useWalkStore.getState().setEnabled(false), []);
  // First run of a session: bring the live monitor in, unless the user already chose.
  useEffect(() => {
    if (status === "running" && !prefs.rightChosen && !prefs.right && !compact) setRightOpen(true, false);
  }, [compact, prefs.right, prefs.rightChosen, setRightOpen, status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setMobilePanel("scene");
      useEvacuationStore.getState().setPlaceFireMode(false);
      useWalkStore.getState().setEnabled(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Publish the unobstructed scene rectangle so the camera can centre the model in it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shell = root.getBoundingClientRect();
        if (!shell.width || !shell.height) return;
        const header = root.querySelector<HTMLElement>(".sw-header")?.getBoundingClientRect();
        const dock = root.querySelector<HTMLElement>(".sw-dock")?.getBoundingClientRect();
        const visible = (el: Element | null) => el && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
        let top = Math.max(header && visible(root.querySelector(".sw-header")) ? header.bottom - shell.top : 0, dock && visible(root.querySelector(".sw-dock")) ? dock.bottom - shell.top : 0);
        let left = 0;
        let right = 0;
        let bottom = 0;
        if (!compact) {
          const l = leftRef.current;
          const r = rightRef.current;
          const host = mobileHostRef.current;
          if (l && visible(l)) left = l.getBoundingClientRect().right - shell.left;
          if (r && visible(r)) right = shell.right - r.getBoundingClientRect().left;
          if (host && visible(host) && host.classList.contains("is-docked")) right = Math.max(right, shell.right - host.getBoundingClientRect().left);
        }
        const results = resultsRef.current;
        if (results && visible(results)) bottom = shell.bottom - results.getBoundingClientRect().top;
        const nav = root.querySelector<HTMLElement>(".sw-mobile-nav");
        if (compact && nav && visible(nav)) bottom = Math.max(bottom, shell.bottom - nav.getBoundingClientRect().top);
        top = Math.min(top, shell.height * 0.45);
        bottom = Math.min(bottom, shell.height * 0.45);
        useViewportFrameStore.getState().setInsets({ left, right, top, bottom });
      });
    };
    const observer = new ResizeObserver(measure);
    [root, leftRef.current, rightRef.current, resultsRef.current, mobileHostRef.current, root.querySelector(".sw-header"), root.querySelector(".sw-dock")]
      .forEach((el) => { if (el) observer.observe(el); });
    window.addEventListener("resize", measure);
    // The cinematic intro reveals the panels through an <html> attribute, not React state.
    const introObserver = new MutationObserver(() => { measure(); window.setTimeout(measure, 1200); });
    introObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skr-intro"] });
    measure();
    const late = window.setTimeout(measure, 360);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(late);
      observer.disconnect();
      introObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [compact, prefs.left, prefs.right, resultsOpen, sceneFocus, walking, mobilePanel, mobileHost.open, mobileHost.mode, mobileHost.mounted, mobileHostWidth]);
  useEffect(() => () => resetSceneInsets(), []);

  const revealReadiness = () => {
    if (compact) setMobilePanel("controls");
    else setLeftOpen(true);
    setSceneFocus(false);
    useMapperStore.getState().addToast("info", `ยังเริ่มไม่ได้: ${startBlockSummary(startBlock)} — ดูขั้นตอนแก้ไขในแผงตั้งค่า`);
    window.setTimeout(() => {
      const card = document.getElementById("sw-readiness");
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      card?.focus({ preventScroll: true });
    }, 340);
  };

  const prepareTourPanel = useCallback((panel: TourPanel) => {
    setMobilePanel(panel);
    setSceneFocus(false);
    useWalkStore.getState().setEnabled(false);
    if (panel === "controls") { setLeftOpen(true); setControlTab("scenario"); }
    if (panel === "metrics") setResultsOpen(true);
    if (panel === "activity") { setRightOpen(true); setMonitorTab("bottlenecks"); }
  }, [setLeftOpen, setRightOpen]);

  const practiceGuideStep = (target: GuideTarget) => {
    prepareTourPanel(guidePanels[target]);
    window.setTimeout(() => {
      const section = rootRef.current?.querySelector<HTMLElement>(`[data-guide-target="${target}"]`);
      section?.focus({ preventScroll: true });
      section?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, 320);
  };

  const quickRun = () => {
    const s = useEvacuationStore.getState();
    if (s.status === "running") s.pause();
    else if (startBlock) revealReadiness();
    else if (s.status === "paused") s.resume();
    else { s.start(); closeSheet(); }
  };

  const panelsHidden = sceneFocus || walking;
  const roleplayOn = useRoleplayStore((state) => state.phase !== "off");
  const hostDocked = mobileHost.open && mobileHost.mode === "docked" && !compact;
  const toggleMobileHost = () => setMobileHost((current) => (current.open ? { ...current, open: false } : { mounted: true, open: true, mode: current.mode === "minimized" ? "docked" : current.mode }));

  return (
    <div
      ref={rootRef}
      className="sw-root"
      data-panel={mobilePanel}
      data-focus={panelsHidden}
      data-walking={walking}
      data-compact={compact}
      data-mobile-host={mobileHost.open ? mobileHost.mode : "closed"}
      data-roleplay={roleplayOn}
      style={{ ...(hostDocked ? ({ "--sw-right": `${mobileHostWidth}px` } as React.CSSProperties) : {}), ...(roleplayOn ? { display: "none" } : {}) }}
      aria-hidden={roleplayOn || undefined}
    >
      {compact && mobilePanel !== "scene" && <button type="button" className="sw-scrim" onClick={closeSheet} aria-label="ปิดแผงและดูโมเดล" />}
      <CommandHeader
        compact={compact}
        readiness={readiness}
        startBlock={startBlock}
        sceneFocus={sceneFocus}
        onToggleFocus={() => setSceneFocus(!sceneFocus)}
        onOpenGuide={() => openGuide(false)}
        guideNew={guideNew}
        onBlockedStart={revealReadiness}
        onStarted={closeSheet}
        mobileGuidanceOpen={mobileHost.open}
        onToggleMobileGuidance={toggleMobileHost}
      />
      <ViewDock walking={walking} onWalk={startWalking} onStopWalk={stopWalking} onAfterCommand={closeSheet} />

      {walking && <TouchWalkControls blocked={mobilePanel !== "scene" || placeFireMode} onExit={stopWalking} />}
      {placeFireMode && (
        <div className="sw-banner is-risk" role="status">
          <UiIcon name="target" size={18} />
          <span>{touch ? "แตะ" : "คลิก"}บนอาคารเพื่อวางจุดไฟ — จุดไฟผูกกับชั้นและปีกของอาคาร</span>
          <button type="button" className="pi-btn is-sm is-quiet-dark" onClick={() => setPlaceFireMode(false)}>ยกเลิก</button>
        </div>
      )}

      <ControlPanel
        ref={leftRef}
        open={compact ? mobilePanel === "controls" : prefs.left}
        tab={controlTab}
        onTab={setControlTab}
        onToggle={() => setLeftOpen(!prefs.left)}
        onClose={closeSheet}
        readiness={readiness}
        startBlock={startBlock}
        onStartTutorial={onStartTutorial}
        onPlaceFire={closeSheet}
      />
      <MonitorPanel ref={rightRef} open={compact ? mobilePanel === "activity" : prefs.right} tab={monitorTab} onTab={setMonitorTab} onToggle={() => setRightOpen(!prefs.right)} onClose={closeSheet} />
      <ResultsBar ref={resultsRef} expanded={compact ? mobilePanel === "metrics" : resultsOpen} onToggle={() => (compact ? setMobilePanel(mobilePanel === "metrics" ? "scene" : "metrics") : setResultsOpen(!resultsOpen))} onClose={closeSheet} />

      {!compact && (
        <p className="sw-hint" aria-hidden="true">
          <span><kbd>คลิกขวา</kbd> ลากเพื่อหันมอง</span><span><kbd>ล้อเมาส์</kbd> ซูม</span><span><kbd>WASD</kbd> เคลื่อนที่</span>
        </p>
      )}

      <nav className="sw-mobile-nav" aria-label="เมนูการจำลอง">
        {([
          { id: "scene", label: "โมเดล", icon: "scene" },
          { id: "controls", label: "ตั้งค่า", icon: "controls" },
          { id: "metrics", label: "ผลอพยพ", icon: "metrics" },
          { id: "activity", label: "เหตุการณ์", icon: "activity" },
        ] as const).map((item) => (
          <button type="button" key={item.id} aria-pressed={mobilePanel === item.id} onClick={() => setMobilePanel(mobilePanel === item.id ? "scene" : item.id)}>
            <UiIcon name={item.icon} /><span>{item.label}</span>
          </button>
        ))}
        <button type="button" className={`sw-mobile-run is-${status}${startBlock && status !== "running" ? " is-blocked" : ""}`} onClick={quickRun} aria-label={status === "running" ? "หยุดการจำลองชั่วคราว" : status === "paused" ? "ทำการจำลองต่อ" : "เริ่มการจำลอง"}>
          <UiIcon name={status === "running" ? "pause" : "play"} /><span>{status === "running" ? "หยุด" : status === "paused" ? "ทำต่อ" : "เริ่ม"}</span>
        </button>
      </nav>
      <div className="sw-mobile-status" aria-hidden="true"><span className={`pi-chip is-status-${status}`}><i />{STATUS_LABEL[status]}</span></div>
      {compact && mobilePanel === "controls" && <div className="sw-sheet-run"><RunControls startBlock={startBlock} onBlockedStart={revealReadiness} onStarted={closeSheet} compact /></div>}

      {mobileHost.mounted && (
        <Suspense fallback={null}>
          <MobileGuidanceHost
            panelRef={mobileHostRef}
            open={mobileHost.open}
            mode={mobileHost.mode}
            compact={compact}
            onMode={(mode) => setMobileHost((current) => ({ ...current, mode }))}
            onClose={() => setMobileHost((current) => ({ ...current, open: false, mode: "docked" }))}
            onWidth={setMobileHostWidth}
          />
        </Suspense>
      )}
      <UserGuide open={guideOpen} welcome={guideWelcome} resume={guideResume} onClose={() => { setGuideOpen(false); setGuideWelcome(false); }} onPractice={practiceGuideStep} onPracticeLesson={(lesson) => setLessonTour({ lesson, returnPanel: mobilePanel })} onStartTutorial={() => { setGuideOpen(false); onStartTutorial(); }} />
      {tutorialActive && <GuidedTour panel={mobilePanel} onPrepare={prepareTourPanel} onClose={onEndTutorial} />}
      {lessonTour && !tutorialActive && lessonTour.lesson.practice && (
        <GuidedTour key={lessonTour.lesson.id} panel={mobilePanel} steps={lessonTour.lesson.practice} title={`ลองทำ: ${lessonTour.lesson.label}`} onPrepare={prepareTourPanel}
          onClose={() => { const back = lessonTour.returnPanel; setLessonTour(null); setMobilePanel(back); openGuide(false, true); }} />
      )}
    </div>
  );
}
