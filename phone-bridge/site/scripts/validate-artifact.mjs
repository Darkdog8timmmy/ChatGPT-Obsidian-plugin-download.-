import { readFileSync, existsSync } from "node:fs";

const root = new URL("../dist/", import.meta.url);
const manifestPath = new URL(".openai/hosting.json", root);
const workerPath = new URL("server/index.js", root);
if (!existsSync(manifestPath) || !existsSync(workerPath)) throw new Error("Required Worker deployment files are missing.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest.project_id) throw new Error("hosting.json is missing its Site project_id.");
if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.includes("mcp")) throw new Error("hosting.json must declare the mcp capability.");
if (manifest.r2 !== "BUCKET") throw new Error("hosting.json must declare the BUCKET R2 binding.");
const worker = readFileSync(workerPath, "utf8");
for (const marker of ["server/discover", "tools/list", "tools/call", "/phone/poll", "/phone/complete"]) {
  if (!worker.includes(marker)) throw new Error(`Worker is missing ${marker}.`);
}
console.log("Deployment artifact structure is valid.");
