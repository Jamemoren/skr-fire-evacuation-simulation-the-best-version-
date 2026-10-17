import { useCallback, useEffect, useState } from "react";
import { DIGITAL_MODEL_NAME_TH, GENERATED_MODEL_HASH, PROJECT_METHOD_NOTE_TH, PROJECT_NAME_TH } from "./projectIdentity";
import { AnnotationDialog } from "./components/AnnotationDialog";
import { OnboardingModal, ShortcutsModal } from "./components/GuideModals";
import { InspectorPanel } from "./components/InspectorPanel";
import { LeftToolbar } from "./components/LeftToolbar";
import { SceneOverlays, Toasts } from "./components/Overlays";
import { SceneCanvas } from "./components/SceneCanvas";
import { CinematicIntro } from "./components/CinematicIntro";
import { TopBar } from "./components/TopBar";
import { BuildingTwinPanel } from "./building1/BuildingTwinPanel";
import { buildGeneratedSemanticMap } from "./simulation/semanticGraph";
import { useBuilding1Store } from "./building1/building1Store";
import { useMapperStore } from "./store";
import { SimulationDashboard } from "./simulation/SimulationDashboard";
import { useEvacuationStore } from "./simulation/simulationStore";

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
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
  const workMode = useEvacuationStore((state) => state.workMode);
  const [cinematicIntro, setCinematicIntro] = useState(shouldShowCinematicIntro);
  const finishCinematicIntro = useCallback(() => {
    try { window.sessionStorage.setItem("skr-cinematic-intro", "seen"); } catch { /* storage can be disabled */ }
    setCinematicIntro(false);
  }, []);

  useEffect(() => {
    const state = useMapperStore.getState();
    const previousSourceHash = state.modelSource?.sha256 ?? "";
    const modelHash = GENERATED_MODEL_HASH;
    const hasCurrentSemanticTopology = state.annotations.some((item) => item.id === "sim-field-gate")
      && state.annotations.some((item) => item.id === "sim-zone-a")
      && state.connections.some((item) => item.id === "edge-left-field-gate")
      && state.project.name === PROJECT_NAME_TH;
    state.setModelLoading(true);
    state.setModelUrl(null);
    state.setModelSource({
      name: DIGITAL_MODEL_NAME_TH,
      size: 0,
      sha256: modelHash,
      source: "generated",
    });
    if (state.annotations.length === 0 || !hasCurrentSemanticTopology || previousSourceHash !== modelHash) {
      state.importMap(buildGeneratedSemanticMap());
    }
    state.setModelLoading(false);
  }, []);

  useEffect(() => {
    if (workMode === "simulation") {
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
      mapper.requestCameraFocus(window.matchMedia("(max-width: 600px)").matches ? [-19, 15, 20] : [-8, 10, 52]);
    }
  }, [workMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useMapperStore.getState();
      if (event.key === "Escape") {
        state.closeDraft();
        state.setShowOnboarding(false);
        state.setShowShortcuts(false);
        return;
      }
      if (isTypingTarget(event.target)) return;
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
        return;
      }
      if (event.key === "Delete") {
        if (state.selectedAnnotationId && window.confirm("ลบตำแหน่งที่เลือกหรือไม่?")) state.deleteAnnotation(state.selectedAnnotationId);
        else if (state.selectedConnectionId && window.confirm("ลบเส้นเชื่อมที่เลือกหรือไม่?")) state.deleteConnection(state.selectedConnectionId);
        return;
      }
      const toolByKey = { Digit1: "inspect", Digit2: "annotate", Digit3: "connect", Digit4: "measure" } as const;
      const mode = toolByKey[event.code as keyof typeof toolByKey];
      if (mode) state.setToolMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (workMode === "simulation") {
    return (
      <main className="app-shell simulation-workspace">
        <section className="workspace simulation-workspace-grid">
          <div className="viewport-shell simulation-viewport-shell">
            <SceneCanvas cinematicIntro={cinematicIntro} />
            <SceneOverlays />
            <SimulationDashboard />
            <CinematicIntro active={cinematicIntro} onComplete={finishCinematicIntro} />
          </div>
        </section>
        {!cinematicIntro && <Toasts />}
      </main>
    );
  }

  return (
    <main className={focusMode ? "app-shell focus-mode" : "app-shell"}>
      <TopBar />
      <section className="workspace">
        <LeftToolbar />
        <div className="viewport-shell">
          <SceneCanvas />
          <SceneOverlays />
          <button type="button" className="sim-return-button" onClick={() => useEvacuationStore.getState().setWorkMode("simulation")}>← กลับระบบจำลองการอพยพ</button>
          <BuildingTwinPanel />
        </div>
        <InspectorPanel />
      </section>
      <footer className="footer-note">
        <span>แบบจำลองการอพยพอาคารเรียน 9 ชั้น · ประชากรจำลอง 3,000 คน · พิจารณาไฟ ควัน ความร้อน และความหนาแน่น</span>
        <strong>{PROJECT_METHOD_NOTE_TH}</strong>
      </footer>
      <AnnotationDialog />
      <OnboardingModal />
      <ShortcutsModal />
      <Toasts />
    </main>
  );
}
