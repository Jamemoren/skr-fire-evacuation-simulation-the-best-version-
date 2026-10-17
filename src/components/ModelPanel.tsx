import { useMemo, useRef, useState } from "react";
import { DEFAULT_MODEL_PATH } from "../constants";
import { DIGITAL_MODEL_NAME_TH } from "../projectIdentity";
import { useMapperStore } from "../store";
import type { Vec3 } from "../types";
import { downloadJson } from "../utils/download";
import { formatBytes, formatNumber, formatVec3 } from "../utils/format";
import { sha256File } from "../utils/hash";
import { clearModelFile, saveModelFile } from "../utils/idb";

function updateVector(source: Vec3, index: number, value: number): Vec3 {
  const next: Vec3 = [...source];
  next[index] = value;
  return next;
}

export function ModelPanel() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [objectQuery, setObjectQuery] = useState("");
  const project = useMapperStore((state) => state.project);
  const patchProject = useMapperStore((state) => state.patchProject);
  const modelUrl = useMapperStore((state) => state.modelUrl);
  const modelSource = useMapperStore((state) => state.modelSource);
  const modelReport = useMapperStore((state) => state.modelReport);
  const modelError = useMapperStore((state) => state.modelError);
  const calibration = useMapperStore((state) => state.calibration);
  const modelOpacity = useMapperStore((state) => state.modelOpacity);
  const setModelUrl = useMapperStore((state) => state.setModelUrl);
  const setModelSource = useMapperStore((state) => state.setModelSource);
  const setModelReport = useMapperStore((state) => state.setModelReport);
  const setModelLoading = useMapperStore((state) => state.setModelLoading);
  const setModelError = useMapperStore((state) => state.setModelError);
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

  const replaceUrl = (url: string | null) => {
    const previous = useMapperStore.getState().modelUrl;
    if (previous?.startsWith("blob:")) URL.revokeObjectURL(previous);
    setModelUrl(url);
  };

  const onModelFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".glb")) {
      addToast("error", "กรุณาเลือกไฟล์ .glb");
      return;
    }
    setBusy(true);
    setModelLoading(true);
    setModelError(null);
    try {
      const sha256 = await sha256File(file);
      let persisted = true;
      try {
        await saveModelFile(file, sha256);
      } catch {
        persisted = false;
      }
      replaceUrl(URL.createObjectURL(file));
      setModelSource({ name: file.name, size: file.size, sha256, source: "uploaded" });
      setModelReport(null);
      addToast(
        persisted ? "success" : "warning",
        persisted
          ? "นำเข้า GLB และบันทึกไว้ในเบราว์เซอร์แล้ว"
          : "นำเข้า GLB แล้ว แต่ไฟล์ใหญ่เกินกว่าจะจำไว้หลังปิดหน้าเว็บ",
      );
    } catch (error) {
      setModelLoading(false);
      addToast("error", error instanceof Error ? error.message : "นำเข้า GLB ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const usePublicModel = async () => {
    setBusy(true);
    setModelLoading(true);
    setModelError(null);
    try {
      const response = await fetch(DEFAULT_MODEL_PATH, { method: "HEAD" });
      if (!response.ok) throw new Error("ไม่พบไฟล์ GLB ใน public/models");
      await clearModelFile();
      replaceUrl(DEFAULT_MODEL_PATH);
      setModelSource({
        name: "suankularb_wittayalai_nonthaburi_school.glb",
        size: Number(response.headers.get("content-length") ?? 0),
        sha256: "",
        source: "public",
      });
      setModelReport(null);
    } catch (error) {
      setModelLoading(false);
      addToast("error", error instanceof Error ? error.message : "โหลดโมเดลไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const clearModel = async () => {
    await clearModelFile();
    replaceUrl(null);
    setModelSource({ name: DIGITAL_MODEL_NAME_TH, size: 0, sha256: "generated-from-building1-plans", source: "generated" });
    setModelReport(null);
    setModelError(null);
    setCalibration({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
    addToast("info", "กลับสู่โมเดลตึก 1 ที่สร้างใหม่แล้ว");
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
        <button type="button" className="button ghost" onClick={() => void clearModel()}>ใช้โมเดลตึก 1</button>
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
        <div><span>สถานะ</span><strong>{modelUrl ? "GLB พร้อมใช้งาน" : "Generated"}</strong></div>
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
