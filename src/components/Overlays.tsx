import { useProgress } from "@react-three/drei";
import { ANNOTATION_LABELS } from "../constants";
import { useMapperStore } from "../store";
import { distanceBetween } from "../utils/coordinates";
import { formatVec3 } from "../utils/format";
import { useEvacuationStore } from "../simulation/simulationStore";

export function SceneOverlays() {
  const { progress, active } = useProgress();
  const cameraMode = useMapperStore((state) => state.cameraMode);
  const targetHit = useMapperStore((state) => state.targetHit);
  const inspectedHit = useMapperStore((state) => state.inspectedHit);
  const modelLoading = useMapperStore((state) => state.modelLoading);
  const toolMode = useMapperStore((state) => state.toolMode);
  const placementType = useMapperStore((state) => state.placementType);
  const connectFromId = useMapperStore((state) => state.connectFromId);
  const annotations = useMapperStore((state) => state.annotations);
  const modelSource = useMapperStore((state) => state.modelSource);
  const measurement = useMapperStore((state) => state.measurement);
  const snapEnabled = useMapperStore((state) => state.snapEnabled);
  const snapSize = useMapperStore((state) => state.snapSize);
  const workMode = useEvacuationStore((state) => state.workMode);
  const connectFrom = annotations.find((item) => item.id === connectFromId);
  const hit = cameraMode === "god" ? targetHit : inspectedHit;
  const measured = measurement.start && measurement.end
    ? distanceBetween(measurement.start, measurement.end)
    : null;

  return (
    <>
      {(modelLoading || active) && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="spinner" />
            <strong>กำลังโหลดและวิเคราะห์โมเดล…</strong>
            <div className="progress-track"><span style={{ width: `${Math.max(4, progress)}%` }} /></div>
            <small>{Math.round(progress)}%</small>
          </div>
        </div>
      )}
      {workMode === "editor" && cameraMode === "god" && (
        <>
          <div className="crosshair" aria-hidden="true"><span /><span /></div>
          <div className="god-hud">
            <strong>โหมดสำรวจ · {ANNOTATION_LABELS[placementType]}</strong>
            <span>{targetHit ? `LOCAL ${formatVec3(targetHit.position, 3)}` : "ไม่มีพื้นผิวตรงเป้า"}</span>
            <small>F ปัก/วัด · Esc ปลดเมาส์ · Ctrl เคลื่อนที่ละเอียด</small>
          </div>
        </>
      )}
      {workMode === "editor" && (
        <>
          <div className="coordinate-hud">
            <div><span>ระบบพิกัด</span><strong>MODEL-LOCAL</strong></div>
            <div><span>Local XYZ</span><strong>{hit ? formatVec3(hit.position, 3) : "–"}</strong></div>
            <div><span>World XYZ</span><strong>{hit ? formatVec3(hit.worldPosition, 3) : "–"}</strong></div>
            <div><span>Object</span><strong>{hit?.objectName ?? "–"}</strong></div>
          </div>
          <div className="scene-status">
            <span className={`mode-chip mode-${toolMode}`}>{toolMode}</span>
            <span>{toolMode === "annotate" ? `กำลังปัก: ${ANNOTATION_LABELS[placementType]}` : `Model: ${modelSource.name}`}</span>
            {connectFrom && <strong>กำลังเชื่อมจาก: {connectFrom.name}</strong>}
            {toolMode === "measure" && <strong>{measured === null ? "เลือกจุดแรก/จุดที่สอง" : `ระยะ ${measured.toFixed(3)} หน่วยโมเดล`}</strong>}
            {snapEnabled && <em>Snap {snapSize}</em>}
          </div>
        </>
      )}
    </>
  );
}

export function Toasts() {
  const toasts = useMapperStore((state) => state.toasts);
  const removeToast = useMapperStore((state) => state.removeToast);
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} type="button" className={`toast ${toast.kind}`} onClick={() => removeToast(toast.id)}>
          {toast.text}
        </button>
      ))}
    </div>
  );
}
