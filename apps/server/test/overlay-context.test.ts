import { describe, expect, it } from "vitest";
import { evolvedSkillDescription } from "../src/evolved-overlay.js";
import {
  countMatchedPlaybooks,
  playbookMatchesUsedSkills,
  selectRelevantPlaybooks,
  skillLabelsFromBlocks,
  subagentLabelsFromBlocks
} from "../src/overlay-context.js";

describe("overlay routing helpers", () => {
  it("selects two to four playbooks that overlap the prompt, including Chinese cues", () => {
    const playbooks = [
      { title: "先核官方截止日期", instruction: "写进材料前先核官方截止日期" },
      { title: "文书先列提纲", instruction: "SOP 先列提纲再写长稿" },
      { title: "套磁先核任职", instruction: "套磁前确认官方任职页" },
      { title: "简历只写已确认事实", instruction: "CV 不编造成果" },
      { title: "无关提醒", instruction: "每天喝水" },
      { title: "另一条无关", instruction: "保持桌面整洁" }
    ];
    const chosen = selectRelevantPlaybooks(playbooks, "帮我核一下这个项目的截止日期和学费", 4);
    expect(chosen.length).toBeGreaterThanOrEqual(2);
    expect(chosen.length).toBeLessThanOrEqual(4);
    expect(chosen[0]?.title).toBe("先核官方截止日期");
    expect(chosen.some((item) => item.title === "无关提醒")).toBe(false);
    expect(countMatchedPlaybooks(playbooks, "你好")).toBe(0);
    expect(countMatchedPlaybooks(playbooks, "帮我核一下这个项目的截止日期和学费")).toBeGreaterThan(0);
  });

  it("reads used skill labels from activity blocks", () => {
    expect(
      skillLabelsFromBlocks([
        { activity: { kind: "skill", displayName: "Skills · 项目调研" } },
        { type: "skill", title: "Skills · 文书写作", children: [] },
        { activity: { kind: "mcp", displayName: "网页搜索" } }
      ])
    ).toEqual(["项目调研", "文书写作"]);
    expect(
      subagentLabelsFromBlocks([
        { activity: { kind: "subagent", displayName: "项目研究员" } },
        { activity: { kind: "skill", displayName: "项目调研" } }
      ])
    ).toEqual(["项目研究员"]);
  });

  it("confirms a playbook only when it matches skills used this turn", () => {
    const research = { title: "先核官方", instruction: "截止日期先核官方页面再写进材料" };
    const writing = { title: "文书提纲", instruction: "SOP 先列提纲" };
    expect(playbookMatchesUsedSkills(research, ["项目调研"])).toBe(true);
    expect(playbookMatchesUsedSkills(writing, ["项目调研"])).toBe(false);
    expect(playbookMatchesUsedSkills(research, [])).toBe(false);
  });

  it("builds an evolved skill description from playbook steps", () => {
    const description = evolvedSkillDescription(["1. 先核官方页面再写进材料", "2. 截止日期以官网为准"]);
    expect(description).toContain("先核官方页面再写进材料");
    expect(description).toContain("截止日期以官网为准");
    expect(description).not.toBe("按用户确认过的个人工作方法处理同类请求。");
  });
});
