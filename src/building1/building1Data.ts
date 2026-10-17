import type { SemanticAnnotation, Vec3 } from "../types";

export const BUILDING_ID = "building-1";
export const FLOOR_COUNT = 9;
export const GROUND_FLOOR = 1;
export const UPPER_FLOOR_START = 2;
export const FLOOR_HEIGHT = 3.5;
export const SLAB_THICKNESS = 0.24;
export const STUDENT_BODY_HEIGHT = 1.58;
export const TARGET_POPULATION = 3000;
export const CLASSROOM_CAPACITY = 40;
export const ROOMS_PER_UPPER_FLOOR = 12;
export const UPPER_FLOOR_COUNT = FLOOR_COUNT - 1;
export const TOTAL_CLASSROOMS = ROOMS_PER_UPPER_FLOOR * UPPER_FLOOR_COUNT;
export const FULL_BUILDING_CAPACITY = TOTAL_CLASSROOMS * CLASSROOM_CAPACITY;

/**
 * กระจายประชากรแบบ Bresenham ให้ครบทุกห้อง/ทุกชั้นโดยผลรวมไม่คลาดเคลื่อน
 * เช่น 3,000 คน / 96 ห้อง = 31–32 คนต่อห้อง และ 375 คนเท่ากันทุกชั้น 2–9
 */
export function balancedOccupancyAt(index: number, population: number, roomCount = TOTAL_CLASSROOMS): number {
  const safePopulation = Math.max(0, Math.min(population, roomCount * CLASSROOM_CAPACITY));
  const base = Math.floor(safePopulation / roomCount);
  const remainder = safePopulation % roomCount;
  const extra = Math.floor(((index + 1) * remainder) / roomCount) - Math.floor((index * remainder) / roomCount);
  return Math.min(CLASSROOM_CAPACITY, base + extra);
}

/**
 * Coordinate convention
 * - Central junction is around the origin.
 * - Pink wing extends toward -X.
 * - Blue wing extends toward +Z.
 * - Wings are perpendicular (90 degrees).
 * - Floor 1 is the open/pilotis ground floor.
 * - Floors 2-9 contain 12 classroom modules per floor: 6 pink + 6 blue.
 */
export const JUNCTION_CENTER: Vec3 = [0, 0, 0];
export const WING_DEPTH = 13.5;
export const CORRIDOR_WIDTH = 3.2;
export const ROOM_DEPTH = 9.8;
export const ROOM_MODULE = 8;
export const PINK_ROOM_BAYS = 6;
export const BLUE_ROOM_BAYS = 6;
export const PINK_WING_LENGTH = PINK_ROOM_BAYS * ROOM_MODULE;
export const BLUE_WING_LENGTH = BLUE_ROOM_BAYS * ROOM_MODULE;
export const PINK_WING_CENTER: Vec3 = [-28, 0, -3.25];
export const BLUE_WING_CENTER: Vec3 = [3.25, 0, 28];
export const PINK_END_TOWER_CENTER: Vec3 = [-56.2, 0, -3.25];
export const BLUE_END_TOWER_CENTER: Vec3 = [3.25, 0, 56.2];
export const CENTRAL_CORE_CENTER: Vec3 = [-0.4, 0, -0.4];
export const TOTAL_HEIGHT = FLOOR_COUNT * FLOOR_HEIGHT;

export const STAIR_STEPS_PER_FLIGHT = 8;
export const STAIR_FLIGHTS_PER_FLOOR = 2;
export const STAIR_TOTAL_STEPS_PER_FLOOR = STAIR_STEPS_PER_FLIGHT * STAIR_FLIGHTS_PER_FLOOR;
export const STAIR_RISER = FLOOR_HEIGHT / STAIR_TOTAL_STEPS_PER_FLOOR;
export const STAIR_TREAD = 0.32;
export const STAIR_FLIGHT_WIDTH = 2.2;
export const STAIR_LANDING_DEPTH = 1.5;
// Shared physical layout for the rendered stair and its navigation waypoints.
// Keeping these values authoritative prevents rails, treads, and agents from
// ending at different points on the landing.
export const STAIR_FLIGHT_CENTER_OFFSET = STAIR_FLIGHT_WIDTH * 0.62;
export const STAIR_FIRST_STEP_Z = 1.30;
export const STAIR_MID_LANDING_Z = -1.85;
export const STAIR_SECOND_STEP_Z = -1.24;
// A front apron, rather than a plate across the flights, leaves full headroom.
export const STAIR_ACCESS_MIN_Z = 1.1775;
export const STAIR_ACCESS_MAX_Z = 3.2;
export const STAIR_ACCESS_NODE_Z = 2.3;
export const CORE_LIFT_X = [-2.15, 0.55] as const;
export const CORE_LIFT_Z = -7.9;
export const CORE_LIFT_SIZE = [2.35, 3.26, 3.18] as const;

