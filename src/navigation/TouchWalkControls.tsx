import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useBuilding1Store } from "../building1/building1Store";
import { UiIcon } from "../components/UiIcon";
import { clearWalkInput, useWalkStore, walkInput } from "./walkStore";
import { canEndPointerGesture, canStartCameraLook, releasePointerCapture } from "./pointerPolicy";

export function TouchWalkControls({ blocked, onExit }: { blocked: boolean; onExit: () => void }) {
  const floor = useWalkStore((state) => state.floor);
  const goToFloor = useWalkStore((state) => state.goToFloor);
  const [fast, setFast] = useState(false);
  const movePointer = useRef<{ id: number; button: number; element: HTMLDivElement } | null>(null);
  const lookPointer = useRef<{ id: number; button: number; x: number; y: number; element: HTMLDivElement } | null>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const reset = () => {
    const moving = movePointer.current, looking = lookPointer.current;
    clearWalkInput(); movePointer.current = null; lookPointer.current = null;
    if (moving) releasePointerCapture(moving.element, moving.id);
    if (looking) releasePointerCapture(looking.element, looking.id);
    if (knob.current) knob.current.style.transform = "translate(-50%, -50%)";
  };
  useEffect(() => {
    walkInput.suspended = blocked; reset();
    const onHidden = () => reset();
    window.addEventListener("blur", onHidden); document.addEventListener("visibilitychange", onHidden);
    return () => { reset(); walkInput.suspended = false; window.removeEventListener("blur", onHidden); document.removeEventListener("visibilitychange", onHidden); };
  }, [blocked]);

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (movePointer.current?.id !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const limit = Math.max(20, (rect.width - 44) / 2);
    let x = event.clientX - rect.left - rect.width / 2, y = event.clientY - rect.top - rect.height / 2;
    const length = Math.hypot(x, y), scale = Math.min(1, limit / Math.max(1, length)); x *= scale; y *= scale;
    const magnitude = Math.hypot(x, y) / limit;
    const response = magnitude < 0.12 ? 0 : (magnitude - 0.12) / (0.88 * magnitude);
    walkInput.x = x / limit * response; walkInput.forward = -y / limit * response;
    if (knob.current) knob.current.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  };
  const endMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canEndPointerGesture(movePointer.current, event)) return;
    const owner = movePointer.current!;
    movePointer.current = null;
    releasePointerCapture(owner.element, owner.id);
    walkInput.x = 0; walkInput.forward = 0;
    if (knob.current) knob.current.style.transform = "translate(-50%, -50%)";
  };
  const endLook = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canEndPointerGesture(lookPointer.current, event)) return;
    const owner = lookPointer.current!;
    lookPointer.current = null;
    releasePointerCapture(owner.element, owner.id);
  };
  if (blocked) return null;
  return <div className="touch-walk-controls" aria-label="การควบคุมเดินบนจอสัมผัส">
    <div className="touch-walk-heading"><span><i /> โหมดเดินสำรวจ</span>
      <select aria-label="ชั้นสำหรับเดินสำรวจ" value={floor} onChange={(event) => {
        reset(); const nextFloor = Number(event.target.value);
        useBuilding1Store.getState().setSelectedFloor(nextFloor);
        useBuilding1Store.getState().setViewMode(nextFloor === 1 ? "exterior" : "cutaway");
        goToFloor(nextFloor);
      }}>{Array.from({ length: 9 }, (_, i) => <option key={i + 1} value={i + 1}>{i === 0 ? "ลานโรงเรียน" : `ชั้น ${i + 1}`}</option>)}</select>
      <button type="button" onClick={onExit} aria-label="ออกจากโหมดเดิน"><UiIcon name="close" /></button>
    </div>
    <div className="walk-move-control"><span>เดิน / ถอย / เดินข้าง</span>
      <div className="walk-stick" role="group" tabIndex={0} aria-label="จอยเดิน ลากขึ้นเพื่อเดินหน้า ลงเพื่อถอย ซ้ายขวาเพื่อเดินข้าง"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => { if (movePointer.current !== null || event.button !== 0) return; event.preventDefault(); movePointer.current = { id: event.pointerId, button: event.button, element: event.currentTarget }; event.currentTarget.setPointerCapture(event.pointerId); move(event); }}
        onPointerMove={move}
        onPointerUp={endMove} onPointerCancel={endMove} onLostPointerCapture={endMove}>
        <span className="walk-axis-y" /><span className="walk-axis-x" /><span className="walk-knob" ref={knob} />
      </div>
    </div>
    <div className="walk-look-control"><span>ลากเพื่อหันมอง</span>
      <div className="walk-look-pad" role="group" tabIndex={0} aria-label="แผงหันมอง ลากซ้ายขวาเพื่อหัน และขึ้นลงเพื่อก้มเงย"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => { if (lookPointer.current || !canStartCameraLook(event.pointerType, event.button)) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); lookPointer.current = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, element: event.currentTarget }; }}
        onPointerMove={(event) => { const previous = lookPointer.current; if (!previous || previous.id !== event.pointerId) return; walkInput.lookX += event.clientX - previous.x; walkInput.lookY += event.clientY - previous.y; previous.x = event.clientX; previous.y = event.clientY; }}
        onPointerUp={endLook} onPointerCancel={endLook} onLostPointerCapture={endLook}><UiIcon name="eye" /><span className="walk-look-cross">＋</span></div>
      <button type="button" className="walk-speed" aria-pressed={fast} onClick={() => { setFast(!fast); walkInput.fast = !fast; }}>{fast ? "เดินเร็ว" : "ความเร็วปกติ"}</button>
    </div>
  </div>;
}
