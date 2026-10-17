import { useMemo } from "react";
import { useMapperStore } from "../store";
import {
  CLASSROOM_CAPACITY,
  CLASSROOMS,
  CENTRAL_STAIR_ACCESS_LANDING_DEPTH,
  CENTRAL_STAIR_ACCESS_LANDING_WIDTH,
  CENTRAL_STAIR_FLOOR_OPENING_SIZE,
  FIELD_CENTER,
  FLOOR_COUNT,
  FLOOR_HEIGHT,
  FULL_BUILDING_CAPACITY,
  PINK_ROOM_BAYS,
  BLUE_ROOM_BAYS,
  ROOMS_PER_UPPER_FLOOR,
  STAIR_FLIGHT_WIDTH,
  STAIR_LANDING_DEPTH,
  STAIR_RISER,
  STAIR_STEPS_PER_FLIGHT,
  STAIR_TREAD,
  STAIR_ZONE_CENTERS,
  TARGET_OCCUPIED_CLASSROOMS,
  TARGET_POPULATION,
  TARGET_POPULATION_PER_FLOOR,
  TOTAL_CLASSROOMS,
} from "./building1Data";
import { buildGeneratedSemanticMap } from "../simulation/semanticGraph";
import { useBuilding1Store, type PopulationProfile } from "./building1Store";

const PAGE_LABELS: Record<number, string> = {
  1: "ผังพื้นชั้นล่าง",
  2: "ผังพื้นชั้น 2",
  3: "ผังพื้นชั้น 3",
  4: "ผังพื้นชั้น 4",
  5: "ผังพื้นชั้น 5",
  6: "ผังพื้นชั้น 6",
  7: "ผังพื้นชั้น 7",
  8: "ผังพื้นชั้น 8",
  9: "ผังพื้นชั้น 9",
  10: "ผังหลังคา",
  11: "รูปตัดบันไดและระดับชั้น",
};

function populationForProfile(profile: PopulationProfile, floor: number): number {
  if (profile === "full") return FULL_BUILDING_CAPACITY;
  if (profile === "selected-floor") return floor === 1 ? 0 : ROOMS_PER_UPPER_FLOOR * CLASSROOM_CAPACITY;
  return TARGET_POPULATION;
}

