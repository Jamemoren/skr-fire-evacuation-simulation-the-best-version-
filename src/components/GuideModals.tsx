import { useRef } from "react";
import { useMapperStore } from "../store";
import { useModalFocus } from "./useModalFocus";

export function ShortcutsModal() {
  const show = useMapperStore((state) => state.showShortcuts);
  const setShow = useMapperStore((state) => state.setShowShortcuts);
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, show);
  if (!show) return null;
  const shortcuts = [
    ["W A S D", "เคลื่อนกล้องได้ทุกโหมด"],
    ["คลิกขวาค้าง + ลาก", "หันมองด้วยกล้อง"],
    ["Q / E", "ลด/เพิ่มระดับความสูง"],
    ["Shift", "เร่งความเร็ว"],
    ["Ctrl", "เคลื่อนที่ละเอียด"],
    ["F", "ปักข้อมูลหรือวัดตรงเป้า"],
    ["1 / 2 / 3 / 4", "ตรวจ / ปัก / เชื่อม / วัด"],
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y", "Redo"],
    ["G / R / T", "ย้าย / หมุน / ปรับขนาดในหน้าแก้ไข"],
    ["Ctrl + D", "ทำสำเนาตำแหน่งหรือวัตถุที่เลือก"],
    ["Delete", "ลบตำแหน่งหรือเส้นเชื่อมที่เลือก"],
    ["Esc", "ปิดหน้าต่างหรือปลดเมาส์"],
  ];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => setShow(false)}>
      <section ref={dialogRef} className="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header"><div><span className="eyebrow">CONTROLS</span><h2 id="shortcuts-title">คีย์ลัด</h2></div><button type="button" className="icon-button" aria-label="ปิดหน้าต่างคีย์ลัด" onClick={() => setShow(false)}>×</button></div>
        <div className="shortcut-list">
          {shortcuts.map(([key, detail]) => <div key={key}><kbd>{key}</kbd><span>{detail}</span></div>)}
        </div>
      </section>
    </div>
  );
}
