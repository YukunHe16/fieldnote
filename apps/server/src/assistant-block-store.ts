import { randomUUID } from "node:crypto";
import type { AgentActivityDto, AgentActivityKind, AgentActivityStatus, AssistantBlockDto } from "@fieldnote/contracts";
import type { SqliteDatabase } from "./database.js";

type BlockRow = {
  id: string;
  run_id: string | null;
  message_id: string;
  parent_block_id: string | null;
  stream_id: string | null;
  external_id: string | null;
  owner: "main" | "subagent";
  kind: "text" | "activity" | "subagent" | "thinking";
  activity_kind: AgentActivityKind | null;
  display_name: string;
  technical_name: string;
  status: AgentActivityStatus;
  content: string;
  input_summary: string | null;
  output_summary: string | null;
  ordinal: number;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
};

const toIso = (value: number): string => new Date(value).toISOString();

export class AssistantBlockStore {
  constructor(private readonly database: SqliteDatabase) {}

  list(messageId: string): AssistantBlockDto[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM assistant_blocks WHERE message_id = ?
         ORDER BY ordinal ASC, started_at ASC, id ASC`
      )
      .all(messageId) as BlockRow[];
    return rows.map((row) => this.toDto(row));
  }

  findByExternalId(runId: string, externalId: string): AssistantBlockDto | null {
    return this.byExternalId(runId, externalId);
  }

  appendText(input: {
    runId: string;
    messageId: string;
    streamId: string;
    delta: string;
    owner?: "main" | "subagent";
    parentBlockId?: string | null;
  }): AssistantBlockDto {
    const parentBlockId = input.parentBlockId ?? null;
    const owner = input.owner ?? "main";
    this.completeOpenThinking(input.messageId);
    const latest = this.database
      .prepare(
        `SELECT * FROM assistant_blocks
         WHERE message_id = ? AND parent_block_id IS ?
         ORDER BY ordinal DESC, started_at DESC, id DESC LIMIT 1`
      )
      .get(input.messageId, parentBlockId) as BlockRow | undefined;
    const timestamp = Date.now();
    if (latest?.kind === "text" && latest.owner === owner && latest.status === "running") {
      this.database
        .prepare("UPDATE assistant_blocks SET content = content || ?, updated_at = ? WHERE id = ?")
        .run(input.delta, timestamp, latest.id);
      return this.get(latest.id)!;
    }
    const streamIdExists = this.database
      .prepare("SELECT 1 FROM assistant_blocks WHERE message_id = ? AND stream_id = ?")
      .get(input.messageId, input.streamId);
    const streamId = streamIdExists ? `${input.streamId}:${randomUUID()}` : input.streamId;
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO assistant_blocks
           (id, run_id, message_id, parent_block_id, stream_id, owner, kind, status,
            content, ordinal, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'text', 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.messageId,
        parentBlockId,
        streamId,
        owner,
        input.delta,
        this.nextOrdinal(input.messageId),
        timestamp,
        timestamp
      );
    return this.get(id)!;
  }

  startActivity(input: {
    runId: string;
    messageId: string;
    externalId: string;
    parentBlockId?: string | null;
    owner?: "main" | "subagent";
    kind: AgentActivityKind;
    displayName: string;
    technicalName: string;
    inputSummary?: string | null;
  }): AssistantBlockDto {
    const existing = this.byExternalId(input.runId, input.externalId);
    if (existing) return existing;
    this.completeOpenThinking(input.messageId);
    const id = randomUUID();
    const timestamp = Date.now();
    this.database
      .prepare(
        `INSERT INTO assistant_blocks
           (id, run_id, message_id, parent_block_id, external_id, owner, kind, activity_kind,
            display_name, technical_name, status, input_summary, ordinal, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.messageId,
        input.parentBlockId ?? null,
        input.externalId,
        input.owner ?? "main",
        input.kind === "subagent" ? "subagent" : "activity",
        input.kind,
        input.displayName,
        input.technicalName,
        input.inputSummary ?? null,
        this.nextOrdinal(input.messageId),
        timestamp,
        timestamp
      );
    return this.get(id)!;
  }

