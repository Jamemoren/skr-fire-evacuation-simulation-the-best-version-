import { useEffect, useRef, useState } from "react";
import { PROJECT_CONTEXT_TH, PROJECT_METHOD_NOTE_TH, PROJECT_NAME_TH } from "../projectIdentity";
import { UiIcon } from "./UiIcon";
import "./user-guide.css";

const lessons = [
  {
    label: "รู้จักหน้าจอ",
    icon: "scene",
    title: "ลองหมุนกล้องและเลือกชั้น",
    target: "scene",
    action: "ไปที่แถบมุมมอง",
    controls: ["อาคาร", "สนาม", "ด้านบน", "ภายในชั้น"],
    instructions: [
      "หากเห็นหน้าบทนำ ให้กด “ข้ามบทนำ” แถบมุมมองอยู่ด้านบนของฉาก 3 มิติ",
      "ลองกด “อาคาร” แล้วสลับเป็น “สนาม” เพื่อดูจุดรวมพล หรือกด “ด้านบน” เพื่อดูผังจากด้านบน",
      "เลือก “ภายในชั้น” จากเมนูมุมมองอาคาร จากนั้นเลือกชั้นที่ต้องการดู",
      "บนคอมพิวเตอร์ ลากด้วยคลิกขวาเพื่อหันมองและใช้ล้อเมาส์เพื่อซูม บนมือถือให้ลากเพื่อหมุนและใช้สองนิ้วเพื่อซูม",
    ],
    result: "เมื่อเลือก “ภายในชั้น” เมนูเลือกชั้นจะปรากฏ และฉากจะแสดงพื้นที่ภายในชั้นที่เลือก",
  },
  {
    label: "ตั้งสถานการณ์",
    icon: "controls",
    title: "ตั้งรอบทดลอง 1,500 คน",
    target: "setup",
    action: "เปิดแผงตั้งค่า",
    controls: ["ทดสอบระบบ 1,500", "สมดุล", "เป็นระเบียบ", "ปีกซ้าย"],
    instructions: [
      "ดูแผงควบคุมทางซ้ายบนคอมพิวเตอร์ หรือกด “ตั้งค่า” ที่เมนูด้านล่างบนมือถือ",
      "เลือก “ทดสอบระบบ 1,500” จากนั้นเลือกแนวทาง “สมดุล” และพฤติกรรมฝูงชน “เป็นระเบียบ”",
      "ในหัวข้อสถานการณ์ไฟและควัน กด “ปีกซ้าย” เพื่อเพิ่มจุดไฟตัวอย่าง หรือใช้ “วางจุดไฟบนโมเดล” แล้วเลือกตำแหน่งเอง",
      "หากปุ่มจำนวนคนหรือแนวทางเป็นสีจาง ให้กด “เริ่มใหม่” เพื่อจบรอบปัจจุบันก่อนตั้งค่า",
    ],
    result: "ตัวเลือก 1,500 และสมดุลจะแสดงว่าเลือกอยู่ ส่วนหัวข้อสถานการณ์ไฟจะแสดงจำนวนต้นกำเนิด",
  },
  {
    label: "เริ่มจำลอง",
    icon: "play",
    title: "เริ่มรอบและลองหยุดดูคิว",
    target: "run",
    action: "ไปที่ปุ่มเริ่มการจำลอง",
    controls: ["เริ่มการจำลอง", "หยุดชั่วคราว", "ทำต่อ", "เริ่มใหม่"],
    instructions: [
      "รอให้ระบบตรวจความพร้อมผ่าน แล้วกด “เริ่มการจำลอง” จากแผงควบคุม หรือกด “เริ่ม” ในเมนูมือถือ",
      "สังเกตเวลาจำลองและการเคลื่อนตัวของคน ลองเลือก “สนาม” เพื่อดูคนที่เดินทางถึงจุดรวมพล",
      "กด “หยุดชั่วคราว” เพื่อสำรวจจุดที่คนรอ แล้วกด “ทำต่อ” เพื่อให้รอบเดิมเดินหน้าต่อ",
    ],
    result: "เมื่อเริ่มแล้ว ปุ่มเริ่มจะเปลี่ยนเป็นปุ่มหยุดชั่วคราว และเวลาจำลองจะเริ่มเดิน",
  },
  {
    label: "อ่านผลอพยพ",
    icon: "metrics",
    title: "หาคอขวดและเทียบผลสองรอบ",
    target: "results",
    action: "เปิดแผงผลอพยพ",
    controls: ["ถึงจุดรวมพล", "กำลังรอ", "T95", "เหตุการณ์"],
    instructions: [
      "ดูแผงผลการอพยพ หรือกด “ผลอพยพ” บนมือถือ จดจำนวนคนถึงจุดรวมพล จำนวนคนกำลังรอ และเวลาจำลอง",
      "ดูแผง “การวิเคราะห์คอขวด” หรือกด “เหตุการณ์” บนมือถือ ชื่อจุดและเวลารอโดยประมาณช่วยบอกว่าคิวสะสมที่ทางเดิน ประตู หรือบันไดใด",
      "จบรอบแรกแล้วกด “เริ่มใหม่” คงจำนวนคน จุดไฟ และพฤติกรรมเดิมไว้ แล้วเปลี่ยนจาก “สมดุล” เป็น “เร็วที่สุด” เพื่อทดลองอีกครั้ง",
      "เทียบจำนวนคนที่ถึงจุดรวมพลพร้อมกับเวลาและคิว หากดู T95 ให้จำว่าระบบคำนวณจากคนที่มาถึงแล้วในรอบนั้น",
    ],
    result: "เมื่อจบสองรอบ คุณจะเปรียบเทียบได้ว่าแนวทางไหนมีคิวรอน้อยกว่า และมีคนถึงจุดรวมพลเท่าไร",
  },
  {
    label: "แก้ไขแผนที่",
    icon: "top",
    title: "ตรวจและส่งออกข้อมูลแผนที่",
    target: "editor",
    action: "ไปที่ปุ่มแก้ไขแบบจำลอง",
    controls: ["นำเข้าไฟล์", "G · ย้าย", "R · หมุน", "T · ขนาด", "ส่งออกโปรเจกต์"],
    instructions: [
      "จากหน้าจำลอง กด “แก้ไขแบบจำลอง” เพื่อเปิดเครื่องมือตรวจวัตถุ ปักตำแหน่ง เชื่อมเส้นทาง และวัดระยะ",
      "ใช้แท็บ “โมเดล” สำหรับไฟล์ GLB หรือกด “นำเข้า” บนแถบด้านบนสำหรับไฟล์แผนที่ JSON",
      "ใช้ WASD เพื่อเคลื่อนกล้อง คลิกขวาค้างแล้วลากเพื่อหันมอง ใช้ G เพื่อย้าย R เพื่อหมุน และ T เพื่อปรับขนาดวัตถุ ลากแกนในฉาก หรือกรอกค่า X Y Z ในแท็บข้อมูล",
      "กด “ส่งออกโปรเจกต์” เพื่อเก็บโมเดล GLB พร้อม Calibration, node, edge และการแก้วัตถุ แล้วนำไฟล์ .skrproject ไป “นำเข้าไฟล์” บนคอมอีกเครื่อง",
    ],
    result: "ไฟล์ JSON ที่ดาวน์โหลดจะมีตำแหน่งและเส้นเชื่อมของแผนที่",
  },
] as const;

