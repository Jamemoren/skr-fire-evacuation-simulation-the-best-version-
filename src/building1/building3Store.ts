import { create } from "zustand";

interface Building3State {
  buildingNumber: 3 | 4;
  inspecting: boolean;
  cutawayFloor: number;
  setInspecting: (value: boolean) => void;
  setCutawayFloor: (floor: number) => void;
}
export const useBuilding3Store = create<Building3State>((set) => ({
  buildingNumber: 3,
  inspecting: false,
  cutawayFloor: 0,
  setInspecting: (inspecting) => set({ inspecting }),
  setCutawayFloor: (floor) => set({ cutawayFloor: Math.max(0, Math.min(4, Math.round(floor))) }),
}));
