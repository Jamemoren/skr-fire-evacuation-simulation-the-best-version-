import { SoundToggle } from "../audio/SoundToggle";
import { useMemo, useRef } from "react";
import { PROJECT_NAME_TH, PROJECT_SHORT_NAME_TH } from "../projectIdentity";
import { DEFAULT_PEOPLE_PER_ROOM, TARGET_POPULATION } from "../constants";
import { useMapperStore } from "../store";
import { currentMap, exportWorkspace, importWorkspaceFile, newWorkspace } from "../utils/projectFiles";
import { downloadBlob, downloadDataUrl, downloadJson, downloadText } from "../utils/download";
import {
  annotationsToCsv,
  buildChatSummary,
  connectionsToCsv,
} from "../utils/semantic";
import { validateSemanticMap } from "../utils/validation";

export function TopBar({ onOpenGuide }: { onOpenGuide: () => void }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const annotations = useMapperStore((state) => state.annotations);
  const connections = useMapperStore((state) => state.connections);
  const past = useMapperStore((state) => state.past);
  const future = useMapperStore((state) => state.future);
  const busy = useMapperStore((state) => state.projectBusy);
  const projectName = useMapperStore((state) => state.project.name);
  const addToast = useMapperStore((state) => state.addToast);
  const distributePopulation = useMapperStore((state) => state.distributePopulation);
  const undo = useMapperStore((state) => state.undo);
  const redo = useMapperStore((state) => state.redo);
  const setShowShortcuts = useMapperStore((state) => state.setShowShortcuts);

  const classrooms = annotations.filter((item) => item.type === "classroom");
  const totalPeople = classrooms.reduce((sum, item) => sum + item.peopleCount, 0);
  const validation = useMemo(() => validateSemanticMap(annotations, connections), [annotations, connections]);

  const exportProject = async () => {
    try {
      downloadBlob("evacuation-project.skrproject", await exportWorkspace());
      addToast("success", "ส่งออกโปรเจกต์พร้อมโมเดล Calibration และ node/edge แล้ว");
    } catch (error) { addToast("error", error instanceof Error ? error.message : "ส่งออกโปรเจกต์ไม่สำเร็จ"); }
  };
  const createProject = async () => {
    if (!window.confirm("เริ่มโปรเจกต์ว่างหรือไม่? กรุณาส่งออกโปรเจกต์ปัจจุบันก่อนเปลี่ยน")) return;
    try { await newWorkspace(); }
    catch (error) { addToast("error", error instanceof Error ? error.message : "สร้างโปรเจกต์ไม่สำเร็จ"); }
  };
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
    try { await importWorkspaceFile(file); }
    catch (error) { addToast("error", error instanceof Error ? error.message : "นำเข้าไฟล์ไม่สำเร็จ"); }
  };

  return (
    <header className="topbar" data-camera-inset="top">
      <div className="brand-block">
        <span className="brand-mark" title="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต">
          <img src="/assets/skr-school-emblem.png" alt="ตราโรงเรียนสวนกุหลาบวิทยาลัย รังสิต" />
        </span>
        <div><span className="editor-brand-eyebrow">พื้นที่แก้ไขโมเดล</span><h1 title={PROJECT_NAME_TH}>{PROJECT_SHORT_NAME_TH}</h1><p title={projectName}>{projectName}</p></div>
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
        <button type="button" className="button secondary" disabled={busy} onClick={() => fileInputRef.current?.click()}>นำเข้าไฟล์</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => void exportProject()}>{busy ? "กำลังจัดการไฟล์…" : "ส่งออกโปรเจกต์"}</button>
        <details className="editor-file-menu" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
        }} onKeyDown={(event) => {
          if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
        }}>
          <summary>เพิ่มเติม <span aria-hidden="true">⌄</span></summary>
          <div className="editor-file-popover" onClick={(event) => {
            if ((event.target as Element).closest("button")) event.currentTarget.closest("details")?.removeAttribute("open");
          }}>
        <span className="editor-menu-caption">โปรเจกต์และข้อมูล</span>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void createProject()}>โปรเจกต์ว่าง</button>
        <button type="button" className="button secondary" onClick={distributePopulation}>จัดสรรประชากร 3,000 คน</button>
        <button type="button" className="button secondary" onClick={exportCsv}>CSV</button>
        <button type="button" className="button secondary" onClick={captureScreenshot}>ภาพ</button>
        <button type="button" className="button secondary" disabled={busy} onClick={exportJson}>แผนที่ JSON</button>
        <button type="button" className="button accent" onClick={copySummary}>คัดลอกสรุปโครงการ</button>
          </div>
        </details>
        <button type="button" className="button secondary" onClick={onOpenGuide} aria-haspopup="dialog">คู่มือการใช้เว็บ</button>
        <SoundToggle className="button secondary" compact />
        <button type="button" className="icon-action" onClick={() => setShowShortcuts(true)} title="คีย์ลัด" aria-label="แสดงคีย์ลัด">⌨</button>
        <input ref={fileInputRef} hidden type="file" aria-label="นำเข้าไฟล์โปรเจกต์หรือโมเดล" accept=".skrproject,.glb,.json,application/json,model/gltf-binary" onChange={(event) => {
          void onImport(event.target.files?.[0]);
          event.currentTarget.value = "";
        }} />
      </div>
    </header>
  );
}
