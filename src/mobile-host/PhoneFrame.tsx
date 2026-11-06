import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export const PHONE_SIZES = {
  compact: { label: "Compact", width: 360, height: 800 },
  standard: { label: "Standard", width: 390, height: 844 },
  large: { label: "Large", width: 430, height: 932 },
} as const;
export type PhoneSize = keyof typeof PHONE_SIZES;

/** Top/bottom safe areas inside the screen (camera strip and home-indicator strip). */
export const SAFE_TOP = 40;
export const SAFE_BOTTOM = 22;
const BEZEL = 12;

interface PhoneFrameProps {
  size: PhoneSize;
  /** "fit": scale down to the available area; "actual": 100 % (the stage scrolls). */
  zoom: "fit" | "actual";
  /** Small screens: no decorative frame, the app fills the area. */
  bare?: boolean;
  label: string;
  children: ReactNode;
}

/**
 * Decorative phone frame around a logical viewport (360/390/430 px wide). It is a test viewport,
 * not an emulation of any particular device or OS: no fake battery or signal is shown.
 * Scaling uses a CSS transform on the whole frame, so pointer and scroll positions inside the
 * iframe stay correct.
 */
export function PhoneFrame({ size, zoom, bare = false, label, children }: PhoneFrameProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const spec = PHONE_SIZES[size];
  const frameWidth = spec.width + BEZEL * 2;
  const frameHeight = spec.height + BEZEL * 2;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || bare) return undefined;
    const measure = () => {
      if (zoom === "actual") { setScale(1); return; }
      // Content box of the stage (its padding keeps room for the scale note), so the frame never clips.
      const style = getComputedStyle(stage);
      const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const next = Math.min(1, width / frameWidth, height / frameHeight);
      setScale(Math.max(0.05, Math.floor(next * 1000) / 1000));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [zoom, frameWidth, frameHeight, bare]);

  if (bare) return <div className="mh-bare" aria-label={label}>{children}</div>;

  return (
    <div ref={stageRef} className={`mh-stage is-${zoom}`}>
      <div className="mh-fit" style={{ width: frameWidth * scale, height: frameHeight * scale }}>
        <div className="mh-phone" style={{ width: frameWidth, height: frameHeight, transform: `scale(${scale})` }} role="group" aria-label={`${label} — หน้าจอทดสอบ ${spec.width}×${spec.height}`}>
          <span className="mh-key is-a" aria-hidden="true" />
          <span className="mh-key is-b" aria-hidden="true" />
          <span className="mh-key is-c" aria-hidden="true" />
          <div className="mh-screen" style={{ width: spec.width, height: spec.height }}>
            <div className="mh-safe-top" style={{ height: SAFE_TOP }} aria-hidden="true"><span className="mh-camera" /></div>
            <div className="mh-viewport" style={{ height: spec.height - SAFE_TOP - SAFE_BOTTOM }}>{children}</div>
            <div className="mh-safe-bottom" style={{ height: SAFE_BOTTOM }} aria-hidden="true"><span className="mh-home" /></div>
          </div>
        </div>
      </div>
      <p className="mh-scale-note" aria-live="polite">หน้าจอทดสอบ {spec.width}×{spec.height} · แสดง {Math.round(scale * 100)}%</p>
    </div>
  );
}
