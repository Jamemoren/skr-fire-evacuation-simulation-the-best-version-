import { useState } from "react";
import { alignEditorMapToModel, useEditorAnalysis } from "../simulation/dashboard/dashboardModel";

/**
 * Tells the editor user, while editing, whether the simulation can use the current map — and if
 * not, exactly which edit stops it (moved structure, path through a wall, no floor, …).
 */
export function EditorSimStatus() {
  const analysis = useEditorAnalysis();
  const [open, setOpen] = useState(false);
  const bad = analysis.blockers.length;
  const label = bad ? `จำลองยังไม่ได้ · ${bad} ข้อ` : analysis.standard ? "ผังมาตรฐาน · จำลองได้" : `จำลองได้ · ใช้การแก้ไข ${analysis.applied.length} รายการ`;
  return <div className="editor-sim-status">
    <button type="button" className={bad ? "is-bad" : "is-ok"} aria-expanded={open} onClick={() => setOpen((value) => !value)}
      title="การแก้ไขในหน้านี้ใช้กับการจำลองได้หรือไม่ (ตรวจพื้นและผนังจากโมเดล 3 มิติ)">{bad ? "⚠" : "✓"} {label}</button>
    {open && <div className="editor-sim-status-panel" role="status">
      {bad > 0 && <><strong>ต้องแก้ก่อนจำลอง</strong><ol>{analysis.blockers.map((line) => <li key={line}>{line}</li>)}</ol></>}
      {analysis.applied.length > 0 && <><strong>{bad ? "ผ่านการตรวจแล้ว (ใช้เมื่อแก้ข้อข้างบนแล้ว)" : "จะใช้ในการจำลอง"}</strong><ul>{analysis.applied.map((line) => <li key={line}>{line}</li>)}</ul></>}
      {analysis.notes.length > 0 && <ul className="is-notes">{analysis.notes.map((line) => <li key={line}>{line}</li>)}</ul>}
      {analysis.driftCount > 0 && <button type="button" className="editor-sim-align" onClick={() => alignEditorMapToModel()}>จัดให้ตรงโมเดลจริง ({analysis.driftCount} รายการ)</button>}
      {!bad && !analysis.applied.length && !analysis.notes.length && <p>ยังไม่มีการแก้ไขที่มีผลกับการจำลอง</p>}
      <p className="editor-sim-status-help">ใช้ได้: ปักไฟ · พื้นที่ห้ามผ่าน · ปิด/ลบทาง · ลดความกว้าง/ความจุ · ทางเดียว · จำนวนคนในห้อง · ย้ายประตู/จุดทางเดิน · เพิ่มทาง/จุดใหม่ (ระบบตรวจพื้นและผนังให้)</p>
    </div>}
  </div>;
}
