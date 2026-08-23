#!/usr/bin/env node
/**
 * `fieldnote` command line entry point.
 *
 * Plain ESM with no dependencies beyond Node builtins: the server bundle in
 * `../server/dist` owns every runtime dependency, and this file only prepares the
 * environment, imports the server, and reports on the local installation.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkoutRoot = path.resolve(packageRoot, "../..");
const runningFromCheckout = exists(path.join(checkoutRoot, "pnpm-workspace.yaml"));
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const english = (process.env.LANG ?? "").toLowerCase().startsWith("en");

const HELP = `fieldnote — 本地优先的 Claude Agent 教育工作台 / local-first Claude Agent workbench

用法 / Usage:
  fieldnote [start] [options]   启动本地服务并打开网页 / start the local server and open the web app
  fieldnote doctor              体检本机环境 / check the local environment
  fieldnote data                显示数据目录 / show the resolved data directory
  fieldnote reset               备份并清空数据目录 / move the data directory aside

选项 / Options:
  --port <n>    端口，默认 8787 / port, default 8787
  --data <dir>  数据目录，默认 ~/.fieldnote / data directory, default ~/.fieldnote
  --demo        演示运行时，无需 Claude 凭据 / demo runtime, no Claude credentials needed
  --no-open     不自动打开浏览器 / do not open the browser
  --yes         跳过 reset 的确认提示 / skip the reset confirmation prompt
  -h, --help    显示帮助 / show this help
  -v, --version 显示版本 / show the version

文档 / Docs: https://github.com/YukunHe16/fieldnote`;

function exists(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

function paint(code, text) {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function fail(message) {
  console.error(paint("31", message));
  process.exit(1);
}

function parseArguments(argv) {
  const flags = { open: true, yes: false, demo: false, rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = (inline) => {
      if (inline !== undefined) return inline;
      index += 1;
      return argv[index];
    };
    const [name, inlineValue] =
      argument.startsWith("--") && argument.includes("=")
        ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)]
        : [argument, undefined];
    if (name === "--port" || name === "-p") flags.port = Number(value(inlineValue));
    else if (name === "--data" || name === "-d") flags.data = value(inlineValue);
    else if (name === "--no-open") flags.open = false;
    else if (name === "--demo") flags.demo = true;
    else if (name === "--yes" || name === "-y") flags.yes = true;
    else if (name === "--help" || name === "-h") flags.help = true;
    else if (name === "--version" || name === "-v") flags.version = true;
    else if (name.startsWith("-")) fail(`未知选项 / unknown option: ${argument}`);
    else flags.rest.push(argument);
  }
  if (flags.port !== undefined && (!Number.isInteger(flags.port) || flags.port <= 0 || flags.port > 65535)) {
    fail(`端口无效 / invalid port: ${flags.port}`);
  }
  return flags;
}

/** Mirror of the server's data-root resolution (config.ts `resolveDataRoot`). */
function resolveDataRoot(dataFlag) {
  if (dataFlag) return path.resolve(process.cwd(), dataFlag);
  if (process.env.FIELDNOTE_HOME) return path.resolve(process.cwd(), process.env.FIELDNOTE_HOME);
  if (runningFromCheckout) return checkoutRoot;
  return path.join(os.homedir(), ".fieldnote");
}

function resolveDatabasePath(dataRoot) {
  return path.resolve(dataRoot, process.env.DATABASE_PATH ?? "./data/agent.db");
}

/** Minimal `.env` reader so `doctor` sees credentials without pulling in dotenv. */
function loadEnvironmentFile(dataRoot) {
  const file = path.join(dataRoot, ".env");
  if (!exists(file)) return;
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || line.trimStart().startsWith("#")) continue;
      const raw = match[2].trim();
      const unquoted = /^(['"])([\s\S]*)\1$/.exec(raw);
      if (process.env[match[1]] === undefined) process.env[match[1]] = unquoted ? unquoted[2] : raw;
    }
  } catch {
    // an unreadable .env is not fatal for a diagnostic command
  }
}

function importServerModule(relativePath) {
  const target = path.join(packageRoot, relativePath);
  if (!exists(target)) {
    fail(`构建产物缺失 / missing build output: ${target}\n请重新安装 fieldnote，或在仓库中运行 \`pnpm build\`。`);
  }
  return import(pathToFileURL(target).href);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function box(lines) {
  const width = Math.max(
    ...lines.map((line) => [...line].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))
  );
  const pad = (line) => {
    const printable = [...line].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return line + " ".repeat(width - printable);
  };
  console.log(paint("36", `┌─${"─".repeat(width)}─┐`));
  for (const line of lines) console.log(`${paint("36", "│")} ${pad(line)} ${paint("36", "│")}`);
  console.log(paint("36", `└─${"─".repeat(width)}─┘`));
}

async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json().catch(() => ({ ok: true }));
    } catch {
      // the server is still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // opening a browser is a convenience, never a failure
  }
}

