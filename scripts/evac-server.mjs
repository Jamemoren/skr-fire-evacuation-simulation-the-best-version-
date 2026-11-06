// Builds and starts the evacuation guidance backend (cross-platform, no extra dependencies).
//   node scripts/evac-server.mjs [--host=0.0.0.0] [--port=8787] [--static=dist] [--no-build]
// Options can also be given as environment variables (EVAC_HOST, EVAC_PORT, EVAC_STATIC_DIR, …).
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : "1"];
}));
const map = { host: "EVAC_HOST", port: "EVAC_PORT", static: "EVAC_STATIC_DIR", data: "EVAC_DATA_DIR" };
for (const [key, name] of Object.entries(map)) if (args[key]) process.env[name] = args[key];

const out = resolve(root, ".server-build");
if (!args["no-build"]) {
  execFileSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(root, "tsconfig.server.json")], { cwd: root, stdio: "inherit" });
}
mkdirSync(out, { recursive: true });
// The project is "type": "module"; the compiled server is CommonJS.
writeFileSync(resolve(out, "package.json"), JSON.stringify({ type: "commonjs" }));
if (args["build-only"]) process.exit(0);
process.chdir(root);
createRequire(import.meta.url)(resolve(out, "server/index.js"));
