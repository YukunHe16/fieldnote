import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";
import type { InputFileManifestItem } from "./input-file-manifest.js";

export type CollaborationTaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export type CollaborationHandoffStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export type FindingStatus = "verified" | "conflicting" | "unresolved";

export type SpecialistResult = {
  summary: string;
  findings: Array<{
    claim: string;
    status: FindingStatus;
    sourceUrls: string[];
    verifiedAt?: string;
  }>;
  openQuestions: string[];
  recommendedFollowups: Array<{ specialistId: string; question: string }>;
};

export type CollaborationTask = {
  id: string;
  runId: string;
  assistantMessageId: string;
  specialistId: string;
  displayName: string;
  sourceTaskId: string | null;
  requestSummary: string;
  inputFiles: InputFileManifestItem[];
  status: CollaborationTaskStatus;
  resultSummary: string | null;
  result: SpecialistResult | null;
  structured: boolean;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
};

export type CollaborationHandoff = {
  id: string;
  runId: string;
  sourceTaskId: string;
  targetTaskId: string;
  question: string;
  status: CollaborationHandoffStatus;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

export type CollaborationSummary = {
  specialistCount: number;
  verifiedCount: number;
  conflictingCount: number;
  unresolvedCount: number;
  sourceCount: number;
  importantNotice: string | null;
};

export type CollaborationTrace = {
  tasks: CollaborationTask[];
  handoffs: CollaborationHandoff[];
  summary: CollaborationSummary;
};

export interface CreateCollaborationTaskInput {
  runId: string;
  assistantMessageId: string;
  specialistId: string;
  displayName: string;
  requestSummary: string;
  sourceTaskId?: string | null;
  inputFiles?: InputFileManifestItem[];
}

type TaskRow = {
  id: string;
  run_id: string;
  assistant_message_id: string;
  specialist_id: string;
  display_name: string;
  source_task_id: string | null;
  request_summary: string;
  input_manifest_json: string;
  status: CollaborationTaskStatus;
  result_summary: string | null;
  result_json: string | null;
  structured: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

type HandoffRow = {
  id: string;
  run_id: string;
  source_task_id: string;
  target_task_id: string;
  question: string;
  status: CollaborationHandoffStatus;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  updated_at: number;
};

const TASK_TERMINAL = new Set<CollaborationTaskStatus>(["completed", "failed", "interrupted"]);
const HANDOFF_TERMINAL = new Set<CollaborationHandoffStatus>(["completed", "failed", "interrupted"]);

function clean(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function required(value: string, label: string, limit: number): string {
  const cleaned = clean(value, limit);
  if (!cleaned) throw new Error(`${label} is required`);
  return cleaned;
}

function cleanUrl(value: string): string | null {
  const candidate = clean(value, 2_000);
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseInputManifest(value: string): InputFileManifestItem[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is InputFileManifestItem => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return (
        typeof row.attachmentId === "string" &&
        typeof row.conversationId === "string" &&
        typeof row.sourceMessageId === "string" &&
        typeof row.originalFileName === "string" &&
        typeof row.relativePath === "string" &&
        typeof row.mimeType === "string" &&
        typeof row.size === "number" &&
        typeof row.sha256 === "string" &&
        ["current_message", "history", "branch_copy", "replay"].includes(String(row.source))
      );
    });
  } catch {
    return [];
  }
}

function sanitizeResult(input: SpecialistResult): SpecialistResult {
  const summary = required(input.summary, "Specialist result summary", 4_000);
  const findings = (input.findings ?? []).slice(0, 40).flatMap((finding) => {
    const claim = clean(finding.claim, 2_000);
    if (!claim || !["verified", "conflicting", "unresolved"].includes(finding.status)) return [];
    const sourceUrls = [
      ...new Set((finding.sourceUrls ?? []).map(cleanUrl).filter((url): url is string => Boolean(url)))
    ].slice(0, 20);
    const status: FindingStatus =
      finding.status === "verified" && sourceUrls.length === 0 ? "unresolved" : finding.status;
    const verifiedDate = typeof finding.verifiedAt === "string" ? new Date(finding.verifiedAt) : null;
    const verifiedAt = verifiedDate && !Number.isNaN(verifiedDate.getTime()) ? verifiedDate.toISOString() : undefined;
    return [{ claim, status, sourceUrls, ...(verifiedAt === undefined ? {} : { verifiedAt }) }];
  });
  const openQuestions = (input.openQuestions ?? [])
    .map((item) => clean(item, 1_000))
    .filter(Boolean)
    .slice(0, 20);
  const recommendedFollowups = (input.recommendedFollowups ?? []).slice(0, 20).flatMap((item) => {
    const specialistId = clean(item.specialistId, 160);
    const question = clean(item.question, 1_000);
    return specialistId && question ? [{ specialistId, question }] : [];
  });
  return { summary, findings, openQuestions, recommendedFollowups };
}

export class CollaborationStore {
  constructor(private readonly database: SqliteDatabase) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        specialist_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_task_id TEXT REFERENCES collaboration_tasks(id) ON DELETE SET NULL,
        request_summary TEXT NOT NULL,
        input_manifest_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
        result_summary TEXT,
        result_json TEXT,
        structured INTEGER NOT NULL DEFAULT 0 CHECK (structured IN (0, 1)),
        error TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_tasks_run ON collaboration_tasks(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_collaboration_tasks_message ON collaboration_tasks(assistant_message_id, created_at);
      CREATE TABLE IF NOT EXISTS collaboration_handoffs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL REFERENCES collaboration_tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES collaboration_tasks(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
        error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_task_id, target_task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_handoffs_run ON collaboration_handoffs(run_id, created_at);
    `);
    const taskColumns = this.database.pragma("table_info(collaboration_tasks)") as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "input_manifest_json")) {
      this.database.exec("ALTER TABLE collaboration_tasks ADD COLUMN input_manifest_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  createTask(input: CreateCollaborationTaskInput): CollaborationTask {
    const runId = required(input.runId, "Run ID", 160);
    const sourceTaskId = input.sourceTaskId?.trim() || null;
    if (sourceTaskId) {
      const source = this.getTask(sourceTaskId);
      if (!source || source.runId !== runId || source.status !== "completed") {
        throw new Error("Source task must be a completed task in the same run");
      }
    }
    const now = Date.now();
    const task: CollaborationTask = {
      id: randomUUID(),
      runId,
      assistantMessageId: required(input.assistantMessageId, "Assistant message ID", 160),
      specialistId: required(input.specialistId, "Specialist ID", 160),
      displayName: required(input.displayName, "Specialist display name", 160),
      sourceTaskId,
      requestSummary: required(input.requestSummary, "Task request summary", 4_000),
      inputFiles: (input.inputFiles ?? []).map((item) => ({ ...item })),
      status: "queued",
      resultSummary: null,
      result: null,
      structured: false,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now
    };
    this.database
      .prepare(
        `INSERT INTO collaboration_tasks
       (id, run_id, assistant_message_id, specialist_id, display_name, source_task_id, request_summary, input_manifest_json,
        status, result_summary, result_json, structured, error, created_at, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.runId,
        task.assistantMessageId,
        task.specialistId,
        task.displayName,
        task.sourceTaskId,
        task.requestSummary,
        JSON.stringify(task.inputFiles),
        task.status,
        null,
        null,
        0,
        null,
        task.createdAt,
        null,
        null,
        task.updatedAt
      );
    return task;
  }

  markRunning(id: string): CollaborationTask {
    const task = this.requireTask(id);
    this.requireStatus(task, ["queued"], "mark running");
    const now = Date.now();
    this.database
      .prepare("UPDATE collaboration_tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    return this.requireTask(id);
  }

  completeStructured(id: string, result: SpecialistResult): CollaborationTask {
    const task = this.requireTask(id);
    this.requireStatus(task, ["running"], "complete");
    const cleanResult = sanitizeResult(result);
    const now = Date.now();
    this.database
      .prepare(
        `UPDATE collaboration_tasks SET status = 'completed', result_summary = ?, result_json = ?, structured = 1,
       error = NULL, finished_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(cleanResult.summary, JSON.stringify(cleanResult), now, now, id);
    return this.requireTask(id);
  }

  completeUnstructured(id: string, summary: string): CollaborationTask {
    const task = this.requireTask(id);
    this.requireStatus(task, ["running"], "complete");
    const now = Date.now();
    this.database
      .prepare(
        `UPDATE collaboration_tasks SET status = 'completed', result_summary = ?, result_json = NULL, structured = 0,
       error = NULL, finished_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(required(summary, "Specialist result summary", 4_000), now, now, id);
    return this.requireTask(id);
  }

  fail(id: string, error: string): CollaborationTask {
    return this.finishTask(id, "failed", error);
  }

  interrupt(id: string, error = "Specialist task interrupted"): CollaborationTask {
    return this.finishTask(id, "interrupted", error);
  }

  getTask(id: string): CollaborationTask | null {
    const row = this.database.prepare("SELECT * FROM collaboration_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? this.toTask(row) : null;
  }

  listForRun(runId: string): CollaborationTask[] {
    return (
      this.database
        .prepare("SELECT * FROM collaboration_tasks WHERE run_id = ? ORDER BY created_at ASC, id ASC")
        .all(runId) as TaskRow[]
    ).map((row) => this.toTask(row));
  }

  interruptRun(runId: string, error = "Specialist run interrupted"): number {
    const cleanError = required(error, "Task error", 1_000);
    const now = Date.now();
    return this.database.transaction(() => {
      const tasks = this.database
        .prepare(
          `UPDATE collaboration_tasks SET status = 'interrupted', error = ?, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND status IN ('queued', 'running')`
        )
        .run(cleanError, now, now, runId).changes;
      this.database
        .prepare(
          `UPDATE collaboration_handoffs SET status = 'interrupted', error = ?, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND status IN ('queued', 'running')`
        )
        .run(cleanError, now, now, runId);
      return tasks;
    })();
  }

  listForMessage(assistantMessageId: string): CollaborationTask[] {
    return (
      this.database
        .prepare("SELECT * FROM collaboration_tasks WHERE assistant_message_id = ? ORDER BY created_at ASC, id ASC")
        .all(assistantMessageId) as TaskRow[]
    ).map((row) => this.toTask(row));
  }

  createHandoff(input: {
    runId: string;
    sourceTaskId: string;
    targetTaskId: string;
    question: string;
  }): CollaborationHandoff {
    const runId = required(input.runId, "Run ID", 160);
    const source = this.requireTask(input.sourceTaskId);
    const target = this.requireTask(input.targetTaskId);
    if (source.runId !== runId || target.runId !== runId || source.status !== "completed") {
      throw new Error("Handoff source and target must belong to the same run, with a completed source task");
    }
    const now = Date.now();
    const handoff: CollaborationHandoff = {
      id: randomUUID(),
      runId,
      sourceTaskId: source.id,
      targetTaskId: target.id,
      question: required(input.question, "Handoff question", 2_000),
      status: "queued",
      error: null,
      createdAt: now,
      finishedAt: null,
      updatedAt: now
    };
    this.database
      .prepare(
        `INSERT INTO collaboration_handoffs
       (id, run_id, source_task_id, target_task_id, question, status, error, created_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        handoff.id,
        handoff.runId,
        handoff.sourceTaskId,
        handoff.targetTaskId,
        handoff.question,
        handoff.status,
        null,
        now,
        null,
        now
      );
    return handoff;
  }

  markHandoffRunning(id: string): CollaborationHandoff {
    const handoff = this.requireHandoff(id);
    if (handoff.status !== "queued") throw new Error("Handoff is not queued");
    const target = this.requireTask(handoff.targetTaskId);
    if (target.status !== "running") throw new Error("Handoff target task must be running");
    this.database
      .prepare("UPDATE collaboration_handoffs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    return this.requireHandoff(id);
  }

  updateHandoffTerminal(
    id: string,
    status: Extract<CollaborationHandoffStatus, "completed" | "failed" | "interrupted">,
    error?: string
  ): CollaborationHandoff {
    if (!HANDOFF_TERMINAL.has(status)) throw new Error("Handoff status must be terminal");
    const handoff = this.requireHandoff(id);
    if (handoff.status !== "queued" && handoff.status !== "running") throw new Error("Handoff is already terminal");
    const target = this.requireTask(handoff.targetTaskId);
    if (target.status !== status) throw new Error("Handoff status must match its target task status");
    const now = Date.now();
    const cleanError =
      status === "completed"
        ? null
        : required(error ?? target.error ?? "Specialist handoff failed", "Handoff error", 1_000);
    this.database
      .prepare("UPDATE collaboration_handoffs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(status, cleanError, now, now, id);
    return this.requireHandoff(id);
  }

  listHandoffsForRun(runId: string): CollaborationHandoff[] {
    return (
      this.database
        .prepare("SELECT * FROM collaboration_handoffs WHERE run_id = ? ORDER BY created_at ASC, id ASC")
        .all(runId) as HandoffRow[]
    ).map((row) => this.toHandoff(row));
  }

  traceForMessage(assistantMessageId: string): CollaborationTrace | null {
    const tasks = this.listForMessage(assistantMessageId);
    if (tasks.length === 0) return null;
    const taskIds = new Set(tasks.map((task) => task.id));
    const handoffs = this.listHandoffsForRun(tasks[0]!.runId).filter(
      (handoff) => taskIds.has(handoff.sourceTaskId) && taskIds.has(handoff.targetTaskId)
    );
    const findings = tasks.flatMap((task) => task.result?.findings ?? []);
    const sources = new Set(findings.flatMap((finding) => finding.sourceUrls));
    return {
      tasks,
      handoffs,
      summary: {
        specialistCount: new Set(tasks.map((task) => task.specialistId)).size,
        verifiedCount: findings.filter((finding) => finding.status === "verified").length,
        conflictingCount: findings.filter((finding) => finding.status === "conflicting").length,
        unresolvedCount: findings.filter((finding) => finding.status === "unresolved").length,
        sourceCount: sources.size,
        importantNotice:
          findings.find((finding) => finding.status === "conflicting")?.claim ??
          findings.find((finding) => finding.status === "unresolved")?.claim ??
          null
      }
    };
  }

  private finishTask(id: string, status: "failed" | "interrupted", error: string): CollaborationTask {
    const task = this.requireTask(id);
    this.requireStatus(task, ["queued", "running"], status);
    const now = Date.now();
    this.database
      .prepare("UPDATE collaboration_tasks SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(status, required(error, "Task error", 1_000), now, now, id);
    return this.requireTask(id);
  }

  private requireStatus(task: CollaborationTask, allowed: CollaborationTaskStatus[], action: string): void {
    if (!allowed.includes(task.status) || TASK_TERMINAL.has(task.status)) {
      throw new Error(`Cannot ${action} a ${task.status} collaboration task`);
    }
  }

  private requireTask(id: string): CollaborationTask {
    const task = this.getTask(id);
    if (!task) throw new Error("Collaboration task not found");
    return task;
  }

  private requireHandoff(id: string): CollaborationHandoff {
    const row = this.database.prepare("SELECT * FROM collaboration_handoffs WHERE id = ?").get(id) as
      | HandoffRow
      | undefined;
    if (!row) throw new Error("Collaboration handoff not found");
    return this.toHandoff(row);
  }

  private toTask(row: TaskRow): CollaborationTask {
    let result: SpecialistResult | null = null;
    if (row.structured && row.result_json) {
      try {
        result = sanitizeResult(JSON.parse(row.result_json) as SpecialistResult);
      } catch {
        result = null;
      }
    }
    return {
      id: row.id,
      runId: row.run_id,
      assistantMessageId: row.assistant_message_id,
      specialistId: row.specialist_id,
      displayName: row.display_name,
      sourceTaskId: row.source_task_id,
      requestSummary: row.request_summary,
      inputFiles: parseInputManifest(row.input_manifest_json),
      status: row.status,
      resultSummary: row.result_summary,
      result,
      structured: Boolean(row.structured),
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at
    };
  }

  private toHandoff(row: HandoffRow): CollaborationHandoff {
    return {
      id: row.id,
      runId: row.run_id,
      sourceTaskId: row.source_task_id,
      targetTaskId: row.target_task_id,
      question: row.question,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at
    };
  }
}
