import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// Backend for the mobile guidance (npm run server). Override with EVAC_API_URL.
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const API_TARGET = nodeEnv.EVAC_API_URL ?? "http://127.0.0.1:8787";
const apiProxy: Record<string, ProxyOptions> = {
  // xfwd: the backend then sees phones as remote clients, never as "same machine" staff.
  "/api": { target: API_TARGET, changeOrigin: false, xfwd: true, ws: false },
};

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
  plugins: [react(), mobileRoute()],
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
