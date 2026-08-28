import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateCacheStabilityGate,
  planGradings,
  summarizeCacheStability,
  validateCompletedCacheStability,
  validateCasesPayload
} from "../../../scripts/cache-bank-stability.mjs";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const structuredAnswer = [
  "ORIGINAL_CONCLUSION:",
  "The primary result is correct.",
  "ORIGINAL_EVIDENCE:",
  "The primary calculation supports it.",
  "GENERAL_METHOD:",
  "Recompute every cache state deterministically.",
  "TRANSFER_CONCLUSION:",
  "The transfer result is correct.",
  "TRANSFER_EVIDENCE:",
  "The transfer calculation supports it."
].join("\n");

function fixture() {
  const items = Array.from({ length: 24 }, (_, index) => {
    const set = Math.floor(index / 4) + 1;
    const variant = (index % 4) + 1;
    return {
      id: `cache-set-${set}-v${variant}`,
      opening: `Primary scenario ${set}/${variant}`,
      postTest: `Solve primary and transfer ${set}/${variant}`,
      machineVerified: true,
      concepts: [
        { id: "conclusion", label: "states the primary conclusion", credit: "Must state it explicitly." },
        { id: "evidence", label: "shows the primary calculation", credit: "Must show the calculation." },
        { id: "method", label: "states the general method", credit: "Must state a reusable method." },
        { id: "transfer-applied", label: "solves the transfer", credit: "Must solve the fresh case." }
      ]
    };
  });
  const cases = items.flatMap((item, index) => {
    const setId = `set-${Math.floor(index / 4) + 1}`;
    const variant = (index % 4) + 1;
    return [
      {
        caseId: `${item.id}::complete`,
        itemId: item.id,
        setId,
        variant,
        answerVariant: "complete",
        omittedConceptId: null,
        answer: structuredAnswer,
        answerSha256: sha256(structuredAnswer),
        machineVerified: true,
        expected: {
          verdict: "resolved",
          conceptIds: ["conclusion", "evidence", "method", "transfer-applied"]
        }
      },
      {
        caseId: `${item.id}::omission::method`,
        itemId: item.id,
        setId,
        variant,
        answerVariant: "omission",
        omittedConceptId: "method",
        answer: structuredAnswer,
        answerSha256: sha256(structuredAnswer),
        machineVerified: true,
        expected: {
          verdict: "partial",
          conceptIds: ["conclusion", "evidence", "transfer-applied"]
        }
      }
    ];
  });
  return {
    schemaVersion: "cache-bank-posttest-cases/v1",
    bank: {
      version: "cache-v1",
      contentSha256: "a".repeat(64),
      fileSha256: "b".repeat(64),
      path: "private/bank.json",
      manifestPath: "private/manifest.json",
      manifestFileSha256: "c".repeat(64)
    },
    answerFormat: "structured-v1",
    judgeContractVersion: "evidence-v2",
    items,
    cases
  };
}

function successfulGradings(payload: ReturnType<typeof fixture>) {
  return payload.cases.flatMap((entry) =>
    [1, 2].map((repeat) => ({
      caseId: entry.caseId,
      itemId: entry.itemId,
      repeat,
      formatParsed: true,
      judgeResponseModelVerified: true,
      judgeAttempts: [{ outcome: "success", responseModel: "judge-fixed" }],
      error: null,
      verdict: entry.expected.verdict,
      matched: entry.expected.conceptIds,
      concepts: entry.expected.conceptIds.map((id) => ({
        id,
        judgeDemonstrated: true,
        demonstrated: true,
        evidenceValid: true
      }))
    }))
  );
}

