import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_PEOPLE_PER_ROOM,
  STORAGE_KEY,
  TARGET_POPULATION,
} from "./constants";
import { DIGITAL_MODEL_NAME_TH, GENERATED_MODEL_HASH, PROJECT_DESCRIPTION_TH, PROJECT_NAME_TH, SCHOOL_NAME_TH } from "./projectIdentity";
import type {
  AnnotationDraft,
  AnnotationType,
  Calibration,
  CameraMode,
  MeasurementState,
  ModelReport,
  ModelSourceInfo,
  ProjectInfo,
  SemanticAnnotation,
  SemanticConnection,
  SemanticMapFile,
  SurfaceHit,
  ToolMode,
  Vec3,
} from "./types";
import { snapVec3 } from "./utils/coordinates";
import { createId } from "./utils/id";

interface ToastMessage {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

interface MapSnapshot {
  annotations: SemanticAnnotation[];
  connections: SemanticConnection[];
  calibration: Calibration;
}

interface MapperState {
  project: ProjectInfo;
  modelUrl: string | null;
  modelSource: ModelSourceInfo;
  modelReport: ModelReport | null;
  modelLoading: boolean;
  modelError: string | null;
  calibration: Calibration;
  cameraMode: CameraMode;
  toolMode: ToolMode;
  placementType: AnnotationType;
  godSpeed: number;
  showGrid: boolean;
  showLabels: boolean;
  showModel: boolean;
  modelOpacity: number;
  snapEnabled: boolean;
  snapSize: number;
  hiddenTypes: AnnotationType[];
  targetHit: SurfaceHit | null;
  inspectedHit: SurfaceHit | null;
  draft: AnnotationDraft | null;
  annotations: SemanticAnnotation[];
  connections: SemanticConnection[];
  selectedAnnotationId: string | null;
  selectedConnectionId: string | null;
  connectFromId: string | null;
  measurement: MeasurementState;
  cameraFocus: Vec3 | null;
  cameraFocusToken: number;
  showOnboarding: boolean;
  showShortcuts: boolean;
  past: MapSnapshot[];
  future: MapSnapshot[];
  toasts: ToastMessage[];

  patchProject: (patch: Partial<ProjectInfo>) => void;
  setModelUrl: (url: string | null) => void;
  setModelSource: (source: ModelSourceInfo) => void;
  setModelReport: (report: ModelReport | null) => void;
  setModelLoading: (loading: boolean) => void;
  setModelError: (error: string | null) => void;
  setCalibration: (calibration: Calibration) => void;
  patchCalibration: (patch: Partial<Calibration>) => void;
  setCameraMode: (mode: CameraMode) => void;
  setToolMode: (mode: ToolMode) => void;
  setPlacementType: (type: AnnotationType) => void;
  setGodSpeed: (speed: number) => void;
  setShowGrid: (value: boolean) => void;
  setShowLabels: (value: boolean) => void;
  setShowModel: (value: boolean) => void;
  setModelOpacity: (value: number) => void;
  setSnapEnabled: (value: boolean) => void;
  setSnapSize: (value: number) => void;
  toggleTypeVisibility: (type: AnnotationType) => void;
  setTargetHit: (hit: SurfaceHit | null) => void;
  setInspectedHit: (hit: SurfaceHit | null) => void;
  openDraftFromHit: (hit: SurfaceHit, type?: AnnotationType) => void;
  updateDraft: (patch: Partial<AnnotationDraft>) => void;
  closeDraft: () => void;
  saveDraft: () => void;
  updateAnnotation: (id: string, patch: Partial<SemanticAnnotation>) => void;
  duplicateAnnotation: (id: string) => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  handleAnnotationClick: (id: string) => void;
  addConnection: (fromId: string, toId: string) => void;
  updateConnection: (id: string, patch: Partial<SemanticConnection>) => void;
  selectConnection: (id: string | null) => void;
  deleteConnection: (id: string) => void;
  setMeasurementPoint: (position: Vec3) => void;
  clearMeasurement: () => void;
  clearMap: () => void;
  distributePopulation: () => void;
  importMap: (map: SemanticMapFile) => void;
  requestCameraFocus: (position: Vec3) => void;
  setShowOnboarding: (value: boolean) => void;
  setShowShortcuts: (value: boolean) => void;
  undo: () => void;
  redo: () => void;
  addToast: (kind: ToastMessage["kind"], text: string) => void;
  removeToast: (id: string) => void;
}

const DEFAULT_CALIBRATION: Calibration = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
};

const now = () => new Date().toISOString();

const DEFAULT_PROJECT: ProjectInfo = {
  name: PROJECT_NAME_TH,
  schoolName: SCHOOL_NAME_TH,
  description: PROJECT_DESCRIPTION_TH,
  createdAt: now(),
  updatedAt: now(),
};

