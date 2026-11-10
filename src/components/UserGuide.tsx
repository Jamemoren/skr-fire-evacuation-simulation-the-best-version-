import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PROJECT_CONTEXT_TH, PROJECT_METHOD_NOTE_TH, PROJECT_NAME_TH } from "../projectIdentity";
import { UiIcon } from "./UiIcon";
import "./user-guide.css";
import { LESSONS, LEVELS, loadProgress, saveProgress, searchLessons, totalMinutes, type Lesson, type LessonJump } from "../guide/lessons";
// The worked example (tables, diagram) loads only when its lesson is opened.
const RouteExampleCard = lazy(() => import("../explain/RouteExampleCard").then((module) => ({ default: module.RouteExampleCard })));
import { OPEN_PRESENTATION_EVENT } from "../present/presentEvents";
import { startAutoEditorDemo } from "./AutoEditorDemo";

export type GuideTarget = LessonJump;

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
  /** First visit: a larger welcome, both ways to learn up front, and "skip for now". */
  welcome?: boolean;
  /** Reopen straight on the last lesson (after practising it on screen). */
  resume?: boolean;
  onClose: () => void;
  /** Go to the lesson's area of the screen (opens the right panel). */
  onPractice?: (target: GuideTarget) => void;
  /** Walk through the lesson on the real screen (points at each control, waits until it is used). */
  onPracticeLesson?: (lesson: Lesson) => void;
  onStartTutorial: () => void;
}

