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
  return <section className="sim-control-section sim-quality-section" aria-label="คุณภาพกราฟิก">
    <div className="sim-section-title"><span>ภาพและความลื่นไหล</span><strong>{tier === "high" ? "รายละเอียดสูง" : tier === "balanced" ? "สมดุล" : "ประหยัดพลังงาน"}</strong></div>
    <div className="sim-quality-options" role="group" aria-label="เลือกระดับภาพ">
      {options.map((option) => <button type="button" key={option.id} aria-pressed={mode === option.id} onClick={() => setMode(option.id)}>{option.label}</button>)}
    </div>
    <p className="sim-hint neutral">{mode === "auto" ? "ปรับความละเอียด เงา และเอฟเฟกต์ให้เหมาะกับเครื่องโดยอัตโนมัติ" : mode === "economy" ? "ลดเงาและเอฟเฟกต์ ช่วยประหยัดแบตเตอรี่และลดภาระเครื่อง" : "เลือกอัตโนมัติหากรู้สึกว่าฉากเริ่มกระตุก"}</p>
  </section>;
}
