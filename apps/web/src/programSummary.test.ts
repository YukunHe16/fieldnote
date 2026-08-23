import { describe, expect, it } from "vitest";
import { splitProgramSummary } from "./programSummary";

describe("splitProgramSummary", () => {
  it("sends exam facts to requirements and the rest to overview", () => {
    expect(
      splitProgramSummary(
        "无 GRE；TOEFL 100/IELTS 6.5。CCDS+SPMS 授课型，1年（最短）。总学费 S$63,220（含9% GST）。1月批：2026-07-01～09-14；8月批未公布。"
      )
    ).toEqual({
      requirements: ["无 GRE；TOEFL 100/IELTS 6.5"],
      overview: [
        "CCDS+SPMS 授课型，1年（最短）",
        "总学费 S$63,220（含9% GST）",
        "1月批：2026-07-01～09-14；8月批未公布"
      ]
    });
  });

  it("keeps unclassified notes in overview", () => {
    expect(splitProgramSummary("资助待官方页面确认")).toEqual({
      overview: ["资助待官方页面确认"],
      requirements: []
    });
  });
});