function defaultDraft(hit: SurfaceHit, type: AnnotationType): AnnotationDraft {
  const defaultNameByType: Record<AnnotationType, string> = {
    building: "อาคาร",
    floor: "ชั้น",
    classroom: "ห้องเรียน",
    door: "ประตู",
    stair: "บันได",
    exit: "ทางออก",
    hallway: "ทางเดิน",
    "navigation-node": "จุดนำทาง",
    "assembly-area": "จุดรวมพล",
    "football-field": "สนามฟุตบอล",
    "restricted-area": "พื้นที่ห้ามผ่าน",
    "fire-source": "จุดจำลองไฟ",
    custom: "ตำแหน่ง",
  };
  const boxTypes: AnnotationType[] = [
    "building",
    "floor",
    "classroom",
    "hallway",
    "assembly-area",
    "football-field",
    "restricted-area",
  ];
  const defaultSize: Record<AnnotationType, Vec3> = {
    building: [30, 15, 20],
    floor: [25, 3.5, 18],
    classroom: [8, 3, 8],
    door: [1.5, 2.2, 0.25],
    stair: [3, 4, 5],
    exit: [2, 2.5, 0.3],
    hallway: [12, 3, 2.5],
    "navigation-node": [1, 1, 1],
    "assembly-area": [20, 1, 20],
    "football-field": [105, 1, 68],
    "restricted-area": [10, 3, 10],
    "fire-source": [1, 1, 1],
    custom: [2, 2, 2],
  };

  return {
    hit,
    type,
    shape: boxTypes.includes(type) ? "box" : "point",
    name: defaultNameByType[type],
    buildingId: "",
    floor: null,
    peopleCount: type === "classroom" ? DEFAULT_PEOPLE_PER_ROOM : 0,
    capacity: type === "football-field" ? TARGET_POPULATION : 0,
    size: defaultSize[type],
    notes: "",
    tagsText: "",
  };
}

function snapshot(state: MapperState): MapSnapshot {
  return {
    annotations: structuredClone(state.annotations),
    connections: structuredClone(state.connections),
    calibration: structuredClone(state.calibration),
  };
}

