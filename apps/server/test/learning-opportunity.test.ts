import { describe, expect, it } from "vitest";
import { detectLearningOpportunity } from "../src/learning-opportunity.js";

describe("detectLearningOpportunity", () => {
  it("suggests learning mode for an explicit understanding difficulty", () => {
    const result = detectLearningOpportunity([
      { role: "assistant", content: "递归会调用自身。" },
      { role: "user", content: "我还是没理解递归为什么需要出口，换种讲法教我。" }
    ]);
    expect(result).toMatchObject({ confidence: 0.82, reason: expect.stringContaining("理解困难") });
    expect(result?.goal).toContain("递归");
    expect(detectLearningOpportunity([{ role: "user", content: "不懂" }])?.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it("suggests after two consecutive clear education-intent user turns", () => {
    const result = detectLearningOpportunity([
      { role: "user", content: "我想学习二分查找的原理。" },
      { role: "assistant", content: "可以先从不变量开始。" },
      { role: "user", content: "我还想学习它的循环不变量。" }
    ]);
    expect(result).toMatchObject({ confidence: 0.76, reason: expect.stringContaining("连续") });
    expect(result?.goal).toContain("循环不变量");
  });

  it("does not treat writing, research, translation, or administrative work as learning incidents", () => {
    for (const content of [
      "帮我写一封研究联系邮件",
      "研究一下 UIUC 的申请要求",
      "翻译这段课程介绍",
      "帮我安排下周的面试预约"
    ]) {
      expect(detectLearningOpportunity([{ role: "user", content }])).toBeNull();
    }
  });

  it("does not suggest for short chat or a single weak learning signal", () => {
    expect(detectLearningOpportunity([{ role: "user", content: "你好" }])).toBeNull();
    expect(detectLearningOpportunity([{ role: "user", content: "我想了解一下机器学习。" }])).toBeNull();
  });

  it("only considers the most recent six visible messages", () => {
    const result = detectLearningOpportunity([
      { role: "user", content: "我完全不懂递归，教我。" },
      { role: "assistant", content: "我们先看一个例子。" },
      { role: "user", content: "好的" },
      { role: "assistant", content: "继续。" },
      { role: "user", content: "谢谢" },
      { role: "assistant", content: "不客气。" },
      { role: "user", content: "再见" },
      { role: "assistant", content: "再见。" }
    ]);
    expect(result).toBeNull();
  });
});
