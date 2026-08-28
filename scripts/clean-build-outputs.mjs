#!/usr/bin/env node
/** Remove only repository-derived build and package assembly outputs. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const derivedPaths = [
  "apps/server/dist",
  "apps/server/tsconfig.tsbuildinfo",
  "apps/web/dist",
  "apps/web/tsconfig.app.tsbuildinfo",
  "apps/web/tsconfig.node.tsbuildinfo",
  "packages/contracts/dist",
  "packages/fieldnote/server",
  "packages/fieldnote/web"
];

for (const relativePath of derivedPaths) {
  fs.rmSync(path.join(repositoryRoot, relativePath), { recursive: true, force: true });
}

console.log("fieldnote: cleaned derived build outputs");
