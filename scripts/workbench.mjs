#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "doctor";
const skipInstall = process.argv.includes("--skip-install");
const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

const paint = (code, value) => (useColor ? `\u001b[${code}m${value}\u001b[0m` : value);
const ok = (value) => console.log(`${paint("32", "✓")} ${value}`);
const warn = (value) => console.log(`${paint("33", "!")} ${value}`);
const fail = (value) => console.log(`${paint("31", "✗")} ${value}`);
const info = (value) => console.log(`${paint("36", "→")} ${value}`);

/** Anthropic's document skills are not redistributed here; they are fetched on demand. */
const OFFICE_SKILL_NAMES = ["docx", "pdf", "xlsx"];
const OFFICE_SKILLS_TARBALL = "https://codeload.github.com/anthropics/skills/tar.gz/refs/heads/main";
const OFFICE_SKILLS_HOME = "https://github.com/anthropics/skills";

if (command === "setup") {
  await setup();
} else if (command === "doctor") {
  await doctor();
} else if (command === "run-local") {
  await runLocal();
} else if (command === "install-office-skills") {
  await installOfficeSkills();
} else {
  console.error(`Unknown command: ${command}. Use setup, doctor, run-local, or install-office-skills.`);
  process.exitCode = 1;
}

async function setup() {
  console.log(`\n${paint("1", "Fieldnote setup")}\n`);
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    fail(`Node.js ${process.versions.node} is too old; install Node.js 20 or newer.`);
    process.exitCode = 1;
    return;
  }
  ok(`Node.js ${process.versions.node}`);

  const envPath = path.join(repositoryRoot, ".env");
  if (fs.existsSync(envPath)) {
    ok("Existing .env preserved");
  } else {
    fs.copyFileSync(path.join(repositoryRoot, ".env.example"), envPath, fs.constants.COPYFILE_EXCL);
    ok("Created .env from .env.example");
  }
  fs.mkdirSync(path.join(repositoryRoot, "data", "workspaces"), { recursive: true });
  ok("Data and conversation workspace directories are ready");

  if (!skipInstall && !fs.existsSync(path.join(repositoryRoot, "node_modules"))) {
    info("Dependencies are not installed; running pnpm install…");
    const result = spawnSync("pnpm", ["install"], { cwd: repositoryRoot, stdio: "inherit" });
    if (result.status !== 0) {
      fail("Dependency installation failed. Fix the pnpm error, then run pnpm setup again.");
      process.exitCode = 1;
      return;
    }
  } else if (skipInstall) {
    warn("Dependency installation skipped by --skip-install");
  } else {
    ok("Dependencies are already installed");
  }

  await doctor({ heading: false });
  if (!process.exitCode) {
    console.log(
      `\n${paint("1", "Ready.")} Run ${paint("36", "pnpm dev")} and open ${paint("36", "http://127.0.0.1:5173")}\n`
    );
  }
}

async function runLocal() {
  const apiPort = Number(getArgValue("--api-port") ?? process.env.PORT ?? "8787");

  if (!Number.isFinite(apiPort)) {
    fail("Invalid --api-port value. Use an integer port.");
    process.exitCode = 1;
    return;
  }

  const skipBuild = process.argv.includes("--skip-build");
  if (!skipBuild) {
    info("Building contracts, server, and web bundles…");
    const build = spawnSync("pnpm", ["build"], {
      cwd: repositoryRoot,
      stdio: "inherit"
    });
    if (build.status !== 0) {
      fail("Build failed; aborting start.");
      process.exitCode = 1;
      return;
    }
  } else if (!fs.existsSync(path.join(repositoryRoot, "apps", "server", "dist", "index.js"))) {
    fail("apps/server/dist is missing; run without --skip-build first.");
    process.exitCode = 1;
    return;
  }

  const children = [];
  let shuttingDown = false;

  const stopAll = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGINT");
      }
    }
  };

  const onChildExit = (name) => (code, signal) => {
    if (shuttingDown) return;
    const status = signal ? `signal ${signal}` : `code ${code}`;
    warn(`\n${name} stopped (${status}); shutting down the rest.`);
    stopAll();
    if (Number.isInteger(code)) process.exitCode = code;
  };

  const spawnChild = (name, args, env = {}) => {
    const proc = spawn("pnpm", args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    proc.on("error", (error) => {
      fail(`${name} failed to start: ${error.message}`);
      process.exitCode = 1;
      stopAll();
    });
    proc.once("exit", onChildExit(name));
    return proc;
  };

  const backend = spawnChild("server", ["--filter", "@fieldnote/server", "start"], {
    NODE_ENV: "production",
    PORT: String(apiPort)
  });
  children.push(backend);

  info("Local production server starting (single port, serves the built web UI):");
  info(`Open -> http://127.0.0.1:${apiPort}`);
  console.log("Press Ctrl+C to stop.");

  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);
}

