import { create } from "zustand";
import { integerBetween } from "../utils/numbers";

export type BuildingViewMode = "exterior" | "cutaway" | "single-floor" | "interior" | "structure";
export type PopulationPreviewMode = "rooms" | "assembly";
export type PopulationProfile = "target3000" | "full" | "selected-floor";
export type StairFocus = "left" | "center" | "right";

interface Building1State {
  viewMode: BuildingViewMode;
  selectedFloor: number;
  blueprintPage: number;
  blueprintOpen: boolean;
  blueprintOpacity: number;
  explodeFloors: boolean;
  showRoomVolumes: boolean;
  showRoomLabels: boolean;
  showEvacuationRoute: boolean;
  showSportsField: boolean;
  showFootballMarkings: boolean;
  showTrackLanes: boolean;
  showGoals: boolean;
  showAssemblyZones: boolean;
  showFieldLights: boolean;
  showFieldLabels: boolean;
  showPopulation: boolean;
  populationMode: PopulationPreviewMode;
  populationProfile: PopulationProfile;
  showInteriorWalls: boolean;
  showDoors: boolean;
  showFurniture: boolean;
  showLiftCore: boolean;
  showStairs: boolean;
  showStairLabels: boolean;
  showFacadeWindows: boolean;
  showRoof: boolean;
  showCorridorLights: boolean;
  stairFocus: StairFocus;
  focusMode: boolean;
  setViewMode: (mode: BuildingViewMode) => void;
  setSelectedFloor: (floor: number) => void;
  setBlueprintPage: (page: number) => void;
  setBlueprintOpen: (open: boolean) => void;
  setBlueprintOpacity: (opacity: number) => void;
  setExplodeFloors: (value: boolean) => void;
  setShowRoomVolumes: (value: boolean) => void;
  setShowRoomLabels: (value: boolean) => void;
  setShowEvacuationRoute: (value: boolean) => void;
  setShowSportsField: (value: boolean) => void;
  setShowFootballMarkings: (value: boolean) => void;
  setShowTrackLanes: (value: boolean) => void;
  setShowGoals: (value: boolean) => void;
  setShowAssemblyZones: (value: boolean) => void;
  setShowFieldLights: (value: boolean) => void;
  setShowFieldLabels: (value: boolean) => void;
  setShowPopulation: (value: boolean) => void;
  setPopulationMode: (mode: PopulationPreviewMode) => void;
  setPopulationProfile: (profile: PopulationProfile) => void;
  setShowInteriorWalls: (value: boolean) => void;
  setShowDoors: (value: boolean) => void;
  setShowFurniture: (value: boolean) => void;
  setShowLiftCore: (value: boolean) => void;
  setShowStairs: (value: boolean) => void;
  setShowStairLabels: (value: boolean) => void;
  setShowFacadeWindows: (value: boolean) => void;
  setShowRoof: (value: boolean) => void;
  setShowCorridorLights: (value: boolean) => void;
  setStairFocus: (zone: StairFocus) => void;
  setFocusMode: (value: boolean) => void;
}

export const useBuilding1Store = create<Building1State>((set) => ({
  viewMode: "exterior",
  selectedFloor: 3,
  blueprintPage: 3,
  blueprintOpen: false,
  blueprintOpacity: 0.92,
  explodeFloors: false,
  showRoomVolumes: false,
  showRoomLabels: false,
  showEvacuationRoute: false,
  showSportsField: true,
  showFootballMarkings: true,
  showTrackLanes: true,
  showGoals: true,
  showAssemblyZones: true,
  showFieldLights: true,
  showFieldLabels: true,
  showPopulation: false,
  populationMode: "rooms",
  populationProfile: "target3000",
  showInteriorWalls: true,
  showDoors: true,
  showFurniture: true,
  showLiftCore: true,
  showStairs: true,
  showStairLabels: false,
  showFacadeWindows: true,
  showRoof: true,
  showCorridorLights: true,
  stairFocus: "center",
  focusMode: false,
  setViewMode: (viewMode) => set({ viewMode }),
  setSelectedFloor: (selectedFloor) => set((state) => {
    const floor = integerBetween(selectedFloor, state.selectedFloor, 1, 9);
    return { selectedFloor: floor, blueprintPage: floor };
  }),
  setBlueprintPage: (blueprintPage) => set((state) => ({ blueprintPage: integerBetween(blueprintPage, state.blueprintPage, 1, 11) })),
  setBlueprintOpen: (blueprintOpen) => set({ blueprintOpen }),
  setBlueprintOpacity: (blueprintOpacity) => set({ blueprintOpacity }),
  setExplodeFloors: (explodeFloors) => set({ explodeFloors }),
  setShowRoomVolumes: (showRoomVolumes) => set({ showRoomVolumes }),
  setShowRoomLabels: (showRoomLabels) => set({ showRoomLabels }),
  setShowEvacuationRoute: (showEvacuationRoute) => set({ showEvacuationRoute }),
  setShowSportsField: (showSportsField) => set({ showSportsField }),
  setShowFootballMarkings: (showFootballMarkings) => set({ showFootballMarkings }),
  setShowTrackLanes: (showTrackLanes) => set({ showTrackLanes }),
  setShowGoals: (showGoals) => set({ showGoals }),
  setShowAssemblyZones: (showAssemblyZones) => set({ showAssemblyZones }),
  setShowFieldLights: (showFieldLights) => set({ showFieldLights }),
  setShowFieldLabels: (showFieldLabels) => set({ showFieldLabels }),
  setShowPopulation: (showPopulation) => set({ showPopulation }),
  setPopulationMode: (populationMode) => set({ populationMode }),
  setPopulationProfile: (populationProfile) => set({ populationProfile }),
  setShowInteriorWalls: (showInteriorWalls) => set({ showInteriorWalls }),
  setShowDoors: (showDoors) => set({ showDoors }),
  setShowFurniture: (showFurniture) => set({ showFurniture }),
  setShowLiftCore: (showLiftCore) => set({ showLiftCore }),
  setShowStairs: (showStairs) => set({ showStairs }),
  setShowStairLabels: (showStairLabels) => set({ showStairLabels }),
  setShowFacadeWindows: (showFacadeWindows) => set({ showFacadeWindows }),
  setShowRoof: (showRoof) => set({ showRoof }),
  setShowCorridorLights: (showCorridorLights) => set({ showCorridorLights }),
  setStairFocus: (stairFocus) => set({ stairFocus }),
  setFocusMode: (focusMode) => set({ focusMode }),
}));
