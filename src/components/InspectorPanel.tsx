import { useMemo, useState } from "react";
import {
  ANNOTATION_ICONS,
  ANNOTATION_LABELS,
  CONNECTION_LABELS,
  TARGET_POPULATION,
} from "../constants";
import { useMapperStore } from "../store";
import type {
  AnnotationType,
  ConnectionType,
  SemanticAnnotation,
  SemanticConnection,
  Vec3,
} from "../types";
import { modelLocalToWorld } from "../utils/coordinates";
import { formatNumber, formatVec3 } from "../utils/format";
import { ModelPanel } from "./ModelPanel";
import { ValidationPanel } from "./ValidationPanel";

type PanelTab = "selected" | "list" | "validation" | "model";

function updateVector(source: Vec3, index: number, value: number): Vec3 {
  const next: Vec3 = [...source];
  next[index] = value;
  return next;
}

interface AnnotationEditorProps {
  annotation: SemanticAnnotation;
}

function AnnotationEditor({ annotation }: AnnotationEditorProps) {
  const calibration = useMapperStore((state) => state.calibration);
  const snapSize = useMapperStore((state) => state.snapSize);
  const updateAnnotation = useMapperStore((state) => state.updateAnnotation);
  const duplicateAnnotation = useMapperStore((state) => state.duplicateAnnotation);
  const deleteAnnotation = useMapperStore((state) => state.deleteAnnotation);
  const requestCameraFocus = useMapperStore((state) => state.requestCameraFocus);
  const addToast = useMapperStore((state) => state.addToast);
  const patch = (value: Partial<SemanticAnnotation>) => updateAnnotation(annotation.id, value);
  const worldPosition = modelLocalToWorld(annotation.position, calibration);

  const nudge = (axis: number, direction: number) => {
    patch({ position: updateVector(annotation.position, axis, annotation.position[axis] + snapSize * direction) });
  };

  return (
    <div className="form-stack compact-form">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">{ANNOTATION_ICONS[annotation.type]} {ANNOTATION_LABELS[annotation.type]}</span>
          <h3>{annotation.name}</h3>
        </div>
        <button type="button" className="button secondary small" onClick={() => requestCameraFocus(annotation.position)}>Focus</button>
      </div>
      <label>ชื่อ<input value={annotation.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      <div className="field-grid two-columns">
        <label>ประเภท
          <select value={annotation.type} onChange={(event) => patch({ type: event.target.value as AnnotationType })}>
            {(Object.keys(ANNOTATION_LABELS) as AnnotationType[]).map((type) => <option key={type} value={type}>{ANNOTATION_LABELS[type]}</option>)}
          </select>
        </label>
        <label>รูปแบบ
          <select value={annotation.shape} onChange={(event) => patch({ shape: event.target.value as "point" | "box" })}>
            <option value="point">จุด</option>
            <option value="box">กล่อง 3 มิติ</option>
          </select>
        </label>
        <label>อาคาร<input value={annotation.buildingId} onChange={(event) => patch({ buildingId: event.target.value })} /></label>
        <label>ชั้น<input type="number" value={annotation.floor ?? ""} onChange={(event) => patch({ floor: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        <label>จำนวนคน<input type="number" min="0" step="1" value={annotation.peopleCount} onChange={(event) => patch({ peopleCount: Math.max(0, Number(event.target.value)) })} /></label>
        <label>Capacity<input type="number" min="0" value={annotation.capacity} onChange={(event) => patch({ capacity: Math.max(0, Number(event.target.value)) })} /></label>
      </div>
      <div className="switch-grid">
        <label className="switch-row"><input type="checkbox" checked={annotation.visible} onChange={(event) => patch({ visible: event.target.checked })} />แสดงผล</label>
        <label className="switch-row"><input type="checkbox" checked={annotation.locked} onChange={(event) => patch({ locked: event.target.checked })} />ล็อกข้อมูล</label>
      </div>
      <fieldset>
        <legend>ตำแหน่ง Model-local X / Y / Z</legend>
        <div className="field-grid three-columns">
          {[0, 1, 2].map((index) => (
            <label key={index}>{"XYZ"[index]}
              <input type="number" step="0.1" disabled={annotation.locked} value={formatNumber(annotation.position[index], 4)} onChange={(event) => patch({ position: updateVector(annotation.position, index, Number(event.target.value)) })} />
            </label>
          ))}
        </div>
        {!annotation.locked && (
          <div className="nudge-grid">
            {[0, 1, 2].map((axis) => (
              <div key={axis}><span>{"XYZ"[axis]}</span><button type="button" onClick={() => nudge(axis, -1)}>−</button><button type="button" onClick={() => nudge(axis, 1)}>+</button></div>
            ))}
          </div>
        )}
      </fieldset>
      <div className="coordinate-preview compact">
        <div><span>Local</span><strong>{formatVec3(annotation.position, 5)}</strong></div>
        <div><span>World</span><strong>{formatVec3(worldPosition, 5)}</strong></div>
      </div>
      {annotation.shape === "box" && (
        <fieldset>
          <legend>ขนาด X / Y / Z</legend>
          <div className="field-grid three-columns">
            {[0, 1, 2].map((index) => (
              <label key={index}>{"XYZ"[index]}
                <input type="number" min="0.01" step="0.1" disabled={annotation.locked} value={annotation.size[index]} onChange={(event) => patch({ size: updateVector(annotation.size, index, Math.max(0.01, Number(event.target.value))) })} />
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend>Rotation X / Y / Z (องศา)</legend>
        <div className="field-grid three-columns">
          {[0, 1, 2].map((index) => (
            <label key={index}>{"XYZ"[index]}
              <input type="number" step="1" disabled={annotation.locked} value={formatNumber(annotation.rotation[index] * 180 / Math.PI, 1)} onChange={(event) => patch({ rotation: updateVector(annotation.rotation, index, Number(event.target.value) * Math.PI / 180) })} />
            </label>
          ))}
        </div>
      </fieldset>
      <label>Tags<input value={annotation.tags.join(", ")} onChange={(event) => patch({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label>
      <label>หมายเหตุ<textarea rows={3} value={annotation.notes} onChange={(event) => patch({ notes: event.target.value })} /></label>
      <div className="object-source"><span>Object ต้นทาง</span><strong>{annotation.sourceObjectName || "–"}</strong><small>{annotation.sourceObjectPath || "–"}</small></div>
      <div className="button-grid two">
        <button type="button" className="button secondary" onClick={() => duplicateAnnotation(annotation.id)}>ทำสำเนา</button>
        <button type="button" className="button secondary" onClick={() => {
          void navigator.clipboard.writeText(JSON.stringify(annotation, null, 2));
          addToast("success", "คัดลอกข้อมูลตำแหน่งแล้ว");
        }}>คัดลอก JSON</button>
        <button type="button" className="button danger full-span" onClick={() => {
          if (window.confirm(`ลบ “${annotation.name}” และเส้นเชื่อมที่เกี่ยวข้องหรือไม่?`)) deleteAnnotation(annotation.id);
        }}>ลบตำแหน่ง</button>
      </div>
    </div>
  );
}

function ConnectionEditor({ connection }: { connection: SemanticConnection }) {
  const annotations = useMapperStore((state) => state.annotations);
  const updateConnection = useMapperStore((state) => state.updateConnection);
  const deleteConnection = useMapperStore((state) => state.deleteConnection);
  const from = annotations.find((item) => item.id === connection.fromId);
  const to = annotations.find((item) => item.id === connection.toId);
  const patch = (value: Partial<SemanticConnection>) => updateConnection(connection.id, value);
  return (
    <div className="form-stack compact-form">
      <div className="panel-heading-row"><div><span className="eyebrow">เส้นเชื่อม</span><h3>{from?.name ?? "?"} → {to?.name ?? "?"}</h3></div></div>
      <label>ประเภท<select value={connection.type} onChange={(event) => patch({ type: event.target.value as ConnectionType })}>
        {(Object.keys(CONNECTION_LABELS) as ConnectionType[]).map((type) => <option key={type} value={type}>{CONNECTION_LABELS[type]}</option>)}
      </select></label>
      <div className="field-grid two-columns">
        <label>ความกว้าง<input type="number" min="0.01" step="0.1" value={connection.width} onChange={(event) => patch({ width: Math.max(0.01, Number(event.target.value)) })} /></label>
        <label>Capacity/วินาที<input type="number" min="0.01" step="0.1" value={connection.capacityPerSecond} onChange={(event) => patch({ capacityPerSecond: Math.max(0.01, Number(event.target.value)) })} /></label>
      </div>
      <div className="switch-grid">
        <label className="switch-row"><input type="checkbox" checked={connection.bidirectional} onChange={(event) => patch({ bidirectional: event.target.checked })} />เดินได้สองทาง</label>
        <label className="switch-row"><input type="checkbox" checked={connection.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />เปิดใช้งาน</label>
      </div>
      <label>หมายเหตุ<textarea rows={3} value={connection.notes} onChange={(event) => patch({ notes: event.target.value })} /></label>
      <button type="button" className="button danger full" onClick={() => deleteConnection(connection.id)}>ลบเส้นเชื่อม</button>
    </div>
  );
}

function AnnotationList() {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | AnnotationType>("all");
  const annotations = useMapperStore((state) => state.annotations);
  const connections = useMapperStore((state) => state.connections);
  const hiddenTypes = useMapperStore((state) => state.hiddenTypes);
  const selectedAnnotationId = useMapperStore((state) => state.selectedAnnotationId);
  const selectAnnotation = useMapperStore((state) => state.selectAnnotation);
  const selectConnection = useMapperStore((state) => state.selectConnection);
  const requestCameraFocus = useMapperStore((state) => state.requestCameraFocus);
  const toggleTypeVisibility = useMapperStore((state) => state.toggleTypeVisibility);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return annotations.filter((annotation) => {
      const matchesType = typeFilter === "all" || annotation.type === typeFilter;
      const matchesText = !normalized || [annotation.name, annotation.id, annotation.buildingId, annotation.sourceObjectName, annotation.tags.join(" ")].join(" ").toLowerCase().includes(normalized);
      return matchesType && matchesText;
    });
  }, [annotations, query, typeFilter]);

  return (
    <div className="list-tab">
      <div className="filter-row">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อ ห้อง อาคาร Tags…" />
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "all" | AnnotationType)}>
          <option value="all">ทุกประเภท</option>
          {(Object.keys(ANNOTATION_LABELS) as AnnotationType[]).map((type) => <option key={type} value={type}>{ANNOTATION_LABELS[type]}</option>)}
        </select>
      </div>
      <div className="layer-visibility">
        {(Object.keys(ANNOTATION_LABELS) as AnnotationType[]).map((type) => (
          <button key={type} type="button" className={hiddenTypes.includes(type) ? "is-hidden" : ""} onClick={() => toggleTypeVisibility(type)} title={`แสดง/ซ่อน ${ANNOTATION_LABELS[type]}`}>
            {ANNOTATION_ICONS[type]}
          </button>
        ))}
      </div>
      <div className="annotation-list">
        {filtered.length === 0 && <div className="empty-state">ยังไม่พบตำแหน่งตามตัวกรอง</div>}
        {filtered.map((annotation) => (
          <button key={annotation.id} type="button" className={`annotation-row${selectedAnnotationId === annotation.id ? " is-selected" : ""}`} onClick={() => {
            selectAnnotation(annotation.id);
            requestCameraFocus(annotation.position);
          }}>
            <span className={`type-dot type-${annotation.type}`} />
            <div><strong>{annotation.locked ? "🔒 " : ""}{annotation.name}</strong><small>{ANNOTATION_LABELS[annotation.type]} · {annotation.buildingId || "ไม่ระบุอาคาร"} · {formatVec3(annotation.position)}</small></div>
            {annotation.peopleCount > 0 && <em>{annotation.peopleCount}</em>}
          </button>
        ))}
      </div>
      <h3 className="subheading">เส้นเชื่อม {connections.length}</h3>
      <div className="connection-list">
        {connections.length === 0 && <div className="empty-state small">ยังไม่มีเส้นเชื่อม</div>}
        {connections.map((connection) => {
          const from = annotations.find((item) => item.id === connection.fromId);
          const to = annotations.find((item) => item.id === connection.toId);
          return (
            <button key={connection.id} type="button" className="connection-row" onClick={() => selectConnection(connection.id)}>
              <span>{connection.enabled ? "" : "⛔ "}{from?.name ?? "?"} → {to?.name ?? "?"}</span><em>{CONNECTION_LABELS[connection.type]}</em>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function InspectorPanel() {
  const [tab, setTab] = useState<PanelTab>("selected");
  const annotations = useMapperStore((state) => state.annotations);
  const connections = useMapperStore((state) => state.connections);
  const selectedAnnotationId = useMapperStore((state) => state.selectedAnnotationId);
  const selectedConnectionId = useMapperStore((state) => state.selectedConnectionId);
  const inspectedHit = useMapperStore((state) => state.inspectedHit);
  const targetHit = useMapperStore((state) => state.targetHit);
  const placementType = useMapperStore((state) => state.placementType);
  const openDraftFromHit = useMapperStore((state) => state.openDraftFromHit);
  const addToast = useMapperStore((state) => state.addToast);
  const selected = annotations.find((item) => item.id === selectedAnnotationId) ?? null;
  const selectedConnection = connections.find((item) => item.id === selectedConnectionId) ?? null;
  const classrooms = annotations.filter((item) => item.type === "classroom");
  const totalPeople = classrooms.reduce((sum, item) => sum + item.peopleCount, 0);
  const currentHit = inspectedHit ?? targetHit;

  return (
    <aside className="right-panel panel">
      <div className="panel-tabs four-tabs">
        <button type="button" className={tab === "selected" ? "is-active" : ""} onClick={() => setTab("selected")}>ข้อมูล</button>
        <button type="button" className={tab === "list" ? "is-active" : ""} onClick={() => setTab("list")}>รายการ</button>
        <button type="button" className={tab === "validation" ? "is-active" : ""} onClick={() => setTab("validation")}>ตรวจสอบ</button>
        <button type="button" className={tab === "model" ? "is-active" : ""} onClick={() => setTab("model")}>โมเดล</button>
      </div>
      <div className="right-panel-content">
        {tab === "model" && <ModelPanel />}
        {tab === "validation" && <ValidationPanel />}
        {tab === "list" && <AnnotationList />}
        {tab === "selected" && (
          <>
            <div className="population-card">
              <div><span>ห้องเรียน</span><strong>{classrooms.length}</strong></div>
              <div><span>คนที่กำหนด</span><strong>{totalPeople.toLocaleString("th-TH")}</strong></div>
              <div className={totalPeople === TARGET_POPULATION ? "is-good" : "is-warning"}><span>ต่างจากเป้าหมาย</span><strong>{Math.abs(TARGET_POPULATION - totalPeople).toLocaleString("th-TH")}</strong></div>
            </div>
            {selected ? <AnnotationEditor annotation={selected} /> : selectedConnection ? <ConnectionEditor connection={selectedConnection} /> : (
              <div className="inspection-block">
                <h3>ตำแหน่งที่ตรวจพบ</h3>
                {currentHit ? (
                  <>
                    <dl className="inspection-data">
                      <div><dt>Object</dt><dd>{currentHit.objectName}</dd></div>
                      <div><dt>Local</dt><dd>{formatVec3(currentHit.position, 4)}</dd></div>
                      <div><dt>World</dt><dd>{formatVec3(currentHit.worldPosition, 4)}</dd></div>
                      <div><dt>Normal</dt><dd>{formatVec3(currentHit.normal, 3)}</dd></div>
                      <div><dt>Material</dt><dd>{currentHit.materialName || "–"}</dd></div>
                      <div><dt>Triangles</dt><dd>{currentHit.triangleCount.toLocaleString("th-TH")}</dd></div>
                    </dl>
                    <div className="object-path">{currentHit.objectPath}</div>
                    <div className="button-grid two">
                      <button type="button" className="button primary" onClick={() => openDraftFromHit(currentHit, placementType)}>สร้าง {ANNOTATION_LABELS[placementType]}</button>
                      <button type="button" className="button secondary" onClick={() => {
                        void navigator.clipboard.writeText(formatVec3(currentHit.position, 6));
                        addToast("success", "คัดลอกพิกัด Model-local แล้ว");
                      }}>คัดลอก Local XYZ</button>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">เลือก “ตรวจวัตถุ” แล้วคลิกโมเดล หรือเข้า โหมดสำรวจ เพื่อเล็งตำแหน่ง</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
