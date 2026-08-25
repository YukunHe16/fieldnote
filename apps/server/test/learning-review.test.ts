import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { LearningReviewRunner } from "../src/learning-review.js";
import { LearningStore } from "../src/learning-store.js";
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
  const practiceDraft0 = draftApproved(learning, incident.id, "请解释递归出口。");
  const verification = learning.requestVerification({
    incidentId: incident.id,
    interventionId: intervention.id,
    method: "self_explanation",
    prompt: "请解释递归出口。",
    rubric: "说明何时停止调用",
    practiceItemId: practiceDraft0.id
  });
  learning.proposeSystemOutcome(verification.id, "resolved", 0.8);
  learning.confirmVerification(verification.id, "resolved");
  const submitted: Array<{ conversationId: string; content: string }> = [];
  const orchestrator = {
    // Mirrors the real orchestrator: submit creates an actual run (fired_run_id is a real
    // foreign key into runs).
    submit(conversationId: string, content: string) {
      submitted.push({ conversationId, content });
      return agents.createRun(conversationId, content, "normal");
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
    const fired = learning.listReviewTasks(session.id)[0];
    expect(fired?.status).toBe("fired");
    // The delivering run is attached: confirmVerification matches the revisit's own
    // confirmation through it.
    expect(fired?.firedRunId).toBeTruthy();
    expect(agents.getRun(fired!.firedRunId!)?.conversationId).toBe(conversation.id);
    // A fired task never double-posts.
    runner.tick();
    expect(submitted).toHaveLength(1);
    database.close();
  });

  it("cancels the task when the session ended and defers it while the session is paused", () => {
    const paused = fixture();
    paused.learning.transitionSession(paused.session.id, "paused");
    const pausedRunner = new LearningReviewRunner(paused.learning, paused.agents, paused.orchestrator, paused.now);
    paused.setNow(paused.now() + 3 * DAY);
    pausedRunner.tick();
    expect(paused.submitted).toHaveLength(0);
    const held = paused.learning.listReviewTasks(paused.session.id)[0];
    expect(held?.status).toBe("pending");
    // Deferred, not left overdue: a pile of past-due tasks from paused sessions would
    // otherwise pin the head of the due window and starve active sessions' revisits.
    expect(held!.dueAt).toBeGreaterThan(paused.now());
    // Resuming the session lets the deferred task fire on a later tick.
    paused.learning.transitionSession(paused.session.id, "active");
    paused.setNow(paused.now() + 2 * 60 * 60 * 1_000);
    pausedRunner.tick();
    expect(paused.submitted).toHaveLength(1);
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

  it("defers unreachable conversations and expires fired tasks that never linked back", () => {
    const unreachable = fixture();
    let reachable = false;
    const runner = new LearningReviewRunner(
      unreachable.learning,
      unreachable.agents,
      unreachable.orchestrator,
      unreachable.now,
      () => reachable
    );
    unreachable.setNow(unreachable.now() + 2 * DAY + 1_000);
    runner.tick();
    // A Feishu conversation whose binding rotated away (/new) gets no invisible model run.
    expect(unreachable.submitted).toHaveLength(0);
    expect(unreachable.learning.listReviewTasks(unreachable.session.id)[0]?.status).toBe("pending");
    // Once the channel can reach the learner again, the deferred task fires.
    reachable = true;
    unreachable.setNow(unreachable.now() + 2 * 60 * 60 * 1_000);
    runner.tick();
    expect(unreachable.submitted).toHaveLength(1);
    // A fired task whose revisit never produced a linked confirmation expires after a week
    // instead of sitting as a permanent trap for later bookkeeping.
    unreachable.setNow(unreachable.now() + 8 * DAY);
    runner.tick();
    expect(unreachable.learning.listReviewTasks(unreachable.session.id)[0]?.status).toBe("cancelled");
    unreachable.database.close();
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
