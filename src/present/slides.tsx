/**
 * The presentation's slides. Each slide sets up the 3D scene (view, camera, annotations) on enter
 * and renders its panel. Every number shown is computed live by the simulator's own code
 * (routeExample) or read from saved runs of the real runtime (public/presentation/results.json,
 * with the run's date, seed and conditions printed next to it).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { computeRouteExample, fmt, type ExampleResult, type RouteCalc } from "../explain/routeExample";
import { createEvacuationGraph } from "../simulation/graph";
import { useBuilding1Store } from "../building1/building1Store";
import { frame, moveCamera } from "../camera/cameraDirector";
import { useStoryOverlay, type StoryLine, type StoryMarker } from "./StoryOverlay3D";
import { createReadonlySource } from "../mobile/client";
import { MobileApp } from "../mobile/MobileApp";
import { PhoneFrame } from "../mobile-host/PhoneFrame";
import "../mobile/mobile.css";
import "../mobile-host/host.css";
import { PHONE_DEMO_FALLBACK, runPhoneDemo, type PhoneDemo } from "./demoPhone";
import { startAutoEditorDemo } from "../components/AutoEditorDemo";
import { PROJECT_NAME_TH } from "../projectIdentity";
import { usePresentStore } from "./presentStore";
import { sound } from "../audio/soundManager";
import type { Vec3 } from "../simulation/types";

// ---------------------------------------------------------------- shared data
let graphCache: ReturnType<typeof createEvacuationGraph> | null = null;
const graph = () => (graphCache ??= createEvacuationGraph());
const nodePos = (id: string): Vec3 => [...(graph().nodes.find((node) => node.id === id)?.position ?? [0, 0, 0])] as Vec3;
const nodeName = (id: string) => graph().nodes.find((node) => node.id === id)?.name ?? id;
let exampleCache: ExampleResult | null = null;
export const example = () => (exampleCache ??= computeRouteExample());

export interface SavedRun {
  id: string; title: string; compare: boolean;
  conditions: { population: number; preset: string; decisionMode: string; seed: number; fireSpreadEnabled: boolean; closedEdges: string[]; timeLimit: number };
  result: { simulatedSeconds: number; completed: boolean; arrived: number; incapacitated: number; stillInside: number; byStatus: Record<string, number>; insideReasons: Record<string, number>;
    firstArrival: number | null; p50Arrival: number | null; p90Arrival: number | null; finalArrival: number | null; rerouteCount: number;
    bottlenecks: Array<{ edgeId: string; name: string; queueSeconds: number; capacityPerSecond: number; utilization: number }>; maxQueue: number; dangerousCrowdSeconds: number };
  checks: { headCountMatches: boolean; topologyViolations: number; collisionCorrections: number; walkedIntoFlame: number; overtakenByFlame: number; maxStepMetres: number };
  series: Array<{ t: number; arrived: number; queueing: number; inside: number; top: { name: string; queueSeconds: number } | null }>;
}
export interface SavedResults { generatedAt: string; command: string; codeHash: string; note: string; runs: SavedRun[] }
let resultsPromise: Promise<SavedResults | null> | null = null;
export function loadResults() {
  resultsPromise ??= fetch("/presentation/results.json", { cache: "no-cache" }).then((response) => (response.ok ? response.json() as Promise<SavedResults> : null)).catch(() => null);
  return resultsPromise;
}
function useResults() {
  const [data, setData] = useState<SavedResults | null | undefined>(undefined);
  useEffect(() => { let alive = true; void loadResults().then((value) => { if (alive) setData(value); }); return () => { alive = false; }; }, []);
  return data;
}
const thDate = (iso: string) => new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
const secs = (value: number | null | undefined) => (value == null ? "—" : `${fmt(value, 0)} วินาที`);

function RunSource({ data, runs }: { data: SavedResults; runs: SavedRun[] }) {
  const c = runs[0]?.conditions;
  return (
    <p className="pz-source">
      ผลจากรอบที่บันทึก {thDate(data.generatedAt)} · โค้ด {data.codeHash} · {c ? `${c.population.toLocaleString("th-TH")} คน · seed ${c.seed}` : ""} · รันซ้ำได้: <code>{data.command}</code>
    </p>
  );
}

// ---------------------------------------------------------------- scene helpers
export interface SceneApi { alive(): boolean }
async function view(mode: "exterior" | "single-floor", floor?: number) {
  const b1 = useBuilding1Store.getState();
  b1.setExplodeFloors(false);
  if (floor) b1.setSelectedFloor(floor);
  b1.setViewMode(mode);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function look(points: Vec3[], options: { preferTop?: boolean; duration?: number } = {}) {
  try { const pose = frame(points, { preferTop: options.preferTop }); if (pose && !pose.reused) await moveCamera(pose, options.duration ?? 1600); } catch { /* the slide still shows its text */ }
}
const overlay = (lines: StoryLine[] = [], markers: StoryMarker[] = []) => useStoryOverlay.getState().set({ lines, markers, boxes: [] });
const BUILDING1: Vec3[] = [[-58, 0, -12], [12, 0, -12], [12, 0, 58], [-58, 34, 12]];
const CAMPUS: Vec3[] = [[-150, 0, -60], [60, 0, -60], [60, 0, 180], [-150, 0, 180]];
const routePoints = (calc: RouteCalc) => calc.nodeIds.map(nodePos);
const floorPart = (points: Vec3[], y: number) => points.filter((p) => Math.abs(p[1] - y) < 1.5);

