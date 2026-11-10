/**
 * “เริ่มการสาธิต”: the narrated math story on the live 3D model. One clock drives the camera, the
 * drawing on the model, the numbers in the equation and the narration — pause stops all of them
 * together, “ย้อนช่วง” replays a section from its start. Every number comes from storyModel()
 * (the simulator's findPath / stepCost), computed when the story opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmt } from "../../explain/routeExample";
import { useBuilding1Store } from "../../building1/building1Store";
import { cancelCameraMove, currentPose, frame, moveCamera, onCameraInterrupt, type CameraPose } from "../../camera/cameraDirector";
import { sound, useSoundStatus } from "../../audio/soundManager";
import { useIntroAudioSettings } from "../../audio/introAudioSettings";
import { SoundToggle } from "../../audio/SoundToggle";
import { freezeOverlay, useStoryOverlay, type StoryLine } from "../StoryOverlay3D";
import { buildBeats, chapterStarts, CHAPTERS, COLORS, totalMs, type Beat, type PanelKind } from "./storyBeats";
import { MAX_QUEUE, queueAt, storyModel, type StoryModel } from "./storyData";
import { useStoryClock } from "./storyStore";
import "./story.css";

const still = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const n3 = (v: number) => fmt(v, 3);
const KIND_TH: Record<string, string> = { room: "ห้อง → ประตู", corridor: "ทางเดิน", junction: "ทางแยก", stair: "บันได", exit: "ชั้น 1 → ทางออก", outdoor: "นอกอาคาร", assembly: "เข้าลานรวมพล" };

// ---------------------------------------------------------------- formula pieces
function Term({ k, color, label, off, hot, children }: { k: string; color: string; label: string; off?: boolean; hot?: boolean; children: ReactNode }) {
  return (
    <span className={`st-term${off ? " is-off" : ""}${hot ? " is-hot" : ""}`} data-term={k} style={{ ["--c" as string]: color }}>
      <b>{children}</b><small>{label}</small>
    </span>
  );
}

function FullFormula({ step }: { step: "full" | "simplify" | "values" | "substitute" }) {
  const off = step !== "full";
  return (
    <div className="st-formula" role="math" aria-label="ต้นทุนของเส้นเชื่อม เท่ากับ 0.28 คูณ d บวก d หาร v บวก L หาร c บวก 20 L หาร w คูณ max 4 d บวก พจน์อันตราย">
      <span className="st-eq">C =</span>
      <Term k="dist" color={COLORS.distance} label="ระยะทาง" hot={step === "values" || step === "substitute"}>0.28·<i>d</i></Term>
      <span className="st-op">+</span>
      <Term k="travel" color={COLORS.travel} label="เวลาเดิน (วิ)" hot={step === "values" || step === "substitute"}><i>d</i> ÷ <i>v</i></Term>
      <span className="st-op">+</span>
      <Term k="queue" color={COLORS.queue} label="รอคิว (วิ)" off={off}>L ÷ c</Term>
      <span className="st-op">+</span>
      <Term k="crowd" color={COLORS.queue} label="ความแออัด" off={off}>20·L ÷ (w·max(4,d))</Term>
      <span className="st-op">+</span>
      <Term k="hazard" color={COLORS.hazard} label="ไฟ·ความร้อน·ควัน" off={off}>4200·F + 2436·H + 1250·S + T</Term>
    </div>
  );
}

function Units() {
  return (
    <dl className="st-units">
      <div><dt style={{ color: COLORS.distance }}>d</dt><dd>ระยะของเส้น (เมตร) · 0.28 = น้ำหนักต่อเมตร</dd></div>
      <div><dt style={{ color: COLORS.travel }}>v</dt><dd>ความเร็วเดิน 1.32 ม./วิ × ตัวคูณของทาง → d ÷ v เป็นวินาที</dd></div>
      <div><dt style={{ color: COLORS.queue }}>L, c, w</dt><dd>คนที่วางแผนใช้เส้นนั้นแล้ว (คน) · ความจุ (คน/วิ) · ความกว้าง (ม.)</dd></div>
      <div><dt style={{ color: COLORS.hazard }}>F, H, S</dt><dd>ไฟ ความร้อน ควัน (0–1 ตามระยะจากไฟ) · T ความร้อนเกินเกณฑ์ · ในเปลวไฟ = ใช้เส้นไม่ได้</dd></div>
      <div><dt>C</dt><dd>หน่วยต้นทุน (เทียบเท่าวินาที) — ค่าแนวทาง “สมดุล” จาก src/simulation/graph.ts</dd></div>
    </dl>
  );
}

// ---------------------------------------------------------------- chart: cost of A and B vs people queuing
function QueueChart({ m, load, compact = false }: { m: StoryModel; load: number; compact?: boolean }) {
  const W = 420, H = compact ? 150 : 210, pad = { l: 46, r: 14, t: 14, b: 30 };
  const ys = m.queue.flatMap((q) => [q.costA, q.costB]);
  const yMin = Math.floor(Math.min(...ys) / 5) * 5, yMax = Math.ceil(Math.max(...ys) / 5) * 5;
  const x = (L: number) => pad.l + (L / MAX_QUEUE) * (W - pad.l - pad.r);
  const y = (c: number) => H - pad.b - ((c - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const path = (key: "costA" | "costB") => m.queue.map((q, i) => `${i ? "L" : "M"}${x(q.load).toFixed(1)},${y(q[key]).toFixed(1)}`).join(" ");
  const q = queueAt(load);
  const be = m.breakEven.after.load;
  return (
    <figure className="st-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`กราฟต้นทุนตามจำนวนคนรอ: ทาง A เพิ่มขึ้น ทาง B คงที่ ${n3(m.example.routeB.total)} ตัดกันระหว่าง ${be - 1} กับ ${be} คน ขณะนี้ ${load} คน โปรแกรมเลือก ${q.programPick}`}>
        {[yMin, (yMin + yMax) / 2, yMax].map((v) => <g key={v}><line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="st-grid" /><text x={pad.l - 6} y={y(v) + 4} className="st-axis" textAnchor="end">{Math.round(v)}</text></g>)}
        {[0, 10, 20, 30, 40].map((v) => <text key={v} x={x(v)} y={H - 10} className="st-axis" textAnchor="middle">{v}</text>)}
        <text x={W - pad.r} y={H - 10} className="st-axis" textAnchor="end" dy="-12">คนรอ L</text>
        <line x1={x(be - 0.5)} x2={x(be - 0.5)} y1={pad.t} y2={H - pad.b} className="st-break" />
        <text x={x(be - 0.5) + 4} y={pad.t + 10} className="st-axis is-break">จุดเปลี่ยน {be} คน</text>
        <path d={path("costB")} className="st-lineB" />
        <path d={path("costA")} className="st-lineA" />
        <line x1={x(load)} x2={x(load)} y1={pad.t} y2={H - pad.b} className="st-cursor" />
        <circle cx={x(load)} cy={y(q.costA)} r={q.programPick === "A" ? 7 : 5} className={`st-dotA${q.programPick === "A" ? " is-chosen" : ""}`} />
        <circle cx={x(load)} cy={y(q.costB)} r={q.programPick === "B" ? 7 : 5} className={`st-dotB${q.programPick === "B" ? " is-chosen" : ""}`} />
        <text x={x(2)} y={y(m.queue[2].costA) - 8} className="st-axis is-A">A (บันไดกลาง)</text>
        <text x={x(2)} y={y(m.queue[2].costB) - 8} className="st-axis is-B">B (บันไดซ้าย) — เส้นประ</text>
      </svg>
    </figure>
  );
}

// ---------------------------------------------------------------- panel bodies
function Match({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <p className={`st-match${ok ? " is-ok" : " is-bad"}`} role="status">{ok ? "✓ ตรงกัน" : "✗ ไม่ตรง"} · {children}</p>;
}

function Accumulate({ m, route, p, check }: { m: StoryModel; route: "A" | "B"; p: number; check: boolean }) {
  const calc = route === "A" ? m.example.routeA : m.example.routeB;
  // A: counted up in its own beat, then confirmed in the next (shown whole). B: counted up and confirmed in one beat.
  const whole = route === "A" && check;
  const shown = whole ? calc.rows.length : Math.min(calc.rows.length, Math.floor(p * (route === "A" ? 1 : 1 / 0.75) * calc.rows.length) + 1);
  const running = calc.rows.slice(0, shown).reduce((sum, row) => sum + row.handCost, 0);
  const done = shown >= calc.rows.length;
  return (
    <>
      <p className="st-lead">ทาง {calc.label}: รวมต้นทุนทีละเส้นตามลำดับการเดิน</p>
      <ol className="st-rows">
        {calc.rows.map((row, i) => (
          <li key={row.edgeId} className={i < shown ? (i === shown - 1 && !done ? "is-now" : "is-done") : "is-wait"}>
            <span>{KIND_TH[row.kind] ?? row.kind}</span><span className="st-num">{i < shown ? n3(row.handCost) : "…"}</span>
          </li>
        ))}
      </ol>
      <p className="st-total"><span>ยอดสะสม</span><b className="st-big">{n3(running)}</b></p>
      {done && check && (
        <>
          <Match ok={Math.abs(calc.total - calc.programTotal) < 1e-9}>มือ {n3(calc.total)} = โปรแกรม {n3(calc.programTotal)}</Match>
          <p className="st-src">มือ = Σ(0.28·d + d÷v) จากค่าของแต่ละเส้นในข้อมูล · โปรแกรม = ผลรวม stepCost ที่ findPath ใช้ค้นหา · ผลรวมคิดจากค่าเต็มก่อนปัด (บวกเลขที่ปัดแล้วอาจต่าง ±0.002)</p>
          {route === "B" && <p className="st-verdict">{n3(m.example.routeA.total)} &lt; {n3(m.example.routeB.total)} → ไม่มีคนรอ เลือก <b>ทาง A</b> (โปรแกรมเลือก {m.example.programPick})</p>}
        </>
      )}
    </>
  );
}

/** Pointing at a row of the table lights the same step on the model. */
function highlightStep(m: StoryModel, route: "A" | "B" | null, index: number) {
  const overlay = useStoryOverlay.getState();
  const lines = overlay.lines.filter((line) => line.id !== "row-hover");
  if (route) {
    const ids = route === "A" ? m.example.routeA.nodeIds : m.example.routeB.nodeIds;
    lines.push({ id: "row-hover", points: [m.nodes[ids[index]].position, m.nodes[ids[index + 1]].position], color: "#ffffff", width: 12, label: "ช่วงในตาราง", startedAt: 0 });
  }
  overlay.set({ lines });
}

