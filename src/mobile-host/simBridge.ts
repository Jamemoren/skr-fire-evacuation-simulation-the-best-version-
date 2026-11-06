/**
 * Simulator A — links the 3D crowd simulation to the mobile guidance backend.
 *
 * A seeded share of the simulated people "carry a phone". Once a second this bridge reports where
 * each of them is (their last confirmed graph node) to the backend's simulation
 * incident, and hands every new route the backend issues back to that person in the 3D runtime,
 * who follows it with the chosen compliance — or not, if what they see contradicts it.
 *
 * The backend never sees the simulated fire directly: like a real system it only learns what the
 * simulated smoke/heat sensors report. Passages closed in the 3D world are mirrored as closures.
 * Everything here is labelled simulated and runs only against a "simulation" incident, so bots can
 * never mix with a drill or a real incident.
 */
import { useEffect, useRef, useState } from "react";
import type { IncidentSummary, MapPackage, SensorState } from "../evac/protocol";
import { computeMapVersion } from "../evac/mapRegistry";
import { modeledTemperatureFromHeat, pointRisk } from "../simulation/graph";
import { evacuationRuntime } from "../simulation/runtime";

interface SimBotAdvice {
  botId: number;
  participantId: string;
  routeRevision: number;
  status: string;
  nodeIds: string[];
  edgeIds: string[];
  destinationNodeId: string | null;
  reason: string | null;
}

export interface BotBridgeStatus {
  state: "off" | "waiting" | "running" | "error";
  text: string;
  holders: number;
  routesDelivered: number;
  lastSyncAt: number | null;
}

type Call = <T>(path: string, body?: unknown, method?: string) => Promise<T>;

/** Simulated smoke above this level (0–1 model scale) makes a smoke detector alarm. */
const SMOKE_ALARM_LEVEL = 0.12;
/** Simulated air temperature that trips a heat detector (fixed-temperature type, °C). */
const HEAT_ALARM_C = 57;