export function UserGuide({ open, welcome = false, resume = false, onClose, onPractice, onPracticeLesson, onStartTutorial }: UserGuideProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lessonHeadingRef = useRef<HTMLHeadingElement>(null);
  const [progress, setProgress] = useState(loadProgress);
  const [reading, setReading] = useState(false);
  const [query, setQuery] = useState("");
  /** Phones: the contents fold away so the lesson comes first. */
  const [tocOpen, setTocOpen] = useState(false);
  const lesson = LESSONS.find((item) => item.id === progress.last) ?? LESSONS[0];
  const index = LESSONS.indexOf(lesson);
  const found = useMemo(() => searchLessons(query), [query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);
  useEffect(() => { saveProgress(progress); }, [progress]);
  useEffect(() => { if (open && resume) { setReading(true); requestAnimationFrame(() => lessonHeadingRef.current?.focus()); } }, [open, resume]);

  const closeGuide = () => dialogRef.current?.close();
  const show = (id: string, markDone?: string) => {
    setTocOpen(false);
    setProgress((current) => ({ last: id, done: markDone && !current.done.includes(markDone) ? [...current.done, markDone] : current.done }));
    requestAnimationFrame(() => lessonHeadingRef.current?.focus());
  };
  const next = LESSONS[index + 1];
  const prev = LESSONS[index - 1];
  const doneCount = progress.done.length;

  if (!open) return null;

  const canPractice = !!((lesson.practice?.length && onPracticeLesson) || (lesson.jump && (onPractice || lesson.jump === "present")));
  const practice = () => {
    show(lesson.id, lesson.id);
    closeGuide();
    if (lesson.practice?.length && onPracticeLesson) onPracticeLesson(lesson);
    else if (lesson.jump === "present") window.dispatchEvent(new Event(OPEN_PRESENTATION_EVENT));
    else if (lesson.jump && onPractice) onPractice(lesson.jump);
  };

  return (
    <dialog ref={dialogRef} className={`user-guide${welcome ? " is-welcome" : ""}`} aria-labelledby="user-guide-title"
      onClose={() => { setReading(false); onClose(); }} onKeyDown={(event) => event.stopPropagation()}>
      <div className="user-guide-inner">
        <header className="user-guide-hero">
          <div className="user-guide-top">
            <span className="user-guide-kicker"><UiIcon name="guide" /> {welcome ? "ยินดีต้อนรับ · เข้าครั้งแรก" : `คู่มือ · ${LESSONS.length} บท · ประมาณ ${totalMinutes()} นาที`}</span>
            <button type="button" className="user-guide-close" onClick={closeGuide} aria-label="ปิดคู่มือ"><UiIcon name="close" /></button>
          </div>
          <h2 id="user-guide-title">{welcome ? "เริ่มต้นที่นี่ — คู่มือการใช้เว็บ" : "คู่มือการใช้เว็บ"}</h2>
          <p className="user-guide-lead">สอนตั้งแต่พื้นฐานถึงขั้นสูง: หน้าจอ ตั้งสถานการณ์ ไฟ เริ่มจำลอง อ่านผล หลักคณิตศาสตร์ ตัวแก้ไข ไฟล์ สวมบท มือถือ และโหมดนำเสนอ · เรียนแล้ว {doneCount}/{LESSONS.length} บท</p>
          <p className="user-guide-project">{PROJECT_NAME_TH} · {PROJECT_CONTEXT_TH}</p>
        </header>

        <div className="user-guide-main">
          {!reading ? (
            <section className="user-guide-choices" aria-label="เลือกรูปแบบการเรียนรู้">
              <button type="button" className="user-guide-choice" onClick={() => setReading(true)}>
                <span className="user-guide-choice-icon"><UiIcon name="guide" /></span>
                <span className="user-guide-kicker">อ่านตามจังหวะของคุณ</span>
                <strong>อ่านตามหัวข้อ</strong>
                <span>{LESSONS.length} บท มีสารบัญค้นหาได้ เวลาโดยประมาณ และจำว่าอ่านถึงไหน แต่ละบทบอก: ทำไม → กดที่ไหน → จะเห็นอะไร → ตรวจอะไร</span>
                <b>{doneCount ? `อ่านต่อ: ${lesson.label} →` : "เปิดคู่มือ →"}</b>
              </button>
              <button type="button" className="user-guide-choice user-guide-choice-tour" onClick={() => { closeGuide(); onStartTutorial(); }}>
                <span className="user-guide-choice-icon"><UiIcon name="play" /></span>
                <span className="user-guide-kicker">แนะนำสำหรับครั้งแรก</span>
                <strong>ลองทำบนหน้าจอจริง</strong>
                <span>ระบบพาไปที่ปุ่มจริงทีละขั้น รอให้คุณกด แล้วไปขั้นถัดไป (ข้ามได้ทุกขั้น) — ในแต่ละบทของคู่มือก็มีปุ่ม “ลองทำบนหน้าจอจริง”</span>
                <b>เริ่มสอนใช้งาน →</b>
              </button>
              <p className="user-guide-choice-note">เปิดคู่มือนี้ได้ตลอดจากปุ่ม “คู่มือ” ที่แถบด้านบน · ความคืบหน้าบันทึกไว้ในเบราว์เซอร์นี้</p>
              {welcome && <button type="button" className="user-guide-skip" onClick={closeGuide}>ข้ามไปก่อน — ไปดูแบบจำลอง</button>}
            </section>
          ) : (
          <div className="user-guide-reader">
            <nav className={`user-guide-toc${tocOpen || query ? " is-open" : ""}`} aria-label="สารบัญคู่มือ">
              <button type="button" className="user-guide-back" onClick={() => setReading(false)}>← เลือกรูปแบบการเรียนรู้</button>
              <label className="user-guide-search">
                <span className="sr-only">ค้นหาในคู่มือ</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหา เช่น ไฟ, คอขวด, ส่งออก" aria-describedby="guide-search-count" />
              </label>
              <p id="guide-search-count" className="user-guide-count" aria-live="polite">{query ? `พบ ${found.length} บท` : `${doneCount}/${LESSONS.length} บท · ~${totalMinutes()} นาที`}</p>
              <button type="button" className="user-guide-toc-toggle" aria-expanded={tocOpen} onClick={() => setTocOpen(!tocOpen)}>{tocOpen ? "ซ่อนสารบัญ ▴" : `สารบัญทั้งหมด (${LESSONS.length} บท) ▾`}</button>
              <div className="user-guide-progress" aria-hidden="true"><i style={{ width: `${(doneCount / LESSONS.length) * 100}%` }} /></div>
              {LEVELS.map((level) => {
                const items = found.filter((item) => item.level === level);
                if (!items.length) return null;
                return (
                  <div key={level} className="user-guide-toc-group">
                    <h3>{level}</h3>
                    <ol>
                      {items.map((item) => (
                        <li key={item.id}>
                          <button type="button" aria-current={item.id === lesson.id ? "step" : undefined} onClick={() => show(item.id)}>
                            <span className="user-guide-number">{String(LESSONS.indexOf(item) + 1).padStart(2, "0")}</span>
                            <span className="user-guide-toc-label">{item.label}</span>
                            <small>{progress.done.includes(item.id) ? "✓" : `${item.minutes} น.`}</small>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
              {!found.length && <p className="user-guide-count">ไม่พบบทที่ตรงกับ “{query}” — ลองคำอื่น</p>}
            </nav>

            <article className="user-guide-lesson" aria-labelledby="user-guide-lesson-title">
              <span className="user-guide-kicker">บทที่ {index + 1}/{LESSONS.length} · {lesson.level} · ~{lesson.minutes} นาที {progress.done.includes(lesson.id) ? "· ✓ เรียนแล้ว" : ""}</span>
              <h3 id="user-guide-lesson-title" ref={lessonHeadingRef} tabIndex={-1}>{lesson.title}</h3>
              <div key={lesson.id} className="user-guide-parts">
                <section><h4><b>1</b> ทำไม</h4><p>{lesson.purpose}</p></section>
                <section><h4><b>2</b> กดที่ไหน</h4><ol className="user-guide-instructions">{lesson.where.map((line) => <li key={line}>{line}</li>)}</ol></section>
                <section><h4><b>3</b> จะเห็นอะไร</h4><p>{lesson.see}</p></section>
                <section className="is-check"><h4><b>4</b> ตรวจอะไร</h4><ul>{lesson.check.map((line) => <li key={line}>{line}</li>)}</ul></section>
              </div>
              {lesson.extra === "math" && <Suspense fallback={<p className="user-guide-count" role="status">กำลังโหลดตัวอย่างคำนวณ…</p>}><RouteExampleCard /></Suspense>}
              {lesson.extra === "flow" && <FlowDemo />}
              <div className="user-guide-practice-action">
                {lesson.extra === "auto-demo" && (
                  <button type="button" className="user-guide-jump" onClick={() => { show(lesson.id, lesson.id); closeGuide(); startAutoEditorDemo("guide"); }}>▶ ชมการสาธิตอัตโนมัติ</button>
                )}
                {canPractice && (
                  <button type="button" className={lesson.extra === "auto-demo" ? "user-guide-secondary" : "user-guide-jump"} onClick={practice}>
                    {lesson.practice?.length && onPracticeLesson ? "ลองทำบนหน้าจอจริง →" : lesson.jump === "present" ? "เปิดโหมดนำเสนอ →" : "พาไปที่ปุ่มบนหน้าจอ →"}
                  </button>
                )}
                {lesson.extra === "auto-demo" && <small>การสาธิตทำบนสำเนาชั่วคราว ผังของคุณไม่เปลี่ยน · หยุด ย้อน ข้าม หรือออกได้ทุกเมื่อ</small>}
                {lesson.practice?.length && onPracticeLesson ? <small>ระบบชี้ปุ่มจริงและรอให้คุณกด · ถ้าปุ่มไม่แสดงบนจอนี้จะบอกและให้ข้ามได้ · กด “คู่มือ” เพื่อกลับมาบทเดิม</small> : null}
              </div>
              <div className="user-guide-actions">
                <button type="button" disabled={!prev} onClick={() => prev && show(prev.id)}>← ก่อนหน้า</button>
                {next ? <>
                  <button type="button" onClick={() => show(next.id)}>ข้ามบทนี้</button>
                  <button type="button" className="user-guide-primary" onClick={() => show(next.id, lesson.id)}>เข้าใจแล้ว · บทถัดไป →</button>
                </> : <button type="button" className="user-guide-primary" onClick={() => { show(lesson.id, lesson.id); closeGuide(); }}>เสร็จสิ้น ✓</button>}
              </div>
            </article>
          </div>
          )}
          <footer className="user-guide-note">{PROJECT_METHOD_NOTE_TH}</footer>
        </div>
      </div>
    </dialog>
  );
}
