/**
 * “ชมการสาธิตอัตโนมัติ” — the model editor demonstrates itself, step by step, in the real editor,
 * on a temporary copy of the map:
 *
 *   overview → choose floor 5 → select and move a corridor point → rotate a no-go box →
 *   add a walkway node → connect edges (both ends shown) → check a room still reaches an assembly
 *   area → delete → undo → export a sample file.
 *
 * For every step the camera frames what is being edited (computed from its bounds, the free screen
 * area and occlusion — cameraDirector), a highlight/label/before-ghost marks it in 3D, and the card
 * says “กำลังทำอะไร” and “ผลคืออะไร” (the result is computed by the same analysis the editor uses).
 *
 * Isolation: the demo starts from a snapshot of the editor (map, history, selection, tools, view,
 * camera) and has its own undo history. While it runs, what the browser saves stays the user's
 * original map. On exit everything is put back exactly; the user's work, imported files and the
 * server are never touched. The sample export contains only the demo copy.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { create } from "zustand";
import { useMapperStore } from "../store";
import { useBuilding1Store } from "../building1/building1Store";
import { useBuilding3Store } from "../building1/building3Store";
import { useEvacuationStore } from "../simulation/simulationStore";
import { analyzeEditorMap, edgesThroughBox } from "../simulation/editorScenario";
import { applyGraphEdits } from "../simulation/graphEdits";
import { createEvacuationGraph, findPath } from "../simulation/graph";
import { modelPhysics } from "../simulation/modelPhysics";
import { cancelCameraMove, currentPose, frame, inspectView, moveCamera, onCameraInterrupt, type CameraPose } from "../camera/cameraDirector";
import { useStoryOverlay, type StoryBox, type StoryLine, type StoryMarker } from "../present/StoryOverlay3D";
import { sound } from "../audio/soundManager";
import { encodeProject } from "../utils/portableProject";
import { currentMap } from "../utils/projectFiles";
import { downloadBlob } from "../utils/download";
import type { SemanticAnnotation, SemanticConnection, SurfaceHit, Vec3 } from "../types";
import { UiIcon } from "./UiIcon";
import "./editor-demo.css";

// ---------------------------------------------------------------- sandbox
type MapperState = ReturnType<typeof useMapperStore.getState>;
const SNAPSHOT_KEYS = ["annotations", "connections", "objects", "calibration", "project", "past", "future", "selectedAnnotationId", "selectedConnectionId",
  "selectedObjectId", "toolMode", "transformMode", "transformTarget", "placementType", "snapEnabled", "draft", "connectFromId"] as const;
type Snapshot = Partial<Pick<MapperState, (typeof SNAPSHOT_KEYS)[number]>>;

interface Sandbox {
  mapper: Snapshot;
  building: { viewMode: string; selectedFloor: number; explodeFloors: boolean; showInteriorWalls: boolean };
  cutaway: number;
  workMode: "simulation" | "editor";
  camera: CameraPose | null;
  partialize: unknown;
}
let sandbox: Sandbox | null = null;
const RESTORE_KEY = "skr-auto-demo-restore";

function takeSnapshot(): Snapshot {
  const state = useMapperStore.getState() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) if (key in state) out[key] = structuredClone(state[key]);
  return out as Snapshot;
}

/** What the screen looked like before the demo started (taken before the switch into the editor). */
interface Before { workMode: WorkModeName; building: { viewMode: string; selectedFloor: number; explodeFloors: boolean; showInteriorWalls: boolean }; camera: CameraPose | null }
type WorkModeName = ReturnType<typeof useEvacuationStore.getState>["workMode"];
function captureBefore(): Before {
  const b1 = useBuilding1Store.getState();
  return { workMode: useEvacuationStore.getState().workMode, building: { viewMode: b1.viewMode, selectedFloor: b1.selectedFloor, explodeFloors: b1.explodeFloors, showInteriorWalls: b1.showInteriorWalls }, camera: currentPose() };
}

