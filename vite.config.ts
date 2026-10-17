import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-core": ["react", "react-dom", "zustand"],
          three: ["three"],
          "react-three-fiber": ["@react-three/fiber"],
          drei: ["@react-three/drei"],
        },
      },
    },
  },
});
