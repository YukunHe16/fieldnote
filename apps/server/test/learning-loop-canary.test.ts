import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Tool names the mocked agent run should emit, in order. */
let agentToolNames: string[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: unknown) => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => options,
  query: () =>
    (async function* agentQuery() {
      yield {
        type: "assistant",
        message: {
          content: agentToolNames.map((name, index) => ({
            type: "tool_use",
            id: `tool-${index}`,
            name,
            input: {}
          }))
        }
      };
      yield { type: "result", subtype: "success", total_cost_usd: 0.01 };
    })()
}));

const roots: string[] = [];

afterEach(async () => {
  agentToolNames = [];
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function runAgentDemoTurn(toolNames: string[]): Promise<string[]> {
  agentToolNames = toolNames;
  const [runtimeModule, databaseModule, storeModule, learningModule, coordinatorModule, sessionModule] =
    await Promise.all([
      import("../src/runtime.js"),
      import("../src/database.js"),
      import("../src/store.js"),
      import("../src/learning-store.js"),
      import("../src/learning-coordinator.js"),
      import("../src/session-store.js")
    ]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "learning-canary-"));
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
    } as never,
    new sessionModule.SqliteSessionStore(database),
    undefined,
    undefined,
    undefined,
    { learning: new coordinatorModule.LearningCoordinator(learning) }
  );
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
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
    /* drain the mocked run */
  }
  database.close();
  return warnings.filter((line) => line.includes("[learning]"));
}

describe("learning loop canary", () => {
  it("warns when an agent-mode tutor turn calls no learning tool at all", async () => {
    const warnings = await runAgentDemoTurn(["Read"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the learning loop did not run");
  });

  it("names tool search when that is what the tutor reached for instead", async () => {
    const warnings = await runAgentDemoTurn(["ToolSearch", "ToolSearch"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ENABLE_TOOL_SEARCH");
  });

  it("stays quiet when the tutor opens the incident", async () => {
    const warnings = await runAgentDemoTurn(["mcp__learning__open_learning_incident"]);
    expect(warnings).toEqual([]);
  });
});
