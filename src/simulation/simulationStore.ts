import { create } from "zustand";
import { TARGET_POPULATION } from "../building1/building1Data";
import { evacuationRuntime } from "./runtime";
import { normalizeStudentPopulation } from "./studentPlacement";
import { finiteBetween } from "../utils/numbers";
import type { CrowdBehavior, FireSource, RoutingPreset, SimulationConfig, SimulationEvent, SimulationMetrics, SimulationStatus, Vec3 } from "./types";

export type WorkMode = "simulation" | "editor";

const FIRE_PATTERN_STORAGE_KEY = "skr-building1-fire-pattern";
const DEFAULT_WALKING_SPEED = 1.32;
type StoredFireSource = Pick<FireSource, "position" | "intensity" | "fireRadius" | "smokeRadius" | "spreadRate">;

/** Never let stale or manually edited localStorage data enter the fire solver unchecked. */
function sanitizeStoredFireSource(value: unknown): StoredFireSource | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StoredFireSource>;
  if (!Array.isArray(candidate.position) || candidate.position.length !== 3) return null;
  const [rawX, rawY, rawZ] = candidate.position;
  if (![rawX, rawY, rawZ].every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  return {
    position: [
      finiteBetween(rawX, 0, -140, 140),
      finiteBetween(rawY, 1, 0, 50),
      finiteBetween(rawZ, 0, -140, 180),
    ],
    intensity: finiteBetween(candidate.intensity, 1, 0.05, 3),
    fireRadius: finiteBetween(candidate.fireRadius, 2.8, 0.2, 12),
    smokeRadius: finiteBetween(candidate.smokeRadius, 7.5, 0.5, 30),
    spreadRate: finiteBetween(candidate.spreadRate, 0.08, 0, 1),
  };
}

function normalizeWalkingSpeed(value: number, fallback = DEFAULT_WALKING_SPEED): number {
  return Number.isFinite(value) && value > 0 ? Math.max(0.01, value) : fallback;
}

function stableSnapshot<T>(current: T[], source: T[]): T[] {
  return current.length === source.length && current.every((item, index) => item === source[index]) ? current : [...source];
}

