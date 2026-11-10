/**
 * "▶ สาธิตการแก้ไข" — a guided demonstration of the model editor that edits the real map, step by
 * step, and then runs the simulation with those edits:
 *   1 fire marker  2 no-go area  3 closed passage  4 people in a room  5 run  6 clean up.
 * Every step can be done for the user ("ทำให้ดู") or by hand. Clean-up removes only what the demo
 * added and restores what it changed (other edits are untouched). Nothing here is hidden logic:
 * the same editor actions a user clicks are called.
 */
import { create } from "zustand";
import { useMapperStore } from "../store";
import { refreshEditorScenario, useEvacuationStore } from "../simulation/simulationStore";
import { analyzeEditorMap } from "../simulation/editorScenario";
import { modelPhysics } from "../simulation/modelPhysics";
import type { AnnotationType, SurfaceHit, Vec3 } from "../types";
import "./editor-demo.css";

interface DemoState {
  open: boolean;
  step: number;
  created: string[];
  connections: Record<string, boolean>;
  people: Record<string, number>;
  set: (patch: Partial<DemoState>) => void;
}
export const useEditorDemoStore = create<DemoState>((set) => ({ open: false, step: 0, created: [], connections: {}, people: {}, set: (patch) => set(patch) }));
export function openEditorDemo() { useEditorDemoStore.getState().set({ open: true, step: 0 }); }

const FIRE_NODE = "sim-corr-pink-f5-b3";
const NO_GO_NODE = "sim-stair-left-f5";
const CLOSED_EDGE = "edge-center-stair-door";
const ROOM = "b1-f9-pink-1";

function nodePosition(id: string): Vec3 | null {
  const node = useMapperStore.getState().annotations.find((item) => item.id === id);
  return node ? [...node.position] as Vec3 : null;
}
function hitAt(position: Vec3): SurfaceHit {
  return { position, worldPosition: position, normal: [0, 1, 0], objectName: "DEMO", objectPath: "/DEMO", materialName: "", triangleCount: 0 };
}
function placeMarker(type: AnnotationType, at: Vec3, name: string, size: Vec3, notes: string) {
  const mapper = useMapperStore.getState();
  // Already placed by this demo: show it again instead of adding a second one.
  const existing = useEditorDemoStore.getState().created.find((id) => mapper.annotations.find((item) => item.id === id)?.type === type);
  if (existing) { mapper.selectAnnotation(existing); mapper.requestCameraFocus(at); return; }
  const snap = mapper.snapEnabled;
  if (snap) mapper.setSnapEnabled(false);
  mapper.openDraftFromHit(hitAt(at), type);
  useMapperStore.getState().updateDraft({ name, shape: "box", size, notes });
  useMapperStore.getState().saveDraft();
  if (snap) useMapperStore.getState().setSnapEnabled(true);
  const id = useMapperStore.getState().selectedAnnotationId;
  if (id) { const demo = useEditorDemoStore.getState(); demo.set({ created: [...demo.created, id] }); }
  useMapperStore.getState().requestCameraFocus(at);
}

interface Step { title: string; text: string; how: string; run?: () => void; done?: () => boolean }