// ---------------------------------------------------------------- slides
export interface Slide {
  id: string; group: "main" | "extra"; kicker: string; title: string;
  /** Read aloud when narration is on; also the caption under the slide. */
  narration: string;
  /** Seconds before auto-advance (when “เล่นอัตโนมัติ” is on). */
  seconds: number;
  enter(api: SceneApi): Promise<void>;
  Panel: (props: { onExit?: () => void }) => ReactNode;
  wide?: boolean;
}

function TitlePanel() {
  const g = graph();
  return (
    <div className="pz-title">
      <img src="/assets/skr-school-emblem.png" alt="" className="pz-emblem" />
      <h1>{PROJECT_NAME_TH}</h1>
      <p className="pz-lead">แบบจำลองดิจิทัล 3 มิติของอาคาร 1, 3 และ 4 โรงเรียนสวนกุหลาบวิทยาลัย รังสิต ใช้คำนวณเส้นทางอพยพ เปรียบเทียบแนวทาง และหาจุดคอขวดก่อนซ้อมจริง</p>
      <ul className="pz-stats">
        <li><b>{g.nodes.length.toLocaleString("th-TH")}</b><span>จุด (Node)</span></li>
        <li><b>{g.edges.length.toLocaleString("th-TH")}</b><span>เส้นทาง (Edge)</span></li>
        <li><b>3,000</b><span>นักเรียนในแบบจำลอง</span></li>
        <li><b>{g.nodes.filter((node) => node.type === "assembly").length}</b><span>จุดรวมพล</span></li>
      </ul>
    </div>
  );
}

/** The busiest bottleneck of the whole run (the end-of-run list is empty once everyone has left). */
function peakBottleneck(run: SavedRun) {
  let best: { name: string; queueSeconds: number } | null = null;
  for (const point of run.series) if (point.top && (!best || point.top.queueSeconds > best.queueSeconds)) best = point.top;
  return best ?? (run.result.bottlenecks[0] ? { name: run.result.bottlenecks[0].name, queueSeconds: run.result.bottlenecks[0].queueSeconds } : null);
}

function QueueChart({ run }: { run: SavedRun }) {
  const series = run.series;
  const max = Math.max(1, ...series.map((point) => point.queueing));
  const end = Math.max(1, series[series.length - 1]?.t ?? 1);
  const path = series.map((point, index) => `${index ? "L" : "M"}${(point.t / end) * 100},${40 - (point.queueing / max) * 38}`).join(" ");
  const peak = series.reduce((best, point) => (point.queueing > best.queueing ? point : best), series[0]);
  return (
    <figure className="pz-chart">
      <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img" aria-label={`จำนวนคนที่รอคิวตามเวลา สูงสุด ${peak?.queueing ?? 0} คน ที่วินาที ${peak?.t ?? 0}`}>
        <path d={`${path} L100,40 L0,40 Z`} className="pz-chart-area" />
        <path d={path} className="pz-chart-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption>คนที่ “รอคิว” ณ แต่ละเวลา (สูงสุด <b>{peak?.queueing.toLocaleString("th-TH")}</b> คน ที่ {peak?.t} วินาที) · คอขวดที่รอนานสุด: <b>{peakBottleneck(run)?.name ?? "—"}</b> (รอสะสมสูงสุด {fmt(peakBottleneck(run)?.queueSeconds ?? 0, 0)} วินาที)</figcaption>
    </figure>
  );
}

function BottleneckPanel() {
  const data = useResults();
  const run = data?.runs.find((item) => item.id === "no-fire");
  const r = example();
  return (
    <>
      <p className="pz-lead">ประตูและบันไดระบายคนได้จำกัด — บันไดกลางรับได้ <b>{fmt(r.stair.capacity, 1)} คน/วินาที</b> ถ้าคนมาถึงเร็วกว่านั้น <b>คิวจะยาวขึ้นทุกวินาที</b></p>
      <div className="pz-formula">คิวที่เพิ่ม ≈ (อัตราคนมาถึง − ความจุทาง) × เวลา</div>
      {run ? <><QueueChart run={run} /><RunSource data={data!} runs={[run]} /></>
        : <p className="pz-note">{data === undefined ? "กำลังโหลดผลที่บันทึก…" : "ยังไม่มีไฟล์ผลที่บันทึก (รัน npm run presentation:results)"}</p>}
    </>
  );
}

