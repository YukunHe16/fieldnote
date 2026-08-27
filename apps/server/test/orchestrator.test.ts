import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EventStore } from "../src/event-store.js";
import { MemoryCoordinator } from "../src/memory-coordinator.js";
import { MemoryStore } from "../src/memory-store.js";
import { RunOrchestrator } from "../src/orchestrator.js";
import type { AgentRuntime, RuntimeEvent, RuntimeInput, RuntimeSupplement } from "../src/runtime.js";
import { emptyTurnAnalysis } from "../src/runtime.js";
import { AgentStore } from "../src/store.js";
import { RunReplayStore } from "../src/run-replay.js";
import { CollaborationStore } from "../src/collaboration-store.js";
import { InputFileManifestService } from "../src/input-file-manifest.js";

class SlowRuntime implements AgentRuntime {
  readonly kind = "demo" as const;

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "status", message: "working" };
    await new Promise<void>((_resolve, reject) => {
      input.abortController.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("Interrupted"), { name: "AbortError" })),
        { once: true }
      );
    });
    yield { type: "completed" };
  }
}

class SupplementRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  seenInputFiles: RuntimeSupplement["inputFiles"] = [];

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    yield { type: "status", message: "working" };
    const iterator = input.supplements[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    this.seenInputFiles = [first, second]
      .filter((item): item is IteratorYieldResult<RuntimeSupplement> => !item.done)
      .flatMap((item) => item.value.inputFiles ?? []);
    const prompts = [first, second]
      .filter((item): item is IteratorYieldResult<RuntimeSupplement> => !item.done)
      .map((item) => item.value.prompt);
    input.supplements.close();
    yield { type: "text.delta", delta: prompts.join("|") };
    yield { type: "completed" };
  }
}

class FinalizingRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  private resolve!: () => void;
  private readonly pending = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });

  release(): void {
    this.resolve();
  }

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    input.supplements.close();
    yield { type: "status", message: "finalizing" };
    await this.pending;
    yield { type: "text.delta", delta: "done" };
    yield { type: "completed" };
  }
}

class ControlledCompletionRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  private input?: RuntimeInput;
  private resolve!: () => void;
  private readonly pending = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });

  release(): void {
    this.resolve();
  }

  closeSupplements(): void {
    this.input?.supplements.close();
  }

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    this.input = input;
    yield { type: "status", message: "working" };
    await this.pending;
    yield { type: "completed" };
  }
}

class TitleRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  analysisInputs: Array<{ prompt: string; response: string }> = [];

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    input.supplements.close();
    yield {
      type: "text.delta",
      delta: "这是一段完整回答。我比较了两个方案的取舍、适用场景和常见误区，并建议先核官方文档再把结论写进笔记。"
    };
    yield { type: "completed" };
  }

  async analyzeTurn(input: { prompt: string; response: string }) {
    this.analysisInputs.push(input);
    return {
      ...emptyTurnAnalysis("模型生成的短标题"),
      title: "模型生成的短标题",
      meaningfulTask: true,
      taskType: "durable_task" as const,
      task: { title: "方案比较", summary: "完成了两个方案的比较", keywords: ["方案比较"], importance: 3 },
      memories: [
        {
          memoryId: null,
          category: "preference" as const,
          title: "比较方式",
          content: "用户希望比较方案",
          keywords: ["比较"],
          importance: 3
        }
      ]
    };
  }
}

class FileRuntime implements AgentRuntime {
  readonly kind = "demo" as const;

  constructor(
    private readonly file: { relativePath: string; fileName: string; mimeType: string; size: number; sha256: string }
  ) {}

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    input.supplements.close();
    yield { type: "text.delta", delta: "已写好文书。" };
    yield { type: "file.created", ...this.file };
    yield { type: "completed" };
  }
}