export function BuildingTwinPanel() {
  const state = useBuilding1Store();
  const importMap = useMapperStore((mapper) => mapper.importMap);
  const addToast = useMapperStore((mapper) => mapper.addToast);
  const requestCameraFocus = useMapperStore((mapper) => mapper.requestCameraFocus);
  const selectedFloorRooms = useMemo(() => CLASSROOMS.filter((room) => room.floor === state.selectedFloor), [state.selectedFloor]);
  const selectedFloorCapacity = selectedFloorRooms.length * CLASSROOM_CAPACITY;
  const previewPopulation = populationForProfile(state.populationProfile, state.selectedFloor);

  const seedSemanticMap = () => {
    if (!window.confirm("สร้างข้อมูลอาคารเรียน 1 และสนามฟุตบอลจากโครงข่ายการจำลองปัจจุบันหรือไม่? ข้อมูลแผนที่เดิมจะถูกแทนที่")) return;
    importMap(buildGeneratedSemanticMap());
    addToast("success", "สร้างแผนที่เชิงความหมายจากโครงข่ายการจำลอง พร้อมสนามฟุตบอลและจุดรวมพล 6 โซนแล้ว");
  };

  const focusStair = (zone: "left" | "center" | "right") => {
    state.setStairFocus(zone);
    state.setViewMode("interior");
    const center = STAIR_ZONE_CENTERS[zone];
    requestCameraFocus([center[0], FLOOR_HEIGHT * (state.selectedFloor - 0.5), center[2]]);
  };

  return (
    <>
      <aside className="twin-control-panel twin-panel-formal">
        <div className="twin-panel-heading">
          <div><span>แบบจำลองดิจิทัลอาคารและพื้นที่รวมพล</span><strong>อาคารเรียน 1 + สนามฟุตบอล</strong></div>
          <div className="twin-heading-actions">
            <button type="button" onClick={() => state.setFocusMode(!state.focusMode)}>{state.focusMode ? "ออก Focus" : "Focus"}</button>
            <button type="button" onClick={() => state.setBlueprintOpen(!state.blueprintOpen)}>{state.blueprintOpen ? "ซ่อนแบบ" : "เปิดแบบ"}</button>
          </div>
        </div>

        <div className="twin-badges">
          <span>12 ห้อง / ชั้นบน</span>
          <span>40 คน / ห้อง</span>
          <span>3 บันไดหลัก</span>
          <span>8 + 8 ขั้น</span>
          <span>สนาม 6 โซน</span>
        </div>

        <div className="twin-metrics twin-metrics-grid">
          <div><span>ชั้นทั้งหมด</span><strong>{FLOOR_COUNT}</strong></div>
          <div><span>ห้องเรียน</span><strong>{TOTAL_CLASSROOMS}</strong></div>
          <div><span>Target</span><strong>{TARGET_POPULATION.toLocaleString("th-TH")}</strong></div>
          <div><span>Full capacity</span><strong>{FULL_BUILDING_CAPACITY.toLocaleString("th-TH")}</strong></div>
        </div>

        <label className="twin-label">โหมดแสดงโมเดล
          <select value={state.viewMode} onChange={(event) => state.setViewMode(event.target.value as typeof state.viewMode)}>
            <option value="exterior">Exterior · ภายนอกเต็ม</option>
            <option value="cutaway">Cutaway · ตัดชั้นบน</option>
            <option value="single-floor">Single Floor · ชั้นเดียว</option>
            <option value="interior">Interior · เปิดผนังดูภายใน</option>
            <option value="structure">Structure · โครงสร้าง</option>
          </select>
        </label>

        <label className="twin-label">ชั้นที่เลือก: {state.selectedFloor}{state.selectedFloor === 1 ? " · ชั้นล่างเปิด" : ` · ${selectedFloorRooms.length} ห้อง · ${selectedFloorCapacity} คนเต็มความจุ`}
          <input type="range" min="1" max={FLOOR_COUNT} step="1" value={state.selectedFloor} onChange={(event) => state.setSelectedFloor(Number(event.target.value))} />
        </label>
        <div className="twin-floor-buttons">
          {Array.from({ length: FLOOR_COUNT }, (_, index) => index + 1).map((floor) => (
            <button key={floor} type="button" className={state.selectedFloor === floor ? "is-active" : ""} onClick={() => state.setSelectedFloor(floor)}>{floor}</button>
          ))}
        </div>

        <section className="twin-section">
          <div className="twin-section-title"><span>STAIR CORE</span><strong>บันไดกลับตัว 180°</strong></div>
          <div className="stair-spec-grid">
            <div><span>Flight 1</span><strong>{STAIR_STEPS_PER_FLIGHT} ขั้น</strong></div>
            <div><span>Landing</span><strong>{STAIR_LANDING_DEPTH.toFixed(2)} m</strong></div>
            <div><span>Flight 2</span><strong>{STAIR_STEPS_PER_FLIGHT} ขั้น</strong></div>
            <div><span>Riser</span><strong>{STAIR_RISER.toFixed(3)} m</strong></div>
            <div><span>Tread</span><strong>{STAIR_TREAD.toFixed(2)} m</strong></div>
            <div><span>Width</span><strong>{STAIR_FLIGHT_WIDTH.toFixed(1)} m</strong></div>
            {state.stairFocus === "center" && <div><span>Access landing</span><strong>{CENTRAL_STAIR_ACCESS_LANDING_WIDTH.toFixed(2)} × {CENTRAL_STAIR_ACCESS_LANDING_DEPTH.toFixed(2)} m</strong></div>}
            {state.stairFocus === "center" && <div><span>Floor opening</span><strong>{CENTRAL_STAIR_FLOOR_OPENING_SIZE[0].toFixed(2)} × {CENTRAL_STAIR_FLOOR_OPENING_SIZE[1].toFixed(2)} m</strong></div>}
          </div>
          <div className="twin-segmented stair-focus-buttons">
            <button type="button" className={state.stairFocus === "left" ? "is-active" : ""} onClick={() => focusStair("left")}>ซ้าย</button>
            <button type="button" className={state.stairFocus === "center" ? "is-active" : ""} onClick={() => focusStair("center")}>กลาง</button>
            <button type="button" className={state.stairFocus === "right" ? "is-active" : ""} onClick={() => focusStair("right")}>ขวา</button>
          </div>
        </section>

        <div className="twin-switch-grid twin-switch-grid-formal">
          <label><input type="checkbox" checked={state.showInteriorWalls} onChange={(event) => state.setShowInteriorWalls(event.target.checked)} /> ผนังภายใน</label>
          <label><input type="checkbox" checked={state.showDoors} onChange={(event) => state.setShowDoors(event.target.checked)} /> ประตูทั้งหมด</label>
          <label><input type="checkbox" checked={state.showLiftCore} onChange={(event) => state.setShowLiftCore(event.target.checked)} /> ลิฟต์ 2 ตัว</label>
          <label><input type="checkbox" checked={state.showStairs} onChange={(event) => state.setShowStairs(event.target.checked)} /> บันได 3 โซน</label>
          <label><input type="checkbox" checked={state.showStairLabels} onChange={(event) => state.setShowStairLabels(event.target.checked)} /> ป้ายบันได</label>
          <label><input type="checkbox" checked={state.showFurniture} onChange={(event) => state.setShowFurniture(event.target.checked)} /> โต๊ะ–เก้าอี้</label>
          <label><input type="checkbox" checked={state.showFacadeWindows} onChange={(event) => state.setShowFacadeWindows(event.target.checked)} /> หน้าต่าง</label>
          <label><input type="checkbox" checked={state.showCorridorLights} onChange={(event) => state.setShowCorridorLights(event.target.checked)} /> ไฟทางเดิน</label>
          <label><input type="checkbox" checked={state.showRoof} onChange={(event) => state.setShowRoof(event.target.checked)} /> หลังคา–คิ้ว</label>
          <label><input type="checkbox" checked={state.explodeFloors} onChange={(event) => state.setExplodeFloors(event.target.checked)} /> Exploded Floors</label>
          <label><input type="checkbox" checked={state.showRoomVolumes} onChange={(event) => state.setShowRoomVolumes(event.target.checked)} /> Room Volumes</label>
          <label><input type="checkbox" checked={state.showRoomLabels} onChange={(event) => state.setShowRoomLabels(event.target.checked)} /> ชื่อห้อง</label>
        </div>

        <section className="twin-section">
          <div className="twin-section-title"><span>OCCUPANCY</span><strong>จำลองนักเรียนจริงในห้อง</strong></div>
          <label className="twin-switch-line"><input type="checkbox" checked={state.showPopulation} onChange={(event) => state.setShowPopulation(event.target.checked)} /> แสดงประชากร</label>
          {state.showPopulation && (
            <>
              <label className="twin-label">Scenario
                <select value={state.populationProfile} onChange={(event) => state.setPopulationProfile(event.target.value as typeof state.populationProfile)}>
                  <option value="target3000">Target 3,000 · กระจายครบชั้น 2–9</option>
                  <option value="full">Full Capacity · 96 ห้อง × 40</option>
                  <option value="selected-floor">Selected Floor · 12 ห้อง × 40</option>
                </select>
              </label>
              <div className="twin-segmented">
                <button type="button" className={state.populationMode === "rooms" ? "is-active" : ""} onClick={() => state.setPopulationMode("rooms")}>อยู่ในห้อง</button>
                <button type="button" className={state.populationMode === "assembly" ? "is-active" : ""} onClick={() => state.setPopulationMode("assembly")}>จุดรวมพล</button>
              </div>
              <div className="population-summary"><span>จำนวนที่กำลังแสดง</span><strong>{previewPopulation.toLocaleString("th-TH")} คน</strong></div>
            </>
          )}
        </section>

        <section className="twin-section field-control-section">
          <div className="twin-section-title"><span>FOOTBALL FIELD</span><strong>สนามฟุตบอล + จุดรวมพล 3,000 คน</strong></div>
          <label className="twin-switch-line"><input type="checkbox" checked={state.showSportsField} onChange={(event) => state.setShowSportsField(event.target.checked)} /> แสดงสนามฟุตบอล</label>
          {state.showSportsField && (
            <>
              <div className="field-metric-grid">
                <div><span>Running track</span><strong>6 เลน</strong></div>
                <div><span>Assembly zones</span><strong>6 × 500</strong></div>
                <div><span>Capacity</span><strong>3,000 คน</strong></div>
                <div><span>Destination</span><strong>Safe Zone</strong></div>
              </div>
              <div className="twin-switch-grid field-switch-grid">
                <label><input type="checkbox" checked={state.showFootballMarkings} onChange={(event) => state.setShowFootballMarkings(event.target.checked)} /> เส้นสนามฟุตบอล</label>
                <label><input type="checkbox" checked={state.showTrackLanes} onChange={(event) => state.setShowTrackLanes(event.target.checked)} /> เส้นลู่วิ่ง</label>
                <label><input type="checkbox" checked={state.showGoals} onChange={(event) => state.setShowGoals(event.target.checked)} /> ประตู + ตาข่าย</label>
                <label><input type="checkbox" checked={state.showAssemblyZones} onChange={(event) => state.setShowAssemblyZones(event.target.checked)} /> Zone A–F</label>
                <label><input type="checkbox" checked={state.showFieldLights} onChange={(event) => state.setShowFieldLights(event.target.checked)} /> เสาไฟสนาม</label>
                <label><input type="checkbox" checked={state.showFieldLabels} onChange={(event) => state.setShowFieldLabels(event.target.checked)} /> ป้ายสนาม</label>
                <label><input type="checkbox" checked={state.showEvacuationRoute} onChange={(event) => state.setShowEvacuationRoute(event.target.checked)} /> แนวอพยพจากตึก</label>
              </div>
              <button type="button" className="field-focus-button" onClick={() => requestCameraFocus(FIELD_CENTER)}>โฟกัสสนามฟุตบอล</button>
            </>
          )}
        </section>

        <div className="twin-actions twin-actions-grid">
          <button type="button" onClick={() => requestCameraFocus([-24, 16, 22])}>ภาพรวมตึก 1</button>
          <button type="button" onClick={() => requestCameraFocus([-20, FLOOR_HEIGHT * (state.selectedFloor - 0.5), 18])}>โฟกัสชั้น {state.selectedFloor}</button>
          {state.showSportsField && <button type="button" onClick={() => requestCameraFocus(FIELD_CENTER)}>โฟกัสสนาม</button>}
          <button type="button" className="primary" onClick={seedSemanticMap}>สร้างแผนที่เชิงความหมาย</button>
        </div>

        <div className="twin-caveat twin-caveat-note">
          <strong>ข้อกำหนดของแบบจำลอง</strong>
          <span>ปีกซ้าย {PINK_ROOM_BAYS} ห้อง + ปีกขวา {BLUE_ROOM_BAYS} ห้องต่อชั้นบน = {ROOMS_PER_UPPER_FLOOR} ห้อง/ชั้น · Scenario 3,000 คนกระจายครบ {TARGET_OCCUPIED_CLASSROOMS} ห้อง · ชั้นละ {TARGET_POPULATION_PER_FLOOR} คน</span>
        </div>
      </aside>

      {state.blueprintOpen && (
        <aside className="blueprint-dock" style={{ opacity: state.blueprintOpacity }}>
          <header>
            <div><span>แบบอ้างอิง</span><strong>{PAGE_LABELS[state.blueprintPage]}</strong></div>
            <button type="button" onClick={() => state.setBlueprintOpen(false)}>×</button>
          </header>
          <img src={`/floorplans/floor-${String(state.blueprintPage).padStart(2, "0")}.jpg`} alt={PAGE_LABELS[state.blueprintPage]} />
          <footer>
            <select value={state.blueprintPage} onChange={(event) => state.setBlueprintPage(Number(event.target.value))}>
              {Object.entries(PAGE_LABELS).map(([page, label]) => <option key={page} value={page}>{label}</option>)}
            </select>
            <label>ความทึบ <input type="range" min="0.35" max="1" step="0.05" value={state.blueprintOpacity} onChange={(event) => state.setBlueprintOpacity(Number(event.target.value))} /></label>
          </footer>
        </aside>
      )}
    </>
  );
}