function enterSandbox(before: Before = captureBefore()) {
  if (sandbox) return;
  const persistApi = useMapperStore.persist;
  const original = persistApi.getOptions().partialize;
  sandbox = {
    mapper: takeSnapshot(),
    building: before.building,
    cutaway: useBuilding3Store.getState().cutawayFloor,
    workMode: before.workMode,
    camera: before.camera,
    partialize: original,
  };
  // What the browser saves during the demo stays the user's map (captured now), never the demo copy.
  const frozen = original ? original(useMapperStore.getState()) : undefined;
  if (frozen !== undefined) persistApi.setOptions({ partialize: () => frozen });
  try { sessionStorage.setItem(RESTORE_KEY, JSON.stringify(sandbox.mapper)); } catch { /* best effort */ }
  document.body.classList.add("skr-auto-demo");
  // The demo's own undo history starts empty.
  useMapperStore.setState({ past: [], future: [], draft: null, selectedAnnotationId: null, selectedConnectionId: null, selectedObjectId: null });
}

function leaveSandbox() {
  const saved = sandbox;
  if (!saved) return;
  sandbox = null;
  useMapperStore.setState(structuredClone(saved.mapper) as Partial<MapperState>);
  if (saved.partialize) useMapperStore.persist.setOptions({ partialize: saved.partialize as never });
  // One more write with the normal rule, so storage holds exactly the user's map.
  useMapperStore.setState({});
  const b1 = useBuilding1Store.getState();
  b1.setViewMode(saved.building.viewMode as never);
  b1.setSelectedFloor(saved.building.selectedFloor);
  b1.setExplodeFloors(saved.building.explodeFloors);
  b1.setShowInteriorWalls(saved.building.showInteriorWalls);
  useBuilding3Store.getState().setCutawayFloor(saved.cutaway);
  try { sessionStorage.removeItem(RESTORE_KEY); } catch { /* ignore */ }
  document.body.classList.remove("skr-auto-demo");
  useStoryOverlay.getState().clear();
  sound.stopSpeech();
  if (saved.workMode !== useEvacuationStore.getState().workMode) useEvacuationStore.getState().setWorkMode(saved.workMode);
  // Back in the same work mode: put the camera back too (a mode switch re-frames the scene itself).
  if (saved.camera && saved.workMode === "editor") void moveCamera(saved.camera, 900);
}

