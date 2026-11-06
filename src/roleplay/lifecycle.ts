/**
 * Entering and leaving the roleplay simulator without losing the user's own simulation setup
 * (population, crowd behaviour, speed, fires, closures, building view). Kept apart from the host
 * so the header button does not load the phone UI and its styles until the mode is opened.
 */
import { evacuationRuntime } from "../simulation/runtime";
import { useEvacuationStore } from "../simulation/simulationStore";
import { useBuilding1Store } from "../building1/building1Store";
import { useMapperStore } from "../store";
import { CAMPUS_OVERVIEW_FOCUS } from "../building1/campusExtensionData";
import { useWalkStore } from "../navigation/walkStore";
import type { FireSource, CrowdBehavior, Vec3 } from "../simulation/types";
import { useRoleplayStore } from "./roleplayStore";

interface SavedSettings {
  populationTarget: number;
  crowdBehavior: CrowdBehavior;
  speedFactor: number;
  closedPassages: string[];
  fires: Array<Pick<FireSource, "position" | "intensity" | "fireRadius" | "smokeRadius" | "spreadRate">>;
  viewMode: ReturnType<typeof useBuilding1Store.getState>["viewMode"];
  selectedFloor: number;
}
let saved: SavedSettings | null = null;

/** Header button: remember the user's own simulation settings, then open the setup. */
export function openRoleplay() {
  // Only one controller may move the camera: the old walk mode stops first.
  useWalkStore.getState().setEnabled(false);
  const sim = useEvacuationStore.getState();
  const building = useBuilding1Store.getState();
  if (useRoleplayStore.getState().phase !== "off") return;
  saved = {
    populationTarget: sim.populationTarget, crowdBehavior: sim.crowdBehavior, speedFactor: sim.speedFactor, closedPassages: [...sim.closedPassages],
    fires: evacuationRuntime.fires.filter((fire) => fire.origin === "primary").map(({ position, intensity, fireRadius, smokeRadius, spreadRate }) => ({ position: [...position] as Vec3, intensity, fireRadius, smokeRadius, spreadRate })),
    viewMode: building.viewMode, selectedFloor: building.selectedFloor,
  };
  if (document.pointerLockElement) void document.exitPointerLock();
  useRoleplayStore.getState().open();
}

export function restoreSettings() {
  const sim = useEvacuationStore.getState();
  sim.reset();
  evacuationRuntime.playerBody = null;
  evacuationRuntime.clearFires();
  const before = saved;
  saved = null;
  if (before) {
    before.fires.forEach((fire) => evacuationRuntime.addFire(fire.position, fire));
    for (const group of evacuationRuntime.passageGroups()) {
      const closed = before.closedPassages.includes(group.id);
      if (group.closed !== closed) evacuationRuntime.setPassageGroupClosed(group.id, closed);
    }
    useEvacuationStore.setState({ populationTarget: before.populationTarget, crowdBehavior: before.crowdBehavior, speedFactor: before.speedFactor,
      closedPassages: evacuationRuntime.passageGroups().filter((group) => group.closed).map((group) => group.id) });
    useBuilding1Store.getState().setSelectedFloor(before.selectedFloor);
    useBuilding1Store.getState().setViewMode(before.viewMode);
  }
  useEvacuationStore.getState().syncFromRuntime();
  useMapperStore.getState().requestCameraFocus(CAMPUS_OVERVIEW_FOCUS);
}


/**
 * Automated browser tests only (`?qa=1`): read the run state and press keys through the same input
 * path as the keyboard. Simulation internals only — no tokens, nothing that reaches a server.
 */
export function exposeRoleplayForQa(handles: Record<string, unknown>) {
  if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("qa")) return;
  const target = window as unknown as { __skrRoleplay?: Record<string, unknown> };
  target.__skrRoleplay = { ...(target.__skrRoleplay ?? {}), ...handles };
}
