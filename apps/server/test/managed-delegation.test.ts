import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ToolDefinition = {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};
let childMode: "success" | "failure" = "success";
let childOptions: Record<string, any> | undefined;
let parentOptions: Record<string, any> | undefined;
let childBudgets: unknown[] = [];
let parentDelegateCount = 1;
let parentDelegatesInParallel = false;
let parentResultDelayMs = 0;
let childSubmitsStructured = false;
let childPrompt = "";
let childPrompts: string[] = [];
let parentUsesHandoff = false;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: ToolDefinition["handler"]) => ({
    name,
    handler
  }),
  createSdkMcpServer: (options: unknown) => options,
  query: ({ prompt, options }: { prompt: unknown; options: Record<string, any> }) => {
    if (typeof prompt === "string") {
      childPrompt = prompt;
      childPrompts.push(prompt);
      childOptions = options;
      childBudgets.push(options.maxBudgetUsd);
      return (async function* childQuery() {
        yield {
          type: "stream_event",
          uuid: "child-message",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "子助手" } }
        };
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield {
          type: "stream_event",
          uuid: "child-message",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "真实流" } }
        };
        yield {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: "notes.md" } }] }
        };
        if (childSubmitsStructured) {
          const resultServer = options.mcpServers.specialist_result as { tools: ToolDefinition[] };
          const submit = resultServer.tools.find((item) => item.name === "submit_specialist_result")!;
          await submit.handler(
            {
              summary: "完成官方核验 API_KEY=supersecretvalue",
              findings: [
                {
                  claim: "截止日期为 12 月 1 日",
                  status: "verified",
                  sourceUrls: ["https://example.edu/deadline"],
                  verifiedAt: "2026-08-21T00:00:00.000Z"
                }
              ],
              openQuestions: [],
              recommendedFollowups: []
            },
            {}
          );
        }
        if (childMode === "failure") {
          yield { type: "result", subtype: "error", result: "child failed", total_cost_usd: 0.2 };
          return;
        }
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "child-read", content: "done" }] }
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0.2 };
      })();
    }
    parentOptions = options;
    return (async function* parentQuery() {
      if (prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
        for await (const _message of prompt as AsyncIterable<unknown>) {
          /* consume host messages */
        }
      }
      const server = options.mcpServers.managed_delegation as { tools: ToolDefinition[] } | undefined;
      if (!server) {
        yield {
          type: "stream_event",
          uuid: "parent-final",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "真实 Agent 教学" } }
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0.1 };
        return;
      }
      const delegate = server.tools.find((item) => item.name === "delegate_researcher")!;
      if (parentDelegatesInParallel) {
        const toolUseIds = Array.from({ length: parentDelegateCount }, (_, index) => `outer-delegation-${index}`);
        yield {
          type: "assistant",
          uuid: "parent-tool-turn",
          message: {
            content: toolUseIds.map((id) => ({
              type: "tool_use",
              id,
              name: "mcp__managed_delegation__delegate_researcher",
              input: { task: "比较两个项目" }
            }))
          }
        };
        const results = await Promise.all(toolUseIds.map(() => delegate.handler({ task: "比较两个项目" }, {})));
        if (parentResultDelayMs) await new Promise((resolve) => setTimeout(resolve, parentResultDelayMs));
        yield {
          type: "user",
          uuid: "parent-tool-result",
          message: {
            content: toolUseIds.map((toolUseId, index) => ({
              type: "tool_result",
              tool_use_id: toolUseId,
              content: results[index]
            }))
          }
        };
      }
      let sourceTaskId: string | undefined;
      for (let index = 0; index < parentDelegateCount; index += 1) {
        if (parentDelegatesInParallel) break;
        const toolUseId = `outer-delegation-${index}`;
        yield {
          type: "assistant",
          uuid: "parent-tool-turn",
          message: {
            content: [
              {
                type: "tool_use",
                id: toolUseId,
                name: "mcp__managed_delegation__delegate_researcher",
                input: { task: "比较两个项目" }
              }
            ]
          }
        };
        const result = await delegate.handler(
          {
            task: index === 0 ? "比较两个项目" : "复核第一个专家的结论",
            ...(parentUsesHandoff && sourceTaskId ? { sourceTaskId } : {})
          },
          {}
        );
        if (parentUsesHandoff && index === 0) {
          const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
          if (text) sourceTaskId = (JSON.parse(text) as { taskId?: string }).taskId;
        }
        if (parentResultDelayMs) await new Promise((resolve) => setTimeout(resolve, parentResultDelayMs));
        yield {
          type: "user",
          uuid: "parent-tool-result",
          message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] }
        };
      }
      yield {
        type: "stream_event",
        uuid: "parent-final",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "主助手结论" } }
      };
      yield { type: "result", subtype: "success", total_cost_usd: 0.1 };
    })();
  }
}));

