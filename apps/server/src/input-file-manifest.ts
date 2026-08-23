import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentStore } from "./store.js";

export type InputFileSource = "current_message" | "history" | "branch_copy" | "replay";
export const MAX_INPUT_FILE_BYTES = 20 * 1024 * 1024;

export interface InputFileManifestItem {
  attachmentId: string;
  conversationId: string;
  sourceMessageId: string;
  originalFileName: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: InputFileSource;
}

export interface InputFileManifestError {
  attachmentId: string;
  fileName: string | null;
  message: string;
}

export interface InputFileManifestResult {
  items: InputFileManifestItem[];
  errors: InputFileManifestError[];
}

export interface InputFileManifestFilter {
  fileName?: string;
  mimeType?: string;
  sourceMessageId?: string;
  currentMessageId?: string;
  scope?: "current" | "history";
}

type AttachmentRow = {
  id: string;
  conversation_id: string;
  file_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  relative_path: string;
  status: "ready" | "failed";
};

type LinkedAttachmentRow = AttachmentRow & { source_message_id: string };

/**
 * Produces a verified, read-only view of conversation attachments for Runtime
 * consumers. Invalid files are described to the caller and never included.
 */
export class InputFileManifestService {
  constructor(
    private readonly store: AgentStore,
    private readonly workspaceRoot: string
  ) {}

  async buildForMessage(
    conversationId: string,
    messageId: string,
    source: InputFileSource = "current_message"
  ): Promise<InputFileManifestResult> {
    const message = this.store.getMessage(messageId);
    if (!message || message.conversationId !== conversationId || message.role !== "user") {
      return this.failure("", null, "附件消息不属于当前对话。");
    }
    const rows = this.store.database
      .prepare(
        `SELECT a.*, ma.message_id AS source_message_id
       FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.id
       JOIN messages m ON m.id = ma.message_id AND m.role = 'user'
       WHERE ma.message_id = ?`
      )
      .all(messageId) as LinkedAttachmentRow[];
    return this.build(rows, conversationId, source);
  }

