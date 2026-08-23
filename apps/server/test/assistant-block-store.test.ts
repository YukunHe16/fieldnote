import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { AgentStore } from "../src/store.js";

describe("AssistantBlockStore", () => {
  it("persists ordered text and nested activity blocks and clones them with branches", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "研究项目", "normal");

    const first = store.assistantBlocks.appendText({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: "assistant-turn-1",
      delta: "我先核验资料。"
    });
    store.assistantBlocks.appendText({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: "token-event-2",
      delta: "请稍等。"
    });
    const activity = store.assistantBlocks.startActivity({
      runId: run.id,
      messageId: run.assistantMessageId,
      externalId: "tool-1",
      kind: "mcp",
      displayName: "Sources",
      technicalName: "mcp__admissions_evidence__fetch",
      inputSummary: "example.edu"
    });
    const nested = store.assistantBlocks.startActivity({
      runId: run.id,
      messageId: run.assistantMessageId,
      externalId: "tool-2",
      parentBlockId: activity.id,
      owner: "subagent",
      kind: "skill",
      displayName: "Skills · 项目调研",
      technicalName: "Skill"
    });
    store.assistantBlocks.updateActivityInput(run.id, "tool-1", '{"url":"https://example.edu"}');
    store.assistantBlocks.completeActivity(run.id, "tool-2", "completed", "已读取要求");
    store.assistantBlocks.completeActivity(run.id, "tool-1", "completed", "已核验 1 个页面");
    store.assistantBlocks.appendText({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: "assistant-turn-1",
      delta: "这是"
    });
    store.assistantBlocks.appendText({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: "token-event-4",
      delta: "结论。"
    });
    store.assistantBlocks.completeOpenTextBlocks(run.assistantMessageId, "completed");

    const blocks = store.getMessage(run.assistantMessageId)!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["text", "activity", "activity", "text"]);
    expect(blocks[0]).toMatchObject({ id: first.id, content: "我先核验资料。请稍等。" });
    expect(blocks[3]).toMatchObject({ content: "这是结论。" });
    expect(blocks[2]).toMatchObject({ parentBlockId: activity.id, owner: "subagent" });
    expect(blocks[1]?.activity).toMatchObject({
      id: activity.id,
      inputSummary: '{"url":"https://example.edu"}'
    });
    expect(blocks[2]?.activity).toMatchObject({ id: nested.id, status: "completed" });

    const branched = store.createBranchFromMessage(run.assistantMessageId, {
      asNewConversation: true,
      includeTarget: true
    });
    const cloned = branched.messages.find((message) => message.role === "assistant")!;
    expect(cloned.blocks.map((block) => block.kind)).toEqual(["text", "activity", "activity", "text"]);
    expect(cloned.blocks[2]?.parentBlockId).toBe(cloned.blocks[1]?.id);
    expect(cloned.blocks.map((block) => block.runId)).toEqual([run.id, run.id, run.id, run.id]);

    const next = store.createRun(conversation.id, "再根据官网补材料要求", "normal");
    store.assistantBlocks.appendText({
      runId: next.id,
      messageId: next.assistantMessageId,
      streamId: "assistant-turn-2",
      delta: "已写入看板。"
    });
    store.assistantBlocks.completeOpenTextBlocks(next.assistantMessageId, "completed");
    store.setMessageStatus(next.assistantMessageId, "completed");
    store.setRunStatus(next.id, "completed");

    const edited = store.createBranchFromMessage(next.userMessageId, {
      asNewConversation: false,
      includeTarget: false
    });
    const kept = edited.messages.find((message) => message.role === "assistant")!;
    expect(kept.blocks.map((block) => block.kind)).toEqual(["text", "activity", "activity", "text"]);
    expect(kept.blocks[0]?.runId).toBe(run.id);
    database.close();
  });

  it("starts a new thinking block after the assistant has already written text", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "再核对一轮", "normal");

    store.assistantBlocks.appendThinking({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: `${run.id}:thinking`,
      delta: "先看截止日期。"
    });
    store.assistantBlocks.appendText({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: `${run.id}:main`,
      delta: "截止日期是三月。"
    });
    store.assistantBlocks.appendThinking({
      runId: run.id,
      messageId: run.assistantMessageId,
      streamId: `${run.id}:thinking`,
      delta: "再核对材料清单。"
    });
    store.assistantBlocks.completeOpenTextBlocks(run.assistantMessageId, "completed");

    const blocks = store.getMessage(run.assistantMessageId)!.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["thinking", "text", "thinking"]);
    expect(blocks[0]).toMatchObject({ content: "先看截止日期。" });
    expect(blocks[2]).toMatchObject({ content: "再核对材料清单。" });
    database.close();
  });
});
