/**
 * Frame-rate state of one roleplay run, shared by the 3D controller (inside the canvas) and the
 * host (DOM: phone, setup, results). Kept outside React so movement never re-renders the page;
 * the store receives throttled summaries.
 */
import type { Vec3 } from "../simulation/types";
import type { SimulatorPose } from "../mobile/client";
import type { PlayerNavigator } from "./playerMotion";

export interface RunStats {
  /** Simulation time when the player started walking. */
  startSimTime: number;
  /** Horizontal distance walked (m). */
  distance: number;
  /** Seconds with 6 or more simulated people within 2.5 m. */
  crowdedSeconds: number;
  /** Seconds in modelled smoke (level > 0.05). */
  smokeSeconds: number;
  /** ∫ smoke level dt — a relative exposure index of the model, not a toxic dose. */
  smokeIndex: number;
  /** Highest modelled air temperature at the character (°C). */
  maxTemperatureC: number;
  /** Seconds within 2.5 m of the advised walkway (while a route existed). */
  followedSeconds: number;
  /** Seconds away from the advised walkway (while a route existed). */
  offRouteSeconds: number;
  /** Continuous seconds in flame contact (ends the run at FLAME_LIMIT_S). */
  flameSeconds: number;
  /** Route changes after the first advice, with the server's reason. */
  reroutes: Array<{ at: number; reason: string }>;
}

export const FLAME_LIMIT_S = 0.9;

export function emptyStats(startSimTime = 0): RunStats {
  return { startSimTime, distance: 0, crowdedSeconds: 0, smokeSeconds: 0, smokeIndex: 0, maxTemperatureC: 0, followedSeconds: 0, offRouteSeconds: 0, flameSeconds: 0, reroutes: [] };
}

export interface AdvisedRoute {
  routeId: string;
  revision: number;
  nodeIds: string[];
  edgeIds: string[];
  destinationId: string | null;
}

export const roleplaySession = {
  navigator: null as PlayerNavigator | null,
  /** View: yaw 0 looks along −Z, positive turns left (three.js convention); pitch in radians. */
  yaw: 0,
  pitch: -0.05,
  /** Camera eye height, smoothed for comfort (physics height is never smoothed). */
  eyeY: null as number | null,
  route: null as AdvisedRoute | null,
  stats: emptyStats(),
  /** Last pose the host forwarded to the phone (node + time). */
  lastReportedNode: null as string | null,
  lastReportedAt: 0,
  /** Set by the host: forward a pose to the player's phone session. */
  reportPose: null as ((pose: SimulatorPose) => void) | null,
  onArrive: null as ((assemblyNodeId: string) => void) | null,
  onFail: null as ((reason: string) => void) | null,
  /** Frame timing (ms) measured by the controller. */
  perf: { frames: 0, moveMs: 0, guideMs: 0, guides: 0, clock: 0 },
};

export function resetSession() {
  roleplaySession.navigator = null;
  roleplaySession.yaw = 0;
  roleplaySession.pitch = -0.05;
  roleplaySession.eyeY = null;
  roleplaySession.route = null;
  roleplaySession.stats = emptyStats();
  roleplaySession.lastReportedNode = null;
  roleplaySession.lastReportedAt = 0;
  roleplaySession.reportPose = null;
  roleplaySession.onArrive = null;
  roleplaySession.onFail = null;
  roleplaySession.perf = { frames: 0, moveMs: 0, guideMs: 0, guides: 0, clock: 0 };
}

export function horizontalDistance(a: Vec3, b: Vec3) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
