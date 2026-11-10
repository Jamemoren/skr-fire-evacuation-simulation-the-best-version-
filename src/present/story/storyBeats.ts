/**
 * The narrated story, beat by beat. Each beat is stateless: it says what the camera frames, what is
 * drawn on the model and what the panel shows — so pausing, going back a section or replaying always
 * lands in a consistent state. Animated values inside a beat are a function of the beat's progress
 * (0…1), which only advances while the story plays.
 */
import { fmt } from "../../explain/routeExample";
import type { StoryLine, StoryMarker } from "../StoryOverlay3D";
import type { Vec3 } from "../../simulation/types";
import { storyModel, type StoryModel } from "./storyData";

export const COLORS = {
  routeA: "#40b8d5", routeB: "#8fb7ff", chosen: "#5ee0ff", queue: "#ffb547", closed: "#ff5a5f",
  distance: "#5fd3c6", travel: "#7aa7ff", hazard: "#ff7a6b", node: "#cfe3ff",
} as const;

export type PanelKind =
  | { kind: "question"; step: 0 | 1 | 2 | 3 | 4 }
  | { kind: "graph"; step: "nodes" | "edges" | "edge" }
  | { kind: "formula"; step: "full" | "simplify" | "values" | "substitute" }
  | { kind: "accumulate"; route: "A" | "B"; check: boolean }
  | { kind: "detailB" }
  | { kind: "queue"; step: "formula" | "ramp" | "hold" | "summary"; from: number; to: number }
  | { kind: "fire"; step: "fire" | "blocked" | "route" | "contrast" }
  | { kind: "closing" };

export interface Beat {
  id: string;
  chapter: number;
  ms: number;
  /** read aloud (when narration is on) and shown as the caption — the story works with sound off */
  caption: string;
  view: { mode: "exterior" | "single-floor"; floor?: number };
  targets(m: StoryModel): Vec3[];
  preferTop?: boolean;
  /** keep the camera at least this far (m) from what it frames — close-ups stay readable */
  minDistance?: number;
  /** overlay at progress p (0…1); called again only when its result changes (see `steps`) */
  overlay(m: StoryModel, p: number): { lines: StoryLine[]; markers: StoryMarker[] };
  /** how many distinct overlay states the beat has over its progress (1 = static) */
  steps?: number;
  panel: PanelKind;
  /** label ↔ formula pointers: [marker id on the model, term key in the panel] */
  connectors?: Array<[string, string]>;
}

export const CHAPTERS = ["ตั้งโจทย์", "ผังอาคาร → กราฟ", "สูตรและการแทนค่า", "จุดที่คำตอบเปลี่ยน", "ไฟปิดทาง", "สรุป"];

// ---------------------------------------------------------------- helpers
const node = (m: StoryModel, id: string) => m.nodes[id].position;
const ROOM = "b1-f2-pink-3", ZONE = "sim-zone-c", CSTAIR = "sim-stair-center-f2", LSTAIR = "sim-stair-left-f2";
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const floorOf = (points: Vec3[], y: number) => points.filter((p) => Math.abs(p[1] - y) < 1.6);
const segment = (m: StoryModel, route: "A" | "B", index: number): [Vec3, Vec3] => {
  const ids = route === "A" ? m.example.routeA.nodeIds : m.example.routeB.nodeIds;
  return [node(m, ids[index]), node(m, ids[index + 1])];
};

