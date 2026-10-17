import { ANNOTATION_ICONS, ANNOTATION_LABELS } from "../constants";
import { useMapperStore } from "../store";
import type { AnnotationType, CameraMode, ToolMode } from "../types";

const toolButtons: Array<{ mode: ToolMode; icon: string; label: string; hint: string }> = [
  { mode: "inspect", icon: "⌖", label: "ตรวจวัตถุ", hint: "คลิกโมเดลเพื่ออ่านชื่อ Mesh และพิกัด" },
  { mode: "annotate", icon: "+", label: "ปักข้อมูล", hint: "คลิกโมเดลแล้วกรอกรายละเอียดตำแหน่ง" },
  { mode: "connect", icon: "↔", label: "เชื่อมเส้นทาง", hint: "คลิก Marker ต้นทางและปลายทาง" },
  { mode: "measure", icon: "📏", label: "วัดระยะ", hint: "คลิกสองจุดเพื่อวัดระยะในโมเดล" },
];

const cameraButtons: Array<{ mode: CameraMode; label: string }> = [
  { mode: "orbit", label: "Orbit" },
  { mode: "god", label: "สำรวจ" },
  { mode: "top", label: "Top" },
  { mode: "isometric", label: "Iso" },
];

const quickTypes: AnnotationType[] = [
  "building",
  "floor",
  "classroom",
  "door",
  "stair",
  "exit",
  "hallway",
  "navigation-node",
  "football-field",
  "restricted-area",
  "fire-source",
  "custom",
];

export function LeftToolbar() {
  const toolMode = useMapperStore((state) => state.toolMode);
  const placementType = useMapperStore((state) => state.placementType);
  const cameraMode = useMapperStore((state) => state.cameraMode);
  const godSpeed = useMapperStore((state) => state.godSpeed);
  const setToolMode = useMapperStore((state) => state.setToolMode);
  const setPlacementType = useMapperStore((state) => state.setPlacementType);
  const setCameraMode = useMapperStore((state) => state.setCameraMode);
  const setGodSpeed = useMapperStore((state) => state.setGodSpeed);
  const showGrid = useMapperStore((state) => state.showGrid);
  const showLabels = useMapperStore((state) => state.showLabels);
  const showModel = useMapperStore((state) => state.showModel);
  const snapEnabled = useMapperStore((state) => state.snapEnabled);
  const snapSize = useMapperStore((state) => state.snapSize);
  const measurement = useMapperStore((state) => state.measurement);
  const setShowGrid = useMapperStore((state) => state.setShowGrid);
  const setShowLabels = useMapperStore((state) => state.setShowLabels);
  const setShowModel = useMapperStore((state) => state.setShowModel);
  const setSnapEnabled = useMapperStore((state) => state.setSnapEnabled);
  const setSnapSize = useMapperStore((state) => state.setSnapSize);
  const clearMeasurement = useMapperStore((state) => state.clearMeasurement);
  const setShowShortcuts = useMapperStore((state) => state.setShowShortcuts);

  return (
    <aside className="left-toolbar panel">
      <section>
        <div className="section-heading"><h2>เครื่องมือ</h2><button type="button" onClick={() => setShowShortcuts(true)}>⌨</button></div>
        <div className="tool-list">
          {toolButtons.map((tool) => (
            <button
              key={tool.mode}
              type="button"
              className={`tool-button${toolMode === tool.mode ? " is-active" : ""}`}
              onClick={() => setToolMode(tool.mode)}
              title={tool.hint}
            >
              <span>{tool.icon}</span>
              <div><strong>{tool.label}</strong><small>{tool.hint}</small></div>
            </button>
          ))}
        </div>
      </section>

      <section className="type-palette-section">
        <h2>ชนิดข้อมูลที่จะปัก</h2>
        <div className="type-palette">
          {quickTypes.map((type) => (
            <button
              key={type}
              type="button"
              className={placementType === type && toolMode === "annotate" ? "is-active" : ""}
              onClick={() => setPlacementType(type)}
              title={ANNOTATION_LABELS[type]}
            >
              <span>{ANNOTATION_ICONS[type]}</span>
              <small>{ANNOTATION_LABELS[type]}</small>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>กล้อง</h2>
        <div className="segmented four">
          {cameraButtons.map((item) => (
            <button
              key={item.mode}
              type="button"
              className={cameraMode === item.mode ? "is-active" : ""}
              onClick={() => setCameraMode(item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {cameraMode === "god" && (
          <div className="god-controls">
            <button id="god-lock-button" type="button" className="button danger full">
              🎮 เข้าควบคุม โหมดสำรวจ
            </button>
            <p><kbd>WASD</kbd> บิน · <kbd>Q/E</kbd> ลง/ขึ้น · <kbd>Shift</kbd> เร่ง · <kbd>Ctrl</kbd> ละเอียด · <kbd>F</kbd> ปัก</p>
            <label>
              ความเร็ว <strong>{godSpeed}</strong>
              <input type="range" min="3" max="180" step="1" value={godSpeed} onChange={(event) => setGodSpeed(Number(event.target.value))} />
            </label>
          </div>
        )}
      </section>

      <section>
        <h2>ความแม่นยำ</h2>
        <label className="switch-row"><input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />Snap to Grid</label>
        <label className="inline-number">ระยะ Snap<input type="number" min="0.001" step="0.1" value={snapSize} onChange={(event) => setSnapSize(Number(event.target.value))} /></label>
        {measurement.start && <button type="button" className="button ghost full" onClick={clearMeasurement}>ล้างการวัดระยะ</button>}
      </section>

      <section>
        <h2>การแสดงผล</h2>
        <label className="switch-row"><input type="checkbox" checked={showModel} onChange={(event) => setShowModel(event.target.checked)} />โมเดล</label>
        <label className="switch-row"><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />Grid และแกน XYZ</label>
        <label className="switch-row"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} />ชื่อ Marker</label>
      </section>
    </aside>
  );
}
