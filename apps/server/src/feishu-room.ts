import path from "node:path";
import type { AskUserQuestionDto } from "@fieldnote/contracts";

export type FeishuInboundFile = {
  key: string;
  kind: "file" | "image";
  fileName?: string;
  mimeType?: string;
  data?: Buffer;
};

export function feishuRoomKey(message: {
  chatType: "p2p" | "group";
  chatId: string;
  senderId: string;
  rootId?: string;
  threadId?: string;
}): string {
  if (message.chatType === "p2p") return `p2p:${message.senderId}`;
  const root = message.rootId ?? message.threadId;
  return root ? `group:${message.chatId}:${root}` : `group:${message.chatId}`;
}

export function isFeishuThreadMessage(message: { rootId?: string | null; threadId?: string | null }): boolean {
  return Boolean(message.rootId?.trim() || message.threadId?.trim());
}

export function feishuReplyOptions(message: { messageId?: string; rootId?: string | null; threadId?: string | null }): {
  replyTo?: string;
  replyInThread: boolean;
} {
  return {
    ...(message.messageId ? { replyTo: message.messageId } : {}),
    replyInThread: isFeishuThreadMessage(message)
  };
}

export function sanitizeInboundFileName(value: string): string {
  const base = path
    .basename(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .trim();
  return (base || "attachment").slice(0, 180);
}

export function inboundFilesFromMessage(message: {
  content?: string;
  messageType?: string;
  files?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
  raw?: unknown;
}): FeishuInboundFile[] {
  const found: FeishuInboundFile[] = [];
  const push = (raw: Record<string, unknown>, fallbackKind: "file" | "image") => {
    const key = String(raw.fileKey ?? raw.file_key ?? raw.imageKey ?? raw.image_key ?? "").trim();
    if (!key && !Buffer.isBuffer(raw.data) && !Buffer.isBuffer(raw.buffer)) return;
    const kind: "file" | "image" = /image|img/.test(String(raw.tag ?? raw.type ?? raw.kind ?? fallbackKind))
      ? "image"
      : fallbackKind;
    const fileName = raw.fileName ?? raw.file_name ?? raw.name ?? raw.title;
    const mimeType = raw.mimeType ?? raw.mime_type ?? raw.type;
    found.push({
      key: key || `inline-${found.length + 1}`,
      kind,
      ...(typeof fileName === "string" ? { fileName } : {}),
      ...(typeof mimeType === "string" && mimeType.includes("/") ? { mimeType } : {}),
      ...(Buffer.isBuffer(raw.data)
        ? { data: raw.data }
        : Buffer.isBuffer(raw.buffer)
          ? { data: raw.buffer as Buffer }
          : {})
    });
  };
  const visit = (value: unknown, depth: number) => {
    if (value == null || depth > 8) return;
    if (Buffer.isBuffer(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed), depth + 1);
        } catch {
          /* plain text */
        }
      }
      return;
    }
    if (typeof value !== "object") return;
    const raw = value as Record<string, unknown>;
    if (raw.file_key || raw.fileKey || raw.image_key || raw.imageKey) {
      push(raw, raw.image_key || raw.imageKey || raw.tag === "img" ? "image" : "file");
    }
    for (const [key, nested] of Object.entries(raw)) {
      if (key === "data" || key === "buffer") continue;
      visit(nested, depth + 1);
    }
  };
  for (const file of message.files ?? []) push(file, "file");
  for (const image of message.images ?? []) push(image, "image");
  visit(message.content, 0);
  visit(message.raw, 0);
  const seen = new Set<string>();
  return found.filter((file) => {
    const id = `${file.kind}:${file.key}:${file.fileName ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function normalizeInboundMessage<
  T extends {
    content?: string;
    messageType?: string;
    files?: Array<Record<string, unknown>>;
    images?: Array<Record<string, unknown>>;
    raw?: unknown;
  }
>(message: T): T {
  const raw = message.raw && typeof message.raw === "object" ? (message.raw as Record<string, unknown>) : null;
  const nestedMessage =
    raw?.message && typeof raw.message === "object" ? (raw.message as Record<string, unknown>) : raw;
  const messageType =
    message.messageType ||
    (typeof nestedMessage?.message_type === "string" ? nestedMessage.message_type : undefined) ||
    (typeof nestedMessage?.msg_type === "string" ? nestedMessage.msg_type : undefined);
  const content = message.content || (typeof nestedMessage?.content === "string" ? nestedMessage.content : undefined);
  return {
    ...message,
    ...(messageType ? { messageType } : {}),
    ...(content && !message.content ? { content } : {})
  };
}

export function askUserAnswersFromCard(question: AskUserQuestionDto | null, answer: string): Record<string, string> {
  const first = question?.questions[0];
  return { [first?.question ?? "answer"]: answer };
}

export function feishuConversationWebButton(
  webAppUrl: string,
  conversationId: string,
  extra?: { width?: string }
): object {
  const url = new URL(webAppUrl);
  url.searchParams.set("conversation", conversationId);
  return {
    tag: "button",
    element_id: "open_conversation",
    text: { tag: "plain_text", content: "去往网页端" },
    type: "default",
    size: "medium",
    ...(extra?.width ? { width: extra.width } : {}),
    behaviors: [
      {
        type: "open_url",
        default_url: url.toString(),
        pc_url: url.toString(),
        ios_url: url.toString(),
        android_url: url.toString()
      }
    ]
  };
}

export function buildFeishuAskUserCard(
  question: AskUserQuestionDto,
  context: { conversationId: string; runId: string; webAppUrl?: string }
): object {
  const first = question.questions[0];
  const prompt = first
    ? [first.header, first.question]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join("\n\n")
    : "请选择";
  const options = (first?.options ?? []).slice(0, 6);
  const optionList = options
    .map((option, index) => {
      const title = oneLine(option.label) || `选项 ${index + 1}`;
      const extra = [option.description, option.preview].map((part) => part?.trim()).filter(Boolean);
      return extra.length > 0 ? `${index + 1}. **${title}**\n${extra.join("\n")}` : `${index + 1}. **${title}**`;
    })
    .join("\n\n");
  const buttons = options.map((option, index) => ({
    tag: "button",
    element_id: `ask_${index}`,
    text: { tag: "plain_text", content: (oneLine(option.label) || `选项 ${index + 1}`).slice(0, 40) },
    type: "default",
    size: "medium",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: {
          action: "ask_answer",
          conversationId: context.conversationId,
          runId: context.runId,
          answer: option.label
        }
      }
    ]
  }));
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "需要你选择" }, template: "orange" },
    config: { update_multi: true, summary: { content: prompt.slice(0, 60) } },
    body: {
      direction: "vertical",
      vertical_spacing: "8px",
      padding: "12px",
      elements: [
        { tag: "markdown", element_id: "ask_prompt", content: optionList ? `${prompt}\n\n${optionList}` : prompt },
        ...buttons,
        ...(context.webAppUrl
          ? [feishuConversationWebButton(context.webAppUrl, context.conversationId, { width: "fill" })]
          : [])
      ]
    }
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildFeishuAskUserAnsweredCard(question: string, answer: string): object {
  return {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "已选择" }, template: "green" },
    config: { update_multi: true, summary: { content: answer.slice(0, 60) } },
    body: {
      direction: "vertical",
      padding: "12px",
      elements: [{ tag: "markdown", element_id: "ask_prompt", content: `${question}\n\n已选择：${answer}` }]
    }
  };
}