function AllRows({ m }: { m: StoryModel }) {
  return (
    <details className="st-table">
      <summary>ดูต้นทุนทุกช่วง (ทั้งสองเส้นทาง)</summary>
      {[m.example.routeA, m.example.routeB].map((calc) => (
        <table key={calc.label}>
          <caption>{calc.label} · {fmt(calc.distance, 1)} ม.</caption>
          <thead><tr><th>จาก → ถึง</th><th>d (ม.)</th><th>v (ม./วิ)</th><th>C</th></tr></thead>
          <tbody>{calc.rows.map((row, i) => (
            <tr key={row.edgeId} tabIndex={0} onMouseEnter={() => highlightStep(m, calc === m.example.routeA ? "A" : "B", i)} onFocus={() => highlightStep(m, calc === m.example.routeA ? "A" : "B", i)} onMouseLeave={() => highlightStep(m, null, 0)} onBlur={() => highlightStep(m, null, 0)}>
              <td>{row.from} → {row.to}</td><td>{fmt(row.d, 2)}</td><td>{fmt(row.v, 3)}</td><td>{n3(row.handCost)}</td>
            </tr>
          ))}</tbody>
          <tfoot><tr><td colSpan={3}>รวม (มือ / โปรแกรม)</td><td>{n3(calc.total)} / {n3(calc.programTotal)}</td></tr></tfoot>
        </table>
      ))}
    </details>
  );
}

