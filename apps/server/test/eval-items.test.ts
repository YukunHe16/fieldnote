import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural checks on the offline evaluation's item bank.
 *
 * These items are the eval's ground truth, so a typo here does not fail loudly — it
 * silently mis-scores every run that touches the item. The eval harness is a script that
 * only runs on demand against a live model; this file is what keeps the bank honest in CI.
 */

const ITEM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../eval/learning-items");

interface Concept {
  id: string;
  label: string;
  credit?: string;
  patterns: string[];
}

interface GroundTruth {
  wrongGrader?: string;
  focalGrader?: string;
  temptingIsWrong?: boolean;
  valence?: "endorses" | "rejects";
  tone?: "plain" | "authoritative";
  acceptanceConcept?: string;
  note?: string;
}

interface EvalItem {
  id: string;
  difficultyType: string;
  topicKey: string;
  title: string;
  opening: string;
  persona: { beliefs: string[]; style: string; unlockConcepts: string[] };
  stubbornPersona?: { beliefs: string[]; consolidationRules: string[] };
  concepts: Concept[];
  postTest: string;
  groundTruth?: GroundTruth | string;
}

const items: EvalItem[] = fs
  .readdirSync(ITEM_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .flatMap((name) => JSON.parse(fs.readFileSync(path.join(ITEM_DIR, name), "utf8")) as EvalItem[]);

const feedbackItems = items.filter((item) => item.difficultyType === "feedback_uncertainty");

describe("learning eval item bank", () => {
  it("pins the published family sizes so code and study docs change together", () => {
    const familySizes = Object.fromEntries(
      [...new Set(items.map((item) => item.difficultyType))]
        .sort()
        .map((family) => [family, items.filter((item) => item.difficultyType === family).length])
    );
    expect(familySizes).toEqual({
      conceptual_misconception: 6,
      feedback_uncertainty: 19,
      planning_gap: 6
    });
  });

  it("loads every item with unique ids and compilable patterns", () => {
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) {
      for (const field of ["difficultyType", "topicKey", "title", "opening", "postTest"] as const) {
        expect(item[field], `${item.id}.${field}`).toBeTruthy();
      }
      expect(item.concepts.length, `${item.id} concepts`).toBeGreaterThan(0);
      for (const concept of item.concepts) {
        expect(concept.patterns.length, `${item.id}/${concept.id}`).toBeGreaterThan(0);
        // The harness compiles these at load; an invalid pattern would abort a run that
        // may already have cost an hour of model time.
        for (const pattern of concept.patterns) expect(() => new RegExp(pattern, "i")).not.toThrow();
      }
      expect(new Set(item.concepts.map((concept) => concept.id)).size).toBe(item.concepts.length);
    }
  });

  it("points every persona's unlockConcepts at concepts the item actually defines", () => {
    for (const item of items) {
      const ids = new Set(item.concepts.map((concept) => concept.id));
      for (const unlock of item.persona.unlockConcepts) {
        expect(ids.has(unlock), `${item.id}: unlockConcepts names "${unlock}"`).toBe(true);
      }
    }
  });

  it("gives every feedback-uncertainty item a structured ground truth", () => {
    // The free-text form still loads, but it cannot answer the question this family exists
    // for — whether the learner went along with feedback that was wrong.
    for (const item of feedbackItems) {
      const truth = item.groundTruth;
      expect(typeof truth, `${item.id} groundTruth`).toBe("object");
      const structured = truth as GroundTruth;
      expect(structured.valence, item.id).toMatch(/^(endorses|rejects)$/);
      expect(structured.tone, item.id).toMatch(/^(plain|authoritative)$/);
      expect(typeof structured.temptingIsWrong, item.id).toBe("boolean");
      expect(structured.note, `${item.id} needs a note saying which grader is right and why`).toBeTruthy();
      // A typo here would score every run as acceptance without failing anything.
      const ids = new Set(item.concepts.map((concept) => concept.id));
      expect(ids.has(structured.acceptanceConcept ?? ""), `${item.id}: acceptanceConcept`).toBe(true);
    }
  });

  it("keeps temptingIsWrong in step with which grader the cell describes", () => {
    // This is the invariant that a mislabelled item breaks silently. `focalGrader` names the
    // feedback the cell is about; `temptingIsWrong` says whether that feedback is the wrong
    // one. Get them out of step and the item lands in the opposite half of the factorial —
    // a credulity probe counted as a control, which is exactly the confound the controls
    // exist to remove. Two items were filed that way before this check existed.
    for (const item of feedbackItems) {
      const truth = item.groundTruth as GroundTruth;
      expect(truth.focalGrader, `${item.id} focalGrader`).toBeTruthy();
      const focalIsWrong = truth.wrongGrader === "both" || truth.wrongGrader === truth.focalGrader;
      expect(
        truth.temptingIsWrong,
        `${item.id}: wrongGrader=${truth.wrongGrader} focalGrader=${truth.focalGrader}`
      ).toBe(focalIsWrong);
    }
  });

  it("covers every cell of the feedback factorial, controls included", () => {
    const cell = (item: EvalItem) => {
      const truth = item.groundTruth as GroundTruth;
      return `${truth.temptingIsWrong ? "wrong" : "sound"}-${truth.valence}-${truth.tone}`;
    };
    const counts = new Map<string, number>();
    for (const item of feedbackItems) counts.set(cell(item), (counts.get(cell(item)) ?? 0) + 1);
    for (const wrong of ["wrong", "sound"]) {
      for (const valence of ["endorses", "rejects"]) {
        for (const tone of ["plain", "authoritative"]) {
          expect(
            counts.get(`${wrong}-${valence}-${tone}`) ?? 0,
            `cell ${wrong}-${valence}-${tone} is empty`
          ).toBeGreaterThan(0);
        }
      }
    }
    // The `sound-*` half is the control: without items whose tempting feedback is CORRECT,
    // an acceptance rate cannot separate a credulous learner from one who rejects
    // everything. Losing that half would not fail any other test.
    const sound = feedbackItems.filter((item) => (item.groundTruth as GroundTruth).temptingIsWrong === false);
    expect(sound.length, "the control half of the factorial").toBeGreaterThanOrEqual(4);
  });

  it("keeps the newer feedback items single-belief so a dropped belief cannot confound the diagnosis", () => {
    // The six original items each script two beliefs — one about the subject matter and one
    // about whom to trust — and the tutor reliably diagnoses one and drops the other, which
    // is why this family scores lowest. The newer items script only the trust belief; the
    // learner's opening answer is a fact of the scenario, not a position they defend. The
    // split is deliberate, so the two groups can be compared rather than blended.
    const dual = feedbackItems.filter((item) => item.persona.beliefs.length > 1);
    const single = feedbackItems.filter((item) => item.persona.beliefs.length === 1);
    expect(dual.length).toBe(6);
    expect(single.length).toBe(13);
    for (const item of feedbackItems) {
      expect(item.persona.beliefs.length, `${item.id} beliefs`).toBeGreaterThan(0);
      if (item.stubbornPersona)
        expect(item.stubbornPersona.beliefs.length, `${item.id} stubborn beliefs`).toBe(item.persona.beliefs.length);
    }
  });

  it("ends every item with a transfer case the exit check can grade", () => {
    for (const item of items) {
      // Every item's post-test carries a fresh case, and `transfer-applied` is how coverage
      // distinguishes understanding from restating the worked example.
      expect(
        item.concepts.some((concept) => concept.id === "transfer-applied"),
        `${item.id}`
      ).toBe(true);
      expect(item.postTest.length, `${item.id} postTest`).toBeGreaterThan(120);
    }
  });
});
