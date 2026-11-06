import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UiIcon } from "./UiIcon";
import "./guided-tour.css";

export type TourPanel = "scene" | "controls" | "metrics" | "activity";

const steps = [
  {
    target: '[data-tour="building"]',
    panel: "scene",
    title: "เริ่มที่อาคารของเรา",
    description: "กด “อาคาร” ที่กรอบสว่าง เพื่อจัดกล้องกลับมาดูอาคารเรียน จากนั้นกดขั้นถัดไป",
    task: "ลองกดปุ่มอาคาร",
  },
  {
    target: '[data-tour="population"]',
    panel: "controls",
    title: "เลือกรอบทดลอง 1,500 คน",
    description: "กดปุ่มที่ไฮไลต์เพื่อกำหนดจำนวนคนสำหรับรอบทดลอง ปุ่มนี้อยู่ในแผงตั้งค่าการจำลอง",
    task: "ลองเลือก 1,500 คน",
  },
  {
    target: '[data-tour="strategy"]',
    panel: "controls",
    title: "ลองแนวทางสมดุล",
    description: "กด “สมดุล” เพื่อให้การเลือกเส้นทางคำนึงถึงเวลา คิว และความเสี่ยงร่วมกัน",
    task: "ลองกดสมดุล",
  },
  {
    target: '[data-tour="fire"]',
    panel: "controls",
    title: "เพิ่มจุดไฟตัวอย่าง",
    description: "กด “ปีกซ้าย” เพื่อเพิ่มจุดกำเนิดไฟในอาคาร จุดไฟนี้จะใช้ในการจำลองรอบจริงของคุณ",
    task: "ลองเพิ่มจุดไฟปีกซ้าย",
  },
  {
    target: '[data-tour="run"]',
    panel: "controls",
    title: "ควบคุมรอบจำลองตรงนี้",
    description: "กด “เริ่มการจำลอง” เมื่อระบบพร้อม ระหว่างรันจะมี “หยุดชั่วคราว” และ “ทำต่อ” ให้ลองใช้",
    task: "ลองกดปุ่มควบคุมรอบจำลอง",
  },
  {
    target: '[data-tour="metrics"] [data-kpi="first"]',
    panel: "metrics",
    title: "ดูว่ามีกี่คนถึงจุดรวมพล",
    description: "ตัวเลขตรงนี้คือคนที่มาถึงแล้ว ส่วนการ์ดข้าง ๆ แสดงจำนวนคนรอและเวลา บนมือถือเปิดดูจากเมนู “ผลอพยพ”",
  },
  {
    target: '[data-tour="bottlenecks"]',
    panel: "activity",
    title: "ตามหาจุดที่คนรอสะสม",
    description: "แผงนี้แสดงชื่อจุดคอขวดและเวลารอ หากยังไม่มีรายการ ให้รอผลระหว่างจำลอง บนมือถือเปิดจาก “เหตุการณ์”",
  },
] satisfies { target: string; panel: TourPanel; title: string; description: string; task?: string }[];

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Layout {
  spot: Bounds | null;
  card: Bounds;
  side: string;
  locked: boolean;
}

