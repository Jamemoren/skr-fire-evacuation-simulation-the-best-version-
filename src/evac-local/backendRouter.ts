/**
 * Chooses where /api requests go, once per page:
 *   - "server"  — a backend answers /api/health (npm run server, the Vite proxy, or Render via Vercel);
 *   - "browser" — nobody answers: the same API runs inside this page (localBackend.ts), so the
 *                 simulated phone works with only the website running.
 * Override with ?backend=server or ?backend=browser. Every existing caller keeps using
 * fetch("/api/…") and new EventSource("/api/stream…"); nothing else changes.
 *
 * The phone preview is an iframe on the same origin; it borrows this page's router
 * (window.__evacBackend) so both sides talk to the same backend.
 */
import type { LocalBackend } from "./localBackend";

export type BackendMode = "checking" | "server" | "browser";

export interface EvacBackendBridge {
  fetch: typeof window.fetch;
  EventSource: typeof window.EventSource;
  mode(): BackendMode;
  ready: Promise<Exclude<BackendMode, "checking">>;
}

declare global {
  interface Window { __evacBackend?: EvacBackendBridge }
}

const PROBE_TIMEOUT_MS = 2500;
let mode: BackendMode = "checking";
const listeners = new Set<() => void>();
export const getBackendMode = () => mode;
export function subscribeBackendMode(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const setMode = (next: BackendMode) => { mode = next; listeners.forEach((listener) => listener()); };

const isApi = (url: URL) => url.origin === window.location.origin && url.pathname.startsWith("/api/");
const toUrl = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : String(input), window.location.href);

async function probe(realFetch: typeof window.fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await realFetch("/api/health", { cache: "no-store", signal: controller.signal });
    if (!response.ok) return false;
    const data = await response.json() as { ok?: boolean };
    return data.ok === true;
  } catch { return false; } finally { window.clearTimeout(timer); }
}

/** Wraps one EventSource so it can be created before the backend is known. */
function makeEventSourceClass(ready: Promise<"server" | "browser">, RealEventSource: typeof window.EventSource, local: () => Promise<LocalBackend>) {
  class RoutedEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials: boolean;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private inner: EventSource | null = null;
    private closed = false;

    constructor(input: string | URL, init?: EventSourceInit) {
      super();
      const url = new URL(String(input), window.location.href);
      this.url = url.href;
      this.withCredentials = Boolean(init?.withCredentials);
      const attach = (inner: EventSource) => {
        if (this.closed) { inner.close(); return; }
        this.inner = inner;
        inner.onopen = () => this.relay(new Event("open"));
        inner.onmessage = (event) => this.relay(new MessageEvent("message", { data: event.data, lastEventId: event.lastEventId }));
        inner.onerror = () => this.relay(new Event("error"));
      };
      if (!isApi(url)) { attach(new RealEventSource(url, init)); return; }
      void ready.then(async (chosen) => attach(chosen === "server" ? new RealEventSource(url, init) : new (await local()).EventSource(url)));
    }

    get readyState() { return this.closed ? 2 : this.inner?.readyState ?? 0; }

    private relay(event: Event) {
      if (this.closed) return;
      this.dispatchEvent(event);
      if (event.type === "open") this.onopen?.(event);
      else if (event.type === "message") this.onmessage?.(event as MessageEvent);
      else if (event.type === "error") this.onerror?.(event);
    }

    close() { this.closed = true; this.inner?.close(); }
  }
  return RoutedEventSource as unknown as typeof window.EventSource;
}

let installed: EvacBackendBridge | null = null;

/** Install once in the dashboard page (main.tsx), before any component talks to /api. */
export function installBackendRouter(): EvacBackendBridge {
  if (installed) return installed;
  const realFetch = window.fetch.bind(window);
  const RealEventSource = window.EventSource;
  const forced = new URLSearchParams(window.location.search).get("backend");
  let localPromise: Promise<LocalBackend> | null = null;
  const local = () => (localPromise ??= import("./localBackend").then((module) => module.createLocalBackend()));
  const ready: Promise<"server" | "browser"> = (forced === "server" ? Promise.resolve(true) : forced === "browser" ? Promise.resolve(false) : probe(realFetch))
    .then((serverUp) => { const chosen = serverUp ? "server" as const : "browser" as const; setMode(chosen); return chosen; });

  const routedFetch: typeof window.fetch = async (input, init) => {
    const url = toUrl(input);
    if (!isApi(url)) return await realFetch(input, init);
    if ((await ready) === "server") return await realFetch(input, init);
    const requestInit: RequestInit = input instanceof Request
      ? { method: input.method, headers: input.headers, body: init?.body ?? (input.method === "GET" || input.method === "HEAD" ? undefined : await input.clone().text()), ...init }
      : init ?? {};
    return await (await local()).fetch(url, requestInit);
  };
  const RoutedEventSource = makeEventSourceClass(ready, RealEventSource, local);
  window.fetch = routedFetch;
  window.EventSource = RoutedEventSource;
  installed = { fetch: routedFetch, EventSource: RoutedEventSource, mode: () => mode, ready };
  window.__evacBackend = installed;
  return installed;
}

/**
 * For the phone page: when shown inside the dashboard (same origin), use the dashboard's backend.
 * Returns false on a real phone / standalone page, which keeps talking to the server directly.
 */
export function adoptParentBackend(): boolean {
  let bridge: EvacBackendBridge | undefined;
  try { bridge = window.parent !== window ? window.parent.__evacBackend : undefined; } catch { bridge = undefined; }
  if (!bridge) return false;
  const parentBridge = bridge;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = toUrl(input);
    return isApi(url) ? parentBridge.fetch(url.href, init) : realFetch(input, init);
  };
  window.EventSource = parentBridge.EventSource;
  window.__evacBackend = parentBridge;
  void parentBridge.ready.then((chosen) => setMode(chosen));
  return true;
}
