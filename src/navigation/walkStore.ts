import { create } from "zustand";
import { integerBetween } from "../utils/numbers";

// High-frequency pointer input stays outside React to avoid rerendering the dashboard.
export const walkInput = { x: 0, forward: 0, lookX: 0, lookY: 0, fast: false, suspended: false };
export function clearWalkInput() { walkInput.x = 0; walkInput.forward = 0; walkInput.lookX = 0; walkInput.lookY = 0; }

interface WalkState {
  enabled: boolean;
  floor: number;
  spawnToken: number;
  setEnabled: (enabled: boolean, floor?: number) => void;
  goToFloor: (floor: number) => void;
}
export const useWalkStore = create<WalkState>((set) => ({
  enabled: false, floor: 1, spawnToken: 0,
  setEnabled: (enabled, floor = 1) => { clearWalkInput(); walkInput.fast = false; set((state) => ({ enabled, floor: integerBetween(floor, state.floor, 1, 9), spawnToken: state.spawnToken + 1 })); },
  goToFloor: (floor) => { clearWalkInput(); set((state) => ({ floor: integerBetween(floor, state.floor, 1, 9), spawnToken: state.spawnToken + 1 })); },
}));
