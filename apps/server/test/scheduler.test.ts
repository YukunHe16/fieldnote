import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdmissionsStore } from "../src/admissions-store.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import type { AgentRuntime, RuntimeEvent, RuntimeInput } from "../src/runtime.js";
import { ScheduledJobRunner } from "../src/scheduler.js";
import { SchedulerStore } from "../src/scheduler-store.js";
import { AgentStore } from "../src/store.js";

class ReportRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  prompts: string[] = [];

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    this.prompts.push(input.prompt);
    yield {
      type: "activity.started",
      activityId: "research",
      activityKind: "skill",
      displayName: "Skills · 申请进度",
      technicalName: "application-tracker"
    };
    yield { type: "activity.text.delta", activityId: "research", delta: "正在核对任务" };
    yield { type: "activity.completed", activityId: "research", outputSummary: "已核对" };
    yield { type: "text.delta", delta: "今天先完成 SOP 初稿。" };
    yield { type: "completed" };
  }
}

class BlockingReportRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    await new Promise<void>((_resolve, reject) =>
      input.abortController.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("Interrupted"), { name: "AbortError" })),
        { once: true }
      )
    );
    yield { type: "completed" };
  }
}

function config(root: string): AppConfig {
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ScheduledJobRunner", () => {
  it("runs a profile report independently, stores activity blocks, and delivers it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-runner-"));
    const database = openDatabase(":memory:");
    const schedules = new SchedulerStore(database);
    const admissions = new AdmissionsStore(database);
    const conversations = new AgentStore(database);
    const cycle = admissions.createCycle({
      name: "2027 秋季",
      degree: "PhD",
      fieldOfStudy: "AI",
      intakeTerm: "Fall 2027",
      targetRegions: ["美国"],
      active: true
    });
    admissions.createTask({
      cycleId: cycle.id,
      programId: null,
      title: "完成 SOP 初稿",
      priority: "high",
      dueAt: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
      completed: false
    });
    const runtime = new ReportRuntime();
    const delivered: string[] = [];
    const runner = new ScheduledJobRunner(config(root), schedules, admissions, conversations, runtime, {
      async deliver(destination, report) {
        delivered.push(`${destination}:${report.content}`);
        return report.run.id;
      }
    });
    const job = schedules.createJob({
      profileId: "graduate-admissions",
      templateId: "daily-application-plan",
      destinations: ["web", "feishu"],
      enabled: false
    });
    const started = runner.runNow(job.id)!;
    await waitFor(() => schedules.getRun(started.id)?.status === "completed");
    const completed = schedules.getRun(started.id)!;
    expect(completed).toMatchObject({ title: "今日申学计划", content: "今天先完成 SOP 初稿。" });
    expect(completed.blocks[0]).toMatchObject({
      displayName: "Skills · 申请进度",
      status: "completed",
      content: "正在核对任务"
    });
    expect(runtime.prompts[0]).toContain("完成 SOP 初稿");
    expect(delivered).toEqual(["feishu:今天先完成 SOP 初稿。", "web:今天先完成 SOP 初稿。"]);
    await runner.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("excludes temporary chats and redacts sensitive recent chat context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-context-"));
    const database = openDatabase(":memory:");
    const schedules = new SchedulerStore(database);
    const admissions = new AdmissionsStore(database);
    const conversations = new AgentStore(database);
    admissions.createCycle({
      name: "2027 秋季",
      degree: "PhD",
      fieldOfStudy: "AI",
      intakeTerm: "Fall 2027",
      targetRegions: ["美国"],
      active: true
    });
    const durable = conversations.createConversation("web", "申请进度 user@example.com", {
      profileId: "graduate-admissions"
    });
    conversations.createRun(durable.id, "Bearer secret-token-123 申请清单", "normal");
    const temporary = conversations.createConversation("web", "临时申学", {
      profileId: "graduate-admissions",
      temporary: true
    });
    conversations.createRun(temporary.id, "TEMPORARY-ONLY-PASSPORT 12345678901234567", "normal");
    const runtime = new ReportRuntime();
    const runner = new ScheduledJobRunner(config(root), schedules, admissions, conversations, runtime);
    const job = schedules.createJob({ profileId: "graduate-admissions", templateId: "weekly-application-review" });
    const started = runner.runNow(job.id)!;
    await waitFor(() => schedules.getRun(started.id)?.status === "completed");
    expect(runtime.prompts[0]).toContain("可能包含敏感信息已省略");
    expect(runtime.prompts[0]).not.toContain("secret-token-123");
    expect(runtime.prompts[0]).not.toContain("user@example.com");
    expect(runtime.prompts[0]).not.toContain("TEMPORARY-ONLY-PASSPORT");
    expect(runtime.prompts[0]).not.toContain("12345678901234567");
    await runner.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("aborts in-flight work on stop so no running schedule is stranded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-stop-"));
    const database = openDatabase(":memory:");
    const schedules = new SchedulerStore(database);
    const admissions = new AdmissionsStore(database);
    const conversations = new AgentStore(database);
    admissions.createCycle({
      name: "2027 秋季",
      degree: "PhD",
      fieldOfStudy: "AI",
      intakeTerm: "Fall 2027",
      targetRegions: ["美国"],
      active: true
    });
    const runner = new ScheduledJobRunner(
      config(root),
      schedules,
      admissions,
      conversations,
      new BlockingReportRuntime()
    );
    const job = schedules.createJob({ profileId: "graduate-admissions", templateId: "daily-application-plan" });
    const started = runner.runNow(job.id)!;
    const secondJob = schedules.createJob({
      profileId: "graduate-admissions",
      templateId: "weekly-application-review"
    });
    const pending = runner.runNow(secondJob.id)!;
    await waitFor(() => schedules.getRun(started.id)?.status === "running");
    await runner.stop();
    expect(schedules.getRun(started.id)).toMatchObject({
      status: "queued",
      retryCount: 1,
      retryAt: expect.any(String)
    });
    expect(schedules.getRun(pending.id)).toMatchObject({
      status: "queued",
      retryCount: 1,
      retryAt: expect.any(String)
    });
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});