export function useBotPhoneBridge(options: {
  enabled: boolean;
  adoption: number;
  compliance: number;
  incident: IncidentSummary | null;
  map: MapPackage | null;
  sensors: SensorState[];
  call: Call;
}) {
  const { enabled, adoption, compliance, incident, map, sensors, call } = options;
  const [status, setStatus] = useState<BotBridgeStatus>({ state: "off", text: "", holders: 0, routesDelivered: 0, lastSyncAt: null });
  const lastSent = useRef(new Map<number, string | null>());
  const runIdentity = useRef<{ firstAgent: object; time: number } | null>(null);
  const busyRef = useRef(false);
  const lastHeartbeat = useRef(0);
  const closuresSent = useRef(new Set<string>());
  const sensorSequence = useRef(new Map<string, number>());
  const sensorState = useRef(new Map<string, "alarm" | "normal">());
  const routesDelivered = useRef(0);
  const evacuateSent = useRef<string | null>(null);
  const fullNext = useRef(true);
  const channel = useRef<string | null>(null);
  const sensorsRef = useRef(sensors);
  sensorsRef.current = sensors;

  useEffect(() => {
    evacuationRuntime.phoneCompliance = Math.max(0, Math.min(1, compliance / 100));
  }, [compliance]);

  useEffect(() => {
    if (!enabled) {
      evacuationRuntime.agents.forEach(agent => { agent.phoneAdvice = undefined; });
      setStatus({ state: "off", text: "", holders: 0, routesDelivered: 0, lastSyncAt: null });
      // Remove only virtual phones; keep the framed tester and every real phone session.
      let stopped = false;
      let timer = 0;
      const clear = async () => {
        if (stopped || !incident || incident.mode !== "simulation") return;
        if (busyRef.current) { timer = window.setTimeout(() => void clear(), 100); return; }
        busyRef.current = true;
        try { await call(`/api/admin/incidents/${incident.id}/sim-bots`, { bots: [], replace: true }); } catch { /* retried on the next activation */ }
        finally { busyRef.current = false; }
      };
      void clear();
      return () => { stopped = true; window.clearTimeout(timer); };
    }
    if (!incident || incident.mode !== "simulation" || incident.phase === "ended") {
      setStatus({ state: "error", text: "ต้องมีรอบ “สถานการณ์จำลอง” ที่ยังไม่ยุติ (บอทใช้กับรอบฝึกซ้อมหรือเหตุจริงไม่ได้)", holders: 0, routesDelivered: 0, lastSyncAt: null });
      return undefined;
    }
    if (!map) { setStatus(current=>({...current,state:"waiting",text:"รอโหลดและตรวจเวอร์ชันแผนที่"})); return undefined; }
    if (map && computeMapVersion(evacuationRuntime.graph) !== map.mapVersion) {
      setStatus({ state: "error", text: `แผนที่ของโมเดล 3 มิติไม่ตรงกับเซิร์ฟเวอร์ (${map.mapVersion}) — เชื่อมบอทไม่ได้`, holders: 0, routesDelivered: 0, lastSyncAt: null });
      return undefined;
    }
    let cancelled = false;
    let timer = 0;
    const share = Math.max(0, Math.min(1, adoption / 100));
    if (channel.current !== incident.id) {
      channel.current = incident.id;
      runIdentity.current = null;
      evacuationRuntime.agents.forEach(agent => { agent.phoneAdvice = undefined; agent.phoneRevisionHandled = 0; });
    }
    // A new selection/adoption must send a complete roster, not just changed positions.
    fullNext.current = true;

    const resetForNewRun = async () => {
      lastSent.current.clear();
      closuresSent.current.clear();
      sensorState.current.clear();
      routesDelivered.current = 0;
      evacuateSent.current = null;
      fullNext.current = true;
      // Bots of the previous run leave; real participants (if any) are untouched.
      await call(`/api/admin/incidents/${incident.id}/reset-test`, { scope: "bots" });
    };

    const syncSensors = async () => {
      const runtime = evacuationRuntime;
      const readings: unknown[] = [];
      const changes: Array<{id:string;state:"alarm"|"normal"}> = [];
      for (const sensor of sensorsRef.current) {
        if (sensor.type !== "smoke" && sensor.type !== "heat") continue;
        const position = runtime.nodePosition(sensor.nodeId);
        if (!position) continue;
        const risk = pointRisk(position, runtime.fires, runtime.time);
        const temperature = modeledTemperatureFromHeat(risk.heat, runtime.config.ambientTemperatureC ?? 29);
        const alarm = sensor.type === "smoke" ? risk.smoke >= SMOKE_ALARM_LEVEL : temperature >= HEAT_ALARM_C || risk.fire > 0.02;
        const next = alarm ? "alarm" : "normal";
        const previous = sensorState.current.get(sensor.sensorId) ?? (sensor.status === "alarm" ? "alarm" : "normal");
        // Report only changes (a real detector reports its state, not a stream of "still normal").
        if (next === previous && sensorState.current.has(sensor.sensorId)) continue;
        if (next === "normal" && !sensorState.current.has(sensor.sensorId) && sensor.status !== "alarm") { sensorState.current.set(sensor.sensorId, "normal"); continue; }
        changes.push({id:sensor.sensorId,state:next});
        const sequence = Math.max(sensorSequence.current.get(sensor.sensorId) ?? -1, sensor.lastSequence) + 1;
        sensorSequence.current.set(sensor.sensorId, sequence);
        readings.push({
          sensorId: sensor.sensorId, type: sensor.type,
          value: sensor.type === "smoke" ? Math.round(Math.min(100, risk.smoke * 25) * 10) / 10 : Math.round(temperature * 10) / 10,
          unit: sensor.type === "smoke" ? "%/m" : "°C", status: next,
          eventId: `bot-sim-${sensor.sensorId}-${sequence}-${Math.random().toString(36).slice(2, 7)}`,
          sequence, observedAt: Date.now(), quality: "good", mode: "simulated",
        });
      }
      for(let offset=0;offset<readings.length;offset+=200){
        await call("/api/sensors/events", { incidentId: incident.id, readings: readings.slice(offset,offset+200) });
        changes.slice(offset,offset+200).forEach(change=>sensorState.current.set(change.id,change.state));
      }
    };

    const syncClosures = async () => {
      const now = evacuationRuntime.closedEdges;
      const added = [...now].filter((edgeId) => !closuresSent.current.has(edgeId));
      const removed = [...closuresSent.current].filter((edgeId) => !now.has(edgeId));
      if (added.length) await call(`/api/admin/incidents/${incident.id}/closures`, { edgeIds: added, closed: true, reason: "ปิดในแบบจำลอง 3 มิติ" });
      if (removed.length) await call(`/api/admin/incidents/${incident.id}/closures`, { edgeIds: removed, closed: false, reason: "เปิดในแบบจำลอง 3 มิติ" });
      added.forEach((edgeId) => closuresSent.current.add(edgeId));
      removed.forEach((edgeId) => closuresSent.current.delete(edgeId));
    };

    const tick = async () => {
      if (cancelled) return;
      if (busyRef.current) { timer=window.setTimeout(tick,100); return; }
      busyRef.current = true;
      try {
        const runtime = evacuationRuntime;
        if (!runtime.agents.length) {
          if (lastSent.current.size) {
            await call(`/api/admin/incidents/${incident.id}/sim-bots`, { bots: [], replace: true });
            lastSent.current.clear();
          }
          if (!cancelled) setStatus({ state: "waiting", text: "รอเริ่มการจำลอง 3 มิติ — บอทจะถือมือถือเมื่อเริ่มจำลอง", holders: 0, routesDelivered: 0, lastSyncAt: null });
          return;
        }
        const identity = runIdentity.current;
        if (!identity || runtime.agents[0] !== identity.firstAgent || runtime.time + 1e-6 < identity.time) await resetForNewRun();
        if(cancelled)return;
        runIdentity.current = { firstAgent: runtime.agents[0], time: runtime.time };
        if (runtime.time <= 0) {
          setStatus((current) => ({ ...current, state: "waiting", text: "รอเริ่มการจำลอง 3 มิติ" }));
          return;
        }
        if (incident.phase === "standby" && evacuateSent.current !== incident.id) {
          await call(`/api/admin/incidents/${incident.id}/evacuate`, {});
          evacuateSent.current = incident.id;
        }
        await syncClosures();
        await syncSensors();
        if(cancelled)return;
        const updates: Array<{ botId: number; nodeId: string | null }> = [];
        const full=fullNext.current;
        const heartbeat=Date.now()-lastHeartbeat.current>=10_000;
        const firstAgent=runtime.agents[0];
        let holders = 0;
        for (const agent of runtime.agents) {
          if (!runtime.isPhoneHolder(agent.id, share)) continue;
          holders += 1;
          const nodeId = runtime.phoneNodeOf(agent.id);
          if (!full && !heartbeat && lastSent.current.get(agent.id) === nodeId) continue;
          updates.push({ botId: agent.id, nodeId });
        }
        const response = await call<{ advice: SimBotAdvice[]; bots: number }>(`/api/admin/incidents/${incident.id}/sim-bots`, { bots: updates, full, replace: full });
        if(cancelled||runtime.agents[0]!==firstAgent)return;
        updates.forEach(bot=>lastSent.current.set(bot.botId,bot.nodeId));
        if(heartbeat)lastHeartbeat.current=Date.now();
        fullNext.current = false;
        for (const advice of response.advice) {
          if (advice.status !== "ok") {
            const agent = runtime.agents[advice.botId];
            if (agent) agent.phoneAdvice = undefined;
            continue;
          }
          if (runtime.deliverPhoneAdvice(advice.botId, { revision: advice.routeRevision, nodeIds: advice.nodeIds, edgeIds: advice.edgeIds, reason: advice.reason })) routesDelivered.current += 1;
        }
        const metrics = runtime.getMetrics();
        setStatus({
          state: "running",
          text: `บอทถือมือถือ ${holders.toLocaleString("th-TH")} คน (${Math.round(share * 100)}%) · ส่งเส้นทางถึงบอท ${routesDelivered.current.toLocaleString("th-TH")} ครั้ง · เปลี่ยนทางตามมือถือ ${metrics.phoneFollowed.toLocaleString("th-TH")} · ไม่ทำตาม ${metrics.phoneIgnored.toLocaleString("th-TH")}`,
          holders, routesDelivered: routesDelivered.current, lastSyncAt: Date.now(),
        });
      } catch (error) {
        if (cancelled) return;
        fullNext.current = true;
        setStatus((current) => ({ ...current, state: "error", text: `เชื่อมบอทไม่สำเร็จ: ${(error as Error).message}` }));
      } finally {
        busyRef.current = false;
        if (!cancelled) timer = window.setTimeout(tick, 1000);
      }
    };
    void tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [enabled, adoption, incident?.id, incident?.mode, incident?.phase, map, call]);

  return status;
}