class ActivityRuntime implements AgentRuntime {
  readonly kind = "demo" as const;

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    input.supplements.close();
    yield { type: "text.delta", delta: "先", messageUuid: "token-event-1" };
    yield { type: "text.delta", delta: "查资料。", messageUuid: "token-event-2" };
    yield {
      type: "tool.started",
      toolUseId: "source-tool",
      toolName: "mcp__admissions_evidence__fetch",
      inputSummary: "example.edu",
      activityKind: "mcp",
      displayName: "Sources"
    };
    yield { type: "tool.updated", toolUseId: "source-tool", inputSummary: '{"url":"https://example.edu"}' };
    yield { type: "tool.updated", toolUseId: "source-tool", message: "正在核验" };
    yield { type: "tool.completed", toolUseId: "source-tool", outputSummary: "已核验 1 个页面" };
    yield { type: "text.delta", delta: "这是", messageUuid: "token-event-3" };
    yield { type: "text.delta", delta: "结论。", messageUuid: "token-event-4" };
    yield { type: "completed" };
  }
}

class CaptureRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  last?: RuntimeInput;

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    this.last = input;
    input.supplements.close();
    yield { type: "text.delta", delta: "ok" };
    yield { type: "completed" };
  }
}

function testConfig(workspaceRoot: string): AppConfig {
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

describe("RunOrchestrator", () => {
  it("persists and streams ordered activity blocks alongside the main answer", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-activities-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const orchestrator = new RunOrchestrator(testConfig(workspaceRoot), store, events, new ActivityRuntime());
    const conversation = store.createConversation();
    const run = orchestrator.submit(conversation.id, "查项目");
    await waitFor(() => store.getRun(run.id)?.status === "completed");

    const assistant = store.getMessage(run.assistantMessageId)!;
    expect(assistant.content).toBe("先查资料。这是结论。");
    expect(assistant.blocks.map((block) => block.kind)).toEqual(["text", "activity", "text"]);
    expect(assistant.blocks[0]?.content).toBe("先查资料。");
    expect(assistant.blocks[2]?.content).toBe("这是结论。");
    expect(assistant.blocks[1]?.activity).toMatchObject({
      displayName: "Sources",
      technicalName: "mcp__admissions_evidence__fetch",
      status: "completed",
      outputSummary: "已核验 1 个页面",
      inputSummary: '{"url":"https://example.edu"}'
    });
    expect(events.list(conversation.id).map((event) => event.type)).toEqual(
      expect.arrayContaining(["activity.started", "activity.updated", "activity.completed"])
    );

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("attaches agent-created workspace files to the assistant reply", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-files-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation();
    const relativePath = "sop.md";
    await fs.mkdir(path.join(workspaceRoot, conversation.id), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, conversation.id, relativePath), "# SOP");
    const orchestrator = new RunOrchestrator(
      testConfig(workspaceRoot),
      store,
      events,
      new FileRuntime({
        relativePath,
        fileName: "sop.md",
        mimeType: "text/markdown",
        size: 5,
        sha256: "a".repeat(64)
      })
    );
    const run = orchestrator.submit(conversation.id, "写一份 SOP");
    await waitFor(() => store.getRun(run.id)?.status === "completed");
    const assistant = store.getMessage(run.assistantMessageId)!;
    expect(assistant.attachments).toEqual([
      expect.objectContaining({
        fileName: "sop.md",
        mimeType: "text/markdown",
        presented: false
      })
    ]);
    expect(events.list(conversation.id).some((event) => event.type === "attachment.updated")).toBe(true);
    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("interrupts an active run and preserves its partial message", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-interrupt-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const orchestrator = new RunOrchestrator(config, store, events, new SlowRuntime());
    const conversation = store.createConversation();
    const run = orchestrator.submit(conversation.id, "keep the partial response");
    await waitFor(() => store.getRun(run.id)?.status === "running");
    const queued = orchestrator.submit(conversation.id, "cancel this queued turn too", "queue");
    expect(orchestrator.interruptConversation(conversation.id)).toBe(true);
    await waitFor(() => store.getRun(run.id)?.status === "interrupted");
    expect(store.getRun(queued.id)?.status).toBe("interrupted");
    expect(store.getMessage(run.assistantMessageId)?.status).toBe("interrupted");
    expect(events.list(conversation.id).at(-1)?.type).toBe("run.interrupted");

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("cancels active and queued runs removed by an edited branch", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-superseded-runs-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const orchestrator = new RunOrchestrator(testConfig(workspaceRoot), store, events, new SlowRuntime());
    const conversation = store.createConversation();
    const active = orchestrator.submit(conversation.id, "原始问题");
    await waitFor(() => store.getRun(active.id)?.status === "running");
    const queued = orchestrator.submit(conversation.id, "稍后问题", "queue");

    store.createBranchFromMessage(active.userMessageId, { asNewConversation: false, includeTarget: true });
    expect(orchestrator.interruptSupersededRuns(conversation.id)).toBe(2);
    await waitFor(() => store.getRun(active.id)?.status === "interrupted");
    expect(store.getRun(queued.id)).toMatchObject({ status: "interrupted", supersededAt: expect.any(String) });
    expect(
      events.list(conversation.id).some((event) => event.runId === queued.id && event.type === "run.interrupted")
    ).toBe(true);

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("accepts explicit supplemental messages in the active run and deduplicates only transport retries", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-supplement-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const conversation = store.createConversation();
    const runtime = new SupplementRuntime();
    const replay = new RunReplayStore(database, path.join(workspaceRoot, ".snapshots"));
    const inputFiles = new InputFileManifestService(store, workspaceRoot);
    const orchestrator = new RunOrchestrator(config, store, events, runtime, undefined, { inputFiles, replay });
    await fs.mkdir(path.join(workspaceRoot, conversation.id, "attachments"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, conversation.id, "attachments", "supplement.txt"), "B");
    const supplementAttachment = store.createAttachment({
      conversationId: conversation.id,
      fileName: "supplement.txt",
      storedName: "supplement.txt",
      mimeType: "text/plain",
      size: 1,
      sha256: "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c",
      relativePath: "attachments/supplement.txt"
    });
    const otherConversation = store.createConversation();
    const foreignAttachment = store.createAttachment({
      conversationId: otherConversation.id,
      fileName: "foreign.txt",
      storedName: "foreign.txt",
      mimeType: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
      relativePath: "attachments/foreign.txt"
    });
    const run = orchestrator.submit(conversation.id, "A", "normal", [], "11111111-1111-4111-8111-111111111111");
    await waitFor(() => store.getRun(run.id)?.status === "running");

    await expect(
      orchestrator.supplement(conversation.id, "B", [foreignAttachment.id], "22222222-2222-4222-8222-222222222222")
    ).rejects.toThrow("不属于当前对话");
    const first = await orchestrator.supplement(
      conversation.id,
      "B",
      [supplementAttachment.id],
      "22222222-2222-4222-8222-222222222222"
    );
    const retry = await orchestrator.supplement(conversation.id, "B", [], "22222222-2222-4222-8222-222222222222");
    const explicitRepeat = await orchestrator.supplement(
      conversation.id,
      "B",
      [],
      "33333333-3333-4333-8333-333333333333"
    );
    expect(first?.run.id).toBe(run.id);
    expect(retry?.duplicate).toBe(true);
    expect(retry?.message.id).toBe(first?.message.id);
    expect(first?.message.attachments).toEqual([expect.objectContaining({ id: supplementAttachment.id })]);
    expect(explicitRepeat?.message.id).not.toBe(first?.message.id);

    await waitFor(() => store.getRun(run.id)?.status === "completed");
    const detail = store.getConversation(conversation.id)!;
    expect(detail.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "A",
      "B",
      "B"
    ]);
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", content: "B|B", status: "completed" });
    expect(runtime.seenInputFiles).toEqual([expect.objectContaining({ attachmentId: supplementAttachment.id })]);
    expect(replay.getByRun(run.id)?.overlay.inputFiles).toEqual([
      expect.objectContaining({ attachmentId: supplementAttachment.id, source: "history" })
    ]);
    expect(replay.getByRun(run.id)?.prompt).toBe("A\n\n补充信息：B\n\n补充信息：B");

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("does not persist a supplement when manifest validation outlives its active run", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-supplement-race-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const runtime = new ControlledCompletionRuntime();
    let markManifestStarted!: () => void;
    let releaseManifest!: () => void;
    const manifestStarted = new Promise<void>((resolve) => {
      markManifestStarted = resolve;
    });
    const manifestReleased = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const inputFiles = {
      async buildForMessage() {
        return { items: [], errors: [] };
      },
      async buildForPendingAttachments() {
        markManifestStarted();
        await manifestReleased;
        return { items: [], errors: [] };
      }
    } as unknown as InputFileManifestService;
    const orchestrator = new RunOrchestrator(testConfig(workspaceRoot), store, events, runtime, undefined, {
      inputFiles
    });
    const conversation = store.createConversation();
    const run = orchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(run.id)?.status === "running");

    const supplement = orchestrator.supplement(
      conversation.id,
      "late input",
      [],
      "22222222-2222-4222-8222-222222222222"
    );
    await manifestStarted;
    runtime.release();
    await waitFor(() => store.getRun(run.id)?.status === "completed");
    releaseManifest();

    await expect(supplement).resolves.toBeNull();
    expect(store.getConversation(conversation.id)?.messages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ id: run.userMessageId, content: "A" })
    ]);

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps a queued run intact when its steer manifest outlives the active input queue", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-steer-race-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const runtime = new ControlledCompletionRuntime();
    let queuedMessageId = "";
    let markManifestStarted!: () => void;
    let releaseManifest!: () => void;
    const manifestStarted = new Promise<void>((resolve) => {
      markManifestStarted = resolve;
    });
    const manifestReleased = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const inputFiles = {
      async buildForMessage(_conversationId: string, messageId: string) {
        if (messageId !== queuedMessageId) return { items: [], errors: [] };
        markManifestStarted();
        await manifestReleased;
        return { items: [], errors: [] };
      }
    } as unknown as InputFileManifestService;
    const orchestrator = new RunOrchestrator(testConfig(workspaceRoot), store, events, runtime, undefined, {
      inputFiles
    });
    const conversation = store.createConversation();
    const active = orchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(active.id)?.status === "running");
    const queued = orchestrator.submit(conversation.id, "B", "queue");
    queuedMessageId = queued.userMessageId;

    const steering = orchestrator.steerQueuedRun(queued.id);
    await manifestStarted;
    runtime.closeSupplements();
    releaseManifest();

    await expect(steering).resolves.toMatchObject({ run: { id: queued.id }, acceptedAs: "queued" });
    expect(store.getRun(queued.id)?.status).toBe("queued");
    expect(store.getMessage(queued.userMessageId)?.runId).toBe(queued.id);

    runtime.release();
    await waitFor(() => store.getRun(queued.id)?.status === "completed");
    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps queued messages separate until the user steers one into the active run", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-steer-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const orchestrator = new RunOrchestrator(config, store, events, new SupplementRuntime());
    const conversation = store.createConversation();
    const active = orchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(active.id)?.status === "running");
    const queued = orchestrator.submit(conversation.id, "B", "queue");

    const before = store.getConversation(conversation.id)!;
    expect(before).toMatchObject({ status: "running", activeRunId: active.id });
    expect(before.queuedRuns).toEqual([{ runId: queued.id, userMessageId: queued.userMessageId }]);

    const steered = await orchestrator.steerQueuedRun(queued.id);
    expect(steered?.run.id).toBe(active.id);
    expect(steered?.acceptedAs).toBe("supplement");
    expect(steered?.message.content).toBe("B");
    expect(store.getRun(queued.id)?.status).toBe("interrupted");
    expect(store.getConversation(conversation.id)?.queuedRuns).toEqual([]);
    await orchestrator.supplement(conversation.id, "C");

    await waitFor(() => store.getRun(active.id)?.status === "completed");
    const detail = store.getConversation(conversation.id)!;
    expect(detail.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "A",
      "B",
      "C"
    ]);
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", content: "B|C", status: "completed" });
    expect(
      events.list(conversation.id).some((event) => event.runId === queued.id && event.type === "run.interrupted")
    ).toBe(true);

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("edits and deletes a queued turn without leaving it in the transcript", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-queue-edit-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const orchestrator = new RunOrchestrator(config, store, events, new SlowRuntime());
    const conversation = store.createConversation();
    const active = orchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(active.id)?.status === "running");
    const queued = orchestrator.submit(conversation.id, "哈哈", "queue");
    const later = orchestrator.submit(conversation.id, "之后再问", "queue");

    const edited = orchestrator.updateQueuedRun(queued.id, "改过的问题");
    expect(edited?.content).toBe("改过的问题");
    expect(store.getMessage(queued.userMessageId)?.content).toBe("改过的问题");
    expect(store.getConversation(conversation.id)?.queuedRuns).toEqual([
      { runId: queued.id, userMessageId: queued.userMessageId },
      { runId: later.id, userMessageId: later.userMessageId }
    ]);

    expect(orchestrator.deleteQueuedRun(queued.id)).toBe(true);
    expect(store.getRun(queued.id)?.status).toBe("interrupted");
    expect(store.getMessage(queued.userMessageId)).toBeNull();
    const afterDelete = store.getConversation(conversation.id)!;
    expect(afterDelete.queuedRuns).toEqual([{ runId: later.id, userMessageId: later.userMessageId }]);
    expect(afterDelete.messages.some((message) => message.id === queued.userMessageId)).toBe(false);
    expect(
      events.list(conversation.id).some((event) => event.type === "message.updated" && event.runId === queued.id)
    ).toBe(true);
    expect(
      events
        .list(conversation.id)
        .some((event) => event.runId === queued.id && event.payload.reason === "queued_run_deleted")
    ).toBe(true);

    orchestrator.interrupt(active.id);
    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("accepts steer while the active input stream is already finalizing", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-steer-finalizing-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const runtime = new FinalizingRuntime();
    const orchestrator = new RunOrchestrator(config, store, events, runtime);
    const conversation = store.createConversation();
    const active = orchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(active.id)?.status === "running");
    const queued = orchestrator.submit(conversation.id, "B", "queue");

    const accepted = await orchestrator.steerQueuedRun(queued.id);
    expect(accepted?.acceptedAs).toBe("queued");
    expect(accepted?.run.id).toBe(queued.id);
    expect(store.getRun(queued.id)?.status).toBe("queued");

    runtime.release();
    await waitFor(() => store.getRun(queued.id)?.status === "completed");
    expect(store.getMessage(queued.assistantMessageId)?.content).toBe("done");

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("repositions queued turns when they start so visible history stays FIFO", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-queue-order-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const orchestrator = new RunOrchestrator(config, store, events, new SlowRuntime());
    const conversation = store.createConversation();
    const first = orchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(first.id)?.status === "running");
    const second = orchestrator.submit(conversation.id, "B", "queue");
    const third = orchestrator.submit(conversation.id, "C", "queue");
    expect(store.getConversation(conversation.id)?.queuedRuns?.map((run) => run.runId)).toEqual([second.id, third.id]);

    orchestrator.interrupt(first.id);
    await waitFor(() => store.getRun(second.id)?.status === "running");
    orchestrator.interrupt(second.id);
    await waitFor(() => store.getRun(third.id)?.status === "running");

    const detail = store.getConversation(conversation.id)!;
    expect(detail.messages.map((message) => [message.role, message.content, message.status])).toEqual([
      ["user", "A", "completed"],
      ["assistant", "", "interrupted"],
      ["user", "B", "completed"],
      ["assistant", "", "interrupted"],
      ["user", "C", "completed"],
      ["assistant", "", "streaming"]
    ]);

    orchestrator.interrupt(third.id);
    await waitFor(() => store.getRun(third.id)?.status === "interrupted");
    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("resumes durable queued runs after an orchestrator restart", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-queue-restart-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const config = testConfig(workspaceRoot);
    const firstOrchestrator = new RunOrchestrator(config, store, events, new SlowRuntime());
    const conversation = store.createConversation();
    const active = firstOrchestrator.submit(conversation.id, "A");
    await waitFor(() => store.getRun(active.id)?.status === "running");
    const queued = firstOrchestrator.submit(conversation.id, "B", "queue");
    await firstOrchestrator.stop();
    expect(store.getRun(queued.id)?.status).toBe("queued");

    const restarted = new RunOrchestrator(config, store, events, new SlowRuntime());
    expect(store.getRun(active.id)?.status).toBe("interrupted");
    expect(store.getMessage(active.assistantMessageId)?.blocks.every((block) => block.status !== "running")).toBe(true);
    expect(
      events.list(conversation.id).some((event) => event.runId === active.id && event.type === "run.interrupted")
    ).toBe(true);
    await waitFor(() => store.getRun(queued.id)?.status === "running");
    expect(store.getConversation(conversation.id)?.activeRunId).toBe(queued.id);

    restarted.interrupt(queued.id);
    await waitFor(() => store.getRun(queued.id)?.status === "interrupted");
    await restarted.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("recovers persisted specialist tasks as interrupted with their host run", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-collaboration-restart-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "核验资料", "normal");
    store.setRunStatus(run.id, "running");
    const collaboration = new CollaborationStore(database);
    const task = collaboration.markRunning(
      collaboration.createTask({
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
        specialistId: "source-verifier",
        displayName: "资料核验员",
        requestSummary: "核验官方来源"
      }).id
    );

    const restarted = new RunOrchestrator(testConfig(workspaceRoot), store, events, new SlowRuntime(), undefined, {
      collaboration
    });
    expect(store.getRun(run.id)?.status).toBe("interrupted");
    expect(collaboration.getTask(task.id)).toMatchObject({
      status: "interrupted",
      error: "Server restarted during the specialist run"
    });
    await restarted.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("generates a model title after the first completed turn without overwriting manual titles", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-title-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const runtime = new TitleRuntime();
    const memories = new MemoryStore(database);
    const coordinator = new MemoryCoordinator(testConfig(workspaceRoot), store, memories, events, runtime);
    const orchestrator = new RunOrchestrator(testConfig(workspaceRoot), store, events, runtime, coordinator);

    const conversation = store.createConversation();
    const run = orchestrator.submit(conversation.id, "帮我比较两个方案");
    expect(store.getConversation(conversation.id)?.title).toBe("新对话");
    await waitFor(() => store.getRun(run.id)?.status === "completed");
    await waitFor(() => store.getConversation(conversation.id)?.title === "模型生成的短标题");
    expect(runtime.analysisInputs[0]).toMatchObject({
      prompt: "帮我比较两个方案",
      response: "这是一段完整回答。我比较了两个方案的取舍、适用场景和常见误区，并建议先核官方文档再把结论写进笔记。"
    });
    expect(memories.list({ category: "task" })[0]).toMatchObject({ title: "方案比较" });
    expect(memories.list({ category: "preference" })[0]).toMatchObject({ title: "比较方式" });
    expect(events.list(conversation.id).some((event) => event.type === "conversation.updated")).toBe(true);

    const renamed = store.createConversation();
    const renamedRun = orchestrator.submit(renamed.id, "另一个问题");
    store.updateConversation(renamed.id, { title: "我的手动标题" });
    await waitFor(() => store.getRun(renamedRun.id)?.status === "completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getConversation(renamed.id)?.title).toBe("我的手动标题");

    await orchestrator.stop();
    await coordinator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("pins a frozen overlay from the replay store, not a workspace file", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-replay-pin-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const events = new EventStore(database);
    const replay = new RunReplayStore(database, path.join(workspaceRoot, ".snapshots"));
    const runtime = new CaptureRuntime();
    const orchestrator = new RunOrchestrator(testConfig(workspaceRoot), store, events, runtime, undefined, { replay });
    const conversation = store.createConversation("web", "回放", { profileId: "local-operator" });
    await fs.mkdir(path.join(workspaceRoot, conversation.id), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, conversation.id, ".replay.json"),
      JSON.stringify({
        sourceRunId: "forged",
        mode: "with-artifact",
        includeArtifactId: "00000000-0000-4000-8000-000000000099",
        prompt: "forged",
        overlay: { artifactIds: ["00000000-0000-4000-8000-000000000099"], playbookIds: [], playbooks: [] }
      })
    );
    replay.pinConversation(conversation.id, {
      sourceRunId: "run-source",
      mode: "frozen",
      prompt: "改简历",
      overlay: {
        id: "overlay-1",
        playbookIds: ["playbook-1"],
        artifactIds: ["artifact-1"],
        cardTitle: null,
        playbooks: [{ id: "playbook-1", title: "先核官方", polarity: "do" }],
        card: null
      }
    });
    const run = orchestrator.submit(conversation.id, "改简历");
    await waitFor(() => store.getRun(run.id)?.status === "completed");
    expect(runtime.last?.pinnedOverlay?.artifactIds).toEqual(["artifact-1"]);
    expect(runtime.last?.previewArtifactIds).toEqual([]);
    expect(runtime.last?.replayMark?.sourceRunId).toBe("run-source");

    await orchestrator.stop();
    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
