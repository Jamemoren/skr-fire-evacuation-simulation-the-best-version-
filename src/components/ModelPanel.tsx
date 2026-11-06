import { useMemo, useRef, useState } from "react";
import { importWorkspaceFile, openSampleWorkspace } from "../utils/projectFiles";
import { DEFAULT_MODEL_PATH } from "../constants";
import { useMapperStore } from "../store";
import type { Vec3 } from "../types";
import { downloadJson } from "../utils/download";
import { formatBytes, formatNumber, formatVec3 } from "../utils/format";

function updateVector(source: Vec3, index: number, value: number): Vec3 {
  const next: Vec3 = [...source];
  next[index] = value;
  return next;
}

export function ModelPanel() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const busy = useMapperStore((state) => state.projectBusy);
  const [objectQuery, setObjectQuery] = useState("");
  const project = useMapperStore((state) => state.project);
  const patchProject = useMapperStore((state) => state.patchProject);
  const modelUrl = useMapperStore((state) => state.modelUrl);
  const modelSource = useMapperStore((state) => state.modelSource);
  const modelReport = useMapperStore((state) => state.modelReport);
  const modelError = useMapperStore((state) => state.modelError);
  const calibration = useMapperStore((state) => state.calibration);
  const modelOpacity = useMapperStore((state) => state.modelOpacity);
  const setCalibration = useMapperStore((state) => state.setCalibration);
  const setModelOpacity = useMapperStore((state) => state.setModelOpacity);
  const requestCameraFocus = useMapperStore((state) => state.requestCameraFocus);
  const addToast = useMapperStore((state) => state.addToast);

  const filteredObjects = useMemo(() => {
    if (!modelReport) return [];
    const query = objectQuery.trim().toLowerCase();
    return modelReport.items
      .filter((item) => !query || `${item.name} ${item.path} ${item.materialNames.join(" ")}`.toLowerCase().includes(query))
      .sort((a, b) => b.triangleCount - a.triangleCount)
      .slice(0, 120);
  }, [modelReport, objectQuery]);

  const onModelFile = async (file: File | undefined) => {
    if (!file) return;
    try { await importWorkspaceFile(file); }
    catch (error) { addToast("error", error instanceof Error ? error.message : "นำเข้าโมเดลไม่สำเร็จ"); }
  };
  const usePublicModel = async () => {
    try {
      const response = await fetch(DEFAULT_MODEL_PATH);
      if (!response.ok) throw new Error("ไม่พบไฟล์ใน public/models");
      await onModelFile(new File([await response.blob()], "school.glb", { type: "model/gltf-binary" }));
    } catch (error) { addToast("error", error instanceof Error ? error.message : "โหลดโมเดลไม่สำเร็จ"); }
  };
  const clearModel = async () => {
    if (!window.confirm("เปิดผังมาตรฐานอาคาร 1, 3, 4 พร้อม node/edgeหรือไม่? ควรส่งออกโครงการปัจจุบันเก็บก่อน")) return;
    try { await openSampleWorkspace(); }
    catch (error) { addToast("error", error instanceof Error ? error.message : "เปิดตัวอย่างไม่สำเร็จ"); }
  };

  const autoFit = () => {
    if (!modelReport) {
      addToast("warning", "ต้องโหลดและวิเคราะห์โมเดลก่อน");
      return;
    }
    const [sizeX, sizeY, sizeZ] = modelReport.boundsSize;
    const maximum = Math.max(sizeX, sizeY, sizeZ, 0.0001);
    const scale = 150 / maximum;
    const [centerX, , centerZ] = modelReport.boundsCenter;
    const minY = modelReport.boundsMin[1];
    setCalibration({
      position: [-centerX * scale, -minY * scale, -centerZ * scale],
      rotation: [0, 0, 0],
      scale,
    });
    requestCameraFocus(modelReport.boundsCenter);
    addToast("success", "จัดโมเดลให้อยู่กึ่งกลางและแตะพื้นแล้ว");
  };

  return (
    <div className="model-panel">
      <div className="panel-heading-row">
        <div><h3>ข้อมูลโครงการ</h3><p>ใช้ชื่อเดียวกันทุกครั้งที่ Export</p></div>
      </div>
      <div className="form-stack compact-form">
        <label>ชื่อโครงการ<input value={project.name} onChange={(event) => patchProject({ name: event.target.value })} /></label>
        <label>โรงเรียน<input value={project.schoolName} onChange={(event) => patchProject({ schoolName: event.target.value })} /></label>
        <label>คำอธิบาย<textarea rows={2} value={project.description} onChange={(event) => patchProject({ description: event.target.value })} /></label>
      </div>

      <hr />
      <div className="panel-heading-row">
        <div><h3>โมเดลโรงเรียน</h3><p>{modelSource.name}</p></div>
        <span className={`source-badge source-${modelSource.source}`}>{modelSource.source}</span>
      </div>
      <div className="button-grid two">
        <button type="button" className="button primary" disabled={busy} onClick={() => fileInputRef.current?.click()}>{busy ? "กำลังประมวลผล…" : "นำเข้า GLB"}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void usePublicModel()}>โหลดจาก public/models</button>
        <button type="button" className="button secondary" onClick={autoFit}>Auto Fit / Ground</button>
        <button type="button" className="button ghost" onClick={() => void clearModel()}>ใช้ผังมาตรฐานอาคาร 1, 3, 4</button>
      </div>
      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept=".glb,model/gltf-binary"
        onChange={(event) => {
          void onModelFile(event.target.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {modelError && <div className="notice error">{modelError}</div>}
      <div className="model-summary">
        <div><span>สถานะ</span><strong>{modelSource.source === "empty" ? "พื้นที่ว่าง" : modelUrl ? "GLB พร้อมใช้งาน" : modelError ? "รอไฟล์ GLB" : "Generated"}</strong></div>
        <div><span>ขนาดไฟล์</span><strong>{formatBytes(modelSource.size)}</strong></div>
        <div><span>Mesh</span><strong>{modelReport?.meshCount.toLocaleString("th-TH") ?? "–"}</strong></div>
        <div><span>Triangles</span><strong>{modelReport?.triangleCount.toLocaleString("th-TH") ?? "–"}</strong></div>
        <div><span>Objects</span><strong>{modelReport?.objectCount.toLocaleString("th-TH") ?? "–"}</strong></div>
        <div><span>Materials</span><strong>{modelReport?.materialCount.toLocaleString("th-TH") ?? "–"}</strong></div>
      </div>
      {modelReport && (
        <button type="button" className="button secondary full" onClick={() => downloadJson("school-model-report.json", modelReport)}>Export รายงานโครงสร้างโมเดล</button>
      )}

      <hr />
      <h3>Calibration</h3>
      <div className="field-grid">
        {[0, 1, 2].map((index) => (
          <label key={`p-${index}`}>Position {"XYZ"[index]}
            <input type="number" step="0.1" value={calibration.position[index]} onChange={(event) => setCalibration({ ...calibration, position: updateVector(calibration.position, index, Number(event.target.value)) })} />
          </label>
        ))}
        {[0, 1, 2].map((index) => (
          <label key={`r-${index}`}>Rotation {"XYZ"[index]}°
            <input type="number" step="1" value={formatNumber(calibration.rotation[index] * 180 / Math.PI, 1)} onChange={(event) => setCalibration({ ...calibration, rotation: updateVector(calibration.rotation, index, Number(event.target.value) * Math.PI / 180) })} />
          </label>
        ))}
        <label>Scale<input type="number" min="0.00001" step="0.01" value={calibration.scale} onChange={(event) => setCalibration({ ...calibration, scale: Math.max(0.00001, Number(event.target.value)) })} /></label>
        <label>Opacity<input type="range" min="0.08" max="1" step="0.04" value={modelOpacity} onChange={(event) => setModelOpacity(Number(event.target.value))} /></label>
      </div>
      <p className="help-text success-text">ข้อมูลตำแหน่งเก็บเป็นพิกัด Model-local ดังนั้นเปลี่ยน Calibration ภายหลังได้โดยตำแหน่งยังติดกับโมเดลเดิม</p>

      {modelReport && (
        <>
          <hr />
          <h3>Object Explorer</h3>
          <input value={objectQuery} onChange={(event) => setObjectQuery(event.target.value)} placeholder="ค้นหา Mesh, Object, Material…" />
          <div className="model-object-list">
            {filteredObjects.map((item) => (
              <button key={item.path} type="button" onClick={() => requestCameraFocus(item.position)}>
                <div><strong>{item.name}</strong><small>{item.kind} · {formatVec3(item.position, 2)}</small></div>
                <em>{item.triangleCount.toLocaleString("th-TH")} △</em>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
