import type { Vec3 } from "../types";

export const CAMPUS_OVERVIEW_FOCUS: Vec3 = [-119, 8, 58];
export const EXTENSION_FOCUS: Vec3 = [-20, 9, -43];
export const BUILDING3_FOCUS: Vec3 = [-112, 8, -43];
/** Centre of the B3–B4 bridge deck (floor 3, BLOCK_LEVELS[2] ≈ 7.864 m). */
export const SKYBRIDGE_FOCUS: Vec3 = [-62, 7.864, -39.979];
export const BUILDING3_POSITION: Vec3 = [-112, 0, -43];
export const BUILDING3_MODEL_URL = "/models/campus-classroom-block.glb";
export const EXTENSION_MODEL_URL = BUILDING3_MODEL_URL;
// Model metres shared with campusData/campusGraph; not surveyed coordinates.
export const EXTENSION_POSITION: Vec3 = [-20, 0, -43];
export const EXTENSION_SCALE = 1;
export const EXTENSION_HEIGHT_SCALE = 1;
