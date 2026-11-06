import { useQualityStore } from "./qualityStore";
import type { QualityMode } from "./qualityPolicy";

const options: Array<{ id: QualityMode; label: string }> = [
  { id: "auto", label: "อัตโนมัติ" }, { id: "high", label: "คมชัด" },
  { id: "balanced", label: "สมดุล" }, { id: "economy", label: "ประหยัด" },
];
export function QualityControls() {
  const mode = useQualityStore((state) => state.mode);
  const tier = useQualityStore((state) => state.tier);
  const setMode = useQualityStore((state) => state.setMode);
  return <div className="sw-quality" aria-label="คุณภาพกราฟิก">
    <header className="sw-section-head"><h3>ภาพและความลื่นไหล</h3><span className="pi-chip is-neutral">ใช้อยู่: {tier === "high" ? "รายละเอียดสูง" : tier === "balanced" ? "สมดุล" : "ประหยัดพลังงาน"}</span></header>
    <div className="pi-seg" role="radiogroup" aria-label="เลือกระดับภาพ">
      {options.map((option) => <button type="button" role="radio" key={option.id} aria-checked={mode === option.id} className={mode === option.id ? "is-active" : ""} onClick={() => setMode(option.id)}>{option.label}</button>)}
    </div>
    <p className="pi-help">{mode === "auto" ? "ปรับความละเอียด เงา และเอฟเฟกต์ให้เหมาะกับเครื่องโดยอัตโนมัติ" : mode === "economy" ? "ลดเงาและเอฟเฟกต์ ช่วยประหยัดแบตเตอรี่และลดภาระเครื่อง" : "เลือกอัตโนมัติหากรู้สึกว่าฉากเริ่มกระตุก"}</p>
  </div>;
}
