import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useMapperStore } from "../../store";
import { isDefaultSimulationProject } from "../../utils/projectFiles";
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
 * Why the current project cannot drive the built-in simulator, with the fix for each.
 * Empty list = the standard Building 1 template is intact.
 */
export function useTemplateIssues(): string[] {
  const annotations = useMapperStore((s) => s.annotations);
  const connections = useMapperStore((s) => s.connections);
  const calibration = useMapperStore((s) => s.calibration);
  const objects = useMapperStore((s) => s.objects);
  const model = useMapperStore((s) => s.modelSource);
  return useMemo(() => {
    const map = {
      schema: "skr-semantic-map" as const, version: 2 as const, coordinateSpace: "model-local" as const, exportedAt: "",
      project: useMapperStore.getState().project, modelReport: null,
      annotations, connections, calibration, objects, model,
    };
    if (isDefaultSimulationProject(map)) return [];
    const issues: string[] = [];
    if (model.source !== "generated") issues.push("ใช้โมเดลที่นำเข้าเอง → หน้าแก้ไข › แท็บโมเดล › “ใช้ผังมาตรฐานอาคาร 1, 3, 4”");
    if (Object.keys(objects ?? {}).length > 0) issues.push("มีการแก้ไขวัตถุในโมเดล → หน้าแก้ไข › ใช้ Undo หรือคืนค่าวัตถุที่แก้");
    if (calibration.scale !== 1 || [...calibration.position, ...calibration.rotation].some((v) => v !== 0)) issues.push("Calibration ไม่ใช่ค่าเริ่มต้น → หน้าแก้ไข › โมเดลและ Calibration › ตั้งตำแหน่ง/หมุน 0 และสเกล 1");
    if (!issues.length) issues.push("node/edge ที่บันทึกไว้ไม่ตรงกับผังจำลองอาคาร 1, 3, 4 รุ่นปัจจุบัน");
    return issues;
  }, [annotations, calibration, connections, model, objects]);
}

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
