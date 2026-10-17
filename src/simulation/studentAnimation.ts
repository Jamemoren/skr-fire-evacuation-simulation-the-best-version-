import type { StudentRenderView } from "./studentPlacement";

export interface StudentAnimationTrack {
  x: number; y: number; z: number;
  roomId: string;
  sampleTime: number; sampleClock: number; floor: number; phase: string; status: string;
  yaw: number; yawOffset: number;
  offsetX: number; offsetY: number; offsetZ: number;
  strideFrom: number; strideTo: number;
  started: number; duration: number;
}

// All gait/idle frequencies are integer multiples of .01 rad/s, so this period
// preserves their phases while keeping shader Float32 timestamps small.
export const STUDENT_ANIMATION_PERIOD = Math.PI * 200;
export function advanceStudentAnimationClock(clock: number, delta: number, tracks: Iterable<StudentAnimationTrack>): number {
  const next = clock + delta;
  if (next < STUDENT_ANIMATION_PERIOD) return next;
  const shift = Math.floor(next / STUDENT_ANIMATION_PERIOD) * STUDENT_ANIMATION_PERIOD;
  for (const track of tracks) { track.started -= shift; track.sampleClock -= shift; }
  return next - shift;
}

function angleDelta(angle: number) {
  const turn = Math.PI * 2;
  return ((angle + Math.PI) % turn + turn) % turn - Math.PI;
}

/** Rendering history only: never writes interpolated coordinates back into the solver. */
export function sampleStudentAnimation(
  previous: StudentAnimationTrack | undefined, agent: StudentRenderView,
  simulationTime: number, clock: number, allowTranslation: boolean,
): StudentAnimationTrack {
  const [x, y, z] = agent.position;
  if (!previous || previous.roomId !== agent.roomId || simulationTime < previous.sampleTime) return {
    x, y, z, roomId: agent.roomId, sampleTime: simulationTime, sampleClock: clock, floor: agent.floor, phase: agent.phase, status: agent.status,
    yaw: 0, yawOffset: 0, offsetX: 0, offsetY: 0, offsetZ: 0,
    strideFrom: 0, strideTo: 0, started: clock, duration: .08,
  };
  if (previous.sampleTime === simulationTime && previous.status === agent.status
    && previous.floor === agent.floor && previous.phase === agent.phase
    && previous.x === x && previous.y === y && previous.z === z) return previous;

  const dt = simulationTime - previous.sampleTime;
  const clockDt = clock - previous.sampleClock;
  const p = Math.min(1, Math.max(0, (clock - previous.started) / previous.duration));
  const eased = p * p * (3 - 2 * p);
  const dx = x - previous.x, dz = z - previous.z;
  const distance = Math.hypot(dx, dz);
  const moving = agent.status === "evacuating" || agent.status === "rerouting";
  const fallen = agent.status === "incapacitated";
  const stale = dt < 0 || dt > .5 || clockDt > .35;
  const oldYaw = previous.yaw + previous.yawOffset * (1 - eased);
  const yaw = !fallen && distance > .002 && !stale ? Math.atan2(dx, dz) : previous.yaw;
  const turn = angleDelta(oldYaw - yaw);
  // Blend only short, straight, same-surface steps. Snap at stairs, sharp corners,
  // contact collapse and fast-forward so interpolation cannot invent a shortcut.
  const blendPosition = allowTranslation && !stale && !fallen && distance < .22
    && Math.abs(y - previous.y) < .08 && Math.abs(turn) < .65
    && previous.floor === agent.floor && previous.phase === agent.phase;
  const offsetX = blendPosition ? previous.x + previous.offsetX * (1 - p) - x : 0;
  const offsetY = blendPosition ? previous.y + previous.offsetY * (1 - p) - y : 0;
  const offsetZ = blendPosition ? previous.z + previous.offsetZ * (1 - p) - z : 0;
  const strideFrom = stale || fallen ? 0 : previous.strideFrom + (previous.strideTo - previous.strideFrom) * eased;
  const strideTo = moving && !fallen && !stale && dt > 0 && distance > .001 ? Math.min(1.2, distance / dt / 1.32) : 0;
  // Reuse the track rather than allocating thousands of temporary pose objects per tick.
  previous.x = x; previous.y = y; previous.z = z;
  previous.sampleTime = simulationTime; previous.sampleClock = clock;
  previous.floor = agent.floor; previous.phase = agent.phase; previous.status = agent.status;
  previous.yaw = yaw; previous.yawOffset = stale || fallen ? 0 : turn;
  previous.offsetX = offsetX; previous.offsetY = offsetY; previous.offsetZ = offsetZ;
  previous.strideFrom = strideFrom; previous.strideTo = strideTo;
  previous.started = clock; previous.duration = Math.min(.12, Math.max(.075, clockDt * 1.15));
  return previous;
}
