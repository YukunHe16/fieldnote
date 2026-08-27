import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EvolutionCoordinator } from "../src/evolution-coordinator.js";
import { EvolutionStore } from "../src/evolution-store.js";
import { MemoryStore } from "../src/memory-store.js";

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

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolution-review-"));
  const database = openDatabase(":memory:");
  const evolution = new EvolutionStore(database);
  const memories = new MemoryStore(database);
  const coordinator = new EvolutionCoordinator(testConfig(root), evolution, memories);
  return { root, database, evolution, memories, coordinator };
}

function addPlaybook(evolution: EvolutionStore, title: string) {
  return evolution.createPlaybook({
    title,
    instruction: `${title}时先核官方页面再写进材料`,
    polarity: "do",
    origin: "confirmed",
    scope: "profile",
    profileId: "local-operator"
  });
}

describe("evolution review", () => {
  it("does not propose when the profile is not due", async () => {
    const { root, database, evolution, memories, coordinator } = await setup();
    addPlaybook(evolution, "先核官方");
    addPlaybook(evolution, "截止日期");
    memories.create({
      category: "task",
      title: "核对截止日期",
      content: "刚核对了官方截止日期",
      sourceKind: "auto",
      scope: "profile",
      profileId: "local-operator"
    });
    const now = Date.now();
    const status = evolution.getReviewStatus(
      "local-operator",
      memories.countAutoTasksSince("local-operator", now),
      now
    );
    expect(status.due).toBe(false);
    await coordinator.reviewNow(now);
    expect(evolution.listArtifacts("local-operator")).toHaveLength(0);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("marks a due review complete without proposing when evidence is thin", async () => {
    const { root, database, evolution, memories, coordinator } = await setup();
    const now = Date.now();
    evolution.markReviewCompleted("local-operator", now - 8 * 24 * 60 * 60_000, now);
    for (let index = 0; index < 15; index += 1) {
      memories.create({
        category: "task",
        title: `独立任务 ${index}`,
        content: `互不相同的一次性任务 ${index}`,
        sourceKind: "auto",
        scope: "profile",
        profileId: "local-operator"
      });
    }
    const status = evolution.getReviewStatus(
      "local-operator",
      memories.countAutoTasksSince("local-operator", now - 8 * 24 * 60 * 60_000),
      now
    );
    expect(status.due).toBe(true);
    await coordinator.reviewNow(now);
    expect(evolution.listArtifacts("local-operator")).toHaveLength(0);
    expect(evolution.getReviewStatus("local-operator", 0, now).lastRunAt).toBe(now);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("proposes a pending skill from confirmed playbooks and does not auto-enable", async () => {
    const { root, database, evolution, coordinator } = await setup();
    addPlaybook(evolution, "先核官方");
    addPlaybook(evolution, "截止日期");
    const now = Date.now();
    evolution.markReviewCompleted("local-operator", now - 8 * 24 * 60 * 60_000, now);
    const artifact = await coordinator.proposeFromReview("local-operator");
    expect(artifact).toMatchObject({
      slug: "evolved-reviewed-method",
      kind: "skill",
      status: "pending",
      origin: "distilled"
    });
    expect(artifact?.description).toContain("先核官方页面再写进材料");
    expect(artifact?.evaluation?.verdict).toBe("needs_human");
    expect(artifact?.evaluation?.reason).toContain("定期回顾提出");
    expect(evolution.pendingArtifacts("local-operator")).toHaveLength(1);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("skips a second distilled proposal while one is still pending", async () => {
    const { root, database, evolution, coordinator } = await setup();
    addPlaybook(evolution, "先核官方");
    addPlaybook(evolution, "截止日期");
    const first = await coordinator.proposeFromReview("local-operator");
    const second = await coordinator.proposeFromReview("local-operator");
    expect(first?.status).toBe("pending");
    expect(second).toBeNull();
    expect(evolution.pendingArtifacts("local-operator")).toHaveLength(1);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("proposes from repeated similar tasks without any thumbs-up", async () => {
    const { root, database, evolution, memories, coordinator } = await setup();
    for (let index = 0; index < 3; index += 1) {
      memories.create({
        category: "task",
        title: "核对截止日期",
        content: `第 ${index + 1} 次核对官方截止日期`,
        sourceKind: "auto",
        scope: "profile",
        profileId: "local-operator"
      });
    }
    expect(evolution.countThumbs({ profileId: "local-operator", polarity: "up" })).toBe(0);
    const artifact = await coordinator.proposeFromReview("local-operator");
    expect(artifact).toMatchObject({
      kind: "skill",
      status: "pending",
      origin: "distilled"
    });
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not propose a subagent just because playbooks mention writing or research", async () => {
    const { root, database, evolution, coordinator } = await setup();
    addPlaybook(evolution, "文书写作");
    addPlaybook(evolution, "项目研究员");
    const artifact = await coordinator.proposeFromReview("local-operator");
    expect(artifact?.kind).toBe("skill");
    expect(evolution.pendingArtifacts("local-operator").filter((item) => item.kind === "subagent")).toHaveLength(0);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("can also propose a pending subagent when repeated work was delegated", async () => {
    const { root, database, evolution, coordinator } = await setup();
    addPlaybook(evolution, "先核官方");
    evolution.createPlaybook({
      title: "委派调研",
      instruction: "重复的项目调研交给子代理独立完成",
      polarity: "do",
      origin: "confirmed",
      scope: "profile",
      profileId: "local-operator"
    });
    const artifact = await coordinator.proposeFromReview("local-operator");
    expect(artifact?.kind).toBe("skill");
    expect(evolution.pendingArtifacts("local-operator").some((item) => item.kind === "subagent")).toBe(true);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("holds an explicit skill request for human review", async () => {
    const { root, database, evolution, coordinator } = await setup();
    addPlaybook(evolution, "先核官方");
    const artifact = await coordinator.proposeFromPrompt({
      profileId: "local-operator",
      prompt: "做成 skill"
    });
    expect(artifact?.status).toBe("pending");
    expect(artifact?.slug).toBe("evolved-personal-method");
    expect(evolution.enabledArtifacts("local-operator")).toHaveLength(0);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});
