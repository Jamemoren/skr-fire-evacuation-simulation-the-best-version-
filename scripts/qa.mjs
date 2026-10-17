import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "package.json",
  "index.html",
  "vite.config.ts",
  "src/main.tsx",
  "src/App.tsx",
  "src/store.ts",
  "src/components/SceneCanvas.tsx",
  "src/components/ModelPanel.tsx",
  "src/components/ValidationPanel.tsx",
  "src/components/MeasurementLayer.tsx",
  "src/utils/validation.ts",
  "src/utils/coordinates.ts",
];

const errors = [];
for (const file of required) {
  if (!existsSync(join(root, file))) errors.push(`ไม่พบไฟล์: ${file}`);
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const script of ["dev", "build", "typecheck"]) {
  if (!packageJson.scripts?.[script]) errors.push(`package.json ไม่มี script: ${script}`);
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sourceFiles = walk(join(root, "src")).filter((file) => [".ts", ".tsx", ".css"].includes(extname(file)));
const forbidden = [/\bTODO\b/, /\bFIXME\b/, /console\.(log|warn|error)\s*\(/];
for (const file of sourceFiles) {
  const content = readFileSync(file, "utf8");
  if (!content.trim()) errors.push(`ไฟล์ว่าง: ${file.slice(root.length + 1)}`);
  for (const pattern of forbidden) {
    if (pattern.test(content)) errors.push(`พบ ${pattern} ใน ${file.slice(root.length + 1)}`);
  }
  if ([".ts", ".tsx"].includes(extname(file))) {
    const importPattern = /from\s+["'](\.{1,2}\/[^"']+)["']/g;
    for (const match of content.matchAll(importPattern)) {
      const base = resolve(dirname(file), match[1]);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")];
      if (!candidates.some(existsSync)) errors.push(`Import หาไฟล์ไม่พบ: ${match[1]} ใน ${file.slice(root.length + 1)}`);
    }
  }
}

if (errors.length) {
  console.error("QA ไม่ผ่าน:\n" + errors.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`QA ผ่าน: ${sourceFiles.length} source files, required files ครบ, relative imports ครบ`);
