import { describe, expect, it } from "vitest";
import {
  isLearningFrameworkBlock,
  responseStatusLabel,
  shouldShowMessageStatus,
  shouldShowSyntheticStatus,
  shouldShowThinkingFold
} from "./responseStatus";
import type { ChatMessage } from "./types";

const user: ChatMessage = { id: "u1", role: "user", content: "问题", createdAt: "2026-08-18T00:00:00Z" };
const assistant: ChatMessage = {
  id: "a1",
  role: "assistant",
  content: "",
  status: "streaming",
  createdAt: "2026-08-18T00:00:01Z"
};

describe("consumer response status", () => {
  it("shows a synthetic status before the assistant placeholder arrives", () => {
    expect(shouldShowSyntheticStatus([user], "submitting")).toBe(true);
    expect(shouldShowSyntheticStatus([user, assistant], "running")).toBe(false);
  });

  it("hands an empty assistant to the thinking fold instead of a static status", () => {
    expect(shouldShowThinkingFold(assistant, "running")).toBe(true);
    expect(shouldShowMessageStatus(assistant, "running")).toBe(false);
    expect(shouldShowThinkingFold({ ...assistant, content: "开始回答" }, "running")).toBe(false);
    expect(shouldShowMessageStatus({ ...assistant, content: "开始回答" }, "running")).toBe(false);
    expect(shouldShowMessageStatus({ ...assistant, status: "completed" }, "completed")).toBe(false);
    expect(
      shouldShowThinkingFold(
        {
          ...assistant,
          blocks: [{ id: "skill", type: "skill", status: "running", children: [] }]
        },
        "running"
      )
    ).toBe(false);
  });

  it("turns the thinking status into a fold once reasoning tokens arrive", () => {
    const thinking = { ...assistant, reasoningSummary: "先核对官方项目页。" };
    expect(shouldShowThinkingFold(thinking, "running")).toBe(true);
    expect(shouldShowMessageStatus(thinking, "running")).toBe(false);
    expect(
      shouldShowThinkingFold({ ...assistant, status: "completed", reasoningSummary: "先核对官方项目页。" }, "completed")
    ).toBe(true);
    expect(
      shouldShowThinkingFold(
        {
          ...assistant,
          reasoningSummary: "先核对官方项目页。",
          blocks: [{ id: "think-1", type: "thinking", kind: "thinking", status: "running", children: [] }]
        },
        "running"
      )
    ).toBe(false);
    expect(
      shouldShowMessageStatus(
        {
          ...assistant,
          blocks: [{ id: "think-1", type: "thinking", kind: "thinking", status: "running", children: [] }]
        },
        "running"
      )
    ).toBe(false);
  });

  it("hides placeholder thinking while a question is waiting", () => {
    expect(shouldShowThinkingFold(assistant, "running", true)).toBe(false);
    expect(shouldShowMessageStatus(assistant, "running", true)).toBe(false);
    expect(shouldShowSyntheticStatus([user], "running", true)).toBe(false);
  });

  it("treats Learning MCP activity as panel-only framework metadata", () => {
    expect(isLearningFrameworkBlock({ technicalName: "mcp__learning__open_learning_incident" })).toBe(true);
    expect(
      isLearningFrameworkBlock({ activity: { technicalName: "mcp__learning__request_learning_verification" } })
    ).toBe(true);
    expect(isLearningFrameworkBlock({ technicalName: "mcp__workspace__present_files" })).toBe(false);
    expect(
      shouldShowThinkingFold(
        {
          ...assistant,
          blocks: [
            {
              id: "learning-1",
              type: "mcp",
              technicalName: "mcp__learning__record_learning_intervention",
              status: "running",
              children: []
            }
          ]
        },
        "running"
      )
    ).toBe(true);
  });

  it("returns translation keys for lifecycle labels", () => {
    expect(responseStatusLabel("submitting")).toBe("statusThinking");
    expect(responseStatusLabel("running")).toBe("statusThinking");
    expect(responseStatusLabel("reconnecting")).toBe("statusReconnecting");
    expect(responseStatusLabel("interrupting")).toBe("statusStopping");
  });
});
