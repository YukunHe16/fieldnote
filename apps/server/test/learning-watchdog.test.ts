import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { LearningStore } from "../src/learning-store.js";
import { LearningWatchdog } from "../src/learning-watchdog.js";
import { AgentStore } from "../src/store.js";

function fixture(datasetKind: "live" | "eval" = "live") {
  const database = openDatabase(":memory:");
  const agents = new AgentStore(database);
  const conversation = agents.createConversation("web", "看门狗测试", { profileId: "local-operator" });
  let now = 1_000;
  const clock = () => now;
  const setNow = (value: number) => {
    now = value;
  };
  const learning = new LearningStore(database, clock);
  const session = learning.createSession({
    conversationId: conversation.id,
    profileId: "local-operator",
    goal: "理解递归",
    topicKey: "programming",
    datasetKind
  });
  const submitted: Array<{ conversationId: string; content: string }> = [];
  let busy = false;
  const orchestrator = {
    submit(conversationId: string, content: string) {
      submitted.push({ conversationId, content });
      const run = agents.createRun(conversationId, content, "normal");
      return { id: run.id };
    },
    isConversationBusy: () => busy
  };
  const setBusy = (value: boolean) => {
    busy = value;
  };
  let reachableFlag = true;
  const watchdog = new LearningWatchdog(learning, agents, orchestrator, clock, () => reachableFlag);
  const setReachable = (value: boolean) => {
    reachableFlag = value;
  };
  const completedRun = (at: number) => {
    const run = agents.createRun(conversation.id, "学习者的一条消息", "normal");
    agents.setRunStatus(run.id, "completed");
    database.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(at, run.id);
    return run;
  };
  const openIncident = () => {
    const run = agents.createRun(conversation.id, "我不理解这个概念", "normal");
    agents.setRunStatus(run.id, "completed");
    database.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(now - 1, run.id);
    return learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "把递归调用和循环迭代混为一谈",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [run.userMessageId]
    });
  };
  return {
    database,
    agents,
    learning,
    conversation,
    session,
    watchdog,
    submitted,
    setNow,
    setBusy,
    setReachable,
    completedRun,
    openIncident
  };
}