export type GuideTarget = (typeof lessons)[number]["target"];

const people = [0, 1, 2, 3, 4, 5];

function FlowDemo() {
  const [split, setSplit] = useState(false);
  return (
    <aside className="user-guide-demo" aria-labelledby="guide-demo-title">
      <span className="user-guide-kicker">ภาพสาธิตแบบโต้ตอบ</span>
      <h3 id="guide-demo-title">คนไหลผ่านทางออกอย่างไร</h3>
      <div className="user-guide-demo-switch" role="group" aria-label="รูปแบบการกระจายคนในภาพสาธิต">
        <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>ใช้ทางเดียว</button>
        <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>กระจายคน</button>
      </div>
      <svg key={String(split)} className="user-guide-map" viewBox="0 0 340 150" aria-hidden="true">
        <path className="guide-route-base" d="M25 75H126L192 40H308M126 75L192 110H308" />
        <path className="guide-route-live" d="M25 75H126L192 40H308" />
        {split && <path className="guide-route-live" d="M126 75L192 110H308" />}
        <rect className="guide-map-node" x="12" y="64" width="23" height="22" rx="6" />
        <circle className="guide-map-node" cx="126" cy="75" r="7" />
        <rect className="guide-map-node" x="303" y="26" width="22" height="28" rx="6" />
        <rect className="guide-map-node" x="303" y="96" width="22" height="28" rx="6" />
        {people.map((person) => <circle className={split ? "guide-person" : "guide-person guide-person-queued"}
          key={person} cx={294 - (split ? person % 3 : person) * 15}
          cy={split && person >= 3 ? 110 : 40} r="4.5" />)}
      </svg>
      <p role="status">{split
        ? "เมื่อทั้งสองทางใช้ได้ การกระจายคนช่วยแบ่งคิวระหว่างทางออก"
        : "เมื่อทุกคนใช้ทางออกเดียว คิวจะสะสมหากคนมาถึงเร็วกว่าที่ทางออกระบายได้"}</p>
      <small>ภาพนี้อธิบายแนวคิดการไหล ดูผลของแต่ละรอบได้จากแผงผลจำลอง</small>
    </aside>
  );
}

interface UserGuideProps {
  open: boolean;
  onClose: () => void;
  onPractice?: (target: GuideTarget) => void;
  onStartTutorial: () => void;
}