async function commandStart(flags) {
  const port = flags.port ?? Number(process.env.PORT ?? 8787);
  const dataRoot = resolveDataRoot(flags.data);
  if (runningFromCheckout && !flags.data && !process.env.FIELDNOTE_HOME) {
    console.log(paint("33", "! 正在从仓库检出运行；日常开发请用 `pnpm dev` 或 `pnpm run:local`。"));
    console.log(
      paint("2", "  Running from a repository checkout — prefer `pnpm dev` / `pnpm run:local` for development.")
    );
  }
  const databasePath = resolveDatabasePath(dataRoot);
  const firstRun = !exists(databasePath);

  process.env.NODE_ENV ??= "production";
  process.env.PORT = String(port);
  process.env.FIELDNOTE_HOME = dataRoot;
  if (flags.demo) process.env.AGENT_RUNTIME = "demo";

  // The server installs its own SIGINT/SIGTERM shutdown; keep the CLI from dying first.
  process.on("SIGINT", () => console.log(paint("2", "\n正在停止 fieldnote… / stopping fieldnote…")));

  try {
    await importServerModule("server/dist/index.js");
  } catch (error) {
    console.error(paint("31", "启动失败 / failed to start:"), error?.message ?? error);
    console.error(paint("2", "运行 `fieldnote doctor` 查看诊断信息 / run `fieldnote doctor` for diagnostics."));
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(port);
  if (!health) {
    console.error(paint("33", "! 服务已启动但健康检查超时 / server started but the health check timed out"));
    console.error(paint("2", "运行 `fieldnote doctor` 查看诊断信息 / run `fieldnote doctor` for diagnostics."));
    return;
  }

  box([
    "fieldnote 已就绪 / ready",
    "",
    `网页 / Web    ${url}`,
    `数据 / Data   ${dataRoot}`,
    `运行时 / Run  ${health.runtime ?? "unknown"}`,
    "",
    "按 Ctrl+C 停止 / press Ctrl+C to stop"
  ]);

  if (flags.open) openBrowser(firstRun ? `${url}?onboarding=1` : url);
}

async function commandDoctor(flags) {
  const dataRoot = resolveDataRoot(flags.data);
  loadEnvironmentFile(dataRoot);
  process.env.FIELDNOTE_HOME = dataRoot;
  const { loadConfig } = await importServerModule("server/dist/config.js");
  const { runDoctor } = await importServerModule("server/dist/doctor.js");
  const config = loadConfig(process.env, packageRoot);
  const report = await runDoctor(config, { probePorts: true, includeExternalTools: true });
  for (const check of report.checks) {
    const icon =
      check.status === "ok" ? paint("32", "✓") : check.status === "warn" ? paint("33", "!") : paint("31", "✗");
    const label = english ? check.labelEn : check.label;
    const hint = english ? check.hintEn : check.hint;
    console.log(`${icon} ${label}${check.detail ? paint("2", ` — ${check.detail}`) : ""}`);
    if (hint && check.status !== "ok") console.log(`  ${paint("2", hint)}`);
  }
  process.exit(report.checks.some((check) => check.status === "fail") ? 1 : 0);
}

function commandData(flags) {
  const dataRoot = resolveDataRoot(flags.data);
  const databasePath = resolveDatabasePath(dataRoot);
  const stats = exists(databasePath) ? fs.statSync(databasePath) : undefined;
  console.log(`数据目录 / Data directory  ${dataRoot}`);
  console.log(`数据库 / Database          ${databasePath}`);
  if (stats) {
    console.log(`状态 / Status              ${paint("32", "存在 / present")} (${formatBytes(stats.size)})`);
  } else {
    console.log(`状态 / Status              ${paint("33", "尚未创建 / not created yet")}`);
    console.log(paint("2", "首次运行 `fieldnote` 时会自动创建 / created on the first `fieldnote` run"));
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function commandReset(flags) {
  const dataRoot = resolveDataRoot(flags.data);
  const target = path.dirname(resolveDatabasePath(dataRoot));
  if (!exists(target)) {
    console.log(`没有需要重置的数据 / nothing to reset: ${target}`);
    return;
  }
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  console.log(`将把 / will move  ${target}`);
  console.log(`移动到 / to      ${backup}`);
  console.log(paint("2", "数据只会被重命名备份，不会被删除 / data is renamed, never deleted"));
  if (!flags.yes && !(await confirm("确认继续？/ continue? [y/N] "))) {
    console.log("已取消 / cancelled");
    if (!process.stdin.isTTY) console.log(paint("2", "非交互环境请加 --yes / add --yes in a non-interactive shell"));
    return;
  }
  fs.renameSync(target, backup);
  console.log(paint("32", `✓ 已备份 / backed up: ${backup}`));
}

const argv = process.argv.slice(2);
const commandName = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
const flags = parseArguments(argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv);

if (flags.help) {
  console.log(HELP);
} else if (flags.version) {
  console.log(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version);
} else if (commandName === "start") {
  await commandStart(flags);
} else if (commandName === "doctor") {
  await commandDoctor(flags);
} else if (commandName === "data") {
  commandData(flags);
} else if (commandName === "reset") {
  await commandReset(flags);
} else {
  fail(`未知命令 / unknown command: ${commandName}\n\n${HELP}`);
}
