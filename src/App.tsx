import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PROJECT_METHOD_NOTE_TH } from "./projectIdentity";
import { restoreWorkspace } from "./utils/projectFiles";
import { CAMPUS_OVERVIEW_FOCUS } from "./building1/campusExtensionData";
import { EditorToolbar, deleteEditorSelection } from "./components/EditorToolbar";
import { AnnotationDialog } from "./components/AnnotationDialog";
import { ShortcutsModal } from "./components/GuideModals";
import { UserGuide } from "./components/UserGuide";
import { EditorDemo } from "./components/EditorDemo";
import { AutoEditorDemo, recoverInterruptedDemo } from "./components/AutoEditorDemo";
import { InspectorPanel } from "./components/InspectorPanel";
import { LeftToolbar } from "./components/LeftToolbar";
import { SceneOverlays, Toasts } from "./components/Overlays";
import { SceneCanvas } from "./components/SceneCanvas";
import { CinematicIntro, REPLAY_INTRO_EVENT } from "./components/CinematicIntro";
import { TopBar } from "./components/TopBar";
import { BuildingTwinPanel } from "./building1/BuildingTwinPanel";
import { useBuilding1Store } from "./building1/building1Store";
import { useMapperStore } from "./store";
import { SimulationDashboard } from "./simulation/SimulationDashboard";
import { useEvacuationStore } from "./simulation/simulationStore";
import { useRoleplayStore } from "./roleplay/roleplayStore";
import { PresentationHost } from "./present/PresentationHost";

// The roleplay UI (phone, setup, results) loads only when the mode is opened.
const RoleplayHost = lazy(() => import("./roleplay/RoleplayHost").then((module) => ({ default: module.RoleplayHost })));

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function shouldShowCinematicIntro(): boolean {
  if (typeof window === "undefined") return false;
  const introMode = new URLSearchParams(window.location.search).get("intro");
  if (introMode === "1" || introMode === "preview") return true;
  if (introMode === "0" || window.matchMedia("(max-width: 1180px), (prefers-reduced-motion: reduce)").matches) return false;
  try {
    return window.sessionStorage.getItem("skr-cinematic-intro") !== "seen";
  } catch {
    return true;
  }
}

