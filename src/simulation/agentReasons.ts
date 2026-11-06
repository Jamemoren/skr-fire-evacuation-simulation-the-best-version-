/**
 * Explicit occupant behaviour states and testable decision reason codes.
 *
 * The runtime stores only codes + numeric/text parameters that were actually used by the
 * decision. Thai sentences are generated from those values on demand, so the explanation shown
 * to a user can never drift from the data that drove the choice.
 */

export type AgentBehaviorState =
  | "unaware" // ยังไม่รับรู้เหตุ
  | "assessing" // รับรู้และประเมินสถานการณ์
  | "preparing" // เตรียมอพยพ/หน่วงเวลาก่อนออก
  | "leaving-room" // เดินออกจากห้อง
  | "moving" // เดินตามเส้นทาง
  | "queueing" // รอคิว (การซ้อมแบบเป็นระเบียบ)
  | "crowding" // เบียดกันเข้าประตู/บันได (สถานการณ์จริง)
  | "on-stairs" // เดินลงบันได
  | "replanning" // ประเมินทางเลือกใหม่
  | "holding" // รอในตำแหน่งที่ปลอดภัยกว่าเมื่อไปต่อไม่ได้
  | "arrived" // ถึงจุดรวมพล
  | "incapacitated"; // เคลื่อนไหวไม่ได้

export const BEHAVIOR_LABEL_TH: Record<AgentBehaviorState, string> = {
  unaware: "ยังไม่รับรู้เหตุ",
  assessing: "รับรู้และประเมินสถานการณ์",
  preparing: "เตรียมอพยพ",
  "leaving-room": "กำลังออกจากห้อง",
  moving: "เดินตามเส้นทาง",
  queueing: "รอคิว",
  crowding: "เบียดกันเข้าทางออก",
  "on-stairs": "กำลังลงบันได",
  replanning: "ประเมินทางเลือกใหม่",
  holding: "รอในจุดที่ปลอดภัยกว่า",
  arrived: "ถึงจุดรวมพล",
  incapacitated: "เคลื่อนไหวไม่ได้",
};

/** How the person currently knows that something is wrong. */
export type AwarenessSource = "none" | "alarm" | "others-leaving" | "report" | "smoke" | "heat" | "flame" | "controller";

export const AWARENESS_LABEL_TH: Record<AwarenessSource, string> = {
  none: "ยังไม่รับรู้",
  alarm: "ได้ยินสัญญาณเตือน",
  "others-leaving": "เห็นคนรอบตัวเริ่มอพยพ",
  report: "ได้รับแจ้งจากคนในพื้นที่",
  smoke: "ได้กลิ่น/เห็นควัน",
  heat: "รู้สึกถึงความร้อน",
  flame: "เห็นเปลวไฟ",
  controller: "ได้รับคำสั่งจากผู้ควบคุม",
};

export type DecisionReasonCode =
  | "not-aware"
  | "pre-movement"
  | "initial-familiar-route"
  | "initial-group-route"
  | "initial-controller-plan"
  | "follow-plan"
  | "keep-route-with-queue"
  | "keep-route-cooldown"
  | "keep-route-crowd"
  | "switch-shorter-queue"
  | "switch-hazard"
  | "switch-closed"
  | "switch-controller"
  | "follow-group"
  | "follow-phone"
  | "waiting-door-space"
  | "waiting-stair-space"
  | "waiting-space"
  | "pushing-door"
  | "pushing-stair"
  | "pushing-space"
  | "jammed-opening"
  | "local-detour"
  | "retreat-hazard"
  | "no-route-reassess"
  | "holding-hazard"
  | "holding-repeat-hazard"
  | "retry-same-route"
  | "arrived"
  | "incapacitated-flame";

export interface DecisionReason {
  code: DecisionReasonCode;
  at: number;
  /** Only values actually used by the decision. */
  params?: Record<string, string | number>;
}

function seconds(value: unknown): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `${Math.max(0, Math.round(number))} วินาที`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

