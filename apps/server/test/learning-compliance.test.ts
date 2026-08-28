import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EventStore } from "../src/event-store.js";
import { LearningStore } from "../src/learning-store.js";
import { complianceRepairPrompt, RunOrchestrator } from "../src/orchestrator.js";
import type { AgentRuntime, RuntimeEvent, RuntimeInput } from "../src/runtime.js";
import { AgentStore } from "../src/store.js";

const config = (workspaceRoot: string): AppConfig => ({
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
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for compliance run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function learningFixture(datasetKind: "eval" | "live" = "eval") {
  const database = openDatabase(":memory:");
  const agents = new AgentStore(database);
  const learning = new LearningStore(database);
  const conversation = agents.createConversation("web", "compliance");
  const session = learning.createSession({
    conversationId: conversation.id,
    profileId: "local-operator",
    goal: "understand strings",
    topicKey: "feedback-reliability",
    datasetKind,
    condition: "on-call",
    executionMode: "agent",
    status: "active"
  });
  return { database, agents, learning, conversation, session };
}

describe("eval compliance store", () => {
  it("captures no-incident, diagnosed, and intervening tutor obligations", () => {
    const { database, agents, learning, conversation } = learningFixture();
    expect(learning.evalComplianceObligation(conversation.id)).toMatchObject({
      incidentId: null,
      signature: "none:0:0",
      phase: "none"
    });
    const evidenceRun = agents.createRun(conversation.id, "I am stuck", "normal");
    agents.setRunStatus(evidenceRun.id, "completed");
    const session = learning.getSessionForConversation(conversation.id)!;
    const incident = learning.openIncident({
      sessionId: session.id,
      difficultyType: "feedback_uncertainty",
      hypothesis: "trusts the agreeing grader",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [evidenceRun.userMessageId]
    });
    expect(learning.evalComplianceObligation(conversation.id)).toMatchObject({
      incidentId: incident.id,
      signature: "diagnosed:0:0",
      phase: "diagnosed"
    });
    learning.recordIntervention({
      incidentId: incident.id,
      strategy: "evidence_check",
      rationale: "check claims",
      expectedSignal: "uses evidence"
    });
    expect(learning.evalComplianceObligation(conversation.id)).toMatchObject({
      signature: "intervening:1:0",
      phase: "intervening"
    });
    const item = learning.recordPracticeItem({
      incidentId: incident.id,
      round: 1,
      expectedSessionId: session.id,
      status: "approved",
      taskText: "Explain why upper leaves the original string unchanged.",
      targetHypothesis: "trusts explanation length",
      expectedAnswerSketch: "strings are immutable and upper returns a new string",
      difficulty: 3,
      method: "comparison",
      gate: "none",
      evaluatorVerdict: null,
      noveltyScore: 0
    });
    learning.requestVerification({
      incidentId: incident.id,
      method: "comparison",
      prompt: item.taskText,
      rubric: item.expectedAnswerSketch,
      practiceItemId: item.id
    });
    expect(learning.evalComplianceObligation(conversation.id)).toBeNull();
    const answerRun = agents.createRun(conversation.id, "It stays unchanged", "normal");
    expect(learning.evalComplianceObligation(conversation.id, answerRun.id)).toMatchObject({
      signature: "verifying:1:1",
      phase: "verifying"
    });
    const verifyingRequest = learning.recordComplianceEvent({
      obligation: learning.evalComplianceObligation(conversation.id, answerRun.id)!,
      action: "requested",
      sourceRunId: answerRun.id,
      repairRunId: answerRun.id
    });
    learning.escalateIncident(incident.id, "wrong terminal transition");
    expect(learning.complianceRepairSatisfied(verifyingRequest, answerRun.id)).toBe(false);
    database.close();
  });

  it("keeps nullable-incident actions idempotent and excludes only the repair run from learner answers", () => {
    const { database, agents, learning, conversation, session } = learningFixture();
    const obligation = learning.evalComplianceObligation(conversation.id)!;
    const first = learning.recordComplianceEvent({
      obligation,
      action: "compliance_miss",
      sourceRunId: null
    });
    const duplicate = learning.recordComplianceEvent({
      obligation,
      action: "compliance_miss",
      sourceRunId: null
    });
    expect(duplicate.id).toBe(first.id);
    const requested = learning.recordComplianceEvent({ obligation, action: "requested", sourceRunId: null });
    const repair = agents.createRun(conversation.id, "【学习回路修复】", "normal");
    agents.setRunStatus(repair.id, "completed");
    learning.attachComplianceRepairRun(requested.id, repair.id);
    expect(learning.completedLearnerRunsAfter(conversation.id, 0)).toBe(0);
    const learner = agents.createRun(conversation.id, "my answer", "normal");
    agents.setRunStatus(learner.id, "completed");
    expect(learning.completedLearnerRunsAfter(conversation.id, 0)).toBe(1);
    expect(learning.exportResearch().complianceEvents).toHaveLength(2);
    expect(learning.listComplianceEvents(session.id)[0]).toMatchObject({ incidentId: null });
    database.close();
  });

  it("uses phase-specific, bracket-labelled repair prompts", () => {
    expect(complianceRepairPrompt("none", "message-1")).toContain("open_learning_incident");
    expect(complianceRepairPrompt("none", "message-1")).toContain("message-1");
    expect(complianceRepairPrompt("diagnosed", "message-1")).toContain("record_learning_intervention");
    expect(complianceRepairPrompt("intervening", "message-1")).toContain("request_learning_verification");
    expect(complianceRepairPrompt("verifying", "message-1")).toContain("propose_learning_outcome");
  });
});

class ComplianceRuntime implements AgentRuntime {
  readonly kind = "demo" as const;
  calls = 0;

  constructor(
    private readonly learning: LearningStore,
    private readonly incidentId: string,
    private readonly recover: boolean,
    private readonly failRepair = false
  ) {}

  async *run(input: RuntimeInput): AsyncGenerator<RuntimeEvent> {
    input.supplements.close();
    this.calls += 1;
    if (this.calls === 2 && this.failRepair) throw new Error("repair failed");
    if (this.calls === 2 && this.recover) {
      const session = this.learning.getSessionForIncident(this.incidentId)!;
      const item = this.learning.recordPracticeItem({
        incidentId: this.incidentId,
        round: 1,
        expectedSessionId: session.id,
        status: "approved",
        taskText: "Explain why the string stays unchanged.",
        targetHypothesis: "trusts explanation length",
        expectedAnswerSketch: "strings are immutable and upper returns a new value",
        difficulty: 3,
        method: "comparison",
        gate: "none",
        evaluatorVerdict: null,
        noveltyScore: 0
      });
      this.learning.requestVerification({
        incidentId: this.incidentId,
        method: "comparison",
        prompt: item.taskText,
        rubric: item.expectedAnswerSketch,
        practiceItemId: item.id,
        runId: input.runId,
        messageId: input.assistantMessageId
      });
    }
    yield { type: "text.delta", delta: this.calls === 1 ? "Here is a check in prose." : "Registered." };
    yield { type: "completed" };
  }
}

async function orchestratorFixture(recover: boolean, datasetKind: "eval" | "live" = "eval", failRepair = false) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "learning-compliance-"));
  const fixture = learningFixture(datasetKind);
  const evidenceRun = fixture.agents.createRun(fixture.conversation.id, "I am stuck", "normal");
  fixture.agents.setRunStatus(evidenceRun.id, "completed");
  const incident = fixture.learning.openIncident({
    sessionId: fixture.session.id,
    difficultyType: "feedback_uncertainty",
    hypothesis: "trusts explanation length",
    confidence: 0.8,
    severity: 3,
    evidenceMessageIds: [evidenceRun.userMessageId]
  });
  fixture.learning.recordIntervention({
    incidentId: incident.id,
    strategy: "evidence_check",
    rationale: "check claims",
    expectedSignal: "uses evidence"
  });
  const runtime = new ComplianceRuntime(fixture.learning, incident.id, recover, failRepair);
  const events = new EventStore(fixture.database);
  const orchestrator = new RunOrchestrator(config(workspaceRoot), fixture.agents, events, runtime, undefined, {
    learning: fixture.learning
  });
  const source = orchestrator.submit(fixture.conversation.id, "continue", "normal");
  await waitFor(() => !orchestrator.isConversationBusy(fixture.conversation.id));
  return { ...fixture, workspaceRoot, incident, runtime, source };
}