export default function App() {
  const focusMode = useBuilding1Store((state) => state.focusMode);
  const modelKind = useMapperStore((state) => state.modelSource.source);
  const workMode = useEvacuationStore((state) => state.workMode);
  const roleplayOn = useRoleplayStore((state) => state.phase !== "off");
  const [guideOpen, setGuideOpen] = useState(false);
  const [tutorialActive, setTutorialActive] = useState(false);
  const openGuide = () => setGuideOpen(true);
  const [cinematicIntro, setCinematicIntro] = useState(shouldShowCinematicIntro);
  const finishCinematicIntro = useCallback(() => {
    try { window.sessionStorage.setItem("skr-cinematic-intro", "seen"); } catch { /* storage can be disabled */ }
    setCinematicIntro(false);
  }, []);

  const startTutorial = () => {
    setGuideOpen(false);
    finishCinematicIntro();
    useEvacuationStore.getState().setWorkMode("simulation");
    setTutorialActive(true);
  };

  // "เล่นบทนำอีกครั้ง" (project info panel): replay the opening, sound included.
  useEffect(() => {
    const replay = () => {
      if (useEvacuationStore.getState().workMode !== "simulation") return;
      if (document.pointerLockElement) void document.exitPointerLock();
      setCinematicIntro(true);
    };
    window.addEventListener(REPLAY_INTRO_EVENT, replay);
    return () => window.removeEventListener(REPLAY_INTRO_EVENT, replay);
  }, []);

  useEffect(() => {
    // A demo interrupted by a crash or reload: put the user's map back first.
    if (recoverInterruptedDemo()) useMapperStore.getState().addToast("info", "คืนผังของคุณหลังการสาธิตที่ถูกขัดจังหวะ");
    void restoreWorkspace().catch((error) => useMapperStore.getState().addToast("error", error instanceof Error ? error.message : "คืนค่าโปรเจกต์ไม่สำเร็จ"));
  }, []);

  useEffect(() => {
    if (workMode === "simulation" && useEvacuationStore.getState().workMode === "simulation") {
      const building = useBuilding1Store.getState();
      building.setShowPopulation(false);
      building.setShowEvacuationRoute(false);
      building.setShowRoomVolumes(false);
      building.setShowRoomLabels(false);
      building.setShowStairLabels(false);
      building.setShowSportsField(true);
      building.setShowAssemblyZones(true);
      building.setShowFieldLabels(false);
      building.setShowStairs(true);
      building.setViewMode("exterior");
      const mapper = useMapperStore.getState();
      mapper.setCameraMode("isometric");
      mapper.setShowGrid(false);
      mapper.requestCameraFocus(mapper.modelSource.source === "generated" ? CAMPUS_OVERVIEW_FOCUS : window.matchMedia("(max-width: 600px)").matches ? [-19, 15, 20] : [-8, 10, 52]);
    }
  }, [workMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useMapperStore.getState();
      if (event.key === "Escape") {
        state.closeDraft();
        state.setShowShortcuts(false);
        return;
      }
      if (isTypingTarget(event.target) || document.querySelector('[role="dialog"], dialog[open]')) return;
      if (useEvacuationStore.getState().workMode === "editor" && !event.ctrlKey && !event.metaKey && !event.altKey && ["KeyG", "KeyR", "KeyT"].includes(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const mode = { KeyG: "translate", KeyR: "rotate", KeyT: "scale" } as const;
        state.setTransformMode(mode[event.code as keyof typeof mode]);
        return;
      }
      if (state.transformDragging) {
        event.preventDefault();
        if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z")) event.stopImmediatePropagation();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? state.redo() : state.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        state.redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        if (state.selectedAnnotationId) state.duplicateAnnotation(state.selectedAnnotationId);
        else if (state.selectedObjectId) state.duplicateObject(state.selectedObjectId);
        return;
      }
      if (event.key === "Delete") {
        deleteEditorSelection();
        return;
      }
      const toolByKey = { Digit1: "inspect", Digit2: "annotate", Digit3: "connect", Digit4: "measure" } as const;
      const mode = toolByKey[event.code as keyof typeof toolByKey];
      if (mode) state.setToolMode(mode);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  if (workMode === "simulation") {
    return (
      <main className="app-shell simulation-workspace">
        <section className="workspace simulation-workspace-grid">
          <div className="viewport-shell simulation-viewport-shell">
            <SceneCanvas cinematicIntro={cinematicIntro} />
            <SceneOverlays />
            <SimulationDashboard tutorialActive={tutorialActive} introActive={cinematicIntro} onStartTutorial={startTutorial} onEndTutorial={() => setTutorialActive(false)} />
            {roleplayOn && <Suspense fallback={<div className="rp-toast" role="status">กำลังเปิดโหมดสวมบท…</div>}><RoleplayHost /></Suspense>}
            <CinematicIntro active={cinematicIntro} onComplete={finishCinematicIntro} />
          </div>
        </section>
        {!cinematicIntro && <Toasts />}
        <PresentationHost />
      </main>
    );
  }

  return (
    <main className={`app-shell editor-workspace${focusMode ? " focus-mode" : ""}`}>
      <TopBar onOpenGuide={openGuide} />
      <section className="workspace">
        <LeftToolbar />
        <div className="viewport-shell" data-generated={modelKind === "generated"}>
          <SceneCanvas />
          <SceneOverlays />
          <EditorToolbar />
          <EditorDemo />
          <AutoEditorDemo />
          <button type="button" className="sim-return-button" onClick={() => useEvacuationStore.getState().setWorkMode("simulation")}>← กลับระบบจำลองการอพยพ</button>
          {modelKind === "generated" && <details className="editor-building-options"><summary>ตัวเลือกอาคารตัวอย่าง</summary><BuildingTwinPanel /></details>}
        </div>
        <InspectorPanel />
      </section>
      <footer className="footer-note">
        <span>WASD เคลื่อนกล้อง · Q/E ลง–ขึ้น · คลิกขวาค้างแล้วลากเพื่อหันมอง · ล้อเมาส์ซูม</span>
        <strong title={PROJECT_METHOD_NOTE_TH}>ย้าย G · หมุน R · ขนาด T · ย้อนกลับ Ctrl+Z</strong>
      </footer>
      <AnnotationDialog />
      <UserGuide open={guideOpen} onClose={() => setGuideOpen(false)} onStartTutorial={startTutorial} />
      <ShortcutsModal />
      <Toasts />
      <PresentationHost />
    </main>
  );
}
