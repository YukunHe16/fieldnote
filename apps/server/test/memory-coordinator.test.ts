import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EventStore } from "../src/event-store.js";
import { MemoryCoordinator } from "../src/memory-coordinator.js";
import { MemoryStore } from "../src/memory-store.js";
import { EvolutionCoordinator } from "../src/evolution-coordinator.js";
import { EvolutionStore } from "../src/evolution-store.js";
import type { AgentRuntime, RuntimeEvent, RuntimeInput, TurnAnalysisInput } from "../src/runtime.js";
import { emptyTurnAnalysis } from "../src/runtime.js";
import { shouldSkipCasualAnalyze } from "../src/memory-coordinator.js";
import { AgentStore } from "../src/store.js";
import { LearningStore } from "../src/learning-store.js";
import { RunReplayStore } from "../src/run-replay.js";

class RetryAnalysisRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  attempts = 0;

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async analyzeTurn(_input: TurnAnalysisInput) {
    this.attempts += 1;
    if (this.attempts < 2) throw new Error("temporary analysis failure");
    return {
      ...emptyTurnAnalysis("恢复后的标题"),
      title: "恢复后的标题",
      meaningfulTask: true,
      taskType: "durable_task" as const,
      task: { title: "恢复任务", summary: "重试后成功整理任务", keywords: ["恢复任务"], importance: 3 }
    };
  }
}

class RefinementRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  refinements = 0;
  updatedId = "";
  supersededId = "";

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async analyzeTurn(input: TurnAnalysisInput) {
    return { ...emptyTurnAnalysis(input.prompt), title: input.prompt };
  }

  async refineMemories(input: {
    memories: Array<{ id: string; title: string; content: string; sourceKind: string; pinned: boolean }>;
  }) {
    this.refinements += 1;
    const editable = input.memories.filter((memory) => memory.sourceKind === "auto" && !memory.pinned);
    const protectedMemory = input.memories.find((memory) => memory.sourceKind !== "auto" || memory.pinned);
    this.updatedId = editable[2]?.id ?? "";
    this.supersededId = editable[3]?.id ?? "";
    return {
      groups: [
        {
          sourceMemoryIds: editable.slice(0, 2).map((memory) => memory.id),
          category: "project" as const,
          title: "长期发布项目",
          content: "持续维护发布清单与风险检查",
          keywords: ["发布"],
          importance: 4
        }
      ],
      updates: [
        ...(editable[2]
          ? [
              {
                memoryId: editable[2].id,
                title: "高优先级发布结论",
                content: editable[2].content,
                keywords: ["发布", "优先"],
                importance: 5
              }
            ]
          : []),
        ...(protectedMemory
          ? [
              {
                memoryId: protectedMemory.id,
                title: "不应被修改",
                content: protectedMemory.content,
                keywords: [],
                importance: 1
              }
            ]
          : [])
      ],
      supersedeIds: [...(editable[3] ? [editable[3].id] : []), ...(protectedMemory ? [protectedMemory.id] : [])]
    };
  }
}

class AdmissionRuntime implements AgentRuntime {
  readonly kind = "demo" as const;

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async analyzeTurn(_input: TurnAnalysisInput) {
    return {
      ...emptyTurnAnalysis("记忆测试"),
      title: "记忆测试",
      meaningfulTask: true,
      taskType: "durable_task" as const,
      task: { title: "不应保存", summary: "这只是记忆操作或查询", keywords: ["记忆"], importance: 1 }
    };
  }
}

class ThrowingRefinementRuntime implements AgentRuntime {
  readonly kind = "demo" as const;

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async refineMemories() {
    throw new Error("Memory refinement returned invalid structured output");
  }
}

class ApplicationFailureRuntime implements AgentRuntime {
  readonly kind = "demo" as const;

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async refineMemories(input: { memories: Array<{ id: string }> }) {
    return {
      groups: [],
      updates: input.memories[0]
        ? [
            {
              memoryId: input.memories[0].id,
              title: "   ",
              content: "invalid normalized title",
              keywords: [],
              importance: 1
            }
          ]
        : [],
      supersedeIds: []
    };
  }
}

class CrossProfileRefinementRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  foreignMemoryId = "";
  batches: Array<Array<{ id: string; profileId: string | null }>> = [];

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async refineMemories(input: { memories: Array<{ id: string; profileId: string | null }> }) {
    this.batches.push(input.memories.map(({ id, profileId }) => ({ id, profileId })));
    const isAdmissionsBatch = input.memories.some((memory) => memory.profileId === "graduate-admissions");
    return {
      groups: [],
      updates: isAdmissionsBatch
        ? [
            {
              memoryId: this.foreignMemoryId,
              title: "越权改写",
              content: "不应由另一个 Profile 的维护批次写入",
              keywords: ["越权"],
              importance: 5
            }
          ]
        : [],
      supersedeIds: isAdmissionsBatch ? [this.foreignMemoryId] : []
    };
  }
}

class CountingAnalysisRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  calls = 0;

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async analyzeTurn(input: TurnAnalysisInput) {
    this.calls += 1;
    return emptyTurnAnalysis(input.prompt);
  }
}

class DelayedAnalysisRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  private releaseAnalysis!: () => void;
  private markStarted!: () => void;
  private readonly analysisStarted = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly analysisReleased = new Promise<void>((resolve) => {
    this.releaseAnalysis = resolve;
  });

  async *run(_input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "completed" };
  }

  async analyzeTurn(input: TurnAnalysisInput) {
    this.markStarted();
    await this.analysisReleased;
    return {
      ...emptyTurnAnalysis(input.prompt),
      title: "不应写入的标题",
      meaningfulTask: true,
      taskType: "durable_task" as const,
      task: { title: "不应保存的任务", summary: "分支编辑后不应写入此任务记忆", keywords: ["分支"], importance: 3 }
    };
  }

  waitUntilAnalysisStarts(): Promise<void> {
    return this.analysisStarted;
  }

  release(): void {
    this.releaseAnalysis();
  }
}

