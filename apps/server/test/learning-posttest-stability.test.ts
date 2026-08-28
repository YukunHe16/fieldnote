import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  discoverPostTestAnswers,
  evaluateStabilityGate,
  planPendingGradings,
  renderReport,
  summarizeStability,
  validateHoldoutManifest,
  validateResume
} from "../../../scripts/learning-posttest-stability.mjs";

const answers = (count = 27) =>
  Array.from({ length: count }, (_, index) => ({
    itemId: `item-${index + 1}`,
    finalPostTestAnswer: `answer ${index + 1}`
  }));

const grading = (itemId: string, repeat: number) => ({
  answerId: itemId,
  itemId,
  repeat,
  formatParsed: true,
  error: null,
  verdict: "resolved",
  matched: ["alpha", "beta"],
  concepts: [
    { id: "alpha", demonstrated: true, evidenceValid: true },
    { id: "beta", demonstrated: true, evidenceValid: true }
  ],
  agreed: true
});

const structuredAnswer = [
  "ORIGINAL_CONCLUSION:",
  "Grader B is supported.",
  "ORIGINAL_EVIDENCE:",
  "Original evidence.",
  "GENERAL_METHOD:",
  "Check the evidence.",
  "TRANSFER_CONCLUSION:",
  "Grader R is supported.",
  "TRANSFER_EVIDENCE:",
  "Transfer evidence."
].join("\n");
const structuredAnswerSha256 = createHash("sha256").update(structuredAnswer).digest("hex");
const holdoutItemIds = [
  "fu-wrong-endorsement-plain-dict-order",
  "fu-wrong-endorsement-plain-string-immutable",
  "fu-wrong-rejection-plain-append-returns",
  "fu-wrong-rejection-authoritative-floor-division"
];

const holdoutPayload = () => ({
  schemaVersion: "learning-posttest-holdout/v1",
  answerFormat: "structured-v1",
  judgeContractVersion: "evidence-v2",
  cases: holdoutItemIds.flatMap((itemId) =>
    ["complete", "original-only", "transfer-only"].map((variant) => ({
      caseId: `${itemId}::${variant}`,
      itemId,
      variant,
      answer: structuredAnswer,
      answerSha256: structuredAnswerSha256
    }))
  )
});

describe("post-test answer discovery", () => {
  it("discovers exactly 27 archived final answers", () => {
    const discovered = discoverPostTestAnswers({ records: answers() });

    expect(discovered).toHaveLength(27);
    expect(discovered[0]).toMatchObject({
      answerId: "item-1",
      itemId: "item-1",
      answer: "answer 1",
      answerFormat: "legacy-freeform"
    });
  });

  it("rejects missing answers and duplicate item ids", () => {
    const missing = answers();
    missing[0].finalPostTestAnswer = "  ";
    expect(() => discoverPostTestAnswers({ records: missing })).toThrow("found 26");

    const duplicate = answers();
    duplicate[26].itemId = duplicate[0].itemId;
    expect(() => discoverPostTestAnswers({ records: duplicate })).toThrow("must be unique");
  });

  it("discovers four repeated item ids as twelve unique structured holdout cases", () => {
    const cases = Array.from({ length: 4 }, (_, item) =>
      ["complete", "original-only", "transfer-only"].map((variant) => ({
        caseId: `item-${item + 1}::${variant}`,
        itemId: `item-${item + 1}`,
        variant,
        answer: structuredAnswer
      }))
    ).flat();

    const discovered = discoverPostTestAnswers({ answerFormat: "structured-v1", cases }, 12);

    expect(discovered).toHaveLength(12);
    expect(new Set(discovered.map((answer) => answer.itemId)).size).toBe(4);
    expect(new Set(discovered.map((answer) => answer.answerId)).size).toBe(12);
  });

  it("keeps an all-legacy dataset readable but rejects mixed answer formats", () => {
    expect(discoverPostTestAnswers({ records: answers() })[0].answerFormat).toBe("legacy-freeform");
    const mixed = answers() as Array<ReturnType<typeof answers>[number] & { answerFormat?: string }>;
    mixed[0].answerFormat = "structured-v1";
    expect(() => discoverPostTestAnswers({ records: mixed })).toThrow("cannot mix answer formats");
  });

  it("rejects a holdout answer changed after its hash was frozen", () => {
    expect(() =>
      discoverPostTestAnswers(
        {
          answerFormat: "structured-v1",
          cases: [{ caseId: "one::complete", itemId: "one", answer: structuredAnswer, answerSha256: "wrong" }]
        },
        1
      )
    ).toThrow("Answer SHA-256 does not match");
  });

  it("requires the exact four-item by three-variant frozen holdout", () => {
    const valid = holdoutPayload();
    expect(() => validateHoldoutManifest(valid, discoverPostTestAnswers(valid, 12))).not.toThrow();

    const missingHash = holdoutPayload();
    delete (missingHash.cases[0] as { answerSha256?: string }).answerSha256;
    expect(() => validateHoldoutManifest(missingHash, discoverPostTestAnswers(missingHash, 12))).toThrow(
      "requires a frozen SHA-256"
    );

    const unexpected = holdoutPayload();
    unexpected.cases[0].variant = "other";
    unexpected.cases[0].caseId = `${unexpected.cases[0].itemId}::other`;
    expect(() => validateHoldoutManifest(unexpected, discoverPostTestAnswers(unexpected, 12))).toThrow(
      "unexpected item/variant/caseId"
    );
  });
});