export function UserGuide({ open, onClose, onPractice, onStartTutorial }: UserGuideProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lessonHeadingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [reading, setReading] = useState(false);
  const lesson = lessons[step];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  const closeGuide = () => dialogRef.current?.close();
  const changeStep = (index: number) => {
    setStep(index);
    requestAnimationFrame(() => lessonHeadingRef.current?.focus());
  };

  if (!open) return null;

  return (
    <dialog ref={dialogRef} className="user-guide" aria-labelledby="user-guide-title"
      onClose={() => { setReading(false); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
      <div className="user-guide-inner">
        <header className="user-guide-hero">
          <div className="user-guide-top">
            <span className="user-guide-kicker"><UiIcon name="guide" /> เริ่มต้นใช้งาน · 5 บทเรียน</span>
            <button type="button" className="user-guide-close" onClick={closeGuide} aria-label="ปิดคู่มือ"><UiIcon name="close" /></button>
          </div>
          <h2 id="user-guide-title">คู่มือการใช้เว็บ</h2>
          <p className="user-guide-lead">ลองจำลองการอพยพหนึ่งรอบ ตั้งแต่สำรวจอาคารจนถึงอ่านผลคอขวด</p>
          <p className="user-guide-project">{PROJECT_NAME_TH} · {PROJECT_CONTEXT_TH}</p>
        </header>

        <div className="user-guide-main">
          {!reading ? (
            <section className="user-guide-choices" aria-label="เลือกรูปแบบการเรียนรู้">
              <button type="button" className="user-guide-choice user-guide-choice-tour" onClick={() => {
                closeGuide();
                onStartTutorial();
              }}>
                <span className="user-guide-choice-icon"><UiIcon name="play" /></span>
                <span className="user-guide-kicker">แนะนำ · เรียนรู้บนหน้าจอจริง</span>
                <strong>สอนใช้งานแบบชี้จุด</strong>
                <span>กลับหน้าหลัก แล้วทำตามแสงไฮไลต์และคำแนะนำทีละขั้น เหมือนทิวทอเรียลในเกม</span>
                <b>เริ่มสอนใช้งาน →</b>
              </button>
              <button type="button" className="user-guide-choice" onClick={() => setReading(true)}>
                <span className="user-guide-choice-icon"><UiIcon name="guide" /></span>
                <span className="user-guide-kicker">อ่านตามจังหวะของคุณ</span>
                <strong>อ่านคู่มือทีละบท</strong>
                <span>เลือกอ่านวิธีใช้ปุ่มและการดูผล พร้อมภาพสาธิตและคำอธิบายทั้ง 5 บท</span>
                <b>เปิดคู่มือ →</b>
              </button>
              <p className="user-guide-choice-note">ในโหมดสอนใช้งาน คุณจะกดปุ่มจริงเพื่อปรับค่า เพิ่มจุดไฟ และเริ่มรอบจำลอง ออกจากบทเรียนได้ทุกขั้น</p>
            </section>
          ) : (
          <>
          <button type="button" className="user-guide-back" onClick={() => setReading(false)}>← เลือกรูปแบบการเรียนรู้</button>
          <nav className="user-guide-nav" aria-label="บทเรียนในคู่มือ">
            {lessons.map((item, index) => (
              <button type="button" key={item.label} aria-current={index === step ? "step" : undefined}
                onClick={() => changeStep(index)}>
                <span className="user-guide-number">{String(index + 1).padStart(2, "0")}</span>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="user-guide-columns">
            <section className="user-guide-lesson" aria-labelledby="user-guide-lesson-title">
              <span className="user-guide-kicker"><UiIcon name={lesson.icon} /> บทที่ {step + 1} จาก {lessons.length}</span>
              <h3 id="user-guide-lesson-title" ref={lessonHeadingRef} tabIndex={-1}>{lesson.title}</h3>
              <ol key={step} className="user-guide-instructions">
                {lesson.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}
              </ol>
              {onPractice && (
                <div className="user-guide-practice-action">
                  <button type="button" className="user-guide-jump" onClick={() => {
                    closeGuide();
                    onPractice(lesson.target);
                  }}>{lesson.action} →</button>
                  <small>กด “คู่มือ” อีกครั้งเพื่ออ่านต่อจากบทเดิม</small>
                </div>
              )}
              <div className="user-guide-actions">
                <button type="button" disabled={step === 0} onClick={() => changeStep(step - 1)}>← ก่อนหน้า</button>
                {step < lessons.length - 1
                  ? <button type="button" className="user-guide-primary" onClick={() => changeStep(step + 1)}>บทถัดไป →</button>
                  : <button type="button" className="user-guide-primary" onClick={closeGuide}>เสร็จสิ้น</button>}
              </div>
            </section>
            <aside className="user-guide-practice" aria-labelledby="guide-practice-title">
              <span className="user-guide-kicker">ลงมือทำตามบทนี้</span>
              <h3 id="guide-practice-title">มองหาปุ่มเหล่านี้บนหน้าจอ</h3>
              <ul className="user-guide-control-list">
                {lesson.controls.map((label) => <li key={label}>{label}</li>)}
              </ul>
              <div className="user-guide-result">
                <strong>เมื่อทำแล้วจะเห็น</strong>
                <p>{lesson.result}</p>
              </div>
            </aside>
            {lesson.target === "results" && <FlowDemo />}
          </div>
          </>
          )}
          <footer className="user-guide-note">{PROJECT_METHOD_NOTE_TH}</footer>
        </div>
      </div>
    </dialog>
  );
}