export const FIELD_CENTER: Vec3 = [-3, 0, 92];
export const FIELD_SIZE: Vec3 = [104, 0.5, 62];
export const FIELD_PITCH_SIZE: Vec3 = [66, 0.25, 33];
export const ASSEMBLY_ZONE_CAPACITY = 500;
export const ASSEMBLY_ZONE_OFFSETS: Array<[string, number, number]> = [
  ["A", -20, -8], ["B", 0, -8], ["C", 20, -8],
  ["D", -20, 8], ["E", 0, 8], ["F", 20, 8],
];

export type WingSide = "pink" | "blue";
export type StairZone = "left" | "center" | "right";

export interface RoomModuleDefinition {
  id: string;
  name: string;
  floor: number;
  side: WingSide;
  index: number;
  position: Vec3;
  rotation: Vec3;
  size: Vec3;
  roomType: "classroom";
  peopleCount: number;
  capacity: number;
}

export interface NodeDefinition {
  id: string;
  name: string;
  type: SemanticAnnotation["type"];
  floor: number;
  position: Vec3;
  zone?: StairZone;
}

export function floorBase(floor: number): number {
  return (floor - 1) * FLOOR_HEIGHT;
}

export function floorCenter(floor: number): number {
  return floorBase(floor) + FLOOR_HEIGHT / 2;
}

export function pinkRoomCenter(index: number): Vec3 {
  return [-8 - index * ROOM_MODULE, 0, -5.05];
}

export function blueRoomCenter(index: number): Vec3 {
  return [5.05, 0, 8 + index * ROOM_MODULE];
}

export function stairNodeId(zone: StairZone, floor: number): string {
  return `b1-stair-${zone}-f${floor}`;
}

export const STAIR_ZONE_CENTERS: Record<StairZone, Vec3> = {
  left: PINK_END_TOWER_CENTER,
  center: [2.75, 0, -0.5],
  right: BLUE_END_TOWER_CENTER,
};

/** Same local coordinates for the rendered stair, route and geometry audit. */
export function stairWorldPoint(zone: StairZone, x: number, y: number, z: number): Vec3 {
  const center = STAIR_ZONE_CENTERS[zone];
  return zone === "right"
    ? [center[0] + z, y, center[2] - x]
    : [center[0] + x, y, center[2] + z];
}

export function stairAccessPoint(zone: StairZone, floor: number, y = floorBase(floor) + 0.2): Vec3 {
  return stairWorldPoint(zone, 0, y, STAIR_ACCESS_NODE_Z);
}

/**
 * Shared architectural portals used by both the 3D shell and the evacuation graph.
 * Keeping these coordinates in the building data prevents a visually open door from
 * drifting away from the path that pedestrians are allowed to use.
 */
export const STAIR_EXIT_DOOR_CENTERS: Record<StairZone, Vec3> = {
  left: [-54.25, 0.28, 4.25],
  center: [1, 0.28, 5],
  right: [3.58, 0.28, 51.95],
};
export const STAIR_EXIT_DOOR_WIDTH = 2.4;
export const STAIR_EXIT_DOOR_HEIGHT = 2.62;
export const STAIR_FLOOR_OPENING_SIZE: [number, number] = [5.45, 5.45];
// The central stair is the highest-volume stair. Its longer floor void and
// wider access landing prevent the lower flight from feeling pinched against
// the slab edge while preserving the original end-tower openings.
export const CENTRAL_STAIR_FLOOR_OPENING_SIZE: [number, number] = [5.45, 6.4];
export const CENTRAL_STAIR_ACCESS_LANDING_WIDTH = 5.45;
export const CENTRAL_STAIR_ACCESS_LANDING_DEPTH = STAIR_ACCESS_MAX_Z - STAIR_ACCESS_MIN_Z;
// Exterior-only cantilever. It enlarges the visible circular nose toward the
// courtyard without moving the stair void, lift bank, rooms, or navigation.
export const CORE_CURVED_STRUCTURAL_RADIUS = 7.5;
export const CORE_CURVED_CANTILEVER_RADIUS = 8.15;
// The central curve is an open exterior balcony, not part of the enclosed
// school interior. This point keeps navigation on its open connector without
// inventing a doorway or moving any room/stair geometry.
export const CORE_OPEN_CONNECTOR_RADIUS = 7.28;
export const CORE_OPEN_CONNECTOR_ANGLE = -1.31;
export const CORE_OPEN_CONNECTOR_CENTER: Vec3 = [
  CORE_OPEN_CONNECTOR_RADIUS * Math.sin(CORE_OPEN_CONNECTOR_ANGLE),
  0,
  CORE_OPEN_CONNECTOR_RADIUS * Math.cos(CORE_OPEN_CONNECTOR_ANGLE),
];