/** Room, both stairs and the assembly area stay on screen through every section as landmarks. */
function anchors(m: StoryModel, faded = false): StoryMarker[] {
  return [
    { id: "a-room", position: node(m, ROOM), kind: "person", label: faded ? undefined : "ห้อง 203 (เริ่ม)" },
    { id: "a-zone", position: node(m, ZONE), kind: "new", label: faded ? undefined : "จุดรวมพล Zone C" },
    { id: "a-cstair", position: node(m, CSTAIR), kind: "node", color: COLORS.routeA, label: faded ? undefined : "บันไดกลาง" },
    { id: "a-lstair", position: node(m, LSTAIR), kind: "node", color: COLORS.routeB, label: faded ? undefined : "บันไดซ้าย" },
  ];
}
const lineA = (m: StoryModel, extra: Partial<StoryLine> = {}): StoryLine => ({ id: "A", points: m.routePoints.A, color: COLORS.routeA, width: 6, label: `A · บันไดกลาง ${fmt(m.example.routeA.distance, 1)} ม.`, labelAt: 0.3, ...extra });
const lineB = (m: StoryModel, extra: Partial<StoryLine> = {}): StoryLine => ({ id: "B", points: m.routePoints.B, color: COLORS.routeB, width: 5, dashed: true, label: `B · บันไดซ้าย ${fmt(m.example.routeB.distance, 1)} ม.`, labelAt: 0.45, ...extra });
const NODE_TH: Record<string, string> = { room: "ห้อง", door: "ประตู", corridor: "ทางเดิน", junction: "ทางแยก", stair: "บันได", exit: "ทางออก", gate: "ประตูรั้ว", assembly: "จุดรวมพล" };

function graphMarkers(m: StoryModel, shown: number, labels = true): StoryMarker[] {
  // Nodes in walking order: route A, then the nodes only route B uses. The first of each kind is named.
  const order = [...m.example.routeA.nodeIds, ...m.example.routeB.nodeIds.filter((id) => !m.example.routeA.nodeIds.includes(id))];
  const named = new Set<string>();
  return order.slice(0, shown).map((id) => {
    const n = m.nodes[id];
    const first = !named.has(n.type);
    named.add(n.type);
    return { id: `n-${id}`, position: n.position, kind: "node", small: true, color: COLORS.node, label: first && labels ? `Node: ${NODE_TH[n.type] ?? n.type}` : undefined } satisfies StoryMarker;
  });
}
const graphNodeCount = (m: StoryModel) => new Set([...m.example.routeA.nodeIds, ...m.example.routeB.nodeIds]).size;

