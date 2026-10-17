import { ANNOTATION_LABELS } from "../constants";
import { useMapperStore } from "../store";
import type { AnnotationType, Vec3 } from "../types";
import { formatVec3 } from "../utils/format";

function updateVector(source: Vec3, index: number, value: number): Vec3 {
  const next: Vec3 = [...source];
  next[index] = value;
  return next;
}

export function AnnotationDialog() {
  const draft = useMapperStore((state) => state.draft);
  const updateDraft = useMapperStore((state) => state.updateDraft);
  const closeDraft = useMapperStore((state) => state.closeDraft);
  const saveDraft = useMapperStore((state) => state.saveDraft);
  if (!draft) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={closeDraft}>
      <section className="modal annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="annotation-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="eyebrow">MODEL-LOCAL {formatVec3(draft.hit.position, 3)}</span>
            <h2 id="annotation-title">ระบุความหมายของตำแหน่ง</h2>
          </div>
          <button type="button" className="icon-button" onClick={closeDraft} aria-label="ปิด">×</button>
        </div>
        <div className="modal-body form-stack">
          <div className="notice info">
            <strong>วัตถุที่คลิก:</strong> {draft.hit.objectName}<br />
            <small>{draft.hit.objectPath}</small>
          </div>
          <div className="coordinate-preview">
            <div><span>Local</span><strong>{formatVec3(draft.hit.position, 5)}</strong></div>
            <div><span>World</span><strong>{formatVec3(draft.hit.worldPosition, 5)}</strong></div>
          </div>
          <div className="field-grid two-columns">
            <label>ประเภท
              <select value={draft.type} onChange={(event) => updateDraft({ type: event.target.value as AnnotationType })}>
                {(Object.keys(ANNOTATION_LABELS) as AnnotationType[]).map((type) => <option key={type} value={type}>{ANNOTATION_LABELS[type]}</option>)}
              </select>
            </label>
            <label>รูปแบบพื้นที่
              <select value={draft.shape} onChange={(event) => updateDraft({ shape: event.target.value as "point" | "box" })}>
                <option value="point">จุด Marker</option>
                <option value="box">กล่อง 3 มิติ</option>
              </select>
            </label>
          </div>
          <label>ชื่อที่เข้าใจตรงกัน
            <input autoFocus value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder="เช่น ห้อง 431, บันไดอาคาร 4 ฝั่งตะวันออก" />
          </label>
          <div className="field-grid two-columns">
            <label>รหัสอาคาร
              <input value={draft.buildingId} onChange={(event) => updateDraft({ buildingId: event.target.value })} placeholder="เช่น B04" />
            </label>
            <label>ชั้น
              <input type="number" min="-5" max="100" value={draft.floor ?? ""} onChange={(event) => updateDraft({ floor: event.target.value === "" ? null : Number(event.target.value) })} />
            </label>
            <label>จำนวนคน
              <input type="number" min="0" step="1" value={draft.peopleCount} onChange={(event) => updateDraft({ peopleCount: Number(event.target.value) })} />
            </label>
            <label>Capacity
              <input type="number" min="0" step="0.1" value={draft.capacity} onChange={(event) => updateDraft({ capacity: Number(event.target.value) })} />
            </label>
          </div>
          {draft.shape === "box" && (
            <fieldset>
              <legend>ขนาดกล่อง X / Y / Z</legend>
              <div className="field-grid three-columns">
                {[0, 1, 2].map((index) => (
                  <label key={index}>{"XYZ"[index]}
                    <input type="number" min="0.01" step="0.1" value={draft.size[index]} onChange={(event) => updateDraft({ size: updateVector(draft.size, index, Math.max(0.01, Number(event.target.value))) })} />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label>Tags
            <input value={draft.tagsText} onChange={(event) => updateDraft({ tagsText: event.target.value })} placeholder="เช่น อาคารหลัก, ฝั่งตะวันออก, ตรวจสอบแล้ว" />
          </label>
          <label>หมายเหตุ
            <textarea rows={3} value={draft.notes} onChange={(event) => updateDraft({ notes: event.target.value })} placeholder="รายละเอียดที่ช่วยให้เข้าใจตำแหน่งนี้ตรงกัน" />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={closeDraft}>ยกเลิก</button>
          <button type="button" className="button primary" onClick={saveDraft}>บันทึกตำแหน่ง</button>
        </div>
      </section>
    </div>
  );
}