/** Human-readable Thai explanation generated from the stored code and its parameters. */
export function describeReasonTh(reason: DecisionReason | null | undefined): string {
  if (!reason) return "ยังไม่มีการตัดสินใจ";
  const p = reason.params ?? {};
  switch (reason.code) {
    case "not-aware": return "ยังไม่ได้ยินสัญญาณหรือพบสิ่งผิดปกติ";
    case "pre-movement": return `รับรู้แล้ว กำลังเก็บของ/รอเพื่อนก่อนออก (อีก ${seconds(p.remaining)})`;
    case "initial-familiar-route": return `เลือก${text(p.via, "ทาง")}ที่คุ้นเคย/คิดว่าใกล้ที่สุด`;
    case "initial-group-route": return `ออกพร้อมกลุ่มเพื่อนผ่าน${text(p.via, "ทางเดียวกัน")}`;
    case "initial-controller-plan": return `เดินตามแผนที่ผู้ควบคุมกำหนดผ่าน${text(p.via, "เส้นทางที่จัดสรร")}`;
    case "follow-plan": return "เดินตามแผนเดิม ยังไม่พบเหตุที่ต้องเปลี่ยน";
    case "keep-route-with-queue": return `ทางเดิมยังเร็วกว่าเมื่อรวมเวลารอ (เดิม ~${seconds(p.current)} · ทางอื่น ~${seconds(p.best)})`;
    case "keep-route-cooldown": return "เพิ่งเปลี่ยนเส้นทาง จึงยังไม่เปลี่ยนซ้ำถ้าไม่มีอันตราย";
    case "keep-route-crowd": return `ตามฝูงคนที่มุ่งไปทางเดียวกัน ไม่ยอมเสียตำแหน่งที่เบียดมาได้ (ทางเดิม ~${seconds(p.current)} · ทางอื่น ~${seconds(p.best)})`;
    case "switch-shorter-queue": return `คิว${text(p.from, "ทางเดิม")}ยาว (~${seconds(p.wait)}) จึงเปลี่ยนไป${text(p.to, "ทางที่ว่างกว่า")}`;
    case "switch-hazard": return `พบ${text(p.hazard, "อันตราย")}ด้านหน้า จึงเปลี่ยนไป${text(p.to, "ทางอื่น")}`;
    case "switch-closed": return `พบ${text(p.closed, "ทางข้างหน้า")}ถูกปิด จึงเปลี่ยนไป${text(p.to, "ทางอื่น")}`;
    case "switch-controller": return `ผู้ควบคุมสั่งให้ใช้${text(p.to, "เส้นทางใหม่")}`;
    case "follow-group": return `ตามกลุ่มเพื่อนไป${text(p.to, "ทางเดียวกัน")}`;
    case "follow-phone": return `ทำตามคำแนะนำในมือถือ ไปทาง${text(p.to, "ที่ระบบแนะนำ")}${text(p.why) ? ` (${text(p.why)})` : ""}`;
    case "waiting-door-space": return "กำลังรอพื้นที่ว่างหน้าประตู";
    case "waiting-stair-space": return "กำลังรอพื้นที่ว่างเพื่อเข้าบันได";
    case "waiting-space": return "กำลังรอช่องว่างข้างหน้า";
    case "pushing-door": return "เบียดเข้าหาประตู ไม่มีการต่อแถว — ใครใกล้และดันแรงกว่าได้ผ่านก่อน";
    case "pushing-stair": return "เบียดเข้าหาทางลงบันไดพร้อมกับคนจากชั้นอื่น";
    case "pushing-space": return "เบียดหาช่องว่างข้างหน้าในฝูงคน";
    case "jammed-opening": return "ช่องทางติดขัดชั่วขณะ คนอัดกันจนไม่มีใครผ่านได้";
    case "local-detour": return "เดินอ้อมไฟภายในทางเดินที่กว้างพอ";
    case "retreat-hazard": return "ถอยกลับตามทางที่เดินมาเพื่อหลบอันตราย";
    case "no-route-reassess": return `ยังไม่พบเส้นทางที่ใช้งานได้ กำลังประเมินใหม่ (ครั้งถัดไปใน ${seconds(p.retryIn)})`;
    case "holding-hazard": return "หยุดก่อนถึงขอบอันตรายที่ตรวจพบ และรอประเมินใหม่";
    case "retry-same-route": return `ลองไปทาง ${text(p.via, "เส้นทางเดิม")} อีกครั้ง (เส้นทางเดิม ไม่ได้เปลี่ยนทาง) — ถ้ายังอันตรายจะถอยกลับไปรอ`;
    case "holding-repeat-hazard": return `ติดอยู่: ${text(p.passage, "ทางข้างหน้า")}มี${text(p.hazard, "อันตราย")} (หยุดก่อนถึง ${typeof p.count === "number" ? p.count : "หลาย"} ครั้งใน 30 วินาที) และยังไม่มีทางอื่น — รอที่จุดปลอดภัย ประเมินใหม่ทุก ${seconds(p.retryIn)}`;
    case "arrived": return "ถึงพื้นที่จุดรวมพลแล้ว";
    case "incapacitated-flame": return "สัมผัสเปลวไฟต่อเนื่องจนเคลื่อนไหวไม่ได้";
    default: return "—";
  }
}

/** Short, parameter-free label per reason code, for grouping on the results screen. */
const SHORT_REASON_TH: Partial<Record<DecisionReasonCode, string>> = {
  "no-route-reassess": "ไม่มีทางที่ปลอดภัยตามที่รู้ — รอประเมินใหม่",
  "holding-repeat-hazard": "ทางข้างหน้ามีควัน/ความร้อน/ไฟ — หยุดรอที่จุดปลอดภัย",
  "holding-hazard": "หยุดก่อนถึงขอบอันตราย",
  "retry-same-route": "กำลังลองเส้นทางเดิมอีกครั้ง",
  "switch-hazard": "เปลี่ยนทางเพราะไฟ/ความร้อน/ควัน",
  "switch-closed": "เปลี่ยนทางเพราะทางถูกปิด",
  "switch-shorter-queue": "เปลี่ยนไปทางที่คิวสั้นกว่า",
  "switch-controller": "เปลี่ยนทางตามผู้ควบคุม",
  "follow-group": "เปลี่ยนทางตามกลุ่ม",
  "follow-plan": "ปรับแผนเส้นทาง",
};

export function shortReasonTh(code: string, example?: DecisionReason): string {
  return SHORT_REASON_TH[code as DecisionReasonCode] ?? (example ? describeReasonTh(example) : code);
}