export const ROOM_MODULES: RoomModuleDefinition[] = (() => {
  const result: RoomModuleDefinition[] = [];
  let roomOrdinal = 0;

  for (let floor = UPPER_FLOOR_START; floor <= FLOOR_COUNT; floor += 1) {
    for (let index = 0; index < PINK_ROOM_BAYS; index += 1) {
      const peopleCount = balancedOccupancyAt(roomOrdinal, TARGET_POPULATION);
      roomOrdinal += 1;
      result.push({
        id: `b1-f${floor}-pink-${index + 1}`,
        name: `ห้อง ${floor}${String(index + 1).padStart(2, "0")}`,
        floor,
        side: "pink",
        index: index + 1,
        position: [pinkRoomCenter(index)[0], floorCenter(floor), pinkRoomCenter(index)[2]],
        rotation: [0, 0, 0],
        size: [ROOM_MODULE - 0.35, FLOOR_HEIGHT - 0.55, ROOM_DEPTH - 0.35],
        roomType: "classroom",
        peopleCount,
        capacity: CLASSROOM_CAPACITY,
      });
    }

    for (let index = 0; index < BLUE_ROOM_BAYS; index += 1) {
      const peopleCount = balancedOccupancyAt(roomOrdinal, TARGET_POPULATION);
      roomOrdinal += 1;
      result.push({
        id: `b1-f${floor}-blue-${index + 1}`,
        name: `ห้อง ${floor}${String(index + 7).padStart(2, "0")}`,
        floor,
        side: "blue",
        index: index + 1,
        position: [blueRoomCenter(index)[0], floorCenter(floor), blueRoomCenter(index)[2]],
        rotation: [0, 0, 0],
        size: [ROOM_DEPTH - 0.35, FLOOR_HEIGHT - 0.55, ROOM_MODULE - 0.35],
        roomType: "classroom",
        peopleCount,
        capacity: CLASSROOM_CAPACITY,
      });
    }
  }

  return result;
})();

export const CLASSROOMS = ROOM_MODULES;
export const TARGET_OCCUPIED_CLASSROOMS = ROOM_MODULES.filter((room) => room.peopleCount > 0).length;
export const TARGET_POPULATION_PER_FLOOR = TARGET_POPULATION / UPPER_FLOOR_COUNT;

export const FLOOR_STAIR_NODES: NodeDefinition[] = (() => {
  const result: NodeDefinition[] = [];
  for (let floor = 1; floor <= FLOOR_COUNT; floor += 1) {
    (["left", "center", "right"] as StairZone[]).forEach((zone) => {
      result.push({
        id: stairNodeId(zone, floor),
        name: `บันได${zone === "left" ? "ซ้าย" : zone === "center" ? "กลาง" : "ขวา"} ชั้น ${floor}`,
        type: "stair",
        floor,
        zone,
        position: stairAccessPoint(zone, floor, floorBase(floor) + 0.3),
      });
    });
  }
  return result;
})();

export const GROUND_EXIT: NodeDefinition = {
  id: "b1-main-exit",
  name: "ทางออกหลักตึก 1",
  type: "exit",
  floor: 1,
  position: [-9, 0.3, 15],
};

export const FIELD_ASSEMBLY: NodeDefinition = {
  id: "sports-field-assembly",
  name: "สนามฟุตบอล / จุดรวมพลหลัก",
  type: "football-field",
  floor: 0,
  position: FIELD_CENTER,
};

