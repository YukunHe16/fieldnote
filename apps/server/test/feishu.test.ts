import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import {
  buildFeishuReplyCard,
  buildFeishuActivityCard,
  buildFeishuEvolutionCard,
  buildFeishuLearningOutcomeCard,
  buildFeishuProfilePickerCard,
  buildFeishuThinkingCard,
  FeishuChannel,
  parseCardActionValue,
  parseCommand
} from "../src/feishu.js";
import { MemoryStore } from "../src/memory-store.js";
import { AgentStore } from "../src/store.js";
import { CollaborationStore } from "../src/collaboration-store.js";
import { MAX_INPUT_FILE_BYTES } from "../src/input-file-manifest.js";
import { EventStore } from "../src/event-store.js";
import { LearningStore } from "../src/learning-store.js";

function draftApproved(learning: LearningStore, incidentId: string, taskText: string) {
  const { round } = learning.practiceDraftContext(incidentId);
  return learning.recordPracticeItem({
    incidentId,
    round,
    status: "approved",
    taskText,
    targetHypothesis: "剧本误解",
    expectedAnswerSketch: "正确规则的应用",
    difficulty: 3,
    method: "transfer_example",
    gate: "none",
    noveltyScore: 0
  });
}

describe("Feishu commands", () => {
  it("parses control commands without swallowing normal messages", () => {
    expect(parseCommand("/new").name).toBe("new");
    expect(parseCommand("/clear").name).toBe("new");
    expect(parseCommand("/agent 本地")).toEqual({ name: "agent", argument: "本地" });
    expect(parseCommand("/guide 先检查测试")).toEqual({ name: "guide", argument: "先检查测试" });
    expect(parseCommand("解释这个模块")).toEqual({ name: "message", argument: "解释这个模块" });
  });

  it("acknowledges each accepted inbound message with one thumbs-up reaction", async () => {
    let inserted = true;
    const reactions: Array<[string, string]> = [];
    let processed = 0;
    const store = {
      registerInboundEvent() {
        const result = inserted;
        inserted = false;
        return result;
      }
    };
    const channel = new FeishuChannel(
      { appId: "cli_test", appSecret: "secret", allowedOpenIds: new Set(["ou_me"]) },
      store as never,
      {} as never,
      {} as never
    );
    (channel as any).channel = {
      async addReaction(messageId: string, emojiType: string) {
        reactions.push([messageId, emojiType]);
      }
    };
    (channel as any).processInbound = async () => {
      processed += 1;
    };
    const inbound = {
      messageId: "om_test",
      chatId: "oc_test",
      chatType: "p2p",
      senderId: "ou_me",
      content: "你好"
    };

    (channel as any).acceptInbound(inbound);
    (channel as any).acceptInbound(inbound);
    await new Promise((resolve) => setImmediate(resolve));

    expect(reactions).toEqual([["om_test", "THUMBSUP"]]);
    expect(processed).toBe(1);
  });

  it("keeps an empty allowlist allow-all and answers a rejected direct message exactly once", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const processed: string[] = [];
    const sent: any[] = [];
    const openChannel = (allowedOpenIds: Set<string>) => {
      const channel = new FeishuChannel(
        { appId: "cli_test", appSecret: "secret", allowedOpenIds },
        store,
        {} as never,
        {} as never
      );
      (channel as any).channel = {
        async send(...args: any[]) {
          sent.push(args);
        },
        async addReaction() {
          /* acknowledged */
        }
      };
      (channel as any).processInbound = async (message: any) => {
        processed.push(message.messageId);
      };
      return channel;
    };

    const openToEveryone = openChannel(new Set());
    (openToEveryone as any).acceptInbound({
      messageId: "om_open",
      chatId: "oc_1",
      chatType: "p2p",
      senderId: "ou_stranger",
      content: "你好"
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(processed).toEqual(["om_open"]);
    expect(sent).toEqual([]);

    const restricted = openChannel(new Set(["ou_me"]));
    (restricted as any).acceptInbound({
      messageId: "om_mine",
      chatId: "oc_1",
      chatType: "p2p",
      senderId: "ou_me",
      content: "你好"
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(processed).toEqual(["om_open", "om_mine"]);
    expect(sent).toEqual([]);

    (restricted as any).acceptInbound({
      messageId: "om_other_1",
      chatId: "oc_2",
      chatType: "p2p",
      senderId: "ou_other",
      content: "在吗"
    });
    (restricted as any).acceptInbound({
      messageId: "om_other_2",
      chatId: "oc_2",
      chatType: "p2p",
      senderId: "ou_other",
      content: "在吗"
    });
    (restricted as any).acceptInbound({
      messageId: "om_group",
      chatId: "oc_group",
      chatType: "group",
      senderId: "ou_other",
      content: "@bot 在吗",
      mentionedBot: true
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(processed).toEqual(["om_open", "om_mine"]);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe("oc_2");
    expect(sent[0][1]).toEqual({ text: "此机器人为私人助手。" });
    database.close();
  });

  it("remembers the last ten direct-message senders for open_id discovery", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const channel = new FeishuChannel(
      { appId: "cli_test", appSecret: "secret", allowedOpenIds: new Set(["ou_me"]) },
      store,
      {} as never,
      {} as never
    );
    (channel as any).channel = {
      async send() {
        /* refusal */
      },
      async addReaction() {
        /* ack */
      }
    };
    (channel as any).processInbound = async () => {
      /* accepted */
    };

    for (let index = 0; index < 12; index += 1) {
      (channel as any).acceptInbound({
        messageId: `om_${index}`,
        chatId: "oc_1",
        chatType: "p2p",
        senderId: `ou_${index}`,
        content: "你好"
      });
    }
    (channel as any).acceptInbound({
      messageId: "om_me",
      chatId: "oc_1",
      chatType: "p2p",
      senderId: "ou_me",
      content: "你好"
    });
    (channel as any).acceptInbound({
      messageId: "om_repeat",
      chatId: "oc_1",
      chatType: "p2p",
      senderId: "ou_5",
      content: "再问一次"
    });
    (channel as any).acceptInbound({
      messageId: "om_from_group",
      chatId: "oc_group",
      chatType: "group",
      senderId: "ou_in_group",
      content: "@bot 你好",
      mentionedBot: true
    });
    await new Promise((resolve) => setImmediate(resolve));

    const candidates = channel.senderCandidates();
    expect(candidates).toHaveLength(10);
    expect(candidates.map((item) => item.openId).slice(0, 3)).toEqual(["ou_5", "ou_me", "ou_11"]);
    expect(candidates.filter((item) => item.openId === "ou_5")).toHaveLength(1);
    expect(candidates.every((item) => item.chatType === "p2p")).toBe(true);
    expect(candidates.some((item) => item.openId === "ou_in_group")).toBe(false);
    expect(candidates.find((item) => item.openId === "ou_me")?.authorized).toBe(true);
    expect(candidates.find((item) => item.openId === "ou_11")?.authorized).toBe(false);
    expect(Date.parse(candidates[0]!.lastSeenAt)).toBeGreaterThan(0);

    const restarted = new FeishuChannel(undefined, store, {} as never, {} as never);
    expect(restarted.senderCandidates()).toEqual(candidates);
    database.close();
  });

  it("keeps evolution cards updatable after a restart", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation("feishu", "飞书单聊");
    store.setChannelBinding("feishu", "p2p:ou_me", conversation.id, { chatId: "oc_chat", group: false });
    const artifact = {
      id: "artifact-1",
      profileId: "local-operator",
      kind: "skill",
      name: "简历改写与 PDF/Word 导出",
      description: "改简历并导出",
      status: "enabled",
      evaluation: { reason: "飞书卡片确认启用" }
    };
    const before = new FeishuChannel(undefined, store, {} as never, {} as never);
    (before as any).evolution = {
      async review() {
        return artifact;
      }
    };
    (before as any).channel = {
      async send() {
        /* unused */
      },
      async updateCard() {
        /* unused */
      }
    };
    await (before as any).handleCardAction(
      { messageId: "om_card", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } },
      { action: "evolution_approve", artifactId: "artifact-1" }
    );
    expect(store.getSetting<Record<string, { messageId: string }>>("feishu.evolutionCards")).toMatchObject({
      "artifact-1": { chatId: "oc_chat", messageId: "om_card" }
    });

    const updated: any[] = [];
    const after = new FeishuChannel(undefined, store, {} as never, {} as never);
    (after as any).channel = {
      async send() {
        throw new Error("a restarted process must reuse the existing card");
      },
      async updateCard(messageId: string, card: object) {
        updated.push([messageId, card]);
      }
    };
    await after.notifyEvolution({ artifact: artifact as never, verdict: "pass", reason: "复核通过", enabled: true });
    expect(updated).toHaveLength(1);
    expect(updated[0][0]).toBe("om_card");

    for (let index = 0; index < 60; index += 1) {
      (after as any).evolutionCards.set(`artifact-${index}`, { chatId: "oc_chat", messageId: `om_${index}` });
    }
    const stored = store.getSetting<Record<string, unknown>>("feishu.evolutionCards")!;
    expect(Object.keys(stored)).toHaveLength(50);
    expect(stored["artifact-0"]).toBeUndefined();
    expect(stored["artifact-59"]).toEqual({ chatId: "oc_chat", messageId: "om_59" });
    database.close();
  });

  it("builds animated thinking and final action cards without embedding answer text in callbacks", () => {
    const context = {
      conversationId: "conversation-1",
      assistantMessageId: "message-1",
      runId: "run-1",
      webAppUrl: "http://127.0.0.1:5173"
    };
    const thinking = buildFeishuThinkingCard(3, context) as any;
    expect(thinking.body.elements[0].content).toBe("Thinking···");
    expect(thinking.body.elements[1].columns[0].elements[0].text.content).toBe("去往网页端");
    expect(thinking.body.elements[1].columns[1].elements[0].behaviors[0].value).toEqual({
      action: "stop",
      conversationId: "conversation-1",
      runId: "run-1"
    });

    const card = buildFeishuReplyCard("回答正文", context) as any;
    const buttons = card.body.elements[1].columns.map((column: any) => column.elements[0]);
    expect(buttons.map((button: any) => button.text.content)).toEqual(["去往网页端", "重新回复", "新对话", "切换助手"]);
    expect(JSON.stringify(buttons)).not.toContain("回答正文");
    expect(JSON.stringify(card)).not.toContain("已参考");
    expect(parseCardActionValue(buttons[1].behaviors[0].value)).toMatchObject({
      action: "retry",
      conversationId: "conversation-1",
      assistantMessageId: "message-1"
    });
    const fileCard = buildFeishuReplyCard("回答正文", context, [{ id: "file-1", fileName: "sop.md" }]) as any;
    expect(fileCard.body.elements[0].content).toContain("生成的文件");
    expect(fileCard.body.elements[0].content).toContain("sop.md");
    const publicCard = buildFeishuReplyCard("回答正文", { ...context, webAppUrl: "https://agent.example.com" }, [
      { id: "file-1", fileName: "sop.md" }
    ]) as any;
    expect(publicCard.body.elements[1].columns[0].elements[0].text.content).toBe("去往网页端");
    expect(publicCard.body.elements[1].columns[1].elements[0].text.content).toBe("打开 sop.md");
    expect(publicCard.body.elements[1].columns[1].elements[0].behaviors[0].default_url).toContain(
      "/api/attachments/file-1"
    );
    expect(publicCard.body.elements[1].columns[0].elements[0].behaviors[0].default_url).toContain(
      "conversation=conversation-1"
    );
    const picker = buildFeishuProfilePickerCard("conversation-1") as any;
    expect(picker.body.elements[1].columns.map((column: any) => column.elements[0].text.content)).toEqual(["本地助手"]);
    expect(parseCardActionValue(picker.body.elements[1].columns[0].elements[0].behaviors[0].value)).toMatchObject({
      action: "profile",
      profileId: "local-operator"
    });
    const activity = buildFeishuActivityCard("协作助手", "正在读取两个项目", context) as any;
    expect(activity.body.elements[0].content).toContain("协作助手");
    expect(parseCardActionValue({ action: "copy", conversationId: "conversation-1" })).toBeNull();
    expect(parseCardActionValue({ action: "unknown", conversationId: "conversation-1" })).toBeNull();
    expect(parseCardActionValue({ action: "evolution_approve", artifactId: "artifact-1" })).toMatchObject({
      action: "evolution_approve",
      artifactId: "artifact-1"
    });
    // An evolution action without its artifact is unusable; parsing rejects it outright now.
    expect(parseCardActionValue({ action: "evolution_approve" })).toBeNull();
    const pending = buildFeishuEvolutionCard({
      artifact: {
        id: "artifact-1",
        profileId: "local-operator",
        kind: "skill",
        name: "简历改写与 PDF/Word 导出",
        description: "改简历并导出"
      },
      verdict: "needs_human",
      reason: "待你启用"
    }) as any;
    expect(pending.header).toMatchObject({ title: { content: "助手能力有更新" }, template: "orange" });
    expect(pending.body.elements[1].columns).toHaveLength(2);
    const publicPending = buildFeishuEvolutionCard({
      artifact: {
        id: "artifact-1",
        profileId: "local-operator",
        kind: "skill",
        name: "简历改写与 PDF/Word 导出",
        description: "改简历并导出"
      },
      verdict: "needs_human",
      reason: "待你启用",
      replayRunId: "run-old",
      webAppUrl: "https://agent.example.com"
    }) as any;
    expect(publicPending.body.elements[1].columns).toHaveLength(4);
    expect(publicPending.body.elements[1].columns[2].elements[0].text.content).toBe("启用前回放");
    const passed = buildFeishuEvolutionCard({
      artifact: {
        id: "artifact-1",
        profileId: "local-operator",
        kind: "skill",
        name: "简历改写与 PDF/Word 导出",
        description: "改简历并导出"
      },
      verdict: "pass",
      reason: "飞书卡片确认启用",
      enabled: true
    }) as any;
    expect(passed.header).toMatchObject({ title: { content: "已通过" }, template: "green" });
    expect(passed.body.elements[0].content).toContain("检查：飞书卡片确认启用");
    expect(passed.body.elements[0].content).toContain("已启用「简历改写与 PDF/Word 导出」。可在能力页关闭。");
    expect(passed.body.elements[1]).toBeUndefined();
  });

  it("streams one card from Thinking into an answer with final controls", async () => {
    const updates: any[] = [];
    const events = {
      async *streamRun() {
        yield { type: "message.text.delta", payload: { delta: "完成" } };
        yield { type: "run.completed", payload: {} };
      }
    };
    const channel = new FeishuChannel(undefined, {} as never, events as never, {} as never);
    (channel as any).channel = {
      async stream(_chatId: string, input: any) {
        expect(input.card.initial.body.elements[0].content).toBe("Thinking");
        await input.card.producer({
          async update(card: object) {
            updates.push(card);
          }
        });
        return { messageId: "om_reply" };
      }
    };

    await (channel as any).streamReply(
      { messageId: "om_input", chatId: "oc_chat", chatType: "p2p", senderId: "ou_me", content: "问题" },
      {
        id: "run-1",
        conversationId: "conversation-1",
        branchId: "branch-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        mode: "normal",
        status: "running"
      }
    );

    expect(updates.at(-1).body.elements[0].content).toBe("完成");
    expect(updates.at(-1).body.elements[1].columns).toHaveLength(4);
  });

  it("keeps streamed answer visible when a tool starts after text", async () => {
    const updates: any[] = [];
    const events = {
      async *streamRun() {
        yield { type: "message.text.delta", payload: { delta: "先核对官网" } };
        yield {
          type: "activity.started",
          payload: { block: { id: "a1", activity: { displayName: "网页搜索", content: "" } } }
        };
        yield { type: "message.text.delta", payload: { delta: "\n找到了" } };
        yield { type: "run.completed", payload: {} };
      }
    };
    const channel = new FeishuChannel(undefined, {} as never, events as never, {} as never);
    (channel as any).channel = {
      async stream(_chatId: string, input: any) {
        await input.card.producer({
          async update(card: object) {
            updates.push(card);
          }
        });
        return { messageId: "om_reply" };
      }
    };

    await (channel as any).streamReply(
      { messageId: "om_input", chatId: "oc_chat", chatType: "p2p", senderId: "ou_me", content: "问题" },
      {
        id: "run-1",
        conversationId: "conversation-1",
        branchId: "branch-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        mode: "normal",
        status: "running"
      }
    );

    const contents = updates.map((card) => String(card.body.elements[0].content));
    expect(contents.some((content) => content.includes("网页搜索") && !content.includes("先核对官网"))).toBe(false);
    expect(updates.at(-1).body.elements[0].content).toContain("先核对官网");
    expect(updates.at(-1).body.elements[0].content).toContain("找到了");
  });

  it("does not stream reasoning into the Feishu card", async () => {
    const updates: any[] = [];
    const events = {
      async *streamRun() {
        yield { type: "reasoning.summary.delta", payload: { delta: "先看简历结构" } };
        yield { type: "message.text.delta", payload: { delta: "建议改摘要" } };
        yield { type: "run.completed", payload: {} };
      }
    };
    const channel = new FeishuChannel(undefined, {} as never, events as never, {} as never);
    (channel as any).channel = {
      async stream(_chatId: string, input: any) {
        await input.card.producer({
          async update(card: object) {
            updates.push(card);
          }
        });
        return { messageId: "om_reply" };
      }
    };

    await (channel as any).streamReply(
      { messageId: "om_input", chatId: "oc_chat", chatType: "p2p", senderId: "ou_me", content: "问题" },
      {
        id: "run-1",
        conversationId: "conversation-1",
        branchId: "branch-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        mode: "normal",
        status: "running"
      }
    );

    expect(updates.some((card) => String(card.body.elements[0].content).includes("先看简历结构"))).toBe(false);
    expect(updates.at(-1).body.elements[0].content).toBe("建议改摘要");
  });

  it("replies in the group chat instead of opening a new Feishu topic", async () => {
    const streamOptions: unknown[] = [];
    const events = {
      async *streamRun() {
        yield { type: "message.text.delta", payload: { delta: "好" } };
        yield { type: "run.completed", payload: {} };
      }
    };
    const channel = new FeishuChannel(undefined, {} as never, events as never, {} as never);
    (channel as any).channel = {
      async stream(_chatId: string, input: any, options: unknown) {
        streamOptions.push(options);
        await input.card.producer({
          async update() {
            /* card pump */
          }
        });
      }
    };
    await (channel as any).streamReply(
      { messageId: "om_at", chatId: "oc_group", chatType: "group", senderId: "ou_me", content: "改简历" },
      {
        id: "run-1",
        conversationId: "conversation-1",
        branchId: "branch-1",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        mode: "normal",
        status: "running"
      }
    );
    expect(streamOptions[0]).toEqual({ replyTo: "om_at", replyInThread: false });

    streamOptions.length = 0;
    await (channel as any).streamReply(
      {
        messageId: "om_in_topic",
        chatId: "oc_group",
        chatType: "group",
        senderId: "ou_me",
        content: "继续",
        rootId: "om_topic",
        threadId: "omt_1"
      },
      {
        id: "run-2",
        conversationId: "conversation-2",
        branchId: "branch-2",
        userMessageId: "user-2",
        assistantMessageId: "assistant-2",
        mode: "normal",
        status: "running"
      }
    );
    expect(streamOptions[0]).toEqual({ replyTo: "om_in_topic", replyInThread: true });
  });

  it("handles retry and new-conversation card actions from server-side message state", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const sharedMemory = memories.create({
      category: "preference",
      title: "回答风格",
      content: "偏好简洁回答",
      sourceKind: "manual"
    });
    const conversation = store.createConversation("feishu", "飞书单聊");
    store.setChannelBinding("feishu", "p2p:ou_me", conversation.id, { chatId: "oc_chat", group: false });
    const sourceRun = store.createRun(conversation.id, "原始问题", "normal");
    store.replaceMessageText(sourceRun.assistantMessageId, "原始回答");
    store.setMessageStatus(sourceRun.assistantMessageId, "completed");
    const sent: any[] = [];
    const submissions: any[] = [];
    const streams: any[] = [];
    let interruptedConversation: string | undefined;
    const orchestrator = {
      async interruptConversationAndWait(conversationId: string) {
        interruptedConversation = conversationId;
      },
      submit(...args: any[]) {
        submissions.push(args);
        return {
          id: "retry-run",
          conversationId: conversation.id,
          branchId: "retry-branch",
          userMessageId: "retry-user",
          assistantMessageId: "retry-assistant",
          mode: "normal",
          status: "queued"
        };
      }
    };
    const feishu = new FeishuChannel(undefined, store, {} as never, orchestrator as never);
    (feishu as any).channel = {
      async send(...args: any[]) {
        sent.push(args);
      }
    };
    (feishu as any).streamReply = async (...args: any[]) => {
      streams.push(args);
    };
    const event = { messageId: "om_card", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } };

    await (feishu as any).handleCardAction(event, {
      action: "retry",
      conversationId: conversation.id,
      assistantMessageId: sourceRun.assistantMessageId
    });
    expect(submissions[0]?.[1]).toBe("原始问题");
    expect(streams).toHaveLength(1);

    await (feishu as any).handleCardAction(event, { action: "new", conversationId: conversation.id });
    expect(interruptedConversation).toBe(conversation.id);
    expect(sent[0]?.[0]).toBe("oc_chat");
    expect(sent[0]?.[1]).toEqual({ text: "新对话已创建" });
    expect(store.getChannelBinding("feishu", "p2p:ou_me")).not.toBe(conversation.id);
    expect(memories.get(sharedMemory.id)).not.toBeNull();
    database.close();
  });

  it("confirms a learning verification from the outcome card and starts the next round", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const learning = new LearningStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation("feishu", "飞书学习", { profileId: "local-operator" });
    store.setChannelBinding("feishu", "p2p:ou_me", conversation.id, { chatId: "oc_chat", group: false });
    const session = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解递归",
      datasetKind: "live",
      status: "active"
    });
    const run = store.createRun(conversation.id, "我不懂递归出口", "normal");
    const incident = learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "把递归当循环",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [run.userMessageId]
    });
    const intervention = learning.recordIntervention({
      incidentId: incident.id,
      strategy: "direct_explanation",
      rationale: "先讲清楚出口",
      expectedSignal: "能解释出口条件"
    });
    const practiceDraft0 = draftApproved(learning, incident.id, "请解释递归何时停止");
    const verification = learning.requestVerification({
      incidentId: incident.id,
      interventionId: intervention.id,
      method: "self_explanation",
      prompt: "请解释递归何时停止",
      rubric: "说明出口条件",
      practiceItemId: practiceDraft0.id
    });
    learning.proposeSystemOutcome(verification.id, "unresolved", 0.55);
    expect(learning.pendingLearnerConfirmation(conversation.id)?.verification.id).toBe(verification.id);

    const submissions: any[] = [];
    const updated: any[] = [];
    const orchestrator = {
      isConversationBusy: () => false,
      submit(...args: any[]) {
        submissions.push(args);
        return {
          id: "next-run",
          conversationId: conversation.id,
          branchId: "branch",
          userMessageId: "user",
          assistantMessageId: "assistant",
          mode: "normal",
          status: "queued"
        };
      }
    };
    const feishu = new FeishuChannel(
      undefined,
      store,
      events,
      orchestrator as never,
      undefined,
      "",
      undefined,
      undefined,
      learning
    );
    (feishu as any).channel = {
      async send() {},
      async updateCard(...args: any[]) {
        updated.push(args);
      }
    };
    (feishu as any).streamReply = async () => {};
    const event = { messageId: "om_card", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } };

    await (feishu as any).handleCardAction(event, {
      action: "learning_confirm",
      conversationId: conversation.id,
      verificationId: verification.id,
      verdict: "unresolved"
    });
    expect(learning.getVerification(verification.id)?.finalVerdict).toBe("unresolved");
    expect(updated).toHaveLength(1);
    // The unresolved on-call confirmation auto-sends the try-another follow-up server-side.
    expect(submissions).toHaveLength(1);
    expect(String(submissions[0]?.[1])).toContain("换种讲法");
    expect(learning.pendingLearnerConfirmation(conversation.id)).toBeNull();

    // A double-click resolves to the terminal card without a second submission.
    await (feishu as any).handleCardAction(event, {
      action: "learning_confirm",
      conversationId: conversation.id,
      verificationId: verification.id,
      verdict: "resolved"
    });
    expect(submissions).toHaveLength(1);
    expect(updated).toHaveLength(2);
    database.close();
  });

  it("starts the next round after a partial confirmation, not just an unresolved one", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const learning = new LearningStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation("feishu", "飞书学习", { profileId: "local-operator" });
    store.setChannelBinding("feishu", "p2p:ou_me", conversation.id, { chatId: "oc_chat", group: false });
    const session = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解递归",
      datasetKind: "live",
      status: "active"
    });
    const run = store.createRun(conversation.id, "我不懂递归出口", "normal");
    const incident = learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "把递归当循环",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [run.userMessageId]
    });
    const intervention = learning.recordIntervention({
      incidentId: incident.id,
      strategy: "evidence_check",
      rationale: "回去核对原始材料",
      expectedSignal: "能指出证据在哪"
    });
    const draft = draftApproved(learning, incident.id, "请解释递归何时停止");
    const verification = learning.requestVerification({
      incidentId: incident.id,
      interventionId: intervention.id,
      method: "transfer_example",
      prompt: "请解释递归何时停止",
      rubric: "说明出口条件",
      practiceItemId: draft.id
    });
    learning.proposeSystemOutcome(verification.id, "partial", 0.78);

    const submissions: any[] = [];
    const orchestrator = {
      isConversationBusy: () => false,
      submit(...args: any[]) {
        submissions.push(args);
        return {
          id: "next-run",
          conversationId: conversation.id,
          branchId: "branch",
          userMessageId: "user",
          assistantMessageId: "assistant",
          mode: "normal",
          status: "queued"
        };
      }
    };
    const feishu = new FeishuChannel(
      undefined,
      store,
      events,
      orchestrator as never,
      undefined,
      "",
      undefined,
      undefined,
      learning
    );
    (feishu as any).channel = { async send() {}, async updateCard() {} };
    (feishu as any).streamReply = async () => {};

    await (feishu as any).handleCardAction(
      { messageId: "om_card", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } },
      {
        action: "learning_confirm",
        conversationId: conversation.id,
        verificationId: verification.id,
        verdict: "partial"
      }
    );

    // "partial" parks the incident at `diagnosed` — another round is owed, so the follow-up
    // must go out. Gating it on `verdict === "unresolved"` stranded these loops forever.
    expect(learning.getIncident(incident.id)?.status).toBe("diagnosed");
    expect(submissions).toHaveLength(1);
    expect(String(submissions[0]?.[1])).toContain("只理解了一部分");
    database.close();
  });

  it("distills on card-confirmed resolutions, dedupes outcome cards, and reports real errors", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const learning = new LearningStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation("feishu", "飞书学习", { profileId: "local-operator" });
    store.setChannelBinding("feishu", "p2p:ou_me", conversation.id, { chatId: "oc_chat", group: false });
    const session = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解递归",
      datasetKind: "live",
      status: "active"
    });
    const run = store.createRun(conversation.id, "我不懂递归出口", "normal");
    store.replaceMessageText(run.assistantMessageId, "画出每一层调用的栈帧，再对比循环的单一变量快照。");
    store.setMessageStatus(run.assistantMessageId, "completed");
    const incident = learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "把递归当循环",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [run.userMessageId]
    });
    const drive = (
      strategy: "direct_explanation" | "conceptual_hint",
      withMessage: boolean,
      incidentId = incident.id
    ) => {
      const intervention = learning.recordIntervention({
        incidentId,
        strategy,
        rationale: "按误区选择",
        expectedSignal: "能解释出口",
        ...(withMessage ? { runId: run.id, messageId: run.assistantMessageId } : {})
      });
      const practiceDraft1 = draftApproved(learning, incidentId, "请解释递归何时停止");
      const verification = learning.requestVerification({
        incidentId,
        interventionId: intervention.id,
        method: "self_explanation",
        prompt: "请解释递归何时停止",
        rubric: "说明出口条件",
        practiceItemId: practiceDraft1.id
      });
      return verification;
    };
    const first = drive("direct_explanation", false);
    learning.proposeSystemOutcome(first.id, "unresolved", 0.5);
    learning.confirmVerification(first.id, "unresolved");
    const second = drive("conceptual_hint", true);
    learning.proposeSystemOutcome(second.id, "resolved", 0.8);

    const distillCalls: unknown[] = [];
    const runtime = {
      async distillTeachingApproach(input: unknown) {
        distillCalls.push(input);
        return { title: "栈帧对照法", instruction: "先画栈帧图再对比循环变量快照", baseStrategy: "direct_explanation" };
      }
    };
    const sends: any[] = [];
    const updated: any[] = [];
    const orchestrator = { isConversationBusy: () => false, submit: () => ({ id: "next" }) };
    const feishu = new FeishuChannel(
      undefined,
      store,
      events,
      orchestrator as never,
      undefined,
      "",
      undefined,
      undefined,
      learning,
      runtime as never
    );
    (feishu as any).channel = {
      async send(...args: any[]) {
        sends.push(args);
      },
      async updateCard(...args: any[]) {
        updated.push(args);
      }
    };
    const event = { messageId: "om_card", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } };
    await (feishu as any).handleCardAction(event, {
      action: "learning_confirm",
      conversationId: conversation.id,
      verificationId: second.id,
      verdict: "resolved"
    });
    // The card path carries the invention deps: the multi-round resolution distills a
    // pending 讲法 candidate exactly like the web confirm route.
    await vi.waitFor(() => {
      expect(distillCalls).toHaveLength(1);
      expect(learning.listVariants({ participantId: "default", profileId: "local-operator" })).toHaveLength(1);
    });
    // The host decides the base strategy from the winning round, not the model's claim.
    expect(learning.listVariants({ participantId: "default", profileId: "local-operator" })[0]).toMatchObject({
      status: "pending",
      baseStrategy: "conceptual_hint"
    });

    // Outcome cards are deduped per verification: two completed runs while the same
    // confirmation is pending send exactly one card.
    const revisit = learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "残余困难",
      confidence: 0.6,
      severity: 2,
      evidenceMessageIds: [run.userMessageId]
    });
    const pendingVerification = drive("direct_explanation", false, revisit.id);
    learning.proposeSystemOutcome(pendingVerification.id, "partial", 0.6);
    await (feishu as any).maybeSendLearningOutcomeCard("oc_chat", conversation.id, {});
    await (feishu as any).maybeSendLearningOutcomeCard("oc_chat", conversation.id, {});
    expect(sends).toHaveLength(1);

    // A non-conflict failure is reported as an error, never dressed up as a double-click.
    const broken = { ...event, messageId: "om_error" };
    const originalConfirm = learning.confirmVerification.bind(learning);
    (learning as any).confirmVerification = () => {
      throw new TypeError("database is closed");
    };
    await (feishu as any).handleCardAction(broken, {
      action: "learning_confirm",
      conversationId: conversation.id,
      verificationId: pendingVerification.id,
      verdict: "resolved"
    });
    (learning as any).confirmVerification = originalConfirm;
    const lastCard = JSON.stringify(updated.at(-1));
    expect(lastCard).toContain("出错");
    expect(lastCard).not.toContain("已处理过");
    database.close();
  });

  it("ends the session for /learn OFF variants instead of renaming the goal", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const learning = new LearningStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation("feishu", "飞书学习", { profileId: "local-operator" });
    const session = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解递归",
      datasetKind: "live",
      status: "active"
    });
    const sends: any[] = [];
    const feishu = new FeishuChannel(
      undefined,
      store,
      events,
      { submit: () => ({}) } as never,
      undefined,
      "",
      undefined,
      undefined,
      learning
    );
    (feishu as any).channel = {
      async send(...args: any[]) {
        sends.push(args);
      }
    };
    const message = { chatId: "oc_chat", chatType: "p2p", senderId: "ou_me", messageId: "om_msg" };
    // Mobile keyboards auto-capitalize: "/learn OFF" must end the session, not set goal "OFF".
    await (feishu as any).handleLearnCommand(conversation.id, "OFF", message);
    expect(learning.getSessionForConversation(conversation.id)?.status).toBe("completed");
    expect(learning.getSessionForConversation(conversation.id)?.goal).toBe("理解递归");
    void session;
    database.close();
  });

  it("pages the owner once with a handoff card when a live incident escalates", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const learning = new LearningStore(database);
    const events = new EventStore(database);
    const conversation = store.createConversation("web", "网页学习", { profileId: "local-operator" });
    const feishuConversation = store.createConversation("feishu", "飞书单聊");
    store.setChannelBinding("feishu", "p2p:ou_me", feishuConversation.id, { chatId: "oc_owner", group: false });
    const session = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "理解递归",
      datasetKind: "live",
      status: "active"
    });
    const run = store.createRun(conversation.id, "我不懂递归", "normal");
    const incident = learning.openIncident({
      sessionId: session.id,
      difficultyType: "conceptual_misconception",
      hypothesis: "把递归当循环",
      confidence: 0.8,
      severity: 3,
      evidenceMessageIds: [run.userMessageId]
    });
    learning.recordIntervention({
      incidentId: incident.id,
      strategy: "direct_explanation",
      rationale: "讲出口",
      expectedSignal: "能解释出口"
    });
    const escalated = learning.escalateIncident(incident.id, "超出当前能力");
    const sent: any[] = [];
    const feishu = new FeishuChannel(
      undefined,
      store,
      events,
      {} as never,
      undefined,
      "",
      undefined,
      undefined,
      learning
    );
    (feishu as any).channel = {
      async send(...args: any[]) {
        sent.push(args);
      }
    };
    events.append({
      type: "learning.incident.updated",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { incident: escalated }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe("oc_owner");
    const card = JSON.stringify(sent[0]?.[1]);
    expect(card).toContain("需要人工接手");
    expect(card).toContain("超出当前能力");
    // The same escalation event never pages twice.
    events.append({
      type: "learning.incident.updated",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { incident: escalated }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    database.close();
  });

  it("parses the learn command and learning confirm card values", () => {
    expect(parseCommand("/learn 理解递归出口")).toEqual({ name: "learn", argument: "理解递归出口" });
    expect(parseCommand("/learn off")).toEqual({ name: "learn", argument: "off" });
    expect(parseCommand("/learn")).toEqual({ name: "learn", argument: "" });
    expect(
      parseCardActionValue({
        action: "learning_confirm",
        conversationId: "conv",
        verificationId: "verify",
        verdict: "partial"
      })
    ).toMatchObject({ action: "learning_confirm", verificationId: "verify", verdict: "partial" });
    expect(parseCardActionValue({ action: "learning_confirm", conversationId: "conv" })).toBeNull();
    expect(
      parseCardActionValue({
        action: "learning_confirm",
        conversationId: "conv",
        verificationId: "verify",
        verdict: "great"
      })
    ).toBeNull();
    const card = JSON.stringify(
      buildFeishuLearningOutcomeCard({ conversationId: "conv", verificationId: "verify", finalRound: false })
    );
    expect(card).toContain("learning_confirm");
    expect(card).toContain("仍未解决，换种讲法");
    const finalCard = JSON.stringify(
      buildFeishuLearningOutcomeCard({ conversationId: "conv", verificationId: "verify", finalRound: true })
    );
    expect(finalCard).toContain("仍未解决");
    expect(finalCard).not.toContain("换种讲法");
  });

  it("updates the same evolution card in place instead of sending a new message", async () => {
    const sent: any[] = [];
    const updated: any[] = [];
    const feishu = new FeishuChannel(undefined, {} as never, {} as never, {} as never);
    (feishu as any).evolution = {
      async review(_id: string, verdict: string) {
        return {
          id: "artifact-1",
          profileId: "local-operator",
          kind: "skill",
          name: "简历改写与 PDF/Word 导出",
          description: "改简历并导出",
          status: verdict === "pass" ? "enabled" : "rejected",
          evaluation: { reason: "飞书卡片确认启用" }
        };
      }
    };
    (feishu as any).channel = {
      async send(...args: any[]) {
        sent.push(args);
      },
      async updateCard(messageId: string, card: object) {
        updated.push([messageId, card]);
      }
    };

    await (feishu as any).handleCardAction(
      { messageId: "om_card", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } },
      { action: "evolution_approve", artifactId: "artifact-1" }
    );

    expect(sent).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0][0]).toBe("om_card");
    expect(updated[0][1].header).toMatchObject({ title: { content: "已通过" }, template: "green" });
    expect(updated[0][1].body.elements[0].content).toContain("已启用「简历改写与 PDF/Word 导出」。可在能力页关闭。");
  });

  it("ingests an inbound Feishu PDF into the conversation workspace", async () => {
    const root = await (await import("node:fs/promises")).mkdtemp(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "feishu-in-")
    );
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation("feishu", "飞书单聊");
    const feishu = new FeishuChannel(undefined, store, {} as never, {} as never, "http://127.0.0.1:5173", root);
    const result = await (feishu as any).ingestInboundFiles(conversation.id, {
      messageId: "om_file",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_me",
      content: "",
      files: [
        {
          file_key: "file_resume",
          file_name: "resume.pdf",
          mime_type: "application/pdf",
          data: Buffer.from("%PDF-1.4")
        }
      ]
    });
    expect(result.failures).toEqual([]);
    expect(result.attachmentIds).toHaveLength(1);
    const attachment = store.getStoredAttachment(result.attachmentIds[0]!);
    expect(attachment?.fileName).toBe("resume.pdf");
    expect(
      (await import("node:fs")).existsSync(
        (await import("node:path")).join(root, conversation.id, attachment!.relativePath)
      )
    ).toBe(true);
    database.close();
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  });

  it("rejects Feishu files above the shared input size limit", async () => {
    const root = await (await import("node:fs/promises")).mkdtemp(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "feishu-large-")
    );
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation("feishu", "飞书单聊");
    const feishu = new FeishuChannel(undefined, store, {} as never, {} as never, "http://127.0.0.1:5173", root);
    const result = await (feishu as any).ingestInboundFiles(conversation.id, {
      messageId: "om_large",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_me",
      content: "",
      files: [
        {
          file_key: "file_large",
          file_name: "large.pdf",
          mime_type: "application/pdf",
          data: Buffer.alloc(MAX_INPUT_FILE_BYTES + 1)
        }
      ]
    });
    expect(result.attachmentIds).toEqual([]);
    expect(result.failures).toEqual(["large.pdf（超过 20 MB）"]);
    database.close();
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  });

  it("tells the user when a Feishu attachment cannot be accepted", async () => {
    const root = await (await import("node:fs/promises")).mkdtemp(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "feishu-reject-")
    );
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const sent: any[] = [];
    const feishu = new FeishuChannel(undefined, store, {} as never, {} as never, "http://127.0.0.1:5173", root);
    (feishu as any).channel = {
      async send(...args: any[]) {
        sent.push(args);
      }
    };

    await (feishu as any).processInbound({
      messageId: "om_zip",
      chatId: "oc_chat",
      chatType: "p2p",
      senderId: "ou_me",
      content: "",
      messageType: "file",
      files: [
        {
          file_key: "file_zip",
          file_name: "archive.zip",
          mime_type: "application/zip",
          data: Buffer.from("zip")
        }
      ]
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]?.markdown).toContain("附件未能读取");
    expect(sent[0]?.[1]?.markdown).toContain("不支持 application/zip");
    database.close();
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  });

  it("answers AskUserQuestion from the same Feishu card", async () => {
    const answers: Array<Record<string, string>> = [];
    const updated: any[] = [];
    const orchestrator = {
      pendingQuestion() {
        return { questions: [{ question: "用哪一版简历？", options: [{ label: "一页版" }] }] };
      },
      answerQuestion(_runId: string, value: Record<string, string>) {
        answers.push(value);
        return true;
      }
    };
    const feishu = new FeishuChannel(undefined, {} as never, {} as never, orchestrator as never);
    (feishu as any).channel = {
      async updateCard(messageId: string, card: object) {
        updated.push([messageId, card]);
      }
    };
    await (feishu as any).handleCardAction(
      { messageId: "om_ask", chatId: "oc_chat", operator: { openId: "ou_me" }, action: { value: {} } },
      { action: "ask_answer", runId: "run-1", answer: "一页版" }
    );
    expect(answers[0]).toEqual({ "用哪一版简历？": "一页版" });
    expect(updated[0][1].header.title.content).toBe("已选择");
  });

  it("mirrors a completed web reply back to the bound Feishu chat", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation("feishu", "飞书单聊");
    store.setChannelBinding("feishu", "p2p:ou_me", conversation.id, {
      chatId: "oc_chat",
      group: false,
      messageId: "om_root"
    });
    const run = store.createRun(conversation.id, "把 PDF 发来", "normal");
    store.replaceMessageText(run.assistantMessageId, "已生成简历 PDF");
    store.setMessageStatus(run.assistantMessageId, "completed");
    const collaboration = new CollaborationStore(database);
    const task = collaboration.markRunning(
      collaboration.createTask({
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
        specialistId: "source-verifier",
        displayName: "资料核验员",
        requestSummary: "复核截止日期"
      }).id
    );
    collaboration.completeStructured(task.id, {
      summary: "复核完成",
      findings: [{ claim: "国际生轮次仍待确认", status: "unresolved", sourceUrls: [] }],
      openQuestions: [],
      recommendedFollowups: []
    });
    const sent: any[] = [];
    const feishu = new FeishuChannel(
      undefined,
      store,
      {} as never,
      {} as never,
      "http://127.0.0.1:5173",
      "",
      undefined,
      collaboration
    );
    (feishu as any).channel = {
      async send(...args: any[]) {
        sent.push(args);
      }
    };
    await feishu.mirrorCompletedRun(conversation.id, run.id);
    expect(sent[0][0]).toBe("oc_chat");
    expect(sent[0][1].markdown).toContain("已生成简历 PDF");
    expect(sent[0][1].markdown).toContain("协作核验：1 位协作助手");
    expect(sent[0][1].markdown).toContain("注意：国际生轮次仍待确认");
    database.close();
  });
});
