import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { LearningStore, type LearningDatasetKind, type LearningInterventionStrategy } from "../src/learning-store.js";
import { AgentStore } from "../src/store.js";
import { CollaborationStore } from "../src/collaboration-store.js";

const evidenceMessages = new Map<string, string>();

function fixture(
  datasetKind: LearningDatasetKind = "live",
  condition: "on-call" | "one-shot" | "multi-turn" = "on-call",
  evalPolicyEvolution = false
) {
  const database = openDatabase(":memory:");
  const agents = new AgentStore(database);
  const conversation = agents.createConversation("web", "学习测试", { profileId: "local-operator" });
  const learning = new LearningStore(database, undefined, evalPolicyEvolution);
  const session = learning.createSession({
    conversationId: conversation.id,
    profileId: "local-operator",
    goal: "理解递归",
    topicKey: "programming",
    datasetKind,
    condition
  });
  const run = agents.createRun(conversation.id, "我不理解这个概念", "normal");
  evidenceMessages.set(session.id, run.userMessageId);
  return { database, agents, conversation, learning, session, run };
}

function incident(learning: LearningStore, sessionId: string) {
  return learning.openIncident({
    sessionId,
    difficultyType: "conceptual_misconception",
    hypothesis: "把递归调用和循环迭代混为一谈",
    confidence: 0.8,
    severity: 3,
    evidenceMessageIds: [evidenceMessages.get(sessionId)!]
  });
}

function complete(
  learning: LearningStore,
  incidentId: string,
  strategy: LearningInterventionStrategy,
  verdict: "resolved" | "partial" | "unresolved" = "resolved",
  linkage?: { runId: string; messageId: string }
) {
  const intervention = learning.recordIntervention({
    incidentId,
    strategy,
    rationale: "根据误区选择",
    expectedSignal: "能解释递归出口",
    ...(linkage ?? {})
  });
  const verification = learning.requestVerification({
    incidentId,
    interventionId: intervention.id,
    method: "self_explanation",
    prompt: "请解释递归出口。",
    rubric: "说明何时停止调用"
  });
  learning.proposeSystemOutcome(verification.id, verdict, 0.75);
  return learning.confirmVerification(verification.id, verdict);
}