  appendActivityText(runId: string, externalId: string, delta: string): AssistantBlockDto | null {
    const block = this.byExternalId(runId, externalId);
    if (!block) return null;
    this.database
      .prepare("UPDATE assistant_blocks SET content = content || ?, updated_at = ? WHERE id = ?")
      .run(delta, Date.now(), block.id);
    return this.get(block.id);
  }

  updateActivity(runId: string, externalId: string, summary: string): AssistantBlockDto | null {
    const block = this.byExternalId(runId, externalId);
    if (!block) return null;
    this.database
      .prepare("UPDATE assistant_blocks SET output_summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, Date.now(), block.id);
    return this.get(block.id);
  }

  updateActivityInput(runId: string, externalId: string, inputSummary: string): AssistantBlockDto | null {
    const block = this.byExternalId(runId, externalId);
    if (!block) return null;
    this.database
      .prepare("UPDATE assistant_blocks SET input_summary = ?, updated_at = ? WHERE id = ?")
      .run(inputSummary, Date.now(), block.id);
    return this.get(block.id);
  }

  completeActivity(
    runId: string,
    externalId: string,
    status: Exclude<AgentActivityStatus, "running">,
    outputSummary?: string | null
  ): AssistantBlockDto | null {
    const block = this.byExternalId(runId, externalId);
    if (!block) return null;
    const timestamp = Date.now();
    this.database
      .prepare(
        `UPDATE assistant_blocks SET status = ?, output_summary = COALESCE(?, output_summary),
           updated_at = ?, completed_at = ? WHERE id = ?`
      )
      .run(status, outputSummary ?? null, timestamp, timestamp, block.id);
    return this.get(block.id);
  }

  appendThinking(input: {
    runId: string;
    messageId: string;
    streamId: string;
    delta: string;
    owner?: "main" | "subagent";
    parentBlockId?: string | null;
  }): AssistantBlockDto {
    const parentBlockId = input.parentBlockId ?? null;
    const owner = input.owner ?? "main";
    const latest = this.database
      .prepare(
        `SELECT * FROM assistant_blocks
         WHERE message_id = ? AND parent_block_id IS ?
         ORDER BY ordinal DESC, started_at DESC, id DESC LIMIT 1`
      )
      .get(input.messageId, parentBlockId) as BlockRow | undefined;
    const timestamp = Date.now();
    if (latest?.kind === "thinking" && latest.owner === owner && latest.status === "running") {
      if (input.delta) {
        this.database
          .prepare("UPDATE assistant_blocks SET content = content || ?, updated_at = ? WHERE id = ?")
          .run(input.delta, timestamp, latest.id);
      }
      return this.get(latest.id)!;
    }
    const streamIdExists = this.database
      .prepare("SELECT 1 FROM assistant_blocks WHERE message_id = ? AND stream_id = ?")
      .get(input.messageId, input.streamId);
    const streamId = streamIdExists ? `${input.streamId}:${randomUUID()}` : input.streamId;
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO assistant_blocks
           (id, run_id, message_id, parent_block_id, stream_id, owner, kind, status,
            content, ordinal, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'thinking', 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.runId,
        input.messageId,
        parentBlockId,
        streamId,
        owner,
        input.delta,
        this.nextOrdinal(input.messageId),
        timestamp,
        timestamp
      );
    return this.get(id)!;
  }

  thinkingDurationMs(messageId: string): number {
    const rows = this.database
      .prepare(
        `SELECT started_at, updated_at, completed_at FROM assistant_blocks
         WHERE message_id = ? AND kind = 'thinking'`
      )
      .all(messageId) as Array<{ started_at: number; updated_at: number; completed_at: number | null }>;
    return rows.reduce((total, row) => {
      const ended = row.completed_at ?? row.updated_at;
      return total + Math.max(0, ended - row.started_at);
    }, 0);
  }

  completeOpenTextBlocks(messageId: string, status: "completed" | "interrupted" | "failed"): void {
    const timestamp = Date.now();
    this.database
      .prepare(
        `UPDATE assistant_blocks SET status = ?, updated_at = ?, completed_at = ?
         WHERE message_id = ? AND kind IN ('text', 'thinking') AND status = 'running'`
      )
      .run(status, timestamp, timestamp, messageId);
  }

  private completeOpenThinking(messageId: string): void {
    const timestamp = Date.now();
    this.database
      .prepare(
        `UPDATE assistant_blocks SET status = ?, updated_at = ?, completed_at = ?
         WHERE message_id = ? AND kind = 'thinking' AND status = 'running'`
      )
      .run("completed", timestamp, timestamp, messageId);
  }

  completeOpenActivities(messageId: string, status: "completed" | "interrupted" | "failed"): void {
    const timestamp = Date.now();
    this.database
      .prepare(
        `UPDATE assistant_blocks SET status = ?, updated_at = ?, completed_at = ?
         WHERE message_id = ? AND kind IN ('activity', 'subagent') AND status = 'running'`
      )
      .run(status, timestamp, timestamp, messageId);
  }

  cloneMessageBlocks(sourceMessageId: string, targetMessageId: string): void {
    const rows = this.database
      .prepare("SELECT * FROM assistant_blocks WHERE message_id = ? ORDER BY ordinal ASC, started_at ASC, id ASC")
      .all(sourceMessageId) as BlockRow[];
    if (rows.length === 0) return;
    const ids = new Map(rows.map((row) => [row.id, randomUUID()]));
    const insert = this.database.prepare(
      `INSERT INTO assistant_blocks
         (id, run_id, message_id, parent_block_id, stream_id, external_id, owner, kind,
          activity_kind, display_name, technical_name, status, content, input_summary,
          output_summary, ordinal, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(
        ids.get(row.id),
        row.run_id,
        targetMessageId,
        row.parent_block_id ? (ids.get(row.parent_block_id) ?? null) : null,
        row.owner,
        row.kind,
        row.activity_kind,
        row.display_name,
        row.technical_name,
        row.status,
        row.content,
        row.input_summary,
        row.output_summary,
        row.ordinal,
        row.started_at,
        row.updated_at,
        row.completed_at
      );
    }
  }

  private get(id: string): AssistantBlockDto | null {
    const row = this.database.prepare("SELECT * FROM assistant_blocks WHERE id = ?").get(id) as BlockRow | undefined;
    return row ? this.toDto(row) : null;
  }

  private byExternalId(runId: string, externalId: string): AssistantBlockDto | null {
    const row = this.database
      .prepare("SELECT * FROM assistant_blocks WHERE run_id = ? AND external_id = ?")
      .get(runId, externalId) as BlockRow | undefined;
    return row ? this.toDto(row) : null;
  }

  private nextOrdinal(messageId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM assistant_blocks WHERE message_id = ?")
      .get(messageId) as { ordinal: number };
    return row.ordinal;
  }

  private toDto(row: BlockRow): AssistantBlockDto {
    const activity: AgentActivityDto | null = row.activity_kind
      ? {
          id: row.id,
          parentActivityId: row.parent_block_id,
          kind: row.activity_kind,
          displayName: row.display_name,
          technicalName: row.technical_name,
          status: row.status,
          content: row.content,
          inputSummary: row.input_summary,
          outputSummary: row.output_summary,
          startedAt: toIso(row.started_at),
          completedAt: row.completed_at ? toIso(row.completed_at) : null
        }
      : null;
    return {
      id: row.id,
      runId: row.run_id,
      messageId: row.message_id,
      parentBlockId: row.parent_block_id,
      owner: row.owner,
      kind: row.kind,
      order: row.ordinal,
      content: row.content,
      status: row.status,
      activity
    };
  }
}