describe("casual analyze skip", () => {
  it("skips analyzeTurn for a short idle reply with no tools or thinking", () => {
    expect(
      shouldSkipCasualAnalyze({
        prompt: "你好",
        usedSkills: [],
        usedSubagents: [],
        injectedPlaybookCount: 0,
        toolCount: 0,
        thinkingMs: 0,
        outputTokens: 8
      })
    ).toBe(true);
  });

  it("still analyzes when the agent used tools, thought long, or wrote a long answer", () => {
    const base = {
      prompt: "你好",
      usedSkills: [] as string[],
      usedSubagents: [] as string[],
      injectedPlaybookCount: 0,
      toolCount: 0,
      thinkingMs: 0,
      outputTokens: 8
    };
    expect(shouldSkipCasualAnalyze({ ...base, toolCount: 1 })).toBe(false);
    expect(shouldSkipCasualAnalyze({ ...base, thinkingMs: 6_000 })).toBe(false);
    expect(shouldSkipCasualAnalyze({ ...base, outputTokens: 48 })).toBe(false);
    expect(shouldSkipCasualAnalyze({ ...base, reasoningChars: 120 })).toBe(false);
    expect(shouldSkipCasualAnalyze({ ...base, prompt: "记住我喜欢先核官方" })).toBe(false);
    expect(shouldSkipCasualAnalyze({ ...base, injectedPlaybookCount: 2 })).toBe(false);
  });

  it("does not call analyzeTurn for a short idle chat turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-skip-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const runtime = new CountingAnalysisRuntime();
    const coordinator = new MemoryCoordinator(config(root), store, memories, new EventStore(database), runtime);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "你好", "normal");
    store.replaceMessageText(run.assistantMessageId, "你好，需要我帮什么？");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "completed");
    expect(runtime.calls).toBe(0);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps synthetic learning demos out of memory and evolution extraction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-synthetic-demo-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const learning = new LearningStore(database);
    const runtime = new CountingAnalysisRuntime();
    const conversation = store.createConversation("web", "合成演示 · 递归案例", { profileId: "local-operator" });
    learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解递归计划",
      topicKey: "programming-plans",
      datasetKind: "demo"
    });
    const run = store.createRun(conversation.id, "请根据完整代码诊断递归计划缺口，并给出一项迁移验证。", "normal");
    store.replaceMessageText(
      run.assistantMessageId,
      "这是足够长的合成教学回复，用来确认演示内容不会进入真实记忆、标题整理或通用能力自进化流程。"
    );
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      runtime,
      undefined,
      undefined,
      undefined,
      learning
    );

    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "skipped");
    expect(runtime.calls).toBe(0);
    expect(store.getConversation(conversation.id)?.title).toBe("合成演示 · 递归案例");
    expect(memories.list({ profileId: "local-operator" })).toHaveLength(0);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("analyzes a study participant's turn without touching the owner's memories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-participant-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const learning = new LearningStore(database);
    const runtime = new CountingAnalysisRuntime();
    const participant = store.createParticipant("同学B");
    store.setCurrentParticipant(participant.id);
    const conversation = store.createConversation("web", "B 的提问", { profileId: "local-operator" });
    expect(conversation.participantId).toBe(participant.id);
    const run = store.createRun(conversation.id, "我一直不理解递归的出口条件，能一步步教我吗？再多讲讲。", "normal");
    store.replaceMessageText(
      run.assistantMessageId,
      "这是足够长的教学回复，用来确认参与者的回合仍会被分析（标题与学习建议照常），但绝不写入机主的记忆或能力自进化。"
    );
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      runtime,
      undefined,
      undefined,
      undefined,
      learning
    );

    coordinator.enqueue(run);
    // Surgical gating: the turn is PROCESSED (title/suggestion machinery runs)...
    await waitFor(() => memories.getExtraction(run.id)?.status === "completed");
    expect(runtime.calls).toBe(1);
    // ...but nothing lands in the owner's memory store.
    expect(memories.list({ profileId: "local-operator" })).toHaveLength(0);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps eval learning sessions out of memory and evolution extraction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-synthetic-eval-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const learning = new LearningStore(database);
    const evolution = new EvolutionStore(database);
    const runtime = new CountingAnalysisRuntime();
    const conversation = store.createConversation("web", "离线评测 · 递归题", { profileId: "local-operator" });
    learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "评测：递归计划缺口",
      topicKey: "programming-plans",
      datasetKind: "eval"
    });
    const run = store.createRun(conversation.id, "我的嵌套求和递归写错了，帮我看看。", "normal");
    store.replaceMessageText(
      run.assistantMessageId,
      "这是足够长的评测教学回复，用来确认模拟学习者对话不会进入真实记忆或通用能力自进化统计。"
    );
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      runtime,
      undefined,
      undefined,
      undefined,
      learning
    );

    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "skipped");
    expect(runtime.calls).toBe(0);
    expect(memories.list({ profileId: "local-operator" })).toHaveLength(0);
    expect(evolution.listSignals({ limit: 50 })).toHaveLength(0);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps replay conversations without learning sessions out of extraction via the replay mark", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-synthetic-replay-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const replay = new RunReplayStore(database, path.join(root, ".snapshots"));
    const runtime = new CountingAnalysisRuntime();
    const conversation = store.createConversation("web", "回放", { profileId: "local-operator" });
    replay.pinConversation(conversation.id, {
      sourceRunId: "run-source",
      mode: "frozen",
      includeArtifactId: null,
      prompt: "原始提问",
      overlay: {
        id: "",
        playbookIds: [],
        artifactIds: [],
        cardTitle: null,
        playbooks: [],
        card: null,
        memories: [],
        artifacts: []
      }
    });
    const run = store.createRun(conversation.id, "重放这个任务并检查输出。", "normal");
    store.replaceMessageText(
      run.assistantMessageId,
      "这是足够长的重放回复，用来确认重放实验对话不会进入真实记忆或通用能力自进化统计。"
    );
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      replay
    );

    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "skipped");
    expect(runtime.calls).toBe(0);
    expect(memories.list({ profileId: "local-operator" })).toHaveLength(0);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("still skips idle chat when only filler playbooks were injected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-skip-playbook-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const evolution = new EvolutionStore(database);
    const runtime = new CountingAnalysisRuntime();
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      runtime,
      new EvolutionCoordinator(config(root), evolution)
    );
    const conversation = store.createConversation("web", "新对话", { profileId: "graduate-admissions" });
    const playbook = evolution.createPlaybook({
      title: "先核官方",
      instruction: "先核官方页面再写进材料",
      polarity: "do",
      origin: "user",
      scope: "profile",
      profileId: "graduate-admissions"
    });
    const run = store.createRun(conversation.id, "你好", "normal");
    evolution.createOverlayRevision({
      runId: run.id,
      profileId: "graduate-admissions",
      playbooks: [playbook],
      artifactIds: []
    });
    store.replaceMessageText(run.assistantMessageId, "你好，需要我帮什么？");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "completed");
    expect(runtime.calls).toBe(0);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("MemoryCoordinator", () => {
  it("skips persistence when a completed run is superseded during turn analysis", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-superseded-analysis-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const learning = new LearningStore(database);
    const runtime = new DelayedAnalysisRuntime();
    const conversation = store.createConversation("web", "新对话", { profileId: "local-operator" });
    const run = store.createRun(conversation.id, "我还是没理解递归为什么需要出口，请换种讲法教我。", "normal");
    store.replaceMessageText(run.assistantMessageId, "可以，我们换一个例子来解释。");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      events,
      runtime,
      undefined,
      undefined,
      undefined,
      learning
    );

    coordinator.enqueue(run);
    await runtime.waitUntilAnalysisStarts();
    store.createBranchFromMessage(run.userMessageId, { asNewConversation: false, includeTarget: false });
    runtime.release();
    await waitFor(() => memories.getExtraction(run.id)?.status === "skipped");

    expect(store.getRun(run.id)?.supersededAt).toEqual(expect.any(String));
    expect(store.getConversation(conversation.id)?.title).toBe("新对话");
    expect(memories.list({ category: "task" })).toHaveLength(0);
    expect(learning.getSessionForConversation(conversation.id)).toBeNull();
    expect(events.list(conversation.id).some((event) => event.type === "learning.suggested")).toBe(false);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("retries durable extraction jobs and completes without affecting the run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-jobs-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const runtime = new RetryAnalysisRuntime();
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "需要整理这次已经完成的申请任务并记下结论", "normal");
    store.replaceMessageText(run.assistantMessageId, "任务已经完成，下一步继续核对官方截止日期和材料清单。");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");

    memories.enqueueExtraction(run.id);
    memories.markExtraction(run.id, "running");
    const coordinator = new MemoryCoordinator(config(root), store, memories, events, runtime);
    await waitFor(() => memories.getExtraction(run.id)?.status === "completed");

    expect(runtime.attempts).toBe(2);
    expect(memories.getExtraction(run.id)?.attempts).toBe(3);
    expect(memories.list({ category: "task" })[0]).toMatchObject({
      title: "恢复任务",
      scope: "profile",
      profileId: "local-operator"
    });
    expect(store.getRun(run.id)?.status).toBe("completed");
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("runs maintenance when the new task threshold is reached", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-maintenance-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const runtime = new RefinementRuntime();
    const coordinator = new MemoryCoordinator(config(root), store, memories, events, runtime);
    memories.getMaintenanceStatus();
    database.prepare("UPDATE memory_maintenance_state SET last_run_at = ? WHERE id = 1").run(Date.now() - 1_000);
    for (let index = 0; index < 50; index += 1) {
      memories.create({
        category: "task",
        title: `发布任务 ${index}`,
        content: `完成第 ${index} 项发布准备`,
        sourceKind: "auto"
      });
    }
    const protectedMemory = memories.createExplicit({
      category: "preference",
      title: "保护的偏好",
      content: "这条明确记忆不能由整理修改",
      importance: 4
    }).memory!;

    expect(coordinator.scheduleMaintenance().status).toBe("running");
    await waitFor(() => coordinator.maintenanceStatus().status === "idle" && runtime.refinements === 2);
    expect(memories.list({ category: "project" })[0]).toMatchObject({ title: "长期发布项目" });
    expect(
      memories.list({ category: "task", includeSuperseded: true }).filter((item) => item.status === "superseded")
    ).toHaveLength(6);
    expect(memories.get(runtime.updatedId)).toMatchObject({ title: "高优先级发布结论", importance: 5 });
    expect(memories.get(runtime.supersededId)?.status).toBe("superseded");
    expect(memories.get(protectedMemory.id)).toMatchObject({
      title: "保护的偏好",
      content: "这条明确记忆不能由整理修改",
      importance: 4,
      status: "active"
    });
    expect(coordinator.maintenanceStatus()).toMatchObject({ due: false, newTaskCount: 0 });

    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects memory-control and pure-recall turns from task history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-admission-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const runtime = new AdmissionRuntime();
    const coordinator = new MemoryCoordinator(config(root), store, memories, events, runtime);
    const conversation = store.createConversation();
    for (const prompt of [
      "请你帮我记住我今年 21 岁",
      "帮我忘掉旧地址",
      "记一下我偏好简洁回答",
      "能告诉我我今年几岁吗？",
      "告诉我我几岁",
      "还记得我几岁吗",
      "我叫什么名字"
    ]) {
      const run = store.createRun(conversation.id, prompt, "normal");
      store.replaceMessageText(run.assistantMessageId, "已回答");
      store.setMessageStatus(run.assistantMessageId, "completed");
      store.setRunStatus(run.id, "completed");
      coordinator.enqueue(run);
      await waitFor(() => memories.getExtraction(run.id)?.status === "completed");
    }
    expect(memories.list({ category: "task" })).toEqual([]);

    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("skips invalid refinement items and completes maintenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-maintenance-failure-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      new ApplicationFailureRuntime()
    );
    const kept = memories.create({ category: "task", title: "任务", content: "待整理任务", sourceKind: "auto" });

    expect(coordinator.scheduleMaintenance(true).status).toBe("running");
    await waitFor(() => coordinator.maintenanceStatus().status === "idle");
    expect(memories.get(kept.id)).toMatchObject({ title: "任务", content: "待整理任务", status: "active" });
    expect(coordinator.maintenanceStatus().lastError).toBeNull();

    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("completes force maintenance with a heuristic fallback when refinement throws", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-maintenance-heuristic-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      new EventStore(database),
      new ThrowingRefinementRuntime()
    );
    const first = memories.create({ category: "task", title: "发布准备", content: "整理发布清单", sourceKind: "auto" });
    const second = memories.create({
      category: "task",
      title: "发布准备",
      content: "整理发布清单",
      sourceKind: "auto"
    });

    expect(coordinator.scheduleMaintenance(true).status).toBe("running");
    await waitFor(() => coordinator.maintenanceStatus().status === "idle");
    const remaining = memories.list({ category: "task" });
    expect(remaining.some((item) => item.id === first.id || item.id === second.id)).toBe(true);
    expect(remaining.filter((item) => item.status === "active").length).toBeLessThanOrEqual(2);

    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps maintenance batches profile-scoped when a refinement targets another profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-maintenance-scope-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const runtime = new CrossProfileRefinementRuntime();
    const coordinator = new MemoryCoordinator(config(root), store, memories, new EventStore(database), runtime);
    const globalPreference = memories.createExplicit({
      category: "preference",
      title: "全局偏好",
      content: "这条可作为只读参考"
    }).memory!;
    const admissions = memories.create({
      category: "task",
      title: "申请材料",
      content: "整理研究生申请材料",
      sourceKind: "auto",
      scope: "profile",
      profileId: "graduate-admissions"
    });
    const local = memories.create({
      category: "task",
      title: "本地发布",
      content: "整理本地发布检查项",
      sourceKind: "auto",
      scope: "profile",
      profileId: "local-operator"
    });
    runtime.foreignMemoryId = local.id;

    expect(coordinator.scheduleMaintenance(true).status).toBe("running");
    await waitFor(() => coordinator.maintenanceStatus().status === "idle" && runtime.batches.length >= 2);

    expect(
      runtime.batches.some(
        (batch) =>
          batch.some((memory) => memory.profileId === "graduate-admissions") &&
          batch.some((memory) => memory.profileId === "local-operator")
      )
    ).toBe(false);
    expect(runtime.batches.every((batch) => batch.some((memory) => memory.id === globalPreference.id))).toBe(true);
    expect(runtime.batches.some((batch) => batch.some((memory) => memory.id === admissions.id))).toBe(true);
    expect(memories.get(local.id)).toMatchObject({
      content: "整理本地发布检查项",
      status: "active"
    });
    expect(
      memories.updateAutomaticMemory(
        local.id,
        {
          title: "仍然不应改写",
          content: "跨 Profile 更新必须被 store 拒绝",
          keywords: [],
          importance: 1
        },
        { scope: "profile", profileId: "graduate-admissions" }
      )
    ).toBeNull();
    expect(
      memories.supersedeAutomaticMemories([local.id], {
        scope: "profile",
        profileId: "graduate-admissions"
      })
    ).toBe(0);

    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates one opt-in learning suggestion after an explicit understanding difficulty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-suggestion-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const learning = new LearningStore(database);
    const runtime = new AdmissionRuntime();
    const conversation = store.createConversation("web", "学习", { profileId: "local-operator" });
    const run = store.createRun(conversation.id, "我还是没理解递归为什么需要出口，请换种讲法教我。", "normal");
    store.replaceMessageText(run.assistantMessageId, "可以，我们换一个例子来解释。");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      events,
      runtime,
      undefined,
      undefined,
      undefined,
      learning
    );
    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "completed");

    expect(learning.getSessionForConversation(conversation.id)).toMatchObject({
      status: "suggested",
      goal: expect.stringContaining("递归")
    });
    expect(events.list(conversation.id).some((event) => event.type === "learning.suggested")).toBe(true);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not suggest the web-only learning mode inside a Feishu conversation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-suggestion-feishu-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const events = new EventStore(database);
    const learning = new LearningStore(database);
    const runtime = new AdmissionRuntime();
    const conversation = store.createConversation("feishu", "飞书学习", { profileId: "graduate-admissions" });
    const run = store.createRun(conversation.id, "我还是没理解递归为什么需要出口，请换种讲法教我。", "normal");
    store.replaceMessageText(run.assistantMessageId, "可以，我们换一个例子来解释。");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const coordinator = new MemoryCoordinator(
      config(root),
      store,
      memories,
      events,
      runtime,
      undefined,
      undefined,
      undefined,
      learning
    );
    coordinator.enqueue(run);
    await waitFor(() => memories.getExtraction(run.id)?.status === "completed");

    expect(learning.getSessionForConversation(conversation.id)).toBeNull();
    expect(events.list(conversation.id).some((event) => event.type === "learning.suggested")).toBe(false);
    await coordinator.stop();
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});

function config(workspaceRoot: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    workspaceRoot,
    runtime: "demo",
    claudeAuthConfigured: false,
    claudeAuthSource: "none",
    claudeSettingsMode: "isolated",
    claudeConfigDir: path.join(workspaceRoot, ".claude"),
    claudeConfigDirExplicit: false,
    model: "sonnet",
    modelDisplay: "sonnet",
    effort: "high",
    maxConcurrency: 1,
    maxTurns: 30,
    runTimeoutMs: 10_000,
    maxBudgetUsd: 2,
    logLevel: "silent",
    nodeEnv: "test"
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for memory job");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
