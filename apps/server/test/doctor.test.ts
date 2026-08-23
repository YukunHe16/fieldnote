import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EventStore } from "../src/event-store.js";
import { MemoryStore } from "../src/memory-store.js";
import { RunOrchestrator } from "../src/orchestrator.js";
import { ConfigurableAgentRuntime } from "../src/runtime.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { AgentStore } from "../src/store.js";
import { runDoctor } from "../src/doctor.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function testConfig(root: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    workspaceRoot: path.join(root, "workspaces"),
    runtime: "demo",
    claudeAuthConfigured: false,
    claudeAuthSource: "none",
    claudeSettingsMode: "isolated",
    claudeConfigDir: path.join(root, ".claude"),
    claudeConfigDirExplicit: false,
    model: "sonnet",
    modelDisplay: "sonnet",
    effort: "high",
    maxConcurrency: 2,
    maxTurns: 30,
    runTimeoutMs: 20_000,
    maxBudgetUsd: 2,
    logLevel: "silent",
    nodeEnv: "test"
  };
}

describe("OAuth credential detection", () => {
  it("treats a local .credentials.json as a usable Claude login under auto mode", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-oauth-"));
    await fs.writeFile(path.join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    const config = loadConfig(
      { CLAUDE_CONFIG_DIR: directory, CLAUDE_SETTINGS_MODE: "auto", NODE_ENV: "test" },
      directory
    );
    expect(config.claudeAuthConfigured).toBe(true);
    expect(config.claudeAuthSource).toBe("oauth-credentials");
    expect(config.claudeSettingsMode).toBe("inherit-user");
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("keeps isolated mode on the demo runtime even when OAuth credentials exist", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-oauth-"));
    await fs.writeFile(path.join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }));
    const config = loadConfig(
      { CLAUDE_CONFIG_DIR: directory, CLAUDE_SETTINGS_MODE: "isolated", NODE_ENV: "test" },
      directory
    );
    expect(config.claudeAuthConfigured).toBe(false);
    expect(config.claudeAuthSource).toBe("none");
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("resolves data paths against FIELDNOTE_HOME when provided", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fieldnote-home-"));
    const config = loadConfig({ FIELDNOTE_HOME: directory, NODE_ENV: "test" }, process.cwd());
    expect(config.databasePath).toBe(path.join(directory, "data", "agent.db"));
    expect(config.workspaceRoot).toBe(path.join(directory, "data", "workspaces"));
    await fs.rm(directory, { recursive: true, force: true });
  });
});

describe("shared doctor", () => {
  it("reports demo runtime, writable data dir, and external tool gaps without secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-"));
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
    const report = await runDoctor(testConfig(root), {
      feishuConfigured: true,
      feishuConnected: false,
      allowedOpenIdsCount: 0,
      externalToolsOverride: [
        { id: "uv", present: true, version: "uv 1.0" },
        { id: "soffice", present: false }
      ]
    });
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get("runtime")?.status).toBe("warn");
    expect(byId.get("data-dir")?.status).toBe("ok");
    expect(byId.get("feishu")?.status).toBe("warn");
    expect(byId.get("feishu-allowlist")?.status).toBe("warn");
    expect(byId.get("tool:uv")?.status).toBe("ok");
    expect(byId.get("tool:soffice")?.status).toBe("warn");
    for (const check of report.checks) {
      expect(check.labelEn.length).toBeGreaterThan(0);
      expect(JSON.stringify(check)).not.toMatch(/sk-[A-Za-z0-9]/);
    }
  });

  it("flags an unwritable data directory as a failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-ro-"));
    cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
    const config = testConfig(root);
    config.workspaceRoot = path.join(root, "missing-file-parent", "nested");
    await fs.writeFile(path.join(root, "missing-file-parent"), "not a directory");
    const report = await runDoctor(config, { externalToolsOverride: [] });
    expect(report.checks.find((check) => check.id === "data-dir")?.status).toBe("fail");
  });
});

describe("diagnostics and runtime test endpoints", () => {
  it("serves diagnostics without secrets and short-circuits runtime tests without credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostics-api-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const config = testConfig(root);
    const sessionStore = new SqliteSessionStore(database);
    const runtime = new ConfigurableAgentRuntime(config, sessionStore, memories);
    const orchestrator = new RunOrchestrator(config, store, events, runtime);
    const app = await buildApp({ config, store, events, orchestrator, runtime, memories });
    cleanups.push(async () => {
      await orchestrator.stop();
      await app.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    });

    const diagnostics = await app.inject({ method: "GET", url: "/api/diagnostics" });
    expect(diagnostics.statusCode).toBe(200);
    const payload = diagnostics.json() as { checks: Array<{ id: string; status: string }> };
    expect(payload.checks.length).toBeGreaterThan(0);
    expect(payload.checks.find((check) => check.id === "runtime")?.status).toBe("warn");

    const test = await app.inject({ method: "POST", url: "/api/runtime/test", payload: {} });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: false, error: "no-credentials" });

    const badInput = await app.inject({
      method: "POST",
      url: "/api/runtime/test",
      payload: { baseUrl: "not-a-url" }
    });
    expect(badInput.statusCode).toBeGreaterThanOrEqual(400);
  });
});
