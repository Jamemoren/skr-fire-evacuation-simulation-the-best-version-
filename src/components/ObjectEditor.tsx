import { useState } from "react";
import { useMapperStore } from "../store";
import type { ModelObjectEdit, Vec3 } from "../types";

export function ObjectEditor() {
  const state = useMapperStore();
  const object = state.modelObjects.find((item) => item.id === state.selectedObjectId);
  if (!object) return <div className="empty-state">เลือกวัตถุจากโมเดล GLB หรือรายการวัตถุ</div>;
  const edit = state.objects[object.id] ?? {};
  const patch = (value: ModelObjectEdit) => state.patchObject(object.id, value);
  const change = (key: "position" | "rotation" | "scale", axis: number, value: number) => {
    if (!Number.isFinite(value)) return;
    const next = [...edit[key] ?? object[key]] as Vec3;
    next[axis] = key === "scale" ? Math.max(0.00001, value) : value;
    patch({ [key]: next });
  };
  return (
    <div className="form-stack compact-form object-editor">
      <div className="panel-heading-row"><div><span className="eyebrow">วัตถุใน GLB</span><h3>{edit.name ?? object.name}</h3></div></div>
      <label>ชื่อวัตถุ<input aria-label="ชื่อวัตถุ 3D" value={edit.name ?? object.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      {(["position", "rotation", "scale"] as const).map((key) => (
        <fieldset key={key}>
          <legend>{key === "position" ? "ตำแหน่ง" : key === "rotation" ? "หมุน (องศา)" : "ขนาด"} · Local X / Y / Z</legend>
          <div className="field-grid three-columns">
            {[0, 1, 2].map((axis) => {
              const value = (edit[key] ?? object[key])[axis];
              return <label key={axis}>{"XYZ"[axis]}<input aria-label={`Object ${key} ${"XYZ"[axis]}`} disabled={edit.locked || edit.deleted}
                type="number" step={key === "rotation" ? 1 : 0.1} value={Number((key === "rotation" ? value * 180 / Math.PI : value).toFixed(5))}
                onChange={(event) => change(key, axis, event.currentTarget.valueAsNumber * (key === "rotation" ? Math.PI / 180 : 1))} /></label>;
            })}
          </div>
        </fieldset>
      ))}
      <label>สีวัสดุ<input type="color" disabled={edit.locked} value={edit.color ?? object.color} onChange={(event) => patch({ color: event.target.value })} /></label>
      <label className="switch-row"><input type="checkbox" checked={edit.visible !== false} onChange={(event) => patch({ visible: event.target.checked })} />แสดงวัตถุ</label>
      <label className="switch-row"><input type="checkbox" checked={edit.locked === true} onChange={(event) => patch({ locked: event.target.checked })} />ล็อกการปรับรูปทรง</label>
      <div className="button-grid two">
        <button type="button" className="button secondary" onClick={() => state.duplicateObject(object.id)}>ทำสำเนาวัตถุ</button>
        <button type="button" className="button secondary" onClick={() => patch({ position: object.position, rotation: object.rotation, scale: object.scale, visible: true, deleted: false, color: object.color })}>คืนค่ารูปทรง</button>
        <button type="button" className="button danger full-span" disabled={edit.locked} onClick={() => {
          if (edit.deleted || window.confirm("ลบวัตถุที่เลือกหรือไม่? ใช้ Undo เพื่อคืนค่าได้")) patch({ deleted: !edit.deleted });
        }}>{edit.deleted ? "คืนวัตถุที่ลบ" : "ลบวัตถุ"}</button>
      </div>
      <p className="help-text">ลากแกนในฉากเพื่อย้าย หมุน หรือปรับขนาด การแก้ไขจะบันทึกรวมในไฟล์โปรเจกต์</p>
    </div>
  );
}

export function ObjectList() {
  const [query, setQuery] = useState("");
  const objects = useMapperStore((state) => state.modelObjects);
  const edits = useMapperStore((state) => state.objects);
  const selected = useMapperStore((state) => state.selectedObjectId);
  const select = useMapperStore((state) => state.selectObject);
  const filtered = objects.filter((object) => `${edits[object.id]?.name ?? object.name} ${object.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="editor-object-browser">
    <div className="editor-list-heading"><strong>วัตถุในฉาก</strong><span>{filtered.length} / {objects.length}</span></div>
    <input type="search" aria-label="ค้นหาวัตถุ 3D" placeholder="ค้นหาชื่อวัตถุ…" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="model-object-list">
    {!objects.length && <p className="empty-state">นำเข้า GLB เพื่อจัดการวัตถุ 3 มิติแยกชิ้น</p>}
    {objects.length > 0 && !filtered.length && <p className="empty-state">ไม่พบวัตถุ ลองค้นหาด้วยชื่ออื่น</p>}
    {filtered.map((object) => <button type="button" key={object.id} aria-pressed={selected === object.id} className={selected === object.id ? "is-selected" : ""} onClick={() => select(object.id)}>
      <span className="editor-object-icon" aria-hidden="true">◇</span>
      <div><strong>{edits[object.id]?.name ?? object.name}</strong><small>{edits[object.id]?.deleted ? "ลบแล้ว · กดเพื่อคืนค่า" : object.id}</small></div>
      <span className="editor-object-flags">
        {selected === object.id && <b className="is-selected">เลือกอยู่</b>}
        {edits[object.id]?.locked && <b className="is-locked">ล็อก</b>}
        {edits[object.id]?.visible === false && <b className="is-hidden">ซ่อน</b>}
        {edits[object.id]?.deleted && <b className="is-deleted">ลบ</b>}
      </span>
    </button>)}
    </div>
  </div>;
}