const steps: Step[] = [
  {
    title: "สาธิตการแก้ไขโมเดล",
    text: "การสาธิตนี้แก้ผังจริงทีละขั้น: ปักจุดไฟ กำหนดพื้นที่ห้ามผ่าน ปิดทาง และเปลี่ยนจำนวนคนในห้อง แล้วนำไปจำลองการอพยพ ทุกขั้นกด “ทำให้ดู” หรือทำเองตามคำอธิบายก็ได้",
    how: "สุดท้ายกด “ล้างการสาธิต” เพื่อคืนผังเหมือนก่อนเริ่ม",
  },
  {
    title: "1 · ปักจุดจำลองไฟ",
    text: "ปักไฟที่ทางเดินอาคาร 1 ชั้น 5 ปีกชมพู เมื่อเริ่มจำลอง ไฟจะเกิดตรงนี้",
    how: "ทำเอง: เครื่องมือ “ปักข้อมูล” → ชนิด “จุดจำลองไฟ” → คลิกตำแหน่งในโมเดล → บันทึก",
    run: () => {
      const at = nodePosition(FIRE_NODE);
      if (at) placeMarker("fire-source", at, "ไฟสาธิต · ทางเดินชั้น 5", [1.5, 1.5, 1.5], "สร้างโดยการสาธิตการแก้ไข");
    },
    done: () => useEditorDemoStore.getState().created.some((id) => useMapperStore.getState().annotations.find((item) => item.id === id)?.type === "fire-source"),
  },
  {
    title: "2 · กำหนดพื้นที่ห้ามผ่าน",
    text: "วางกล่อง “พื้นที่ห้ามผ่าน” ครอบบันไดซ้ายชั้น 5 ทุกช่วงทางที่ผ่านกล่องนี้จะถูกปิดในการจำลอง",
    how: "ทำเอง: ปักชนิด “พื้นที่ห้ามผ่าน” แล้วปรับขนาดด้วย T (หรือแก้ขนาดในแท็บข้อมูล)",
    run: () => {
      const at = nodePosition(NO_GO_NODE);
      if (at) placeMarker("restricted-area", at, "ห้ามผ่านสาธิต · บันไดซ้ายชั้น 5", [6, 3, 6], "สร้างโดยการสาธิตการแก้ไข");
    },
    done: () => useEditorDemoStore.getState().created.some((id) => useMapperStore.getState().annotations.find((item) => item.id === id)?.type === "restricted-area"),
  },
  {
    title: "3 · ปิดเส้นทาง",
    text: "ปิดประตูทางออกบันไดกลางชั้นล่าง (ปิดสวิตช์ “เปิดใช้งาน” ของเส้นทาง) คนจะต้องใช้ทางออกอื่น",
    how: "ทำเอง: แท็บ “รายการ” → เลือกเส้นทาง → ปิดสวิตช์ “เปิดใช้งาน” (อย่าลบเส้นทาง — การลบใช้จำลองไม่ได้)",
    run: () => {
      const mapper = useMapperStore.getState();
      const edge = mapper.connections.find((item) => item.id === CLOSED_EDGE);
      if (!edge) return;
      const demo = useEditorDemoStore.getState();
      if (!(CLOSED_EDGE in demo.connections)) demo.set({ connections: { ...demo.connections, [CLOSED_EDGE]: edge.enabled } });
      mapper.updateConnection(CLOSED_EDGE, { enabled: false });
      mapper.selectConnection(CLOSED_EDGE);
      const at = nodePosition(edge.fromId);
      if (at) mapper.requestCameraFocus(at);
    },
    done: () => useMapperStore.getState().connections.find((item) => item.id === CLOSED_EDGE)?.enabled === false,
  },
  {
    title: "4 · กำหนดจำนวนคนในห้อง",
    text: "ตั้งห้อง 901 ให้มี 40 คน (เต็มห้อง) เมื่อแก้จำนวนคน ระบบจะจำลองตามจำนวนในแต่ละห้องแทนแถบประชากร",
    how: "ทำเอง: เลือกห้องในแท็บ “รายการ” แล้วแก้ช่อง “จำนวนคน” ในแท็บข้อมูล",
    run: () => {
      const mapper = useMapperStore.getState();
      const room = mapper.annotations.find((item) => item.id === ROOM);
      if (!room) return;
      const demo = useEditorDemoStore.getState();
      if (!(ROOM in demo.people)) demo.set({ people: { ...demo.people, [ROOM]: room.peopleCount } });
      mapper.updateAnnotation(ROOM, { peopleCount: 40 });
      mapper.selectAnnotation(ROOM);
      mapper.requestCameraFocus([...room.position] as Vec3);
    },
    done: () => useMapperStore.getState().annotations.find((item) => item.id === ROOM)?.peopleCount === 40,
  },
  {
    title: "5 · จำลองด้วยผังที่แก้",
    text: "กลับหน้าจำลองแล้วเริ่มรอบใหม่ การ์ดความพร้อมจะขึ้น “ใช้การแก้ไขจากหน้าแก้ไขโมเดล” พร้อมรายการที่ใช้ สังเกตไฟที่ทางเดินชั้น 5 และคนที่เลี่ยงบันไดซ้ายกับประตูที่ปิด",
    how: "กด “เริ่มจำลองด้วยผังนี้” — กด “แก้ไขแบบจำลอง” เพื่อกลับมาล้างการสาธิตภายหลัง",
    run: () => {
      const evac = useEvacuationStore.getState();
      if (evac.status !== "idle") evac.reset();
      evac.setWorkMode("simulation");
      window.setTimeout(() => {
        const sim = useEvacuationStore.getState();
        const mapper = useMapperStore.getState();
        const analysis = analyzeEditorMap({ annotations: mapper.annotations, connections: mapper.connections, calibration: mapper.calibration, objects: mapper.objects, model: mapper.modelSource }, modelPhysics);
        if (analysis.runnable && sim.status === "idle") sim.start();
        else if (!analysis.runnable) mapper.addToast("warning", analysis.blockers[0] ?? "ยังเริ่มจำลองไม่ได้");
      }, 350);
    },
  },
  {
    title: "6 · ล้างการสาธิต",
    text: "ลบจุดไฟและพื้นที่ห้ามผ่านที่การสาธิตสร้าง เปิดเส้นทางกลับ และคืนจำนวนคนในห้องเดิม การแก้ไขอื่นของคุณจะไม่ถูกแตะ",
    how: "หรือใช้ Undo (Ctrl+Z) ย้อนทีละขั้น",
    run: () => cleanUpDemo(),
  },
];