// ---------------------------------------------------------------- the beats
export function buildBeats(m: StoryModel = storyModel()): Beat[] {
  const A = m.example.routeA, B = m.example.routeB;
  const dA = m.detail.A, dB = m.detail.B;
  const stairSeg = segment(m, "A", dA.index);
  const bSeg = segment(m, "B", dB.index);
  const twoFloor = (p: Vec3[]) => [...floorOf(p, p[0][1]), node(m, CSTAIR), node(m, LSTAIR)];
  const routeAll = [...m.routePoints.A, ...m.routePoints.B];
  const single = { mode: "single-floor" as const, floor: 2 };
  return [
    // 0 — the question
    { id: "question", chapter: 0, ms: 7500, view: { mode: "exterior" }, targets: () => routeAll, preferTop: true,
      caption: "ถ้าบันไดกลางมีคนรอมากขึ้น เราควรเปลี่ยนไปใช้บันไดอีกทางเมื่อไหร่",
      overlay: () => ({ lines: [], markers: [] }), panel: { kind: "question", step: 0 } },
    { id: "room", chapter: 0, ms: 6500, view: single, targets: (mm) => [node(mm, ROOM), node(mm, "sim-door-b1-f2-pink-3"), node(mm, "sim-corr-pink-f2-b3")],
      caption: "เริ่มจากนักเรียนห้อง 203 อาคาร 1 ชั้น 2",
      overlay: (mm) => ({ lines: [], markers: anchors(mm).slice(0, 1) }), panel: { kind: "question", step: 1 } },
    { id: "zone", chapter: 0, ms: 6500, view: single, targets: (mm) => [node(mm, ROOM), node(mm, ZONE)],
      caption: "ปลายทางคือจุดรวมพล Zone C ที่สนาม",
      overlay: (mm) => ({ lines: [], markers: anchors(mm).slice(0, 2) }), panel: { kind: "question", step: 2 } },
    { id: "routeA", chapter: 0, ms: 7500, view: single, targets: () => m.routePoints.A,
      caption: `ทาง A ลงบันไดกลาง ระยะ ${fmt(A.distance, 1)} เมตร`,
      overlay: (mm) => ({ lines: [lineA(mm, { revealMs: 4200 })], markers: anchors(mm) }), panel: { kind: "question", step: 3 } },
    { id: "routeB", chapter: 0, ms: 7500, view: single, targets: () => routeAll,
      caption: `ทาง B ลงบันไดซ้าย ระยะ ${fmt(B.distance, 1)} เมตร ยาวกว่า แต่ไม่ต้องผ่านบันไดกลาง`,
      overlay: (mm) => ({ lines: [lineA(mm), lineB(mm, { revealMs: 4200 })], markers: anchors(mm) }), panel: { kind: "question", step: 4 } },

    // 1 — the building becomes a graph
    { id: "nodes", chapter: 1, ms: 9500, view: single, targets: () => twoFloor(m.routePoints.A), steps: graphNodeCount(m),
      caption: "จุด หรือ Node คือห้อง ประตู ทางแยก บันได ทางออก และจุดรวมพล ตามข้อมูลจริงของอาคาร",
      overlay: (mm, p) => ({ lines: [], markers: [...anchors(mm, true), ...graphMarkers(mm, Math.max(1, Math.ceil(p * graphNodeCount(mm))))] }),
      panel: { kind: "graph", step: "nodes" } },
    { id: "edges", chapter: 1, ms: 8500, view: single, targets: () => twoFloor(m.routePoints.A),
      caption: "เส้น หรือ Edge เชื่อมจุดตามทางที่เดินได้จริง แต่ละเส้นรู้ระยะ ความกว้าง และความจุ",
      overlay: (mm) => ({ lines: [lineA(mm, { revealMs: 5000, label: undefined, width: 4 }), lineB(mm, { revealMs: 5000, label: undefined, width: 3 })], markers: [...anchors(mm, true), ...graphMarkers(mm, 99)] }),
      panel: { kind: "graph", step: "edges" } },
    { id: "edge", chapter: 1, ms: 8500, view: single, targets: () => [...stairSeg, node(m, "sim-junction-f2")],
      caption: "ตัวอย่าง Edge หนึ่งเส้น บันไดกลางจากชั้น 2 ลงชั้น 1",
      overlay: (mm) => ({ lines: [lineA(mm, { label: undefined, width: 3 }), { id: "seg", points: stairSeg, color: COLORS.chosen, width: 10, label: "Edge: บันไดกลาง ชั้น 2 → 1" }], markers: anchors(mm, true) }),
      panel: { kind: "graph", step: "edge" } },

    // 2 — formula and substitution
    { id: "formula", chapter: 2, ms: 10000, view: single, targets: () => [...stairSeg, node(m, "sim-junction-f2")],
      caption: "ต้นทุนของแต่ละเส้น คิดจากระยะทาง เวลาเดิน คิว ความแออัด และอันตรายจากไฟ ควัน ความร้อน",
      overlay: (mm) => ({ lines: [{ id: "seg", points: stairSeg, color: COLORS.chosen, width: 10 }], markers: anchors(mm, true) }),
      panel: { kind: "formula", step: "full" } },
    { id: "simplify", chapter: 2, ms: 8000, view: single, targets: () => [...stairSeg, node(m, "sim-junction-f2")],
      caption: "กรณีนี้ไม่มีไฟและยังไม่มีคนรอ พจน์คิวและอันตรายจึงเป็นศูนย์ เหลือระยะทางกับเวลาเดิน",
      overlay: (mm) => ({ lines: [{ id: "seg", points: stairSeg, color: COLORS.chosen, width: 10 }], markers: anchors(mm, true) }),
      panel: { kind: "formula", step: "simplify" } },
    { id: "values", chapter: 2, ms: 8000, view: single, targets: () => [...stairSeg, node(m, "sim-junction-f2")],
      caption: `อ่านค่าจากข้อมูลจริง ระยะ ${dA.sub.d} เมตร ความเร็วบนบันได ${dA.sub.v} เมตรต่อวินาที`,
      overlay: (mm) => ({ lines: [{ id: "seg", points: stairSeg, color: COLORS.chosen, width: 10 }], markers: [...anchors(mm, true),
        { id: "v-d", position: mid(stairSeg[0], stairSeg[1]), kind: "node", color: COLORS.distance, big: true, label: `d = ${dA.sub.d} ม.` },
        { id: "v-v", position: stairSeg[1], kind: "node", color: COLORS.travel, big: true, label: `v = ${dA.sub.v} ม./วิ` }] }),
      panel: { kind: "formula", step: "values" }, connectors: [["v-d", "d"], ["v-v", "v"]] },
    { id: "substitute", chapter: 2, ms: 9000, view: single, targets: () => [...stairSeg, node(m, "sim-junction-f2")],
      caption: `แทนค่า ศูนย์จุดสองแปด คูณระยะ บวกระยะหารความเร็ว ได้ ${dA.sub.result}`,
      overlay: (mm) => ({ lines: [{ id: "seg", points: stairSeg, color: COLORS.chosen, width: 10, label: `= ${dA.sub.result}` }], markers: [...anchors(mm, true),
        { id: "v-d", position: mid(stairSeg[0], stairSeg[1]), kind: "node", color: COLORS.distance, big: true, label: `d = ${dA.sub.d} ม.` },
        { id: "v-v", position: stairSeg[1], kind: "node", color: COLORS.travel, big: true, label: `v = ${dA.sub.v} ม./วิ` }] }),
      panel: { kind: "formula", step: "substitute" }, connectors: [["v-d", "d"], ["v-v", "v"]] },
    { id: "sumA", chapter: 2, ms: 13000, view: single, targets: () => m.routePoints.A, steps: A.rows.length,
      caption: "รวมต้นทุนทุกช่วงของทาง A ตามลำดับการเดิน",
      overlay: (mm, p) => {
        const i = Math.min(A.rows.length - 1, Math.floor(p * A.rows.length));
        return { lines: [lineA(mm, { label: undefined, width: 4 }), { id: `segA-${i}`, points: segment(mm, "A", i), color: COLORS.chosen, width: 11 }], markers: anchors(mm) };
      },
      panel: { kind: "accumulate", route: "A", check: false } },
    { id: "checkA", chapter: 2, ms: 7000, view: single, targets: () => m.routePoints.A,
      caption: `ทาง A รวม ${fmt(A.total, 3)} ตรงกับที่โปรแกรมคำนวณ`,
      overlay: (mm) => ({ lines: [lineA(mm, { label: `A = ${fmt(A.total, 3)}` })], markers: anchors(mm) }),
      panel: { kind: "accumulate", route: "A", check: true } },
    { id: "detailB", chapter: 2, ms: 10000, view: single, targets: () => [...bSeg, node(m, LSTAIR)],
      caption: `ทาง B มีช่วงเดินนอกอาคารยาว ${dB.sub.d} เมตร ต้นทุนช่วงนี้ ${dB.sub.result}`,
      overlay: (mm) => ({ lines: [lineB(mm, { label: undefined }), { id: "segB", points: bSeg, color: COLORS.routeB, width: 11, label: `= ${dB.sub.result}` }], markers: [...anchors(mm),
        { id: "v-dB", position: mid(bSeg[0], bSeg[1]), kind: "node", color: COLORS.distance, big: true, label: `d = ${dB.sub.d} ม.` }] }),
      panel: { kind: "detailB" }, connectors: [["v-dB", "dB"]] },
    { id: "sumB", chapter: 2, ms: 11000, view: single, targets: () => routeAll, steps: B.rows.length,
      caption: `ทาง B รวม ${fmt(B.total, 3)} มากกว่าทาง A ระบบจึงเลือกทาง A เมื่อยังไม่มีคนรอ`,
      overlay: (mm, p) => {
        const i = Math.min(B.rows.length - 1, Math.floor(p * 0.75 * B.rows.length));
        return { lines: [lineA(mm, { label: `A = ${fmt(A.total, 3)}` }), lineB(mm, { label: undefined }), { id: `segB-${i}`, points: segment(mm, "B", i), color: COLORS.routeB, width: 11 }], markers: anchors(mm) };
      },
      panel: { kind: "accumulate", route: "B", check: true } },

    // 3 — where the answer changes
    { id: "queueFormula", chapter: 3, ms: 10000, view: single, targets: () => [...stairSeg, node(m, "sim-junction-f2")],
      caption: "ถ้ามีคนวางแผนใช้บันไดกลางอยู่แล้ว L คน ต้นทุนบันไดกลางเพิ่มจากเวลารอคิวและความแออัด",
      overlay: (mm) => ({ lines: [lineA(mm, { color: COLORS.queue, label: undefined }), { id: "seg", points: stairSeg, color: COLORS.queue, width: 11, label: "คิว L คน" }], markers: anchors(mm, true) }),
      panel: { kind: "queue", step: "formula", from: 0, to: 0 } },
    { id: "ramp1", chapter: 3, ms: 6500, view: single, targets: () => routeAll,
      caption: "เพิ่มคนรอทีละขั้น ต้นทุนทาง A เพิ่มขึ้นเป็นเส้นตรง ทาง B คงที่",
      overlay: (mm) => ({ lines: [lineA(mm, { color: COLORS.queue }), lineB(mm)], markers: anchors(mm) }),
      panel: { kind: "queue", step: "ramp", from: 0, to: 20 } },
    { id: "ramp2", chapter: 3, ms: 5500, view: single, targets: () => routeAll,
      caption: "ยิ่งใกล้ทาง B ส่วนต่างยิ่งน้อยลง",
      overlay: (mm) => ({ lines: [lineA(mm, { color: COLORS.queue }), lineB(mm)], markers: anchors(mm) }),
      panel: { kind: "queue", step: "ramp", from: 20, to: m.breakEven.before.load } },
    { id: "at27", chapter: 3, ms: 9000, view: single, targets: () => routeAll,
      caption: `ที่ ${m.breakEven.before.load} คน ทาง A ยังถูกกว่า โปรแกรมยังเลือกทาง A`,
      overlay: (mm) => ({ lines: [lineA(mm, { color: COLORS.queue, label: `A = ${fmt(m.breakEven.before.costA, 3)}`, width: 8, labelAt: 0.62 }), lineB(mm, { label: `B = ${fmt(m.breakEven.before.costB, 3)}` })], markers: anchors(mm) }),
      panel: { kind: "queue", step: "hold", from: m.breakEven.before.load, to: m.breakEven.before.load } },
    { id: "at28", chapter: 3, ms: 10000, view: single, targets: () => routeAll,
      caption: `ที่ ${m.breakEven.after.load} คน ทาง A แพงกว่าแล้ว โปรแกรมเปลี่ยนไปเลือกทาง B`,
      overlay: (mm) => ({ lines: [lineA(mm, { color: COLORS.queue, width: 3, label: `A = ${fmt(m.breakEven.after.costA, 3)}`, labelAt: 0.62 }), lineB(mm, { color: COLORS.chosen, dashed: false, width: 9, label: `B = ${fmt(m.breakEven.after.costB, 3)} ✓ เลือก` })], markers: anchors(mm) }),
      panel: { kind: "queue", step: "hold", from: m.breakEven.after.load, to: m.breakEven.after.load } },
    { id: "queueSummary", chapter: 3, ms: 8000, view: single, targets: () => routeAll,
      caption: `คิดมือได้ ${m.breakEven.hand} คน โปรแกรมเปลี่ยนที่ ${m.breakEven.program} คน ตรงกัน`,
      overlay: (mm) => ({ lines: [lineA(mm, { color: COLORS.queue, width: 3 }), lineB(mm, { color: COLORS.chosen, dashed: false, width: 9 })], markers: anchors(mm) }),
      panel: { kind: "queue", step: "summary", from: m.breakEven.after.load, to: m.breakEven.after.load } },

    // 4 — fire closes the way
    { id: "fire", chapter: 4, ms: 8000, view: single, targets: () => [node(m, CSTAIR), node(m, "sim-junction-f2"), node(m, ROOM)],
      caption: "อีกกรณีหนึ่ง ไม่มีคนรอ แต่มีไฟที่ชานพักบันไดกลางชั้น 2",
      overlay: (mm) => ({ lines: [lineA(mm, { label: undefined, width: 3 })], markers: [...anchors(mm), { id: "fire", position: mm.fire.position, kind: "fire", label: `ไฟ รัศมี ${fmt(mm.fire.radius, 1)} ม.` }] }),
      panel: { kind: "fire", step: "fire" } },
    { id: "blocked", chapter: 4, ms: 9000, view: single, targets: () => [node(m, CSTAIR), node(m, "sim-junction-f2"), node(m, "sim-stair-center-f1")],
      caption: "เส้นที่อยู่ในเปลวไฟถูกตัดออกจากการค้นหา ต้นทุนเป็นอนันต์ ไม่ใช่แค่แพงขึ้น",
      overlay: (mm) => ({ lines: mm.fire.blocked.map((edge, i) => ({ id: `x-${edge.edgeId}`, points: edge.points, color: COLORS.closed, width: 8, dashed: true, label: i === 0 ? "ตัดออก (∞)" : undefined })),
        markers: [...anchors(mm, true), { id: "fire", position: mm.fire.position, kind: "fire" }, ...mm.fire.blocked.map((edge) => ({ id: `c-${edge.edgeId}`, position: mid(edge.points[0], edge.points[1]), kind: "closed" as const }))] }),
      panel: { kind: "fire", step: "blocked" } },
    { id: "fireRoute", chapter: 4, ms: 9000, view: single, targets: () => [...m.routePoints.fire, node(m, CSTAIR)],
      caption: "โปรแกรมค้นหาใหม่โดยไม่มีเส้นที่ถูกตัด ได้ทางลงบันไดซ้าย",
      overlay: (mm) => ({ lines: [...mm.fire.blocked.map((edge) => ({ id: `x-${edge.edgeId}`, points: edge.points, color: COLORS.closed, width: 7, dashed: true })),
        { id: "F", points: mm.routePoints.fire, color: COLORS.chosen, width: 8, revealMs: 4000, label: `ทางใหม่ = ${fmt(mm.fire.route?.programTotal ?? 0, 3)}`, labelAt: 0.62 }],
        markers: [...anchors(mm), { id: "fire", position: mm.fire.position, kind: "fire" }] }),
      panel: { kind: "fire", step: "route" } },
    { id: "contrast", chapter: 4, ms: 10000, view: single, targets: () => routeAll,
      caption: "คิวทำให้ต้นทุนเพิ่มทีละน้อยจนอีกทางคุ้มกว่า ส่วนไฟทำให้เส้นนั้นใช้ไม่ได้เลย เป็นคนละเงื่อนไขกัน",
      overlay: (mm) => ({ lines: [{ id: "F", points: mm.routePoints.fire, color: COLORS.chosen, width: 7 }, ...mm.fire.blocked.map((edge) => ({ id: `x-${edge.edgeId}`, points: edge.points, color: COLORS.closed, width: 7, dashed: true }))],
        markers: [...anchors(mm), { id: "fire", position: mm.fire.position, kind: "fire" }] }),
      panel: { kind: "fire", step: "contrast" } },

    // 5 — everything together
    { id: "closing", chapter: 5, ms: 11000, view: single, targets: () => routeAll, preferTop: true,
      caption: "ผังอาคาร กราฟ สมการ และเส้นทางที่โปรแกรมเลือก มาจากการคำนวณชุดเดียวกัน ลองปรับจำนวนคนรอได้เอง",
      overlay: (mm) => ({ lines: [lineA(mm, { label: `A = ${fmt(A.total, 3)} ✓ เลือก`, color: COLORS.chosen, width: 8 }), lineB(mm, { label: `B = ${fmt(B.total, 3)}` })], markers: [...anchors(mm), ...graphMarkers(mm, 99, false)] }),
      panel: { kind: "closing" } },
  ];
}

export const chapterStarts = (beats: Beat[]) => CHAPTERS.map((_, chapter) => beats.findIndex((beat) => beat.chapter === chapter));
export const totalMs = (beats: Beat[]) => beats.reduce((sum, beat) => sum + beat.ms, 0);
