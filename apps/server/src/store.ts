import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AttachmentDto,
  ConversationDetailDto,
  ConversationSummaryDto,
  MessageDto,
  ParticipantDto,
  RunMode,
  RunStatus,
  ToolEventDto
} from "@fieldnote/contracts";
import type { SqliteDatabase } from "./database.js";
import { getAgentProfile, getAgentProfileSummary, isAgentProfileId, LEGACY_PROFILE_ID } from "./agent-profiles.js";
import { AssistantBlockStore } from "./assistant-block-store.js";

type ParticipantRow = {
  id: string;
  display_name: string;
  created_at: number;
};

type ConversationRow = {
  id: string;
  title: string;
  channel: "web" | "feishu";
  profile_id: string;
  participant_id: string;
  active_branch_id: string;
  pinned: number;
  temporary: number;
  expires_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  status: RunStatus | null;
  last_message_preview: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  branch_id: string;
  run_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  status: MessageDto["status"];
  reasoning_summary: string | null;
  sdk_uuid: string | null;
  client_message_id: string | null;
  created_at: number;
  updated_at: number;
};

type AttachmentRow = {
  id: string;
  message_id: string | null;
  file_name: string;
  mime_type: string;
  size: number;
  status: "ready" | "failed";
  created_at: number;
  relative_path: string;
  presented: number;
};

type ToolRow = {
  id: string;
  run_id: string;
  tool_use_id: string;
  tool_name: string;
  status: ToolEventDto["status"];
  input_summary: string | null;
  output_summary: string | null;
  started_at: number;
  completed_at: number | null;
};

export interface RunRecord {
  id: string;
  conversationId: string;
  branchId: string;
  userMessageId: string;
  assistantMessageId: string;
  mode: RunMode;
  status: RunStatus;
  profileRevision: number;
  supersededAt: string | null;
}

export interface BranchRuntimeState {
  id: string;
  conversationId: string;
  sdkSessionId: string | null;
  resumeSessionAt: string | null;
}

export interface StoredAttachment extends AttachmentDto {
  relativePath: string;
}

export class InputAttachmentOverwriteError extends Error {
  readonly statusCode = 409;
}

/**
 * The machine owner's participant id — also where all pre-participant history lives.
 * Single constant on purpose: the eligibility rule exists both as TS comparisons and as
 * an interpolated SQL mirror, and a drifted literal would create a phantom participant.
 */
export const DEFAULT_PARTICIPANT_ID = "default";

const toIso = (value: number): string => new Date(value).toISOString();
const cleanPreview = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);

export class AgentStore {
  readonly assistantBlocks: AssistantBlockStore;

  constructor(readonly database: SqliteDatabase) {
    this.assistantBlocks = new AssistantBlockStore(database);
  }

