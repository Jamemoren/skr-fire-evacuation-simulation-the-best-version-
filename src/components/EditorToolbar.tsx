import { useMapperStore } from "../store";
import { openEditorDemo } from "./EditorDemo";
import { EditorSimStatus } from "./EditorSimStatus";
import { startAutoEditorDemo } from "./AutoEditorDemo";
import { useEffect } from "react";
import { modelPhysics } from "../simulation/modelPhysics";
import type { TransformMode } from "../types";

const tools: Array<{ id: TransformMode; label: string; key: string }> = [
  { id: "translate", label: "ย้าย", key: "G" }, { id: "rotate", label: "หมุน", key: "R" }, { id: "scale", label: "ขนาด", key: "T" },
];
export function deleteEditorSelection() {
  const state = useMapperStore.getState();
  const annotation = state.annotations.find((item) => item.id === state.selectedAnnotationId);
  const object = state.objects[state.selectedObjectId ?? ""];
  if (annotation?.locked || object?.locked) { state.addToast("warning", "ปลดล็อกวัตถุก่อนลบ"); return; }
  if (!state.selectedAnnotationId && !state.selectedConnectionId && !state.selectedObjectId) return;
  if (!window.confirm("ลบรายการที่เลือกหรือไม่? ใช้ Undo เพื่อคืนค่าได้")) return;
  if (state.selectedAnnotationId) state.deleteAnnotation(state.selectedAnnotationId);
  else if (state.selectedConnectionId) state.deleteConnection(state.selectedConnectionId);
  else if (state.selectedObjectId) state.patchObject(state.selectedObjectId, { deleted: true });
}
export function EditorToolbar() {
  const state = useMapperStore();
  // Capture the wall/floor model while the editor shows the whole building (needed to check moved
  // points and new passages later, even if the user then switches to a single floor).
  useEffect(() => { modelPhysics(); }, []);
  const node = state.annotations.find((item) => item.id === state.selectedAnnotationId);
  const object = state.modelObjects.find((item) => item.id === state.selectedObjectId);
  const objectEdit = state.objects[state.selectedObjectId ?? ""];
  const hasSelection = Boolean(node || object || state.selectedConnectionId);
  const locked = node?.locked || objectEdit?.locked || objectEdit?.deleted;
  const selectionName = state.transformTarget === "model" ? "ปรับทั้งโมเดล" : node?.name ?? (object ? objectEdit?.name ?? object.name : state.selectedConnectionId ? "เส้นทางที่เลือก" : "เลือกวัตถุในฉากเพื่อเริ่มแก้ไข");
  const addBox = () => {
    state.openDraftFromHit({ position: [0, 1, 0], worldPosition: [0, 1, 0], normal: [0, 1, 0], objectName: "", objectPath: "", materialName: "", triangleCount: 12 }, "custom");
    useMapperStore.getState().updateDraft({ name: "กล่องใหม่", shape: "box", size: [2, 2, 2] });
    useMapperStore.getState().saveDraft();
    state.setTransformTarget("selection");
    state.setTransformMode("translate");
    state.requestCameraFocus([0, 1, 0]);
  };
  return <div className="editor-transform-bar" role="toolbar" aria-label="เครื่องมือแก้ไข 3 มิติ" data-camera-inset="top">
    <div className="editor-transform-context"><span className="editor-context-dot" /><strong title={selectionName}>{selectionName}</strong><small>{locked ? "ล็อกอยู่" : state.transformTarget === "model" ? "Calibration" : hasSelection ? "พร้อมแก้ไข" : "3D EDITOR"}</small></div>
    <div className="editor-transform-controls">
    <select aria-label="เป้าหมายเครื่องมือ 3 มิติ" value={state.transformTarget} onChange={(event) => state.setTransformTarget(event.target.value as "selection" | "model")}>
      <option value="selection">รายการที่เลือก</option><option value="model">Calibration ทั้งโมเดล</option>
    </select>
    <div className="editor-tool-group">{tools.map((tool) => <button type="button" key={tool.id} aria-pressed={state.transformMode === tool.id} onClick={() => state.setTransformMode(tool.id)} title={tool.key}>{tool.label}<kbd>{tool.key}</kbd></button>)}</div>
    <button type="button" aria-pressed={state.transformSpace === "local"} onClick={() => useMapperStore.setState({ transformSpace: state.transformSpace === "world" ? "local" : "world" })}>{state.transformSpace === "local" ? "แกน Local" : "แกน World"}</button>
    <EditorSimStatus />
    <button type="button" className="editor-demo-launch is-auto" data-guide-target="auto-demo" onClick={() => startAutoEditorDemo("editor")} title="ระบบแก้ไขให้ดูเองทีละขั้นบนสำเนาชั่วคราว พร้อมจัดกล้องอัตโนมัติ">▶ ชมการสาธิตอัตโนมัติ</button>
    <button type="button" className="editor-demo-launch" onClick={openEditorDemo} title="ดูระบบปักไฟ กำหนดพื้นที่ห้ามผ่าน ปิดทาง และกำหนดคน แล้วจำลองให้ดูทีละขั้น">▶ สาธิตการแก้ไข</button>
    <button type="button" onClick={addBox}>＋ กล่อง</button>
    <button type="button" disabled={(!node && !object) || Boolean(locked)} title="ทำสำเนา (Ctrl+D)" onClick={() => {
      if (node) state.duplicateAnnotation(node.id);
      else if (object) state.duplicateObject(object.id);
    }}>ทำสำเนา</button>
    <button type="button" className="editor-delete-action" disabled={!hasSelection || Boolean(locked)} onClick={deleteEditorSelection}>ลบ</button>
    </div>
  </div>;
}