describe("post-test stability summary and gates", () => {
  it("passes the twelve-answer holdout thresholds at 24/24, 12/12 verdict, and 11/12 concepts", () => {
    const answerIds = Array.from({ length: 12 }, (_, index) => `case-${index + 1}`);
    const gradings = answerIds.flatMap((answerId) => [grading(answerId, 1), grading(answerId, 2)]);
    gradings.find((entry) => entry.answerId === "case-1" && entry.repeat === 2)!.matched = ["alpha"];

    const summary = summarizeStability(gradings, answerIds);
    const gate = evaluateStabilityGate(summary, {
      minimumVerdictAgreements: 12,
      minimumExactConceptAgreements: 11
    });

    expect(summary).toMatchObject({
      expectedGradings: 24,
      formatParsedAnswers: 12,
      judgeErrors: 0,
      verdictAgreements: 12,
      exactConceptAgreements: 11,
      invalidCreditedConcepts: 0
    });
    expect(gate).toMatchObject({ formatGate: true, evidenceGate: true, overallPass: true });
  });

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

  it("fails when a credited concept lacks host-validated evidence", () => {
    const answerIds = Array.from({ length: 12 }, (_, index) => `case-${index + 1}`);
    const gradings = answerIds.flatMap((answerId) => [grading(answerId, 1), grading(answerId, 2)]);
    gradings[0].concepts[0].evidenceValid = false;

    const gate = evaluateStabilityGate(summarizeStability(gradings, answerIds), {
      minimumVerdictAgreements: 12,
      minimumExactConceptAgreements: 11
    });

    expect(gate).toMatchObject({ evidenceGate: false, overallPass: false });
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

    expect(planPendingGradings(archived, completed)).toEqual([
      { answerId: "two", itemId: "two", answer: "second", repeat: 2 }
    ]);
  });

  it("rejects duplicate or unknown checkpoint keys", () => {
    const archived = [{ itemId: "one", answer: "first" }];
    expect(() =>
      planPendingGradings(archived, [
        { itemId: "one", repeat: 1 },
        { itemId: "one", repeat: 1 }
      ])
    ).toThrow("duplicate grading");
    expect(() => planPendingGradings(archived, [{ itemId: "other", repeat: 1 }])).toThrow("unknown answerId");
  });

  it("refuses to resume under a different protocol or judge configuration", () => {
    const context = {
      input: { sha256: "input" },
      repeats: 2,
      protocol: {
        fingerprint: "protocol",
        answerFormat: "structured-v1",
        judgeContractVersion: "evidence-v2",
        buildIdentity: { gitSha: "build", gitDirty: false }
      },
      config: { learnerBase: "https://judge.invalid", judgeModel: "judge" }
    };
    const result = {
      input: { sha256: "input" },
      repeats: 2,
      protocol: {
        fingerprint: "protocol",
        answerFormat: "structured-v1",
        judgeContractVersion: "evidence-v2",
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
    expect(() =>
      validateResume({ ...result, protocol: { ...result.protocol, judgeContractVersion: "legacy-v1" } }, context)
    ).toThrow("answer format or judge contract");
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
        judgeRetryPolicy: "test-policy",
        answerFormat: "structured-v1",
        judgeContractVersion: "evidence-v2"
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
