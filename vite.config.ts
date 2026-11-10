import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// Backend for the mobile guidance (npm run server). Override with EVAC_API_URL.
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const API_TARGET = nodeEnv.EVAC_API_URL ?? "http://127.0.0.1:8787";
const apiProxy: Record<string, ProxyOptions> = {
  // xfwd: the backend then sees phones as remote clients, never as "same machine" staff.
  "/api": {
    target: API_TARGET, changeOrigin: false, xfwd: true, ws: false,
    // No backend running: answer the page's backend probe plainly instead of a 500, so the web app
    // switches to its in-browser backend without an error in the console. Other calls still fail
    // loudly (they are never sent while the in-browser backend is in use).
    configure: (proxy) => {
      (proxy as unknown as { on: (event: "error", listener: (error: Error, req: { url?: string }, res: unknown) => void) => void }).on("error", (_error, req, res) => {
        const response = res as unknown as { headersSent?: boolean; writeHead?: (status: number, headers: Record<string, string>) => void; end?: (body: string) => void };
        if (!response.writeHead || response.headersSent) return;
        const probe = (req.url ?? "").startsWith("/api/health");
        response.writeHead(probe ? 200 : 502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end?.(JSON.stringify(probe ? { ok: false, backend: "none" } : { error: "no-backend", message: "ยังไม่ได้รันเซิร์ฟเวอร์ (npm run server)" }));
      });
    },
  },
};

interface NetSocket { once(event: "connect" | "error" | "timeout", listener: () => void): NetSocket; setTimeout(ms: number): void; destroy(): void }
type NetModule = { connect(options: { host: string; port: number }): NetSocket };
type ProbeResponse = { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void };

/**
 * /api/health with no backend running: answer "none" here, without proxying, so the dev server
 * does not print "http proxy error … ECONNREFUSED" every time a page opens and uses its in-browser
 * backend. With a backend running the request is proxied as before.
 */
function backendProbe(): Plugin {
  const match = /^(https?):\/\/(\[[^\]]+\]|[^:/]+)(?::(\d+))?/.exec(API_TARGET);
  const host = (match?.[2] ?? "127.0.0.1").replace(/^\[|\]$/g, ""), port = Number(match?.[3] || (match?.[1] === "https" ? 443 : 80));
  const reachable = async () => {
    const net = await import(/* @vite-ignore */ "node:" + "net") as unknown as NetModule;
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(400);
      socket.once("connect", () => done(true)).once("error", () => done(false)).once("timeout", () => done(false));
    });
  };
  const middleware = (req: { url?: string }, res: ProbeResponse, next: () => void) => {
    if (!req.url?.startsWith("/api/health")) { next(); return; }
    void reachable().then((ok) => {
      if (ok) { next(); return; }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ ok: false, backend: "none" }));
    });
  };
  return {
    name: "skr-backend-probe",
    configureServer(server) { server.middlewares.use(middleware as never); },
    configurePreviewServer(server) { server.middlewares.use(middleware as never); },
  };
}

/** /mobile (and /mobile?join=…) serves the separate mobile page, in dev and in preview. */
function mobileRoute(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && /^\/mobile(\/|\?|$)/.test(req.url) && !req.url.startsWith("/mobile.") && !req.url.startsWith("/mobile-sw")) {
      req.url = `/mobile.html${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
    }
    next();
  };
  return {
    name: "skr-mobile-route",
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

export default defineConfig({
  plugins: [react(), mobileRoute(), backendProbe()],
  server: {
    host: true,
    port: 5173,
    proxy: apiProxy,
  },
  preview: { proxy: apiProxy },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        // Relative to the project root (npm scripts run there).
        main: "index.html",
        mobile: "mobile.html",
      },
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("@react-three/fiber")) return "react-three-fiber";
          if (id.includes("@react-three/drei")) return "drei";
          if (/node_modules\/(react|react-dom|scheduler|zustand)\//.test(id)) return "react-core";
          return undefined;
        },
      },
    },
  },
});