describe("Cache bank B-gate input", () => {
  it("requires exactly six sets, four variants, two canonical answers, and structured-v1", () => {
    const payload = fixture();
    const parsed = validateCasesPayload(payload);

    expect(parsed.items).toHaveLength(24);
    expect(parsed.cases).toHaveLength(48);
    expect(parsed.cases.every((entry: { machineVerified: boolean }) => entry.machineVerified)).toBe(true);
  });

  it("fails before model calls on a forged answer hash, malformed five-column answer, or unverified item", () => {
    const badHash = fixture();
    badHash.cases[0].answerSha256 = "0".repeat(64);
    expect(() => validateCasesPayload(badHash)).toThrow(/SHA-256 mismatch/);

    const badFormat = fixture();
    badFormat.cases[0].answer = "free form";
    badFormat.cases[0].answerSha256 = sha256("free form");
    expect(() => validateCasesPayload(badFormat)).toThrow(/structured-v1/);

    const unverified = fixture();
    unverified.items[0].machineVerified = false;
    expect(() => validateCasesPayload(unverified)).toThrow(/not machine-verified/);
  });

  it("plans exactly 96 calls and resumes by case/repeat without duplication", () => {
    const cases = validateCasesPayload(fixture()).cases;
    const all = planGradings(cases);
    expect(all).toHaveLength(96);
    expect(planGradings(cases, [all[0]])).toHaveLength(95);
    expect(() => planGradings(cases, [all[0], all[0]])).toThrow(/repeats/);
  });
});

describe("Cache bank B-gate aggregation", () => {
  it("passes only the fixed 0/96, 48/48, 46/48, 46/48 and evidence thresholds", () => {
    const payload = fixture();
    const cases = validateCasesPayload(payload).cases;
    const summary = summarizeCacheStability(successfulGradings(payload), cases);
    const gate = evaluateCacheStabilityGate(summary);

    expect(summary).toMatchObject({
      judgeErrors: 0,
      verdictAgreements: 48,
      exactConceptAgreements: 48,
      expectedConceptMatches: 48,
      invalidCreditClaims: 0
    });
    expect(gate.overallPass).toBe(true);
  });

  it("distinguishes stable-but-wrong concepts from instability", () => {
    const payload = fixture();
    const cases = validateCasesPayload(payload).cases;
    const gradings = successfulGradings(payload);
    gradings[0].matched = ["conclusion"];
    gradings[1].matched = ["conclusion"];
    const summary = summarizeCacheStability(gradings, cases);

    expect(summary.exactConceptAgreements).toBe(48);
    expect(summary.expectedConceptMatches).toBe(47);
    expect(evaluateCacheStabilityGate(summary).overallPass).toBe(true);

    for (let caseIndex = 1; caseIndex <= 2; caseIndex += 1) {
      gradings[caseIndex * 2].matched = ["conclusion"];
      gradings[caseIndex * 2 + 1].matched = ["conclusion"];
    }
    expect(evaluateCacheStabilityGate(summarizeCacheStability(gradings, cases)).overallPass).toBe(false);
  });

  it("fails when a judge tried to award credit with an invalid quote even if the host downgraded it", () => {
    const payload = fixture();
    const cases = validateCasesPayload(payload).cases;
    const gradings = successfulGradings(payload);
    gradings[0].concepts[0] = {
      id: "conclusion",
      judgeDemonstrated: true,
      demonstrated: false,
      evidenceValid: false
    };
    const summary = summarizeCacheStability(gradings, cases);

    expect(summary.invalidCreditClaims).toBe(1);
    expect(evaluateCacheStabilityGate(summary).evidence).toBe(false);
  });

  it("fails when any successful grading lacks verified effective-model identity", () => {
    const payload = fixture();
    const cases = validateCasesPayload(payload).cases;
    const gradings = successfulGradings(payload);
    gradings[0].judgeResponseModelVerified = false;

    const summary = summarizeCacheStability(gradings, cases);
    expect(summary.modelVerifiedGradings).toBe(95);
    expect(evaluateCacheStabilityGate(summary).errors).toBe(false);
  });

  it("recomputes the publication gate from all 96 unique grading records", () => {
    const payload = fixture();
    const cases = validateCasesPayload(payload).cases;
    const gradings = successfulGradings(payload);
    const summary = summarizeCacheStability(gradings, cases);
    const gate = evaluateCacheStabilityGate(summary);
    const result = {
      schemaVersion: "cache-bank-stability-results/v1",
      config: { judgeModel: "judge-fixed" },
      gradings,
      summary,
      gate
    };

    expect(validateCompletedCacheStability(result, payload).gate.overallPass).toBe(true);
    expect(() =>
      validateCompletedCacheStability({ ...result, gradings: gradings.slice(1), gate: { overallPass: true } }, payload)
    ).toThrow(/missing|stored/);
  });
});