/** A crash mid-demo: the next load puts the user's map back (from this tab's session). */
export function recoverInterruptedDemo() {
  try {
    const raw = sessionStorage.getItem(RESTORE_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(RESTORE_KEY);
    useMapperStore.setState(JSON.parse(raw) as Partial<MapperState>);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- demo state
type Origin = "editor" | "guide" | "presentation";
interface AutoDemoState {
  active: boolean; step: number; playing: boolean; busy: boolean; origin: Origin;
  doing: string; result: string; pausedByCamera: boolean;
  set(patch: Partial<AutoDemoState>): void;
}
export const useAutoDemo = create<AutoDemoState>((set) => ({
  active: false, step: 0, playing: true, busy: false, origin: "editor", doing: "", result: "", pausedByCamera: false,
  set: (patch) => set(patch),
}));

const FLOOR = 5;
const MOVE_NODE = "sim-corr-pink-f5-b2";
const MOVE_BY = 1.2;
const LEFT_STAIR = "sim-stair-left-f5";
const BOX_AT = "sim-corr-pink-f5-b6";
const BOX_SIZE: Vec3 = [8, 3, 1.4];
const EDGE_ORIGINAL = "edge-pink-corr-f5-3-4";
const B3 = "sim-corr-pink-f5-b3", B4 = "sim-corr-pink-f5-b4";
const ROUTE_ROOM = "b1-f5-pink-5";
const DEMO_BOX = "demo-auto-noentry";
const DEMO_NODE = "demo-auto-node";

const mapper = () => useMapperStore.getState();
const ann = (id: string) => mapper().annotations.find((item) => item.id === id);
const pos = (id: string): Vec3 => [...(ann(id)?.position ?? [0, 0, 0])] as Vec3;
const hit = (position: Vec3): SurfaceHit => ({ position, worldPosition: position, normal: [0, 1, 0], objectName: "DEMO", objectPath: "/DEMO", materialName: "", triangleCount: 0 });
const analysis = () => {
  const m = mapper();
  return analyzeEditorMap({ annotations: m.annotations, connections: m.connections, calibration: m.calibration, objects: m.objects, model: m.modelSource }, modelPhysics);
};
function boxCorners(center: Vec3, size: Vec3): Vec3[] {
  const [x, y, z] = center, [w, h, d] = size.map((v) => v / 2);
  return [[x - w, y - h, z - d], [x + w, y + h, z + d], [x - w, y + h, z + d], [x + w, y - h, z - d]];
}
function addAnnotation(type: SemanticAnnotation["type"], id: string, name: string, position: Vec3, size: Vec3, extra: Partial<SemanticAnnotation> = {}) {
  const snap = mapper().snapEnabled;
  if (snap) mapper().setSnapEnabled(false);
  mapper().openDraftFromHit(hit(position), type);
  mapper().updateDraft({ name, shape: type === "restricted-area" ? "box" : "point", size, ...extra });
  mapper().saveDraft();
  if (snap) mapper().setSnapEnabled(true);
  // Give the new item a stable id so later steps (and checks) can find it.
  const created = mapper().selectedAnnotationId;
  if (created && created !== id) {
    useMapperStore.setState((state) => ({
      annotations: state.annotations.map((item) => (item.id === created ? { ...item, id } : item)),
      connections: state.connections.map((edge) => ({ ...edge, fromId: edge.fromId === created ? id : edge.fromId, toId: edge.toId === created ? id : edge.toId })),
      selectedAnnotationId: id,
    }));
  }
}
let edgeNames: Map<string, string> | null = null;
function edgeLabel(id: string) {
  if (!edgeNames) {
    const graph = createEvacuationGraph();
    const names = new Map(graph.nodes.map((node) => [node.id, node.name]));
    edgeNames = new Map(graph.edges.map((edge) => [edge.id, `${names.get(edge.from)} → ${names.get(edge.to)}`]));
  }
  return edgeNames.get(id) ?? id;
}
function routeFromRoom() {
  const m = mapper();
  const a = analysis();
  const graph = applyGraphEdits(createEvacuationGraph(), a.scenario.graphEdits);
  const closed = new Set([...a.scenario.disabledEdgeIds, ...a.scenario.restricted.flatMap((area) => area.edgeIds)]);
  const goals = graph.nodes.filter((node) => node.type === "assembly").map((node) => node.id);
  const path = findPath(graph, ROUTE_ROOM, goals, EXAMPLE_ROUTE_CONFIG, [], 0, new Map(), closed);
  void m;
  if (!path) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return { path, points: path.nodeIds.map((id) => nodes.get(id)!.position), goal: nodes.get(path.goalId)!.name, usesNew: path.edgeIds.some((id) => !createEvacuationGraph().edges.some((edge) => edge.id === id)), analysis: a };
}
const EXAMPLE_ROUTE_CONFIG = {
  populationTarget: 3000, preset: "balanced" as const, walkingSpeed: 1.32, responseDelayMin: 3, responseDelayMax: 10, rerouteInterval: 1.25,
  distanceWeight: 0.28, timeWeight: 1, congestionWeight: 20, fireWeight: 4200, smokeWeight: 1250, fireSpreadEnabled: true, crowdBehavior: "grouped" as const,
  ambientTemperatureC: 29, heatAvoidThresholdC: 44, hardBlockTemperatureC: 62, thermalLookAheadEdges: 10, thermalWeight: 2400, seed: 1, decisionMode: "occupant" as const,
};

interface DemoStep {
  title: string;
  /** Do the edit (idempotent from the step's starting snapshot); returns the result text. */
  act(): string;
  /** World points the camera must show. */
  targets(): Vec3[];
  preferTop?: boolean;
  /** The whole building, or floor 5 on its own. */
  view: "exterior" | "floor";
  /** 3D marks for this step. */
  overlay(): { lines?: StoryLine[]; markers?: StoryMarker[]; boxes?: StoryBox[] };
  doing: string;
  holdMs?: number;
}

let movedFrom: Vec3 | null = null;

const STEPS: DemoStep[] = [
  {
    title: "ภาพรวมอาคาร", view: "exterior", doing: "เริ่มจากภาพรวม: อาคาร 1, 3, 4 และจุดรวมพล — ผังนี้คือโครงข่ายที่ระบบจำลองใช้เดิน",
    act: () => { return "นี่คือสำเนาชั่วคราว การแก้ทั้งหมดในเดโมจะไม่บันทึกทับงานของคุณ"; },
    targets: () => [[-58, 0, -12], [12, 0, -12], [12, 0, 58], [-58, 34, 12]],
    overlay: () => ({}),
  },
  {
    title: "เลือกชั้น 5", view: "floor", doing: "เปิดมุมมองทีละชั้นแล้วเลือกชั้น 5 เพื่อเห็นห้อง ทางเดิน และบันไดของชั้นนั้น",
    act: () => { return "เห็นเฉพาะชั้น 5: โถงปีกซ้าย 6 ช่วง บันไดซ้าย และแกนกลาง"; },
    targets: () => [pos("sim-corr-pink-f5-b1"), pos("sim-corr-pink-f5-b6"), pos(LEFT_STAIR)], preferTop: false,
    overlay: () => ({ markers: ["sim-corr-pink-f5-b1", "sim-corr-pink-f5-b3", "sim-corr-pink-f5-b6"].map((id) => ({ id, position: pos(id), kind: "node" as const, label: ann(id)?.name })) }),
  },
  {
    title: "เลือกและย้ายจุดทางเดิน", view: "floor", doing: `เลือกจุด “${"โถงปีกซ้าย ชั้น 5 ช่วง 2"}” แล้วย้าย ${MOVE_BY} ม. ไปตามโถง (เครื่องมือ “ย้าย”)`,
    act: () => {
      movedFrom = pos(MOVE_NODE);
      mapper().selectAnnotation(MOVE_NODE);
      mapper().setTransformMode("translate");
      mapper().updateAnnotation(MOVE_NODE, { locked: false });
      mapper().updateAnnotation(MOVE_NODE, { position: [movedFrom[0] + MOVE_BY, movedFrom[1], movedFrom[2]] });
      const a = analysis();
      return a.runnable ? `ระบบตรวจพื้นและผนังจากโมเดลแล้ว: ทางที่ต่อกับจุดนี้ยังเดินได้ ✓ (${a.applied.find((line) => line.startsWith("ย้ายจุด")) ?? "ย้ายจุด 1 จุด"})` : `ระบบไม่ยอม: ${a.blockers[0]}`;
    },
    targets: () => [movedFrom ?? pos(MOVE_NODE), pos(MOVE_NODE), pos("sim-door-b1-f5-pink-2")],
    overlay: () => ({
      markers: [{ id: "ghost", position: movedFrom ?? pos(MOVE_NODE), kind: "ghost", label: "ก่อนย้าย" }, { id: "after", position: pos(MOVE_NODE), kind: "new", label: "หลังย้าย" }],
      lines: [{ id: "move-arrow", points: [movedFrom ?? pos(MOVE_NODE), pos(MOVE_NODE)], color: "#4fd6a0", width: 4, revealMs: 700 }],
    }),
  },
  {
    title: "หมุนพื้นที่ห้ามผ่าน", view: "floor", doing: "วางกล่อง “พื้นที่ห้ามผ่าน” ที่โถงช่วง 6 หน้าบันไดซ้าย แล้วหมุน 90° (เครื่องมือ “หมุน”)",
    act: () => {
      const at = pos(BOX_AT);
      if (!ann(DEMO_BOX)) addAnnotation("restricted-area", DEMO_BOX, "ห้ามผ่าน (เดโม)", at, BOX_SIZE);
      const before = new Set(edgesThroughBox({ position: at, rotation: [0, 0, 0], size: BOX_SIZE }));
      mapper().selectAnnotation(DEMO_BOX);
      mapper().setTransformMode("rotate");
      mapper().updateAnnotation(DEMO_BOX, { rotation: [0, Math.PI / 2, 0] });
      const after = new Set(edgesThroughBox({ position: at, rotation: [0, Math.PI / 2, 0], size: BOX_SIZE }));
      const added = [...after].filter((id) => !before.has(id)).map(edgeLabel), reopened = [...before].filter((id) => !after.has(id)).map(edgeLabel);
      return `ก่อนหมุนปิด ${before.size} ช่วง · หลังหมุนปิด ${after.size} ช่วง${added.length ? ` · ปิดเพิ่ม: ${added.join(", ")}` : ""}${reopened.length ? ` · เปิดคืน: ${reopened.join(", ")}` : ""} (ทางเข้าบันไดซ้ายยังถูกปิด)`;
    },
    targets: () => boxCorners(pos(DEMO_BOX), [8, 3, 8]),
    overlay: () => ({ boxes: [{ id: "box", center: pos(DEMO_BOX), size: [BOX_SIZE[2], BOX_SIZE[1], BOX_SIZE[0]], color: "#ff5a36", label: "พื้นที่ห้ามผ่าน (หมุนแล้ว)" }] }),
  },
  {
    title: "เพิ่มจุดทางเดิน (Node)", view: "floor", doing: "เพิ่ม “จุดนำทาง” ใหม่ในโถงระหว่างช่วง 3 และ 4 ชิดด้านราว",
    act: () => {
      if (!ann(DEMO_NODE)) {
        const a = pos(B3), b = pos(B4);
        addAnnotation("navigation-node", DEMO_NODE, "จุดทางเดินใหม่ (เดโม)", [(a[0] + b[0]) / 2, a[1], a[2] + 0.9], [1, 1, 1], { capacity: 20 });
      }
      return "จุดนี้ยังไม่ต่อกับทางใด จึงยังไม่มีผลกับการเดิน (ขั้นต่อไปจะเชื่อมเส้นทาง)";
    },
    targets: () => [pos(DEMO_NODE), pos(B3), pos(B4)],
    overlay: () => ({ markers: [{ id: "new", position: pos(DEMO_NODE), kind: "new", label: "Node ใหม่" }, { id: "b3", position: pos(B3), kind: "node", label: "ช่วง 3" }, { id: "b4", position: pos(B4), kind: "node", label: "ช่วง 4" }] }),
  },
  {
    title: "เชื่อมเส้นทาง (Edge)", view: "floor", doing: "เชื่อม ช่วง 3 → Node ใหม่ → ช่วง 4 และปิดเส้นตรงเดิมระหว่างช่วง 3–4 ให้คนต้องเดินผ่านจุดใหม่",
    act: () => {
      const has = (from: string, to: string) => mapper().connections.some((edge) => edge.fromId === from && edge.toId === to);
      if (!has(B3, DEMO_NODE)) mapper().addConnection(B3, DEMO_NODE);
      if (!has(DEMO_NODE, B4)) mapper().addConnection(DEMO_NODE, B4);
      for (const edge of mapper().connections) if ((edge.fromId === B3 && edge.toId === DEMO_NODE) || (edge.fromId === DEMO_NODE && edge.toId === B4)) mapper().updateConnection(edge.id, { width: 2.2, bidirectional: true });
      mapper().updateConnection(EDGE_ORIGINAL, { enabled: false });
      mapper().selectAnnotation(null);
      const a = analysis();
      return a.runnable ? "ระบบตรวจแล้ว: ทั้งสองเส้นมีพื้นรองรับและไม่ชนผนัง ✓ ใช้ในการจำลองได้" : `ระบบไม่ยอม: ${a.blockers[0]}`;
    },
    targets: () => [pos(B3), pos(DEMO_NODE), pos(B4)],
    overlay: () => ({
      lines: [{ id: "e1", points: [pos(B3), pos(DEMO_NODE)], color: "#4fd6a0", revealMs: 900, label: "Edge ใหม่" }, { id: "e2", points: [pos(DEMO_NODE), pos(B4)], color: "#4fd6a0", revealMs: 900 }, { id: "old", points: [pos(B3), pos(B4)], color: "#ff5a36", dashed: true, width: 3 }],
      markers: [{ id: "new", position: pos(DEMO_NODE), kind: "new", label: "Node ใหม่" }],
    }),
  },
  {
    title: "ตรวจว่าเดินถึงจุดรวมพล", view: "floor", doing: "ถามระบบหาเส้นทางจากห้อง 505 บนผังที่แก้ (บันไดซ้ายถูกกล่องห้ามผ่านปิด)",
    act: () => {
      mapper().selectAnnotation(null);
      const route = routeFromRoom();
      if (!route) return "ไม่พบเส้นทางไปจุดรวมพล — การจำลองจะนับคนห้องนี้เป็นผู้ติดค้าง";
      return `ถึง ${route.goal} ได้ · ${route.path.edgeIds.length} ช่วง · ${Math.round(route.path.distance)} ม.${route.usesNew ? " · ผ่าน Edge ใหม่ที่เพิ่ม ✓" : ""}`;
    },
    targets: () => { const route = routeFromRoom(); return route ? route.points.filter((p) => Math.abs(p[1] - pos(B3)[1]) < 1.5) : [pos(B3)]; },
    overlay: () => { const route = routeFromRoom(); return route ? { lines: [{ id: "route", points: route.points, color: "#4fd6a0", width: 8, revealMs: 2600, label: `ไป ${route.goal}` }] } : {}; },
    holdMs: 6500,
  },
  {
    title: "ลบรายการ", view: "floor", doing: "เลือกกล่องห้ามผ่านแล้วกด “ลบ”",
    act: () => {
      if (ann(DEMO_BOX)) mapper().deleteAnnotation(DEMO_BOX);
      const route = routeFromRoom();
      return `ลบแล้ว บันไดซ้ายเปิดอีกครั้ง${route ? ` · เส้นทางจากห้อง 505 ตอนนี้: ${route.path.edgeIds.length} ช่วง ไป ${route.goal}` : ""}`;
    },
    targets: () => boxCorners(pos(BOX_AT), [8, 3, 8]),
    overlay: () => ({ markers: [{ id: "deleted", position: pos(BOX_AT), kind: "ghost", label: "ลบกล่องห้ามผ่านแล้ว" }] }),
  },
  {
    title: "ย้อนกลับ (Undo)", view: "floor", doing: "กด Undo (Ctrl+Z) — ย้อนการลบเมื่อครู่",
    act: () => { if (!ann(DEMO_BOX)) mapper().undo(); return ann(DEMO_BOX) ? "กล่องห้ามผ่านกลับมาแล้ว (ประวัติแก้ไขของเดโมแยกจากงานจริงของคุณ)" : "ไม่มีรายการให้ย้อน"; },
    targets: () => boxCorners(pos(BOX_AT), [8, 3, 8]),
    overlay: () => (ann(DEMO_BOX) ? { boxes: [{ id: "box", center: pos(DEMO_BOX), size: [BOX_SIZE[2], BOX_SIZE[1], BOX_SIZE[0]], color: "#ff5a36", label: "กลับมาแล้วด้วย Undo" }] } : {}),
  },
  {
    title: "ส่งออกไฟล์ตัวอย่าง", view: "exterior", doing: "ผังที่แก้ส่งออกเป็นไฟล์ .skrproject (มี Node / Edge และ Calibration) แล้วนำเข้าในเครื่องอื่นได้",
    act: () => { return "กด “ดาวน์โหลดไฟล์ตัวอย่าง” เพื่อรับไฟล์จากสำเนาเดโมนี้เท่านั้น — งานจริงของคุณไม่ถูกส่งออกหรือแก้ไข"; },
    targets: () => [[-58, 0, -12], [12, 0, -12], [12, 0, 58], [-58, 34, 12]],
    overlay: () => ({}),
    holdMs: 7000,
  },
];

// ---------------------------------------------------------------- runner
const stepSnapshots: Array<Pick<MapperState, "annotations" | "connections" | "past" | "future">> = [];
let runToken = 0;
let advanceTimer = 0;

function snapshotNetwork() {
  const m = mapper();
  return structuredClone({ annotations: m.annotations, connections: m.connections, past: m.past, future: m.future });
}

async function runStep(index: number) {
  const token = ++runToken;
  window.clearTimeout(advanceTimer);
  const demo = useAutoDemo.getState();
  const step = STEPS[index];
  // Going back (or replaying): start this step from the state it had before.
  if (stepSnapshots[index]) useMapperStore.setState(structuredClone(stepSnapshots[index]));
  else stepSnapshots[index] = snapshotNetwork();
  stepSnapshots.length = index + 1;
  demo.set({ step: index, busy: true, doing: step.doing, result: "" });
  // The view first (the floor choice decides what is visible and what hides it), then the camera, then the edit.
  const b1 = useBuilding1Store.getState();
  if (step.view === "floor") { b1.setViewMode("single-floor"); b1.setSelectedFloor(FLOOR); } else b1.setViewMode("exterior");
  if (index <= 2) movedFrom = null;
  useStoryOverlay.getState().clear();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (token !== runToken) return;
  // Camera trouble must never freeze the demo: the edit and its explanation still happen.
  const look = async (duration: number) => {
    try {
      const pose = frame(step.targets(), { preferTop: step.preferTop });
      if (pose && !pose.reused) await moveCamera(pose, duration);
    } catch { /* camera trouble: the step still runs and explains itself */ }
  };
  await look(1500);
  if (token !== runToken) return;
  void sound.speak(step.doing);
  let result: string;
  try { result = step.act(); } catch (error) { result = `ขั้นนี้ทำไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`; }
  try { useStoryOverlay.getState().set(step.overlay()); } catch { /* marks are optional */ }
  // After the edit the subject may have moved: keep it framed (the same view if it still fits).
  await look(900);
  if (token !== runToken) return;
  useAutoDemo.getState().set({ busy: false, result });
  scheduleAdvance(step.holdMs ?? 4800);
}

function scheduleAdvance(ms: number) {
  window.clearTimeout(advanceTimer);
  const demo = useAutoDemo.getState();
  if (!demo.playing || !demo.active) return;
  advanceTimer = window.setTimeout(() => {
    const now = useAutoDemo.getState();
    if (!now.playing || !now.active || now.busy) return;
    if (now.step < STEPS.length - 1) void runStep(now.step + 1);
    else now.set({ playing: false });
  }, ms);
}

export function startAutoEditorDemo(origin: Origin = "editor") {
  if (useAutoDemo.getState().active) return;
  const before = captureBefore();
  if (useEvacuationStore.getState().workMode !== "editor") useEvacuationStore.getState().setWorkMode("editor");
  // The editor's scene mounts on the next frames; the wall/floor check needs the whole building in
  // view once (captured before the demo switches to a single floor). Start when both are ready.
  useBuilding1Store.getState().setViewMode("exterior");
  const startedAt = performance.now();
  const begin = () => {
    if (!modelPhysics() && performance.now() - startedAt < 12000) { window.setTimeout(begin, 300); return; }
    enterSandbox(before);
    stepSnapshots.length = 0;
    movedFrom = null;
    useAutoDemo.getState().set({ active: true, step: 0, playing: true, origin, pausedByCamera: false });
    void runStep(0);
  };
  window.setTimeout(begin, 350);
}

export function stopAutoEditorDemo() {
  runToken += 1;
  window.clearTimeout(advanceTimer);
  cancelCameraMove();
  const origin = useAutoDemo.getState().origin;
  useAutoDemo.getState().set({ active: false, busy: false, playing: false });
  leaveSandbox();
  stepSnapshots.length = 0;
  movedFrom = null;
  window.dispatchEvent(new CustomEvent("skr:auto-demo-ended", { detail: { origin } }));
}

export function exportDemoSample() {
  const blob = encodeProject(currentMap(), null);
  downloadBlob("ตัวอย่างสาธิต-แก้ไขโมเดล.skrproject", blob);
}

// ---------------------------------------------------------------- UI
export function AutoEditorDemo() {
  const demo = useAutoDemo();
  const panelRef = useRef<HTMLElement>(null);
  const workMode = useSyncExternalStore(useEvacuationStore.subscribe, () => useEvacuationStore.getState().workMode);

  useEffect(() => {
    if (!demo.active) return;
    // The viewer grabbed the camera: pause; "เล่นต่อ" re-frames from wherever the camera is now.
    const off = onCameraInterrupt(() => {
      runToken += 1;
      window.clearTimeout(advanceTimer);
      useAutoDemo.getState().set({ playing: false, pausedByCamera: true, busy: false });
    });
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); stopAutoEditorDemo(); }
    };
    window.addEventListener("keydown", keys, true);
    panelRef.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    return () => { off(); window.removeEventListener("keydown", keys, true); };
  }, [demo.active]);

  useEffect(() => () => { if (useAutoDemo.getState().active) stopAutoEditorDemo(); }, []);

  if (!demo.active || workMode !== "editor") return null;
  const step = STEPS[demo.step];
  const last = demo.step === STEPS.length - 1;
  return (
    <section ref={panelRef} className="auto-demo" role="dialog" aria-modal="false" aria-labelledby="auto-demo-title" data-camera-inset="left" data-step={demo.step + 1}>
      <header>
        <span className="auto-demo-badge">การสาธิตอัตโนมัติ · สำเนาชั่วคราว</span>
        <span>{demo.step + 1} / {STEPS.length}</span>
      </header>
      <div className="editor-demo-progress" aria-hidden="true">{STEPS.map((item, index) => <i key={item.title} className={index <= demo.step ? "is-on" : ""} />)}</div>
      <h2 id="auto-demo-title" tabIndex={-1}>{step.title}</h2>
      <p className="auto-demo-doing"><b>กำลังทำ</b>{demo.doing}</p>
      <p className={`auto-demo-result${demo.result ? " is-shown" : ""}`} role="status" aria-live="polite"><b>ผล</b>{demo.busy ? "กำลังจัดกล้องและแก้ไข…" : demo.result}</p>
      {demo.pausedByCamera && <p className="auto-demo-note">พักไว้เพราะคุณหมุนกล้องเอง — กด “เล่นต่อ” แล้วกล้องจะจัดมุมจากตำแหน่งปัจจุบัน</p>}
      {last && !demo.busy && <button type="button" className="auto-demo-export" onClick={exportDemoSample}><UiIcon name="download" size={16} />ดาวน์โหลดไฟล์ตัวอย่าง</button>}
      <div className="auto-demo-actions">
        <button type="button" disabled={demo.step === 0} onClick={() => { useAutoDemo.getState().set({ pausedByCamera: false }); void runStep(demo.step - 1); }} aria-label="ย้อนขั้น"><UiIcon name="chevronLeft" size={16} />ย้อน</button>
        {demo.playing
          ? <button type="button" onClick={() => { runToken += 1; window.clearTimeout(advanceTimer); useAutoDemo.getState().set({ playing: false, busy: false }); }}><UiIcon name="pause" size={16} />พัก</button>
          : <button type="button" className="is-primary" onClick={() => { useAutoDemo.getState().set({ playing: true, pausedByCamera: false }); void runStep(demo.step); }}><UiIcon name="play" size={16} />เล่นต่อ</button>}
        <button type="button" disabled={last} onClick={() => { useAutoDemo.getState().set({ pausedByCamera: false }); void runStep(demo.step + 1); }} aria-label="ข้ามไปขั้นถัดไป"><UiIcon name="skip" size={16} />ข้าม</button>
        <button type="button" className="auto-demo-exit" onClick={stopAutoEditorDemo}><UiIcon name="close" size={16} />ออก</button>
      </div>
    </section>
  );
}

/** For checks: the steps' titles and the demo's own internals. */
export const AUTO_DEMO_STEPS = STEPS.map((step) => step.title);
/** For automated checks (?qa): is the current step's subject inside the unobstructed view? */
function inspectCurrentStep() {
  const demo = useAutoDemo.getState();
  if (!demo.active) return null;
  const view = inspectView(STEPS[demo.step].targets());
  return view ? { step: demo.step + 1, allInside: view.inside, occluded: view.occluded } : null;
}
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("qa")) (window as unknown as { __skrAutoDemo: unknown }).__skrAutoDemo = { inspect: inspectCurrentStep };

export const __autoDemo = { runStep, snapshot: () => sandbox, analysis, routeFromRoom, ids: { MOVE_NODE, DEMO_BOX, DEMO_NODE, B3, B4, EDGE_ORIGINAL, ROUTE_ROOM }, pos };
// Keep a reference to types used only in signatures.
export type { SemanticConnection };
