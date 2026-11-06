import { BLOCK_LEVELS } from "../campusData";
import { useShallow } from "zustand/react/shallow";
import { FIELD_CENTER, STAIR_ZONE_CENTERS, floorBase, type StairZone } from "../../building1/building1Data";
import { useBuilding1Store } from "../../building1/building1Store";
import { UiIcon } from "../../components/UiIcon";
import { useWalkStore } from "../../navigation/walkStore";
import { useMapperStore } from "../../store";
import { useEvacuationStore } from "../simulationStore";
import { CAMPUS_OVERVIEW_FOCUS, EXTENSION_FOCUS, BUILDING3_FOCUS, SKYBRIDGE_FOCUS } from "../../building1/campusExtensionData";
import { useBuilding3Store } from "../../building1/building3Store";
import { SHRINE_FOCUS } from "../../building1/siteLayout";

export function useSceneCommands() {
  const building = useBuilding1Store(useShallow((s) => ({
    viewMode: s.viewMode, selectedFloor: s.selectedFloor, setViewMode: s.setViewMode, setSelectedFloor: s.setSelectedFloor,
    setStairFocus: s.setStairFocus, setExplodeFloors: s.setExplodeFloors,
  })));
  const setCameraMode = useMapperStore((s) => s.setCameraMode);
  const requestCameraFocus = useMapperStore((s) => s.requestCameraFocus);
  const resetBuilding3 = () => { useBuilding3Store.setState({ inspecting:false,cutawayFloor:0 }); };
  const focusCampus = () => { resetBuilding3();useWalkStore.getState().setEnabled(false); building.setViewMode("exterior"); setCameraMode("isometric"); requestCameraFocus(CAMPUS_OVERVIEW_FOCUS); };
  const focusExtension = () => { useBuilding3Store.setState({inspecting:true,cutawayFloor:0,buildingNumber:4});useWalkStore.getState().setEnabled(false); building.setViewMode("exterior"); setCameraMode("isometric"); requestCameraFocus(EXTENSION_FOCUS); };
  const focusBuilding3 = () => { useBuilding3Store.setState({inspecting:true,cutawayFloor:0,buildingNumber:3});useWalkStore.getState().setEnabled(false);building.setViewMode("exterior");setCameraMode("isometric");requestCameraFocus(BUILDING3_FOCUS); };
  const focusBridge = () => { resetBuilding3();useWalkStore.getState().setEnabled(false);building.setViewMode("exterior");setCameraMode("isometric");requestCameraFocus(SKYBRIDGE_FOCUS); };
  const focusShrine = () => { resetBuilding3();useWalkStore.getState().setEnabled(false);building.setViewMode("exterior");setCameraMode("isometric");requestCameraFocus(SHRINE_FOCUS); };
  const focusBuilding = () => { resetBuilding3();useWalkStore.getState().setEnabled(false); building.setViewMode("exterior"); setCameraMode("isometric"); requestCameraFocus([-19, 15, 20]); };
  const focusField = () => { resetBuilding3();useWalkStore.getState().setEnabled(false); building.setViewMode("exterior"); setCameraMode("isometric"); requestCameraFocus(FIELD_CENTER); };
  const focusTop = () => { resetBuilding3();useWalkStore.getState().setEnabled(false); building.setViewMode("exterior");setCameraMode("top"); requestCameraFocus(CAMPUS_OVERVIEW_FOCUS); };
  const focusInterior = (floor = building.selectedFloor, room = false) => {
    setCameraMode("isometric");
    requestCameraFocus(room ? [-24, floorBase(floor) + 1.2, -5] : [-20, floorBase(floor) + 0.4, 18]);
  };
  const interiorView = building.viewMode === "interior" || building.viewMode === "single-floor";
  const floorView = interiorView || building.viewMode === "cutaway";
  const startWalking = () => {
    resetBuilding3();
    const floor = floorView ? building.selectedFloor : 1;
    useEvacuationStore.getState().setPlaceFireMode(false);
    setCameraMode("isometric");
    building.setExplodeFloors(false);
    building.setSelectedFloor(floor);
    building.setViewMode(floor === 1 ? "exterior" : "cutaway");
    if (document.pointerLockElement) void document.exitPointerLock();
    useWalkStore.getState().setEnabled(true, floor);
  };
  return { building, focusBuilding, focusBuilding3, focusBridge, focusShrine, resetBuilding3, focusField, focusTop, focusCampus, focusExtension, focusInterior, interiorView, floorView, startWalking, setCameraMode, requestCameraFocus };
}