interface GuidedTourProps {
  panel: TourPanel;
  onPrepare: (panel: TourPanel) => void;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function GuidedTour({ panel, onPrepare, onClose }: GuidedTourProps) {
  const [index, setIndex] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [acted, setActed] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const step = steps[index];

  useLayoutEffect(() => {
    if (!completed) onPrepare(step.panel);
    setActed(false);
    setLayout(null);
    const card = cardRef.current;
    if (!card) return;
    card.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    // Panels open with a short transition after onPrepare, so the target may not exist yet;
    // it is looked up again on every measure until found.
    let target = completed ? null : document.querySelector<HTMLElement>(step.target);
    targetRef.current = target;
    let scrolled = false;
    let frame = 0;

    const measure = () => {
      if (!completed && (!target || !target.isConnected)) {
        target = document.querySelector<HTMLElement>(step.target);
        targetRef.current = target;
        if (target) {
          resize.observe(target);
          mutation.observe(target, { attributes: true, attributeFilter: ["disabled"], childList: true, subtree: true });
          target.addEventListener("click", recordAction);
          target.addEventListener("change", recordAction);
        }
      }
      const viewWidth = document.documentElement.clientWidth;
      const viewHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const cardWidth = Math.min(352, viewWidth - 24);
      const cardStyle = getComputedStyle(card);
      const borderHeight = parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth);
      let cardHeight = Math.min(card.scrollHeight + borderHeight, viewHeight - 24);
      let raw = target?.getBoundingClientRect();
      let spot: Bounds | null = null;
      if (raw && raw.width > 0 && raw.height > 0) {
        if (!scrolled) {
          scrolled = true;
          target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          raw = target?.getBoundingClientRect() ?? raw;
        }
        let left = Math.max(0, raw.left);
        let top = Math.max(viewportTop, raw.top);
        let right = Math.min(viewWidth, raw.right);
        let bottom = Math.min(viewportTop + viewHeight, raw.bottom);
        for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const bounds = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
        }
        if (right > left && bottom > top) {
          left = Math.max(4, left - 6);
          top = Math.max(viewportTop + 4, top - 6);
          spot = {
            left,
            top,
            width: Math.min(viewWidth - 4, right + 6) - left,
            height: Math.min(viewportTop + viewHeight - 4, bottom + 6) - top,
          };
        }
      }

      const maxLeft = viewWidth - cardWidth - 12;
      const minTop = viewportTop + 12;
      const maxTop = viewportTop + viewHeight - cardHeight - 12;
      let cardLeft = (viewWidth - cardWidth) / 2;
      let cardTop = viewportTop + (viewHeight - cardHeight) / 2;
      let side = "center";
      if (spot) {
        const candidates = [
          { side: "right", left: spot.left + spot.width + 18, top: clamp(spot.top, minTop, maxTop) },
          { side: "left", left: spot.left - cardWidth - 18, top: clamp(spot.top, minTop, maxTop) },
          { side: "bottom", left: clamp(spot.left, 12, maxLeft), top: spot.top + spot.height + 18 },
          { side: "top", left: clamp(spot.left, 12, maxLeft), top: spot.top - cardHeight - 18 },
        ];
        const position = candidates.find((candidate) =>
          candidate.left >= 12 && candidate.left <= maxLeft && candidate.top >= minTop && candidate.top <= maxTop);
        if (position) {
          cardLeft = position.left;
          cardTop = position.top;
          side = position.side;
        } else {
          const spaceBelow = viewportTop + viewHeight - 12 - spot.top - spot.height - 18;
          const spaceAbove = spot.top - 18 - minTop;
          if (spaceBelow >= spaceAbove) {
            cardHeight = Math.min(cardHeight, Math.max(80, spaceBelow));
            cardTop = spot.top + spot.height + 18;
            side = "bottom";
          } else {
            cardHeight = Math.min(cardHeight, Math.max(80, spaceAbove));
            cardTop = spot.top - cardHeight - 18;
            side = "top";
          }
        }
      }
      const controls = target?.matches("button, input, select")
        ? [target]
        : [...target?.querySelectorAll<HTMLElement>("button, input, select") ?? []];
      const locked = controls.length > 0 && controls.every((control) => control.matches(":disabled"));
      setLayout({ spot, card: { left: cardLeft, top: cardTop, width: cardWidth, height: cardHeight }, side, locked });
    };

    function scheduleMeasure() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    const recordAction = (event: Event) => {
      const control = event.target instanceof Element ? event.target.closest("button, input, select") : null;
      if (control && !control.matches(":disabled")) setActed(true);
    };
    const resize = new ResizeObserver(scheduleMeasure);
    resize.observe(card);
    if (target) resize.observe(target);
    const mutation = new MutationObserver(scheduleMeasure);
    if (target) mutation.observe(target, { attributes: true, attributeFilter: ["disabled"], childList: true, subtree: true });
    target?.addEventListener("click", recordAction);
    target?.addEventListener("change", recordAction);
    window.addEventListener("resize", scheduleMeasure);
    document.addEventListener("scroll", scheduleMeasure, true);
    // Panels and the results drawer open with CSS transitions; re-measure when they settle.
    document.addEventListener("transitionend", scheduleMeasure, true);
    window.visualViewport?.addEventListener("resize", scheduleMeasure);
    window.visualViewport?.addEventListener("scroll", scheduleMeasure);
    measure();
    const settle = window.setTimeout(scheduleMeasure, 250);
    const settleAfterPanel = window.setTimeout(scheduleMeasure, 480);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      window.clearTimeout(settleAfterPanel);
      resize.disconnect();
      mutation.disconnect();
      target?.removeEventListener("click", recordAction);
      target?.removeEventListener("change", recordAction);
      window.removeEventListener("resize", scheduleMeasure);
      document.removeEventListener("scroll", scheduleMeasure, true);
      document.removeEventListener("transitionend", scheduleMeasure, true);
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("scroll", scheduleMeasure);
    };
  }, [step, completed, onPrepare, panel]);

  useEffect(() => {
    const originalFocus = document.activeElement;
    const handleKeys = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab") return;
      const target = targetRef.current;
      const controls = [
        ...(target?.matches("button, input, select") ? [target] : []),
        ...target?.querySelectorAll<HTMLElement>("button, input, select") ?? [],
        ...cardRef.current?.querySelectorAll<HTMLElement>("button") ?? [],
      ].filter((element) => !element.matches(":disabled") && element.getBoundingClientRect().width > 0);
      if (!controls.length) return;
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = current < 0
        ? (event.shiftKey ? controls.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      event.preventDefault();
      controls[next].focus({ preventScroll: true });
    };
    window.addEventListener("keydown", handleKeys, true);
    return () => {
      window.removeEventListener("keydown", handleKeys, true);
      const focus = originalFocus instanceof HTMLElement && originalFocus.isConnected
        ? originalFocus
        : document.querySelector<HTMLElement>(".sw-guide-button");
      focus?.focus({ preventScroll: true });
    };
  }, [onClose]);

  const spot = layout?.spot;
  const viewHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
  const arrow = spot && layout ? ({
    right: { left: layout.card.left - 7, top: clamp(spot.top + spot.height / 2, layout.card.top + 20, layout.card.top + layout.card.height - 20) - 6 },
    left: { left: layout.card.left + layout.card.width - 6, top: clamp(spot.top + spot.height / 2, layout.card.top + 20, layout.card.top + layout.card.height - 20) - 6 },
    bottom: { left: clamp(spot.left + spot.width / 2, layout.card.left + 20, layout.card.left + layout.card.width - 20) - 6, top: layout.card.top - 7 },
    top: { left: clamp(spot.left + spot.width / 2, layout.card.left + 20, layout.card.left + layout.card.width - 20) - 6, top: layout.card.top + layout.card.height - 6 },
  } as Record<string, { left: number; top: number }>)[layout.side] : undefined;
  const next = () => {
    if (index === steps.length - 1) setCompleted(true);
    else setIndex(index + 1);
  };

  return createPortal(
    <div className="guided-tour">
      {spot ? (
        <>
          <div className="guided-tour-blocker" style={{ left: 0, top: 0, width: "100%", height: spot.top }} />
          <div className="guided-tour-blocker" style={{ left: 0, top: spot.top + spot.height, width: "100%", height: Math.max(0, viewHeight - spot.top - spot.height) }} />
          <div className="guided-tour-blocker" style={{ left: 0, top: spot.top, width: spot.left, height: spot.height }} />
          <div className="guided-tour-blocker" style={{ left: spot.left + spot.width, right: 0, top: spot.top, height: spot.height }} />
          <div className="guided-tour-spot" style={spot}><span className="guided-tour-beacon" /></div>
        </>
      ) : <div className="guided-tour-blocker guided-tour-dimmer" />}
      {arrow && <div className="guided-tour-arrow" style={arrow} />}
      <section ref={cardRef} className="guided-tour-card" role="dialog" aria-labelledby="tour-title"
        aria-describedby="tour-description" data-side={layout?.side} data-step={completed ? "complete" : index + 1}
        style={{ left: layout?.card.left ?? 12, top: layout?.card.top ?? 12, maxHeight: layout?.card.height, visibility: layout ? "visible" : "hidden" }}>
        <div className="guided-tour-card-top">
          <span><UiIcon name={completed ? "guide" : "play"} /> {completed ? "เรียนรู้ครบแล้ว" : `สอนใช้งาน · ${index + 1} / ${steps.length}`}</span>
          <button type="button" className="guided-tour-close" onClick={onClose} aria-label="ออกจากบทเรียน"><UiIcon name="close" /></button>
        </div>
        <div className="guided-tour-progress" aria-hidden="true">
          {steps.map((item, itemIndex) => <i key={item.target} className={completed || itemIndex <= index ? "is-filled" : ""} />)}
        </div>
        <div key={completed ? "complete" : index} className="guided-tour-content">
          <h2 id="tour-title" tabIndex={-1}>{completed ? "พร้อมลองด้วยตัวเองแล้ว" : step.title}</h2>
          <p id="tour-description">{completed ? "คุณรู้จักปุ่มหลักครบแล้ว ลองเปลี่ยนแนวทางเลือกเส้นทาง แล้วสังเกตเวลาและคิวในรอบถัดไป เปิดบทเรียนนี้ซ้ำได้จากเมนูคู่มือ" : step.description}</p>
          {!completed && (
            <div className={acted ? "guided-tour-task is-done" : "guided-tour-task"} role="status">
              {layout?.locked ? "รอบปัจจุบันล็อกปุ่มนี้ไว้ กดขั้นถัดไปเพื่อเรียนรู้ต่อได้"
                : acted ? "✓ ลองกดแล้ว ไปขั้นถัดไปได้เลย"
                : step.task ?? "สังเกตค่าที่ไฮไลต์ แล้วกดขั้นถัดไป"}
            </div>
          )}
        </div>
        <div className="guided-tour-actions">
          {completed ? <button type="button" className="guided-tour-primary" onClick={onClose}>กลับไปใช้งานเว็บ →</button> : (
            <>
              <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>ย้อนกลับ</button>
              <button type="button" className="guided-tour-primary" onClick={next}>{index === steps.length - 1 ? "เรียนครบแล้ว ✓" : "ขั้นถัดไป →"}</button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