function QueueMath({ m, load, step }: { m: StoryModel; load: number; step: "formula" | "ramp" | "hold" | "summary" | "try" }) {
  const pp = m.perPerson, q = queueAt(load);
  return (
    <>
      <div className="st-lines">
        <p>เพิ่มบนบันไดกลาง = <span className="st-q">L ÷ c</span> + <span className="st-q">20·L ÷ (w·max(4,d))</span></p>
        <p>= L × (1 ÷ {fmt(pp.capacity, 1)} + 20 ÷ ({fmt(pp.width, 1)} × {fmt(pp.length, 4)}))</p>
        <p>= L × ({fmt(pp.queueTerm, 5)} + {fmt(pp.crowdTerm, 5)}) = <b className="st-q">L × {fmt(pp.value, 5)}</b></p>
      </div>
      {step !== "formula" && (
        <>
          <div className="st-compare">
            <p><span className="st-Lchip">L = <b className="st-big">{load}</b> คน</span></p>
            <p className={q.programPick === "A" ? "is-chosen" : ""}>A = {n3(m.example.routeA.total)} + {load} × {fmt(pp.value, 5)} = <b>{n3(q.costA)}</b></p>
            <p className={q.programPick === "B" ? "is-chosen" : ""}>B = <b>{n3(q.costB)}</b> <small>(ไม่ผ่านบันไดกลาง จึงไม่เปลี่ยน)</small></p>
            <p className="st-verdict">โปรแกรม (findPath) เลือก <b>ทาง {q.programPick}</b> · ผลรวมที่โปรแกรมได้ {n3(q.programTotal)}</p>
          </div>
          <QueueChart m={m} load={load} compact={step === "try"} />
        </>
      )}
      {step === "summary" && (
        <>
          <p className="st-lines">คิดมือ: ต่างกัน {n3(m.example.routeB.total - m.example.routeA.total)} ÷ {fmt(pp.value, 5)} = {fmt((m.example.routeB.total - m.example.routeA.total) / pp.value, 2)} → ต้องมากกว่านี้ → <b>{m.breakEven.hand} คน</b></p>
          <Match ok={m.checks.breakEvenMatches}>มือ {m.breakEven.hand} คน = โปรแกรม {m.breakEven.program} คน (ที่ {m.breakEven.before.load} คนโปรแกรมเลือก {m.breakEven.before.programPick}, ที่ {m.breakEven.after.load} คนเลือก {m.breakEven.after.programPick})</Match>
        </>
      )}
    </>
  );
}

