import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRACTICE_NOVELTY_THRESHOLD,
  buildPracticeEvaluatorRequest,
  noveltyScore,
  parsePracticeEvaluatorVerdict,
  runPracticePipeline,
  verdictIsIncoherent,
  type PracticeDraft,
  type PracticeEvaluatorVerdict
} from "../src/practice-evaluator.js";

/**
 * Adversarial controls for the practice-item pipeline.
 *
 * In production the pipeline has never rejected anything: the LLM tier returned `pass` on
 * every check it produced and the deterministic gates fired zero times. An approval there
 * is therefore indistinguishable from a check that never ran. These fixtures are the
 * missing negative class — deliberately flawed drafts, each labelled with the gate that
 * should stop it, so the pipeline's ability to reject is demonstrated rather than assumed.
 *
 * Tiers 1 and 2 are deterministic and asserted here. Tier 3 needs a model and lives in
 * `scripts/practice-evaluator-controls.mjs`; the fixtures it uses are the ones labelled
 * `evaluator` or `none` below, which must survive both gates to reach it.
 */

interface ControlFixture {
  id: string;
  expectedGate: "programmatic" | "novelty" | "evaluator" | "none";
  why: string;
  goal?: string;
  hypothesis?: string;
  draft: PracticeDraft;
  corpus?: string[];
}

const controlsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../eval/practice-controls");
const fixtures = JSON.parse(
  fs.readFileSync(path.join(controlsDirectory, "deterministic.json"), "utf8")
) as ControlFixture[];

const approve = async (): Promise<PracticeEvaluatorVerdict> => ({
  status: "approved",
  checks: { correctness: "pass", fitToHypothesis: "pass", difficulty: "pass", novelty: "pass" },
  reasons: []
});

describe("practice-item adversarial controls", () => {
  it("ships fixtures with unique ids and both classes represented", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    expect(new Set(fixtures.map((item) => item.id)).size).toBe(fixtures.length);
    for (const fixture of fixtures) expect(fixture.why.trim().length).toBeGreaterThan(0);
    // Negatives alone measure recall and say nothing about false rejections.
    expect(fixtures.some((item) => item.expectedGate === "programmatic")).toBe(true);
    expect(fixtures.some((item) => item.expectedGate === "novelty")).toBe(true);
    expect(fixtures.some((item) => item.expectedGate === "none")).toBe(true);
  });

  // The pipeline result already carries `gate`, so each fixture scores itself.
  for (const fixture of fixtures) {
    it(`routes ${fixture.id} to the ${fixture.expectedGate} gate`, async () => {
      const result = await runPracticePipeline({
        draft: fixture.draft,
        corpus: fixture.corpus ?? [],
        evaluate: approve
      });
      if (fixture.expectedGate === "programmatic" || fixture.expectedGate === "novelty") {
        expect(result.status).toBe("rejected");
        expect(result.gate).toBe(fixture.expectedGate);
        expect(result.reasons.length).toBeGreaterThan(0);
      } else {
        // `evaluator` and `none` fixtures must survive both deterministic gates; which of
        // the two they land on is the model tier's call, measured by the script.
        expect(result.status).toBe("approved");
        expect(result.gate).toBe("none");
      }
    });
  }

  it("brackets the novelty threshold from both sides", () => {
    const scoreOf = (id: string) => {
      const fixture = fixtures.find((item) => item.id === id);
      if (!fixture) throw new Error(`missing fixture ${id}`);
      return noveltyScore(fixture.draft.taskText, fixture.corpus ?? []);
    };
    // A ladder, not a single point: the threshold was an unvalidated constant until
    // something sat on each side of it.
    expect(scoreOf("novelty-exact-copy")).toBe(1);
    expect(scoreOf("novelty-light-edit")).toBeGreaterThan(PRACTICE_NOVELTY_THRESHOLD);
    // A structural re-skin shares almost no wording, so lexical overlap cannot catch it —
    // this is precisely the case tier 2 is blind to and tier 3 exists for.
    expect(scoreOf("novelty-structural-reskin")).toBeLessThan(PRACTICE_NOVELTY_THRESHOLD);
    expect(scoreOf("positive-fresh-transfer")).toBeLessThan(PRACTICE_NOVELTY_THRESHOLD);
  });

  it("needs total containment at four answer tokens and lets three through", async () => {
    // The containment check is strictly greater than 0.75, so a four-token sketch has a
    // one-sided boundary: 4/4 rejects, 3/4 does not. Both sides are fixtures.
    const four = await runPracticePipeline({
      draft: fixtures.find((item) => item.id === "leak-boundary-four-of-four")!.draft,
      corpus: [],
      evaluate: approve
    });
    const three = await runPracticePipeline({
      draft: fixtures.find((item) => item.id === "leak-boundary-three-of-four")!.draft,
      corpus: [],
      evaluate: approve
    });
    expect(four).toMatchObject({ status: "rejected", gate: "programmatic" });
    expect(three).toMatchObject({ status: "approved" });
  });
});

describe("practice evaluator request and verdict", () => {
  it("builds the judge request with the corpus truncated the way production truncates it", () => {
    const corpus = Array.from({ length: 12 }, (_, index) => `task ${index} ${"x".repeat(600)}`);
    const request = buildPracticeEvaluatorRequest({
      draft: fixtures[0]!.draft,
      hypothesis: "h",
      goal: "g",
      corpus
    });
    const payload = JSON.parse(request.prompt) as { alreadySeenByLearner: string[] };
    // The judge sees only a window of the corpus; a fixture whose "already seen" text sits
    // outside it is unjudgeable, which is a property the control set has to know about.
    expect(payload.alreadySeenByLearner).toHaveLength(8);
    expect(payload.alreadySeenByLearner[0]).toMatch(/^task 4 /);
    for (const entry of payload.alreadySeenByLearner) expect(entry.length).toBeLessThanOrEqual(400);
  });

  it("decides on approved alone and records disagreeing checks rather than overriding them", () => {
    const incoherent = parsePracticeEvaluatorVerdict({
      approved: true,
      checks: { correctness: "fail", fitToHypothesis: "pass", difficulty: "pass", novelty: "pass" },
      reasons: []
    });
    expect(incoherent.status).toBe("approved");
    expect(verdictIsIncoherent(incoherent)).toBe(true);

    const clean = parsePracticeEvaluatorVerdict({
      approved: true,
      checks: { correctness: "pass", fitToHypothesis: "pass", difficulty: "pass", novelty: "pass" },
      reasons: []
    });
    expect(verdictIsIncoherent(clean)).toBe(false);
  });

  it("maps a missing or malformed verdict to an error so the pipeline fails open", () => {
    expect(parsePracticeEvaluatorVerdict(null).status).toBe("error");
    expect(parsePracticeEvaluatorVerdict({ checks: {}, reasons: [] }).status).toBe("error");
    expect(parsePracticeEvaluatorVerdict({ approved: "yes" }).status).toBe("error");
  });

  it("coerces unknown check values to unsure and never leaves a rejection unexplained", () => {
    const verdict = parsePracticeEvaluatorVerdict({
      approved: false,
      checks: { correctness: "nope", fitToHypothesis: "fail", difficulty: null, novelty: "pass" },
      reasons: []
    });
    expect(verdict).toMatchObject({ status: "rejected" });
    if (verdict.status === "error") throw new Error("expected a rejection");
    expect(verdict.checks.correctness).toBe("unsure");
    expect(verdict.checks.difficulty).toBe("unsure");
    expect(verdict.checks.fitToHypothesis).toBe("fail");
    expect(verdict.reasons).toHaveLength(1);
  });
});
