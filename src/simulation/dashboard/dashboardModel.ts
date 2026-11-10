import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { useMapperStore } from "../../store";
import { alignToModel, analyzeEditorMap, type EditorAnalysis } from "../editorScenario";
import { setEditorScenarioSource } from "../simulationStore";
import { modelPhysics, modelPhysicsVersion, subscribeModelPhysics } from "../modelPhysics";
import { evaluateOperationalReadiness, type OperationalReadinessReport } from "../operationalReadiness";
import type { SimulationStatus } from "../types";

export type MobilePanel = "scene" | "controls" | "metrics" | "activity";
export type ControlTab = "scenario" | "behavior" | "display";
export type MonitorTab = "bottlenecks" | "floors" | "events" | "reasons";

export const STATUS_LABEL: Record<SimulationStatus, string> = {
  idle: "พร้อมจำลอง",
  running: "กำลังจำลอง",
  paused: "หยุดชั่วคราว",
  completed: "จำลองเสร็จสิ้น",
};

export function fmtTime(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const min = Math.floor(value / 60);
  const sec = Math.floor(value % 60);
  return min > 0 ? `${min}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

export const fmtInt = (value: number) => value.toLocaleString("th-TH");

/** Operational pre-flight runs once, off the first paint. */
export function useReadiness() {
  const [report, setReport] = useState<OperationalReadinessReport | null>(null);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      const next = evaluateOperationalReadiness();
      if (active) setReport(next);
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);
  return report;
}

/**
 * Why the current project cannot drive the built-in simulator, with the fix for each. Edits the
 * simulator can honour (fire markers, no-go areas, closed passages, people per room) are not
 * issues: they are applied when the run starts (see editorScenario.ts).
 * Empty list = runnable.
 */
export function useTemplateIssues(): string[] {
  return useEditorAnalysis().blockers;
}

/** The editor map, analysed for the simulator: blockers, and what a run will apply from it. */
export function useEditorAnalysis(): EditorAnalysis {
  const annotations = useMapperStore((s) => s.annotations);
  const connections = useMapperStore((s) => s.connections);
  const calibration = useMapperStore((s) => s.calibration);
  const objects = useMapperStore((s) => s.objects);
  const model = useMapperStore((s) => s.modelSource);
  // Re-checked when the 3D collision model becomes available (moved points / new passages need it).
  const physicsVersion = useSyncExternalStore(subscribeModelPhysics, modelPhysicsVersion, modelPhysicsVersion);
  return useMemo(() => analyzeEditorMap({ annotations, connections, calibration, objects, model }, modelPhysics), [annotations, calibration, connections, model, objects, physicsVersion]);
}

/** One undoable step: structure and older-version items back to the real model; user edits kept. */
export function alignEditorMapToModel(): number {
  const state = useMapperStore.getState();
  const result = alignToModel({ annotations: state.annotations, connections: state.connections });
  if (result.changed) {
    state.replaceNetwork(result.annotations, result.connections);
    state.addToast("success", `จัดให้ตรงโมเดลจริงแล้ว ${result.changed} รายการ (ย้อนกลับได้ด้วย Undo)`);
  }
  return result.changed;
}

// The simulation store asks for the editor scenario when a run starts (fires, closures, people).
setEditorScenarioSource(() => {
  const state = useMapperStore.getState();
  const analysis = analyzeEditorMap({ annotations: state.annotations, connections: state.connections, calibration: state.calibration, objects: state.objects, model: state.modelSource }, modelPhysics);
  return analysis.runnable ? analysis.scenario : null;
});

export type StartBlock =
  | { kind: "checking" }
  | { kind: "custom"; issues: string[] }
  | { kind: "failed"; report: OperationalReadinessReport }
  | null;

export function startBlockOf(report: OperationalReadinessReport | null, templateIssues: string[]): StartBlock {
  if (templateIssues.length) return { kind: "custom", issues: templateIssues };
  if (!report) return { kind: "checking" };
  if (!report.ready) return { kind: "failed", report };
  return null;
}

export function startBlockSummary(block: StartBlock): string {
  if (!block) return "";
  if (block.kind === "checking") return "กำลังตรวจผังอาคาร ประตู บันได และเส้นทาง";
  if (block.kind === "custom") return "ผังที่ปรับแต่งเปิดใช้ในหน้าแก้ไข — ระบบจำลองหลักใช้ผังอาคาร 1, 3, 4 มาตรฐาน";
  return `ผ่านการตรวจ ${block.report.passed}/${block.report.total} — ต้องแก้รายการที่เหลือก่อน`;
}

// -----------------------------------------------------------------------------
// Free scene area, published by the dashboard and consumed by the camera.
// -----------------------------------------------------------------------------
export interface SceneInsets { left: number; right: number; top: number; bottom: number }

interface ViewportFrameState {
  insets: SceneInsets;
  setInsets: (insets: SceneInsets) => void;
}

const ZERO: SceneInsets = { left: 0, right: 0, top: 0, bottom: 0 };

export const useViewportFrameStore = create<ViewportFrameState>((set, get) => ({
  insets: ZERO,
  setInsets: (insets) => {
    const current = get().insets;
    const same = (Object.keys(insets) as Array<keyof SceneInsets>).every((key) => Math.abs(current[key] - insets[key]) < 0.5);
    if (!same) set({ insets });
  },
}));

export function resetSceneInsets() {
  useViewportFrameStore.getState().setInsets(ZERO);
}

const LAYOUT_KEY = "skr-ui-layout";
/**
 * Default: settings open, monitor folded to a rail so the model keeps ≥60% of the
 * screen. `rightChosen` marks an explicit user choice; until then the monitor opens
 * by itself when a simulation starts.
 */
export function loadPanelPrefs(): { left: boolean; right: boolean; rightChosen: boolean } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "null") as { left?: unknown; right?: unknown; rightChosen?: unknown } | null;
    const rightChosen = raw?.rightChosen === true;
    return {
      left: typeof raw?.left === "boolean" ? raw.left : true,
      right: rightChosen && typeof raw?.right === "boolean" ? raw.right : false,
      rightChosen,
    };
  } catch {
    return { left: true, right: false, rightChosen: false };
  }
}
export function savePanelPrefs(prefs: { left: boolean; right: boolean; rightChosen: boolean }) {
  try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(prefs)); } catch { /* optional */ }
}
