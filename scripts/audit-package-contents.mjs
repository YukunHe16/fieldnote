#!/usr/bin/env node
/** Audit the exact file list pnpm would publish, without creating a tarball. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repositoryRoot, "packages/fieldnote");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const packed = spawnSync(pnpm, ["--dir", packageRoot, "pack", "--dry-run", "--json"], {
  cwd: repositoryRoot,
  encoding: "utf8"
});

if (packed.error) {
  console.error(`fieldnote: could not run pnpm pack: ${packed.error.message}`);
  process.exit(1);
}
if (packed.status !== 0) {
  process.stdout.write(packed.stdout ?? "");
  process.stderr.write(packed.stderr ?? "");
  process.exit(packed.status ?? 1);
}

const jsonStart = packed.stdout.split(/\r?\n/).findIndex((line) => line.trim() === "{");
if (jsonStart < 0) {
  console.error("fieldnote: pnpm pack did not return a JSON file list");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(packed.stdout.split(/\r?\n/).slice(jsonStart).join("\n"));
} catch (error) {
  console.error(`fieldnote: could not parse pnpm pack output: ${error.message}`);
  process.exit(1);
}

const files = new Set(manifest.files.map((entry) => entry.path.replaceAll("\\", "/")));
const required = [
  "package.json",
  "bin/fieldnote.mjs",
  "server/dist/index.js",
  "server/dist/build-info.json",
  "server/dist/config.js",
  "server/dist/doctor.js",
  "web/dist/index.html"
];
const missing = required.filter((entry) => !files.has(entry));
const forbidden = [...files].filter(
  (entry) => /^server\/dist\/admissions-[^/]+$/.test(entry) || entry.startsWith("server/plugins/graduate-admissions/")
);

if (missing.length > 0 || forbidden.length > 0) {
  console.error("fieldnote: package contents audit failed");
  for (const entry of missing) console.error(`  missing: ${entry}`);
  for (const entry of forbidden) console.error(`  forbidden: ${entry}`);
  process.exit(1);
}

console.log(`fieldnote: package contents audit passed (${files.size} files)`);
