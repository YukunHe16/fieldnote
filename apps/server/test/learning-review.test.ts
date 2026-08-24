import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { LearningReviewRunner } from "../src/learning-review.js";
import { LearningStore } from "../src/learning-store.js";
import { AgentStore } from "../src/store.js";

const DAY = 24 * 60 * 60 * 1_000;

function fixture() {
  const database = openDatabase(":memory:");
  const agents = new AgentStore(database);
  let now = Date.UTC(2026, 7, 24, 12);
  const learning = new LearningStore(database, () => now);
  const conversation = agents.createConversation("web", "学习复习测试", { profileId: "local-operator" });
  const session = learning.createSession({
    conversationId: conversation.id,
    profileId: "local-operator",
    goal: "理解递归",
    topicKey: "programming",
    datasetKind: "live"
  });
  const run = agents.createRun(conversation.id, "我不理解递归出口", "normal");
  const incident = learning.openIncident({
    sessionId: session.id,
    difficultyType: "conceptual_misconception",
    hypothesis: "把递归调用和循环迭代混为一谈",
    confidence: 0.8,
    severity: 3,
    evidenceMessageIds: [run.userMessageId]
  });
  const intervention = learning.recordIntervention({
    incidentId: incident.id,
    strategy: "direct_explanation",
    rationale: "根据误区选择",
    expectedSignal: "能解释递归出口"
  });
  const verification = learning.requestVerification({
    incidentId: incident.id,
    interventionId: intervention.id,
    method: "self_explanation",
    prompt: "请解释递归出口。",
    rubric: "说明何时停止调用"
  });
  learning.proposeSystemOutcome(verification.id, "resolved", 0.8);
  learning.confirmVerification(verification.id, "resolved");
  const submitted: Array<{ conversationId: string; content: string }> = [];
  const orchestrator = {
    submit(conversationId: string, content: string) {
      submitted.push({ conversationId, content });
      return {};
    }
  };
  return {
    database,
    agents,
    learning,
    conversation,
    session,
    submitted,
    orchestrator,
    setNow: (value: number) => {
      now = value;
    },
    now: () => now
  };
}

describe("LearningReviewRunner", () => {
  it("posts a revisit prompt into the original conversation when a task is due", () => {
    const { database, agents, learning, conversation, session, submitted, orchestrator, setNow, now } = fixture();
    const runner = new LearningReviewRunner(learning, agents, orchestrator, now);
    runner.tick();
    expect(submitted).toHaveLength(0);
    setNow(now() + 2 * DAY + 1_000);
    runner.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.conversationId).toBe(conversation.id);
    expect(submitted[0]!.content).toContain("间隔复习回访");
    expect(submitted[0]!.content).toContain("递归");
    expect(learning.listReviewTasks(session.id)[0]?.status).toBe("fired");
    // A fired task never double-posts.
    runner.tick();
    expect(submitted).toHaveLength(1);
    database.close();
  });

  it("cancels the task when the session ended and holds it while the session is paused", () => {
    const paused = fixture();
    paused.learning.transitionSession(paused.session.id, "paused");
    const pausedRunner = new LearningReviewRunner(paused.learning, paused.agents, paused.orchestrator, paused.now);
    paused.setNow(paused.now() + 3 * DAY);
    pausedRunner.tick();
    expect(paused.submitted).toHaveLength(0);
    expect(paused.learning.listReviewTasks(paused.session.id)[0]?.status).toBe("pending");
    paused.database.close();

    const ended = fixture();
    ended.learning.transitionSession(ended.session.id, "completed");
    const endedRunner = new LearningReviewRunner(ended.learning, ended.agents, ended.orchestrator, ended.now);
    ended.setNow(ended.now() + 3 * DAY);
    endedRunner.tick();
    expect(ended.submitted).toHaveLength(0);
    expect(ended.learning.listReviewTasks(ended.session.id)[0]?.status).toBe("cancelled");
    ended.database.close();
  });

  it("cancels the task when the conversation no longer exists", () => {
    const { database, learning, session, submitted, orchestrator, setNow, now } = fixture();
    const runner = new LearningReviewRunner(learning, { getConversation: () => null }, orchestrator, now);
    setNow(now() + 3 * DAY);
    runner.tick();
    expect(submitted).toHaveLength(0);
    expect(learning.listReviewTasks(session.id)[0]?.status).toBe("cancelled");
    database.close();
  });
});
