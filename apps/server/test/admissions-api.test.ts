import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdmissionsStore } from "../src/admissions-store.js";
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

describe("admissions HTTP API", () => {
  it("manages an application cycle, tracker records, evidence, and downloadable artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "admissions-api-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const admissions = new AdmissionsStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const config = testConfig(root);
    const runtime = new ConfigurableAgentRuntime(config, new SqliteSessionStore(database), memories);
    const orchestrator = new RunOrchestrator(config, store, events, runtime);
    const app = await buildApp({ config, store, events, orchestrator, runtime, memories, admissions });
    cleanups.push(async () => {
      await orchestrator.stop();
      await app.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    });

    expect((await app.inject({ method: "GET", url: "/api/admissions/cycles" })).json()).toEqual({ items: [] });
    const cycle = (
      await app.inject({
        method: "POST",
        url: "/api/admissions/cycles",
        payload: { name: "2027 秋季", degree: "PhD", fieldOfStudy: "Computer Science", intakeTerm: "Fall 2027" }
      })
    ).json<{ id: string }>();
    const profile = await app.inject({
      method: "POST",
      url: "/api/admissions/profile",
      payload: { cycleId: cycle.id, summary: "计算机本科", researchSummary: "机器学习研究", targetField: "AI" }
    });
    expect(profile.statusCode).toBe(201);
    expect(profile.json()).toMatchObject({ targetDegree: "PhD", targetField: "AI", summary: "计算机本科" });

    const program = (
      await app.inject({
        method: "POST",
        url: "/api/admissions/programs",
        payload: {
          cycleId: cycle.id,
          institution: "Example University",
          name: "PhD in Computer Science",
          country: "美国",
          officialUrl: "https://example.edu/grad",
          deadline: "2026-12-01T00:00:00.000Z"
        }
      })
    ).json<{
      id: string;
      institution: string;
      name: string;
      deadline: string;
      deadlines: Array<{ label: string; dueAt: string }>;
    }>();
    expect(program).toMatchObject({
      institution: "Example University",
      name: "PhD in Computer Science",
      deadline: "2026-12-01T00:00:00.000Z",
      deadlines: [expect.objectContaining({ label: "", dueAt: "2026-12-01T00:00:00.000Z" })]
    });

    const source = (
      await app.inject({
        method: "POST",
        url: "/api/admissions/sources",
        payload: {
          cycleId: cycle.id,
          programId: program.id,
          url: "https://example.edu/grad",
          title: "Example Graduate School",
          snippet: "Applications close December 1."
        }
      })
    ).json<{ id: string; programId: string }>();
    expect(source.programId).toBe(program.id);
    const requirement = await app.inject({
      method: "POST",
      url: `/api/admissions/programs/${program.id}/requirements`,
      payload: { title: "Statement of Purpose", status: "missing", sourceId: source.id }
    });
    expect(requirement.statusCode).toBe(201);
    expect(requirement.json()).toMatchObject({ title: "Statement of Purpose", status: "missing" });
    const task = await app.inject({
      method: "POST",
      url: "/api/admissions/tasks",
      payload: { cycleId: cycle.id, programId: program.id, title: "完成 SOP 初稿", priority: "high" }
    });
    expect(task.json()).toMatchObject({ title: "完成 SOP 初稿", status: "pending" });

    const artifactDirectory = path.join(root, ".admissions-artifacts", cycle.id);
    await fs.mkdir(artifactDirectory, { recursive: true });
    await fs.writeFile(path.join(artifactDirectory, "sop.md"), "# SOP");
    const artifact = (
      await app.inject({
        method: "POST",
        url: "/api/admissions/artifacts",
        payload: { cycleId: cycle.id, kind: "SOP", title: "sop.md", relativePath: `${cycle.id}/sop.md` }
      })
    ).json<{ id: string }>();
    const download = await app.inject({ method: "GET", url: `/api/admissions/artifacts/${artifact.id}/download` });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("# SOP");

    const programs = await app.inject({ method: "GET", url: "/api/admissions/programs" });
    expect(programs.json<{ items: unknown[] }>().items).toHaveLength(1);
    const sources = await app.inject({ method: "GET", url: "/api/admissions/sources" });
    expect(sources.json<{ items: Array<{ programId: string }> }>().items[0]?.programId).toBe(program.id);
  });
});
