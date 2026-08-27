import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EvolutionStore } from "../src/evolution-store.js";
import { MemoryStore } from "../src/memory-store.js";
import { REPLAY_MARK_FILE, RunReplayStore } from "../src/run-replay.js";
import { ClaudeAgentRuntime } from "../src/runtime.js";
import { SqliteSessionStore } from "../src/session-store.js";

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
    maxConcurrency: 1,
    maxTurns: 30,
    runTimeoutMs: 20_000,
    maxBudgetUsd: 2,
    logLevel: "silent",
    nodeEnv: "test"
  };
}

describe("run replay store", () => {
  it("freezes a workspace and restores it into an isolated directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
    const workspace = path.join(root, "original");
    const copy = path.join(root, "copy");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "resume.md"), "v1");
    fs.writeFileSync(path.join(workspace, REPLAY_MARK_FILE), JSON.stringify({ sourceRunId: "forged" }));
    const store = new RunReplayStore(openDatabase(":memory:"), path.join(root, "snapshots"));
    const frozenArtifact = {
      id: "artifact-1",
      profileId: "local-operator",
      kind: "skill" as const,
      slug: "resume-method",
      name: "简历方法",
      description: "把简历压缩为一页并交付",
      body: "1. 保留事实\n2. 导出 PDF",
      status: "enabled" as const,
      origin: "distilled" as const,
      revision: 1,
      evaluation: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z"
    };
    const snapshot = store.freeze({
      runId: "run-1",
      conversationId: "c1",
      profileId: "local-operator",
      prompt: "改简历",
      overlay: {
        playbookIds: ["p1"],
        memories: [{ id: "m1", category: "preference", title: "回答语言", content: "使用简洁中文" }],
        artifacts: [frozenArtifact]
      },
      workspacePath: workspace
    });
    expect(snapshot?.prompt).toBe("改简历");
    expect(store.restoreInto("run-1", copy)).toBe(true);
    expect(fs.readFileSync(path.join(copy, "resume.md"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(copy, REPLAY_MARK_FILE))).toBe(false);
    expect(snapshot?.overlay.playbookIds).toEqual(["p1"]);
    frozenArtifact.body = "后来修改的正文";
    const persisted = store.getByRun("run-1");
    expect(persisted?.overlay.memories?.[0]?.content).toBe("使用简洁中文");
    expect(persisted?.overlay.artifacts?.[0]?.body).toBe("1. 保留事实\n2. 导出 PDF");
    store.pinConversation(copy, {
      sourceRunId: "run-1",
      mode: "frozen",
      prompt: "改简历",
      overlay: snapshot!.overlay
    });
    expect(store.markForConversation(copy)?.sourceRunId).toBe("run-1");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses frozen empty and populated overlays without falling back to current context", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-runtime-"));
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    const evolution = new EvolutionStore(database);
    memories.create({
      category: "preference",
      title: "当前偏好",
      content: "这是回放之后才新增的记忆",
      sourceKind: "manual"
    });
    evolution.createPlaybook({
      title: "当前手册",
      instruction: "这是回放之后才新增的步骤",
      polarity: "do",
      origin: "user",
      scope: "profile",
      profileId: "local-operator"
    });
    const currentArtifact = evolution.createArtifact({
      profileId: "local-operator",
      kind: "skill",
      slug: "current-skill",
      name: "当前能力",
      description: "这是回放之后才启用的能力",
      body: "1. 当前步骤\n2. 当前交付",
      origin: "distilled",
      status: "enabled"
    });
    const runtime = new ClaudeAgentRuntime(testConfig(root), new SqliteSessionStore(database), memories, evolution);
    const inspect = runtime as unknown as {
      memoryContext(input: Record<string, unknown>): string;
      resolveEvolvedArtifacts(input: Record<string, unknown>): (typeof currentArtifact)[];
    };
    const emptyOverlay = {
      id: "empty-overlay",
      playbookIds: [],
      artifactIds: [],
      cardTitle: null,
      playbooks: [],
      card: null,
      memories: [],
      artifacts: []
    };
    const emptyContext = inspect.memoryContext({
      profileId: "local-operator",
      prompt: "回放",
      pinnedOverlay: emptyOverlay
    });
    expect(emptyContext).not.toContain("回放之后才新增");
    expect(
      inspect.resolveEvolvedArtifacts({
        profileId: "local-operator",
        pinnedOverlay: emptyOverlay
      })
    ).toEqual([]);

    const frozenArtifact = { ...currentArtifact, body: "1. 冻结步骤\n2. 冻结交付" };
    const frozenOverlay = {
      ...emptyOverlay,
      playbookIds: ["old-playbook"],
      artifactIds: [frozenArtifact.id],
      playbooks: [{ id: "old-playbook", title: "旧手册", polarity: "do" as const, instruction: "使用冻结步骤" }],
      memories: [{ id: "old-memory", category: "preference" as const, title: "旧偏好", content: "使用冻结记忆" }],
      artifacts: [frozenArtifact]
    };
    const frozenContext = inspect.memoryContext({
      profileId: "local-operator",
      prompt: "回放",
      pinnedOverlay: frozenOverlay
    });
    expect(frozenContext).toContain("使用冻结步骤");
    expect(frozenContext).toContain("使用冻结记忆");
    expect(frozenContext).not.toContain("回放之后才新增");
    expect(
      inspect.resolveEvolvedArtifacts({
        profileId: "local-operator",
        pinnedOverlay: frozenOverlay
      })[0]?.body
    ).toContain("冻结步骤");

    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