function loadFirePattern(): StoredFireSource[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FIRE_PATTERN_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.map(sanitizeStoredFireSource).filter((item): item is StoredFireSource => item !== null).slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function persistFirePattern(fires: FireSource[]) {
  if (typeof window === "undefined") return;
  const pattern: StoredFireSource[] = fires
    .filter((fire) => fire.origin === "primary")
    .map(({ position, intensity, fireRadius, smokeRadius, spreadRate }) => ({ position, intensity, fireRadius, smokeRadius, spreadRate }));
  try {
    window.localStorage.setItem(FIRE_PATTERN_STORAGE_KEY, JSON.stringify(pattern));
  } catch {
    // Private mode, storage quotas, and browser policy must not break a live drill.
  }
}

if (evacuationRuntime.fires.length === 0) {
  loadFirePattern().forEach((fire) => evacuationRuntime.addFire(fire.position, fire));
}

const EMPTY_METRICS: SimulationMetrics = {
  total: 0, arrived: 0, waiting: 0, evacuating: 0, queueing: 0, rerouting: 0, blocked: 0, incapacitated: 0,
  exposedToSmoke: 0, smokeAware: 0, heatAware: 0, exposedToHeat: 0, progress: 0, elapsed: 0, firstArrival: null, p50Arrival: null, p90Arrival: null, p95Arrival: null,
  finalArrival: null, averageArrival: null, rerouteCount: 0, thermalRerouteCount: 0, estimatedMakespan: 0, maxModeledTemperatureC: 29, blockedThermalEdges: 0, fireBlockedEdges: 0, smokeAffectedEdges: 0, maxQueue: 0, averageQueue: 0, bottlenecks: [],
  indoorAgents: 0, stairAgents: 0, outdoorAgents: 0, topologyViolations: 0, collisionCorrections: 0, peakEdgeDensity: 0,
  floorPopulation: Array.from({ length: 10 }, () => 0),
  wingPopulation: { pink: 0, blue: 0, core: 0, ground: 0, outdoor: 0, assembly: 0 },
};

interface EvacuationState {
  workMode: WorkMode;
  status: SimulationStatus;
  speedFactor: number;
  populationTarget: number;
  preset: RoutingPreset;
  walkingSpeed: number;
  responseDelayMin: number;
  responseDelayMax: number;
  rerouteInterval: number;
  crowdBehavior: CrowdBehavior;
  placeFireMode: boolean;
  showAgents: boolean;
  showRoutes: boolean;
  showFire: boolean;
  showSmoke: boolean;
  showHeatZones: boolean;
  fireSpreadEnabled: boolean;
  ambientTemperatureC: number;
  heatAvoidThresholdC: number;
  hardBlockTemperatureC: number;
  thermalLookAheadEdges: number;
  thermalWeight: number;
  metrics: SimulationMetrics;
  fires: FireSource[];
  events: SimulationEvent[];
  snapshotToken: number;
  renderFps: number;
  setWorkMode: (mode: WorkMode) => void;
  setSpeedFactor: (speed: number) => void;
  setPopulationTarget: (count: number) => void;
  setPreset: (preset: RoutingPreset) => void;
  setWalkingSpeed: (value: number) => void;
  setResponseDelays: (min: number, max: number) => void;
  setRerouteInterval: (value: number) => void;
  setCrowdBehavior: (value: CrowdBehavior) => void;
  setPlaceFireMode: (value: boolean) => void;
  setShowAgents: (value: boolean) => void;
  setShowRoutes: (value: boolean) => void;
  setShowFire: (value: boolean) => void;
  setShowSmoke: (value: boolean) => void;
  setShowHeatZones: (value: boolean) => void;
  setFireSpreadEnabled: (value: boolean) => void;
  setThermalModel: (patch: Partial<Pick<EvacuationState, "ambientTemperatureC" | "heatAvoidThresholdC" | "hardBlockTemperatureC" | "thermalLookAheadEdges" | "thermalWeight">>) => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  addFire: (position: Vec3) => void;
  addPresetFire: (preset: "left" | "center" | "right") => void;
  removeFire: (id: string) => void;
  clearFires: () => void;
  syncFromRuntime: () => void;
  setRenderFps: (value: number) => void;
}

export const useEvacuationStore = create<EvacuationState>((set, get) => ({
  workMode: "simulation",
  status: "idle",
  speedFactor: 1,
  populationTarget: TARGET_POPULATION,
  preset: "balanced",
  walkingSpeed: DEFAULT_WALKING_SPEED,
  responseDelayMin: 3,
  responseDelayMax: 10,
  rerouteInterval: 2,
  // A normal school evacuation starts with loose friend groups rather than a military queue.
  // ORDERLY remains available when an instructor explicitly wants to test that drill style.
  crowdBehavior: "grouped",
  placeFireMode: false,
  showAgents: true,
  showRoutes: false,
  showFire: true,
  showSmoke: true,
  // Scientific envelopes remain available as a debug overlay, but stay hidden by default so
  // users see object-to-object propagation rather than mistaking a heat ring for the fire front.
  showHeatZones: false,
  fireSpreadEnabled: true,
  ambientTemperatureC: 29,
  heatAvoidThresholdC: 44,
  hardBlockTemperatureC: 62,
  thermalLookAheadEdges: 10,
  thermalWeight: 2400,
  metrics: EMPTY_METRICS,
  fires: [...evacuationRuntime.fires],
  events: [...evacuationRuntime.events],
  snapshotToken: 0,
  renderFps: 0,
  setWorkMode: (workMode) => set({ workMode }),
  setSpeedFactor: (speedFactor) => set((state) => ({ speedFactor: finiteBetween(speedFactor, state.speedFactor, .25, 50) })),
  setPopulationTarget: (populationTarget) => set((state) => state.status === "running" || state.status === "paused"
    ? state : { populationTarget: normalizeStudentPopulation(populationTarget) }),
  setPreset: (preset) => set({ preset }),
  setWalkingSpeed: (walkingSpeed) => set((state) => {
    const next = normalizeWalkingSpeed(walkingSpeed, state.walkingSpeed);
    if (state.status === "running" || state.status === "paused") evacuationRuntime.setWalkingSpeed(next);
    return { walkingSpeed: next };
  }),
  setResponseDelays: (min, max) => set((state) => {
    const low = finiteBetween(min, state.responseDelayMin, 0, Number.MAX_SAFE_INTEGER);
    const high = finiteBetween(max, state.responseDelayMax, 0, Number.MAX_SAFE_INTEGER);
    return { responseDelayMin: Math.min(low, high), responseDelayMax: Math.max(low, high) };
  }),
  setRerouteInterval: (rerouteInterval) => set((state) => ({ rerouteInterval: finiteBetween(rerouteInterval, state.rerouteInterval, .5, 10) })),
  setCrowdBehavior: (crowdBehavior) => set({ crowdBehavior }),
  setPlaceFireMode: (placeFireMode) => set({ placeFireMode }),
  setShowAgents: (showAgents) => set({ showAgents }),
  setShowRoutes: (showRoutes) => set({ showRoutes }),
  setShowFire: (showFire) => set({ showFire }),
  setShowSmoke: (showSmoke) => set({ showSmoke }),
  setShowHeatZones: (showHeatZones) => set({ showHeatZones }),
  setFireSpreadEnabled: (fireSpreadEnabled) => set({ fireSpreadEnabled }),
  setThermalModel: (patch) => set((state) => {
    const ambientTemperatureC = finiteBetween(patch.ambientTemperatureC, state.ambientTemperatureC, 10, 45);
    const heatAvoidThresholdC = Math.max(ambientTemperatureC + 1, finiteBetween(patch.heatAvoidThresholdC, state.heatAvoidThresholdC, 11, 120));
    const hardBlockTemperatureC = Math.max(heatAvoidThresholdC + 1, finiteBetween(patch.hardBlockTemperatureC, state.hardBlockTemperatureC, 12, 200));
    const thermalLookAheadEdges = Math.round(finiteBetween(patch.thermalLookAheadEdges, state.thermalLookAheadEdges, 4, 20));
    const thermalWeight = finiteBetween(patch.thermalWeight, state.thermalWeight, 0, 20000);
    return { ambientTemperatureC, heatAvoidThresholdC, hardBlockTemperatureC, thermalLookAheadEdges, thermalWeight };
  }),
  start: () => {
    const state = get();
    if (state.status === "running" || state.status === "paused") return;
    const config: Partial<SimulationConfig> = {
      populationTarget: state.populationTarget,
      preset: state.preset,
      walkingSpeed: state.walkingSpeed,
      responseDelayMin: state.responseDelayMin,
      responseDelayMax: state.responseDelayMax,
      rerouteInterval: state.rerouteInterval,
      fireSpreadEnabled: state.fireSpreadEnabled,
      crowdBehavior: state.crowdBehavior,
      ambientTemperatureC: state.ambientTemperatureC,
      heatAvoidThresholdC: state.heatAvoidThresholdC,
      hardBlockTemperatureC: state.hardBlockTemperatureC,
      thermalLookAheadEdges: state.thermalLookAheadEdges,
      thermalWeight: state.thermalWeight,
    };
    evacuationRuntime.start(config);
    set({ status: "running", metrics: evacuationRuntime.getMetrics(), fires: [...evacuationRuntime.fires], events: [...evacuationRuntime.events], snapshotToken: get().snapshotToken + 1, placeFireMode: false });
  },
  pause: () => {
    if (get().status !== "running") return;
    evacuationRuntime.pause();
    set({ status: evacuationRuntime.completed ? "completed" : "paused", metrics: evacuationRuntime.getMetrics(), events: [...evacuationRuntime.events] });
  },
  resume: () => {
    if (get().status !== "paused") return;
    evacuationRuntime.resume();
    set({ status: evacuationRuntime.completed ? "completed" : evacuationRuntime.running ? "running" : "idle" });
  },
  reset: () => { evacuationRuntime.reset(true); set({ status: "idle", placeFireMode: false, metrics: EMPTY_METRICS, events: [...evacuationRuntime.events], fires: [...evacuationRuntime.fires], snapshotToken: get().snapshotToken + 1 }); },
  addFire: (position) => {
    evacuationRuntime.addFire(position);
    persistFirePattern(evacuationRuntime.fires);
    set({ fires: [...evacuationRuntime.fires], events: [...evacuationRuntime.events], snapshotToken: get().snapshotToken + 1, placeFireMode: false });
  },
  addPresetFire: (preset) => {
    evacuationRuntime.addPresetFire(preset);
    persistFirePattern(evacuationRuntime.fires);
    set({ fires: [...evacuationRuntime.fires], events: [...evacuationRuntime.events], snapshotToken: get().snapshotToken + 1 });
  },
  removeFire: (id) => { evacuationRuntime.removeFire(id); persistFirePattern(evacuationRuntime.fires); set({ fires: [...evacuationRuntime.fires], snapshotToken: get().snapshotToken + 1 }); },
  clearFires: () => { evacuationRuntime.clearFires(); persistFirePattern([]); set({ fires: [], events: [...evacuationRuntime.events], snapshotToken: get().snapshotToken + 1 }); },
  setRenderFps: (renderFps) => set((state) => {
    if (!Number.isFinite(renderFps)) return state;
    const next = Math.max(0, Math.round(renderFps));
    return state.renderFps === next ? state : { renderFps: next };
  }),
  syncFromRuntime: () => {
    const status: SimulationStatus = evacuationRuntime.completed ? "completed" : evacuationRuntime.running ? "running" : get().status === "idle" ? "idle" : "paused";
    const current = get();
    set({ status, metrics: evacuationRuntime.getMetrics(), fires: stableSnapshot(current.fires, evacuationRuntime.fires),
      events: stableSnapshot(current.events, evacuationRuntime.events), snapshotToken: current.snapshotToken + 1 });
  },
}));
