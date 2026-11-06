/**
 * Data providers behind the guidance for one person. The roleplay simulator and a future real
 * deployment use the same four interfaces, so the phone and routing code do not change — but the
 * sources never mix: a Real Mode provider must never be fed from the simulator (camera position,
 * runtime fire field, runtime crowd), and the simulator never claims to be real.
 *
 * Real Mode is NOT ready. Its factory returns a disabled bundle with the reasons; nothing in this
 * project switches it on.
 */

export type ProviderMode = "simulator" | "real";

/** Every reading carries where it came from and how much to trust it. */
export interface ProviderMeta {
  mode: ProviderMode;
  /** Free-text source, e.g. "simulator-ground-truth" or "qr-checkpoint". */
  source: string;
  /** Map the reading refers to; readings for another map version are rejected, not converted. */
  mapVersion: string;
  /** When it was observed (ms, epoch). */
  timestamp: number;
  confidence: "high" | "medium" | "low";
  /** Older than the provider's freshness limit: shown as not live, never as current. */
  stale: boolean;
  /** Who confirmed it, if anyone (a sensor alarm needs staff confirmation in a real building). */
  confirmation: "none" | "self" | "staff" | "sensor";
}

export interface LocationReading extends ProviderMeta {
  buildingId: string;
  floor: number;
  nodeId: string;
  /** Simulation coordinates — present only in simulator mode. */
  position: [number, number, number] | null;
  headingDeg: number | null;
}

export interface HazardReading extends ProviderMeta {
  /** Passages that must not be used. */
  blockedEdgeIds: string[];
  /** Extra cost per passage, in seconds of walking (fire/smoke/heat margin). */
  marginSecondsByEdge: Record<string, number>;
}

export interface OccupancyReading extends ProviderMeta {
  /** People per passage (walking on it or crowding at its entrance). */
  peopleByEdge: Record<string, number>;
}

export interface GuidanceReading extends ProviderMeta {
  routeId: string | null;
  nodeIds: string[];
  edgeIds: string[];
  reason: string | null;
}

export interface PlayerLocationProvider { read(): LocationReading | null }
export interface HazardProvider { read(): HazardReading | null }
export interface OccupancyProvider { read(): OccupancyReading | null }
export interface GuidanceProvider { read(): GuidanceReading | null }

export interface ProviderBundle {
  mode: ProviderMode;
  ready: boolean;
  /** Why the bundle cannot be used (empty when ready). */
  notReady: string[];
  location: PlayerLocationProvider;
  hazard: HazardProvider;
  occupancy: OccupancyProvider;
  guidance: GuidanceProvider;
}

/** Freshness limits used to mark a reading stale (ms). */
export const FRESHNESS_MS = { location: 10_000, hazard: 5_000, occupancy: 10_000, guidance: 90_000 } as const;

export function isStale(timestamp: number, limitMs: number, now = Date.now()): boolean {
  return !Number.isFinite(timestamp) || now - timestamp > limitMs;
}

const nothing = { read: () => null };

/**
 * Real Mode: interfaces only. Each item below is work that must be done (and verified on site)
 * before any of these providers may return data.
 */
export const REAL_MODE_NOT_READY: string[] = [
  "ยังไม่มีระบบระบุตำแหน่งในอาคารที่ทดสอบแล้ว (QR/บีคอน/ครูยืนยัน) สำหรับทุกชั้น",
  "ยังไม่ได้เชื่อมเซนเซอร์ไฟ/ควันจริงผ่าน gateway ที่ผ่านการทดสอบ และยังไม่มีขั้นตอนเจ้าหน้าที่ยืนยันสัญญาณ",
  "ยังไม่มีข้อมูลจำนวนคนจริงต่อทางเดิน (กล้องนับคน/ครูนับ) ที่ตรวจสอบความแม่นยำแล้ว",
  "แผนที่ต้องสำรวจและยืนยันกับอาคารจริง (mapVersion ที่ลงนามโดยผู้รับผิดชอบ) และผ่านการซ้อมจริง",
  "ต้องผ่านการประเมินของผู้เชี่ยวชาญด้านความปลอดภัยอัคคีภัยและหน่วยงานที่เกี่ยวข้อง",
];

export function realModeProviders(): ProviderBundle {
  return { mode: "real", ready: false, notReady: REAL_MODE_NOT_READY, location: nothing, hazard: nothing, occupancy: nothing, guidance: nothing };
}

/**
 * Guard for anything that would feed Real Mode: a simulator reading is refused. (Real Mode is
 * disabled anyway; this keeps the rule explicit for whoever enables it later.)
 */
export function acceptForRealMode<T extends ProviderMeta>(reading: T | null): T | null {
  if (!reading) return null;
  if (reading.mode !== "real" || reading.source.startsWith("simulator")) throw new Error("ห้ามส่งข้อมูลจากแบบจำลองเข้าโหมดใช้งานจริง");
  return reading;
}
