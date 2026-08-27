import { describe, expect, it } from "vitest";
import {
  activityDetailFacts,
  activityHeadline,
  activityPills,
  activityPreviewText,
  activityStepDetail,
  activityStepTitle,
  clipActivityText,
  coalesceAdjacentTextBlocks,
  collapseExactRepeatedHalf,
  collectActivityUrls,
  durationLabel,
  friendlyIntegrationName,
  groupAssistantBlocks,
  hasCollaborationTrace,
  isTechnicalDump,
  isViewportPinnedToBottom,
  redactActivityInput,
  visibleCollaborationText,
  visibleMessageAttachments
} from "./components/Messages";

describe("activity presentation", () => {
  it("only exposes non-empty collaboration traces and redacts local paths", () => {
    expect(hasCollaborationTrace(null)).toBe(false);
    expect(
      hasCollaborationTrace({
        tasks: [],
        handoffs: [],
        summary: {
          specialistCount: 0,
          verifiedCount: 0,
          conflictingCount: 0,
          unresolvedCount: 0,
          sourceCount: 0,
          importantNotice: null
        }
      })
    ).toBe(false);
    expect(
      hasCollaborationTrace({
        tasks: [{ id: "task" } as never],
        handoffs: [],
        summary: {
          specialistCount: 1,
          verifiedCount: 0,
          conflictingCount: 0,
          unresolvedCount: 0,
          sourceCount: 0,
          importantNotice: null
        }
      })
    ).toBe(true);
    expect(visibleCollaborationText("已读取 /Users/name/private/file.pdf")).toBe("已读取 ~");
  });

  it("uses calm user-facing names while preserving kind fallbacks", () => {
    expect(friendlyIntegrationName("mcp__lark-calendar__events", "mcp")).toBe("飞书日历");
    expect(friendlyIntegrationName("unknown_delegate", "subagent")).toBe("协作任务");
    expect(friendlyIntegrationName("nightly_digest", "cron")).toBe("计划任务");
    expect(friendlyIntegrationName("WebSearch", "mcp")).toBe("网页搜索");
    expect(friendlyIntegrationName("WebFetch", "mcp")).toBe("网页读取");
  });

  it("hides duration while running and shows the completed elapsed time", () => {
    expect(
      durationLabel({
        id: "running",
        type: "mcp",
        status: "running",
        startedAt: "2026-08-19T10:00:00.000Z",
        children: []
      })
    ).toBe("");
    expect(
      durationLabel({
        id: "completed",
        type: "mcp",
        status: "completed",
        startedAt: "2026-08-19T10:00:00.000Z",
        completedAt: "2026-08-19T10:00:02.350Z",
        children: []
      })
    ).toBe("2.4 秒");
  });

  it("redacts secrets and limits technical parameter length", () => {
    expect(redactActivityInput({ api_key: "sk-secret-value", query: "hello" })).not.toContain("sk-secret-value");
    expect(redactActivityInput("token=abcdefghijklmnop")).toContain("••••••");
    expect(redactActivityInput("x".repeat(1_200)).length).toBeLessThan(1_000);
  });

  it("coalesces legacy token-sized text blocks without crossing an activity boundary", () => {
    const blocks = coalesceAdjacentTextBlocks([
      { id: "t1", type: "text", status: "completed", content: "Hi", children: [] },
      { id: "t2", type: "text", status: "completed", content: "! How", children: [] },
      { id: "a1", type: "mcp", status: "completed", children: [] },
      { id: "t3", type: "text", status: "completed", content: "This is", children: [] },
      { id: "t4", type: "text", status: "completed", content: " the result.", children: [] }
    ]);
    expect(blocks.map((block) => block.type)).toEqual(["text", "mcp", "text"]);
    expect(blocks[0]?.content).toBe("Hi! How");
    expect(blocks[2]?.content).toBe("This is the result.");
  });

  it("groups consecutive tool calls into one activity run", () => {
    const groups = groupAssistantBlocks([
      { id: "t1", type: "text", status: "completed", content: "先看这里", children: [] },
      {
        id: "a1",
        type: "mcp",
        status: "completed",
        technicalName: "WebSearch",
        children: []
      },
      {
        id: "a2",
        type: "mcp",
        status: "completed",
        technicalName: "WebSearch",
        children: []
      },
      { id: "t2", type: "text", status: "completed", content: "检索完成", children: [] }
    ]);
    expect(groups.map((group) => group.type)).toEqual(["text", "activity", "text"]);
    expect(groups[1]?.type === "activity" && groups[1].blocks).toHaveLength(2);
  });

  it("keeps later thinking folds separate from earlier text and tools", () => {
    const groups = groupAssistantBlocks([
      { id: "th1", type: "thinking", kind: "thinking", status: "completed", content: "先想一遍", children: [] },
      { id: "t1", type: "text", status: "completed", content: "先看这里", children: [] },
      { id: "th2", type: "thinking", kind: "thinking", status: "running", content: "再想一遍", children: [] }
    ]);
    expect(groups.map((group) => group.type)).toEqual(["thinking", "text", "thinking"]);
  });

  it("uses thinking-style copy instead of raw tool names", () => {
    expect(
      activityHeadline([
        {
          id: "s1",
          type: "mcp",
          status: "running",
          technicalName: "WebSearch",
          children: [],
          input: { query: "NUS MComp", urls: ["https://www.comp.nus.edu.sg", "https://www.ntu.edu.sg"] }
        }
      ])
    ).toBe("正在检索 2 个网页");
    expect(
      activityStepTitle({
        id: "w1",
        type: "activity",
        status: "completed",
        title: "工作区",
        technicalName: "Write",
        children: []
      })
    ).toBe("写入文件");
    expect(
      activityHeadline([
        {
          id: "w1",
          type: "activity",
          status: "running",
          title: "工作区",
          technicalName: "Read",
          children: []
        }
      ])
    ).toBe("读取文件");
    expect(
      activityHeadline([
        {
          id: "b3",
          type: "activity",
          status: "completed",
          technicalName: "Bash",
          startedAt: "2026-08-19T10:00:00.000Z",
          completedAt: "2026-08-19T10:00:19.000Z",
          children: []
        }
      ])
    ).toBe("运行命令 · 19秒");
    expect(
      activityPreviewText([
        {
          id: "s1",
          type: "mcp",
          status: "completed",
          technicalName: "WebSearch",
          children: [],
          input: {
            query: "NUS MSc AI recommendation letters official requirements",
            urls: ["https://www.comp.nus.edu.sg"]
          }
        }
      ])
    ).toEqual({
      brief: "NUS MSc AI recommendation le…",
      full: "NUS MSc AI recommendation letters official requirements"
    });
    expect(
      activityPreviewText([
        {
          id: "f1",
          type: "mcp",
          status: "completed",
          technicalName: "WebFetch",
          children: [],
          input: { url: "https://www.comp.nus.edu.sg/programmes/" }
        }
      ])
    ).toEqual({
      brief: "comp.nus.edu.sg",
      full: "comp.nus.edu.sg"
    });
    expect(clipActivityText("短标题")).toBe("短标题");
    expect(
      activityHeadline([
        {
          id: "b1",
          type: "activity",
          status: "failed",
          title: "运行命令",
          technicalName: "Bash",
          children: []
        }
      ])
    ).toBe("运行命令 · 未完成");
    expect(
      activityStepDetail({
        id: "b2",
        type: "activity",
        status: "failed",
        technicalName: "Bash",
        children: [],
        input: { command: "ls attachments/*.pdf" }
      })
    ).toBe("ls attachments/*.pdf");
    expect(
      visibleMessageAttachments({
        id: "m1",
        role: "assistant",
        content: "done",
        createdAt: "",
        attachments: [
          { id: "a1", name: "make_resume.py", presented: false },
          { id: "a2", name: "resume.pdf", presented: true }
        ]
      })
    ).toEqual([expect.objectContaining({ name: "resume.pdf" })]);
  });

  it("extracts host pills and hides tool JSON dumps", () => {
    expect(collectActivityUrls({ officialUrl: "https://www.comp.nus.edu.sg/programmes/" })).toEqual([
      "https://www.comp.nus.edu.sg/programmes/"
    ]);
    expect(isTechnicalDump('[{"type":"text","text":"{\\"id\\":\\"abc\\"}"}]')).toBe(true);
    expect(isTechnicalDump("周期已经建立。")).toBe(false);
  });

  it("turns tool parameters into quiet facts instead of raw JSON", () => {
    const block = {
      id: "s1",
      type: "mcp" as const,
      status: "completed" as const,
      technicalName: "WebSearch",
      input: { query: "vitest workspace configuration reference", domains: ["vitest.dev"] },
      children: []
    };
    expect(activityPills(block)).toEqual(["vitest.dev"]);
    expect(activityDetailFacts(block)).toEqual([]);
  });

  it("treats the viewport as pinned only when the user is near the bottom", () => {
    expect(isViewportPinnedToBottom({ scrollHeight: 1_200, scrollTop: 1_192, clientHeight: 40 })).toBe(true);
    expect(isViewportPinnedToBottom({ scrollHeight: 1_200, scrollTop: 1_140, clientHeight: 40 })).toBe(false);
    expect(isViewportPinnedToBottom({ scrollHeight: 1_200, scrollTop: 200, clientHeight: 400 })).toBe(false);
  });

  it("collapses text that was persisted twice in a row", () => {
    const once = "搜索结果里大多没有直接给出版本号，还有一两个链接失效了。我换成读取官方文档页再核实。";
    expect(collapseExactRepeatedHalf(once + once)).toBe(once);
    expect(collapseExactRepeatedHalf(once)).toBe(once);
  });
});