export function cleanUpDemo() {
  const demo = useEditorDemoStore.getState();
  const mapper = useMapperStore.getState();
  for (const id of demo.created) if (mapper.annotations.some((item) => item.id === id)) useMapperStore.getState().deleteAnnotation(id);
  for (const [id, enabled] of Object.entries(demo.connections)) useMapperStore.getState().updateConnection(id, { enabled });
  for (const [id, count] of Object.entries(demo.people)) useMapperStore.getState().updateAnnotation(id, { peopleCount: count });
  demo.set({ created: [], connections: {}, people: {} });
  // End the demo run too, then drop its fire and closures from the 3D world right away.
  const evac = useEvacuationStore.getState();
  if (evac.status !== "idle") evac.reset();
  refreshEditorScenario();
  useMapperStore.getState().addToast("success", "ล้างการสาธิตแล้ว ผังกลับเหมือนก่อนเริ่มสาธิต");
}

export function EditorDemo() {
  const { open, step, set } = useEditorDemoStore();
  // Re-render when the map changes so "done" marks stay current.
  useMapperStore((state) => state.annotations);
  useMapperStore((state) => state.connections);
  const workMode = useEvacuationStore((state) => state.workMode);
  if (!open || workMode !== "editor") return null;
  const current = steps[step];
  const done = current.done?.() ?? false;
  const last = step === steps.length - 1;
  return (
    <section className="editor-demo" role="dialog" aria-labelledby="editor-demo-title" aria-live="polite">
      <header>
        <span>สาธิตการแก้ไข · {step + 1} / {steps.length}</span>
        <button type="button" aria-label="ปิดการสาธิต" onClick={() => set({ open: false })}>×</button>
      </header>
      <div className="editor-demo-progress" aria-hidden="true">{steps.map((item, index) => <i key={item.title} className={index <= step ? "is-on" : ""} />)}</div>
      <h2 id="editor-demo-title">{current.title}</h2>
      <p>{current.text}</p>
      <p className="editor-demo-how">{current.how}</p>
      {current.done && <p className={`editor-demo-state${done ? " is-done" : ""}`} role="status">{done ? "✓ ขั้นนี้เสร็จแล้ว" : "ยังไม่ได้ทำขั้นนี้"}</p>}
      <div className="editor-demo-actions">
        <button type="button" disabled={step === 0} onClick={() => set({ step: step - 1 })}>ย้อนกลับ</button>
        {current.run && <button type="button" className="is-primary" onClick={() => { current.run!(); if (!current.done && !last) set({ step: step + 1 }); }}>
          {step === 5 ? "เริ่มจำลองด้วยผังนี้" : last ? "ล้างการสาธิต" : done ? "ทำให้ดูอีกครั้ง" : "ทำให้ดู"}
        </button>}
        {!last ? <button type="button" onClick={() => set({ step: step + 1 })}>{step === 0 ? "เริ่ม →" : "ถัดไป →"}</button>
          : <button type="button" onClick={() => set({ open: false, step: 0 })}>จบการสาธิต</button>}
      </div>
    </section>
  );
}