export const useMapperStore = create<MapperState>()(
  persist(
    (set, get) => {
      const commit = (patcher: (state: MapperState) => Partial<MapperState>) => {
        set((state) => {
          const patch = patcher(state);
          return {
            ...patch,
            past: [...state.past.slice(-49), snapshot(state)],
            future: [],
            project: patch.project
              ? { ...patch.project, updatedAt: now() }
              : { ...state.project, updatedAt: now() },
          };
        });
      };

      return {
        project: DEFAULT_PROJECT,
        modelUrl: null,
        modelSource: { name: DIGITAL_MODEL_NAME_TH, size: 0, sha256: GENERATED_MODEL_HASH, source: "generated" },
        modelReport: null,
        modelLoading: false,
        modelError: null,
        calibration: DEFAULT_CALIBRATION,
        cameraMode: "orbit",
        toolMode: "inspect",
        placementType: "classroom",
        godSpeed: 36,
        showGrid: true,
        showLabels: true,
        showModel: true,
        modelOpacity: 1,
        snapEnabled: false,
        snapSize: 0.5,
        hiddenTypes: [],
        targetHit: null,
        inspectedHit: null,
        draft: null,
        annotations: [],
        connections: [],
        selectedAnnotationId: null,
        selectedConnectionId: null,
        connectFromId: null,
        measurement: { start: null, end: null },
        cameraFocus: null,
        cameraFocusToken: 0,
        showOnboarding: true,
        showShortcuts: false,
        past: [],
        future: [],
        toasts: [],

        patchProject: (patch) => set((state) => ({ project: { ...state.project, ...patch, updatedAt: now() } })),
        setModelUrl: (modelUrl) => set({ modelUrl }),
        setModelSource: (modelSource) => set({ modelSource }),
        setModelReport: (modelReport) => set({ modelReport }),
        setModelLoading: (modelLoading) => set({ modelLoading }),
        setModelError: (modelError) => set({ modelError }),
        setCalibration: (calibration) => commit(() => ({ calibration })),
        patchCalibration: (patch) => commit((state) => ({ calibration: { ...state.calibration, ...patch } })),
        setCameraMode: (cameraMode) => set({ cameraMode }),
        setToolMode: (toolMode) => set({
          toolMode,
          connectFromId: toolMode === "connect" ? get().connectFromId : null,
          measurement: toolMode === "measure" ? get().measurement : { start: null, end: null },
        }),
        setPlacementType: (placementType) => set({ placementType, toolMode: "annotate" }),
        setGodSpeed: (godSpeed) => set({ godSpeed }),
        setShowGrid: (showGrid) => set({ showGrid }),
        setShowLabels: (showLabels) => set({ showLabels }),
        setShowModel: (showModel) => set({ showModel }),
        setModelOpacity: (modelOpacity) => set({ modelOpacity }),
        setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
        setSnapSize: (snapSize) => set({ snapSize: Math.max(0.001, snapSize) }),
        toggleTypeVisibility: (type) => set((state) => ({
          hiddenTypes: state.hiddenTypes.includes(type)
            ? state.hiddenTypes.filter((item) => item !== type)
            : [...state.hiddenTypes, type],
        })),
        setTargetHit: (targetHit) => set({ targetHit }),
        setInspectedHit: (inspectedHit) => set({ inspectedHit }),
        openDraftFromHit: (hit, type) => set({ draft: defaultDraft(hit, type ?? get().placementType) }),
        updateDraft: (patch) => set((state) => ({ draft: state.draft ? { ...state.draft, ...patch } : null })),
        closeDraft: () => set({ draft: null }),
        saveDraft: () => {
          const state = get();
          const draft = state.draft;
          if (!draft) return;
          const timestamp = now();
          const position = state.snapEnabled
            ? snapVec3(draft.hit.position, state.snapSize)
            : draft.hit.position;
          const annotation: SemanticAnnotation = {
            id: createId("annotation"),
            type: draft.type,
            shape: draft.shape,
            name: draft.name.trim() || "ตำแหน่งไม่มีชื่อ",
            position,
            rotation: [0, 0, 0],
            size: draft.size.map((value) => Math.max(0.01, value)) as Vec3,
            buildingId: draft.buildingId.trim(),
            floor: draft.floor,
            peopleCount: Math.max(0, Math.round(draft.peopleCount)),
            capacity: Math.max(0, draft.capacity),
            notes: draft.notes.trim(),
            tags: draft.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
            visible: true,
            locked: false,
            sourceObjectName: draft.hit.objectName,
            sourceObjectPath: draft.hit.objectPath,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          commit((current) => ({
            annotations: [...current.annotations, annotation],
            selectedAnnotationId: annotation.id,
            selectedConnectionId: null,
            draft: null,
          }));
          get().addToast("success", `บันทึก “${annotation.name}” แล้ว`);
        },
        updateAnnotation: (id, patch) => commit((state) => ({
          annotations: state.annotations.map((annotation) =>
            annotation.id === id
              ? { ...annotation, ...patch, updatedAt: now() }
              : annotation,
          ),
        })),
        duplicateAnnotation: (id) => {
          const source = get().annotations.find((annotation) => annotation.id === id);
          if (!source) return;
          const duplicate: SemanticAnnotation = {
            ...structuredClone(source),
            id: createId("annotation"),
            name: `${source.name} สำเนา`,
            position: [source.position[0] + 1, source.position[1], source.position[2] + 1],
            locked: false,
            createdAt: now(),
            updatedAt: now(),
          };
          commit((state) => ({ annotations: [...state.annotations, duplicate], selectedAnnotationId: duplicate.id }));
          get().addToast("success", "สร้างสำเนาตำแหน่งแล้ว");
        },
        deleteAnnotation: (id) => commit((state) => ({
          annotations: state.annotations.filter((annotation) => annotation.id !== id),
          connections: state.connections.filter((connection) => connection.fromId !== id && connection.toId !== id),
          selectedAnnotationId: state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
          connectFromId: state.connectFromId === id ? null : state.connectFromId,
        })),
        selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId, selectedConnectionId: null }),
        handleAnnotationClick: (id) => {
          const state = get();
          if (state.toolMode !== "connect") {
            set({ selectedAnnotationId: id, selectedConnectionId: null });
            return;
          }
          if (!state.connectFromId) {
            set({ connectFromId: id, selectedAnnotationId: id });
            state.addToast("info", "เลือกตำแหน่งปลายทางเพื่อเชื่อมเส้นทาง");
            return;
          }
          if (state.connectFromId === id) {
            set({ connectFromId: null });
            state.addToast("warning", "ยกเลิกจุดเริ่มต้นการเชื่อม");
            return;
          }
          state.addConnection(state.connectFromId, id);
          set({ connectFromId: null, selectedAnnotationId: id });
        },
        addConnection: (fromId, toId) => {
          const state = get();
          const exists = state.connections.some((connection) =>
            (connection.fromId === fromId && connection.toId === toId) ||
            (connection.fromId === toId && connection.toId === fromId),
          );
          if (exists) {
            state.addToast("warning", "สองตำแหน่งนี้มีเส้นเชื่อมอยู่แล้ว");
            return;
          }
          const connection: SemanticConnection = {
            id: createId("connection"),
            fromId,
            toId,
            type: "walkway",
            width: 2,
            capacityPerSecond: 2,
            bidirectional: true,
            enabled: true,
            notes: "",
          };
          commit((current) => ({
            connections: [...current.connections, connection],
            selectedConnectionId: connection.id,
          }));
          state.addToast("success", "สร้างเส้นเชื่อมแล้ว");
        },
        updateConnection: (id, patch) => commit((state) => ({
          connections: state.connections.map((connection) => connection.id === id ? { ...connection, ...patch } : connection),
        })),
        selectConnection: (selectedConnectionId) => set({ selectedConnectionId, selectedAnnotationId: null }),
        deleteConnection: (id) => commit((state) => ({
          connections: state.connections.filter((connection) => connection.id !== id),
          selectedConnectionId: state.selectedConnectionId === id ? null : state.selectedConnectionId,
        })),
        setMeasurementPoint: (position) => set((state) => ({
          measurement: !state.measurement.start || state.measurement.end
            ? { start: position, end: null }
            : { start: state.measurement.start, end: position },
        })),
        clearMeasurement: () => set({ measurement: { start: null, end: null } }),
        clearMap: () => commit(() => ({
          annotations: [],
          connections: [],
          selectedAnnotationId: null,
          selectedConnectionId: null,
          connectFromId: null,
          inspectedHit: null,
          measurement: { start: null, end: null },
        })),
        distributePopulation: () => {
          const classrooms = get().annotations.filter((annotation) => annotation.type === "classroom");
          if (classrooms.length === 0) {
            get().addToast("warning", "ยังไม่มีตำแหน่งห้องเรียน");
            return;
          }
          let remaining = TARGET_POPULATION;
          const classroomIds = new Set(classrooms.map((room) => room.id));
          commit((state) => ({
            annotations: state.annotations.map((annotation) => {
              if (!classroomIds.has(annotation.id)) return annotation;
              const count = Math.min(DEFAULT_PEOPLE_PER_ROOM, remaining);
              remaining -= count;
              return { ...annotation, peopleCount: count, updatedAt: now() };
            }),
          }));
          get().addToast(
            remaining > 0 ? "warning" : "success",
            remaining > 0
              ? `ห้องยังไม่พอ เหลือ ${remaining.toLocaleString("th-TH")} คน`
              : "กระจายคนรวม 3,000 คนแล้ว",
          );
        },
        importMap: (map) => commit(() => ({
          project: map.project,
          calibration: map.calibration,
          annotations: map.annotations,
          connections: map.connections,
          selectedAnnotationId: null,
          selectedConnectionId: null,
          connectFromId: null,
        })),
        requestCameraFocus: (cameraFocus) => set((state) => ({ cameraFocus, cameraFocusToken: state.cameraFocusToken + 1 })),
        setShowOnboarding: (showOnboarding) => set({ showOnboarding }),
        setShowShortcuts: (showShortcuts) => set({ showShortcuts }),
        undo: () => {
          const state = get();
          const previous = state.past.at(-1);
          if (!previous) return;
          set({
            annotations: previous.annotations,
            connections: previous.connections,
            calibration: previous.calibration,
            past: state.past.slice(0, -1),
            future: [snapshot(state), ...state.future].slice(0, 50),
            selectedAnnotationId: null,
            selectedConnectionId: null,
          });
        },
        redo: () => {
          const state = get();
          const next = state.future[0];
          if (!next) return;
          set({
            annotations: next.annotations,
            connections: next.connections,
            calibration: next.calibration,
            past: [...state.past, snapshot(state)].slice(-50),
            future: state.future.slice(1),
            selectedAnnotationId: null,
            selectedConnectionId: null,
          });
        },
        addToast: (kind, text) => {
          const id = createId("toast");
          set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, text }] }));
          window.setTimeout(() => get().removeToast(id), 3500);
        },
        removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
      };
    },
    {
      name: STORAGE_KEY,
      version: 2,
      partialize: (state) => ({
        project: state.project,
        modelSource: state.modelSource,
        modelReport: state.modelReport,
        calibration: state.calibration,
        godSpeed: state.godSpeed,
        showGrid: state.showGrid,
        showLabels: state.showLabels,
        showModel: state.showModel,
        modelOpacity: state.modelOpacity,
        snapEnabled: state.snapEnabled,
        snapSize: state.snapSize,
        hiddenTypes: state.hiddenTypes,
        annotations: state.annotations,
        connections: state.connections,
        showOnboarding: state.showOnboarding,
      }),
    },
  ),
);
