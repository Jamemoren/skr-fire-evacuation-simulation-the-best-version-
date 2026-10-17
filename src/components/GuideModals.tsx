import { useMapperStore } from "../store";

export function OnboardingModal() {
  const show = useMapperStore((state) => state.showOnboarding);
  const setShow = useMapperStore((state) => state.setShowOnboarding);
  if (!show) return null;
  return (
    <div className="modal-backdrop guide-backdrop" role="presentation" onMouseDown={() => setShow(false)}>
      <section className="modal guide-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><span className="eyebrow">PHASE 1 · DATA MAPPING</span><h2>สร้างแผนที่ที่เราเข้าใจตรงกัน</h2></div>
          <button type="button" className="icon-button" onClick={() => setShow(false)}>×</button>
        </div>
        <div className="guide-intro">
          <strong>เป้าหมาย</strong>
          <p>ใช้ GLB เป็นรูปร่างโรงเรียน แล้วปักข้อมูลจริงเป็น Model-local Coordinate เพื่อส่งต่อไปสร้างระบบอพยพ 3,000 คนใน Phase ถัดไป</p>
        </div>
        <div className="guide-steps">
          <article><span>1</span><div><h3>นำเข้าโมเดล</h3><p>เปิดแท็บ “โมเดล” → นำเข้า GLB → กด Auto Fit / Ground</p></div></article>
          <article><span>2</span><div><h3>ตรวจโครงสร้าง</h3><p>ใช้ “ตรวจวัตถุ” คลิกโมเดล ดูชื่อ Mesh, Local XYZ และ World XYZ</p></div></article>
          <article><span>3</span><div><h3>ปักข้อมูลจริง</h3><p>เลือกชนิดข้อมูล เช่น ห้องเรียน ประตู บันได ทางออก แล้วคลิกตำแหน่งบนโมเดล</p></div></article>
          <article><span>4</span><div><h3>เชื่อมเส้นทาง</h3><p>เชื่อมห้อง → ประตู → ทางเดิน → บันได/ทางออก → สนามฟุตบอล</p></div></article>
          <article><span>5</span><div><h3>ตรวจและส่งออก</h3><p>ตรวจคะแนนความพร้อม แล้ว Export JSON พร้อม Model Report ส่งกลับมาในแชต</p></div></article>
        </div>
        <div className="notice success">
          <strong>แก้ปัญหาสำคัญแล้ว:</strong> ตำแหน่งถูกผูกกับพิกัดภายในโมเดล จึงไม่หลุดเมื่อปรับ Scale, Rotation หรือ Position ภายหลัง
        </div>
        <div className="modal-footer"><button type="button" className="button primary" onClick={() => setShow(false)}>เริ่มสร้างแผนที่</button></div>
      </section>
    </div>
  );
}

export function ShortcutsModal() {
  const show = useMapperStore((state) => state.showShortcuts);
  const setShow = useMapperStore((state) => state.setShowShortcuts);
  if (!show) return null;
  const shortcuts = [
    ["W A S D", "เคลื่อนกล้องได้ทุกโหมด"],
    ["Q / E", "ลด/เพิ่มระดับความสูง"],
    ["Shift", "เร่งความเร็ว"],
    ["Ctrl", "เคลื่อนที่ละเอียด"],
    ["F", "ปักข้อมูลหรือวัดตรงเป้า"],
    ["1 / 2 / 3 / 4", "ตรวจ / ปัก / เชื่อม / วัด"],
    ["Ctrl + Z", "Undo"],
    ["Ctrl + Y", "Redo"],
    ["Ctrl + D", "ทำสำเนาตำแหน่งที่เลือก"],
    ["Delete", "ลบตำแหน่งหรือเส้นเชื่อมที่เลือก"],
    ["Esc", "ปิดหน้าต่างหรือปลดเมาส์"],
  ];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => setShow(false)}>
      <section className="modal shortcuts-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header"><div><span className="eyebrow">CONTROLS</span><h2>คีย์ลัด</h2></div><button type="button" className="icon-button" onClick={() => setShow(false)}>×</button></div>
        <div className="shortcut-list">
          {shortcuts.map(([key, detail]) => <div key={key}><kbd>{key}</kbd><span>{detail}</span></div>)}
        </div>
      </section>
    </div>
  );
}
