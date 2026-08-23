import { describe, expect, it } from "vitest";
import { AgentStore } from "../src/store.js";
import { openDatabase } from "../src/database.js";
import { LearningStore } from "../src/learning-store.js";
import { LearningCoordinator } from "../src/learning-coordinator.js";
import { LEARNING_DEMO_SCENARIOS } from "../src/learning-demos.js";

const resolvedAnswers: Record<(typeof LEARNING_DEMO_SCENARIOS)[number]["id"], string> = {
  "planning-gap":
    "The empty list is the base case and returns []. Split the input into first and rest, recursively flatten both smaller parts, then concatenate the two flattened results.",
  "uncertain-feedback":
    "Grader B is supported: merge sort has log n levels and performs O(n) work at each level, so halving alone does not justify the claimed total.",
  "persistent-misconception":
    "The final access is a capacity miss. Five distinct blocks exceed the four available lines, so no, increasing associativity alone cannot remove it."
};

const teachingSignals: Record<(typeof LEARNING_DEMO_SCENARIOS)[number]["id"], string> = {
  "planning-gap": "**1. Follow one real call**",
  "uncertain-feedback": "**1. Turn the scoring requirement into two checks**",
  "persistent-misconception": "**Direct-mapped cache**"
};

const frameworkLeak =
  /learning incident|diagnostic confidence|recommended strategy|learning policy|synthetic experience|self-evolution|provisional assessment|system verdict/i;

describe("LearningCoordinator demo loop", () => {
  for (const scenario of LEARNING_DEMO_SCENARIOS) {
    it(`completes diagnosis through user confirmation for ${scenario.id}`, () => {
      const database = openDatabase(":memory:");
      const agents = new AgentStore(database);
      const learning = new LearningStore(database);
      const coordinator = new LearningCoordinator(learning);
      const conversation = agents.createConversation("web", scenario.title, { profileId: "local-operator" });
      const session = learning.createSession({
        conversationId: conversation.id,
        profileId: "local-operator",
        goal: scenario.goalEn,
        topicKey: scenario.topicKey,
        datasetKind: "demo"
      });
      learning.seedDemoExperiences(session.id, scenario.difficultyType, [...scenario.seeds], "en");
      learning.maybeCreatePendingPolicyRevision({
        profileId: session.profileId,
        topicKey: session.topicKey,
        difficultyType: scenario.difficultyType,
        datasetKind: "demo"
      });

      const firstRun = agents.createRun(conversation.id, scenario.initialPromptEn, "normal");
      const firstTurn = coordinator.advanceDemoTurn({
        conversationId: conversation.id,
        runId: firstRun.id,
        userMessageId: firstRun.userMessageId,
        assistantMessageId: firstRun.assistantMessageId,
        prompt: scenario.initialPromptEn,
        locale: "en"
      });
      expect(firstTurn).toMatchObject({ phase: "verification_requested", incident: { status: "verifying" } });
      expect(firstTurn?.response).toContain(teachingSignals[scenario.id]);
      expect(firstTurn?.response).toContain("\n\n- ");
      expect(firstTurn?.response).not.toMatch(frameworkLeak);
      expect(scenario.initialPromptEn).not.toContain("synthetic learning case");
      expect(learning.listInterventions(firstTurn!.incident.id)).toHaveLength(1);
      expect(learning.listVerifications(firstTurn!.incident.id)).toHaveLength(1);

      const answer = resolvedAnswers[scenario.id];
      const secondRun = agents.createRun(conversation.id, answer, "normal");
      const secondTurn = coordinator.advanceDemoTurn({
        conversationId: conversation.id,
        runId: secondRun.id,
        userMessageId: secondRun.userMessageId,
        assistantMessageId: secondRun.assistantMessageId,
        prompt: answer,
        locale: "en"
      });
      expect(secondTurn).toMatchObject({ phase: "outcome_proposed", incident: { status: "verifying" } });
      expect(secondTurn?.response).toContain("You connected all of the important ideas");
      expect(secondTurn?.response).not.toMatch(frameworkLeak);
      const verification = learning.listVerifications(firstTurn!.incident.id)[0]!;
      expect(verification).toMatchObject({
        systemVerdict: "resolved",
        systemConfidence: 0.9,
        proposedMessageId: secondRun.assistantMessageId
      });

      learning.confirmVerification(verification.id, "resolved");
      expect(learning.getIncident(firstTurn!.incident.id)?.status).toBe("resolved");
      database.close();
    });
  }

  it("does not treat a long but irrelevant answer as evidence", () => {
    const scenario = LEARNING_DEMO_SCENARIOS[0]!;
    const database = openDatabase(":memory:");
    const agents = new AgentStore(database);
    const learning = new LearningStore(database);
    const coordinator = new LearningCoordinator(learning);
    const conversation = agents.createConversation("web", scenario.title, { profileId: "local-operator" });
    learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: scenario.goalEn,
      topicKey: scenario.topicKey,
      datasetKind: "demo"
    });

    const firstRun = agents.createRun(conversation.id, scenario.initialPromptEn, "normal");
    const firstTurn = coordinator.advanceDemoTurn({
      conversationId: conversation.id,
      runId: firstRun.id,
      userMessageId: firstRun.userMessageId,
      assistantMessageId: firstRun.assistantMessageId,
      prompt: scenario.initialPromptEn,
      locale: "en"
    })!;
    const irrelevant =
      "I would add exception handling around every array access and keep patching whichever line crashes next because that should eventually make the program run.";
    const secondRun = agents.createRun(conversation.id, irrelevant, "normal");
    const secondTurn = coordinator.advanceDemoTurn({
      conversationId: conversation.id,
      runId: secondRun.id,
      userMessageId: secondRun.userMessageId,
      assistantMessageId: secondRun.assistantMessageId,
      prompt: irrelevant,
      locale: "en"
    });

    expect(secondTurn?.response).toContain("has not yet connected these ideas");
    expect(learning.listVerifications(firstTurn.incident.id)[0]?.systemVerdict).toBe("unresolved");
    database.close();
  });
});
