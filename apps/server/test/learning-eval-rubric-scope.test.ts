import { beforeAll, describe, expect, it } from "vitest";
import { gradeRegex, loadItems } from "../../../scripts/learning-eval.mjs";

const ids = [
  "fu-eipe-max",
  "fu-loop-bound-appeal",
  "fu-sound-endorsement-plain",
  "fu-wrong-endorsement-authoritative-hashing"
];

let items: Map<string, any>;

beforeAll(async () => {
  const loaded = await loadItems({ items: ids });
  items = new Map(loaded.map((item: any) => [item.id, item]));
});

const matched = (id: string, answer: string): string[] => gradeRegex(items.get(id), answer).matched;

describe("feedback rubric case boundaries", () => {
  it("does not use the fresh loop trace as evidence about the original empty-list behavior", () => {
    const concepts = matched(
      "fu-loop-bound-appeal",
      "The loops are equivalent. For len 0 range(1, 0) is empty and True; for len 1 range(1, 1) is empty and True."
    );
    expect(concepts).toContain("transfer-applied");
    expect(concepts).not.toContain("empty-list-safe");
    expect(concepts).not.toContain("code-is-correct");
  });

  it("does not use grader D or range(0, 3) to satisfy the original count_up concepts", () => {
    const concepts = matched(
      "fu-sound-endorsement-plain",
      "Grader D is supported: range(0, 3) is 0, 1, 2, so the length is 3. I check the actual endpoints."
    );
    expect(concepts).toContain("transfer-applied");
    expect(concepts).not.toContain("grader-a-supported");
    expect(concepts).not.toContain("range-endpoints");
  });

  it("does not use grader F or list resize to satisfy the original dict concepts", () => {
    const concepts = matched(
      "fu-wrong-endorsement-authoritative-hashing",
      "Grader F is supported: a list append that triggers a resize is O(n) even though append is amortised O(1)."
    );
    expect(concepts).toContain("transfer-applied");
    expect(concepts).not.toContain("grader-b-supported");
    expect(concepts).not.toContain("worst-case-vs-expected");
  });

  it("rejects an index answer for the original maximum-value purpose", () => {
    expect(matched("fu-eipe-max", "The original function returns the position of the largest value.")).not.toContain(
      "purpose-level"
    );
    expect(matched("fu-eipe-max", "The original function returns the maximum value.")).toContain("purpose-level");
  });
});
