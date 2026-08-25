import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { maybeDistillFromResolvedIncident } from "../src/learning-invention.js";
import { LearningStore, type LearningDatasetKind } from "../src/learning-store.js";
import { AgentStore } from "../src/store.js";

function draftApproved(learning: LearningStore, incidentId: string, taskText: string) {
  const { round } = learning.practiceDraftContext(incidentId);
  return learning.recordPracticeItem({
    incidentId,
    round,
    status: "approved",
    taskText,
    targetHypothesis: "剧本误解",
    expectedAnswerSketch: "正确规则的应用",
    difficulty: 3,
    method: "transfer_example",
    gate: "none",
    noveltyScore: 0
  });
}

function fixture(datasetKind: LearningDatasetKind = "live", condition: "on-call" | "one-shot" = "on-call") {
  const database = openDatabase(":memory:");
  const agents = new AgentStore(database);
  const learning = new LearningStore(database);
  const conversation = agents.createConversation("web", "学习", { profileId: "local-operator" });
  const session = learning.createSession({
    conversationId: conversation.id,
    profileId: "local-operator",
    goal: "理解递归",
    topicKey: "programming",
    datasetKind,
    condition,
    ...(datasetKind === "demo" ? { executionMode: "agent" as const } : {})
  });
  const run = agents.createRun(conversation.id, "我不懂递归出口", "normal");
  agents.replaceMessageText(run.assistantMessageId, "让我们画出每一层调用的栈帧，标出它自己的参数副本，再看谁先返回。");
  agents.setMessageStatus(run.assistantMessageId, "completed");
  return { database, agents, learning, conversation, session, run };
}

function driveIncident(
  ctx: ReturnType<typeof fixture>,
  options: { rounds: number; verdict?: "resolved" | "partial"; withMessage?: boolean }
) {
  const incident = ctx.learning.openIncident({
    sessionId: ctx.session.id,
    difficultyType: "conceptual_misconception",
    hypothesis: "把递归调用和循环迭代混为一谈",
    confidence: 0.8,
    severity: 3,
    evidenceMessageIds: [ctx.run.userMessageId]
  });
  const strategies = ["socratic_question", "conceptual_hint", "worked_example"] as const;
  for (let round = 0; round < options.rounds; round += 1) {
    const final = round === options.rounds - 1;
    const intervention = ctx.learning.recordIntervention({
      incidentId: incident.id,
      strategy: strategies[round]!,
      rationale: "按误区选择",
      expectedSignal: "能解释出口",
      ...(final && options.withMessage !== false ? { runId: ctx.run.id, messageId: ctx.run.assistantMessageId } : {})
    });
    const practiceDraft0 = draftApproved(ctx.learning, incident.id, "请解释递归何时停止");
    const verification = ctx.learning.requestVerification({
      incidentId: incident.id,
      interventionId: intervention.id,
      method: "self_explanation",
      prompt: "请解释递归何时停止",
      rubric: "说明出口条件",
      practiceItemId: practiceDraft0.id
    });
    const verdict = final ? (options.verdict ?? "resolved") : "unresolved";
    ctx.learning.proposeSystemOutcome(verification.id, verdict, 0.8);
    ctx.learning.confirmVerification(verification.id, verdict);
  }
  return incident;
}

const stubRuntime = (result: { title: string; instruction: string; baseStrategy: string } | null) => {
  const calls: unknown[] = [];
  return {
    calls,
    async distillTeachingApproach(input: unknown) {
      calls.push(input);
      return result;
    }
  };
};

describe("maybeDistillFromResolvedIncident", () => {
  it("distills a pending variant from a live on-call incident resolved after round one", async () => {
    const ctx = fixture();
    const incident = driveIncident(ctx, { rounds: 2 });
    const runtime = stubRuntime({
      title: "栈帧对照法",
      instruction: "先画栈帧图再对比循环快照",
      // The model claims a different base strategy; the host must ignore it.
      baseStrategy: "direct_explanation"
    });
    const variant = await maybeDistillFromResolvedIncident({
      learning: ctx.learning,
      store: ctx.agents,
      runtime,
      workspaceRoot: "/tmp/does-not-matter",
      incidentId: incident.id
    });
    expect(runtime.calls).toHaveLength(1);
    expect(variant).toMatchObject({
      status: "pending",
      // The host decides the base strategy from the winning round, not the model.
      baseStrategy: "conceptual_hint",
      sourceIncidentId: incident.id,
      title: "栈帧对照法"
    });
    ctx.database.close();
  });

  it("skips round-one resolutions, synthetic sessions, one-shot, and missing messages", async () => {
    const roundOne = fixture();
    const roundOneIncident = driveIncident(roundOne, { rounds: 1 });
    const runtime = stubRuntime({ title: "x", instruction: "y", baseStrategy: "socratic_question" });
    expect(
      await maybeDistillFromResolvedIncident({
        learning: roundOne.learning,
        store: roundOne.agents,
        runtime,
        workspaceRoot: "/tmp",
        incidentId: roundOneIncident.id
      })
    ).toBeNull();
    roundOne.database.close();

    for (const [datasetKind, condition] of [
      ["eval", "on-call"],
      ["demo", "on-call"]
    ] as const) {
      const synthetic = fixture(datasetKind, condition);
      const syntheticIncident = driveIncident(synthetic, { rounds: 2 });
      expect(
        await maybeDistillFromResolvedIncident({
          learning: synthetic.learning,
          store: synthetic.agents,
          runtime,
          workspaceRoot: "/tmp",
          incidentId: syntheticIncident.id
        })
      ).toBeNull();
      synthetic.database.close();
    }

    const noMessage = fixture();
    const noMessageIncident = driveIncident(noMessage, { rounds: 2, withMessage: false });
    expect(
      await maybeDistillFromResolvedIncident({
        learning: noMessage.learning,
        store: noMessage.agents,
        runtime,
        workspaceRoot: "/tmp",
        incidentId: noMessageIncident.id
      })
    ).toBeNull();
    noMessage.database.close();

    const declined = fixture();
    const declinedIncident = driveIncident(declined, { rounds: 2 });
    expect(
      await maybeDistillFromResolvedIncident({
        learning: declined.learning,
        store: declined.agents,
        runtime: stubRuntime(null),
        workspaceRoot: "/tmp",
        incidentId: declinedIncident.id
      })
    ).toBeNull();
    declined.database.close();
  });
});