function FirePanel({ m, step }: { m: StoryModel; step: "fire" | "blocked" | "route" | "contrast" }) {
  return (
    <>
      <p className="st-lead">ไฟที่ชานพักบันไดกลาง ชั้น 2 · รัศมีเปลวไฟ {fmt(m.fire.radius, 1)} ม. · ไม่มีคนรอ (L = 0)</p>
      {step !== "fire" && (
        <ul className="st-blocked">
          {m.fire.blocked.map((edge) => (
            <li key={edge.edgeId}><b>{edge.from} → {edge.to}</b><span>F = {fmt(edge.fire, 2)} (อยู่ในเปลวไฟ) → stepCost = ∞ → <b className="st-x">ตัดออก</b></span></li>
          ))}
        </ul>
      )}
      {(step === "route" || step === "contrast") && m.fire.route && (
        <p className="st-verdict">findPath ค้นหาใหม่บนกราฟที่เหลือ → ลงบันไดซ้าย · ต้นทุน <b>{n3(m.fire.route.programTotal)}</b> (เท่ากับทาง B)</p>
      )}
      {step === "contrast" && (
        <div className="st-two">
          <section className="is-queue"><h4>คิว</h4><p>ต้นทุนเพิ่มทีละ {fmt(m.perPerson.value, 3)} ต่อคน — ทาง A ยังใช้ได้ แค่แพงขึ้นจนทาง B คุ้มกว่า (ที่ {m.breakEven.after.load} คน)</p></section>
          <section className="is-fire"><h4>ไฟปิดทาง</h4><p>เส้นในเปลวไฟถูกตัดออก (∞) — ไม่ว่าคนรอน้อยแค่ไหนก็ไม่ใช้</p></section>
        </div>
      )}
      {step === "contrast" && <p className="st-src">วิธีค้นหาที่โค้ดใช้จริง: {m.algorithm}</p>}
    </>
  );
}

