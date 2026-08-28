#!/usr/bin/env node
/** Write source identity next to the compiled server so evals can verify the running build. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

const git = (args) =>
  execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();

let gitSha = "unknown";
let gitDirty = null;
try {
  gitSha = git(["rev-parse", "HEAD"]);
  gitDirty = git(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
} catch {
  // Source archives have no Git identity; the server reports that explicitly.
}

const out = path.join(repositoryRoot, "apps/server/dist/build-info.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({ version: packageJson.version, gitSha, gitDirty }, null, 2)}\n`);
console.log(`fieldnote: wrote server build identity ${gitSha.slice(0, 12)}${gitDirty ? " (dirty)" : ""}`);
