/**
 * Simulator Adapter: turns the 3D simulation's ground truth (modelled fire/smoke/heat per passage,
 * people per passage) into the same inputs the guidance server uses for routing. Everything it
 * sends is labelled simulator data; the server accepts it only for simulation incidents.
 *
 * Cost control: passages are scanned a slice per call (never all at once), snapshots go to
 * the server at most once a second, and a change in blocked/smoky passages is sent at once
 * (minimum 250 ms apart) so an urgent hazard is never held back by the 1 s rhythm.
 */
import type { EvacuationRuntime } from "../simulation/runtime";
import type { HazardReading, OccupancyReading } from "./providers";

/** Passages scanned per call (≈ 600 passages → a full scan every ~15 calls, ≈ 0.75 s at 50 ms). */
const EDGES_PER_FRAME = 40;
const SEND_EVERY_MS = 1000;
const URGENT_MIN_GAP_MS = 250;
/** People on/at a passage below this are not sent (keeps payloads small). */
const MIN_CROWD = 2;

/**
 * Penalty in seconds of walking added to a passage with modelled smoke/heat that does not block
 * it: 180 s at full smoke, 600 s at full flame proximity, 4 s per °C above 40 °C (capped 600 s).
 * These are routing weights of this model, not measured human tolerances.
 */
export function hazardMarginSeconds(risk: { fire: number; smoke: number; modeledTemperatureC: number }) {
  const value = risk.smoke * 180 + risk.fire * 600 + Math.max(0, risk.modeledTemperatureC - 40) * 4;
  return value >= 3 ? Math.min(600, Math.round(value)) : 0;
}

export interface WorldPayload {
  blocked: string[];
  margins: Record<string, number>;
  crowd: Record<string, number>;
  simTime: number;
}

export class SimulatorWorldAdapter {
  private readonly runtime: EvacuationRuntime;
  private readonly send: (payload: WorldPayload) => Promise<unknown>;
  private cursor = 0;
  private scanBlocked = new Set<string>();
  private scanMargins = new Map<string, number>();
  private blocked = new Set<string>();
  private margins = new Map<string, number>();
  private scanCompletedAt = 0;
  private sentSignature = "";
  private lastSentAt = 0;
  private inFlight = false;
  private disposed = false;
  readonly stats = { sends: 0, failures: 0, lastRttMs: null as number | null, rttSumMs: 0, scanMsSum: 0, frames: 0, lastSentAt: 0 };

  constructor(runtime: EvacuationRuntime, send: (payload: WorldPayload) => Promise<unknown>) {
    this.runtime = runtime;
    this.send = send;
  }

  /** Call on a steady timer (the host uses 50 ms). */
  step(now = Date.now()) {
    if (this.disposed) return;
    const started = performance.now();
    const edges = this.runtime.graph.edges;
    if (!this.runtime.fires.length) {
      // No fire in the model: nothing to scan, nothing blocked.
      this.scanBlocked.clear(); this.scanMargins.clear();
      this.blocked = new Set(); this.margins = new Map();
      this.cursor = 0;
      this.scanCompletedAt = now;
    } else {
      const end = Math.min(edges.length, this.cursor + EDGES_PER_FRAME);
      for (let index = this.cursor; index < end; index += 1) {
        const edge = edges[index];
        const risk = this.runtime.passageHazard(edge.id);
        if (risk.blocked) this.scanBlocked.add(edge.id);
        else {
          const margin = hazardMarginSeconds(risk);
          if (margin) this.scanMargins.set(edge.id, margin);
        }
      }
      this.cursor = end;
      if (this.cursor >= edges.length) {
        this.blocked = this.scanBlocked; this.margins = this.scanMargins;
        this.scanBlocked = new Set(); this.scanMargins = new Map();
        this.cursor = 0;
        this.scanCompletedAt = now;
      }
    }
    this.stats.scanMsSum += performance.now() - started;
    this.stats.frames += 1;
    this.maybeSend(now);
  }

  private signature() {
    return `${[...this.blocked].sort().join(",")}|${[...this.margins.keys()].sort().join(",")}`;
  }

  private maybeSend(now: number) {
    if (this.inFlight || this.scanCompletedAt === 0) return;
    const signature = this.signature();
    const urgent = signature !== this.sentSignature;
    const gap = now - this.lastSentAt;
    if (urgent ? gap < URGENT_MIN_GAP_MS : gap < SEND_EVERY_MS) return;
    this.flush(now, signature);
  }

  private flush(now: number, signature: string) {
    const payload = this.payload();
    this.inFlight = true;
    this.lastSentAt = now;
    const started = performance.now();
    void this.send(payload).then(() => {
      if (this.disposed) return;
      const rtt = performance.now() - started;
      this.sentSignature = signature;
      this.stats.sends += 1; this.stats.lastRttMs = Math.round(rtt); this.stats.rttSumMs += rtt; this.stats.lastSentAt = Date.now();
    }).catch(() => { if (!this.disposed) this.stats.failures += 1; })
      .finally(() => { this.inFlight = false; });
  }

  payload(): WorldPayload {
    const crowd: Record<string, number> = {};
    this.runtime.passageCrowd().forEach((people, edgeId) => { if (people >= MIN_CROWD) crowd[edgeId] = people; });
    const margins: Record<string, number> = {};
    this.margins.forEach((value, edgeId) => { margins[edgeId] = value; });
    return { blocked: [...this.blocked], margins, crowd, simTime: Math.round(this.runtime.time * 10) / 10 };
  }

  /** Provider view of what the adapter currently knows (simulator mode only). */
  hazardReading(mapVersion: string): HazardReading {
    const margins: Record<string, number> = {};
    this.margins.forEach((value, edgeId) => { margins[edgeId] = value; });
    return { mode: "simulator", source: "simulator-ground-truth", mapVersion, timestamp: this.scanCompletedAt, confidence: "high", stale: Date.now() - this.scanCompletedAt > 5000, confirmation: "none", blockedEdgeIds: [...this.blocked], marginSecondsByEdge: margins };
  }

  occupancyReading(mapVersion: string): OccupancyReading {
    return { mode: "simulator", source: "simulator-ground-truth", mapVersion, timestamp: Date.now(), confidence: "high", stale: false, confirmation: "none", peopleByEdge: this.payload().crowd };
  }

  averageScanMs() { return this.stats.frames ? this.stats.scanMsSum / this.stats.frames : 0; }
  averageRttMs() { return this.stats.sends ? this.stats.rttSumMs / this.stats.sends : null; }

  dispose() { this.disposed = true; }
}