function PanelBody({ m, panel, p, tryLoad, onTry }: { m: StoryModel; panel: PanelKind; p: number; tryLoad: number | null; onTry(load: number): void }) {
  const dA = m.detail.A, dB = m.detail.B;
  switch (panel.kind) {
    case "question":
      return (
        <>
          <p className="st-question">“ถ้าบันไดกลางมีคนรอมากขึ้น เราควรเปลี่ยนไปใช้บันไดอีกทาง<b>เมื่อไหร่</b>?”</p>
          <ul className="st-facts">
            {panel.step >= 1 && <li><span className="st-dot is-room" /> เริ่ม: ห้อง 203 อาคาร 1 ชั้น 2</li>}
            {panel.step >= 2 && <li><span className="st-dot is-zone" /> ปลายทาง: จุดรวมพล Zone C</li>}
            {panel.step >= 3 && <li><span className="st-swatch is-A" /> ทาง A ลงบันไดกลาง · {fmt(m.example.routeA.distance, 1)} ม.</li>}
            {panel.step >= 4 && <li><span className="st-swatch is-B" /> ทาง B ลงบันไดซ้าย · {fmt(m.example.routeB.distance, 1)} ม. (เส้นประ)</li>}
          </ul>
        </>
      );
    case "graph": {
      const edge = dA.row;
      return (
        <>
          <p className="st-lead"><b>Node (จุด)</b> = ที่ที่ต้องตัดสินใจหรือเปลี่ยนทาง: ห้อง ประตู ทางแยก บันได ทางออก ประตูรั้ว จุดรวมพล</p>
          {panel.step !== "nodes" && <p className="st-lead"><b>Edge (เส้น)</b> = ทางที่เดินได้จริงระหว่างสองจุด · ระบบมี {m.example.routeA.rows.length} เส้นบนทาง A และ {m.example.routeB.rows.length} เส้นบนทาง B</p>}
          {panel.step === "edge" && (
            <dl className="st-card">
              <div><dt>Edge</dt><dd>{edge.from} → {edge.to}</dd></div>
              <div><dt style={{ color: COLORS.distance }}>ระยะ d</dt><dd>{dA.sub.d} ม.</dd></div>
              <div><dt style={{ color: COLORS.queue }}>ความกว้าง w</dt><dd>{fmt(m.perPerson.width, 1)} ม.</dd></div>
              <div><dt style={{ color: COLORS.queue }}>ความจุ c</dt><dd>{fmt(m.perPerson.capacity, 1)} คน/วิ</dd></div>
              <div><dt style={{ color: COLORS.travel }}>ความเร็ว v</dt><dd>1.32 × {fmt(m.example.stair.speedFactor, 2)} = {dA.sub.v} ม./วิ (ลงบันได)</dd></div>
            </dl>
          )}
        </>
      );
    }
    case "formula":
      return (
        <>
          <FullFormula step={panel.step} />
          {panel.step === "full" && <Units />}
          {panel.step === "simplify" && <p className="st-lines">ไม่มีไฟ ควัน ความร้อน (F = H = S = T = 0) และยังไม่มีคนรอ (L = 0)<br />→ เหลือ <b>C = 0.28·d + d ÷ v</b></p>}
          {(panel.step === "values" || panel.step === "substitute") && (
            <div className="st-lines">
              <p>Edge: {dA.row.from} → {dA.row.to}</p>
              <p><span className="st-chip" style={{ ["--c" as string]: COLORS.distance }} data-term="d">d = {dA.sub.d} ม.</span> <span className="st-chip" style={{ ["--c" as string]: COLORS.travel }} data-term="v">v = {dA.sub.v} ม./วิ</span></p>
              {panel.step === "substitute" && (
                <>
                  <p>C = {dA.sub.expression}</p>
                  <p>= <span style={{ color: COLORS.distance }}>{dA.sub.distanceTerm}</span> + <span style={{ color: COLORS.travel }}>{dA.sub.travel}</span></p>
                  <p>= <b className="st-big">{p > 0.35 || still() ? dA.sub.result : "…"}</b> <small>หน่วยต้นทุน</small></p>
                  {p > 0.6 && <Match ok={Math.abs(dA.row.handCost - dA.row.cost) < 1e-9}>โปรแกรม stepCost ของเส้นนี้ = {n3(dA.row.cost)}</Match>}
                </>
              )}
            </div>
          )}
        </>
      );
    case "accumulate":
      return <><Accumulate m={m} route={panel.route} p={still() ? 1 : p} check={panel.check} />{panel.check && <AllRows m={m} />}</>;
    case "detailB":
      return (
        <div className="st-lines">
          <p className="st-lead">ทาง B — ช่วงที่ทำให้แพงกว่า: {dB.row.from} → {dB.row.to}</p>
          <p><span className="st-chip" style={{ ["--c" as string]: COLORS.distance }} data-term="dB">d = {dB.sub.d} ม.</span> <span className="st-chip" style={{ ["--c" as string]: COLORS.travel }}>v = {dB.sub.v} ม./วิ</span></p>
          <p>C = {dB.sub.expression}</p>
          <p>= <span style={{ color: COLORS.distance }}>{dB.sub.distanceTerm}</span> + <span style={{ color: COLORS.travel }}>{dB.sub.travel}</span> = <b className="st-big">{dB.sub.result}</b></p>
          <Match ok={Math.abs(dB.row.handCost - dB.row.cost) < 1e-9}>โปรแกรม stepCost ของเส้นนี้ = {n3(dB.row.cost)}</Match>
        </div>
      );
    case "queue": {
      const t = still() ? 1 : ease(Math.min(1, p / 0.8));
      const load = Math.round(panel.from + (panel.to - panel.from) * t);
      return <QueueMath m={m} load={load} step={panel.step} />;
    }
    case "fire":
      return <FirePanel m={m} step={panel.step} />;
    case "closing":
      if (tryLoad !== null) {
        return (
          <>
            <label className="st-slider">
              <span>จำนวนคนรอที่บันไดกลาง: <b>{tryLoad}</b> คน</span>
              <input type="range" min={0} max={MAX_QUEUE} step={1} value={tryLoad} onChange={(event) => onTry(Number(event.target.value))} aria-label="จำนวนคนรอที่บันไดกลาง" />
            </label>
            <QueueMath m={m} load={tryLoad} step="try" />
            <p className="st-src">คำนวณแยกจากรอบจำลองหลัก (ไม่เปลี่ยนการตั้งค่าหรือผลจำลองของคุณ)</p>
          </>
        );
      }
      return (
        <>
          <p className="st-lead">สรุป: ผังอาคาร → กราฟ → สูตรต้นทุน → ค้นหาทางที่ผลรวมต่ำสุด</p>
          <ul className="st-facts">
            <li>ไม่มีคนรอ: A {n3(m.example.routeA.total)} &lt; B {n3(m.example.routeB.total)} → เลือก A</li>
            <li>คนรอบันไดกลาง ≥ {m.breakEven.after.load} คน → เลือก B (มือ = โปรแกรม)</li>
            <li>ไฟปิดชานพักบันไดกลาง → เส้นถูกตัดออก → ลงบันไดซ้าย</li>
          </ul>
          <QueueChart m={m} load={0} compact />
        </>
      );
  }
}