/** Consecutive steps of the same kind merged: Σd, and cost = Σ(0.28·d + d/v) — still checkable by hand. */
function groupRows(calc: RouteCalc) {
  const groups: Array<{ key: string; from: string; to: string; kind: string; steps: number; d: number; distanceTerm: number; travel: number; cost: number; edgeIds: string[] }> = [];
  for (const row of calc.rows) {
    const last = groups[groups.length - 1];
    if (last && last.kind === row.kind) { last.to = row.to; last.steps += 1; last.d += row.d; last.distanceTerm += row.distanceTerm; last.travel += row.travel; last.cost += row.cost; last.edgeIds.push(row.edgeId); }
    else groups.push({ key: row.edgeId, from: row.from, to: row.to, kind: row.kind, steps: 1, d: row.d, distanceTerm: row.distanceTerm, travel: row.travel, cost: row.cost, edgeIds: [row.edgeId] });
  }
  return groups;
}
const KIND_TH: Record<string, string> = { junction: "ทางเข้าบันได", corridor: "ทางเดิน", stair: "บันได", exit: "ชั้น 1 → ทางออก", outdoor: "ไปประตูรั้ว", assembly: "ลานรวมพล", door: "ประตูห้อง", room: "ประตูห้อง" };

function RouteSummary({ calc, highlight }: { calc: RouteCalc; highlight?: string }) {
  return (
    <table className="pz-table">
      <caption>{calc.label} · {fmt(calc.distance, 1)} ม.</caption>
      <thead><tr><th>ช่วง</th><th>Σd (ม.)</th><th>0.28·Σd</th><th>Σ d/v</th><th>ต้นทุน</th></tr></thead>
      <tbody>
        {groupRows(calc).map((group) => (
          <tr key={group.key} className={highlight && group.edgeIds.includes(highlight) ? "is-key" : undefined}>
            <td>{KIND_TH[group.kind] ?? group.kind}{group.steps > 1 ? ` (${group.steps} ช่วง)` : ""}</td><td>{fmt(group.d)}</td><td>{fmt(group.distanceTerm)}</td><td>{fmt(group.travel)}</td><td>{fmt(group.cost, 2)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td colSpan={4}>รวม (คำนวณมือ)</td><td>{fmt(calc.total, 3)}</td></tr><tr><td colSpan={4}>โปรแกรม</td><td>{fmt(calc.programTotal, 3)}</td></tr></tfoot>
    </table>
  );
}

function RouteTable({ calc, highlight }: { calc: RouteCalc; highlight?: string }) {
  return (
    <table className="pz-table">
      <caption>{calc.label} · {fmt(calc.distance, 1)} ม.</caption>
      <thead><tr><th>ช่วง</th><th>d (ม.)</th><th>v (ม./วิ)</th><th>0.28·d</th><th>d/v</th><th>ต้นทุน</th></tr></thead>
      <tbody>
        {calc.rows.map((row) => (
          <tr key={row.edgeId} className={row.edgeId === highlight ? "is-key" : undefined}>
            <td>{row.from} → {row.to}</td><td>{fmt(row.d)}</td><td>{fmt(row.v, 3)}</td><td>{fmt(row.distanceTerm)}</td><td>{fmt(row.travel)}</td><td>{fmt(row.cost, 3)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td colSpan={5}>รวม (คำนวณมือ)</td><td>{fmt(calc.total, 3)}</td></tr><tr><td colSpan={5}>โปรแกรม (findPath)</td><td>{fmt(calc.programTotal, 3)}</td></tr></tfoot>
    </table>
  );
}

function MathPanel() {
  const r = example();
  const match = r.maxStepError < 1e-9 && r.handPick === r.programPick;
  return (
    <>
      <div className="pz-formula">ต้นทุนช่วง = 0.28·d + (d/v + L/c)·1 + 20·L/(w·max(4,d)) + 4200·ไฟ + 2436·ความร้อน + 1250·ควัน</div>
      <p className="pz-small">d ระยะทาง (ม.) · v = 1.32 ม./วิ × ตัวคูณทาง · L คนที่วางแผนใช้ทางนั้นแล้ว · c ความจุ (คน/วิ) · w ความกว้าง (ม.) — ค่าแนวทาง “สมดุล” จากโค้ดจริง · ไม่มีไฟและคิว จึงเหลือ 0.28·d + d/v · ตารางรายช่วงเต็มอยู่ในฉากเสริม</p>
      <div className="pz-two">
        <RouteSummary calc={r.routeA} highlight="edge-stair-center-2-1" />
        <RouteSummary calc={r.routeB} highlight="edge-stair-left-2-1" />
      </div>
      <p className={`pz-verdict${match ? " is-ok" : " is-bad"}`} role="status">
        {match ? "✓ " : "✗ "}คำนวณมือเลือก <b>{r.handPick === "A" ? r.routeA.label : r.routeB.label}</b> ({fmt(r.routeA.total, 3)} &lt; {fmt(r.routeB.total, 3)}) · โปรแกรมเลือก <b>{r.programPick === "A" ? r.routeA.label : r.routeB.label}</b> · {r.maxStepError < 1e-9 ? "ทุกช่วงตรงกับโปรแกรม (ต่างน้อยกว่า 10⁻⁹)" : `ต่างกันมากสุด ${r.maxStepError.toExponential(1)}`}
      </p>
      <p className="pz-lead">คอขวด: ถ้ามีคนรอที่บันไดกลางแล้ว L คน ต้นทุนเพิ่ม L × (1/{fmt(r.stair.capacity, 1)} + 20/({fmt(r.stair.width, 1)}×{fmt(r.stair.length, 2)})) = <b>{fmt(r.perPerson, 3)} ต่อคน</b> → เปลี่ยนไปบันไดซ้ายเมื่อ L ≥ ⌊{fmt(r.routeB.total - r.routeA.total, 2)} ÷ {fmt(r.perPerson, 3)}⌋ + 1 = <b>{r.breakEvenHand} คน</b> · โปรแกรมเปลี่ยนที่ <b>{r.breakEvenProgram ?? "—"} คน</b> {r.breakEvenHand === r.breakEvenProgram ? "✓ ตรงกัน" : "✗"}</p>
    </>
  );
}

function FirePanel() {
  const r = example();
  return (
    <>
      <p className="pz-lead">ไฟที่ชานบันไดกลางชั้น 2 ทำให้ทาง A <b className="pz-danger">ผ่านไม่ได้</b> (ต้นทุน = ∞) — ระบบไม่ “ฝ่าไฟ” แต่หาทางที่เหลือที่ต้นทุนต่ำสุด</p>
      <ul className="pz-list">
        <li>ทางใหม่: {r.fire.route ? `${r.fire.route.nodeIds.length - 1} ช่วง · ${fmt(r.fire.route.distance, 1)} ม. · ผ่าน${r.fire.route.nodeIds.some((id) => id.includes("stair-left")) ? "บันไดซ้าย" : r.fire.route.nodeIds.some((id) => id.includes("stair-right")) ? "บันไดขวา" : "ทางอื่น"}` : "ไม่มี"}</li>
        <li>ต้นทุนรวม {r.fire.route ? fmt(r.fire.route.programTotal, 2) : "—"} (เดิม {fmt(r.routeA.programTotal, 2)})</li>
        <li>{r.fire.avoidsCentre ? "✓ ไม่ใช้บันไดกลางที่มีไฟ" : "✗ ยังใช้บันไดกลาง"}</li>
      </ul>
      <p className="pz-small">คนในแบบจำลองรู้ว่ามีไฟเมื่อเห็น ได้กลิ่นควัน หรือได้รับแจ้ง — จึงเปลี่ยนทางในเวลาต่างกัน</p>
    </>
  );
}

function NoExitPanel() {
  const r = example();
  const data = useResults();
  const run = data?.runs.find((item) => item.id === "all-exits-closed");
  return (
    <>
      <p className="pz-lead">ถ้าทางออกชั้นล่าง <b className="pz-danger">ถูกปิดทั้งหมด</b> ระบบ <b>ไม่สร้างทางที่ไม่มีจริง</b> — ตอบว่าไม่มีเส้นทาง {r.allExitsClosed.route === null ? "✓" : "✗"}</p>
      {run && <>
        <ul className="pz-list">
          <li>ถึงจุดรวมพล <b>{run.result.arrived.toLocaleString("th-TH")}</b> / {run.conditions.population.toLocaleString("th-TH")} คน (ผลจริงของสถานการณ์นี้)</li>
          <li>ยังอยู่ในอาคาร <b>{run.result.stillInside.toLocaleString("th-TH")}</b> คน — แสดงเป็น “ผู้ติดค้าง” พร้อมเหตุผล ไม่ซ่อนตัวเลข</li>
          <li>ยอดคนตรวจครบ: {run.checks.headCountMatches ? "✓ เท่ากับจำนวนเริ่มต้น" : "✗"}</li>
        </ul>
        <RunSource data={data!} runs={[run]} />
      </>}
    </>
  );
}

function Bars({ items, unit, better }: { items: Array<{ label: string; value: number | null }>; unit: string; better: "low" | "high" }) {
  const max = Math.max(1, ...items.map((item) => item.value ?? 0));
  const best = better === "low" ? Math.min(...items.map((item) => item.value ?? Infinity)) : Math.max(...items.map((item) => item.value ?? -Infinity));
  return (
    <ul className="pz-bars">
      {items.map((item) => (
        <li key={item.label} className={item.value === best ? "is-best" : undefined}>
          <span>{item.label}</span><i style={{ width: `${((item.value ?? 0) / max) * 100}%` }} /><b>{item.value == null ? "—" : `${fmt(item.value, 0)} ${unit}`}</b>
        </li>
      ))}
    </ul>
  );
}

/** Said from the numbers, never assumed: faster, about the same, or slower. */
function Verdict({ a, b }: { a: SavedRun; b: SavedRun }) {
  const ta = a.result.finalArrival ?? a.result.simulatedSeconds, tb = b.result.finalArrival ?? b.result.simulatedSeconds;
  const change = (tb - ta) / ta;
  const text = Math.abs(change) < 0.02 ? `ใกล้เคียงกัน (ต่าง ${fmt(Math.abs(change) * 100, 1)}%) — ทางที่เหลือจำกัดจนการวางแผนช่วยได้น้อย`
    : change < 0 ? `วางแผนรวมออกครบเร็วขึ้น ${fmt(-change * 100, 0)}% (${fmt(ta - tb, 0)} วินาที)` : `วางแผนรวมช้ากว่า ${fmt(change * 100, 0)}% ในสถานการณ์นี้`;
  return <p className={`pz-verdict ${change < -0.02 ? "is-ok" : "is-neutral"}`}>{text}</p>;
}

function ComparePanel() {
  const data = useResults();
  if (!data) return <p className="pz-note">{data === undefined ? "กำลังโหลดผลที่บันทึก…" : "ยังไม่มีไฟล์ผลที่บันทึก (รัน npm run presentation:results)"}</p>;
  const by = (id: string) => data.runs.find((run) => run.id === id);
  const pairs = [
    { title: "ไม่มีไฟ", a: by("no-fire"), b: by("coordinated") },
    { title: "ไฟปิดบันไดกลาง ชั้น 5", a: by("fire-blocks-stair"), b: by("fire-blocks-stair-coordinated") },
  ].filter((pair) => pair.a && pair.b) as Array<{ title: string; a: SavedRun; b: SavedRun }>;
  return (
    <>
      <p className="pz-lead">ฉาก คน และ seed เดียวกัน เปลี่ยนเฉพาะวิธีเลือกทาง: <b>แต่ละคนเลือกเอง</b> (อ้างอิง) กับ <b>ระบบวางแผนรวมด้วยต้นทุนและความจุ</b></p>
      <div className="pz-two">
        {pairs.map(({ title, a, b }) => (
          <section key={title} className="pz-compare">
            <h3>{title}</h3>
            <Bars unit="วิ" better="low" items={[{ label: "เลือกเอง · ออกครบ", value: a.result.finalArrival ?? a.result.simulatedSeconds }, { label: "วางแผนรวม · ออกครบ", value: b.result.finalArrival ?? b.result.simulatedSeconds }]} />
            <Bars unit="วิ" better="low" items={[{ label: "เลือกเอง · 90%", value: a.result.p90Arrival }, { label: "วางแผนรวม · 90%", value: b.result.p90Arrival }]} />
            <Verdict a={a} b={b} />
            <p className="pz-small">ถึงจุดรวมพล {a.result.arrived.toLocaleString("th-TH")} → {b.result.arrived.toLocaleString("th-TH")} คน · คอขวดหลัก “{peakBottleneck(a)?.name ?? "—"}” รอสะสมสูงสุด {fmt(peakBottleneck(a)?.queueSeconds ?? 0, 0)} → “{peakBottleneck(b)?.name ?? "—"}” {fmt(peakBottleneck(b)?.queueSeconds ?? 0, 0)} วิ</p>
          </section>
        ))}
      </div>
      <RunSource data={data} runs={pairs.map((pair) => pair.a)} />
      <p className="pz-small">ผลนี้เป็นของรอบตัวอย่างที่ระบุเท่านั้น — ข้อสรุปทั่วไปต้องดูหลายสถานการณ์ (สไลด์เสริม “ผลทุกสถานการณ์”)</p>
    </>
  );
}

function PhonePanel() {
  const [demo, setDemo] = useState<PhoneDemo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, made: PhoneDemo | null = null;
    runPhoneDemo().then((value) => {
      made = value;
      if (!alive) { value.dispose(); return; }
      setDemo(value);
      const route = (ids: string[] | undefined) => (ids ?? []).map(nodePos);
      overlay([
        { id: "before", points: route(value.before.advice?.nodeIds), color: "#9fb3c8", width: 4, dashed: true, label: "ก่อน", labelAt: 0.3 },
        { id: "after", points: route(value.after.advice?.nodeIds), color: "#4fd6a0", width: 7, revealMs: 2400, label: "หลังเปลี่ยนเส้นทาง" },
      ], [{ id: "me", position: nodePos("sim-corr-pink-f2-b3"), kind: "person", label: "ผู้ใช้มือถือ" }, { id: "fire", position: nodePos("sim-stair-center-f2"), kind: "fire", label: "บันไดกลางปิด" }]);
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; made?.dispose(); };
  }, []);
  const before = useMemo(() => (demo ? createReadonlySource(demo.before, demo.map, Date.now()) : null), [demo]);
  const after = useMemo(() => (demo ? createReadonlySource(demo.after, demo.map, Date.now()) : null), [demo]);
  return (
    <>
      <p className="pz-badge-demo">การสาธิต · ข้อมูลฝึกซ้อมในเบราว์เซอร์นี้ ไม่ได้ส่งไปเซิร์ฟเวอร์</p>
      {failed || !demo ? (
        <div className="pz-two">
          {failed ? <>
            <section className="pz-fallback"><h3>ก่อน (ข้อมูลสำรอง)</h3><ol>{PHONE_DEMO_FALLBACK.before.map((line) => <li key={line}>{line}</li>)}</ol></section>
            <section className="pz-fallback"><h3>หลัง (ข้อมูลสำรอง)</h3><ol>{PHONE_DEMO_FALLBACK.after.map((line) => <li key={line}>{line}</li>)}</ol></section>
          </> : <p className="pz-note">กำลังเตรียมการสาธิต…</p>}
        </div>
      ) : (
        <div className="pz-phones">
          <figure><figcaption>ก่อน: แนะนำบันไดกลาง</figcaption><div className="pz-phone"><PhoneFrame size="standard" zoom="fit" label="ก่อนเปลี่ยนเส้นทาง (การสาธิต)"><MobileApp source={before!} /></PhoneFrame></div></figure>
          <figure><figcaption>หลัง: บันไดกลางปิด → เปลี่ยนทาง</figcaption><div className="pz-phone"><PhoneFrame size="standard" zoom="fit" label="หลังเปลี่ยนเส้นทาง (การสาธิต)"><MobileApp source={after!} /></PhoneFrame></div></figure>
        </div>
      )}
    </>
  );
}

function playEditorDemo() {
  usePresentStore.getState().set({ suspended: true, autoplay: false });
  useStoryOverlay.getState().clear();
  sound.stopSpeech();
  startAutoEditorDemo("presentation");
}

function EditorPanel() {
  return (
    <>
      <p className="pz-lead">ผังที่ระบบใช้แก้ได้ในตัวแก้ไข: ย้ายประตู/จุดทางเดิน เพิ่ม Node และ Edge ปิดหรือลบทาง ทุกการแก้ผ่านการตรวจ <b>พื้นรองรับและผนังจริงในโมเดล 3 มิติ</b> ก่อนนำไปจำลอง</p>
      <ol className="pz-list">
        <li>แก้ในหน้า “แก้ไขแบบจำลอง” — ปุ่มสถานะบอกทันทีว่า “จำลองได้” หรือติดอะไร</li>
        <li>กลับหน้าจำลอง → การ์ดความพร้อมแสดงสิ่งที่นำไปใช้</li>
        <li>ส่งออก .skrproject (Node / Edge + Calibration) เพื่อย้ายไปเครื่องอื่น</li>
      </ol>
      <button type="button" className="pz-action" onClick={playEditorDemo}>▶ ชมการสาธิตอัตโนมัติ (จัดกล้องเอง)</button>
      <p className="pz-small">การสาธิตทำบนสำเนาชั่วคราว ออกแล้วผังเดิมกลับมาครบ และกลับมาที่สไลด์นี้</p>
    </>
  );
}

function ClosingPanel({ onExit }: { onExit?: () => void } = {}) {
  return (
    <div className="pz-two">
      <section><h3>สิ่งที่ระบบทำได้</h3><ul className="pz-list">
        <li>จำลองนักเรียน 3,000 คนเดินตามโครงข่ายจริงของอาคาร</li>
        <li>เลือกทางด้วยต้นทุนที่ตรวจด้วยมือได้ และหลบไฟ/ควัน/คิว</li>
        <li>หาคอขวดและเปรียบเทียบแนวทางด้วย seed เดียวกัน</li>
        <li>ต้นแบบมือถือนำทาง และตัวแก้ไขผังที่ตรวจผนังจริง</li>
      </ul></section>
      <section><h3>ข้อจำกัด</h3><ul className="pz-list is-limits">
        <li>เป็นเครื่องมือเพื่อการศึกษาและฝึกซ้อม ไม่ใช่ระบบแจ้งเหตุจริงหรือการรับรองความปลอดภัย</li>
        <li>ไฟ ควัน ความร้อนเป็นแบบจำลองอย่างง่าย ใช้เปรียบเทียบ ไม่ใช่ทำนายเหตุจริง</li>
        <li>ผังจากแบบจำลอง ยังไม่ได้สำรวจหน้างานทุกจุด ต้องตรวจกับการซ้อมจริงเสมอ</li>
      </ul>
      {onExit && <button type="button" className="pz-action" onClick={onExit}>กลับไปทดลองเอง →</button>}</section>
    </div>
  );
}

function MatrixPanel() {
  const data = useResults();
  if (!data) return <p className="pz-note">{data === undefined ? "กำลังโหลด…" : "ยังไม่มีไฟล์ผลที่บันทึก"}</p>;
  return (
    <>
      <table className="pz-table is-matrix">
        <thead><tr><th>สถานการณ์</th><th>คน</th><th>ถึงจุดรวมพล</th><th>หมดสติ</th><th>ยังอยู่ใน</th><th>90%</th><th>ออกครบ</th><th>ยอดคน</th><th>ผนัง/วาร์ป</th></tr></thead>
        <tbody>{data.runs.map((run) => (
          <tr key={run.id}>
            <td>{run.title}</td><td>{run.conditions.population.toLocaleString("th-TH")}</td><td>{run.result.arrived.toLocaleString("th-TH")}</td><td>{run.result.incapacitated}</td>
            <td>{run.result.stillInside}{run.result.stillInside ? ` (${Object.entries(run.result.insideReasons).map(([key, value]) => `${key} ${value}`).join(", ")})` : ""}</td>
            <td>{secs(run.result.p90Arrival)}</td><td>{run.result.completed ? secs(run.result.finalArrival) : `ไม่ครบใน ${run.conditions.timeLimit} วิ`}</td>
            <td>{run.checks.headCountMatches ? "✓" : "✗"}</td><td>{run.checks.topologyViolations + run.checks.collisionCorrections === 0 && run.checks.maxStepMetres < 1 ? "✓" : "✗"}</td>
          </tr>
        ))}</tbody>
      </table>
      <RunSource data={data} runs={data.runs} />
    </>
  );
}

function FullTablePanel() {
  const r = example();
  return (
    <>
      <p className="pz-small">ทุกช่วงของทั้งสองเส้นทาง: d ระยะ, v ความเร็วบนช่วงนั้น, ต้นทุน = 0.28·d + d/v (ไม่มีไฟและคิว) — ผลรวมเท่ากับที่โปรแกรมคำนวณ</p>
      <div className="pz-two">
        <RouteTable calc={r.routeA} highlight="edge-stair-center-2-1" />
        <RouteTable calc={r.routeB} highlight="edge-stair-left-2-1" />
      </div>
    </>
  );
}

function FloorPanel() {
  return <p className="pz-lead">มุมมองทีละชั้นเปิดดูห้องเรียน ทางเดิน ประตู และบันไดของชั้นที่เลือก — ใช้ปุ่ม “ภายในชั้น” ที่แถบมุมมองด้านบนของหน้าจำลอง แล้วเลือกชั้น</p>;
}

function WallPanel() {
  return (
    <>
      <p className="pz-lead">ก่อนให้คนในแบบจำลองเดินทางที่แก้ใหม่ ระบบยิงเส้นตรวจกับโมเดล 3 มิติที่วาดจริง: มีพื้นใต้ทางทุก 0.5 ม. และไม่ชนผนัง ราว หน้าต่าง หรือต้นไม้ที่ความสูงเข่าและศีรษะ</p>
      <ul className="pz-list"><li>ทดสอบกับเส้นทางมาตรฐาน 570 เส้น (ไม่รวมบันได): ผ่านทั้งหมด — ไม่เตือนผิด</li><li>การตรวจนี้พบข้อผิดพลาดเดิม 2 จุด (ทางออกขวาทะลุผนัง, ต้นไม้ขวางทาง) และแก้แล้ว</li></ul>
    </>
  );
}

export const SLIDES: Slide[] = [
  {
    id: "title", group: "main", kicker: "โครงงาน", title: "ระบบจำลอง 3 มิติเพื่อการอพยพหนีไฟ", seconds: 14,
    narration: "ระบบจำลองสามมิติ เพื่อคำนวณและเพิ่มประสิทธิภาพเส้นทางการอพยพ ลดปรากฏการณ์คอขวดด้วยหลักคณิตศาสตร์",
    enter: async (api) => { overlay(); await view("exterior"); await look(CAMPUS, { duration: 1400 }); if (api.alive()) await look(BUILDING1, { duration: 2200 }); },
    Panel: TitlePanel,
  },
  {
    id: "bottleneck", group: "main", kicker: "ปัญหา", title: "คอขวดเกิดที่ประตูและบันได", seconds: 16,
    narration: "ประตูและบันไดระบายคนได้จำกัด ถ้าคนมาถึงเร็วกว่าความจุ คิวจะยาวขึ้นทุกวินาที",
    enter: async () => {
      await view("exterior");
      const stairs = Array.from({ length: 9 }, (_, i) => nodePos(`sim-stair-center-f${i + 1}`));
      overlay([], [{ id: "top", position: stairs[8], kind: "node", label: "บันไดกลาง ชั้น 9" }, { id: "bottom", position: stairs[0], kind: "node", label: "ชั้น 1 · 4.5 คน/วินาที" }]);
      await look(stairs);
    },
    Panel: BottleneckPanel,
  },
  {
    id: "math", group: "main", kicker: "แผนที่และหลักคณิตศาสตร์", title: "Node / Edge และต้นทุนของแต่ละเส้นทาง", seconds: 24, wide: true,
    narration: "อาคารถูกแทนด้วยจุดและเส้นเชื่อม แต่ละช่วงมีต้นทุนจากระยะทาง เวลา คิว และความเสี่ยง ระบบเลือกเส้นทางที่ผลรวมต้นทุนต่ำสุด ผลคำนวณมือตรงกับโปรแกรม",
    enter: async () => {
      const r = example();
      await view("single-floor", 2);
      const a = routePoints(r.routeA), b = routePoints(r.routeB);
      overlay([
        { id: "A", points: a, color: "#40b8d5", width: 7, revealMs: 2600, label: `A ${fmt(r.routeA.total, 1)}`, labelAt: 0.35 },
        { id: "B", points: b, color: "#a78bfa", width: 5, revealMs: 3200, label: `B ${fmt(r.routeB.total, 1)}`, labelAt: 0.35 },
      ], [{ id: "start", position: a[0], kind: "person", label: "ห้อง 203" }]);
      await look([...floorPart(a, a[0][1]), ...floorPart(b, b[0][1])]);
    },
    Panel: MathPanel,
  },
  {
    id: "fire", group: "main", kicker: "จำลองไฟ", title: "ไฟปิดทาง → ระบบเปลี่ยนเส้นทาง", seconds: 16,
    narration: "เมื่อไฟปิดบันไดกลาง ทางเดิมผ่านไม่ได้ ระบบหาเส้นทางที่เหลือที่ต้นทุนต่ำสุดแทน",
    enter: async () => {
      const r = example();
      await view("single-floor", 2);
      const a = routePoints(r.routeA), f = r.fire.route ? routePoints(r.fire.route) : [];
      overlay([
        { id: "A", points: a, color: "#ff5a36", width: 4, dashed: true, label: "ทางเดิม (ผ่านไม่ได้)", labelAt: 0.3 },
        ...(f.length ? [{ id: "F", points: f, color: "#4fd6a0", width: 7, revealMs: 2600, label: "ทางใหม่" }] : []),
      ], [{ id: "fire", position: nodePos("sim-stair-center-f2"), kind: "fire", label: "ไฟ" }, { id: "start", position: a[0], kind: "person", label: "ห้อง 203" }]);
      await look([...floorPart(a, a[0][1]), ...floorPart(f, a[0][1])]);
    },
    Panel: FirePanel,
  },
  {
    id: "no-exit", group: "main", kicker: "จำลองไฟ", title: "เมื่อไม่มีทางไปจุดรวมพล", seconds: 14,
    narration: "ถ้าทางออกถูกปิดทั้งหมด ระบบไม่สร้างทางที่ไม่มีจริง และแสดงจำนวนผู้ติดค้างตามผลจำลอง",
    enter: async () => {
      await view("exterior");
      const exits = ["sim-exit-left", "sim-exit-center", "sim-exit-right"].map((id) => ({ id, position: nodePos(id), kind: "closed" as const, label: `${nodeName(id)} ปิด` }));
      overlay([], exits);
      await look(exits.map((exit) => exit.position), { preferTop: false });
    },
    Panel: NoExitPanel,
  },
  {
    id: "compare", group: "main", kicker: "ผลเปรียบเทียบ", title: "วางแผนรวมด้วยคณิตศาสตร์ vs ต่างคนต่างเลือก", seconds: 20, wide: true,
    narration: "เปรียบเทียบด้วยฉาก คน และ seed เดียวกัน เพื่อดูว่าการวางแผนรวมตามความจุทางช่วยได้มากแค่ไหนในแต่ละสถานการณ์",
    enter: async () => { overlay(); await view("exterior"); await look(BUILDING1); },
    Panel: ComparePanel,
  },
  {
    id: "phone", group: "main", kicker: "ระบบมือถือ", title: "คำแนะนำก่อนและหลังเปลี่ยนเส้นทาง", seconds: 18, wide: true,
    narration: "หน้าจอมือถือบอกเส้นทางทีละขั้น เมื่อบันไดกลางถูกปิด คำแนะนำเปลี่ยนทันทีพร้อมเหตุผล นี่คือการสาธิต",
    enter: async () => { await view("single-floor", 2); overlay(); await look([nodePos("sim-corr-pink-f2-b3"), nodePos("sim-stair-center-f2"), nodePos("sim-stair-left-f2")]); },
    Panel: PhonePanel,
  },
  {
    id: "editor", group: "main", kicker: "ตัวแก้ไขแบบจำลอง", title: "แก้ผังแล้วนำไปจำลองได้จริง", seconds: 14,
    narration: "ตัวแก้ไขเปลี่ยนผังได้ ทุกการแก้ผ่านการตรวจผนังและพื้นจริงก่อนนำไปจำลอง",
    enter: async () => { overlay(); await view("exterior"); await look(BUILDING1); },
    Panel: EditorPanel,
  },
  {
    id: "closing", group: "main", kicker: "สรุป", title: "สิ่งที่ทำได้ และข้อจำกัดของผลจำลอง", seconds: 16, wide: true,
    narration: "ระบบช่วยหาคอขวดและเปรียบเทียบแผนก่อนซ้อมจริง ผลเป็นการจำลองเพื่อการศึกษา ต้องตรวจกับการซ้อมจริงเสมอ",
    enter: async () => { overlay(); await view("exterior"); await look(CAMPUS); },
    Panel: ClosingPanel,
  },
  {
    id: "matrix", group: "extra", kicker: "ฉากเสริม", title: "ผลทุกสถานการณ์ (seed เดียวกัน)", seconds: 20, wide: true,
    narration: "ตารางผลทุกสถานการณ์ที่รันด้วย seed เดียวกัน พร้อมการตรวจยอดคนและการไม่ทะลุผนัง",
    enter: async () => { overlay(); await view("exterior"); },
    Panel: MatrixPanel,
  },
  {
    id: "fulltable", group: "extra", kicker: "ฉากเสริม", title: "ตารางคำนวณรายช่วงเต็ม (ห้อง 203 → จุดรวมพล)", seconds: 20, wide: true,
    narration: "ตารางคำนวณต้นทุนทุกช่วงของทั้งสองเส้นทาง ตรวจด้วยมือได้ทุกบรรทัด",
    enter: async () => { overlay(); await view("single-floor", 2); },
    Panel: FullTablePanel,
  },
  {
    id: "floors", group: "extra", kicker: "ฉากเสริม", title: "มุมมองทีละชั้น", seconds: 10,
    narration: "เปิดดูทีละชั้นเพื่อเห็นห้อง ทางเดิน และบันได",
    enter: async () => { overlay(); await view("single-floor", 5); await look([nodePos("sim-corr-pink-f5-b6"), nodePos("sim-corr-blue-f5-b6"), nodePos("sim-junction-f5")]); },
    Panel: FloorPanel,
  },
  {
    id: "wallcheck", group: "extra", kicker: "ฉากเสริม", title: "การตรวจผนังและพื้นของตัวแก้ไข", seconds: 12,
    narration: "ตัวแก้ไขตรวจทางใหม่กับโมเดลสามมิติจริง ไม่ยอมให้เดินทะลุผนัง",
    enter: async () => { overlay(); await view("exterior"); await look(BUILDING1); },
    Panel: WallPanel,
  },
];

export { ClosingPanel };
