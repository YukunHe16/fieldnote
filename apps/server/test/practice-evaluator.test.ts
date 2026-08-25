import { describe, expect, it } from "vitest";
import {
  noveltyScore,
  overlapTokens,
  programmaticPracticeGate,
  runPracticePipeline,
  type PracticeEvaluatorVerdict
} from "../src/practice-evaluator.js";

const draft = (overrides: Partial<Parameters<typeof programmaticPracticeGate>[0]> = {}) => ({
  taskText: "一个 2 路组相联缓存，访问序列 0,4,8,0：请判断每次访问的结果并说明理由。",
  targetHypothesis: "学习者认为发生替换的未命中都是容量未命中",
  expectedAnswerSketch: "最后一次访问 0 是冲突未命中，因为其他组还有空位",
  difficulty: 3,
  ...overrides
});

const approve = async (): Promise<PracticeEvaluatorVerdict> => ({
  status: "approved",
  checks: { correctness: "pass", fitToHypothesis: "pass", difficulty: "pass", novelty: "pass" },
  reasons: []
});

describe("practice evaluator", () => {
  it("tokenizes both scripts: latin words and CJK character bigrams overlap meaningfully", () => {
    const tokens = overlapTokens("conflict miss 冲突未命中");
    expect(tokens.has("conflict")).toBe(true);
    expect(tokens.has("冲突")).toBe(true);
    expect(tokens.has("未命")).toBe(true);
    expect(noveltyScore("冲突未命中的判断", ["冲突未命中的判断"])).toBe(1);
    expect(noveltyScore("完全无关的另一个话题", ["conflict miss classification"])).toBe(0);
  });

  it("hard-rejects answer leakage deterministically", () => {
    const leaked = draft({
      taskText: "请判断:最后一次访问 0 是冲突未命中，因为其他组还有空位。这是为什么?",
      expectedAnswerSketch: "最后一次访问 0 是冲突未命中，因为其他组还有空位"
    });
    const reasons = programmaticPracticeGate(leaked);
    expect(reasons.some((reason) => reason.includes("answer"))).toBe(true);
    expect(programmaticPracticeGate(draft())).toEqual([]);
  });

  it("catches leaks in both scripts and reordered wording, but not bare terms", () => {
    // A short CJK answer carries as much as a long latin one: the character-weighted guard
    // must not exempt it from the leak checks.
    const shortCjk = draft({
      taskText: "下面这次访问的答案是冲突未命中，请说明为什么会这样。",
      expectedAnswerSketch: "冲突未命中"
    });
    expect(programmaticPracticeGate(shortCjk).some((reason) => reason.includes("answer"))).toBe(true);
    // Reordering defeats the substring check; containment of the answer's tokens in the
    // task still catches it.
    const reordered = draft({
      taskText:
        "Why does the last access to 0 miss? Note the other set still has a free line, and it is a conflict miss.",
      expectedAnswerSketch: "it is a conflict miss because the other set still has a free line"
    });
    expect(programmaticPracticeGate(reordered).some((reason) => reason.includes("answer"))).toBe(true);
    // A bare term legitimately appears in the task that asks about it.
    const term = draft({
      taskText: "访问 1,5,1 时，第二次访问 1 是否命中？说明理由。",
      expectedAnswerSketch: "命中"
    });
    expect(programmaticPracticeGate(term)).toEqual([]);
  });

  it("rejects near-duplicates of the session corpus at the novelty gate", async () => {
    const seen = "一个 2 路组相联缓存，访问序列 0,4,8,0：请判断每次访问的结果并说明理由。";
    const result = await runPracticePipeline({ draft: draft(), corpus: [seen], evaluate: approve });
    expect(result).toMatchObject({ status: "rejected", gate: "novelty" });
    expect(result.noveltyScore).toBeGreaterThan(0.6);
    const fresh = await runPracticePipeline({
      draft: draft({ taskText: "换一个情境：直接映射缓存里访问 1,5,1，命中情况如何？说明每一步。" }),
      corpus: [seen],
      evaluate: approve
    });
    expect(fresh.status).toBe("approved");
  });

  it("counts an evaluator rejection but fails open on evaluator errors", async () => {
    const rejected = await runPracticePipeline({
      draft: draft(),
      corpus: [],
      evaluate: async () => ({
        status: "rejected",
        checks: { correctness: "pass", fitToHypothesis: "fail", difficulty: "pass", novelty: "pass" },
        reasons: ["仍持有误解的学习者也能答对这道题"]
      })
    });
    expect(rejected).toMatchObject({ status: "rejected", gate: "evaluator" });
    expect(rejected.reasons[0]).toContain("误解");

    const throwing = await runPracticePipeline({
      draft: draft(),
      corpus: [],
      evaluate: async () => {
        throw new Error("model timeout");
      }
    });
    expect(throwing.status).toBe("approved");
    expect(throwing.verdict).toMatchObject({ status: "error" });

    const errorVerdict = await runPracticePipeline({
      draft: draft(),
      corpus: [],
      evaluate: async () => ({ status: "error", reasons: ["no verdict"] })
    });
    expect(errorVerdict.status).toBe("approved");
  });

  it("keeps the deterministic gates hard even when the evaluator would approve", async () => {
    const result = await runPracticePipeline({
      draft: draft({ difficulty: 9 }),
      corpus: [],
      evaluate: approve
    });
    expect(result).toMatchObject({ status: "rejected", gate: "programmatic" });
  });
});