describe("eval compliance recovery", () => {
  it("queues one repair and records recovered when the repair completes the required transition", async () => {
    const fixture = await orchestratorFixture(true);
    expect(fixture.runtime.calls).toBe(2);
    expect(fixture.learning.listComplianceEvents(fixture.session.id).map((event) => event.action)).toEqual([
      "compliance_miss",
      "requested",
      "recovered"
    ]);
    const messages = fixture.agents.getConversation(fixture.conversation.id)!.messages;
    expect(messages.some((message) => message.role === "user" && message.content.includes("【学习回路修复】"))).toBe(
      true
    );
    expect(fixture.learning.evalComplianceObligation(fixture.conversation.id)).toBeNull();
    fixture.database.close();
    await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  });

  it("records gave_up after exactly one repair that still leaves the tutor owing a move", async () => {
    const fixture = await orchestratorFixture(false);
    expect(fixture.runtime.calls).toBe(2);
    expect(fixture.learning.listComplianceEvents(fixture.session.id).map((event) => event.action)).toEqual([
      "compliance_miss",
      "requested",
      "gave_up"
    ]);
    fixture.database.close();
    await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  });

  it("records gave_up when the repair run fails", async () => {
    const fixture = await orchestratorFixture(false, "eval", true);
    expect(fixture.runtime.calls).toBe(2);
    expect(fixture.learning.listComplianceEvents(fixture.session.id).map((event) => event.action)).toEqual([
      "compliance_miss",
      "requested",
      "gave_up"
    ]);
    expect(
      fixture.agents.database.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'failed'").get()
    ).toMatchObject({ n: 1 });
    fixture.database.close();
    await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  });

  it("closes an attached in-flight repair as gave_up during restart recovery", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "learning-compliance-restart-"));
    const fixture = learningFixture();
    const obligation = fixture.learning.evalComplianceObligation(fixture.conversation.id)!;
    fixture.learning.recordComplianceEvent({ obligation, action: "compliance_miss", sourceRunId: null });
    const requested = fixture.learning.recordComplianceEvent({ obligation, action: "requested", sourceRunId: null });
    const repair = fixture.agents.createRun(fixture.conversation.id, "【学习回路修复】", "normal");
    fixture.agents.setRunStatus(repair.id, "running");
    fixture.learning.attachComplianceRepairRun(requested.id, repair.id);
    const orchestrator = new RunOrchestrator(
      config(workspaceRoot),
      fixture.agents,
      new EventStore(fixture.database),
      new ComplianceRuntime(fixture.learning, "unused", false),
      undefined,
      { learning: fixture.learning }
    );
    expect(fixture.agents.getRun(repair.id)?.status).toBe("interrupted");
    expect(fixture.learning.listComplianceEvents(fixture.session.id).map((event) => event.action)).toEqual([
      "compliance_miss",
      "requested",
      "gave_up"
    ]);
    await orchestrator.stop();
    fixture.database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("closes a superseded queued repair as gave_up before the runtime starts", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "learning-compliance-superseded-"));
    const fixture = learningFixture();
    const obligation = fixture.learning.evalComplianceObligation(fixture.conversation.id)!;
    fixture.learning.recordComplianceEvent({ obligation, action: "compliance_miss", sourceRunId: null });
    const requested = fixture.learning.recordComplianceEvent({ obligation, action: "requested", sourceRunId: null });
    const repair = fixture.agents.createRun(fixture.conversation.id, "【学习回路修复】", "normal");
    fixture.learning.attachComplianceRepairRun(requested.id, repair.id);
    fixture.database.prepare("UPDATE runs SET superseded_at = ? WHERE id = ?").run(Date.now(), repair.id);
    const runtime = new ComplianceRuntime(fixture.learning, "unused", false);
    const orchestrator = new RunOrchestrator(
      config(workspaceRoot),
      fixture.agents,
      new EventStore(fixture.database),
      runtime,
      undefined,
      { learning: fixture.learning }
    );
    await waitFor(() => fixture.agents.getRun(repair.id)?.status === "interrupted");
    expect(runtime.calls).toBe(0);
    expect(fixture.learning.listComplianceEvents(fixture.session.id).map((event) => event.action)).toEqual([
      "compliance_miss",
      "requested",
      "gave_up"
    ]);
    await orchestrator.stop();
    fixture.database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("does not repair live sessions", async () => {
    const fixture = await orchestratorFixture(false, "live");
    expect(fixture.runtime.calls).toBe(1);
    expect(fixture.learning.listComplianceEvents(fixture.session.id)).toEqual([]);
    fixture.database.close();
    await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  });
});
