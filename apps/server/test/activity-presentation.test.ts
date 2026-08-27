import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activityPresentation,
  collectWorkspaceFileCandidates,
  describeCreatedWorkspaceFile,
  extractAssistantThinking,
  extractCreatedFilePath,
  extractThinkingDelta,
  isThinkingBlockStart,
  meaningfulToolInput,
  promptWithAttachedFiles,
  workspaceRelativePath
} from "../src/runtime.js";

describe("activityPresentation", () => {
  it("distinguishes web tools from local workspace tools", () => {
    expect(activityPresentation("WebSearch", { query: "NUS AI" })).toEqual({
      activityKind: "mcp",
      displayName: "网页搜索"
    });
    expect(activityPresentation("WebFetch", { url: "https://example.edu" })).toEqual({
      activityKind: "mcp",
      displayName: "网页读取"
    });
    expect(activityPresentation("Read", {})).toEqual({ activityKind: "workspace", displayName: "读取文件" });
    expect(activityPresentation("mcp__workspace_files__present_files", {})).toEqual({
      activityKind: "workspace",
      displayName: "分享文件"
    });
    expect(activityPresentation("Write", {})).toEqual({ activityKind: "workspace", displayName: "写入文件" });
    expect(activityPresentation("Grep", {})).toEqual({ activityKind: "workspace", displayName: "搜索文件内容" });
  });

  it("uses friendly labels for skills, MCP services, and delegates", () => {
    expect(activityPresentation("Skill", { skill: "pdf" }).displayName).toBe("Skills · PDF");
    expect(activityPresentation("Skill", { skill: "docx" }).displayName).toBe("Skills · Word");
    expect(activityPresentation("Skill", { skill: "xlsx" }).displayName).toBe("Skills · Excel");
    expect(activityPresentation("Skill", { skill: "pdf-creator" }).displayName).toBe("Skills · Markdown 转 PDF");
    expect(activityPresentation("Skill", { skill: "doc-to-markdown" }).displayName).toBe("Skills · 文档转 Markdown");
    expect(activityPresentation("Skill", { skill: "docx-creator" }).displayName).toBe("Skills · Word 排版");
    expect(activityPresentation("Skill", { skill: "humanizer-zh" }).displayName).toBe("Skills · 去 AI 痕迹");
    // A skill with no dedicated label still reads as a skill rather than leaking its raw id.
    expect(activityPresentation("Skill", { skill: "some-evolved-skill" })).toEqual({
      activityKind: "skill",
      displayName: "Skills"
    });
    expect(activityPresentation("mcp__evolution__propose_evolved_capability", {}).displayName).toBe("提交待审能力");
    expect(activityPresentation("mcp__academic_research__search", {}).displayName).toBe("连接服务");
  });

  it("presents every delegation tool as one collaborator, including the legacy prefix", () => {
    expect(activityPresentation("mcp__managed_delegation__delegate_researcher", {})).toEqual({
      activityKind: "subagent",
      displayName: "协作助手"
    });
    // `admissions_delegation` was the pre-rename server name and is still persisted in historical
    // `tool_events` rows, so it must keep resolving to the same collaborator presentation.
    expect(activityPresentation("mcp__admissions_delegation__delegate_researcher", {})).toEqual({
      activityKind: "subagent",
      displayName: "协作助手"
    });
    expect(activityPresentation("Task", {})).toEqual({ activityKind: "subagent", displayName: "协作助手" });
  });

  it("reads thinking tokens from stream deltas and assistant thinking blocks", () => {
    expect(
      extractThinkingDelta({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "先打开官方项目页。" }
      })
    ).toBe("先打开官方项目页。");
    expect(
      extractThinkingDelta({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "正式回答" }
      })
    ).toBe("");
    expect(extractAssistantThinking({ type: "thinking", thinking: "核对截止日期。" })).toBe("核对截止日期。");
    expect(extractAssistantThinking({ type: "text", text: "正式回答" })).toBe("");
    expect(
      isThinkingBlockStart({
        type: "content_block_start",
        content_block: { type: "thinking" }
      })
    ).toBe(true);
    expect(
      isThinkingBlockStart({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "继续想。" }
      })
    ).toBe(false);
  });

  it("extracts Write/Edit paths and describes workspace files", async () => {
    expect(extractCreatedFilePath("Write", { file_path: "sop.md" })).toBe("sop.md");
    expect(extractCreatedFilePath("Read", { file_path: "sop.md" })).toBeUndefined();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "created-file-"));
    await fs.writeFile(path.join(root, "sop.md"), "# SOP");
    await expect(describeCreatedWorkspaceFile(root, "sop.md")).resolves.toMatchObject({
      relativePath: "sop.md",
      fileName: "sop.md",
      mimeType: "text/markdown",
      size: 5
    });
    await expect(describeCreatedWorkspaceFile(root, "attachments/secret.pdf")).resolves.toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("recovers written files from tool blocks and mentioned names", () => {
    expect(
      collectWorkspaceFileCandidates({
        content: "已写好并保存为 Markdown 文档：2027fall-ai-master-application-summary.md（保存在当前工作区）",
        blocks: [
          { technicalName: "Write", input: { file_path: "notes.md" } },
          { technicalName: "Read", input: { file_path: "ignore-me.txt" } }
        ]
      })
    ).toEqual(["notes.md", "2027fall-ai-master-application-summary.md"]);
  });

  it("keeps uploaded file paths in the prompt and ignores empty tool input", () => {
    expect(meaningfulToolInput({})).toBeUndefined();
    expect(meaningfulToolInput("{}")).toBeUndefined();
    expect(meaningfulToolInput({ command: "ls attachments/*.pdf" })).toEqual({ command: "ls attachments/*.pdf" });
    expect(
      promptWithAttachedFiles("看看这版简历怎么样？", [
        { fileName: "resume.pdf", relativePath: "attachments/resume.pdf", mimeType: "application/pdf" }
      ])
    ).toContain("attachments/resume.pdf");
    expect(
      promptWithAttachedFiles("看看这版简历怎么样？", [
        { fileName: "resume.pdf", relativePath: "attachments/resume.pdf", mimeType: "application/pdf" }
      ])
    ).toContain("Read the exact paths directly");
    expect(
      promptWithAttachedFiles(
        "解释这张图",
        [],
        [
          {
            attachmentId: "image-1",
            conversationId: "conversation-1",
            sourceMessageId: "message-1",
            originalFileName: "diagram.png",
            relativePath: "attachments/diagram.png",
            mimeType: "image/png",
            size: 12,
            sha256: "a".repeat(64),
            source: "current_message"
          }
        ]
      )
    ).toContain("attachments/diagram.png");
    expect(workspaceRelativePath("$WORKSPACE/HAORAN_PAN_resume_revised.pdf")).toBe("HAORAN_PAN_resume_revised.pdf");
  });
});
