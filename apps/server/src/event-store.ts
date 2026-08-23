import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentEventType, AgentRunEvent } from "@fieldnote/contracts";
import type { SqliteDatabase } from "./database.js";

type EventRow = {
  event_id: string;
  type: AgentEventType;
  sequence: number;
  created_at: number;
  conversation_id: string;
  branch_id: string | null;
  run_id: string | null;
  payload_json: string;
};

const terminalTypes = new Set<AgentEventType>(["run.interrupted", "run.completed", "run.failed"]);

export class EventStore {
  private readonly emitter = new EventEmitter();

  constructor(private readonly database: SqliteDatabase) {
    this.emitter.setMaxListeners(200);
  }

  append<T extends Record<string, unknown>>(input: {
    type: AgentEventType;
    conversationId: string;
    branchId?: string | null;
    runId?: string | null;
    payload?: T;
  }): AgentRunEvent<T> {
    const timestamp = Date.now();
    const event = this.database.transaction(() => {
      const sequenceRow = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM event_log WHERE conversation_id = ?")
        .get(input.conversationId) as { sequence: number };
      const value: AgentRunEvent<T> = {
        eventId: randomUUID(),
        type: input.type,
        sequence: sequenceRow.sequence,
        timestamp: new Date(timestamp).toISOString(),
        conversationId: input.conversationId,
        branchId: input.branchId ?? null,
        runId: input.runId ?? null,
        payload: input.payload ?? ({} as T)
      };
      this.database
        .prepare(
          `INSERT INTO event_log
             (event_id, conversation_id, branch_id, run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          value.eventId,
          value.conversationId,
          value.branchId,
          value.runId,
          value.sequence,
          value.type,
          JSON.stringify(value.payload),
          timestamp
        );
      return value;
    })();
    this.emitter.emit(input.conversationId, event);
    this.emitter.emit("*", event);
    return event;
  }

  list(conversationId: string, afterSequence = 0, limit = 2_000): AgentRunEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM event_log WHERE conversation_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(conversationId, afterSequence, limit) as EventRow[];
    return rows.map((row) => this.fromRow(row));
  }

  latestSequence(conversationId: string): number {
    return (
      this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log WHERE conversation_id = ?")
        .get(conversationId) as { sequence: number }
    ).sequence;
  }

  latestRunSequence(conversationId: string, runId: string): number {
    return (
      this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM event_log WHERE conversation_id = ? AND run_id = ?"
        )
        .get(conversationId, runId) as { sequence: number }
    ).sequence;
  }

  subscribe(conversationId: string, listener: (event: AgentRunEvent) => void): () => void {
    this.emitter.on(conversationId, listener);
    return () => this.emitter.off(conversationId, listener);
  }

  subscribeAll(listener: (event: AgentRunEvent) => void): () => void {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }

  async *streamRun(conversationId: string, runId: string): AsyncGenerator<AgentRunEvent> {
    const replayWatermark = this.latestRunSequence(conversationId, runId);
    const replayed: AgentRunEvent[] = [];
    const liveDuringReplay: AgentRunEvent[] = [];
    const pending: AgentRunEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let replaying = true;
    const unsubscribe = this.subscribe(conversationId, (event) => {
      if (event.runId !== runId) return;
      if (replaying) {
        liveDuringReplay.push(event);
        return;
      }
      pending.push(event);
      if (terminalTypes.has(event.type)) closed = true;
      wake?.();
      wake = undefined;
    });

    try {
      let cursor = 0;
      while (cursor < replayWatermark) {
        const page = this.listRun(conversationId, runId, cursor);
        if (page.length === 0) break;
        for (const event of page) {
          cursor = event.sequence;
          if (event.sequence <= replayWatermark) replayed.push(event);
        }
      }
      const deduplicated = new Map<number, AgentRunEvent>();
      for (const event of [...replayed, ...liveDuringReplay]) deduplicated.set(event.sequence, event);
      pending.push(...[...deduplicated.values()].sort((a, b) => a.sequence - b.sequence));
      replaying = false;
      closed = pending.some((event) => terminalTypes.has(event.type));
      while (!closed || pending.length > 0) {
        const event = pending.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      unsubscribe();
    }
  }

  /** Read a single run directly, rather than truncating the conversation at the replay page limit. */
  listRun(conversationId: string, runId: string, afterSequence = 0, limit = 2_000): AgentRunEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM event_log WHERE conversation_id = ? AND run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`
      )
      .all(conversationId, runId, afterSequence, limit) as EventRow[];
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: EventRow): AgentRunEvent {
    return {
      eventId: row.event_id,
      type: row.type,
      sequence: row.sequence,
      timestamp: new Date(row.created_at).toISOString(),
      conversationId: row.conversation_id,
      branchId: row.branch_id,
      runId: row.run_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>
    };
  }
}
