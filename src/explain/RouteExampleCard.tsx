/**
 * The worked example, for the guide: flow → node/edge diagram → formula with units → step costs →
 * the program's answer. Numbers come from computeRouteExample(), the same code the presentation and
 * the simulator use, so the guide can never drift from what the program does.
 */
import { useMemo, useState } from "react";
import { computeRouteExample, fmt, type RouteCalc } from "./routeExample";
import "./route-example.css";

const KIND_TH: Record<string, string> = { room: "ประตูห้อง", corridor: "ทางเดิน", junction: "ทางเข้าบันได", stair: "บันได", exit: "ชั้น 1 → ทางออก", outdoor: "ไปประตูรั้ว", assembly: "ลานรวมพล" };

function groups(calc: RouteCalc) {
  const out: Array<{ kind: string; steps: number; d: number; cost: number }> = [];
  for (const row of calc.rows) {
    const last = out[out.length - 1];
    if (last && last.kind === row.kind) { last.steps += 1; last.d += row.d; last.cost += row.cost; }
    else out.push({ kind: row.kind, steps: 1, d: row.d, cost: row.cost });
  }
  return out;
}

/** Two lanes of nodes (circles) joined by edges (lines) labelled with each group's cost. */
function Diagram({ a, b }: { a: RouteCalc; b: RouteCalc }) {
  const lanes = [{ calc: a, y: 52, color: "#1f7fc4" }, { calc: b, y: 140, color: "#7c5cd6" }];
  return (
    <svg className="rx-diagram" viewBox="0 0 640 186" role="img" aria-label={`แผนภาพ Node/Edge: ${a.label} ต้นทุน ${fmt(a.total, 1)} และ ${b.label} ต้นทุน ${fmt(b.total, 1)}`}>
      <circle cx="22" cy="96" r="13" className="rx-node is-start" /><text x="22" y="100" className="rx-t">203</text>
      <circle cx="618" cy="96" r="13" className="rx-node is-goal" /><text x="618" y="100" className="rx-t">C</text>
      {lanes.map(({ calc, y, color }) => {
        const parts = groups(calc).slice(1);
        const step = (596 - 44) / parts.length;
        return (
          <g key={calc.label}>
            <path d={`M35 96 L44 ${y}`} stroke={color} className="rx-edge" />
            {parts.map((part, i) => {
              const x1 = 44 + i * step, x2 = 44 + (i + 1) * step;
              return (
                <g key={i}>
                  <line x1={x1} y1={y} x2={x2} y2={y} stroke={color} className={`rx-edge${part.kind === "stair" ? " is-stair" : ""}`} />
                  <circle cx={x2} cy={y} r="5" className="rx-node" />
                  <text x={(x1 + x2) / 2} y={y - 9} className="rx-t is-cost">{fmt(part.cost, 1)}</text>
                  <text x={(x1 + x2) / 2} y={y + 17} className="rx-t is-kind">{KIND_TH[part.kind] ?? part.kind}</text>
                </g>
              );
            })}
            <path d={`M596 ${y} L605 96`} stroke={color} className="rx-edge" />
            <text x="44" y={y - 28} className="rx-t is-lane" style={{ fill: color }}>{calc.label} · รวม {fmt(calc.total, 2)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function RouteExampleCard() {
  const r = useMemo(() => computeRouteExample(), []);
  const [full, setFull] = useState(false);
  const match = r.maxStepError < 1e-9 && r.handPick === r.programPick;
  const extra = r.routeB.total - r.routeA.total;
  return (
    <section className="rx" aria-labelledby="rx-title">
      <h4 id="rx-title">ตัวอย่างคำนวณ: นักเรียนห้อง 203 (อาคาร 1 ชั้น 2) ไปจุดรวมพล Zone C</h4>
      <ol className="rx-flow" aria-label="ขั้นตอนที่ระบบทำ">
        <li>อาคาร → จุด (Node) และเส้นเชื่อม (Edge)</li><li>คำนวณต้นทุนทุกช่วง</li><li>รวมต้นทุนตามเส้นทาง</li><li>เลือกผลรวมต่ำสุด (Dijkstra)</li><li>มีคน/ไฟ → ต้นทุนเปลี่ยน → คำนวณใหม่</li>
      </ol>
      <Diagram a={r.routeA} b={r.routeB} />
      <div className="rx-formula">ต้นทุนช่วง = 0.28·d + (d/v + L/c)·1 + 20·L/(w·max(4, d)) + 4200·ไฟ + 2436·ความร้อน + 1250·ควัน</div>
      <dl className="rx-params">
        <div><dt>d</dt><dd>ระยะทางของช่วง (เมตร)</dd></div>
        <div><dt>v</dt><dd>ความเร็วเดิน 1.32 ม./วินาที × ตัวคูณของทาง (บันไดลง {fmt(r.stair.speedFactor, 2)})</dd></div>
        <div><dt>L</dt><dd>จำนวนคนที่วางแผนใช้ช่วงนั้นแล้ว (คน)</dd></div>
        <div><dt>c</dt><dd>ความจุ (คน/วินาที) — บันไดกลาง {fmt(r.stair.capacity, 1)}</dd></div>
        <div><dt>w</dt><dd>ความกว้าง (เมตร) — บันไดกลาง {fmt(r.stair.width, 1)}</dd></div>
        <div><dt>ไฟ ความร้อน ควัน</dt><dd>0–1 ตามระยะจากไฟ (ไฟปิดทาง = ผ่านไม่ได้)</dd></div>
      </dl>
      <p>ไม่มีไฟและยังไม่มีคนรอ (L = 0) สูตรจึงเหลือ <b>0.28·d + d/v</b> เช่น ช่วงบันไดกลางชั้น 2→1: d = {fmt(r.stair.length, 2)} ม., v = {fmt(1.32 * r.stair.speedFactor, 3)} ม./วิ → 0.28×{fmt(r.stair.length, 2)} + {fmt(r.stair.length, 2)}/{fmt(1.32 * r.stair.speedFactor, 3)} = <b>{fmt(r.routeA.rows.find((row) => row.kind === "stair")?.handCost ?? 0, 3)}</b></p>
      <table className="rx-table">
        <thead><tr><th>ช่วง</th><th>{r.routeA.label}</th><th>{r.routeB.label}</th></tr></thead>
        <tbody>
          {groups(r.routeA).map((group, i) => { const other = groups(r.routeB)[i]; return (
            <tr key={i}><td>{KIND_TH[group.kind] ?? group.kind}</td><td>{fmt(group.cost, 2)} <small>({fmt(group.d, 1)} ม.)</small></td><td>{other ? <>{fmt(other.cost, 2)} <small>({fmt(other.d, 1)} ม.)</small></> : "—"}</td></tr>
          ); })}
        </tbody>
        <tfoot>
          <tr><td>รวม (คำนวณมือ)</td><td>{fmt(r.routeA.total, 3)}</td><td>{fmt(r.routeB.total, 3)}</td></tr>
          <tr><td>โปรแกรม</td><td>{fmt(r.routeA.programTotal, 3)}</td><td>{fmt(r.routeB.programTotal, 3)}</td></tr>
        </tfoot>
      </table>
      <p className={`rx-verdict${match ? " is-ok" : " is-bad"}`} role="status">{match ? "✓" : "✗"} มือเลือก <b>{r.handPick === "A" ? r.routeA.label : r.routeB.label}</b> · โปรแกรมเลือก <b>{r.programPick === "A" ? r.routeA.label : r.routeB.label}</b> · {r.maxStepError < 1e-9 ? "ทุกช่วงตรงกับโปรแกรม (ต่างน้อยกว่า 10⁻⁹)" : `ต่างกันมากสุด ${r.maxStepError.toExponential(1)}`}</p>
      <h5>เมื่อมีคนรอที่บันไดกลาง</h5>
      <p>แต่ละคนที่วางแผนใช้บันไดกลางแล้วเพิ่มต้นทุน 1/c + 20/(w·d) = 1/{fmt(r.stair.capacity, 1)} + 20/({fmt(r.stair.width, 1)}×{fmt(r.stair.length, 2)}) = <b>{fmt(r.perPerson, 5)}</b> ต่อคน · ทาง A แพงกว่า B เมื่อ L × {fmt(r.perPerson, 5)} &gt; {fmt(extra, 3)} → L ≥ <b>{r.breakEvenHand} คน</b> · โปรแกรมเปลี่ยนไปบันไดซ้ายที่ <b>{r.breakEvenProgram ?? "—"} คน</b> {r.breakEvenHand === r.breakEvenProgram ? "✓ ตรงกัน" : "✗ ไม่ตรง"}</p>
      <p className="rx-small">ไฟที่ชานบันไดกลางชั้น 2: ทาง A ผ่านไม่ได้ → โปรแกรมเลือก{r.fire.avoidsCentre ? "ทางที่ไม่ผ่านบันไดกลาง ✓" : " ✗"} · ปิดทางออกชั้น 1 ทั้งหมด: {r.allExitsClosed.route === null ? "ไม่มีเส้นทาง (ระบบไม่สร้างทางเอง) ✓" : "✗"} · ตรวจซ้ำได้ด้วย <code>npm run qa:route-example</code></p>
      <button type="button" className="rx-more" aria-expanded={full} onClick={() => setFull(!full)}>{full ? "ซ่อนตารางรายช่วง" : "ดูตารางรายช่วงเต็ม"}</button>
      {full && [r.routeA, r.routeB].map((calc) => (
        <table key={calc.label} className="rx-table is-full">
          <caption>{calc.label}</caption>
          <thead><tr><th>จาก → ถึง</th><th>d</th><th>v</th><th>0.28·d</th><th>d/v</th><th>ต้นทุน</th></tr></thead>
          <tbody>{calc.rows.map((row) => <tr key={row.edgeId}><td>{row.from} → {row.to}</td><td>{fmt(row.d)}</td><td>{fmt(row.v, 3)}</td><td>{fmt(row.distanceTerm)}</td><td>{fmt(row.travel)}</td><td>{fmt(row.cost, 3)}</td></tr>)}</tbody>
        </table>
      ))}
    </section>
  );
}