type SqliteDatabase = ReturnType<typeof import("../src/database.js").openDatabase>;

const roots: string[] = [];
const databases: SqliteDatabase[] = [];

/**
 * No profile ships built-in delegates any more, so the managed delegation server only exists
 * when an evolved subagent is enabled. `delegateFromArtifact` derives the tool name from the
 * slug, so the `researcher` slug is what makes `delegate_researcher` callable.
 */
async function enableEvolvedResearcher(existing?: SqliteDatabase) {
  const [{ openDatabase }, { EvolutionStore }] = await Promise.all([
    import("../src/database.js"),
    import("../src/evolution-store.js")
  ]);
  const database = existing ?? openDatabase(":memory:");
  if (!existing) databases.push(database);
  const evolution = new EvolutionStore(database);
  evolution.createArtifact({
    profileId: "local-operator",
    kind: "subagent",
    slug: "researcher",
    name: "个人流程子代理",
    description: "完成一个边界明确的调研任务",
    body: JSON.stringify({
      systemPrompt: "Complete one bounded research task and report the result back.",
      skills: [],
      mcpFactories: [],
      maxTurns: 8,
      allowDelegation: false
    }),
    origin: "distilled",
    status: "enabled"
  });
  return evolution;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  childMode = "success";
  childOptions = undefined;
  parentOptions = undefined;
  childBudgets = [];
  parentDelegateCount = 1;
  parentDelegatesInParallel = false;
  parentResultDelayMs = 0;
  childSubmitsStructured = false;
  childPrompt = "";
  childPrompts = [];
  parentUsesHandoff = false;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed specialist delegation", () => {
  it("uses low effort and loads Learning MCP for a real Agent demo", async () => {
    const [runtimeModule, databaseModule, storeModule, learningModule, coordinatorModule, sessionModule] =
      await Promise.all([
        import("../src/runtime.js"),
        import("../src/database.js"),
        import("../src/store.js"),
        import("../src/learning-store.js"),
        import("../src/learning-coordinator.js"),
        import("../src/session-store.js")
      ]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "real-agent-demo-runtime-"));
    roots.push(root);
    const database = databaseModule.openDatabase(":memory:");
    const agents = new storeModule.AgentStore(database);
    const conversation = agents.createConversation("web", "Agent demo", { profileId: "local-operator" });
    const learning = new learningModule.LearningStore(database);
    learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "Understand recursion",
      datasetKind: "demo",
      executionMode: "agent"
    });
    const run = agents.createRun(conversation.id, "Teach me the base case", "normal");
    const runtime = new runtimeModule.ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      new sessionModule.SqliteSessionStore(database),
      undefined,
      undefined,
      undefined,
      {
        learning: new coordinatorModule.LearningCoordinator(learning)
      }
    );
    const supplements = new runtimeModule.RuntimeInputQueue();
    supplements.close();
    for await (const _event of runtime.run({
      runId: run.id,
      conversationId: conversation.id,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      conversationTitle: conversation.title,
      memoryEnabled: false,
      profileId: "local-operator",
      prompt: "Teach me the base case",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    })) {
      /* consume mocked query */
    }

    expect(parentOptions?.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
    expect(parentOptions?.mcpServers?.learning).toBeTruthy();
    expect(parentOptions?.systemPrompt?.append).toContain(
      "before extended analysis or visible prose, call open_learning_incident"
    );
    database.close();
  });

  it("multiplexes real child query deltas while the parent MCP call is pending", async () => {
    const [{ ClaudeAgentRuntime, RuntimeInputQueue }] = await Promise.all([import("../src/runtime.js")]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-"));
    roots.push(root);
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      await enableEvolvedResearcher()
    );
    const supplements = new RuntimeInputQueue();
    supplements.close();
    const events = [];
    for await (const event of runtime.run({
      runId: "run-1",
      conversationId: "conversation-1",
      userMessageId: "message-1",
      conversationTitle: "项目比较",
      memoryEnabled: false,
      profileId: "local-operator",
      prompt: "比较两个项目",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    }))
      events.push(event);

    expect(events.map((event) => event.type).filter((type) => type !== "assistant.uuid")).toEqual(
      expect.arrayContaining([
        "activity.started",
        "activity.text.delta",
        "activity.started",
        "activity.completed",
        "text.delta",
        "completed"
      ])
    );
    expect(
      events
        .filter((event) => event.type === "activity.text.delta")
        .map((event) => event.delta)
        .join("")
    ).toBe("子助手真实流");
    expect(events.find((event) => event.type === "text.delta")).toMatchObject({ delta: "主助手结论" });
    expect(events.find((event) => event.type === "completed")).toMatchObject({ totalCostUsd: 0.3 });
    expect(childOptions).not.toHaveProperty("maxBudgetUsd");
    expect(childOptions?.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
    expect(parentOptions?.maxBudgetUsd).toBe(2);
    expect(childOptions?.hooks?.PreToolUse).toHaveLength(1);
    const guard = childOptions!.hooks.PreToolUse[0].hooks[0] as (input: unknown) => Promise<Record<string, any>>;
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-outside-"));
    roots.push(externalRoot);
    const outside = path.join(externalRoot, "outside.txt");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(root, "linked.txt"));
    await expect(guard({ tool_name: "Read", tool_input: { file_path: outside } })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" }
    });
    await expect(guard({ tool_name: "Grep", tool_input: { path: "../outside.txt" } })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" }
    });
    await expect(guard({ tool_name: "Bash", tool_input: { command: "cat linked.txt" } })).resolves.toEqual({});
    await expect(
      guard({
        tool_name: "Bash",
        tool_input: { command: "ls attachments/*.pdf", dangerouslyDisableSandbox: true }
      })
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect(
      guard({
        tool_name: "Write",
        tool_input: { file_path: "attachments/source.pdf", content: "overwrite" }
      })
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    // The tool allowlist belongs to the specialist child: `delegateToolsFor` grants Read to
    // every delegate but `source-verifier`, and Bash is added on top. The parent is never
    // restricted to an allowlist.
    expect(childOptions?.tools).toEqual(["Read", "Bash"]);
    expect(parentOptions?.sandbox?.allowUnsandboxedCommands).toBe(true);
    expect(parentOptions?.sandbox?.filesystem?.denyWrite).toEqual([path.join(root, "attachments")]);
    expect(childOptions?.sandbox?.filesystem?.denyWrite).toEqual([path.join(root, "attachments")]);
  });

  it("automatically carries a verified supplement manifest into later specialist work", async () => {
    const { ClaudeAgentRuntime, RuntimeInputQueue } = await import("../src/runtime.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-supplement-"));
    roots.push(root);
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      await enableEvolvedResearcher()
    );
    const supplements = new RuntimeInputQueue();
    supplements.push({
      prompt: "补充附件",
      attachments: [],
      inputFiles: [
        {
          attachmentId: "supplement-file",
          conversationId: "conversation-1",
          sourceMessageId: "supplement-message",
          originalFileName: "supplement.pdf",
          relativePath: "attachments/supplement.pdf",
          mimeType: "application/pdf",
          size: 12,
          sha256: "a".repeat(64),
          source: "current_message"
        }
      ]
    });
    supplements.close();
    for await (const _event of runtime.run({
      runId: "run-1",
      conversationId: "conversation-1",
      userMessageId: "message-1",
      assistantMessageId: "message-2",
      profileId: "local-operator",
      prompt: "核验资料",
      workspacePath: root,
      attachments: [],
      inputFiles: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    })) {
      /* drain */
    }

    expect(childPrompt).toContain("supplement.pdf");
    expect(childPrompt).toContain("attachments/supplement.pdf");
  });

  it("closes a nested activity when a specialist fails", async () => {
    childMode = "failure";
    const [{ ClaudeAgentRuntime, RuntimeInputQueue }] = await Promise.all([import("../src/runtime.js")]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-failure-"));
    roots.push(root);
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      await enableEvolvedResearcher()
    );
    const supplements = new RuntimeInputQueue();
    supplements.close();
    const events = [];
    for await (const event of runtime.run({
      profileId: "local-operator",
      prompt: "比较两个项目",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    }))
      events.push(event);
    const nested = events.filter(
      (event) => event.type.startsWith("activity.") && "activityId" in event && event.activityId.includes("child-read")
    );
    expect(nested.map((event) => event.type)).toEqual(["activity.started", "activity.failed"]);
    expect(events.find((event) => event.type === "completed")).toMatchObject({ totalCostUsd: 0.3 });
  });

  it("finishes when delegation terminal events were already streamed before the tool result", async () => {
    parentResultDelayMs = 25;
    const [{ ClaudeAgentRuntime, RuntimeInputQueue }] = await Promise.all([import("../src/runtime.js")]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-drained-"));
    roots.push(root);
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      await enableEvolvedResearcher()
    );
    const supplements = new RuntimeInputQueue();
    supplements.close();
    const collect = async () => {
      const events = [];
      for await (const event of runtime.run({
        profileId: "local-operator",
        prompt: "比较两个项目",
        workspacePath: root,
        attachments: [],
        branch: { sdkSessionId: null, resumeSessionAt: null },
        supplements,
        abortController: new AbortController()
      }))
        events.push(event);
      return events;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const events = await Promise.race([
        collect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("delegation stream deadlocked")), 2_000);
        })
      ]);
      expect(events.some((event) => event.type === "completed")).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  it("does not impose a dollar budget on concurrent specialists while aggregating their cost", async () => {
    parentDelegateCount = 2;
    parentDelegatesInParallel = true;
    const [{ ClaudeAgentRuntime, RuntimeInputQueue }] = await Promise.all([import("../src/runtime.js")]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-budget-"));
    roots.push(root);
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      await enableEvolvedResearcher()
    );
    const supplements = new RuntimeInputQueue();
    supplements.close();
    const events = [];
    for await (const event of runtime.run({
      profileId: "local-operator",
      prompt: "比较两个项目",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    }))
      events.push(event);
    expect(childBudgets).toHaveLength(2);
    expect(childBudgets).toEqual([undefined, undefined]);
    expect(parentOptions?.maxBudgetUsd).toBe(2);
    expect(events.find((event) => event.type === "completed")).toMatchObject({ totalCostUsd: 0.5 });
  });

  it("persists a structured specialist result with the verified input manifest", async () => {
    childSubmitsStructured = true;
    parentDelegateCount = 2;
    parentUsesHandoff = true;
    const [
      { ClaudeAgentRuntime, RuntimeInputQueue },
      { openDatabase },
      { AgentStore },
      { CollaborationStore },
      { LearningStore },
      { LearningCoordinator }
    ] = await Promise.all([
      import("../src/runtime.js"),
      import("../src/database.js"),
      import("../src/store.js"),
      import("../src/collaboration-store.js"),
      import("../src/learning-store.js"),
      import("../src/learning-coordinator.js")
    ]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-delegate-persisted-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const conversation = agents.createConversation("web", "协作核验", { profileId: "local-operator" });
    const run = agents.createRun(conversation.id, "核验截止日期", "normal");
    const collaboration = new CollaborationStore(database);
    const learning = new LearningStore(database);
    const learningCoordinator = new LearningCoordinator(learning);
    learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解如何核验相互冲突的截止日期",
      topicKey: "deadline-verification"
    });
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      await enableEvolvedResearcher(database),
      undefined,
      { collaboration, learning: learningCoordinator }
    );
    const supplements = new RuntimeInputQueue();
    supplements.close();
    const collaborationEvents = [];
    for await (const event of runtime.run({
      runId: run.id,
      conversationId: conversation.id,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      conversationTitle: conversation.title,
      memoryEnabled: false,
      profileId: "local-operator",
      prompt: "核验截止日期",
      workspacePath: root,
      attachments: [],
      inputFiles: [
        {
          attachmentId: "file-1",
          conversationId: conversation.id,
          sourceMessageId: run.userMessageId,
          originalFileName: "requirements.pdf",
          relativePath: "attachments/requirements.pdf",
          mimeType: "application/pdf",
          size: 12,
          sha256: "a".repeat(64),
          source: "current_message"
        }
      ],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    }))
      collaborationEvents.push(event);

    const tasks = collaboration.listForRun(run.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ status: "completed", structured: true, sourceTaskId: null });
    expect(tasks[1]).toMatchObject({ status: "completed", structured: true, sourceTaskId: tasks[0]?.id });
    expect(tasks[0]?.result?.findings[0]).toMatchObject({ status: "verified" });
    expect(tasks[0]?.result?.summary).toContain("API_KEY=[REDACTED]");
    expect(JSON.stringify(tasks)).not.toContain("supersecretvalue");
    expect(tasks[1]?.inputFiles[0]?.relativePath).toBe("attachments/requirements.pdf");
    expect(collaboration.listHandoffsForRun(run.id)).toEqual([
      expect.objectContaining({ sourceTaskId: tasks[0]?.id, targetTaskId: tasks[1]?.id, status: "completed" })
    ]);
    expect(childPrompt).toContain("<delegated_input_files>");
    expect(childPrompts[1]).toContain("<source_specialist_result>");
    expect(childPrompts[1]).toContain('"originalRequest":"比较两个项目"');
    expect(collaborationEvents.some((event) => event.type === "collaboration.task.updated")).toBe(true);
    expect(collaborationEvents.some((event) => event.type === "collaboration.handoff.updated")).toBe(true);
    expect(parentOptions?.mcpServers).toHaveProperty("learning");
    expect(JSON.stringify(parentOptions?.systemPrompt)).toContain(run.userMessageId);
    expect(learning.listIncidents(learning.getSessionForConversation(conversation.id)!.id)).toEqual([]);
    database.close();
  });

  it("loads learning tools only for an active web learning session", async () => {
    const [
      { ClaudeAgentRuntime, RuntimeInputQueue },
      { openDatabase },
      { AgentStore },
      { LearningStore },
      { LearningCoordinator }
    ] = await Promise.all([
      import("../src/runtime.js"),
      import("../src/database.js"),
      import("../src/store.js"),
      import("../src/learning-store.js"),
      import("../src/learning-coordinator.js")
    ]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-learning-tools-"));
    roots.push(root);
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const conversation = agents.createConversation("web", "学习", { profileId: "local-operator" });
    const run = agents.createRun(conversation.id, "我不理解递归", "normal");
    const learning = new LearningStore(database);
    const learningCoordinator = new LearningCoordinator(learning);
    learning.createSession({ conversationId: conversation.id, profileId: "local-operator", goal: "理解递归" });
    const runtime = new ClaudeAgentRuntime(
      {
        host: "127.0.0.1",
        port: 8787,
        databasePath: ":memory:",
        workspaceRoot: root,
        runtime: "claude",
        claudeAuthConfigured: true,
        claudeAuthSource: "process-env",
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
      },
      {} as never,
      undefined,
      undefined,
      undefined,
      { learning: learningCoordinator }
    );
    const supplements = new RuntimeInputQueue();
    supplements.close();
    for await (const _event of runtime.run({
      runId: run.id,
      conversationId: conversation.id,
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      profileId: "local-operator",
      prompt: "我不理解递归",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements,
      abortController: new AbortController()
    })) {
      /* drain */
    }
    const learningServer = parentOptions?.mcpServers?.learning as { tools: ToolDefinition[] };
    expect(learningServer).toBeTruthy();
    const open = learningServer.tools.find((item) => item.name === "open_learning_incident")!;
    await open.handler(
      {
        difficultyType: "conceptual_misconception",
        hypothesis: "没有理解递归出口",
        confidence: 0.8,
        severity: 3,
        evidenceMessageIds: [run.userMessageId]
      },
      {}
    );
    expect(learning.listIncidents(learning.getSessionForConversation(conversation.id)!.id)).toHaveLength(1);

    const sourceIncident = learning.listIncidents(learning.getSessionForConversation(conversation.id)!.id)[0]!;
    const replayConversation = agents.createConversation("web", "学习回放", { profileId: "local-operator" });
    const replayRun = agents.createRun(replayConversation.id, "重新检查", "normal");
    learning.createSession({
      conversationId: replayConversation.id,
      profileId: "local-operator",
      goal: "理解递归",
      datasetKind: "replay"
    });
    const replayQueue = new RuntimeInputQueue();
    replayQueue.close();
    for await (const _event of runtime.run({
      runId: replayRun.id,
      conversationId: replayConversation.id,
      userMessageId: replayRun.userMessageId,
      assistantMessageId: replayRun.assistantMessageId,
      profileId: "local-operator",
      prompt: "重新检查",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements: replayQueue,
      abortController: new AbortController(),
      pinnedOverlay: {
        id: "frozen",
        playbookIds: [],
        artifactIds: [],
        cardTitle: null,
        playbooks: [],
        learning: {
          ...learning.getSessionForConversation(conversation.id)!,
          incidents: [{ ...sourceIncident, interventions: [], verifications: [] }]
        }
      }
    })) {
      /* drain */
    }
    // local-operator runs append onto the claude_code preset, so the injected text is the
    // `append` field rather than the whole option.
    const replayPrompt = String((parentOptions?.systemPrompt as { append?: string } | undefined)?.append ?? "");
    expect(replayPrompt).not.toContain(run.userMessageId);
    expect(replayPrompt).toContain('"evidenceMessageCount":1');

    const inactive = agents.createConversation("web", "普通", { profileId: "local-operator" });
    const inactiveRun = agents.createRun(inactive.id, "普通问题", "normal");
    const inactiveQueue = new RuntimeInputQueue();
    inactiveQueue.close();
    for await (const _event of runtime.run({
      runId: inactiveRun.id,
      conversationId: inactive.id,
      userMessageId: inactiveRun.userMessageId,
      assistantMessageId: inactiveRun.assistantMessageId,
      profileId: "local-operator",
      prompt: "普通问题",
      workspacePath: root,
      attachments: [],
      branch: { sdkSessionId: null, resumeSessionAt: null },
      supplements: inactiveQueue,
      abortController: new AbortController()
    })) {
      /* drain */
    }
    expect(parentOptions?.mcpServers).not.toHaveProperty("learning");
    database.close();
  });
});