/** Where on-demand plugins are installed; mirrors apps/server/src/document-skills.ts. */
function runtimePluginRoot() {
  return process.env.FIELDNOTE_RUNTIME_PLUGINS ?? path.join(repositoryRoot, "data", ".runtime-plugins");
}

/** Returns the directory holding the office skills, or null when they are not installed. */
function officeSkillsLocation() {
  const roots = [
    path.join(repositoryRoot, "apps", "server", "plugins", "document-skills"),
    path.join(runtimePluginRoot(), "document-skills")
  ];
  for (const root of roots) {
    if (OFFICE_SKILL_NAMES.every((name) => fs.existsSync(path.join(root, "skills", name, "SKILL.md")))) {
      return root;
    }
  }
  return null;
}

function askYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.readable) {
      resolve(false);
      return;
    }
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      cleanup();
      resolve(/^\s*y(es)?\s*$/i.test(String(chunk)));
    };
    const onEnd = () => {
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
    process.stdin.once("end", onEnd);
  });
}

/** Depth-limited search for skill directories named docx/pdf/xlsx that actually carry a SKILL.md. */
function findOfficeSkillDirectories(root) {
  const found = new Map();
  const walk = (directory, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = path.join(directory, entry.name);
      if (
        OFFICE_SKILL_NAMES.includes(entry.name) &&
        !found.has(entry.name) &&
        fs.existsSync(path.join(child, "SKILL.md"))
      ) {
        found.set(entry.name, child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

async function installOfficeSkills() {
  console.log(`\n${paint("1", "Install office skills (docx / pdf / xlsx)")}\n`);
  const force = process.argv.includes("--force");
  const target = path.join(runtimePluginRoot(), "document-skills");

  const existing = officeSkillsLocation();
  if (existing && !force) {
    ok(`Office skills already installed at ${compactHome(existing)}`);
    info("Re-download and replace them with: pnpm skills:office -- --force");
    return;
  }

  console.log(
    [
      "The docx, pdf and xlsx skills are Anthropic's document skills. They are NOT",
      `distributed with this repository; they are downloaded from ${OFFICE_SKILLS_HOME}`,
      "and their use is governed by your own agreement with Anthropic.",
      `They will be installed into ${compactHome(target)}.`,
      ""
    ].join("\n")
  );

  if (!process.argv.includes("--yes")) {
    const confirmed = await askYesNo("Download and install them now? [y/N] ");
    if (!confirmed) {
      warn("Cancelled; nothing was downloaded.");
      return;
    }
  }

  const tools = spawnSync("bash", ["-lc", "command -v curl >/dev/null && command -v tar >/dev/null"], {
    stdio: "ignore"
  });
  if (tools.status !== 0) {
    fail(
      "curl and tar are required to download the office skills. Install them, or copy the docx/pdf/xlsx skill folders into:"
    );
    fail(`  ${path.join(target, "skills")}`);
    process.exitCode = 1;
    return;
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fieldnote-office-skills-"));
  try {
    info("Downloading anthropics/skills…");
    const download = spawnSync(
      "bash",
      ["-lc", `curl -fsSL ${JSON.stringify(OFFICE_SKILLS_TARBALL)} | tar -xz -C ${JSON.stringify(staging)}`],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    if (download.status !== 0) {
      fail("Download failed. Check your network connection (or a proxy) and try again.");
      process.exitCode = 1;
      return;
    }

    const sources = findOfficeSkillDirectories(staging);
    const missing = OFFICE_SKILL_NAMES.filter((name) => !sources.has(name));
    if (missing.length > 0) {
      fail(`The downloaded archive does not contain: ${missing.join(", ")}. Upstream layout may have changed.`);
      process.exitCode = 1;
      return;
    }

    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.join(target, "skills"), { recursive: true });
    for (const name of OFFICE_SKILL_NAMES) {
      fs.cpSync(sources.get(name), path.join(target, "skills", name), { recursive: true, dereference: true });
    }
    fs.mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(target, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: "document-skills",
          version: "1.0.0",
          description: "Anthropic document skills installed on demand for local document work."
        },
        null,
        2
      )}\n`
    );

    ok(`Installed docx, pdf and xlsx into ${compactHome(target)}`);
    info("Verify with: pnpm doctor");
    info("Their use remains governed by your agreement with Anthropic; they stay out of git.");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function doctor(options = { heading: true }) {
  if (options.heading) console.log(`\n${paint("1", "Fieldnote doctor")}\n`);
  let hasHardFailure = false;
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`);
  else {
    fail(`Node.js ${process.versions.node}; version 20+ is required`);
    hasHardFailure = true;
  }

  const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (pnpm.status === 0) ok(`pnpm ${pnpm.stdout.trim()}`);
  else {
    fail("pnpm was not found; install it with: npm install -g pnpm (or corepack enable)");
    hasHardFailure = true;
  }

  if (fs.existsSync(path.join(repositoryRoot, "node_modules"))) ok("Workspace dependencies installed");
  else {
    fail("Workspace dependencies missing; run pnpm install");
    hasHardFailure = true;
  }

  const officeSkills = officeSkillsLocation();
  if (officeSkills) ok(`Office skills (docx/pdf/xlsx) installed at ${compactHome(officeSkills)}`);
  else info("Office skills (docx/pdf/xlsx) not installed (optional); add them with pnpm skills:office");

  const envFile = readEnvFile(path.join(repositoryRoot, ".env"));
  if (envFile) ok(".env found (values hidden)");
  else warn(".env not found; run pnpm setup or use process environment variables");
  const effectiveEnv = { ...(envFile ?? {}), ...process.env };
  const claudeConfigDir = effectiveEnv.CLAUDE_CONFIG_DIR
    ? path.resolve(repositoryRoot, effectiveEnv.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeConfigDir, "settings.json");
  const settings = readJson(settingsPath);

  if (settings) {
    ok(`Claude user settings found at ${compactHome(settingsPath)}`);
    const plugins = Object.keys(object(settings.enabledPlugins));
    if (plugins.length > 0) ok(`User plugins: ${plugins.join(", ")}`);
  } else {
    info(`Claude user settings not found at ${compactHome(settingsPath)} (OAuth login may still work)`);
  }

  const globalClaude = readJson(path.join(os.homedir(), ".claude.json"));
  const mcpNames = new Set([
    ...Object.keys(object(settings?.mcpServers)),
    ...Object.keys(object(globalClaude?.mcpServers))
  ]);
  if (mcpNames.size > 0) ok(`MCP servers: ${[...mcpNames].join(", ")}`);
  else info("No user MCP servers discovered");

  // Runtime selection, auth detection, data directory, ports, and external tools
  // are checked by the shared doctor module (apps/server/src/doctor.ts) so this
  // script and the server never disagree.
  const tsxBin = path.join(repositoryRoot, "node_modules", ".bin", "tsx");
  if (fs.existsSync(tsxBin)) {
    const shared = spawnSync(tsxBin, [path.join(repositoryRoot, "apps", "server", "src", "doctor-cli.ts")], {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: process.env
    });
    if (shared.status !== 0) hasHardFailure = true;
  } else {
    warn("Shared diagnostics skipped (dependencies not installed yet)");
  }

  if (hasHardFailure) {
    process.exitCode = 1;
    console.log(`\n${paint("31", "Doctor found blocking issues.")} Fix them and run pnpm doctor again.\n`);
  } else if (options.heading) {
    console.log(`\n${paint("32", "All required checks passed.")}\n`);
  }
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compactHome(value) {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function getArgValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}