// ---------------------------------------------------------------- pointers from model labels to the equation
function Connectors({ pairs }: { pairs: Array<[string, string]> }) {
  const [paths, setPaths] = useState<Array<{ d: string; color: string }>>([]);
  useEffect(() => {
    if (!pairs.length) { setPaths([]); return undefined; }
    let raf = 0;
    const loop = () => {
      const next: Array<{ d: string; color: string }> = [];
      for (const [anchor, term] of pairs) {
        const from = document.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`)?.getBoundingClientRect();
        const to = document.querySelector<HTMLElement>(`.st-panel [data-term="${term}"]`)?.getBoundingClientRect();
        if (!from || !to || !from.width || !to.width) continue;
        const x1 = to.right + 4, y1 = to.top + to.height / 2, x2 = from.left - 4, y2 = from.top + from.height / 2;
        const color = getComputedStyle(document.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`)!).borderTopColor;
        next.push({ d: `M${x1},${y1} C${x1 + 80},${y1} ${x2 - 80},${y2} ${x2},${y2}`, color });
      }
      setPaths((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pairs]);
  return (
    <svg className="st-connectors" aria-hidden="true">
      {paths.map((path, i) => <path key={i} d={path.d} stroke={path.color} />)}
    </svg>
  );
}

// ---------------------------------------------------------------- the player
function usePortrait() {
  const [portrait, setPortrait] = useState(() => window.matchMedia("(max-aspect-ratio: 1/1)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-aspect-ratio: 1/1)");
    const update = () => setPortrait(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return portrait;
}

export function StoryPlayer({ onExit, onSlides }: { onExit(): void; onSlides(): void }) {
  const portrait = usePortrait();
  const m = useMemo(() => storyModel(), []);
  const beats = useMemo(() => buildBeats(m), [m]);
  const starts = useMemo(() => chapterStarts(beats), [beats]);
  const total = useMemo(() => totalMs(beats), [beats]);
  const { beat: index, elapsed, playing, finished, tryLoad, set } = useStoryClock();
  const beat: Beat = beats[Math.min(index, beats.length - 1)];
  const p = Math.min(1, elapsed / beat.ms);
  const narration = useIntroAudioSettings((state) => state.narration);
  const setNarration = useIntroAudioSettings((state) => state.setNarration);
  const camera = useRef<{ pose: CameraPose | null; pending: boolean }>({ pose: null, pending: false });
  const overlayStep = useRef(-1);

  // Start from the top each time the story opens.
  useEffect(() => {
    set({ beat: 0, elapsed: 0, playing: true, finished: false, tryLoad: null });
    return () => { freezeOverlay(false); cancelCameraMove(); sound.stopSpeech(); useStoryOverlay.getState().clear(); useStoryClock.getState().set({ playing: false }); };
  }, [set]);

  // The clock.
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = now - last; last = now;
      const s = useStoryClock.getState();
      if (s.playing && !s.finished) {
        const current = beats[s.beat];
        let next = s.elapsed + dt * s.rate;
        // narration still reading: hold at the end of the beat rather than talk over the next one
        if (next >= current.ms && useSoundStatus.getState().speaking && s.rate === 1) next = current.ms;
        else if (next >= current.ms) {
          if (s.beat + 1 < beats.length) { s.set({ beat: s.beat + 1, elapsed: 0 }); raf = requestAnimationFrame(tick); return; }
          s.set({ elapsed: current.ms, playing: false, finished: true });
          raf = requestAnimationFrame(tick); return;
        }
        s.set({ elapsed: next });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [beats]);

  const applyOverlay = useCallback((target: Beat, progress: number, force = false) => {
    const steps = target.steps ?? 1;
    const step = steps > 1 ? Math.min(steps - 1, Math.floor(progress * steps)) : 0;
    if (!force && step === overlayStep.current) return;
    overlayStep.current = step;
    const next = target.overlay(m, steps > 1 ? (step + 0.5) / steps : progress);
    // Keep lines that are already drawn where they are (no re-reveal when only a highlight moves).
    const previous = new Map(useStoryOverlay.getState().lines.map((line) => [line.id, line]));
    const lines: StoryLine[] = next.lines.map((line) => {
      const before = previous.get(line.id);
      return before && !force ? { ...line, startedAt: before.startedAt } : line;
    });
    useStoryOverlay.getState().set({ lines, markers: next.markers, boxes: [] });
  }, [m]);

  // Entering a beat: view, drawing, camera, narration.
  useEffect(() => {
    if (tryLoad !== null) return;
    const target = beats[index];
    let alive = true;
    const b1 = useBuilding1Store.getState();
    b1.setExplodeFloors(false);
    if (target.view.floor) b1.setSelectedFloor(target.view.floor);
    b1.setViewMode(target.view.mode);
    overlayStep.current = -1;
    applyOverlay(target, useStoryClock.getState().elapsed / target.ms, true);
    sound.stopSpeech();
    if (useStoryClock.getState().playing) void sound.speak(target.caption);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!alive) return;
      try {
        const pose = frame(target.targets(m), { preferTop: target.preferTop, minDistance: target.minDistance ?? 26 });
        camera.current = { pose, pending: !!pose && !pose.reused };
        if (pose && !pose.reused && useStoryClock.getState().playing) void moveCamera(pose, still() ? 0 : 1900).then((done) => { if (done && alive) camera.current.pending = false; });
      } catch { camera.current = { pose: null, pending: false }; }
    }));
    return () => { alive = false; };
  }, [index, beats, m, applyOverlay, tryLoad]);

  // Overlay steps inside a beat (nodes appearing one by one, the running-sum highlight).
  useEffect(() => { if (tryLoad === null) applyOverlay(beat, p); }, [beat, p, applyOverlay, tryLoad]);

  // Pause / resume: camera, drawing, narration and the clock together.
  useEffect(() => {
    if (playing) {
      freezeOverlay(false);
      sound.resumeSpeech();
      const { pose, pending } = camera.current;
      if (pending && pose) void moveCamera(pose, still() ? 0 : 900).then((done) => { if (done) camera.current.pending = false; });
    } else {
      freezeOverlay(true);
      cancelCameraMove();
      sound.pauseSpeech();
    }
  }, [playing]);

  // Grabbing the camera pauses the story (the viewer wants to look around).
  useEffect(() => onCameraInterrupt(() => { const s = useStoryClock.getState(); if (s.playing) s.set({ playing: false }); }), []);

  const goChapter = useCallback((chapter: number) => {
    const c = Math.max(0, Math.min(CHAPTERS.length - 1, chapter));
    sound.stopSpeech();
    set({ beat: starts[c], elapsed: 0, finished: false, tryLoad: null, playing: true });
  }, [set, starts]);
  const chapter = beat.chapter;
  const back = useCallback(() => {
    const s = useStoryClock.getState();
    // Within the first 2 s of a section, go to the previous one; otherwise replay this one.
    const intoChapter = beats.slice(starts[chapter], s.beat).reduce((sum, b) => sum + b.ms, 0) + s.elapsed;
    goChapter(intoChapter < 2000 ? chapter - 1 : chapter);
  }, [beats, starts, chapter, goChapter]);
  const toggle = useCallback(() => {
    const s = useStoryClock.getState();
    if (s.finished) { goChapter(0); return; }
    s.set({ playing: !s.playing });
  }, [goChapter]);

  const tryIt = useCallback((load: number) => {
    const q = queueAt(load);
    set({ tryLoad: load, playing: false });
    freezeOverlay(false);
    const lines: StoryLine[] = [
      { id: "A", points: m.routePoints.A, color: q.programPick === "A" ? COLORS.chosen : COLORS.queue, width: q.programPick === "A" ? 9 : 3, label: `A = ${n3(q.costA)}${q.programPick === "A" ? " ✓ เลือก" : ""}`, labelAt: 0.3, startedAt: 0 },
      { id: "B", points: m.routePoints.B, color: q.programPick === "B" ? COLORS.chosen : COLORS.routeB, width: q.programPick === "B" ? 9 : 3, dashed: q.programPick !== "B", label: `B = ${n3(q.costB)}${q.programPick === "B" ? " ✓ เลือก" : ""}`, labelAt: 0.45, startedAt: 0 },
    ];
    useStoryOverlay.getState().set({ lines, markers: beats[beats.length - 1].overlay(m, 1).markers.filter((marker) => marker.id.startsWith("a-")), boxes: [] });
  }, [beats, m, set]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onExit(); return; }
      if (target?.closest("input, textarea, select") || event.ctrlKey || event.metaKey || event.altKey) return;
      const keys: Record<string, () => void> = {
        " ": toggle, k: toggle, ArrowLeft: back, ArrowRight: () => goChapter(chapter + 1),
        m: () => sound.setEnabled(!useIntroAudioSettings.getState().enabled), M: () => sound.setEnabled(!useIntroAudioSettings.getState().enabled),
        Escape: onExit,
      };
      const action = keys[event.key];
      if (!action || (event.key === " " && target?.closest("button"))) return;
      event.preventDefault(); event.stopPropagation(); action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle, back, goChapter, chapter, onExit]);

  // ?qa: drive and read the story from automated checks.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("qa")) return undefined;
    const api = {
      state: () => { const s = useStoryClock.getState(); return { beat: s.beat, id: beats[s.beat].id, chapter: beats[s.beat].chapter, elapsed: s.elapsed, playing: s.playing, finished: s.finished, tryLoad: s.tryLoad, cameraPending: camera.current.pending, camera: currentPose()?.position.map((v) => Math.round(v * 100) / 100) ?? null }; },
      setRate: (rate: number) => useStoryClock.getState().set({ rate }),
      go: (beatIndex: number) => useStoryClock.getState().set({ beat: beatIndex, elapsed: 0, finished: false }),
      checks: () => m.checks,
      numbers: () => ({ subA: m.detail.A.sub, subB: m.detail.B.sub, totalA: n3(m.example.routeA.total), totalB: n3(m.example.routeB.total), programA: n3(m.example.routeA.programTotal), programB: n3(m.example.routeB.programTotal),
        before: { load: m.breakEven.before.load, costA: n3(m.breakEven.before.costA), pick: m.breakEven.before.programPick }, after: { load: m.breakEven.after.load, costA: n3(m.breakEven.after.costA), pick: m.breakEven.after.programPick }, perPerson: fmt(m.perPerson.value, 5) }),
      beats: () => beats.map((b) => ({ id: b.id, chapter: b.chapter, ms: b.ms })),
    };
    (window as unknown as { __skrStory: typeof api }).__skrStory = api;
    return () => { delete (window as unknown as { __skrStory?: unknown }).__skrStory; };
  }, [beats, m]);

  // ?qa: what was on screen for each beat (after every render — exact, independent of the test's polling).
  useEffect(() => {
    const w = window as unknown as { __skrStoryLog?: { seen: string[]; texts: Record<string, string> } };
    if (!new URLSearchParams(window.location.search).has("qa")) return;
    w.__skrStoryLog ??= { seen: [], texts: {} };
    const log = w.__skrStoryLog;
    if (log.seen[log.seen.length - 1] !== beat.id) log.seen.push(beat.id);
    // the last render of a beat wins: that is what was on screen when the beat ended
    if (tryLoad === null) log.texts[beat.id] = document.querySelector<HTMLElement>(".st-panel")?.innerText ?? "";
  });

  // progress
  const done = beats.slice(0, index).reduce((sum, b) => sum + b.ms, 0) + Math.min(elapsed, beat.ms);
  const chapterMs = CHAPTERS.map((_, c) => beats.filter((b) => b.chapter === c).reduce((sum, b) => sum + b.ms, 0));
  const chapterStartMs = chapterMs.map((_, c) => chapterMs.slice(0, c).reduce((a, b) => a + b, 0));
  const remaining = Math.max(0, Math.round((total - done) / 1000));
  const panelKind: PanelKind = tryLoad !== null ? { kind: "closing" } : beat.panel;

  return (
    <div className="st-root" data-beat={beat.id} data-playing={playing}>
      <aside className="st-panel" data-camera-inset={portrait ? "bottom" : "left"}>
        <p className="st-kicker">ช่วงที่ {chapter + 1}/{CHAPTERS.length} · {CHAPTERS[chapter]}</p>
        <div key={tryLoad !== null ? "try" : beat.id} className="st-body">
          <PanelBody m={m} panel={panelKind} p={p} tryLoad={tryLoad} onTry={tryIt} />
        </div>
        {tryLoad === null && <p className="st-caption" aria-live="polite">{beat.caption}</p>}
        {(finished || tryLoad !== null) && (
          <div className="st-end">
            {tryLoad === null && <button type="button" className="st-primary" onClick={() => tryIt(0)}>ลองปรับจำนวนคนรอเอง</button>}
            <button type="button" onClick={() => goChapter(0)}>↺ ดูอีกครั้ง</button>
            <button type="button" onClick={onSlides}>ดูแบบสไลด์</button>
            <button type="button" onClick={onExit}>ออก</button>
          </div>
        )}
      </aside>
      <Connectors pairs={tryLoad === null && beat.connectors && p > 0.08 ? beat.connectors : []} />
      <footer className="st-bar" data-camera-inset="bottom">
        <div className="st-controls">
          <button type="button" onClick={back} aria-label="ย้อนช่วง" title="ย้อนช่วง (←)">⏮</button>
          <button type="button" className="st-play" onClick={toggle} aria-label={finished ? "ดูอีกครั้ง" : playing ? "พัก" : "เล่นต่อ"} title="พัก/เล่นต่อ (Space)">{finished ? "↺" : playing ? "❚❚" : "▶"}</button>
          <button type="button" onClick={() => goChapter(chapter + 1)} aria-label="ช่วงถัดไป" title="ช่วงถัดไป (→)" disabled={chapter >= CHAPTERS.length - 1}>⏭</button>
        </div>
        <ol className="st-progress" aria-label="ความคืบหน้า">
          {CHAPTERS.map((title, c) => {
            const fill = Math.max(0, Math.min(1, (done - chapterStartMs[c]) / chapterMs[c]));
            return (
              <li key={title} style={{ flexGrow: chapterMs[c] }}>
                <button type="button" onClick={() => goChapter(c)} aria-current={c === chapter} aria-label={`ช่วงที่ ${c + 1}: ${title}`}>
                  <i style={{ transform: `scaleX(${fill})` }} />
                  <span>{c + 1}. {title}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <span className="st-time" aria-label={`เหลือประมาณ ${remaining} วินาที`}>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span>
        <div className="st-controls">
          <SoundToggle compact className="st-sound" />
          {sound.narrationAvailable() && <button type="button" aria-pressed={narration} onClick={() => { if (narration) sound.stopSpeech(); setNarration(!narration); }} title="อ่านคำบรรยายออกเสียง">{narration ? "🔊 บรรยาย" : "🔈 บรรยาย"}</button>}
          <button type="button" onClick={onExit} aria-label="ออกจากการสาธิต" title="ออก (Esc)">✕</button>
        </div>
      </footer>
    </div>
  );
}