describe("LearningWatchdog", () => {
  it("nudges once per stalled signature, then gives up loudly and goes quiet", () => {
    const { database, learning, watchdog, submitted, setNow, completedRun, openIncident, session } = fixture();
    const incident = openIncident();
    // One idle turn: below the threshold, nothing happens.
    completedRun(1_100);
    watchdog.tick();
    expect(submitted).toHaveLength(0);
    // Second idle turn: one phase-matched, bracket-labelled nudge.
    completedRun(1_200);
    setNow(1_300);
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.content).toContain("【学习回路提醒】");
    expect(submitted[0]!.content).toContain("换一种方式");
    // Same state, same tick cadence: never a second nudge for the same signature.
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    // The nudge's own turn completes and changes nothing → gave_up, exactly once.
    completedRun(1_400);
    setNow(1_500);
    watchdog.tick();
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    const events = database
      .prepare("SELECT action FROM learning_watchdog_events WHERE incident_id = ? ORDER BY created_at")
      .all(incident.id) as Array<{ action: string }>;
    expect(events.map((event) => event.action)).toEqual(["nudged", "gave_up"]);
    // The stall surfaces in the session-denominator metrics.
    const metrics = learning.metricsSummary({});
    expect(metrics.sessions).toMatchObject({ total: 1, stalledMidLoop: 1, nudged: 1 });
    expect(metrics.sessions?.conditions.find((cell) => cell.condition === session.condition)).toMatchObject({
      stalledMidLoop: 1
    });
    database.close();
  });

  it("resets on progress: a new signature earns a fresh threshold and one new nudge", () => {
    const { database, learning, watchdog, submitted, setNow, completedRun, openIncident } = fixture();
    const incident = openIncident();
    completedRun(1_100);
    completedRun(1_200);
    setNow(1_250);
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    // Progress: an intervention lands, signature changes, updated_at moves forward.
    setNow(1_300);
    learning.recordIntervention({
      incidentId: incident.id,
      strategy: "contrastive_example",
      rationale: "换招",
      expectedSignal: "能解释递归出口"
    });
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    // One idle turn after progress: still below threshold.
    completedRun(1_400);
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    // Second idle turn: a new nudge for the intervening phase.
    completedRun(1_500);
    setNow(1_600);
    watchdog.tick();
    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.content).toContain("小任务");
    database.close();
  });

  it("excludes learner-owed states, non-live datasets, inactive sessions, busy and unreachable conversations", () => {
    const { database, learning, watchdog, submitted, setNow, setBusy, setReachable, completedRun, openIncident } =
      fixture();
    const incident = openIncident();
    completedRun(1_100);
    completedRun(1_200);
    setNow(1_250);
    // Busy conversation: skipped.
    setBusy(true);
    watchdog.tick();
    expect(submitted).toHaveLength(0);
    setBusy(false);
    // Unreachable channel: skipped.
    setReachable(false);
    watchdog.tick();
    expect(submitted).toHaveLength(0);
    setReachable(true);
    // Verification requested but unanswered: the learner owes the move, not the tutor.
    setNow(1_300);
    const intervention = learning.recordIntervention({
      incidentId: incident.id,
      strategy: "worked_example",
      rationale: "示范",
      expectedSignal: "能自己走一遍"
    });
    const requestRun = completedRun(1_350);
    const verification = learning.requestVerification({
      incidentId: incident.id,
      interventionId: intervention.id,
      method: "self_explanation",
      prompt: "请解释递归出口。",
      rubric: "说明何时停止调用"
    });
    watchdog.tick();
    expect(submitted).toHaveLength(0);
    expect(requestRun.id).toBeTruthy();
    // The learner answers (a later completed run) but no system verdict lands for two turns:
    // now the tutor owes propose_learning_outcome and the nudge fires.
    completedRun(1_400);
    completedRun(1_500);
    setNow(1_550);
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.content).toContain("评估");
    // A proposed verdict flips it back to learner-owed: no further nudges.
    setNow(1_600);
    learning.proposeSystemOutcome(verification.id, "resolved", 0.8);
    completedRun(1_700);
    completedRun(1_800);
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    database.close();
  });

  it("ignores eval sessions and paused sessions entirely", () => {
    const evalFixture = fixture("eval");
    evalFixture.openIncident();
    evalFixture.completedRun(1_100);
    evalFixture.completedRun(1_200);
    evalFixture.setNow(1_250);
    evalFixture.watchdog.tick();
    expect(evalFixture.submitted).toHaveLength(0);
    evalFixture.database.close();

    const paused = fixture();
    paused.openIncident();
    paused.completedRun(1_100);
    paused.completedRun(1_200);
    paused.learning.transitionSession(paused.session.id, "paused");
    paused.setNow(1_250);
    paused.watchdog.tick();
    expect(paused.submitted).toHaveLength(0);
    paused.database.close();
  });

  it("survives restarts: a fresh instance over the same database does not re-nudge", () => {
    const { database, agents, learning, watchdog, submitted, setNow, completedRun, openIncident } = fixture();
    openIncident();
    completedRun(1_100);
    completedRun(1_200);
    setNow(1_250);
    watchdog.tick();
    expect(submitted).toHaveLength(1);
    const replacementSubmissions: Array<{ conversationId: string }> = [];
    const replacement = new LearningWatchdog(
      learning,
      agents,
      {
        submit(conversationId: string) {
          replacementSubmissions.push({ conversationId });
          return {};
        },
        isConversationBusy: () => false
      },
      () => 1_260
    );
    replacement.tick();
    expect(replacementSubmissions).toHaveLength(0);
    database.close();
  });

  it("counts recovery only on real loop progress, never on abandonment", () => {
    const { database, learning, watchdog, setNow, completedRun, openIncident, session } = fixture();
    const incident = openIncident();
    completedRun(1_100);
    completedRun(1_200);
    setNow(1_250);
    watchdog.tick();
    // The nudge works: an intervention lands after it → recovered.
    setNow(1_300);
    learning.recordIntervention({
      incidentId: incident.id,
      strategy: "contrastive_example",
      rationale: "被提醒后换招",
      expectedSignal: "能解释递归出口"
    });
    expect(learning.metricsSummary({}).sessions).toMatchObject({ nudged: 1, recoveredAfterNudge: 1 });
    database.close();

    // Second fixture: the nudge fails, the learner closes the session. Abandonment is not recovery.
    const failed = fixture();
    failed.openIncident();
    failed.completedRun(1_100);
    failed.completedRun(1_200);
    failed.setNow(1_250);
    failed.watchdog.tick();
    failed.completedRun(1_400);
    failed.setNow(1_500);
    failed.watchdog.tick();
    failed.learning.transitionSession(failed.session.id, "completed");
    expect(failed.learning.metricsSummary({}).sessions).toMatchObject({
      nudged: 1,
      stalledMidLoop: 1,
      recoveredAfterNudge: 0
    });
    expect(session.id).toBeTruthy();
    failed.database.close();
  });

  it("treats harness-originated runs as non-answers for a pending verification", () => {
    const { database, learning, watchdog, submitted, setNow, completedRun, openIncident } = fixture();
    const incident = openIncident();
    setNow(1_050);
    const intervention = learning.recordIntervention({
      incidentId: incident.id,
      strategy: "worked_example",
      rationale: "示范",
      expectedSignal: "能自己走一遍"
    });
    completedRun(1_100);
    learning.requestVerification({
      incidentId: incident.id,
      interventionId: intervention.id,
      method: "self_explanation",
      prompt: "请解释递归出口。",
      rubric: "说明何时停止调用"
    });
    // Two later completed runs exist, but both are harness runs: a spaced-review revisit and
    // a (hypothetical) watchdog nudge. Neither is a learner answer → no propose-nudge.
    const reviewRun = completedRun(1_200);
    database
      .prepare(
        `INSERT INTO learning_review_tasks (id, incident_id, session_id, conversation_id, profile_id, round, due_at, status, fired_run_id, created_at, updated_at)
         VALUES ('rt1', ?, ?, ?, 'local-operator', 1, 0, 'fired', ?, 0, 0)`
      )
      .run(
        incident.id,
        incident.sessionId,
        submitted.length ? "x" : (learning.getSession(incident.sessionId)?.conversationId ?? ""),
        reviewRun.id
      );
    const nudgeRun = completedRun(1_300);
    database
      .prepare(
        `INSERT INTO learning_watchdog_events (id, session_id, incident_id, signature, action, run_id, created_at)
         VALUES ('we1', ?, ?, 'other-signature', 'nudged', ?, 1_150)`
      )
      .run(incident.sessionId, incident.id, nudgeRun.id);
    setNow(1_350);
    watchdog.tick();
    expect(submitted).toHaveLength(0);
    // A genuine learner run arrives → now the tutor owes the verdict and the nudge fires.
    completedRun(1_400);
    completedRun(1_500);
    setNow(1_550);
    watchdog.tick();
    expect(submitted.length).toBeGreaterThan(0);
    database.close();
  });

  it("leaves threads with no completed run in 24 hours alone", () => {
    const { database, watchdog, submitted, setNow, completedRun, openIncident } = fixture();
    openIncident();
    completedRun(1_100);
    completedRun(1_200);
    // Boot-time tick a day later must not resurrect the dead thread.
    setNow(1_200 + 25 * 60 * 60 * 1_000);
    watchdog.tick();
    expect(submitted).toHaveLength(0);
    database.close();
  });

  it("compensates the ledger when submit throws, so a phantom nudge cannot become a stall", () => {
    const { database, agents, learning, setNow, completedRun, openIncident } = fixture();
    openIncident();
    completedRun(1_100);
    completedRun(1_200);
    setNow(1_250);
    const throwing = new LearningWatchdog(
      learning,
      agents,
      {
        submit() {
          throw new Error("orchestrator stopped");
        },
        isConversationBusy: () => false
      },
      () => 1_250
    );
    throwing.tick();
    expect((database.prepare("SELECT COUNT(*) AS n FROM learning_watchdog_events").get() as { n: number }).n).toBe(0);
    // A later healthy watchdog still gets to nudge — the failed attempt left no residue.
    const delivered: string[] = [];
    const healthy = new LearningWatchdog(
      learning,
      agents,
      {
        submit(conversationId: string) {
          delivered.push(conversationId);
          const run = agents.createRun(conversationId, "提醒", "normal");
          return { id: run.id };
        },
        isConversationBusy: () => false
      },
      () => 1_300
    );
    healthy.tick();
    expect(delivered).toHaveLength(1);
    database.close();
  });

  it("keeps dismissed and deterministic sessions out of the health denominator", () => {
    const { database, agents, learning, completedRun } = fixture();
    completedRun(1_100);
    completedRun(1_200);
    completedRun(1_300);
    // Dismissed suggestion with plenty of turns: the user opted out, not a loop failure.
    const declined = agents.createConversation("web", "婉拒建议", { profileId: "local-operator" });
    const suggestion = learning.createSession({
      conversationId: declined.id,
      profileId: "local-operator",
      goal: "被拒绝的建议",
      status: "suggested"
    });
    learning.transitionSession(suggestion.id, "dismissed");
    for (const at of [1_100, 1_200, 1_300]) {
      const run = agents.createRun(declined.id, "普通聊天", "normal");
      agents.setRunStatus(run.id, "completed");
      database.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(at, run.id);
    }
    const metrics = learning.metricsSummary({});
    expect(metrics.sessions).toMatchObject({ total: 1, neverOpened: 1, unhealthy: 1 });
    database.close();
  });

  it("counts never-opened and errored sessions in the metrics block and nulls it under a difficulty filter", () => {
    const { database, agents, learning, conversation, completedRun } = fixture();
    // This fixture session: three completed turns, no incident → never-opened.
    completedRun(1_100);
    completedRun(1_200);
    completedRun(1_300);
    // A second session whose latest run failed → errored.
    const other = agents.createConversation("web", "出错会话", { profileId: "local-operator" });
    learning.createSession({
      conversationId: other.id,
      profileId: "local-operator",
      goal: "另一个目标"
    });
    const failing = agents.createRun(other.id, "会失败的消息", "normal");
    agents.setRunStatus(failing.id, "failed", "boom");
    const metrics = learning.metricsSummary({});
    expect(metrics.sessions).toMatchObject({ total: 2, neverOpened: 1, errored: 1, stalledMidLoop: 0 });
    expect(learning.metricsSummary({ difficultyType: "planning_gap" }).sessions).toBeNull();
    // Overlapping categories count once: fail a run in the never-opened session too.
    const overlap = agents.createRun(conversation.id, "再失败一次", "normal");
    agents.setRunStatus(overlap.id, "failed", "boom");
    const after = learning.metricsSummary({});
    expect(after.sessions).toMatchObject({ neverOpened: 1, errored: 2, unhealthy: 2 });
    database.close();
  });
});
