/**
 * Mobile data layer, shared by the real phone (/mobile) and the phone frame on the dashboard
 * (which loads /mobile in an iframe). One logic, one backend: the frame is not a mock-up.
 *
 * Data sources (adapters):
 *  - "device":   a real phone that joined a drill with its code (QR or link)
 *  - "preview":  the dashboard's phone frame; joins as a *test participant* with a staff-issued
 *                ticket, so it never counts as a real person
 *  - "readonly": a staff view of an existing session — no actions, never sends a position
 *  - "player":   the roleplay simulator's character (SIMULATOR only). Joins with a staff-issued
 *                player ticket; its position comes from the character in the 3D simulation, sent
 *                as source "simulator", which the server accepts only for simulation incidents.
 */
import type { MapPackage, ParticipantView, RouteAdvice, StreamMessage } from "../evac/protocol";

export type ConnectionState = "connecting" | "online" | "offline" | "error";
export type SourceKind = "device" | "preview" | "readonly" | "player";

export interface Capabilities {
  secureContext: boolean;
  barcodeDetector: boolean;
  camera: boolean;
  geolocation: boolean;
  notifications: "granted" | "denied" | "default" | "unsupported";
  serviceWorker: boolean;
}

export interface ClientState {
  kind: SourceKind;
  session: { token: string; participantId: string; incidentId: string } | null;
  view: ParticipantView | null;
  map: MapPackage | null;
  mapNote: string | null;
  connection: ConnectionState;
  /** Time (local clock) of the last message from the server. */
  lastMessageAt: number | null;
  /** serverTime − local time, from the latest message (for expiry checks). */
  serverOffsetMs: number;
  error: string | null;
  busy: boolean;
  /** Network cut simulated by the preview host (test only). */
  simulatedOffline: boolean;
  pendingCheckpoint: string | null;
  capabilities: Capabilities;
  /** routeIds the user explicitly acknowledged (“รับทราบ”). */
  confirmedRouteIds: string[];
  /** Player only: round trip of the latest simulator position report (ms), measured. */
  poseRoundTripMs: number | null;
  /** Player only: local time the latest simulator position was accepted by the server. */
  poseAcceptedAt: number | null;
}

/** A position of the roleplay character (simulation coordinates, never a real location). */
export interface SimulatorPose {
  nodeId: string;
  position: [number, number, number];
  headingDeg: number;
}

export interface MobileActions {
  join(joinCode: string, displayName?: string): Promise<void>;
  reportCheckpoint(checkpointId: string, source: "qr" | "manual"): Promise<void>;
  reportNode(nodeId: string, confirmJump?: boolean): Promise<void>;
  reportGeolocation(): Promise<void>;
  confirmRoute(routeId: string): Promise<void>;
  markViewed(routeId: string): void;
  requestHelp(): Promise<void>;
  reportBlocked(edgeId: string | null): Promise<void>;
  reportArrived(assemblyId: string | null): Promise<void>;
  setMobility(mobility: "standard" | "no-stairs"): Promise<void>;
  leave(): Promise<void>;
  requestNotifications(): Promise<void>;
  clearError(): void;
  /** Player only: report where the character is. Overlapping calls are coalesced (latest wins). */
  reportSimulatorPose?(pose: SimulatorPose): void;
  /** Player only: simulate a network cut of the player's phone. */
  setSimulatedNetwork?(online: boolean): void;
}

export interface MobileSource {
  getState(): ClientState;
  subscribe(listener: () => void): () => void;
  actions: MobileActions | null;
  dispose(): void;
}

const MAP_KEY = "skr-evac-map";
const DEVICE_KEY = "skr-evac-device";

function storage(kind: SourceKind): Storage | null {
  // The player and the framed tester live for this tab only; a real phone keeps its session.
  try { return kind === "device" ? window.localStorage : window.sessionStorage; } catch { return null; }
}

export function detectCapabilities(): Capabilities {
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  return {
    secureContext,
    barcodeDetector: typeof window !== "undefined" && "BarcodeDetector" in window,
    camera: secureContext && Boolean(navigator.mediaDevices?.getUserMedia),
    geolocation: secureContext && "geolocation" in navigator,
    notifications: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    serviceWorker: secureContext && "serviceWorker" in navigator,
  };
}

function randomKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shown instead of the browser's raw "Failed to fetch" / "Load failed" when the server cannot be reached. */
export const NETWORK_ERROR_TH = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบ Wi-Fi/เน็ตมือถือแล้วลองใหม่ ระหว่างนี้ทำตามคำสั่งครู เจ้าหน้าที่ และป้ายทางออก";

async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    // Network down, server stopped, or blocked by the browser: no HTTP status at all.
    throw Object.assign(new Error(NETWORK_ERROR_TH), { code: "network", status: 0 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = response.status >= 500 ? `เซิร์ฟเวอร์ขัดข้องชั่วคราว (HTTP ${response.status}) — ลองใหม่อีกครั้ง` : `ทำรายการไม่สำเร็จ (HTTP ${response.status})`;
    const error = new Error((data as { message?: string }).message ?? fallback) as Error & { code?: string; status?: number };
    error.code = (data as { error?: string }).error;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

/** Messages the dashboard host may send into the preview iframe (nothing else is accepted). */
export type HostMessage = { source: "skr-evac-host"; type: "set-network"; online: boolean };
/** Messages the preview iframe sends to its host (no tokens, no personal data). */
export type PreviewMessage =
  | { source: "skr-evac-mobile"; type: "session"; participantId: string; incidentId: string }
  | { source: "skr-evac-mobile"; type: "screen"; screen: string; routeRevision: number | null };

export function createLiveSource(options: { kind: "device" | "preview" | "player"; joinCode?: string | null; previewTicket?: string | null; incidentId?: string | null; checkpoint?: string | null }): MobileSource {
  const kind = options.kind;
  const store = storage(kind);
  const sessionKey = kind === "preview" ? `skr-evac-preview:${options.incidentId ?? "none"}`
    : kind === "player" ? `skr-evac-player:${options.incidentId ?? "none"}` : "skr-evac-session";
  const listeners = new Set<() => void>();
  let state: ClientState = {
    kind,
    session: null,
    view: null,
    map: null,
    mapNote: null,
    connection: "connecting",
    lastMessageAt: null,
    serverOffsetMs: 0,
    error: null,
    busy: false,
    simulatedOffline: false,
    pendingCheckpoint: options.checkpoint ?? null,
    capabilities: detectCapabilities(),
    confirmedRouteIds: [],
    poseRoundTripMs: null,
    poseAcceptedAt: null,
  };
  let source: EventSource | null = null;
  let poseInFlight = false;
  let pendingPose: SimulatorPose | null = null;
  let retryTimer: number | null = null;
  let disposed = false;
  const acked = new Set<string>();

  const set = (patch: Partial<ClientState>) => { if (disposed) return; state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  const read = <T,>(key: string): T | null => { try { const raw = store?.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; } };
  const write = (key: string, value: unknown) => { try { if (value === null) store?.removeItem(key); else store?.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ } };

  const deviceKey = (() => {
    const existing = read<string>(DEVICE_KEY);
    if (existing) return existing;
    const key = randomKey();
    write(DEVICE_KEY, key);
    return key;
  })();
  let clientSeq = read<number>(`${sessionKey}:seq`) ?? 0;
  const nextSeq = () => { clientSeq = Math.max(clientSeq + 1, Date.now()); write(`${sessionKey}:seq`, clientSeq); return clientSeq; };

  const notifyHost = (message: PreviewMessage) => {
    if (kind === "preview" && window.parent !== window) window.parent.postMessage(message, window.location.origin);
  };

  async function loadMap(expectedVersion?: string) {
    const cached = (() => { try { const raw = window.localStorage.getItem(MAP_KEY); return raw ? JSON.parse(raw) as MapPackage : null; } catch { return null; } })();
    if (cached && (!expectedVersion || cached.mapVersion === expectedVersion)) {
      if (!state.map || state.map.mapVersion !== cached.mapVersion) set({ map: cached, mapNote: null });
      if (expectedVersion) return;
    }
    try {
      const map = await api<MapPackage>("/api/map");
      if (disposed) return;
      try { window.localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch { /* quota */ }
      set({ map, mapNote: null });
    } catch {
      if (cached) set({ map: cached, mapNote: expectedVersion && cached.mapVersion !== expectedVersion ? "แผนที่ในเครื่องเป็นรุ่นเก่า และยังโหลดรุ่นใหม่ไม่ได้ — ใช้เป็นแผนอ้างอิงเท่านั้น" : null });
      else set({ mapNote: "ยังโหลดแผนที่ไม่ได้" });
    }
  }

  function applyView(view: ParticipantView) {
    // Older revisions arriving late never overwrite newer data.
    if (state.view && view.me.participantId === state.view.me.participantId && view.revision < state.view.revision) return;
    set({ view, lastMessageAt: Date.now(), serverOffsetMs: view.serverTime - Date.now(), connection: "online", error: null });
    if (state.map && state.map.mapVersion !== view.mapVersion) void loadMap(view.mapVersion);
    const advice = view.advice;
    if (advice && !acked.has(`received:${advice.routeId}`) && state.session) {
      acked.add(`received:${advice.routeId}`);
      void api("/api/participant/ack", { body: { routeId: advice.routeId, stage: "received" }, token: state.session.token }).catch(() => acked.delete(`received:${advice.routeId}`));
    }
  }

  function closeStream() {
    source?.close();
    source = null;
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
  }

  function openStream() {
    closeStream();
    if (disposed || !state.session || state.simulatedOffline) return;
    set({ connection: state.lastMessageAt ? "connecting" : "connecting" });
    const es = new EventSource(`/api/stream?participant=${encodeURIComponent(state.session.token)}`);
    source = es;
    es.onmessage = (event) => {
      if (disposed || source !== es || state.simulatedOffline) return;
      try {
        const message = JSON.parse(event.data) as StreamMessage;
        if (message.type === "participant") applyView(message.view);
        else if (message.type === "error" && message.code === "bad-session") { forgetSession("เซสชันนี้ถูกล้างแล้ว กรุณาเข้าร่วมใหม่"); }
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => {
      if (disposed || source !== es) return;
      set({ connection: "offline" });
      if (es.readyState === EventSource.CLOSED) {
        // Server refused the stream (e.g. session unknown after a restart) or network down.
        es.close();
        source = null;
        retryTimer = window.setTimeout(() => void verifySession(), 4000);
      }
    };
  }

  async function verifySession() {
    if (!state.session || disposed) return;
    try {
      const view = await api<ParticipantView>("/api/participant/me", { token: state.session.token });
      if (disposed) return;
      applyView(view);
      openStream();
    } catch (error) {
      if (disposed) return;
      const status = (error as { status?: number }).status;
      if (status === 401) forgetSession("เซสชันหมดอายุ (เซิร์ฟเวอร์อาจเริ่มใหม่) กรุณาเข้าร่วมรอบอีกครั้ง");
      else { set({ connection: "offline" }); retryTimer = window.setTimeout(() => void verifySession(), 5000); }
    }
  }

  function forgetSession(message: string) {
    closeStream();
    write(sessionKey, null);
    set({ session: null, view: null, connection: "error", error: message });
  }

  function startSession(session: NonNullable<ClientState["session"]>) {
    if (disposed) return;
    write(sessionKey, session);
    set({ session, error: null });
    notifyHost({ source: "skr-evac-mobile", type: "session", participantId: session.participantId, incidentId: session.incidentId });
    openStream();
    if (state.pendingCheckpoint) {
      const checkpoint = state.pendingCheckpoint;
      set({ pendingCheckpoint: null });
      void actions.reportCheckpoint(checkpoint, "qr");
    }
  }

  async function run(task: () => Promise<void>) {
    set({ busy: true, error: null });
    try { await task(); } catch (error) {
      const err = error as Error & { code?: string; status?: number };
      if (err.status === 401) forgetSession("เซสชันหมดอายุ กรุณาเข้าร่วมใหม่");
      else set({ error: err.message || "ทำรายการไม่สำเร็จ", ...(err.code === "network" ? { connection: "offline" as const } : {}) });
      if (err.code === "map-version-mismatch") void loadMap();
    } finally { set({ busy: false }); }
  }

  const token = () => {
    if (!state.session) throw new Error("ยังไม่ได้เข้าร่วมรอบ");
    if (state.simulatedOffline) throw new Error("ขาดการเชื่อมต่อ (จำลอง) — ส่งข้อมูลไม่ได้");
    return state.session.token;
  };

  const actions: MobileActions = {
    join: (joinCode, displayName) => run(async () => {
      // The framed preview and the roleplay player are test participants only; they must never
      // join a drill as a real person.
      if (options.kind !== "device") throw new Error("กรอบทดสอบเข้าร่วมได้เฉพาะด้วยบัตรผู้ทดสอบจากศูนย์ควบคุม");
      const result = await api<{ token: string; participantId: string; incidentId: string }>("/api/participant/join", {
        body: { joinCode: joinCode.trim().toUpperCase(), deviceKey, displayName: displayName?.trim() || undefined },
      });
      startSession({ token: result.token, participantId: result.participantId, incidentId: result.incidentId });
    }),
    reportCheckpoint: (checkpointId, source) => run(async () => {
      if (!state.session) { set({ pendingCheckpoint: checkpointId }); return; }
      const result = await api<{ view: ParticipantView }>("/api/participant/location", {
        // After the server flagged the position as uncertain, a new scan/pick is the person's explicit re-confirmation.
        token: token(), body: { source, checkpointId, observedAt: Date.now(), clientSeq: nextSeq(), mapVersion: state.map?.mapVersion ?? state.view?.mapVersion ?? "", confirmJump: state.view?.me.locationState === "uncertain" },
      });
      applyView(result.view);
    }),
    reportNode: (nodeId, confirmJump = false) => run(async () => {
      const result = await api<{ view: ParticipantView }>("/api/participant/location", {
        token: token(), body: { source: "manual", nodeId, observedAt: Date.now(), clientSeq: nextSeq(), mapVersion: state.map?.mapVersion ?? state.view?.mapVersion ?? "", confirmJump },
      });
      applyView(result.view);
    }),
    reportGeolocation: () => run(async () => {
      if (!state.capabilities.geolocation) throw new Error("อุปกรณ์หรือการเชื่อมต่อนี้ใช้ตำแหน่ง GPS ไม่ได้ (ต้องเปิดผ่าน HTTPS และอนุญาตตำแหน่ง)");
      const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }))
        .catch((error: GeolocationPositionError) => { throw new Error(error.code === 1 ? "ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง — ใช้ QR หรือเลือกจุดเองได้" : "อ่านตำแหน่งไม่สำเร็จ"); });
      const result = await api<{ view: ParticipantView }>("/api/participant/location", {
        token: token(), body: {
          source: "geolocation", observedAt: position.timestamp, clientSeq: nextSeq(), mapVersion: state.map?.mapVersion ?? state.view?.mapVersion ?? "",
          accuracyM: position.coords.accuracy, geo: { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy },
        },
      });
      applyView(result.view);
    }),
    confirmRoute: (routeId) => run(async () => {
      await api("/api/participant/ack", { token: token(), body: { routeId, stage: "confirmed" } });
      set({ confirmedRouteIds: [...state.confirmedRouteIds, routeId].slice(-20) });
    }),
    markViewed: (routeId) => {
      if (!state.session || state.simulatedOffline || acked.has(`viewed:${routeId}`) || document.visibilityState !== "visible") return;
      acked.add(`viewed:${routeId}`);
      void api("/api/participant/ack", { token: state.session.token, body: { routeId, stage: "viewed" } }).catch(() => acked.delete(`viewed:${routeId}`));
    },
    requestHelp: () => run(async () => { await api("/api/participant/help", { token: token(), body: {} }); }),
    reportBlocked: (edgeId) => run(async () => { await api("/api/participant/blocked", { token: token(), body: { edgeId: edgeId ?? undefined } }); }),
    reportArrived: (assemblyId) => run(async () => { await api("/api/participant/arrived", { token: token(), body: { assemblyId: assemblyId ?? undefined } }); }),
    setMobility: (mobility) => run(async () => { await api("/api/participant/profile", { token: token(), body: { mobility } }); }),
    leave: () => run(async () => {
      if (state.session) await api("/api/participant/leave", { token: state.session.token, body: {} }).catch(() => undefined);
      forgetSession("");
      set({ error: null, connection: "connecting" });
    }),
    requestNotifications: () => run(async () => {
      if (typeof Notification === "undefined") throw new Error("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");
      const result = await Notification.requestPermission();
      set({ capabilities: { ...state.capabilities, notifications: result } });
    }),
    clearError: () => set({ error: null }),
  };

  if (kind === "player") {
    const sendPose = async (pose: SimulatorPose) => {
      if (disposed || !state.session || state.simulatedOffline) return;
      poseInFlight = true;
      const startedAt = performance.now();
      try {
        const result = await api<{ view: ParticipantView }>("/api/participant/location", {
          token: state.session.token,
          body: { source: "simulator", nodeId: pose.nodeId, position: pose.position, headingDeg: pose.headingDeg, observedAt: Date.now(), clientSeq: nextSeq(), mapVersion: state.map?.mapVersion ?? state.view?.mapVersion ?? "" },
        });
        if (disposed) return;
        set({ poseRoundTripMs: Math.round(performance.now() - startedAt), poseAcceptedAt: Date.now() });
        applyView(result.view);
      } catch (error) {
        if (disposed) return;
        const err = error as Error & { status?: number };
        if (err.status === 401) forgetSession("เซสชันผู้เล่นหมดอายุ");
        else if (err.status !== 429) set({ error: err.message || "ส่งตำแหน่งจำลองไม่สำเร็จ" });
      } finally {
        poseInFlight = false;
        const next = pendingPose;
        pendingPose = null;
        if (next && !disposed) void sendPose(next);
      }
    };
    actions.reportSimulatorPose = (pose) => {
      if (disposed || !state.session || state.simulatedOffline) return;
      if (poseInFlight) { pendingPose = pose; return; }
      void sendPose(pose);
    };
    actions.setSimulatedNetwork = (online) => {
      if (disposed) return;
      if (!online) { pendingPose = null; closeStream(); set({ simulatedOffline: true, connection: "offline" }); }
      else { set({ simulatedOffline: false }); void verifySession(); }
    };
  }

  // Preview-only: the host may simulate a network cut. Same origin + our parent only.
  const onHostMessage = (event: MessageEvent) => {
    if (kind !== "preview" || event.origin !== window.location.origin || event.source !== window.parent) return;
    const data = event.data as Partial<HostMessage> | null;
    if (!data || data.source !== "skr-evac-host" || data.type !== "set-network" || typeof data.online !== "boolean") return;
    if (!data.online) { closeStream(); set({ simulatedOffline: true, connection: "offline" }); }
    else { set({ simulatedOffline: false }); void verifySession(); }
  };
  const onOnline = () => { if (state.session && !state.simulatedOffline) void verifySession(); };
  const onOffline = () => set({ connection: "offline" });
  window.addEventListener("message", onHostMessage);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // Boot: map first (works offline from cache), then the saved session or the preview ticket.
  void (async () => {
    await loadMap();
    if (disposed) return;
    const saved = read<NonNullable<ClientState["session"]>>(sessionKey);
    if (saved && (!options.incidentId || saved.incidentId === options.incidentId)) {
      set({ session: saved });
      notifyHost({ source: "skr-evac-mobile", type: "session", participantId: saved.participantId, incidentId: saved.incidentId });
      await verifySession();
      return;
    }
    if ((kind === "preview" || kind === "player") && options.previewTicket) {
      await run(async () => {
        const result = await api<{ token: string; participantId: string; incidentId: string }>("/api/participant/join", {
          body: kind === "player"
            ? { previewTicket: options.previewTicket, deviceKey: `${deviceKey}-player`, displayName: "ผู้เล่นสวมบท (SIMULATOR)" }
            : { previewTicket: options.previewTicket, deviceKey: `${deviceKey}-preview`, displayName: "ผู้ทดสอบ (กรอบจำลอง)" },
        });
        startSession({ token: result.token, participantId: result.participantId, incidentId: result.incidentId });
      });
      return;
    }
    if (options.joinCode && kind === "device") { await actions.join(options.joinCode); return; }
    set({ connection: "online" });
  })();

  return {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    actions,
    dispose: () => {
      disposed = true;
      closeStream();
      window.removeEventListener("message", onHostMessage);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      listeners.clear();
    },
  };
}

/** Staff read-only view of an existing session: same screens, no actions, no position sending. */
export function createReadonlySource(view: ParticipantView | null, map: MapPackage | null, lastMessageAt: number | null): MobileSource {
  const state: ClientState = {
    kind: "readonly", session: null, view, map, mapNote: null, connection: view ? "online" : "connecting",
    lastMessageAt, serverOffsetMs: view ? view.serverTime - Date.now() : 0, error: null, busy: false, simulatedOffline: false,
    pendingCheckpoint: null, capabilities: detectCapabilities(), confirmedRouteIds: [], poseRoundTripMs: null, poseAcceptedAt: null,
  };
  return { getState: () => state, subscribe: () => () => undefined, actions: null, dispose: () => undefined };
}

/** Is the advice still current (not expired, connection alive)? */
export function adviceIsCurrent(advice: RouteAdvice | null, state: ClientState): boolean {
  if (!advice) return false;
  const serverNow = Date.now() + state.serverOffsetMs;
  return state.connection === "online" && !state.simulatedOffline && serverNow < advice.expiresAt;
}