  getSetting<T>(key: string): T | null {
    const row = this.database.prepare("SELECT value_json FROM local_settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.database
      .prepare(
        `INSERT INTO local_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  // ── Participants ──────────────────────────────────────────────────────────
  // The people axis, orthogonal to agent profiles. "Current participant" is a
  // local UI setting (like research.enabled), not an auth concept: this is a
  // single-machine workbench where participants take turns at the keyboard.

  listParticipants(): ParticipantDto[] {
    const rows = this.database.prepare("SELECT * FROM participants ORDER BY created_at ASC").all() as ParticipantRow[];
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      createdAt: toIso(row.created_at)
    }));
  }

  getParticipant(id: string): ParticipantDto | null {
    const row = this.database.prepare("SELECT * FROM participants WHERE id = ?").get(id) as ParticipantRow | undefined;
    return row ? { id: row.id, displayName: row.display_name, createdAt: toIso(row.created_at) } : null;
  }

  createParticipant(displayName: string): ParticipantDto {
    const name = displayName.trim().slice(0, 100);
    if (!name) throw new Error("Participant name is required");
    const id = randomUUID();
    this.database
      .prepare("INSERT INTO participants (id, display_name, created_at) VALUES (?, ?, ?)")
      .run(id, name, Date.now());
    const participant = this.getParticipant(id);
    if (!participant) throw new Error("Failed to create participant");
    return participant;
  }

  /** Falls back to the default participant when the stored id no longer resolves. */
  currentParticipantId(): string {
    const stored = this.getSetting<string>("participants.current");
    if (stored && this.getParticipant(stored)) return stored;
    return DEFAULT_PARTICIPANT_ID;
  }

  setCurrentParticipant(id: string): ParticipantDto {
    const participant = this.getParticipant(id);
    if (!participant) throw new Error("Participant not found");
    this.setSetting("participants.current", id);
    return participant;
  }

  createConversation(
    channel: "web" | "feishu" = "web",
    title = "新对话",
    options: { temporary?: boolean; expiresAt?: number; profileId?: string; participantId?: string } = {}
  ): ConversationDetailDto {
    const conversationId = randomUUID();
    const branchId = randomUUID();
    const timestamp = Date.now();
    // Web-origin conversations belong to whoever is currently at the keyboard; channel
    // and fork call sites pass an explicit participant instead (Feishu is outside the
    // participant pilot and always writes to the default participant).
    const participantId = options.participantId ?? this.currentParticipantId();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO conversations
             (id, title, channel, profile_id, participant_id, active_branch_id, temporary, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conversationId,
          title,
          channel,
          options.profileId ?? "local-operator",
          participantId,
          branchId,
          options.temporary ? 1 : 0,
          options.expiresAt ?? null,
          timestamp,
          timestamp
        );
      this.database
        .prepare(
          `INSERT INTO branches (id, conversation_id, created_at)
           VALUES (?, ?, ?)`
        )
        .run(branchId, conversationId, timestamp);
    })();
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Failed to create conversation");
    return conversation;
  }

  listConversations(state: "active" | "archived", query = "", participantId?: string): ConversationSummaryDto[] {
    const archived = state === "archived" ? 1 : 0;
    const term = query.trim();
    const like = `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    // The sidebar shows only the current participant's conversations — the most
    // important isolation query: without it every participant scrolls through every
    // other participant's threads. Deep links (getConversation) stay unscoped.
    const participant = participantId ?? this.currentParticipantId();
    const rows = this.database
      .prepare(
        `SELECT c.*,
          (SELECT r.status FROM runs r
           WHERE r.conversation_id = c.id AND r.status IN ('queued','running','interrupting')
           ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'interrupting' THEN 0 ELSE 1 END,
             r.created_at ASC LIMIT 1) AS status,
          (SELECT m.content FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_preview
         FROM conversations c
         WHERE c.temporary = 0 AND (c.archived_at IS NOT NULL) = ?
           AND c.participant_id = ?
           AND EXISTS (
             SELECT 1 FROM messages lm
             WHERE lm.conversation_id = c.id AND lm.role = 'user'
           )
           AND (? = '' OR c.title LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM messages sm
               WHERE sm.conversation_id = c.id AND sm.content LIKE ? ESCAPE '\\'
             ))
         ORDER BY c.pinned DESC, c.updated_at DESC
         LIMIT 200`
      )
      .all(archived, participant, term, like, like) as ConversationRow[];
    return rows.map((row) => this.toConversationSummary(row));
  }

  getConversation(conversationId: string): ConversationDetailDto | null {
    const row = this.database
      .prepare(
        `SELECT c.*,
          (SELECT r.status FROM runs r
           WHERE r.conversation_id = c.id AND r.status IN ('queued','running','interrupting')
           ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'interrupting' THEN 0 ELSE 1 END,
             r.created_at ASC LIMIT 1) AS status,
          (SELECT m.content FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_preview
         FROM conversations c WHERE c.id = ?`
      )
      .get(conversationId) as ConversationRow | undefined;
    if (!row) return null;

    const messages = this.database
      .prepare(
        `SELECT * FROM messages WHERE branch_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(row.active_branch_id) as MessageRow[];
    const attachments = this.database
      .prepare(
        `SELECT a.*, ma.message_id AS linked_message_id
         FROM attachments a
         JOIN message_attachments ma ON ma.attachment_id = a.id
         JOIN messages m ON m.id = ma.message_id
         WHERE m.branch_id = ? ORDER BY a.created_at ASC`
      )
      .all(row.active_branch_id) as Array<AttachmentRow & { linked_message_id: string }>;
    const attachmentsByMessage = new Map<string, AttachmentDto[]>();
    for (const attachment of attachments) {
      const values = attachmentsByMessage.get(attachment.linked_message_id) ?? [];
      values.push({ ...this.toAttachment(attachment), messageId: attachment.linked_message_id });
      attachmentsByMessage.set(attachment.linked_message_id, values);
    }
    const tools = this.database
      .prepare(
        `SELECT te.* FROM tool_events te
         JOIN runs r ON r.id = te.run_id
         WHERE r.conversation_id = ?
         ORDER BY te.started_at ASC`
      )
      .all(conversationId) as ToolRow[];
    const activeRun = this.database
      .prepare(
        `SELECT id FROM runs WHERE conversation_id = ?
         AND status IN ('queued','running','interrupting')
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'interrupting' THEN 0 ELSE 1 END,
           created_at ASC LIMIT 1`
      )
      .get(conversationId) as { id: string } | undefined;
    const queuedRuns = this.database
      .prepare(
        `SELECT id, user_message_id FROM runs
         WHERE conversation_id = ? AND status = 'queued' AND mode = 'queue'
           AND EXISTS (
             SELECT 1 FROM runs active
             WHERE active.conversation_id = runs.conversation_id
               AND active.status IN ('running','interrupting')
           )
         ORDER BY created_at ASC`
      )
      .all(conversationId) as Array<{ id: string; user_message_id: string }>;
    const eventCursor = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log WHERE conversation_id = ?")
      .get(conversationId) as { sequence: number };

    return {
      ...this.toConversationSummary(row),
      activeBranchId: row.active_branch_id,
      messages: messages.map((message) => ({
        ...this.toMessage(message),
        attachments: attachmentsByMessage.get(message.id) ?? []
      })),
      toolEvents: tools.map((tool) => this.toTool(tool)),
      activeRunId: activeRun?.id ?? null,
      queuedRuns: queuedRuns.map((run) => ({ runId: run.id, userMessageId: run.user_message_id })),
      lastEventSequence: eventCursor.sequence
    };
  }

  updateConversation(
    conversationId: string,
    input: { title?: string; pinned?: boolean; archived?: boolean }
  ): ConversationDetailDto | null {
    const current = this.getConversation(conversationId);
    if (!current) return null;
    const title = input.title?.trim().slice(0, 120) || current.title;
    const pinned = input.pinned === undefined ? current.pinned : input.pinned;
    const archivedAt =
      input.archived === undefined ? (current.archived ? Date.now() : null) : input.archived ? Date.now() : null;
    this.database
      .prepare(
        `UPDATE conversations SET title = ?, pinned = ?, archived_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(title, pinned ? 1 : 0, archivedAt, Date.now(), conversationId);
    return this.getConversation(conversationId);
  }

  deleteConversation(conversationId: string): boolean {
    return this.database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId).changes > 0;
  }

  listExpiredTemporaryConversationIds(now = Date.now()): string[] {
    const rows = this.database
      .prepare(
        `SELECT id FROM conversations
         WHERE temporary = 1 AND expires_at IS NOT NULL AND expires_at <= ?
         ORDER BY expires_at ASC`
      )
      .all(now) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  deleteSessionTranscriptsForConversation(conversationId: string): void {
    const rows = this.database
      .prepare("SELECT sdk_session_id FROM branches WHERE conversation_id = ? AND sdk_session_id IS NOT NULL")
      .all(conversationId) as Array<{ sdk_session_id: string }>;
    const sessionIds = [...new Set(rows.map((row) => row.sdk_session_id))];
    if (sessionIds.length === 0) return;
    const placeholders = sessionIds.map(() => "?").join(",");
    this.database.transaction(() => {
      this.database
        .prepare(`DELETE FROM session_store_entries WHERE session_id IN (${placeholders})`)
        .run(...sessionIds);
      this.database
        .prepare(`DELETE FROM session_store_summaries WHERE session_id IN (${placeholders})`)
        .run(...sessionIds);
    })();
  }

  createRun(
    conversationId: string,
    content: string,
    mode: RunMode,
    attachmentIds: string[] = [],
    clientMessageId?: string
  ): RunRecord {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    this.assertAttachmentIds(conversationId, attachmentIds);
    const lastCreatedAt = Math.max(0, ...conversation.messages.map((message) => new Date(message.createdAt).getTime()));
    const timestamp = Math.max(Date.now(), lastCreatedAt + 1);
    const runId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const lastMessage = conversation.messages.at(-1);
    const profileId = isAgentProfileId(conversation.profileId) ? conversation.profileId : LEGACY_PROFILE_ID;
    const profileRevision = getAgentProfile(profileId).revision;

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO runs
             (id, conversation_id, branch_id, user_message_id, assistant_message_id, mode, profile_revision, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
        )
        .run(
          runId,
          conversationId,
          conversation.activeBranchId,
          userMessageId,
          assistantMessageId,
          mode,
          profileRevision,
          timestamp
        );
      this.database
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, branch_id, run_id, parent_message_id, role, content, status,
              client_message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'user', ?, 'completed', ?, ?, ?)`
        )
        .run(
          userMessageId,
          conversationId,
          conversation.activeBranchId,
          runId,
          lastMessage?.id ?? null,
          content,
          clientMessageId ?? null,
          timestamp,
          timestamp
        );
      this.database
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, branch_id, run_id, parent_message_id, role, content, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'assistant', '', 'queued', ?, ?)`
        )
        .run(
          assistantMessageId,
          conversationId,
          conversation.activeBranchId,
          runId,
          userMessageId,
          timestamp + 1,
          timestamp + 1
        );
      if (attachmentIds.length > 0) {
        const link = this.database.prepare(
          `INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
           SELECT ?, id FROM attachments WHERE id = ? AND conversation_id = ?`
        );
        for (const attachmentId of attachmentIds) link.run(userMessageId, attachmentId, conversationId);
      }
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, conversationId);
    })();

    return {
      id: runId,
      conversationId,
      branchId: conversation.activeBranchId,
      userMessageId,
      assistantMessageId,
      mode,
      status: "queued",
      profileRevision,
      supersededAt: null
    };
  }

  countToolEvents(runId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM tool_events WHERE run_id = ?").get(runId) as {
      count: number;
    };
    return row.count;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | {
          id: string;
          conversation_id: string;
          branch_id: string;
          user_message_id: string;
          assistant_message_id: string;
          mode: RunMode;
          status: RunStatus;
          profile_revision: number;
          superseded_at: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      mode: row.mode,
      status: row.status,
      profileRevision: row.profile_revision,
      supersededAt: row.superseded_at === null ? null : toIso(row.superseded_at)
    };
  }

  getMessage(messageId: string): MessageDto | null {
    const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!row) return null;
    const attachments = this.database
      .prepare(
        `SELECT a.* FROM attachments a
         JOIN message_attachments ma ON ma.attachment_id = a.id
         WHERE ma.message_id = ? ORDER BY a.created_at`
      )
      .all(messageId) as AttachmentRow[];
    return {
      ...this.toMessage(row),
      attachments: attachments.map((item) => ({ ...this.toAttachment(item), messageId }))
    };
  }

  getMessagesForRun(runId: string): MessageDto[] {
    const rows = this.database
      .prepare("SELECT id FROM messages WHERE run_id = ? ORDER BY created_at ASC, id ASC")
      .all(runId) as Array<{ id: string }>;
    return rows.map((row) => this.getMessage(row.id)).filter((message): message is MessageDto => Boolean(message));
  }

  getMessageByClientMessageId(conversationId: string, clientMessageId: string): MessageDto | null {
    const row = this.database
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?")
      .get(conversationId, clientMessageId) as MessageRow | undefined;
    return row ? this.getMessage(row.id) : null;
  }

  createSupplementMessage(input: {
    runId: string;
    content: string;
    attachmentIds?: string[];
    clientMessageId?: string;
    messageId?: string;
  }): MessageDto {
    const run = this.getRun(input.runId);
    if (!run) throw new Error("Run not found");
    const existing = input.clientMessageId
      ? this.getMessageByClientMessageId(run.conversationId, input.clientMessageId)
      : null;
    if (existing) return existing;
    const conversation = this.getConversation(run.conversationId);
    if (!conversation || conversation.activeBranchId !== run.branchId) throw new Error("Active branch changed");
    const normalized = input.content.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (!normalized && attachmentIds.length === 0) throw new Error("Message cannot be empty");
    this.assertAttachmentIds(run.conversationId, attachmentIds);
    const assistant = this.getMessage(run.assistantMessageId);
    if (!assistant) throw new Error("Assistant placeholder not found");
    const previousMessage = conversation.messages.filter((message) => message.id !== assistant.id).at(-1);
    const lastCreatedAt = Math.max(0, ...conversation.messages.map((message) => new Date(message.createdAt).getTime()));
    const timestamp = Math.max(Date.now(), lastCreatedAt + 1);
    const messageId = input.messageId ?? randomUUID();

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, branch_id, run_id, parent_message_id, role, content, status,
              client_message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'user', ?, 'completed', ?, ?, ?)`
        )
        .run(
          messageId,
          run.conversationId,
          run.branchId,
          run.id,
          previousMessage?.id ?? run.userMessageId,
          normalized,
          input.clientMessageId ?? null,
          timestamp,
          timestamp
        );
      const link = this.database.prepare(
        `INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
         SELECT ?, id FROM attachments WHERE id = ? AND conversation_id = ?`
      );
      for (const attachmentId of attachmentIds) link.run(messageId, attachmentId, run.conversationId);
      this.database
        .prepare("UPDATE messages SET parent_message_id = ?, created_at = ?, updated_at = ? WHERE id = ?")
        .run(messageId, timestamp + 1, timestamp + 1, run.assistantMessageId);
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, run.conversationId);
    })();

    const message = this.getMessage(messageId);
    if (!message) throw new Error("Failed to create supplement message");
    return message;
  }

  convertQueuedRunToSupplement(queuedRunId: string, activeRunId: string): MessageDto {
    const queuedRun = this.getRun(queuedRunId);
    const activeRun = this.getRun(activeRunId);
    if (!queuedRun || queuedRun.status !== "queued" || queuedRun.mode !== "queue") {
      throw new Error("Queued run not found");
    }
    if (!activeRun || activeRun.status !== "running" || activeRun.conversationId !== queuedRun.conversationId) {
      throw new Error("Active run not found");
    }
    if (activeRun.branchId !== queuedRun.branchId) throw new Error("Active branch changed");
    const queuedMessage = this.getMessage(queuedRun.userMessageId);
    if (!queuedMessage) throw new Error("Queued message not found");
    const activeAssistant = this.database
      .prepare("SELECT parent_message_id, created_at FROM messages WHERE id = ?")
      .get(activeRun.assistantMessageId) as { parent_message_id: string | null; created_at: number } | undefined;
    if (!activeAssistant) throw new Error("Assistant placeholder not found");
    const queuedCreatedAt = new Date(queuedMessage.createdAt).getTime();
    const timestamp = Math.max(Date.now(), queuedCreatedAt + 1, activeAssistant.created_at);

    this.database.transaction(() => {
      this.database.prepare("DELETE FROM messages WHERE id = ?").run(queuedRun.assistantMessageId);
      this.database
        .prepare(
          `UPDATE messages SET run_id = ?, branch_id = ?, parent_message_id = ?, status = 'completed', updated_at = ?
           WHERE id = ?`
        )
        .run(activeRun.id, activeRun.branchId, activeAssistant.parent_message_id, timestamp, queuedRun.userMessageId);
      this.database
        .prepare("UPDATE messages SET parent_message_id = ?, created_at = ?, updated_at = ? WHERE id = ?")
        .run(queuedRun.userMessageId, timestamp + 1, timestamp + 1, activeRun.assistantMessageId);
      this.database
        .prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?")
        .run(timestamp, queuedRun.id);
      this.database
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(timestamp, activeRun.conversationId);
    })();

    const message = this.getMessage(queuedRun.userMessageId);
    if (!message) throw new Error("Failed to steer queued message");
    return message;
  }

  updateQueuedRunContent(runId: string, content: string): MessageDto | null {
    const run = this.getRun(runId);
    if (!run || run.status !== "queued" || run.mode !== "queue") return null;
    const message = this.getMessage(run.userMessageId);
    if (!message) return null;
    const normalized = content.trim();
    if (!normalized && message.attachments.length === 0) return null;
    this.replaceMessageText(run.userMessageId, normalized);
    this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now(), run.conversationId);
    return this.getMessage(run.userMessageId);
  }

  deleteQueuedRun(runId: string): boolean {
    const run = this.getRun(runId);
    if (!run || run.status !== "queued" || run.mode !== "queue") return false;
    const timestamp = Date.now();
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM messages WHERE id = ?").run(run.assistantMessageId);
      this.database.prepare("DELETE FROM messages WHERE id = ?").run(run.userMessageId);
      this.database
        .prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?")
        .run(timestamp, run.id);
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, run.conversationId);
    })();
    return true;
  }

  prepareQueuedRunForStart(runId: string): void {
    const run = this.getRun(runId);
    if (!run || run.status !== "queued" || run.mode !== "queue") return;
    const previous = this.database
      .prepare(
        `SELECT m.id, m.created_at FROM messages m
         WHERE m.branch_id = ?
           AND (m.run_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM runs queued WHERE queued.id = m.run_id AND queued.status = 'queued'
           ))
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1`
      )
      .get(run.branchId) as { id: string; created_at: number } | undefined;
    const timestamp = Math.max(Date.now(), (previous?.created_at ?? 0) + 1);
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE messages SET parent_message_id = ?, created_at = ?, updated_at = ? WHERE id = ?")
        .run(previous?.id ?? null, timestamp, timestamp, run.userMessageId);
      this.database
        .prepare("UPDATE messages SET parent_message_id = ?, created_at = ?, updated_at = ? WHERE id = ?")
        .run(run.userMessageId, timestamp + 1, timestamp + 1, run.assistantMessageId);
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, run.conversationId);
    })();
  }

  setRunStatus(runId: string, status: RunStatus, error?: string, totalCostUsd?: number): void {
    const current = this.getRun(runId)?.status;
    const terminal = new Set<RunStatus>(["completed", "failed", "interrupted"]);
    if (current && terminal.has(current) && !terminal.has(status)) return;
    const timestamp = Date.now();
    const startedAt = status === "running" ? timestamp : null;
    const finishedAt = ["interrupted", "completed", "failed"].includes(status) ? timestamp : null;
    this.database
      .prepare(
        `UPDATE runs SET status = ?, error = COALESCE(?, error),
           total_cost_usd = COALESCE(?, total_cost_usd),
           started_at = COALESCE(started_at, ?), finished_at = COALESCE(?, finished_at)
         WHERE id = ?`
      )
      .run(status, error ?? null, totalCostUsd ?? null, startedAt, finishedAt, runId);
  }

  setMessageStatus(messageId: string, status: MessageDto["status"]): void {
    this.database
      .prepare("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), messageId);
  }

  appendMessageText(messageId: string, delta: string): void {
    this.database
      .prepare("UPDATE messages SET content = content || ?, updated_at = ? WHERE id = ?")
      .run(delta, Date.now(), messageId);
  }

  replaceMessageText(messageId: string, content: string): void {
    this.database
      .prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?")
      .run(content, Date.now(), messageId);
  }

  appendReasoningSummary(messageId: string, delta: string): void {
    this.database
      .prepare(
        "UPDATE messages SET reasoning_summary = COALESCE(reasoning_summary, '') || ?, updated_at = ? WHERE id = ?"
      )
      .run(delta, Date.now(), messageId);
  }

  setMessageSdkUuid(messageId: string, sdkUuid: string): void {
    this.database.prepare("UPDATE messages SET sdk_uuid = ? WHERE id = ?").run(sdkUuid, messageId);
  }

  getBranchRuntime(branchId: string): BranchRuntimeState | null {
    const row = this.database.prepare("SELECT * FROM branches WHERE id = ?").get(branchId) as
      | {
          id: string;
          conversation_id: string;
          sdk_session_id: string | null;
          resume_session_at: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          conversationId: row.conversation_id,
          sdkSessionId: row.sdk_session_id,
          resumeSessionAt: row.resume_session_at
        }
      : null;
  }

  updateBranchSession(branchId: string, sessionId: string): void {
    this.database
      .prepare("UPDATE branches SET sdk_session_id = ?, resume_session_at = NULL WHERE id = ?")
      .run(sessionId, branchId);
  }

  upsertToolEvent(input: {
    runId: string;
    toolUseId: string;
    toolName: string;
    status: ToolEventDto["status"];
    inputSummary?: string;
    outputSummary?: string;
  }): ToolEventDto {
    const existing = this.database
      .prepare("SELECT * FROM tool_events WHERE run_id = ? AND tool_use_id = ?")
      .get(input.runId, input.toolUseId) as ToolRow | undefined;
    const timestamp = Date.now();
    if (existing) {
      this.database
        .prepare(
          `UPDATE tool_events SET status = ?, input_summary = COALESCE(?, input_summary),
           output_summary = COALESCE(?, output_summary), completed_at = ? WHERE id = ?`
        )
        .run(
          input.status,
          input.inputSummary ?? null,
          input.outputSummary ?? null,
          input.status === "running" ? null : timestamp,
          existing.id
        );
    } else {
      this.database
        .prepare(
          `INSERT INTO tool_events
             (id, run_id, tool_use_id, tool_name, status, input_summary, output_summary, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          input.runId,
          input.toolUseId,
          input.toolName,
          input.status,
          input.inputSummary ?? null,
          input.outputSummary ?? null,
          timestamp,
          input.status === "running" ? null : timestamp
        );
    }
    const row = this.database
      .prepare("SELECT * FROM tool_events WHERE run_id = ? AND tool_use_id = ?")
      .get(input.runId, input.toolUseId) as ToolRow;
    return this.toTool(row);
  }

  attachGeneratedFile(input: {
    conversationId: string;
    messageId: string;
    fileName: string;
    mimeType: string;
    size: number;
    sha256: string;
    relativePath: string;
    presented?: boolean;
  }): StoredAttachment {
    const existing = this.database
      .prepare("SELECT * FROM attachments WHERE conversation_id = ? AND relative_path = ?")
      .get(input.conversationId, input.relativePath) as AttachmentRow | undefined;
    if (existing) {
      const linkedToUser = this.database
        .prepare(
          `SELECT 1 FROM message_attachments ma
         JOIN messages m ON m.id = ma.message_id
         WHERE ma.attachment_id = ? AND m.role = 'user' LIMIT 1`
        )
        .get(existing.id);
      if (linkedToUser)
        throw new InputAttachmentOverwriteError("Generated files cannot overwrite a user input attachment");
    }
    const attachment = existing
      ? this.updateAttachment(existing.id, {
          ...input,
          presented: input.presented === true || existing.presented === 1
        })
      : this.createAttachment({
          conversationId: input.conversationId,
          fileName: input.fileName,
          storedName: path.basename(input.relativePath),
          mimeType: input.mimeType,
          size: input.size,
          sha256: input.sha256,
          relativePath: input.relativePath,
          presented: input.presented === true
        });
    this.database
      .prepare(
        `INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
         SELECT ?, id FROM attachments WHERE id = ? AND conversation_id = ?`
      )
      .run(input.messageId, attachment.id, input.conversationId);
    return { ...attachment, messageId: input.messageId };
  }

  getStoredAttachment(id: string): StoredAttachment | null {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    return row ? { ...this.toAttachment(row), relativePath: row.relative_path } : null;
  }

  getStoredAttachmentsForMessage(messageId: string): StoredAttachment[] {
    const rows = this.database
      .prepare(
        `SELECT a.* FROM attachments a
         JOIN message_attachments ma ON ma.attachment_id = a.id
         WHERE ma.message_id = ? ORDER BY a.created_at`
      )
      .all(messageId) as AttachmentRow[];
    return rows.map((row) => ({ ...this.toAttachment(row), relativePath: row.relative_path, messageId }));
  }

  private updateAttachment(
    id: string,
    input: {
      fileName: string;
      mimeType: string;
      size: number;
      sha256: string;
      presented?: boolean;
    }
  ): StoredAttachment {
    this.database
      .prepare(
        "UPDATE attachments SET file_name = ?, mime_type = ?, size = ?, sha256 = ?, status = 'ready', presented = ? WHERE id = ?"
      )
      .run(input.fileName, input.mimeType, input.size, input.sha256, input.presented === true ? 1 : 0, id);
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow;
    return { ...this.toAttachment(row), relativePath: row.relative_path };
  }

  createAttachment(input: {
    conversationId: string;
    fileName: string;
    storedName: string;
    mimeType: string;
    size: number;
    sha256: string;
    relativePath: string;
    presented?: boolean;
  }): StoredAttachment {
    const id = randomUUID();
    const timestamp = Date.now();
    const presented = input.presented !== false;
    this.database
      .prepare(
        `INSERT INTO attachments
           (id, conversation_id, file_name, stored_name, mime_type, size, sha256, relative_path, status, presented, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.fileName,
        input.storedName,
        input.mimeType,
        input.size,
        input.sha256,
        input.relativePath,
        presented ? 1 : 0,
        timestamp
      );
    return {
      id,
      messageId: null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      status: "ready",
      presented,
      createdAt: toIso(timestamp),
      relativePath: input.relativePath
    };
  }

  getAttachments(ids: string[]): StoredAttachment[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.database
      .prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`)
      .all(...ids) as AttachmentRow[];
    return rows.map((row) => ({ ...this.toAttachment(row), relativePath: row.relative_path }));
  }

  deleteAttachment(attachmentId: string): StoredAttachment | null {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId) as
      | AttachmentRow
      | undefined;
    if (!row) return null;
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
    return { ...this.toAttachment(row), relativePath: row.relative_path };
  }

  registerInboundEvent(channel: string, idempotencyKey: string, payload: unknown): boolean {
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO inbound_events (channel, idempotency_key, payload_json, received_at)
         VALUES (?, ?, ?, ?)`
        )
        .run(channel, idempotencyKey, JSON.stringify(payload), Date.now()).changes > 0
    );
  }

  getChannelBinding(channel: string, externalKey: string): string | null {
    const row = this.database
      .prepare("SELECT conversation_id FROM channel_bindings WHERE channel = ? AND external_key = ?")
      .get(channel, externalKey) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  setChannelBinding(channel: string, externalKey: string, conversationId: string, metadata: unknown = {}): void {
    const timestamp = Date.now();
    this.database
      .prepare(
        `INSERT INTO channel_bindings
           (channel, external_key, conversation_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, external_key) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .run(channel, externalKey, conversationId, JSON.stringify(metadata), timestamp, timestamp);
  }

  createBranchFromMessage(
    messageId: string,
    options: { asNewConversation: boolean; includeTarget?: boolean; title?: string }
  ): ConversationDetailDto {
    const source = this.getMessage(messageId);
    if (!source) throw new Error("Message not found");
    const sourceConversation = this.getConversation(source.conversationId);
    if (!sourceConversation) throw new Error("Conversation not found");
    const sourceBranch = this.getBranchRuntime(source.branchId);
    if (!sourceBranch) throw new Error("Branch not found");

    const targetConversation = options.asNewConversation
      ? this.createConversation(sourceConversation.channel, options.title ?? `${sourceConversation.title} · 分支`, {
          profileId: sourceConversation.profileId,
          // A fork continues the same person's thread regardless of who is currently
          // selected in the sidebar.
          participantId: sourceConversation.participantId
        })
      : sourceConversation;
    const targetBranchId = options.asNewConversation ? targetConversation.activeBranchId : randomUUID();
    const timestamp = Date.now();
    const targetIndex = sourceConversation.messages.findIndex((message) => message.id === source.id);
    if (targetIndex < 0) throw new Error("Message is not in the active branch");
    const includeTarget = options.includeTarget ?? true;
    const sourceMessages = sourceConversation.messages.slice(0, targetIndex + (includeTarget ? 1 : 0));
    const removedRunIds = [
      ...new Set(
        sourceConversation.messages
          .slice(targetIndex + (includeTarget ? 1 : 0))
          .map((message) => message.runId)
          .filter((runId): runId is string => Boolean(runId))
      )
    ];
    const resumeMessage = sourceMessages.at(-1);
    // A new conversation has a different SDK project key/cwd. Rehydrate its visible
    // transcript into the first prompt instead of trying to resume across projects.
    // Only resume when the exact last visible application message has a matching
    // SDK chain UUID. Older rows without that boundary fall back to rehydrating
    // visible history, which is safer than leaking messages past the edit point.
    const resumeSessionAt = options.asNewConversation ? null : (resumeMessage?.sdkUuid ?? null);
    const sdkSessionId = options.asNewConversation || !resumeSessionAt ? null : sourceBranch.sdkSessionId;

    this.database.transaction(() => {
      if (!options.asNewConversation) {
        this.database
          .prepare(
            `INSERT INTO branches
               (id, conversation_id, parent_branch_id, forked_from_message_id, sdk_session_id, resume_session_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            targetBranchId,
            source.conversationId,
            source.branchId,
            source.id,
            sdkSessionId,
            resumeSessionAt,
            timestamp
          );
      } else {
        this.database
          .prepare(
            `UPDATE branches SET parent_branch_id = ?, forked_from_message_id = ?,
             sdk_session_id = ?, resume_session_at = ? WHERE id = ?`
          )
          .run(source.branchId, source.id, sdkSessionId, resumeSessionAt, targetBranchId);
      }

      let parentId: string | null = null;
      for (const message of sourceMessages) {
        const clonedId = randomUUID();
        this.database
          .prepare(
            `INSERT INTO messages
               (id, conversation_id, branch_id, parent_message_id, role, content, status,
                reasoning_summary, sdk_uuid, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            clonedId,
            targetConversation.id,
            targetBranchId,
            parentId,
            message.role,
            message.content,
            message.status,
            message.reasoningSummary,
            message.sdkUuid,
            new Date(message.createdAt).getTime(),
            new Date(message.updatedAt).getTime()
          );
        this.assistantBlocks.cloneMessageBlocks(message.id, clonedId);
        if (!options.asNewConversation) {
          this.database
            .prepare(
              `INSERT INTO message_attachments (message_id, attachment_id)
               SELECT ?, attachment_id FROM message_attachments WHERE message_id = ?`
            )
            .run(clonedId, message.id);
        }
        parentId = clonedId;
      }
      this.database
        .prepare("UPDATE conversations SET active_branch_id = ?, updated_at = ? WHERE id = ?")
        .run(targetBranchId, timestamp, targetConversation.id);
      if (!options.asNewConversation && removedRunIds.length > 0) {
        const placeholders = removedRunIds.map(() => "?").join(",");
        this.database
          .prepare(`UPDATE runs SET superseded_at = COALESCE(superseded_at, ?) WHERE id IN (${placeholders})`)
          .run(timestamp, ...removedRunIds);
        this.database
          .prepare(
            `UPDATE memory_items SET status = 'superseded', updated_at = ?
             WHERE category = 'task' AND source_kind = 'auto' AND status = 'active'
               AND id IN (SELECT memory_id FROM memory_sources WHERE run_id IN (${placeholders}))`
          )
          .run(timestamp, ...removedRunIds);
      }
    })();

    const result = this.getConversation(targetConversation.id);
    if (!result) throw new Error("Failed to create branch");
    return result;
  }

  private assertAttachmentIds(conversationId: string, attachmentIds: readonly string[]): void {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length === 0) return;
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(`SELECT id, conversation_id, status FROM attachments WHERE id IN (${placeholders})`)
      .all(...uniqueIds) as Array<{ id: string; conversation_id: string; status: "ready" | "failed" }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of uniqueIds) {
      const attachment = byId.get(id);
      if (!attachment || attachment.conversation_id !== conversationId) {
        throw new Error("Invalid attachment: it does not belong to this conversation");
      }
      if (attachment.status !== "ready") throw new Error("Invalid attachment: it is not ready");
    }
  }

  private toConversationSummary(row: ConversationRow): ConversationSummaryDto {
    const profileId = isAgentProfileId(row.profile_id) ? row.profile_id : LEGACY_PROFILE_ID;
    const profile = getAgentProfileSummary(profileId);
    return {
      id: row.id,
      title: row.title,
      channel: row.channel,
      profileId,
      profileName: profile.name,
      participantId: row.participant_id ?? DEFAULT_PARTICIPANT_ID,
      archived: row.archived_at !== null,
      pinned: row.pinned === 1,
      temporary: row.temporary === 1,
      expiresAt: row.expires_at ? toIso(row.expires_at) : null,
      status: row.status ?? "idle",
      lastMessagePreview: cleanPreview(row.last_message_preview),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at)
    };
  }

  private toAttachment(row: AttachmentRow): AttachmentDto {
    return {
      id: row.id,
      messageId: row.message_id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      size: row.size,
      status: row.status,
      presented: row.presented !== 0,
      createdAt: toIso(row.created_at)
    };
  }

  private toMessage(row: MessageRow): Omit<MessageDto, "attachments"> {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      runId: row.run_id,
      role: row.role,
      content: row.content,
      status: row.status,
      reasoningSummary: row.reasoning_summary,
      sdkUuid: row.sdk_uuid,
      clientMessageId: row.client_message_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      memoryReferences: [],
      blocks: this.assistantBlocks.list(row.id)
    };
  }

  private toTool(row: ToolRow): ToolEventDto {
    return {
      id: row.id,
      runId: row.run_id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      status: row.status,
      inputSummary: row.input_summary,
      outputSummary: row.output_summary,
      startedAt: toIso(row.started_at),
      completedAt: row.completed_at ? toIso(row.completed_at) : null
    };
  }
}