describe("LearningStore", () => {
  it("allows only the declared session transitions and one session per conversation", () => {
    const { database, learning, session } = fixture();
    expect(learning.transitionSession(session.id, "paused").status).toBe("paused");
    expect(learning.transitionSession(session.id, "active").status).toBe("active");
    const activeIncident = incident(learning, session.id);
    expect(learning.transitionSession(session.id, "completed").completedAt).not.toBeNull();
    expect(learning.getIncident(activeIncident.id)).toMatchObject({ status: "abandoned" });
    expect(() => learning.transitionSession(session.id, "active")).toThrow("Cannot transition");
    expect(() =>
      learning.createSession({
        conversationId: session.conversationId,
        profileId: "local-operator",
        goal: "另一个目标"
      })
    ).toThrow("already exists");
    database.close();
  });

  it("uses suggested sessions only as an opt-in transition", () => {
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const conversation = agents.createConversation();
    const learning = new LearningStore(database);
    const suggested = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "学会解释",
      status: "suggested",
      suggestionReason: "连续困惑"
    });
    expect(learning.transitionSession(suggested.id, "active").status).toBe("active");
    database.close();
  });

  it("keeps deterministic and real-agent demo execution explicit", () => {
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const learning = new LearningStore(database);
    const liveConversation = agents.createConversation();
    const deterministicConversation = agents.createConversation();
    const agentConversation = agents.createConversation();
    expect(
      learning.createSession({ conversationId: liveConversation.id, profileId: "local-operator", goal: "Live" })
        .executionMode
    ).toBe("agent");
    expect(
      learning.createSession({
        conversationId: deterministicConversation.id,
        profileId: "local-operator",
        goal: "Stable demo",
        datasetKind: "demo"
      }).executionMode
    ).toBe("deterministic");
    expect(
      learning.createSession({
        conversationId: agentConversation.id,
        profileId: "local-operator",
        goal: "Agent demo",
        datasetKind: "demo",
        executionMode: "agent"
      }).executionMode
    ).toBe("agent");
    const invalidConversation = agents.createConversation();
    expect(() =>
      learning.createSession({
        conversationId: invalidConversation.id,
        profileId: "local-operator",
        goal: "Invalid",
        executionMode: "deterministic"
      })
    ).toThrow("only for demo");
    database.close();
  });

  it("migrates existing demo sessions to deterministic execution", () => {
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const conversation = agents.createConversation();
    database.exec(`
      CREATE TABLE learning_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        topic_key TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        dataset_kind TEXT NOT NULL,
        suggestion_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `);
    database
      .prepare(
        `INSERT INTO learning_sessions
       (id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, created_at, updated_at)
       VALUES ('legacy-demo', ?, 'local-operator', 'Legacy demo', 'topic', 'active', 'demo', 1, 1)`
      )
      .run(conversation.id);
    const learning = new LearningStore(database);
    expect(learning.getSession("legacy-demo")?.executionMode).toBe("deterministic");
    database.close();
  });

  it("permits one non-terminal incident and escalates the third unresolved intervention", () => {
    const { database, learning, session } = fixture();
    const current = incident(learning, session.id);
    expect(() => incident(learning, session.id)).toThrow("Only one active");
    for (const strategy of ["socratic_question", "conceptual_hint", "worked_example"] as const) {
      complete(learning, current.id, strategy, "unresolved");
      if (strategy !== "worked_example") expect(learning.getIncident(current.id)?.status).toBe("diagnosed");
    }
    expect(learning.getIncident(current.id)?.status).toBe("escalated");
    expect(learning.listInterventions(current.id)).toHaveLength(3);
    expect(() =>
      learning.recordIntervention({
        incidentId: current.id,
        strategy: "direct_explanation",
        rationale: "too late",
        expectedSignal: "none"
      })
    ).toThrow("not allowed");
    database.close();
  });

  it("keeps the proposed system outcome and the user-confirmed final outcome", () => {
    const { database, learning, session } = fixture();
    const current = incident(learning, session.id);
    const intervention = learning.recordIntervention({
      incidentId: current.id,
      strategy: "contrastive_example",
      rationale: "show contrast",
      expectedSignal: "distinguishes cases"
    });
    const verification = learning.requestVerification({
      incidentId: current.id,
      interventionId: intervention.id,
      method: "comparison",
      prompt: "比较两个例子",
      rubric: "指出区别"
    });
    expect(() => learning.confirmVerification(verification.id, "partial")).toThrow("before a system outcome");
    learning.proposeSystemOutcome(verification.id, "resolved", 0.9);
    const confirmed = learning.confirmVerification(verification.id, "partial");
    expect(confirmed.systemVerdict).toBe("resolved");
    expect(confirmed.userVerdict).toBe("partial");
    expect(confirmed.finalVerdict).toBe("partial");
    expect(learning.getIncident(current.id)?.status).toBe("diagnosed");
    expect(() => learning.confirmVerification(verification.id, "resolved")).toThrow("cannot be confirmed");
    database.close();
  });

  it("rejects runtime learning mutations while paused but permits a user confirmation", () => {
    const interventionFixture = fixture();
    const interventionIncident = incident(interventionFixture.learning, interventionFixture.session.id);
    interventionFixture.learning.transitionSession(interventionFixture.session.id, "paused");
    expect(() =>
      interventionFixture.learning.recordIntervention({
        incidentId: interventionIncident.id,
        strategy: "worked_example",
        rationale: "解释基准情形",
        expectedSignal: "能指出终止条件"
      })
    ).toThrow("active session");
    interventionFixture.database.close();

    const verificationFixture = fixture();
    const verificationIncident = incident(verificationFixture.learning, verificationFixture.session.id);
    const verificationIntervention = verificationFixture.learning.recordIntervention({
      incidentId: verificationIncident.id,
      strategy: "worked_example",
      rationale: "解释基准情形",
      expectedSignal: "能指出终止条件"
    });
    verificationFixture.learning.transitionSession(verificationFixture.session.id, "paused");
    expect(() =>
      verificationFixture.learning.requestVerification({
        incidentId: verificationIncident.id,
        interventionId: verificationIntervention.id,
        method: "self_explanation",
        prompt: "解释终止条件",
        rubric: "指出 base case"
      })
    ).toThrow("active session");
    verificationFixture.database.close();

    const outcomeFixture = fixture();
    const outcomeIncident = incident(outcomeFixture.learning, outcomeFixture.session.id);
    const outcomeIntervention = outcomeFixture.learning.recordIntervention({
      incidentId: outcomeIncident.id,
      strategy: "worked_example",
      rationale: "解释基准情形",
      expectedSignal: "能指出终止条件"
    });
    const outcomeVerification = outcomeFixture.learning.requestVerification({
      incidentId: outcomeIncident.id,
      interventionId: outcomeIntervention.id,
      method: "self_explanation",
      prompt: "解释终止条件",
      rubric: "指出 base case"
    });
    outcomeFixture.learning.transitionSession(outcomeFixture.session.id, "paused");
    expect(() => outcomeFixture.learning.proposeSystemOutcome(outcomeVerification.id, "resolved", 0.9)).toThrow(
      "active session"
    );
    outcomeFixture.database.close();

    const escalationFixture = fixture();
    const escalationIncident = incident(escalationFixture.learning, escalationFixture.session.id);
    escalationFixture.learning.transitionSession(escalationFixture.session.id, "paused");
    expect(() => escalationFixture.learning.escalateIncident(escalationIncident.id, "需要人工协助")).toThrow(
      "active session"
    );
    escalationFixture.database.close();

    const confirmationFixture = fixture();
    const confirmationIncident = incident(confirmationFixture.learning, confirmationFixture.session.id);
    const confirmationIntervention = confirmationFixture.learning.recordIntervention({
      incidentId: confirmationIncident.id,
      strategy: "worked_example",
      rationale: "解释基准情形",
      expectedSignal: "能指出终止条件"
    });
    const confirmationVerification = confirmationFixture.learning.requestVerification({
      incidentId: confirmationIncident.id,
      interventionId: confirmationIntervention.id,
      method: "self_explanation",
      prompt: "解释终止条件",
      rubric: "指出 base case"
    });
    confirmationFixture.learning.proposeSystemOutcome(confirmationVerification.id, "resolved", 0.9);
    confirmationFixture.learning.transitionSession(confirmationFixture.session.id, "paused");
    expect(confirmationFixture.learning.confirmVerification(confirmationVerification.id, "resolved").finalVerdict).toBe(
      "resolved"
    );
    confirmationFixture.database.close();
  });

  it("requires a later learner turn for runtime-linked outcomes and binds confirmation to that reply", () => {
    const { database, agents, learning, session, run, conversation } = fixture();
    const current = learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "没有理解递归出口",
      confidence: 0.84,
      severity: 3,
      evidenceMessageIds: [run.userMessageId],
      runId: run.id
    });
    const intervention = learning.recordIntervention({
      incidentId: current.id,
      strategy: "contrastive_example",
      rationale: "对比有出口和无出口的调用",
      expectedSignal: "能预测终止条件",
      runId: run.id,
      messageId: run.assistantMessageId
    });
    const prematureRun = agents.createRun(conversation.id, "这条消息在验证问题提出前已经排队。", "queue");
    const verification = learning.requestVerification({
      incidentId: current.id,
      interventionId: intervention.id,
      method: "prediction",
      prompt: "预测这个新例子何时停止。",
      rubric: "指出 base case",
      runId: run.id,
      messageId: run.assistantMessageId
    });
    expect(() =>
      learning.proposeSystemOutcome(verification.id, "resolved", 0.8, {
        runId: run.id,
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId
      })
    ).toThrow("later learner turn");
    expect(() =>
      learning.proposeSystemOutcome(verification.id, "resolved", 0.8, {
        runId: prematureRun.id,
        userMessageId: prematureRun.userMessageId,
        assistantMessageId: prematureRun.assistantMessageId
      })
    ).toThrow("created after the verification prompt");

    const nextRun = agents.createRun(conversation.id, "这个新例子会在 n 等于 0 时停止。", "normal");
    expect(
      learning.proposeSystemOutcome(verification.id, "resolved", 0.9, {
        runId: nextRun.id,
        userMessageId: nextRun.userMessageId,
        assistantMessageId: nextRun.assistantMessageId
      })
    ).toMatchObject({
      requestedRunId: run.id,
      requestedMessageId: run.assistantMessageId,
      proposedRunId: nextRun.id,
      proposedMessageId: nextRun.assistantMessageId
    });
    database.close();
  });

  it("writes confirmed experiences only to their live or demo dataset, never replay", () => {
    const live = fixture("live");
    const resolvedIncident = incident(live.learning, live.session.id);
    complete(live.learning, resolvedIncident.id, "worked_example");
    expect(live.learning.getIncident(resolvedIncident.id)?.closedSnapshot).toMatchObject({
      difficultyType: "conceptual_misconception",
      interventions: [expect.objectContaining({ strategy: "worked_example" })],
      verification: expect.objectContaining({ finalVerdict: "resolved" })
    });
    expect(
      live.learning.listExperiences({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "live"
      })
    ).toHaveLength(1);
    expect(
      live.learning.listExperiences({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "demo"
      })
    ).toHaveLength(0);
    live.database.close();

    const replay = fixture("replay");
    complete(replay.learning, incident(replay.learning, replay.session.id).id, "worked_example");
    expect(() =>
      replay.learning.listExperiences({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "replay" as never
      })
    ).not.toThrow();
    expect(
      replay.learning.selectStrategy({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "replay"
      }).historyCount
    ).toBe(0);
    replay.database.close();
  });

  it("uses the beta posterior after three confirmations and demotes failed strategies for an incident", () => {
    const { database, learning, session } = fixture();
    for (let index = 0; index < 3; index += 1) complete(learning, incident(learning, session.id).id, "worked_example");
    const selected = learning.selectStrategy({
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception",
      datasetKind: "live",
      failedStrategies: ["worked_example"]
    });
    expect(selected.reason).toBe("evidence");
    expect(selected.scores.worked_example).toBeGreaterThan(selected.scores.socratic_question);
    expect(selected.strategy).not.toBe("worked_example");
    database.close();
  });

  it("generates, reviews, and rolls back a pending policy revision", () => {
    const { database, learning, session } = fixture();
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO learning_policy_revisions (id, profile_id, topic_key, difficulty_type, dataset_kind, ordered_strategies_json, evidence_experience_ids_json, status, evaluation_summary, created_at, updated_at)
       VALUES ('baseline', 'local-operator', 'programming', 'conceptual_misconception', 'live', ?, '[]', 'enabled', 'baseline', ?, ?)`
      )
      .run(
        JSON.stringify([
          "socratic_question",
          "worked_example",
          "conceptual_hint",
          "contrastive_example",
          "analogical_example",
          "direct_explanation",
          "evidence_check",
          "abstain_escalate"
        ]),
        now,
        now
      );
    for (let index = 0; index < 5; index += 1) complete(learning, incident(learning, session.id).id, "worked_example");
    const pending = learning.maybeCreatePendingPolicyRevision({
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception",
      datasetKind: "live"
    });
    expect(pending?.status).toBe("pending");
    expect(pending?.orderedStrategies[0]).toBe("worked_example");
    expect(pending?.previousRevisionId).toBe("baseline");
    expect(pending?.preview).toMatchObject({
      currentFirstStrategy: "socratic_question",
      candidateFirstStrategy: "worked_example",
      snapshotCount: 5
    });
    const enabled = learning.reviewPolicyRevision(pending!.id, "enabled");
    expect(enabled.status).toBe("enabled");
    expect(
      learning.selectStrategy({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "demo"
      }).policyRevisionId
    ).toBeNull();
    expect(learning.rollbackPolicyRevision(enabled.id).id).toBe("baseline");
    expect(
      learning
        .listPolicies({
          profileId: "local-operator",
          topicKey: "programming",
          difficultyType: "conceptual_misconception",
          datasetKind: "live",
          includeDisabled: true
        })
        .find((policy) => policy.id === enabled.id)?.status
    ).toBe("disabled");
    database.close();
  });

  it("does not re-propose a rejected policy for the same evidence snapshot", () => {
    const { database, learning, session } = fixture();
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO learning_policy_revisions (id, profile_id, topic_key, difficulty_type, dataset_kind, ordered_strategies_json, evidence_experience_ids_json, status, evaluation_summary, created_at, updated_at)
       VALUES ('baseline', 'local-operator', 'programming', 'conceptual_misconception', 'live', ?, '[]', 'enabled', 'baseline', ?, ?)`
      )
      .run(
        JSON.stringify([
          "socratic_question",
          "worked_example",
          "conceptual_hint",
          "contrastive_example",
          "analogical_example",
          "direct_explanation",
          "evidence_check",
          "abstain_escalate"
        ]),
        now,
        now
      );
    for (let index = 0; index < 5; index += 1) complete(learning, incident(learning, session.id).id, "worked_example");
    const scope = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception" as const,
      datasetKind: "live" as const
    };
    const pending = learning.maybeCreatePendingPolicyRevision(scope);
    expect(pending?.status).toBe("pending");
    expect(pending?.orderedStrategies[0]).toBe("worked_example");
    learning.reviewPolicyRevision(pending!.id, "rejected");
    expect(learning.maybeCreatePendingPolicyRevision(scope)).toBeNull();

    complete(learning, incident(learning, session.id).id, "worked_example");
    const withNewEvidence = learning.maybeCreatePendingPolicyRevision(scope);
    expect(withNewEvidence?.status).toBe("pending");
    expect(withNewEvidence?.orderedStrategies[0]).toBe("worked_example");
    expect(withNewEvidence?.evidenceExperienceIds).toEqual(expect.arrayContaining(pending!.evidenceExperienceIds));
    database.close();
  });

  it("supersedes edited-branch incidents and removes their outcomes from strategy statistics", () => {
    const { database, agents, learning, session, run } = fixture();
    for (let index = 0; index < 5; index += 1) {
      complete(learning, incident(learning, session.id).id, "worked_example", "resolved", {
        runId: run.id,
        messageId: run.assistantMessageId
      });
    }
    const pending = learning.maybeCreatePendingPolicyRevision({
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception",
      datasetKind: "live"
    });
    expect(pending?.status).toBe("pending");

    agents.createBranchFromMessage(run.userMessageId, { asNewConversation: false, includeTarget: true });
    expect(
      (database.prepare("SELECT superseded_at FROM runs WHERE id = ?").get(run.id) as { superseded_at: number | null })
        .superseded_at
    ).not.toBeNull();
    expect(learning.listIncidents(session.id)).toEqual([]);
    expect(learning.listIncidents(session.id, true)).toHaveLength(5);
    expect(
      learning.listIncidents(session.id, true).every((item) => item.supersededAt && item.status === "abandoned")
    ).toBe(true);
    expect(
      learning.listExperiences({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "live"
      })
    ).toEqual([]);
    expect(
      learning.selectStrategy({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "live"
      }).historyCount
    ).toBe(0);
    expect(learning.getPolicyRevision(pending!.id)?.status).toBe("rejected");
    database.close();
  });

  it("keeps the learning incident active when a same-run specialist task is interrupted", () => {
    const { database, learning, session, run } = fixture();
    const current = learning.openIncident({
      sessionId: session.id,
      difficultyType: "feedback_uncertainty",
      hypothesis: "不确定该信任哪条反馈",
      confidence: 0.8,
      severity: 2,
      evidenceMessageIds: [run.userMessageId],
      runId: run.id
    });
    const collaboration = new CollaborationStore(database);
    const task = collaboration.markRunning(
      collaboration.createTask({
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
        specialistId: "source-verifier",
        displayName: "资料核验员",
        requestSummary: "核验冲突反馈"
      }).id
    );

    collaboration.interruptRun(run.id, "User stopped the run");
    expect(collaboration.getTask(task.id)?.status).toBe("interrupted");
    expect(learning.getIncident(current.id)?.status).toBe("diagnosed");
    database.close();
  });

  it("cascades every learning record when its conversation is deleted", () => {
    const { database, agents, learning, conversation, session } = fixture();
    complete(learning, incident(learning, session.id).id, "worked_example");
    expect(agents.deleteConversation(conversation.id)).toBe(true);
    for (const table of [
      "learning_sessions",
      "learning_incidents",
      "learning_interventions",
      "learning_verifications",
      "learning_experiences"
    ] as const) {
      expect((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    database.close();
  });

  it("seeds clearly isolated synthetic demo history and can propose a demo-only policy", () => {
    const { database, learning, session } = fixture("demo");
    expect(
      learning.seedDemoExperiences(session.id, "planning_gap", [
        { strategy: "contrastive_example", outcome: "resolved", count: 5 },
        { strategy: "socratic_question", outcome: "unresolved", count: 1 }
      ])
    ).toBe(6);
    expect(learning.listIncidents(session.id)).toHaveLength(6);
    const pending = learning.maybeCreatePendingPolicyRevision({
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "planning_gap",
      datasetKind: "demo"
    });
    expect(pending).toMatchObject({ status: "pending", datasetKind: "demo" });
    expect(pending?.orderedStrategies[0]).toBe("contrastive_example");
    expect(pending?.preview).toMatchObject({ snapshotCount: 6, candidateFirstStrategy: "contrastive_example" });
    expect(pending?.previousRevisionId).not.toBeNull();
    expect(
      learning.listPolicies({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "planning_gap",
        datasetKind: "demo"
      })[0]?.id
    ).toBe(pending?.id);
    const enabled = learning.reviewPolicyRevision(pending!.id, "enabled");
    expect(learning.rollbackPolicyRevision(enabled.id).id).toBe(pending!.previousRevisionId);
    expect(
      learning.listExperiences({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "planning_gap",
        datasetKind: "live"
      })
    ).toEqual([]);
    database.close();
  });

  it("redirects wrong-state tool calls instead of dead-ending them", () => {
    const { database, learning, session } = fixture();
    const first = incident(learning, session.id);
    // diagnosed: verification before any intervention → point at the missing step.
    expect(() =>
      learning.requestVerification({
        incidentId: first.id,
        method: "self_explanation",
        prompt: "解释一下",
        rubric: "关键点"
      })
    ).toThrow("record_learning_intervention");
    learning.recordIntervention({
      incidentId: first.id,
      strategy: "socratic_question",
      rationale: "先问",
      expectedSignal: "能自述"
    });
    learning.requestVerification({
      incidentId: first.id,
      method: "self_explanation",
      prompt: "解释一下",
      rubric: "关键点"
    });
    // verifying: another intervention → point at propose + confirmation.
    expect(() =>
      learning.recordIntervention({
        incidentId: first.id,
        strategy: "worked_example",
        rationale: "再讲",
        expectedSignal: "换信号"
      })
    ).toThrow("propose_learning_outcome");
    database.close();
  });

  it("limits one-shot sessions to a single intervention and closes without escalation", () => {
    const { database, learning, session } = fixture("live", "one-shot");
    expect(session.condition).toBe("one-shot");
    const first = incident(learning, session.id);
    learning.recordIntervention({
      incidentId: first.id,
      strategy: "direct_explanation",
      rationale: "基线只讲一次",
      expectedSignal: "能复述关键点"
    });
    expect(() =>
      learning.recordIntervention({
        incidentId: first.id,
        strategy: "worked_example",
        rationale: "第二轮",
        expectedSignal: "换个信号"
      })
    ).toThrow("single intervention");
    const verification = learning.requestVerification({
      incidentId: first.id,
      method: "self_explanation",
      prompt: "请解释递归出口。",
      rubric: "说明何时停止调用"
    });
    learning.proposeSystemOutcome(verification.id, "unresolved", 0.7);
    learning.confirmVerification(verification.id, "unresolved");
    // On-call would go back to "diagnosed" for another strategy; the baseline is final.
    expect(learning.getIncident(first.id)).toMatchObject({ status: "unresolved" });
    expect(learning.getIncident(first.id)?.closedAt).not.toBeNull();
    // One-shot outcomes never feed strategy evolution.
    expect(
      learning.listExperiences({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "live"
      })
    ).toEqual([]);
    database.close();
  });

  it("gives multi-turn the same rounds as on-call but none of the policy or the handoff", () => {
    const { database, learning, session } = fixture("live", "multi-turn");
    expect(session.condition).toBe("multi-turn");
    const first = incident(learning, session.id);
    // Unlike one-shot, a second and third round are allowed — the baseline differs from
    // on-call in its policy, not in how many chances it gets.
    for (const [index, strategy] of (
      ["direct_explanation", "direct_explanation", "worked_example"] as const
    ).entries()) {
      learning.recordIntervention({
        incidentId: first.id,
        strategy,
        rationale: `第 ${index + 1} 轮`,
        expectedSignal: "学习者能应用"
      });
      const verification = learning.requestVerification({
        incidentId: first.id,
        method: "self_explanation",
        prompt: "请解释递归出口。",
        rubric: "说明何时停止调用"
      });
      learning.proposeSystemOutcome(verification.id, "unresolved", 0.7);
      learning.confirmVerification(verification.id, "unresolved");
    }
    // Repeating a strategy is allowed here; nothing forces the switch that on-call requires.
    expect(learning.listInterventions(first.id).map((entry) => entry.strategy)).toEqual([
      "direct_explanation",
      "direct_explanation",
      "worked_example"
    ]);
    // Three unresolved rounds would escalate under on-call. The baseline has no handoff.
    expect(learning.getIncident(first.id)).toMatchObject({ status: "unresolved" });
    const second = incident(learning, session.id);
    expect(() => learning.escalateIncident(second.id, "试试交接")).toThrow("on-call");
    database.close();
  });

  it("migrates an existing experiences table whose CHECK predates the eval dataset", () => {
    // The in-memory fixtures are built from the current schema, so the migration never runs
    // there. Only a database created before the eval dataset existed exercises it — and the
    // rename it performs has to survive a trigger that reads the table being replaced.
    const database = openDatabase(":memory:");
    new LearningStore(database);
    const legacyCheck = "CHECK (dataset_kind IN ('live', 'demo'))";
    database.pragma("legacy_alter_table = ON");
    database.exec(`
      DROP TABLE learning_experiences;
      CREATE TABLE learning_experiences (
        id TEXT PRIMARY KEY,
        verification_id TEXT NOT NULL UNIQUE,
        incident_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        topic_key TEXT NOT NULL DEFAULT '',
        difficulty_type TEXT NOT NULL,
        strategy TEXT NOT NULL,
        outcome TEXT NOT NULL,
        dataset_kind TEXT NOT NULL ${legacyCheck},
        snapshot_json TEXT NOT NULL DEFAULT '{}',
        strategy_variant_id TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO learning_experiences
        (id, verification_id, incident_id, profile_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, created_at)
      VALUES ('legacy-1', 'v-1', 'i-1', 'local-operator', 'programming', 'planning_gap', 'worked_example', 'resolved', 'live', 1);
    `);
    database.pragma("legacy_alter_table = OFF");
    expect(
      (database.prepare("SELECT sql FROM sqlite_master WHERE name = 'learning_experiences'").get() as { sql: string })
        .sql
    ).toContain(legacyCheck);

    // Reopening the store must widen the CHECK without losing the row or breaking the trigger.
    new LearningStore(database);
    const migrated = (
      database.prepare("SELECT sql FROM sqlite_master WHERE name = 'learning_experiences'").get() as { sql: string }
    ).sql;
    expect(migrated).toContain("'eval'");
    expect(database.prepare("SELECT COUNT(*) AS count FROM learning_experiences").get()).toMatchObject({ count: 1 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'learning_supersede_run'").get()).toBeTruthy();
    database.close();
  });

  it("lets an opted-in eval accumulate its own strategy evidence without touching live", () => {
    const { database, learning, session } = fixture("eval", "on-call", true);
    const strategies: LearningInterventionStrategy[] = ["socratic_question", "socratic_question", "socratic_question"];
    for (const strategy of strategies) {
      const current = incident(learning, session.id);
      learning.recordIntervention({
        incidentId: current.id,
        strategy,
        rationale: "重复同一策略并让它失败",
        expectedSignal: "学习者能应用"
      });
      const verification = learning.requestVerification({
        incidentId: current.id,
        method: "self_explanation",
        prompt: "请解释递归出口。",
        rubric: "说明何时停止调用"
      });
      learning.proposeSystemOutcome(verification.id, "unresolved", 0.7);
      learning.confirmVerification(verification.id, "unresolved");
      // Close it so the next repetition can open its own incident, the way a fresh eval
      // conversation would.
      learning.escalateIncident(current.id, "本轮结束");
    }
    // Evidence accrued, and it is filed under the eval dataset — live sees nothing.
    const scope = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception"
    } as const;
    expect(learning.listExperiences({ ...scope, datasetKind: "eval" })).toHaveLength(3);
    expect(learning.listExperiences({ ...scope, datasetKind: "live" })).toEqual([]);
    // With three failures on record the posterior demotes that strategy instead of keeping
    // the fixed default order an order-independent eval would have used.
    const selection = learning.selectStrategy({ ...scope, datasetKind: "eval" });
    expect(selection.reason).toBe("evidence");
    expect(selection.strategy).not.toBe("socratic_question");
    database.close();
  });

  it("keeps eval runs order-independent: default strategy order, no experiences, no policies", () => {
    const { database, learning, session } = fixture("eval");
    expect(session.datasetKind).toBe("eval");
    const first = incident(learning, session.id);
    complete(learning, first.id, "socratic_question", "resolved");
    const selection = learning.selectStrategy({
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception",
      datasetKind: "eval"
    });
    expect(selection).toMatchObject({ reason: "default", historyCount: 0 });
    expect(
      learning.maybeCreatePendingPolicyRevision({
        profileId: "local-operator",
        topicKey: "programming",
        difficultyType: "conceptual_misconception",
        datasetKind: "eval"
      })
    ).toBeNull();
    expect(learning.exportResearch().experiences).toEqual([]);
    database.close();
  });

  it("rebuilds pre-research learning_sessions rows with the on-call default", () => {
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const conversation = agents.createConversation("web", "旧库", { profileId: "local-operator" });
    database.exec(`
      CREATE TABLE learning_sessions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        topic_key TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('suggested', 'active', 'paused', 'completed', 'dismissed')),
        dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('live', 'demo', 'replay')),
        execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK (execution_mode IN ('agent', 'deterministic')),
        suggestion_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
    `);
    database
      .prepare(
        `INSERT INTO learning_sessions (id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, execution_mode, created_at, updated_at)
       VALUES ('legacy-session', ?, 'local-operator', '旧目标', 'programming', 'active', 'live', 'agent', 1, 1)`
      )
      .run(conversation.id);
    const learning = new LearningStore(database);
    expect(learning.getSession("legacy-session")).toMatchObject({
      goal: "旧目标",
      datasetKind: "live",
      condition: "on-call"
    });
    // The rebuilt table accepts the new dataset kind and condition.
    const evalConversation = agents.createConversation("web", "评测", { profileId: "local-operator" });
    expect(
      learning.createSession({
        conversationId: evalConversation.id,
        profileId: "local-operator",
        goal: "评测运行",
        datasetKind: "eval",
        condition: "one-shot"
      })
    ).toMatchObject({ datasetKind: "eval", condition: "one-shot" });
    database.close();
  });

  it("aggregates metrics per condition with calibration bins", () => {
    const { database, agents, learning, session } = fixture();
    // On-call: one incident resolved in a single round, one resolved on the second round.
    const first = incident(learning, session.id);
    complete(learning, first.id, "socratic_question", "resolved");
    const second = incident(learning, session.id);
    complete(learning, second.id, "conceptual_hint", "unresolved");
    complete(learning, second.id, "worked_example", "resolved");
    // Miscalibrated verification: confident "resolved" verdict, learner says "partial".
    const third = incident(learning, session.id);
    const intervention = learning.recordIntervention({
      incidentId: third.id,
      strategy: "direct_explanation",
      rationale: "直接讲",
      expectedSignal: "能迁移"
    });
    const verification = learning.requestVerification({
      incidentId: third.id,
      interventionId: intervention.id,
      method: "transfer_example",
      prompt: "换一个输入再做一次。",
      rubric: "结果正确"
    });
    learning.proposeSystemOutcome(verification.id, "resolved", 0.95);
    learning.confirmVerification(verification.id, "partial");
    // Partial keeps the incident open in on-call; close it by ending the session so it
    // does not enter the closed-incident universe.
    learning.transitionSession(session.id, "completed");

    // One-shot baseline in a second conversation, same profile/topic/dataset.
    const baselineConversation = agents.createConversation("web", "基线", { profileId: "local-operator" });
    const baseline = learning.createSession({
      conversationId: baselineConversation.id,
      profileId: "local-operator",
      goal: "基线对照",
      topicKey: "programming",
      condition: "one-shot"
    });
    const run = agents.createRun(baselineConversation.id, "还是不懂", "normal");
    const baselineIncident = learning.openIncident({
      sessionId: baseline.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "同一误区",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [run.userMessageId]
    });
    const baselineIntervention = learning.recordIntervention({
      incidentId: baselineIncident.id,
      strategy: "direct_explanation",
      rationale: "一次讲清",
      expectedSignal: "能复述"
    });
    const baselineVerification = learning.requestVerification({
      incidentId: baselineIncident.id,
      interventionId: baselineIntervention.id,
      method: "self_explanation",
      prompt: "解释一下",
      rubric: "关键点齐全"
    });
    learning.proposeSystemOutcome(baselineVerification.id, "unresolved", 0.75);
    learning.confirmVerification(baselineVerification.id, "unresolved");

    const metrics = learning.metricsSummary({ profileId: "local-operator", topicKey: "programming" });
    expect(metrics.overall).toMatchObject({
      incidents: 3,
      outcomes: { resolved: 2, partial: 0, unresolved: 1 },
      escalated: 0
    });
    const onCall = metrics.conditions.find((cell) => cell.condition === "on-call");
    expect(onCall).toMatchObject({ incidents: 2, outcomes: { resolved: 2, partial: 0, unresolved: 0 } });
    expect(onCall?.meanInterventionRounds).toBe(1.5);
    expect(onCall?.firstRoundResolutionRate).toBe(0.5);
    expect(onCall?.resolutionWithoutEscalationRate).toBe(1);
    const oneShot = metrics.conditions.find((cell) => cell.condition === "one-shot");
    expect(oneShot).toMatchObject({ incidents: 1, outcomes: { resolved: 0, partial: 0, unresolved: 1 } });
    expect(oneShot?.resolutionWithoutEscalationRate).toBe(0);
    // 0.95-confidence disagreement lands in the top bin; the 0.7–0.8 bin agrees throughout.
    const topBin = metrics.calibration.find((bin) => bin.lower === 0.9);
    expect(topBin).toMatchObject({ count: 1, agreementRate: 0 });
    const midBin = metrics.calibration.find((bin) => bin.lower === 0.7);
    expect(midBin?.count).toBe(4);
    expect(midBin?.agreementRate).toBe(1);
    expect(metrics.overall.strategyOutcomes.find((row) => row.strategy === "worked_example")).toMatchObject({
      resolved: 1
    });
    const exported = learning.exportResearch();
    expect(exported.sessions).toHaveLength(2);
    expect(exported.incidents).toHaveLength(4);
    expect(exported.verifications).toHaveLength(5);
    database.close();
  });

  it("writes the same rich snapshot on both escalation paths and renders a handoff report", () => {
    const auto = fixture();
    const autoIncident = incident(auto.learning, auto.session.id);
    for (const strategy of ["socratic_question", "conceptual_hint", "worked_example"] as const) {
      complete(auto.learning, autoIncident.id, strategy, "unresolved");
    }
    expect(auto.learning.getIncident(autoIncident.id)?.status).toBe("escalated");
    const autoReport = auto.learning.handoffReport(autoIncident.id);
    expect(autoReport).not.toBeNull();
    expect(autoReport!.attempts.map((attempt) => attempt.strategy)).toEqual([
      "socratic_question",
      "conceptual_hint",
      "worked_example"
    ]);
    expect(autoReport!.attempts.every((attempt) => attempt.outcome === "unresolved")).toBe(true);
    expect(autoReport!.stillOpen).toContain("说明何时停止调用");
    expect(autoReport!.suggestedNextStrategies).not.toContain("abstain_escalate");
    expect(autoReport!.suggestedNextStrategies).not.toContain("socratic_question");
    expect(autoReport!.suggestedNextStrategies.length).toBeGreaterThan(0);
    auto.database.close();

    const manual = fixture();
    const manualIncident = incident(manual.learning, manual.session.id);
    manual.learning.recordIntervention({
      incidentId: manualIncident.id,
      strategy: "evidence_check",
      rationale: "先核对证据",
      expectedSignal: "能指出哪份反馈可信"
    });
    manual.learning.escalateIncident(manualIncident.id, "学习者反复回到旧模型，超出当前能力");
    const escalated = manual.learning.getIncident(manualIncident.id)!;
    expect(escalated.status).toBe("escalated");
    // The tool path now closes with the rich snapshot too, not just {reason, closedAt}.
    expect(escalated.closedSnapshot).toMatchObject({
      hypothesis: "把递归调用和循环迭代混为一谈",
      reason: "学习者反复回到旧模型，超出当前能力",
      interventions: [expect.objectContaining({ strategy: "evidence_check" })]
    });
    const manualReport = manual.learning.handoffReport(manualIncident.id);
    expect(manualReport).toMatchObject({
      escalationReason: "学习者反复回到旧模型，超出当前能力",
      attempts: [expect.objectContaining({ strategy: "evidence_check", outcome: null })]
    });
    expect(manual.learning.exportResearch().handoffs).toHaveLength(1);
    // Non-escalated incidents have no handoff.
    const open = fixture();
    const openIncident = incident(open.learning, open.session.id);
    expect(open.learning.handoffReport(openIncident.id)).toBeNull();
    open.database.close();
    manual.database.close();

    // interventionId omitted on every verification request (the MCP arg is optional and
    // models routinely skip it): the write-time backfill keeps every attempt linked to its
    // outcome instead of the handoff rendering three rounds of 未验证.
    const omitted = fixture();
    const omittedIncident = incident(omitted.learning, omitted.session.id);
    for (const strategy of ["socratic_question", "conceptual_hint", "worked_example"] as const) {
      omitted.learning.recordIntervention({
        incidentId: omittedIncident.id,
        strategy,
        rationale: "按误区选择",
        expectedSignal: "能解释递归出口"
      });
      const verification = omitted.learning.requestVerification({
        incidentId: omittedIncident.id,
        method: "self_explanation",
        prompt: "请解释递归出口。",
        rubric: "说明何时停止调用"
      });
      omitted.learning.proposeSystemOutcome(verification.id, "unresolved", 0.7);
      omitted.learning.confirmVerification(verification.id, "unresolved");
    }
    const omittedReport = omitted.learning.handoffReport(omittedIncident.id)!;
    expect(omittedReport.attempts.map((attempt) => attempt.outcome)).toEqual([
      "unresolved",
      "unresolved",
      "unresolved"
    ]);
    omitted.database.close();
  });

  it("invents variants with dedupe, a single pending per scope, and rejection memory", () => {
    const { database, learning } = fixture();
    const base = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception" as const,
      baseStrategy: "socratic_question" as const
    };
    const created = learning.createVariant({
      ...base,
      title: "栈帧追踪法",
      instruction: "让学生画出每次调用的独立栈帧再比较循环变量"
    });
    expect(created).toMatchObject({ status: "pending", origin: "distilled" });
    // Similar wording (any status) blocks re-proposal.
    expect(
      learning.createVariant({
        ...base,
        title: "栈帧追踪法",
        instruction: "让学生画出每次调用的独立栈帧再比较循环变量。"
      })
    ).toBeNull();
    // A scope+base pair holds one pending candidate at a time.
    expect(
      learning.createVariant({ ...base, title: "另一种问法", instruction: "从最小输入开始问学生每一步谁在调用谁" })
    ).toBeNull();
    learning.reviewVariant(created!.id, "reject");
    // Rejection memory: similar wording stays blocked even after rejection.
    expect(
      learning.createVariant({
        ...base,
        title: "栈帧追踪法",
        instruction: "让学生画出每次调用的独立栈帧再比较循环变量"
      })
    ).toBeNull();
    // Genuinely different long instructions are NOT similar (the similarity is
    // length-normalized): a distinct approach for the same base strategy still lands.
    expect(
      learning.createVariant({
        ...base,
        title: "反例对照法",
        instruction: "给出一个没有出口条件的递归反例，让学生预测运行结果并解释为什么栈会溢出，再回到正确版本对照差异"
      })
    ).toMatchObject({ status: "pending" });
    // Dedupe and rejection memory are scoped per base strategy: the same wording under a
    // different strategy is a different candidate, not a blocked duplicate.
    expect(
      learning.createVariant({
        ...base,
        baseStrategy: "worked_example",
        title: "栈帧追踪法",
        instruction: "让学生画出每次调用的独立栈帧再比较循环变量"
      })
    ).toMatchObject({ status: "pending" });
    database.close();
  });

  it("runs variant review transitions with the two-trial cap", () => {
    const { database, learning } = fixture();
    const base = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception" as const,
      baseStrategy: "socratic_question" as const
    };
    const first = learning.createVariant({
      ...base,
      title: "第一讲法",
      instruction: "先画栈帧图再对比循环快照理解调用链"
    })!;
    expect(learning.reviewVariant(first.id, "trial").status).toBe("trial");
    const second = learning.createVariant({
      ...base,
      title: "第二讲法",
      instruction: "用套娃比喻走一遍嵌套调用的进入与返回过程"
    })!;
    expect(learning.reviewVariant(second.id, "trial").status).toBe("trial");
    const third = learning.createVariant({
      ...base,
      title: "第三讲法",
      instruction: "让学生亲手展开三层调用并标注每层的返回值来源"
    })!;
    expect(() => learning.reviewVariant(third.id, "trial")).toThrow("two variants");
    expect(() => learning.reviewVariant(first.id, "enable")).not.toThrow();
    expect(learning.getVariant(first.id)?.status).toBe("enabled");
    // Promoting a sibling is a switch: the previously enabled variant retires in the same
    // decision — otherwise offerVariant (oldest-enabled-first) would shadow the new one
    // forever while the UI showed both as 已启用.
    expect(learning.reviewVariant(second.id, "enable").status).toBe("enabled");
    expect(learning.getVariant(first.id)?.status).toBe("retired");
    expect(() => learning.reviewVariant(first.id, "keep")).toThrow("trial");
    expect(learning.reviewVariant(second.id, "retire").status).toBe("retired");
    database.close();
  });

  it("offers deterministically and only to live on-call scopes", () => {
    const { database, learning } = fixture();
    const base = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception" as const,
      baseStrategy: "socratic_question" as const
    };
    const first = learning.createVariant({
      ...base,
      title: "第一讲法",
      instruction: "先画栈帧图再对比循环快照理解调用链"
    })!;
    learning.reviewVariant(first.id, "trial");
    const offerScope = { ...base, datasetKind: "live" as const, condition: "on-call" as const };
    expect(learning.offerVariant(offerScope)?.id).toBe(first.id);
    expect(learning.offerVariant({ ...offerScope, datasetKind: "eval" })).toBeNull();
    expect(learning.offerVariant({ ...offerScope, datasetKind: "demo" })).toBeNull();
    expect(learning.offerVariant({ ...offerScope, datasetKind: "replay" })).toBeNull();
    expect(learning.offerVariant({ ...offerScope, condition: "one-shot" })).toBeNull();
    const second = learning.createVariant({
      ...base,
      title: "第二讲法",
      instruction: "用套娃比喻走一遍嵌套调用的进入与返回过程"
    })!;
    learning.reviewVariant(second.id, "trial");
    // Ties break toward the older trial; an enabled variant beats every trial.
    expect(learning.offerVariant(offerScope)?.id).toBe(first.id);
    learning.reviewVariant(second.id, "enable");
    expect(learning.offerVariant(offerScope)?.id).toBe(second.id);
    database.close();
  });

  it("attributes interventions only to variants the prompt actually delivered", () => {
    const scope = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception" as const,
      baseStrategy: "socratic_question" as const
    };
    const renderScope = { ...scope, datasetKind: "live" as const, condition: "on-call" as const };

    const attributed = fixture();
    const variant = attributed.learning.createVariant({
      ...scope,
      title: "栈帧追踪法",
      instruction: "先画栈帧图再对比循环快照理解调用链"
    })!;
    attributed.learning.reviewVariant(variant.id, "trial");
    const current = incident(attributed.learning, attributed.session.id);
    // The prompt render wrote the delivery ledger for round one, and the tutor recorded the
    // delivered strategy → the round is attributed.
    expect(attributed.learning.offerVariantForPrompt({ ...renderScope, incidentId: current.id, round: 1 })?.id).toBe(
      variant.id
    );
    complete(attributed.learning, current.id, "socratic_question", "resolved");
    const rounds = attributed.learning.listInterventions(current.id);
    expect(rounds[0]?.strategyVariantId).toBe(variant.id);
    const exported = attributed.learning.exportResearch();
    expect(exported.strategyVariants).toHaveLength(1);
    // The export carries the real attributed count, not the toVariant default.
    expect(exported.strategyVariants[0]?.attributedCount).toBe(1);
    expect(exported.experiences.at(-1)?.strategyVariantId).toBe(variant.id);
    attributed.database.close();

    const deviated = fixture();
    const other = deviated.learning.createVariant({
      ...scope,
      title: "栈帧追踪法",
      instruction: "先画栈帧图再对比循环快照理解调用链"
    })!;
    deviated.learning.reviewVariant(other.id, "trial");
    const deviatedIncident = incident(deviated.learning, deviated.session.id);
    deviated.learning.offerVariantForPrompt({ ...renderScope, incidentId: deviatedIncident.id, round: 1 });
    // The tutor deviated from the delivered strategy: no attribution, honest ITT semantics.
    complete(deviated.learning, deviatedIncident.id, "direct_explanation", "resolved");
    expect(deviated.learning.listInterventions(deviatedIncident.id)[0]?.strategyVariantId).toBeNull();
    deviated.database.close();

    const undelivered = fixture();
    const ghost = undelivered.learning.createVariant({
      ...scope,
      title: "栈帧追踪法",
      instruction: "先画栈帧图再对比循环快照理解调用链"
    })!;
    undelivered.learning.reviewVariant(ghost.id, "trial");
    const midRun = incident(undelivered.learning, undelivered.session.id);
    // An incident opened mid-run has no ledger entry for round one — the context rendered
    // before it existed, so the instruction was never in the prompt. Recording the matching
    // strategy must NOT stamp the variant (this was the systematic round-one mislabeling).
    complete(undelivered.learning, midRun.id, "socratic_question", "resolved");
    expect(undelivered.learning.listInterventions(midRun.id)[0]?.strategyVariantId).toBeNull();
    undelivered.database.close();
  });

  it("recommends promotion after five attributed outcomes, needs a real control, and respects the keep memory", () => {
    const { database, learning, session } = fixture();
    const variant = learning.createVariant({
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception",
      baseStrategy: "socratic_question",
      title: "栈帧追踪法",
      instruction: "先画栈帧图再对比循环快照理解调用链"
    })!;
    learning.reviewVariant(variant.id, "trial");
    const scope = {
      profileId: "local-operator",
      topicKey: "programming",
      difficultyType: "conceptual_misconception" as const
    };
    const renderScope = {
      ...scope,
      baseStrategy: "socratic_question" as const,
      datasetKind: "live" as const,
      condition: "on-call" as const
    };
    const attributedRound = (verdict: "resolved" | "partial" | "unresolved" = "resolved") => {
      const current = incident(learning, session.id);
      learning.offerVariantForPrompt({ ...renderScope, incidentId: current.id, round: 1 });
      complete(learning, current.id, "socratic_question", verdict);
    };
    for (let index = 0; index < 4; index += 1) {
      attributedRound();
      expect(learning.maybeRecommendVariantPromotion(scope)).toHaveLength(0);
    }
    attributedRound();
    // Five attributed outcomes but ZERO bare controls: a recommendation would compare
    // against the bare Beta(1,1) prior — advice built on no evidence — so none is raised.
    expect(learning.maybeRecommendVariantPromotion(scope)).toHaveLength(0);
    // One real control (no delivery ledger, tutor used the bare base strategy) unlocks it.
    complete(learning, incident(learning, session.id).id, "socratic_question", "resolved");
    const [recommended] = learning.maybeRecommendVariantPromotion(scope);
    expect(recommended).toMatchObject({ id: variant.id, recommendation: "promote" });
    expect(recommended!.recommendationSummary).toContain("建议转正");
    // Keeping dismisses the recommendation and blocks the identical evidence set.
    learning.reviewVariant(variant.id, "keep");
    expect(learning.maybeRecommendVariantPromotion(scope)).toHaveLength(0);
    // A sixth attributed outcome changes the evidence set; the recommendation returns.
    attributedRound();
    expect(learning.maybeRecommendVariantPromotion(scope)[0]?.recommendation).toBe("promote");
    database.close();
  });

  it("books a two-day spaced-review revisit only for live on-call resolutions", () => {
    const day = 24 * 60 * 60 * 1_000;
    const live = fixture();
    complete(live.learning, incident(live.learning, live.session.id).id, "direct_explanation", "resolved");
    const tasks = live.learning.listReviewTasks(live.session.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ round: 1, status: "pending" });
    expect(tasks[0]!.dueAt - Date.now()).toBeGreaterThan(1.9 * day);
    expect(tasks[0]!.dueAt - Date.now()).toBeLessThan(2.1 * day);
    live.database.close();

    const unresolvedLive = fixture();
    complete(
      unresolvedLive.learning,
      incident(unresolvedLive.learning, unresolvedLive.session.id).id,
      "conceptual_hint",
      "unresolved"
    );
    expect(unresolvedLive.learning.listReviewTasks(unresolvedLive.session.id)).toHaveLength(0);
    unresolvedLive.database.close();

    for (const [datasetKind, condition] of [
      ["eval", "on-call"],
      ["replay", "on-call"],
      ["demo", "on-call"],
      ["live", "one-shot"]
    ] as const) {
      const synthetic = fixture(datasetKind, condition);
      complete(
        synthetic.learning,
        incident(synthetic.learning, synthetic.session.id).id,
        "direct_explanation",
        "resolved"
      );
      expect(synthetic.learning.listReviewTasks(synthetic.session.id)).toHaveLength(0);
      synthetic.database.close();
    }
  });

  it("completes a fired revisit only via its own linked confirmation and books round two after a resolved revisit", () => {
    const day = 24 * 60 * 60 * 1_000;
    const { database, agents, conversation, learning, session } = fixture();
    const revisitIncident = (runId: string, hypothesis: string) =>
      learning.openIncident({
        sessionId: session.id,
        difficultyType: "conceptual_misconception",
        hypothesis,
        confidence: 0.7,
        severity: 3,
        evidenceMessageIds: [agents.getRun(runId)!.userMessageId],
        runId
      });
    complete(learning, incident(learning, session.id).id, "direct_explanation", "resolved");
    const [round1] = learning.listReviewTasks(session.id);
    // Simulate the runner: mark fired, then attach the run that delivered the revisit.
    learning.markReviewTask(round1!.id, "fired");
    const reviewRun = agents.createRun(conversation.id, "【间隔复习回访】迁移小任务", "normal");
    learning.attachReviewRun(round1!.id, reviewRun.id);

    // An unrelated difficulty confirmed while the revisit is outstanding must NOT consume
    // the fired task — and it books its own round-one review instead of losing it.
    const unrelated = incident(learning, session.id);
    complete(learning, unrelated.id, "worked_example", "resolved");
    let tasks = learning.listReviewTasks(session.id);
    expect(tasks.find((task) => task.id === round1!.id)?.status).toBe("fired");
    expect(
      tasks.filter((task) => task.round === 1 && task.status === "pending" && task.incidentId === unrelated.id)
    ).toHaveLength(1);

    // The revisit's own incident — opened by the review run — resolves: the task completes
    // and round two is booked for the ORIGINAL incident, while the revisit incident itself
    // starts no chain of its own.
    const revisit = revisitIncident(reviewRun.id, "回访迁移任务暴露的残余困难");
    complete(learning, revisit.id, "contrastive_example", "resolved");
    tasks = learning.listReviewTasks(session.id);
    expect(tasks.find((task) => task.id === round1!.id)?.status).toBe("completed");
    const round2 = tasks.find((task) => task.round === 2);
    expect(round2).toMatchObject({ status: "pending", incidentId: round1!.incidentId });
    expect(round2!.dueAt - Date.now()).toBeGreaterThan(4.9 * day);
    expect(tasks.filter((task) => task.status === "pending" && task.incidentId === revisit.id)).toHaveLength(0);

    // Round two is the end of the chain: its linked resolution books nothing further.
    learning.markReviewTask(round2!.id, "fired");
    const reviewRun2 = agents.createRun(conversation.id, "【间隔复习回访】第二轮迁移任务", "normal");
    learning.attachReviewRun(round2!.id, reviewRun2.id);
    const revisit2 = revisitIncident(reviewRun2.id, "第二轮回访的迁移任务");
    complete(learning, revisit2.id, "conceptual_hint", "resolved");
    tasks = learning.listReviewTasks(session.id);
    expect(tasks.find((task) => task.id === round2!.id)?.status).toBe("completed");
    expect(tasks.filter((task) => task.status === "pending" && task.incidentId === round1!.incidentId)).toHaveLength(0);
    database.close();
  });
});
