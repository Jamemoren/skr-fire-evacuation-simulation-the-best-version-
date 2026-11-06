import { create } from "zustand";
import type { CrowdBehavior } from "../simulation/types";
import type { PlayerGuide } from "../mobile/MobileApp";
import type { SpawnChoice, SpawnPlan } from "./spawn";

export type RoleplayPhase = "off" | "setup" | "starting" | "playing" | "result";
export type FireScenario = "none" | "left" | "center" | "right" | "on-route";
export type PointerState = "locked" | "free" | "unsupported";

export interface RoleplayScenario {
  npcCount: number;
  fire: FireScenario;
  /** Passage groups (runtime ids) closed from the start. */
  closures: string[];
  crowdBehavior: CrowdBehavior;
}

export interface RoleplayResult {
  outcome: "arrived" | "failed" | "exited";
  reason: string;
  assemblyNodeId: string | null;
  assemblyName: string | null;
  seconds: number;
  distance: number;
  reroutes: Array<{ at: number; reason: string }>;
  crowdedSeconds: number;
  smokeSeconds: number;
  smokeIndex: number;
  maxTemperatureC: number;
  followedShare: number | null;
}

export interface RoleplayHud {
  seconds: number;
  distance: number;
  reroutes: number;
  crowdedSeconds: number;
  smokeSeconds: number;
  running: boolean;
}

export interface RoleplayPerf {
  /** Average ms per frame of the player's own work (movement + collision), measured. */
  moveMs: number;
  /** Average ms per guide update (route lookahead, risk, crowd count), measured. */
  guideMs: number;
  /** Simulator adapter: ms per 50 ms call spent scanning passages, measured. */
  adapterMs: number;
  /** Adapter → server: last and average round trip of the world snapshot (ms). */
  worldRttMs: number | null;
  worldRttAvgMs: number | null;
  worldSends: number;
  /** Player phone: round trip of the latest position report (ms). */
  poseRttMs: number | null;
}

interface RoleplayState {
  phase: RoleplayPhase;
  choice: SpawnChoice;
  scenario: RoleplayScenario;
  plan: SpawnPlan | null;
  /** Prepared scene (NPCs placed, fires/closures set) matches the current scenario. */
  prepared: boolean;
  preparing: boolean;
  /** Use the suggested spawn (the user saw and accepted it). */
  acceptSuggestion: boolean;
  menuOpen: boolean;
  pointer: PointerState;
  guide: PlayerGuide | null;
  hud: RoleplayHud;
  perf: RoleplayPerf;
  result: RoleplayResult | null;
  backend: { state: "idle" | "connecting" | "ready" | "unavailable"; text: string };
  incidentId: string | null;
  phone: { minimized: boolean; width: number; networkOnline: boolean };
  open: () => void;
  close: () => void;
  setChoice: (patch: Partial<SpawnChoice>) => void;
  setScenario: (patch: Partial<RoleplayScenario>) => void;
  set: (patch: Partial<Omit<RoleplayState, "open" | "close" | "setChoice" | "setScenario" | "set">>) => void;
}

export const DEFAULT_CHOICE: SpawnChoice = { buildingId: "building-1", floor: 5, kind: "room", id: "" };
export const DEFAULT_SCENARIO: RoleplayScenario = { npcCount: 300, fire: "none", closures: [], crowdBehavior: "surge" };
const EMPTY_HUD: RoleplayHud = { seconds: 0, distance: 0, reroutes: 0, crowdedSeconds: 0, smokeSeconds: 0, running: false };
const EMPTY_PERF: RoleplayPerf = { moveMs: 0, guideMs: 0, adapterMs: 0, worldRttMs: null, worldRttAvgMs: null, worldSends: 0, poseRttMs: null };

export const useRoleplayStore = create<RoleplayState>((set) => ({
  phase: "off",
  choice: DEFAULT_CHOICE,
  scenario: DEFAULT_SCENARIO,
  plan: null,
  prepared: false,
  preparing: false,
  acceptSuggestion: false,
  menuOpen: false,
  pointer: "free",
  guide: null,
  hud: EMPTY_HUD,
  perf: EMPTY_PERF,
  result: null,
  backend: { state: "idle", text: "" },
  incidentId: null,
  phone: { minimized: false, width: 400, networkOnline: true },
  open: () => set({ phase: "setup", result: null, menuOpen: false, acceptSuggestion: false, prepared: false, guide: null, hud: EMPTY_HUD, perf: EMPTY_PERF }),
  close: () => set({ phase: "off", menuOpen: false, plan: null, prepared: false, guide: null, result: null, incidentId: null, backend: { state: "idle", text: "" }, phone: { minimized: false, width: 400, networkOnline: true } }),
  setChoice: (patch) => set((state) => {
    const choice = { ...state.choice, ...patch };
    return JSON.stringify(choice) === JSON.stringify(state.choice) ? state : { choice, acceptSuggestion: false };
  }),
  // "prepared" is owned by the setup's preparation effect (which re-runs only when the scenario
  // really changes), so selecting the same value again can never leave the setup unprepared.
  setScenario: (patch) => set((state) => {
    const scenario = { ...state.scenario, ...patch };
    return JSON.stringify(scenario) === JSON.stringify(state.scenario) ? state : { scenario, acceptSuggestion: false };
  }),
  set: (patch) => set(patch),
}));

/** The roleplay owns the camera and the keyboard while it is set up or played. */
export function roleplayActive(phase: RoleplayPhase) {
  return phase !== "off";
}
