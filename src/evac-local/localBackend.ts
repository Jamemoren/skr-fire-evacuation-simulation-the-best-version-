/**
 * In-browser backend: the very same IncidentService and API routes as the Node server
 * (server/apiCore.ts), running inside this page. Used when no server answers, so the website's
 * simulated phone, the staff panel and the roleplay phone work with just the website.
 *
 * Scope (stated in the UI too): everything stays in this browser tab and is lost on reload.
 * A real phone on another device cannot join — that still needs the server (npm run server / Render).
 */
import { ApiError, IncidentService, randomHex } from "../../server/incidentService";
import { createApiCore, type ApiOutcome, type StreamSink } from "../../server/apiCore";
import type { EventLogEntry, StreamMessage } from "../evac/protocol";

export interface LocalBackend {
  fetch(url: URL, init?: RequestInit): Promise<Response>;
  EventSource: new (url: string | URL) => EventSource;
  log: EventLogEntry[];
  /** Stop the backend's timer (a backend made for one demo). The page's own backend never stops. */
  dispose(): void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function headerRecord(init?: RequestInit): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!init?.headers) return out;
  new Headers(init.headers).forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

async function bodyText(init?: RequestInit): Promise<string> {
  const body = init?.body;
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Blob) return await body.text();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBuffer);
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

export function createLocalBackend(): LocalBackend {
  const log: EventLogEntry[] = [];
  const service = new IncidentService({
    liveEnabled: false,
    liveReadiness: [
      { id: "browser", label: "กำลังใช้ระบบจำลองในเบราว์เซอร์ (ไม่มีเซิร์ฟเวอร์) — ใช้ได้เฉพาะการจำลอง", ok: false },
    ],
    log: (entry) => { log.push(entry); if (log.length > 2000) log.splice(0, log.length - 2000); },
  });
  const api = createApiCore({
    service,
    staffToken: randomHex(18),
    sensorKey: null,
    allowLoopbackStaff: true,
    liveEnabled: false,
    // Nothing crosses a network here; a plain comparison is enough.
    safeEqual: (a, b) => a === b,
    randomHex,
    // One page drives every simulated phone and bot: lift the per-address limits like a load test.
    rateScale: 50,
    health: () => ({ backend: "browser", tls: false }),
    schedule: (fn, delay) => { window.setTimeout(fn, Math.max(0, delay)); },
  });
  const ticker = window.setInterval(() => service.tick(), 5_000);

  async function call(url: URL, method: string, init?: RequestInit): Promise<ApiOutcome> {
    const text = await bodyText(init);
    return await api.handle({
      method,
      url,
      headers: headerRecord(init),
      clientAddress: "browser",
      loopback: true,
      // Same rejections as the HTTP adapter: oversized → 413, not a JSON object → 400.
      readJson: async (limit = 64 * 1024) => {
        if (!text) return {};
        if (new Blob([text]).size > limit) throw new ApiError(413, "too-large", "ข้อมูลใหญ่เกินกำหนด");
        try {
          const parsed = JSON.parse(text) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          return parsed as Record<string, unknown>;
        } catch { throw new ApiError(400, "bad-json", "รูปแบบข้อมูลไม่ถูกต้อง"); }
      },
    });
  }

  async function localFetch(url: URL, init?: RequestInit): Promise<Response> {
    const outcome = await call(url, (init?.method ?? "GET").toUpperCase(), init);
    if (outcome.kind === "not-modified") return new Response(null, { status: 304, headers: outcome.headers });
    if (outcome.kind === "stream") return new Response(JSON.stringify({ error: "use-eventsource", message: "ใช้ EventSource สำหรับ /api/stream" }), { status: 400, headers: JSON_HEADERS });
    return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { ...JSON_HEADERS, ...(outcome.headers ?? {}) } });
  }

  /** EventSource over the in-page API: same events and closing behaviour as the SSE server. */
  class LocalEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private detach: (() => void) | null = null;
    private closed = false;

    constructor(input: string | URL) {
      super();
      const url = new URL(String(input), window.location.href);
      this.url = url.href;
      void call(url, "GET").then((outcome) => {
        if (this.closed) return;
        if (outcome.kind !== "stream") { this.fail(); return; }
        this.readyState = 1;
        this.emit(new Event("open"));
        // Deliver asynchronously, like a network stream: never re-enter the service from its own change callback.
        const sink: StreamSink = {
          send: (id: number, message: StreamMessage) => {
            const data = JSON.stringify(message);
            window.setTimeout(() => { if (!this.closed) this.emit(new MessageEvent("message", { data, lastEventId: String(id) })); }, 0);
          },
          comment: () => undefined,
          end: () => { window.setTimeout(() => this.fail(), 0); },
        };
        this.detach = outcome.attach(sink);
      });
    }

    private emit(event: Event) {
      this.dispatchEvent(event);
      if (event.type === "open") this.onopen?.(event);
      else if (event.type === "message") this.onmessage?.(event as MessageEvent);
      else if (event.type === "error") this.onerror?.(event);
    }

    /** A refused or ended stream: CLOSED + error, as a browser reports a server that hung up. */
    private fail() {
      if (this.closed) return;
      this.release();
      this.readyState = 2;
      this.emit(new Event("error"));
    }

    private release() {
      this.closed = true;
      const detach = this.detach;
      this.detach = null;
      detach?.();
    }

    close() {
      this.release();
      this.readyState = 2;
    }
  }

  return { fetch: localFetch, EventSource: LocalEventSource as unknown as new (url: string | URL) => EventSource, log, dispose: () => window.clearInterval(ticker) };
}
