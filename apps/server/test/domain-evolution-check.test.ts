import { describe, expect, it } from "vitest";
import { evaluateArtifactDomain, runShadowCheck } from "../src/domain-evolution-check.js";

describe("domain evolution check", () => {
  it("blocks an empty personal method, a resume skill without safety rules, and a one-step skill", () => {
    expect(
      evaluateArtifactDomain({
        kind: "skill",
        slug: "evolved-personal-method",
        name: "个人工作方法",
        description: "按确认过的流程做事",
        body: "按用户刚才确认的流程重复同样的工作方法。\n1. 先看\n2. 再写"
      }).ok
    ).toBe(false);

    expect(
      evaluateArtifactDomain({
        kind: "skill",
        slug: "resume-pdf",
        name: "简历改写",
        description: "改简历并导出 pdf",
        body: "1. 改摘要\n2. 导出 pdf"
      }).ok
    ).toBe(false);

    expect(
      evaluateArtifactDomain({
        kind: "skill",
        slug: "resume-pdf",
        name: "简历改写",
        description: "改简历并导出 pdf",
        body: "1. 不编造经历\n2. 导出 pdf 后 present_files"
      }).ok
    ).toBe(true);

    expect(
      evaluateArtifactDomain({
        kind: "skill",
        slug: "one-step-method",
        name: "一步流程",
        description: "只有一步的做法",
        body: "1. 直接给结论"
      }).ok
    ).toBe(false);

    expect(
      evaluateArtifactDomain({
        kind: "skill",
        slug: "two-step-method",
        name: "两步流程",
        description: "先看材料再写结论",
        body: "1. 先看材料\n2. 再写结论"
      }).ok
    ).toBe(true);
  });

  it("attaches a matching snapshot as the shadow replay target", () => {
    const result = runShadowCheck(
      {
        kind: "skill",
        slug: "resume-pdf",
        name: "简历改写",
        description: "改简历并导出 pdf",
        body: "1. 不编造经历\n2. 导出 pdf 后 present_files"
      },
      { runId: "run-resume", prompt: "把简历改成一页 PDF" }
    );
    expect(result.ok).toBe(true);
    expect(result.replayRunId).toBe("run-resume");
  });

  it("matches a natural Chinese request by meaningful n-gram overlap", () => {
    const result = runShadowCheck(
      {
        kind: "skill",
        slug: "resume-pdf",
        name: "学术简历压缩",
        description: "把学术简历压缩为一页并交付 pdf",
        body: "1. 不编造经历并保留事实\n2. 压缩到一页后导出 pdf 并 present_files"
      },
      { runId: "run-resume-long", prompt: "请帮我重新修改这份学术简历，控制在一页" }
    );
    expect(result.replayRunId).toBe("run-resume-long");
  });

  it("does not attach replayRunId when the snapshot prompt does not match", () => {
    const result = runShadowCheck(
      {
        kind: "skill",
        slug: "resume-pdf",
        name: "简历改写",
        description: "改简历并导出 pdf",
        body: "1. 不编造经历\n2. 导出 pdf 后 present_files"
      },
      { runId: "run-tuition", prompt: "比较两个项目的学费" }
    );
    expect(result.replayRunId).toBeNull();
  });
});
