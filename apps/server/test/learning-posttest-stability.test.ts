import { describe, expect, it } from "vitest";
import {
  discoverPostTestAnswers,
  evaluateStabilityGate,
  planPendingGradings,
  renderReport,
  summarizeStability,
  validateResume
} from "../../../scripts/learning-posttest-stability.mjs";

const answers = (count = 27) =>
  Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index + 1}`,
    finalPostTestAnswer: `answer ${index + 1}`
  }));

const grading = (itemId: string, repeat: number) => ({
  itemId,
  repeat,
  error: null,
  verdict: "resolved",
  matched: ["alpha", "beta"],
  agreed: true
});

describe("post-test answer discovery", () => {
  it("discovers exactly 27 archived final answers", () => {
    const discovered = discoverPostTestAnswers({ records: answers() });

    expect(discovered).toHaveLength(27);
    expect(discovered[0]).toEqual({ itemId: "item-1", answer: "answer 1" });
  });

  it("rejects missing answers and duplicate item ids", () => {
    const missing = answers();
    missing[0].finalPostTestAnswer = "  ";
    expect(() => discoverPostTestAnswers({ records: missing })).toThrow("found 26");

    const duplicate = answers();
    duplicate[26].itemId = duplicate[0].itemId;
    expect(() => discoverPostTestAnswers({ records: duplicate })).toThrow("must be unique");
  });
});

describe("post-test stability summary and gates", () => {
  it("passes at the exact verdict and concept agreement thresholds", () => {
    const itemIds = answers().map((answer) => answer.itemId);
    const gradings = itemIds.flatMap((itemId) => [grading(itemId, 1), grading(itemId, 2)]);
    gradings.find((entry) => entry.itemId === "item-1" && entry.repeat === 2)!.verdict = "partial";
    for (const itemId of ["item-1", "item-2", "item-3"]) {
      gradings.find((entry) => entry.itemId === itemId && entry.repeat === 2)!.matched = ["alpha"];
    }

    const summary = summarizeStability(gradings, itemIds);

    expect(summary).toMatchObject({
      expectedGradings: 54,
      judgeErrors: 0,
      verdictAgreements: 26,
      exactConceptAgreements: 24,
      regexAgreements: 54,
      regexComparable: 54,
      retriedGradings: 0,
      noThinkingRecoveries: 0
    });
    expect(evaluateStabilityGate(summary)).toMatchObject({
      errorGate: true,
      verdictGate: true,
      exactConceptGate: true,
      overallPass: true
    });
  });

  it("fails below either agreement threshold", () => {
    const itemIds = answers().map((answer) => answer.itemId);
    const gradings = itemIds.flatMap((itemId) => [grading(itemId, 1), grading(itemId, 2)]);
    for (const itemId of ["item-1", "item-2"]) {
      gradings.find((entry) => entry.itemId === itemId && entry.repeat === 2)!.verdict = "partial";
    }
    for (const itemId of ["item-1", "item-2", "item-3", "item-4"]) {
      gradings.find((entry) => entry.itemId === itemId && entry.repeat === 2)!.matched = ["alpha"];
    }

    const gate = evaluateStabilityGate(summarizeStability(gradings, itemIds));

    expect(gate).toMatchObject({ verdictGate: false, exactConceptGate: false, overallPass: false });
  });

  it("counts persisted judge failures and fails the complete error-free gate", () => {
    const itemIds = answers().map((answer) => answer.itemId);
    const gradings = itemIds.flatMap((itemId) => [grading(itemId, 1), grading(itemId, 2)]);
    Object.assign(gradings[0], {
      error: "Judge returned no JSON",
      verdict: null,
      matched: [],
      agreed: null
    });

    const summary = summarizeStability(gradings, itemIds);

    expect(summary).toMatchObject({ completedGradings: 54, successfulGradings: 53, judgeErrors: 1 });
    expect(evaluateStabilityGate(summary)).toMatchObject({ errorGate: false, overallPass: false });
  });

  it("reports larger-budget retries and successful no-thinking recovery", () => {
    const itemIds = answers().map((answer) => answer.itemId);
    const gradings = itemIds.flatMap((itemId) => [grading(itemId, 1), grading(itemId, 2)]);
    Object.assign(gradings[0], {
      judgeAttemptUsed: 3,
      judgeAttempts: [
        { reasoningMode: "default", outcome: "empty_text" },
        { reasoningMode: "default", outcome: "empty_text" },
        { reasoningMode: "none", outcome: "success" }
      ]
    });

    expect(summarizeStability(gradings, itemIds)).toMatchObject({
      retriedGradings: 1,
      noThinkingRecoveries: 1
    });
  });
});

describe("post-test stability resume planning", () => {
  it("plans only missing item/repeat keys and treats recorded failures as completed", () => {
    const archived = [
      { itemId: "one", answer: "first" },
      { itemId: "two", answer: "second" }
    ];
    const completed = [
      { itemId: "one", repeat: 1 },
      { itemId: "one", repeat: 2, error: "persisted failure" },
      { itemId: "two", repeat: 1 }
    ];

    expect(planPendingGradings(archived, completed)).toEqual([{ itemId: "two", answer: "second", repeat: 2 }]);
  });

  it("rejects duplicate or unknown checkpoint keys", () => {
    const archived = [{ itemId: "one", answer: "first" }];
    expect(() =>
      planPendingGradings(archived, [
        { itemId: "one", repeat: 1 },
        { itemId: "one", repeat: 1 }
      ])
    ).toThrow("duplicate grading");
    expect(() => planPendingGradings(archived, [{ itemId: "other", repeat: 1 }])).toThrow("unknown itemId");
  });

  it("refuses to resume under a different protocol or judge configuration", () => {
    const context = {
      input: { sha256: "input" },
      repeats: 2,
      protocol: {
        fingerprint: "protocol",
        buildIdentity: { gitSha: "build", gitDirty: false }
      },
      config: { learnerBase: "https://judge.invalid", judgeModel: "judge" }
    };
    const result = {
      input: { sha256: "input" },
      repeats: 2,
      protocol: {
        fingerprint: "protocol",
        buildIdentity: { gitSha: "build", gitDirty: false }
      },
      config: { learnerBase: "https://judge.invalid", judgeModel: "judge" }
    };

    expect(() => validateResume(result, context)).not.toThrow();
    expect(() => validateResume({ ...result, config: { ...result.config, judgeModel: "other" } }, context)).toThrow(
      "judge model/provider"
    );
    expect(() =>
      validateResume({ ...result, protocol: { ...result.protocol, fingerprint: "other" } }, context)
    ).toThrow("protocol fingerprint");
  });
});

describe("post-test stability report", () => {
  it("renders ordinary Markdown without patch-marker prefixes", () => {
    const itemIds = answers().map((answer) => answer.itemId);
    const summary = summarizeStability(
      itemIds.flatMap((itemId) => [grading(itemId, 1), grading(itemId, 2)]),
      itemIds
    );
    const report = renderReport({
      input: { sha256: "input" },
      protocol: {
        gitSha: "git",
        gitDirty: false,
        buildIdentity: { gitSha: "build", gitDirty: false },
        itemBankSha256: "items",
        judgePromptSha256: "prompt",
        judgeRetryPolicy: "test-policy"
      },
      config: { judgeModel: "judge", learnerBase: "https://judge.invalid" },
      summary,
      gate: evaluateStabilityGate(summary)
    });

    expect(report).toContain("## Result");
    expect(report).toContain("Judge retry policy: `test-policy`");
    expect(report.split("\n").some((line) => line.startsWith("+"))).toBe(false);
  });
});
