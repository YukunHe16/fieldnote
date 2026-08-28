#!/usr/bin/env node
/**
 * Copy the workspace build outputs into the publishable `fieldnote` package.
 *
 * The layout is load-bearing and mirrors the paths the server resolves from its own
 * dist location:
 *   server/dist     — `<serverDist>/../../web/dist` finds the web bundle (app.ts)
 *   server/plugins  — `<serverDist>/../plugins` is BUNDLED_PLUGIN_ROOT (document-skills.ts)
 *   web/dist        — static site served in production single-port mode
 * Every target is replaced wholesale so a direct `npm pack` / `npm publish` cannot
 * retain files from an older assembly. The repository build separately cleans its
 * source output directories before compiling.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

const copies = [
  { source: "apps/server/dist", target: "server/dist" },
  { source: "apps/server/plugins", target: "server/plugins" },
  { source: "apps/web/dist", target: "web/dist" }
].map((entry) => ({
  ...entry,
  from: path.join(repositoryRoot, entry.source),
  to: path.join(packageRoot, entry.target)
}));

const missing = copies.filter((entry) => !fs.existsSync(entry.from));
if (missing.length > 0) {
  console.error("fieldnote: 缺少构建产物 / missing build output:");
  for (const entry of missing) console.error(`  - ${entry.from}`);
  console.error("");
  console.error("请先在仓库根目录运行 `pnpm build` 再打包。");
  console.error("Run `pnpm build` at the repository root before packing.");
  process.exit(1);
}

for (const entry of copies) {
  fs.rmSync(entry.to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(entry.to), { recursive: true });
  fs.cpSync(entry.from, entry.to, { recursive: true });
  console.log(`fieldnote: ${entry.source} -> ${entry.target}`);
}

console.log("fieldnote: 打包内容已就绪 / package contents assembled");
