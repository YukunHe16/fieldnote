import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { AgentStore } from "../src/store.js";

describe("AgentStore", () => {
  it("keeps empty drafts out of conversation history until the user sends a message", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const draft = store.createConversation("web", "新对话", { profileId: "graduate-admissions" });

    expect(store.listConversations("active")).toEqual([]);
    store.createRun(draft.id, "第一条真实请求", "normal");
    expect(store.listConversations("active")).toEqual([
      expect.objectContaining({ id: draft.id, profileId: "graduate-admissions" })
    ]);
    database.close();
  });

  it("creates, searches, archives, and branches conversations", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "整理项目发布计划", "normal");
    store.appendMessageText(run.assistantMessageId, "已经完成发布计划。");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    store.setRunStatus(run.id, "running");
    expect(store.getRun(run.id)?.status).toBe("completed");

    expect(store.listConversations("active", "发布")).toHaveLength(1);
    const archived = store.updateConversation(conversation.id, { archived: true });
    expect(archived?.archived).toBe(true);
    expect(store.listConversations("active")).toHaveLength(0);
    expect(store.listConversations("archived", "发布")).toHaveLength(1);

    store.updateConversation(conversation.id, { archived: false });
    const branch = store.createBranchFromMessage(run.userMessageId, {
      asNewConversation: false,
      includeTarget: false
    });
    expect(branch.activeBranchId).not.toBe(conversation.activeBranchId);
    expect(branch.messages).toHaveLength(0);

    const editable = store.createConversation();
    const keptRun = store.createRun(editable.id, "保留的第一轮", "normal");
    store.setMessageStatus(keptRun.assistantMessageId, "completed");
    store.setRunStatus(keptRun.id, "completed");
    store.updateBranchSession(editable.activeBranchId, "sdk-session-edit");
    store.setMessageSdkUuid(keptRun.assistantMessageId, "assistant-boundary");
    const replacedRun = store.createRun(editable.id, "需要改写的第二轮", "normal");
    const editedBranch = store.createBranchFromMessage(replacedRun.userMessageId, {
      asNewConversation: false,
      includeTarget: false
    });
    expect(editedBranch.messages.map((message) => message.content)).toEqual(["保留的第一轮", ""]);
    expect(store.getBranchRuntime(editedBranch.activeBranchId)).toMatchObject({
      sdkSessionId: "sdk-session-edit",
      resumeSessionAt: "assistant-boundary"
    });

    const legacy = store.createConversation();
    const legacyKeptRun = store.createRun(legacy.id, "旧会话第一轮", "normal");
    store.setMessageStatus(legacyKeptRun.assistantMessageId, "completed");
    store.setRunStatus(legacyKeptRun.id, "completed");
    store.updateBranchSession(legacy.activeBranchId, "legacy-session");
    const legacyReplacedRun = store.createRun(legacy.id, "旧会话第二轮", "normal");
    const legacyBranch = store.createBranchFromMessage(legacyReplacedRun.userMessageId, {
      asNewConversation: false,
      includeTarget: false
    });
    expect(store.getBranchRuntime(legacyBranch.activeBranchId)).toMatchObject({
      sdkSessionId: null,
      resumeSessionAt: null
    });

    const source = store.createConversation();
    const sourceRun = store.createRun(source.id, "保留这段上下文", "normal");
    store.updateBranchSession(source.activeBranchId, "sdk-session-a");
    store.setMessageSdkUuid(sourceRun.userMessageId, "message-a");
    const newConversation = store.createBranchFromMessage(sourceRun.userMessageId, {
      asNewConversation: true,
      includeTarget: true
    });
    expect(newConversation.messages[0]?.content).toBe("保留这段上下文");
    expect(store.getBranchRuntime(newConversation.activeBranchId)?.sdkSessionId).toBeNull();
    expect(newConversation.profileId).toBe("local-operator");

    const admissions = store.createConversation("web", "申学", { profileId: "graduate-admissions" });
    const admissionsRun = store.createRun(admissions.id, "比较项目", "normal");
    expect(admissions).toMatchObject({ profileId: "graduate-admissions", profileName: "申学助手" });
    expect(admissionsRun.profileRevision).toBeGreaterThan(0);
    const admissionsBranch = store.createBranchFromMessage(admissionsRun.userMessageId, {
      asNewConversation: true,
      includeTarget: true
    });
    expect(admissionsBranch.profileId).toBe("graduate-admissions");
    database.close();
  });

  it("keeps generated files unpublished until they are presented", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "导出 PDF", "normal");
    const draft = store.attachGeneratedFile({
      conversationId: conversation.id,
      messageId: run.assistantMessageId,
      fileName: "make_resume.py",
      mimeType: "application/octet-stream",
      size: 12,
      sha256: "a".repeat(64),
      relativePath: "make_resume.py"
    });
    const pdf = store.attachGeneratedFile({
      conversationId: conversation.id,
      messageId: run.assistantMessageId,
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      size: 20,
      sha256: "b".repeat(64),
      relativePath: "resume.pdf",
      presented: true
    });
    store.attachGeneratedFile({
      conversationId: conversation.id,
      messageId: run.assistantMessageId,
      fileName: "make_resume.py",
      mimeType: "application/octet-stream",
      size: 12,
      sha256: "a".repeat(64),
      relativePath: "make_resume.py"
    });
    expect(draft.presented).toBe(false);
    expect(pdf.presented).toBe(true);
    expect(store.getMessage(run.assistantMessageId)?.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileName: "make_resume.py", presented: false }),
        expect.objectContaining({ fileName: "resume.pdf", presented: true })
      ])
    );
    database.close();
  });

  it("never reclassifies a user input attachment as generated output", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const input = store.createAttachment({
      conversationId: conversation.id,
      fileName: "source.txt",
      storedName: "source.txt",
      mimeType: "text/plain",
      size: 8,
      sha256: "a".repeat(64),
      relativePath: "attachments/source.txt"
    });
    const run = store.createRun(conversation.id, "读取原文件", "normal", [input.id]);

    expect(() =>
      store.attachGeneratedFile({
        conversationId: conversation.id,
        messageId: run.assistantMessageId,
        fileName: "source.txt",
        mimeType: "text/plain",
        size: 9,
        sha256: "b".repeat(64),
        relativePath: "attachments/source.txt"
      })
    ).toThrow("cannot overwrite a user input attachment");
    expect(store.getStoredAttachment(input.id)).toMatchObject({ size: 8 });
    expect(store.getMessage(run.assistantMessageId)?.attachments).toEqual([]);
    database.close();
  });
});
