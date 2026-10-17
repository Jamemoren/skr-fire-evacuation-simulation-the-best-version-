import { useMemo, useRef } from "react";
import { PROJECT_CONTEXT_TH, PROJECT_NAME_TH } from "../projectIdentity";
import { DEFAULT_PEOPLE_PER_ROOM, TARGET_POPULATION } from "../constants";
import { useMapperStore } from "../store";
import type { SemanticMapFile } from "../types";
import { downloadDataUrl, downloadJson, downloadText } from "../utils/download";
import {
  annotationsToCsv,
  buildChatSummary,
  buildSemanticMap,
  connectionsToCsv,
  isImportableSemanticMap,
  normalizeImportedMap,
} from "../utils/semantic";
import { validateSemanticMap } from "../utils/validation";

export function TopBar() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const project = useMapperStore((state) => state.project);
  const annotations = useMapperStore((state) => state.annotations);
  const connections = useMapperStore((state) => state.connections);
  const modelSource = useMapperStore((state) => state.modelSource);
  const calibration = useMapperStore((state) => state.calibration);
  const modelReport = useMapperStore((state) => state.modelReport);
  const past = useMapperStore((state) => state.past);
  const future = useMapperStore((state) => state.future);
  const importMap = useMapperStore((state) => state.importMap);
  const addToast = useMapperStore((state) => state.addToast);
  const distributePopulation = useMapperStore((state) => state.distributePopulation);
  const undo = useMapperStore((state) => state.undo);
  const redo = useMapperStore((state) => state.redo);
  const setShowOnboarding = useMapperStore((state) => state.setShowOnboarding);
  const setShowShortcuts = useMapperStore((state) => state.setShowShortcuts);

  const classrooms = annotations.filter((item) => item.type === "classroom");
  const totalPeople = classrooms.reduce((sum, item) => sum + item.peopleCount, 0);
  const validation = useMemo(() => validateSemanticMap(annotations, connections), [annotations, connections]);

  const currentMap = (): SemanticMapFile => buildSemanticMap({
    project,
    model: modelSource,
    calibration,
    modelReport,
    annotations,
    connections,
  });

  const exportJson = () => {
    downloadJson("school-semantic-map.json", currentMap());
    addToast("success", "ส่งออก school-semantic-map.json แล้ว");
  };

  const exportCsv = () => {
    downloadText("school-annotations.csv", `\uFEFF${annotationsToCsv(annotations)}`, "text/csv;charset=utf-8");
    window.setTimeout(() => {
      downloadText("school-connections.csv", `\uFEFF${connectionsToCsv(connections, annotations)}`, "text/csv;charset=utf-8");
    }, 250);
    addToast("success", "Export CSV ตำแหน่งและเส้นเชื่อมแล้ว");
  };

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(buildChatSummary(currentMap()));
      addToast("success", "คัดลอกสรุปโครงการแล้ว");
    } catch {
      downloadText("semantic-map-summary.md", buildChatSummary(currentMap()));
      addToast("warning", "Clipboard ใช้ไม่ได้ จึงดาวน์โหลดไฟล์สรุปแทน");
    }
  };

  const captureScreenshot = () => {
    const canvas = document.querySelector<HTMLCanvasElement>(".viewport-shell canvas");
    if (!canvas) {
      addToast("error", "ไม่พบ Canvas สำหรับจับภาพ");
      return;
    }
    try {
      downloadDataUrl(`skr-semantic-map-${Date.now()}.png`, canvas.toDataURL("image/png"));
      addToast("success", "บันทึกภาพหน้าจอ 3D แล้ว");
    } catch {
      addToast("error", "จับภาพไม่สำเร็จ กรุณาลองใหม่หลังโมเดลโหลดเสร็จ");
    }
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const value: unknown = JSON.parse(await file.text());
      if (!isImportableSemanticMap(value)) throw new Error("ไฟล์ต้องเป็น skr-semantic-map schema version 1 หรือ 2");
      const normalized = normalizeImportedMap(value);
      const hashMismatch = Boolean(normalized.model.sha256 && modelSource.sha256 && normalized.model.sha256 !== modelSource.sha256);
      const nameMismatch = normalized.model.name !== modelSource.name;
      if ((hashMismatch || nameMismatch) && !window.confirm(
        `ข้อมูลนี้สร้างจากโมเดล “${normalized.model.name}” แต่ขณะนี้เปิด “${modelSource.name}”\nต้องการนำเข้าต่อหรือไม่?`,
      )) return;
      importMap(normalized);
      addToast(
        value.version === 1 ? "warning" : "success",
        value.version === 1
          ? `นำเข้า ${normalized.annotations.length} ตำแหน่งและแปลงเป็นพิกัด Model-local แล้ว`
          : `นำเข้า ${normalized.annotations.length} ตำแหน่งแล้ว`,
      );
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "นำเข้าไฟล์ไม่สำเร็จ");
    }
  };

  return (
    <header className="topbar">
      <div className="brand-block">
        <span className="brand-mark" title="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต">
          <img src="/assets/skr-school-emblem.png" alt="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต" />
        </span>
        <div><h1>{PROJECT_NAME_TH}</h1><p>{PROJECT_CONTEXT_TH}</p></div>
      </div>
      <div className="top-stats">
        <div><span>ตำแหน่ง</span><strong>{annotations.length}</strong></div>
        <div><span>ห้องเรียน</span><strong>{classrooms.length}</strong></div>
        <div className={totalPeople === TARGET_POPULATION ? "is-good" : ""}><span>ประชากร</span><strong>{totalPeople.toLocaleString("th-TH")}/{TARGET_POPULATION.toLocaleString("th-TH")}</strong></div>
        <div><span>คุณภาพข้อมูล</span><strong>{validation.score}/100</strong></div>
        <div><span>ค่าเริ่มต้น/ห้อง</span><strong>{DEFAULT_PEOPLE_PER_ROOM}</strong></div>
      </div>
      <div className="top-actions">
        <button type="button" className="icon-action" disabled={past.length === 0} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
        <button type="button" className="icon-action" disabled={future.length === 0} onClick={redo} title="Redo (Ctrl+Y)">↷</button>
        <button type="button" className="button secondary" onClick={distributePopulation}>จัดสรรประชากร 3,000 คน</button>
        <button type="button" className="button secondary" onClick={() => fileInputRef.current?.click()}>นำเข้า</button>
        <button type="button" className="button secondary" onClick={exportCsv}>CSV</button>
        <button type="button" className="button secondary" onClick={captureScreenshot}>ภาพ</button>
        <button type="button" className="button primary" onClick={exportJson}>ส่งออก JSON</button>
        <button type="button" className="button accent" onClick={copySummary}>คัดลอกสรุปโครงการ</button>
        <button type="button" className="icon-action" onClick={() => setShowOnboarding(true)} title="คู่มือเริ่มต้น">?</button>
        <button type="button" className="icon-action" onClick={() => setShowShortcuts(true)} title="คีย์ลัด">⌨</button>
        <input ref={fileInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => {
          void onImport(event.target.files?.[0]);
          event.currentTarget.value = "";
        }} />
      </div>
    </header>
  );
}
