import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EventStore } from "../src/event-store.js";
import { MemoryStore } from "../src/memory-store.js";
import { RunOrchestrator } from "../src/orchestrator.js";
import { ConfigurableAgentRuntime } from "../src/runtime.js";
import { SqliteSessionStore } from "../src/session-store.js";
import { AgentStore } from "../src/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function testConfig(root: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    workspaceRoot: root,
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

async function buildTestApp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "onboarding-state-"));
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
    await fs.rm(root, { recursive: true });
  });
  return { app, store };
}

describe("onboarding state API", () => {
  it("reports a fresh install as not onboarded", async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: "GET", url: "/api/onboarding-state" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ completed: false });
  });

  it("persists completion and reads it back", async () => {
    const { app, store } = await buildTestApp();

    const saved = await app.inject({
      method: "PUT",
      url: "/api/onboarding-state",
      payload: { completed: true }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ completed: true });
    expect(store.getSetting<boolean>("onboarding.completed")).toBe(true);

    const reread = await app.inject({ method: "GET", url: "/api/onboarding-state" });
    expect(reread.json()).toEqual({ completed: true });

    const reset = await app.inject({
      method: "PUT",
      url: "/api/onboarding-state",
      payload: { completed: false }
    });
    expect(reset.json()).toEqual({ completed: false });
    expect((await app.inject({ method: "GET", url: "/api/onboarding-state" })).json()).toEqual({ completed: false });
  });

  it("rejects a payload without a boolean flag", async () => {
    const { app } = await buildTestApp();

    expect((await app.inject({ method: "PUT", url: "/api/onboarding-state", payload: {} })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/onboarding-state",
          payload: { completed: "yes" }
        })
      ).statusCode
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/onboarding-state" })).json()).toEqual({ completed: false });
  });
});