  async buildForAttachments(
    conversationId: string,
    attachmentIds: readonly string[],
    source: InputFileSource = "current_message"
  ): Promise<InputFileManifestResult> {
    if (attachmentIds.length === 0) return { items: [], errors: [] };
    const uniqueIds = [...new Set(attachmentIds)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.store.database
      .prepare(
        `SELECT a.*, ma.message_id AS source_message_id
       FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.id
       JOIN messages m ON m.id = ma.message_id AND m.role = 'user'
       WHERE a.id IN (${placeholders})
       ORDER BY a.created_at, ma.message_id`
      )
      .all(...uniqueIds) as LinkedAttachmentRow[];
    const uniqueRows = rows.filter((row, index) => rows.findIndex((candidate) => candidate.id === row.id) === index);
    const found = new Set(uniqueRows.map((row) => row.id));
    const result = await this.build(uniqueRows, conversationId, source);
    for (const attachmentId of uniqueIds) {
      if (!found.has(attachmentId)) {
        result.errors.push({ attachmentId, fileName: null, message: "附件不存在。" });
      }
    }
    return result;
  }

  async buildForPendingAttachments(
    conversationId: string,
    attachmentIds: readonly string[],
    sourceMessageId: string,
    source: InputFileSource = "current_message"
  ): Promise<InputFileManifestResult> {
    if (attachmentIds.length === 0) return { items: [], errors: [] };
    const uniqueIds = [...new Set(attachmentIds)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.store.database
      .prepare(
        `SELECT a.*, ? AS source_message_id
       FROM attachments a
       WHERE a.id IN (${placeholders})
       ORDER BY a.created_at`
      )
      .all(sourceMessageId, ...uniqueIds) as LinkedAttachmentRow[];
    const found = new Set(rows.map((row) => row.id));
    const result = await this.build(rows, conversationId, source);
    for (const attachmentId of uniqueIds) {
      if (!found.has(attachmentId)) result.errors.push({ attachmentId, fileName: null, message: "附件不存在。" });
    }
    return result;
  }

  async listForConversation(
    conversationId: string,
    filter: InputFileManifestFilter = {}
  ): Promise<InputFileManifestResult> {
    const rows = this.store.database
      .prepare(
        `SELECT a.*, ma.message_id AS source_message_id
       FROM attachments a
       JOIN message_attachments ma ON ma.attachment_id = a.id
       JOIN messages m ON m.id = ma.message_id AND m.role = 'user'
       WHERE a.conversation_id = ?
       ORDER BY a.created_at, ma.message_id`
      )
      .all(conversationId) as LinkedAttachmentRow[];
    const normalizedName = filter.fileName?.trim().toLowerCase();
    const normalizedMime = filter.mimeType?.trim().toLowerCase();
    const selected = rows.filter((row) => {
      const isCurrent = filter.currentMessageId === row.source_message_id;
      if (filter.scope === "current" && !isCurrent) return false;
      if (filter.scope === "history" && isCurrent) return false;
      if (filter.sourceMessageId && row.source_message_id !== filter.sourceMessageId) return false;
      if (normalizedName && !row.file_name.toLowerCase().includes(normalizedName)) return false;
      return !normalizedMime || row.mime_type.toLowerCase() === normalizedMime;
    });
    const output: InputFileManifestResult = { items: [], errors: [] };
    for (const row of selected) {
      const source: InputFileSource = row.source_message_id === filter.currentMessageId ? "current_message" : "history";
      const checked = await this.validate(row, conversationId, source);
      if ("item" in checked) output.items.push(checked.item);
      else output.errors.push(checked.error);
    }
    return output;
  }

  private async build(
    rows: LinkedAttachmentRow[],
    conversationId: string,
    source: InputFileSource
  ): Promise<InputFileManifestResult> {
    const output: InputFileManifestResult = { items: [], errors: [] };
    for (const row of rows) {
      const checked = await this.validate(row, conversationId, source);
      if ("item" in checked) output.items.push(checked.item);
      else output.errors.push(checked.error);
    }
    return output;
  }

  private async validate(
    row: LinkedAttachmentRow,
    conversationId: string,
    source: InputFileSource
  ): Promise<{ item: InputFileManifestItem } | { error: InputFileManifestError }> {
    const failure = (message: string) => ({ error: { attachmentId: row.id, fileName: row.file_name, message } });
    if (row.conversation_id !== conversationId) return failure("附件不属于当前对话，无法使用。");
    if (!row.source_message_id) return failure("附件尚未绑定到消息，无法使用。");
    if (row.status !== "ready") return failure("附件尚未准备完成，无法使用。");
    if (!Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_INPUT_FILE_BYTES) {
      return failure("附件大小超出 20 MB 限制，无法使用。");
    }
    if (!row.relative_path || path.isAbsolute(row.relative_path)) return failure("附件路径不安全，无法使用。");

    const conversationRoot = path.resolve(this.workspaceRoot, conversationId);
    const target = path.resolve(conversationRoot, row.relative_path);
    if (!isWithin(target, conversationRoot)) return failure("附件路径超出当前对话工作区，已拒绝使用。");

    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      const linkMetadata = await lstat(target);
      if (!linkMetadata.isFile()) return failure("附件不是普通文件，无法使用。");
      const [realTarget, realConversationRoot] = await Promise.all([realpath(target), realpath(conversationRoot)]);
      if (!isWithin(realTarget, realConversationRoot)) return failure("附件实际路径超出当前对话工作区，已拒绝使用。");
      metadata = await stat(realTarget);
    } catch {
      return failure("附件文件缺失，无法使用。");
    }
    if (metadata.size !== row.size) return failure("附件大小与记录不一致，无法使用。");

    let actualHash: string;
    try {
      actualHash = await hashFile(target);
    } catch {
      return failure("附件无法读取，无法使用。");
    }
    if (actualHash !== row.sha256) return failure("附件内容校验失败，无法使用。");

    return {
      item: {
        attachmentId: row.id,
        conversationId: row.conversation_id,
        sourceMessageId: row.source_message_id,
        originalFileName: row.file_name,
        relativePath: row.relative_path,
        mimeType: row.mime_type,
        size: row.size,
        sha256: row.sha256,
        source
      }
    };
  }

  private failure(attachmentId: string, fileName: string | null, message: string): InputFileManifestResult {
    return { items: [], errors: [{ attachmentId, fileName, message }] };
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function hashFile(filePath: string): Promise<string> {
  const buffer = await (await import("node:fs/promises")).readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}
