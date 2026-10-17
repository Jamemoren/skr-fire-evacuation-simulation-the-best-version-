import { CLASSROOMS, CLASSROOM_CAPACITY, TARGET_POPULATION, balancedOccupancyAt, type RoomModuleDefinition } from "../building1/building1Data";
import { walkY } from "./graph";
import type { AgentPublicSnapshot, Vec3 } from "./types";

export type StudentRenderView = Pick<AgentPublicSnapshot,
  "id" | "gender" | "roomId" | "position" | "status" | "floor" | "phase" | "incapacitatedAt" | "protectivePosture"
>;

export function normalizeStudentPopulation(population: number): number {
  return Number.isFinite(population) ? Math.max(1, Math.min(TARGET_POPULATION, Math.round(population))) : TARGET_POPULATION;
}

/** The preview and the live simulation share the same floor height and spawn slots. */
export function studentStartPosition(room: RoomModuleDefinition, index: number): Vec3 {
  const col = index % 8;
  const row = Math.floor(index / 8);
  const y = walkY(room.floor);
  return room.side === "pink"
    ? [room.position[0] - 2.65 + col * 0.76, y, -7.55 + row * 1.18]
    : [7.55 - row * 1.18, y, room.position[2] - 2.65 + col * 0.76];
}

/** Display waiting occupants without starting clocks, routing or fire exposure. */
export function createWaitingStudents(population: number): StudentRenderView[] {
  const target = normalizeStudentPopulation(population);
  const counts = new Map(CLASSROOMS.map((room, index) => [room.id, balancedOccupancyAt(index, target, CLASSROOMS.length)]));
  const students: StudentRenderView[] = [];
  for (const room of [...CLASSROOMS].sort((a, b) => b.floor - a.floor)) {
    for (let index = 0; index < Math.min(CLASSROOM_CAPACITY, counts.get(room.id) ?? 0); index += 1) {
      students.push({
        id: students.length,
        gender: (index + room.floor + room.index) % 2 === 0 ? "female" : "male",
        roomId: room.id,
        position: studentStartPosition(room, index),
        status: "waiting", floor: room.floor, phase: "room",
        incapacitatedAt: null, protectivePosture: false,
      });
    }
  }
  return students;
}