type ViewMode = "exterior" | "cutaway" | "interior";
const VIEW_MODES: Array<{ id: ViewMode; label: string }> = [
  { id: "exterior", label: "ภายนอก" },
  { id: "cutaway", label: "เปิดอาคาร" },
  { id: "interior", label: "ภายในชั้น" },
];

interface ViewDockProps {
  walking: boolean;
  onWalk: () => void;
  onStopWalk: () => void;
  onAfterCommand: () => void;
}

export function ViewDock({ walking, onWalk, onStopWalk, onAfterCommand }: ViewDockProps) {
  const cmd = useSceneCommands();
  const source = useMapperStore((s) => s.modelSource.source);
  const inspectingBuilding3 = useBuilding3Store((s)=>s.inspecting);
  const buildingNumber=useBuilding3Store(s=>s.buildingNumber);
  const cutawayFloor = useBuilding3Store((s)=>s.cutawayFloor);
  const { building } = cmd;
  const after = (fn: () => void) => () => { fn(); onAfterCommand(); };
  const setMode = (mode: ViewMode) => {
    cmd.resetBuilding3();
    useWalkStore.getState().setEnabled(false);
    building.setViewMode(mode);
    if (mode === "interior") cmd.focusInterior();
    else { cmd.setCameraMode("isometric"); cmd.requestCameraFocus([-19, 15, 20]); }
    onAfterCommand();
  };
  const editorOnlyMode = building.viewMode === "structure" || building.viewMode === "single-floor";
  return (
    <div className="sw-dock" role="toolbar" aria-label="มุมมองโมเดลโรงเรียน" data-guide-target="scene" tabIndex={-1}>
      <div className="sw-dock-group" role="group" aria-label="จัดกล้อง">
        {(source === "generated" || source === "demo") && <><button type="button" className="sw-dock-btn" onClick={after(cmd.focusCampus)}><UiIcon name="campus" size={18} /><span>ทั้งแผนที่</span></button><button type="button" className="sw-dock-btn" aria-pressed={inspectingBuilding3 && buildingNumber===3} title="อาคาร 3 · 4 ชั้น ชั้นล่างเปิดโล่ง" onClick={after(cmd.focusBuilding3)}><UiIcon name="campus" size={18} /><span>อาคาร 3</span></button><button type="button" className="sw-dock-btn" aria-pressed={inspectingBuilding3 && buildingNumber===4} title="อาคาร 4 · เปิดดูได้ทั้ง 4 ชั้น" onClick={after(cmd.focusExtension)}><UiIcon name="campus" size={18} /><span>อาคาร 4</span></button><button type="button" className="sw-dock-btn" title="ทางเชื่อมอาคาร 3–4 ที่ชั้น 4" onClick={after(cmd.focusBridge)}><UiIcon name="layers" size={18} /><span>ทางเชื่อม</span></button><button type="button" className="sw-dock-btn" title="ฐานพระและศาลากลางลาน" onClick={after(cmd.focusShrine)}><UiIcon name="campus" size={18}/><span>ฐานพระ</span></button></>}
        <button type="button" className="sw-dock-btn" data-tour="building" onClick={after(cmd.focusBuilding)}><UiIcon name="campus" size={18} /><span>อาคาร</span></button>
        <button type="button" className="sw-dock-btn" onClick={after(cmd.focusField)}><UiIcon name="field" size={18} /><span>สนาม</span></button>
        <button type="button" className="sw-dock-btn" onClick={after(cmd.focusTop)}><UiIcon name="top" size={18} /><span>ด้านบน</span></button>
      </div>
      {inspectingBuilding3 && <label className="sw-dock-select"><UiIcon name="layers" size={18}/><select aria-label={"เปิดดูชั้นอาคาร "+buildingNumber} value={cutawayFloor} onChange={(e)=>{ const floor=Number(e.target.value);useBuilding3Store.getState().setCutawayFloor(floor);cmd.requestCameraFocus([buildingNumber===3?-112:-20,floor ? BLOCK_LEVELS[floor-1]+1.2 : 8,-43]); }}><option value="0">อาคาร {buildingNumber} · ทั้งอาคาร</option>{[1,2,3,4].map((floor)=><option key={floor} value={floor}>{floor===1 ? "ชั้น 1 · ใต้ถุนโล่ง" : `เปิดถึงชั้น ${floor}`}</option>)}</select></label>}
      <i className="sw-dock-rule" aria-hidden="true" />
      <div className="pi-seg is-on-dark sw-dock-modes" role="radiogroup" aria-label="รูปแบบการแสดงอาคาร">
        {VIEW_MODES.map((mode) => (
          <button key={mode.id} type="button" role="radio" aria-checked={building.viewMode === mode.id} className={building.viewMode === mode.id ? "is-active" : ""} onClick={() => setMode(mode.id)}>{mode.label}</button>
        ))}
        {editorOnlyMode && <span className="sw-dock-note">มุมมองจากตัวแก้ไข</span>}
      </div>
      {cmd.floorView && (
        <label className="sw-dock-select">
          <UiIcon name="layers" size={18} />
          <span className="pi-sr-only">เลือกชั้นที่ต้องการแสดง</span>
          <select aria-label="เลือกชั้นที่ต้องการแสดง" value={building.selectedFloor} onChange={(event) => { const floor = Number(event.target.value); building.setSelectedFloor(floor); if (cmd.interiorView) cmd.focusInterior(floor); }}>
            {Array.from({ length: 9 }, (_, i) => <option value={i + 1} key={i}>ชั้น {i + 1}</option>)}
          </select>
        </label>
      )}
      {cmd.interiorView && (
        <label className="sw-dock-select">
          <UiIcon name="stairs" size={18} />
          <select aria-label="ดูรายละเอียดบันได" value="" onChange={(event) => {
            const zone = event.target.value as StairZone;
            if (!zone) return;
            useWalkStore.getState().setEnabled(false);
            building.setStairFocus(zone);
            const c = STAIR_ZONE_CENTERS[zone];
            cmd.setCameraMode("isometric");
            cmd.requestCameraFocus([c[0], floorBase(building.selectedFloor) + 0.4, c[2]]);
            onAfterCommand();
          }}>
            <option value="">ดูบันได</option><option value="left">บันไดซ้าย</option><option value="center">บันไดกลาง</option><option value="right">บันไดขวา</option>
          </select>
        </label>
      )}
      {cmd.interiorView && building.selectedFloor > 1 && (
        <button type="button" className="sw-dock-btn" onClick={after(() => cmd.focusInterior(building.selectedFloor, true))}><UiIcon name="room" size={18} /><span>ห้องเรียน</span></button>
      )}
      <i className="sw-dock-rule" aria-hidden="true" />
      <button type="button" className={`sw-dock-btn is-walk${walking ? " is-active" : ""}`} aria-pressed={walking} onClick={walking ? onStopWalk : onWalk}>
        <UiIcon name="walk" size={18} /><span>{walking ? "ออกจากโหมดเดิน" : "เดินสำรวจ"}</span>
      </button>
    </div>
  );
}
