import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export const LEARNING_SESSION_STATUSES = ["suggested", "active", "paused", "completed", "dismissed"] as const;
export const LEARNING_DATASET_KINDS = ["live", "demo", "replay"] as const;
export const LEARNING_EXECUTION_MODES = ["agent", "deterministic"] as const;
export const LEARNING_INCIDENT_STATUSES = [
  "observing",
  "diagnosed",
  "intervening",
  "verifying",
  "resolved",
  "unresolved",
  "escalated",
  "abandoned"
] as const;
export const LEARNING_DIFFICULTY_TYPES = [
  "planning_gap",
  "conceptual_misconception",
  "procedural_gap",
  "feedback_uncertainty",
  "prerequisite_gap",
  "other"
] as const;
export const LEARNING_INTERVENTION_STRATEGIES = [
  "socratic_question",
  "conceptual_hint",
  "contrastive_example",
  "worked_example",
  "analogical_example",
  "direct_explanation",
  "evidence_check",
  "abstain_escalate"
] as const;
export const LEARNING_VERIFICATION_METHODS = [
  "self_explanation",
  "transfer_example",
  "prediction",
  "comparison",
  "user_report"
] as const;
export const LEARNING_OUTCOMES = ["resolved", "partial", "unresolved", "unknown"] as const;
export const LEARNING_POLICY_STATUSES = ["pending", "enabled", "rejected", "disabled"] as const;

export type LearningSessionStatus = (typeof LEARNING_SESSION_STATUSES)[number];
export type LearningDatasetKind = (typeof LEARNING_DATASET_KINDS)[number];
export type LearningExecutionMode = (typeof LEARNING_EXECUTION_MODES)[number];
export type LearningIncidentStatus = (typeof LEARNING_INCIDENT_STATUSES)[number];
export type LearningDifficultyType = (typeof LEARNING_DIFFICULTY_TYPES)[number];
export type LearningInterventionStrategy = (typeof LEARNING_INTERVENTION_STRATEGIES)[number];
export type LearningVerificationMethod = (typeof LEARNING_VERIFICATION_METHODS)[number];
export type LearningOutcome = (typeof LEARNING_OUTCOMES)[number];
export type LearningPolicyStatus = (typeof LEARNING_POLICY_STATUSES)[number];

export class LearningConflictError extends Error {
  readonly statusCode = 409;
}

export class LearningNotFoundError extends Error {
  readonly statusCode = 404;
}

const learningConflict = (message: string) => new LearningConflictError(message);

export interface LearningSessionDto {
  id: string;
  conversationId: string;
  profileId: string;
  goal: string;
  topicKey: string | null;
  status: LearningSessionStatus;
  datasetKind: LearningDatasetKind;
  executionMode: LearningExecutionMode;
  suggestionReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface LearningIncidentDto {
  id: string;
  sessionId: string;
  difficultyType: LearningDifficultyType;
  hypothesis: string;
  confidence: number;
  severity: number;
  evidenceMessageIds: string[];
  openedRunId: string | null;
  status: LearningIncidentStatus;
  closedSnapshot: unknown | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  supersededAt: string | null;
}

export interface LearningInterventionDto {
  id: string;
  incidentId: string;
  strategy: LearningInterventionStrategy;
  rationale: string;
  expectedSignal: string;
  policyRevisionId: string | null;
  runId: string | null;
  messageId: string | null;
  round: number;
  createdAt: string;
}

export interface LearningVerificationDto {
  id: string;
  incidentId: string;
  interventionId: string | null;
  method: LearningVerificationMethod;
  prompt: string;
  rubric: string;
  systemVerdict: LearningOutcome | null;
  systemConfidence: number | null;
  userVerdict: Exclude<LearningOutcome, "unknown"> | null;
  finalVerdict: LearningOutcome | null;
  requestedRunId: string | null;
  requestedMessageId: string | null;
  proposedRunId: string | null;
  proposedMessageId: string | null;
  createdAt: string;
  proposedAt: string | null;
  confirmedAt: string | null;
}

export interface LearningExperienceDto {
  id: string;
  verificationId: string;
  incidentId: string;
  profileId: string;
  topicKey: string | null;
  difficultyType: LearningDifficultyType;
  strategy: LearningInterventionStrategy;
  outcome: Exclude<LearningOutcome, "unknown">;
  datasetKind: Exclude<LearningDatasetKind, "replay">;
  createdAt: string;
}

export interface LearningPolicyRevisionDto {
  id: string;
  profileId: string;
  topicKey: string | null;
  difficultyType: LearningDifficultyType;
  datasetKind: Exclude<LearningDatasetKind, "replay">;
  orderedStrategies: LearningInterventionStrategy[];
  evidenceExperienceIds: string[];
  previousRevisionId: string | null;
  status: LearningPolicyStatus;
  evaluationSummary: string;
  preview: LearningPolicyPreview | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningPolicyPreview {
  currentFirstStrategy: LearningInterventionStrategy;
  candidateFirstStrategy: LearningInterventionStrategy;
  snapshotCount: number;
  changedSelectionCount: number;
  comparisons: Array<{
    incidentId: string;
    currentStrategy: LearningInterventionStrategy;
    candidateStrategy: LearningInterventionStrategy;
    failedStrategies: LearningInterventionStrategy[];
  }>;
}

export interface LearningStrategySelection {
  strategy: LearningInterventionStrategy;
  orderedStrategies: LearningInterventionStrategy[];
  policyRevisionId: string | null;
  historyCount: number;
  scores: Record<LearningInterventionStrategy, number>;
  reason: "default" | "policy" | "evidence";
}

export interface CreateLearningSessionInput {
  conversationId: string;
  profileId: string;
  goal: string;
  topicKey?: string | null;
  status?: "suggested" | "active";
  datasetKind?: LearningDatasetKind;
  executionMode?: LearningExecutionMode;
  suggestionReason?: string | null;
}

export interface OpenLearningIncidentInput {
  sessionId: string;
  difficultyType: LearningDifficultyType;
  hypothesis: string;
  confidence: number;
  severity: number;
  evidenceMessageIds: string[];
  runId?: string | null;
}

export interface DemoLearningExperienceSeed {
  strategy: LearningInterventionStrategy;
  outcome: Exclude<LearningOutcome, "unknown">;
  count: number;
}

export const LEARNING_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  topic_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('suggested', 'active', 'paused', 'completed', 'dismissed')),
  dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('live', 'demo', 'replay')),
  execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK (execution_mode IN ('agent', 'deterministic')),
  suggestion_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_learning_sessions_status ON learning_sessions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS learning_incidents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  difficulty_type TEXT NOT NULL CHECK (difficulty_type IN ('planning_gap', 'conceptual_misconception', 'procedural_gap', 'feedback_uncertainty', 'prerequisite_gap', 'other')),
  hypothesis TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  evidence_message_ids_json TEXT NOT NULL DEFAULT '[]',
  opened_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('observing', 'diagnosed', 'intervening', 'verifying', 'resolved', 'unresolved', 'escalated', 'abandoned')),
  closed_snapshot_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  superseded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_learning_incidents_session ON learning_incidents(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_interventions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('socratic_question', 'conceptual_hint', 'contrastive_example', 'worked_example', 'analogical_example', 'direct_explanation', 'evidence_check', 'abstain_escalate')),
  rationale TEXT NOT NULL,
  expected_signal TEXT NOT NULL,
  policy_revision_id TEXT REFERENCES learning_policy_revisions(id) ON DELETE SET NULL,
  run_id TEXT,
  message_id TEXT,
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 3),
  created_at INTEGER NOT NULL,
  UNIQUE(incident_id, round)
);
CREATE INDEX IF NOT EXISTS idx_learning_interventions_incident ON learning_interventions(incident_id, round);

CREATE TABLE IF NOT EXISTS learning_verifications (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  intervention_id TEXT REFERENCES learning_interventions(id) ON DELETE SET NULL,
  method TEXT NOT NULL CHECK (method IN ('self_explanation', 'transfer_example', 'prediction', 'comparison', 'user_report')),
  prompt TEXT NOT NULL,
  rubric TEXT NOT NULL,
  system_verdict TEXT CHECK (system_verdict IS NULL OR system_verdict IN ('resolved', 'partial', 'unresolved', 'unknown')),
  system_confidence REAL CHECK (system_confidence IS NULL OR (system_confidence >= 0 AND system_confidence <= 1)),
  user_verdict TEXT CHECK (user_verdict IS NULL OR user_verdict IN ('resolved', 'partial', 'unresolved')),
  final_verdict TEXT CHECK (final_verdict IS NULL OR final_verdict IN ('resolved', 'partial', 'unresolved', 'unknown')),
  requested_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  requested_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  response_after_run_created_at INTEGER,
  proposed_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  proposed_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  proposed_at INTEGER,
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_learning_verifications_incident ON learning_verifications(incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_experiences (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL UNIQUE REFERENCES learning_verifications(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  topic_key TEXT NOT NULL DEFAULT '',
  difficulty_type TEXT NOT NULL CHECK (difficulty_type IN ('planning_gap', 'conceptual_misconception', 'procedural_gap', 'feedback_uncertainty', 'prerequisite_gap', 'other')),
  strategy TEXT NOT NULL CHECK (strategy IN ('socratic_question', 'conceptual_hint', 'contrastive_example', 'worked_example', 'analogical_example', 'direct_explanation', 'evidence_check', 'abstain_escalate')),
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'partial', 'unresolved')),
  dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('live', 'demo')),
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_experiences_selector ON learning_experiences(profile_id, topic_key, difficulty_type, dataset_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_policy_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  topic_key TEXT NOT NULL DEFAULT '',
  difficulty_type TEXT NOT NULL CHECK (difficulty_type IN ('planning_gap', 'conceptual_misconception', 'procedural_gap', 'feedback_uncertainty', 'prerequisite_gap', 'other')),
  dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('live', 'demo')),
  ordered_strategies_json TEXT NOT NULL,
  evidence_experience_ids_json TEXT NOT NULL DEFAULT '[]',
  previous_revision_id TEXT REFERENCES learning_policy_revisions(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'enabled', 'rejected', 'disabled')),
  evaluation_summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_policy_scope ON learning_policy_revisions(profile_id, topic_key, difficulty_type, dataset_kind, status, created_at DESC);
`;

const DEFAULT_STRATEGIES: readonly LearningInterventionStrategy[] = [
  "socratic_question",
  "conceptual_hint",
  "contrastive_example",
  "worked_example",
  "analogical_example",
  "direct_explanation",
  "evidence_check",
  "abstain_escalate"
];
const TERMINAL_INCIDENTS = new Set<LearningIncidentStatus>(["resolved", "unresolved", "escalated", "abandoned"]);
const has = <T extends readonly string[]>(values: T, value: string): value is T[number] =>
  values.includes(value as T[number]);
const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());
const clean = (value: string, limit: number): string => value.replace(/\s+/g, " ").trim().slice(0, limit);
const topic = (value: string | null | undefined): string => clean(value ?? "", 100);
const optionalTopic = (value: string): string | null => value || null;
const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

type SessionRow = Record<string, unknown>;
type IncidentRow = Record<string, unknown>;
type InterventionRow = Record<string, unknown>;
type VerificationRow = Record<string, unknown>;
type ExperienceRow = Record<string, unknown>;
type PolicyRow = Record<string, unknown>;

export class LearningStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.database.exec(LEARNING_STORE_SCHEMA);
    const sessionColumns = this.database.pragma("table_info(learning_sessions)") as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "execution_mode")) {
      this.database.exec(
        "ALTER TABLE learning_sessions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK (execution_mode IN ('agent', 'deterministic'))"
      );
      this.database.exec("UPDATE learning_sessions SET execution_mode = 'deterministic' WHERE dataset_kind = 'demo'");
    }
    const incidentColumns = this.database.pragma("table_info(learning_incidents)") as Array<{ name: string }>;
    if (!incidentColumns.some((column) => column.name === "opened_run_id")) {
      this.database.exec(
        "ALTER TABLE learning_incidents ADD COLUMN opened_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL"
      );
    }
    if (!incidentColumns.some((column) => column.name === "superseded_at")) {
      this.database.exec("ALTER TABLE learning_incidents ADD COLUMN superseded_at INTEGER");
    }
    this.database.exec(`
      UPDATE learning_incidents
      SET opened_run_id = (
        SELECT message.run_id
        FROM json_each(learning_incidents.evidence_message_ids_json) evidence
        JOIN messages message ON message.id = evidence.value
        WHERE message.run_id IS NOT NULL
        LIMIT 1
      )
      WHERE opened_run_id IS NULL;
    `);
    const verificationColumns = this.database.pragma("table_info(learning_verifications)") as Array<{ name: string }>;
    for (const [name, target] of [
      ["requested_run_id", "runs(id)"],
      ["requested_message_id", "messages(id)"],
      ["proposed_run_id", "runs(id)"],
      ["proposed_message_id", "messages(id)"]
    ] as const) {
      if (!verificationColumns.some((column) => column.name === name)) {
        this.database.exec(
          `ALTER TABLE learning_verifications ADD COLUMN ${name} TEXT REFERENCES ${target} ON DELETE SET NULL`
        );
      }
    }
    if (!verificationColumns.some((column) => column.name === "response_after_run_created_at")) {
      this.database.exec("ALTER TABLE learning_verifications ADD COLUMN response_after_run_created_at INTEGER");
    }
    const experienceColumns = this.database.pragma("table_info(learning_experiences)") as Array<{ name: string }>;
    if (!experienceColumns.some((column) => column.name === "snapshot_json")) {
      this.database.exec("ALTER TABLE learning_experiences ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'");
      this.database.exec(`
        UPDATE learning_experiences
        SET snapshot_json = COALESCE(
          (SELECT closed_snapshot_json FROM learning_incidents WHERE learning_incidents.id = learning_experiences.incident_id),
          '{}'
        );
      `);
    }
    this.database.exec(`
      CREATE TRIGGER IF NOT EXISTS learning_supersede_run
      AFTER UPDATE OF superseded_at ON runs
      WHEN NEW.superseded_at IS NOT NULL AND OLD.superseded_at IS NULL
      BEGIN
        UPDATE learning_policy_revisions
        SET status = 'rejected',
            evaluation_summary = evaluation_summary || ' Evidence was superseded by an edited branch.',
            updated_at = NEW.superseded_at
        WHERE status = 'pending'
          AND EXISTS (
            SELECT 1 FROM json_each(learning_policy_revisions.evidence_experience_ids_json) evidence
            JOIN learning_experiences experience ON experience.id = evidence.value
            JOIN learning_incidents incident ON incident.id = experience.incident_id
            LEFT JOIN learning_interventions intervention ON intervention.incident_id = incident.id
            WHERE incident.opened_run_id = NEW.id OR intervention.run_id = NEW.id
          );
        UPDATE learning_incidents
        SET status = 'abandoned',
            superseded_at = NEW.superseded_at,
            updated_at = NEW.superseded_at,
            closed_at = COALESCE(closed_at, NEW.superseded_at),
            closed_snapshot_json = COALESCE(closed_snapshot_json, printf('{"reason":"run_superseded","runId":"%s"}', NEW.id))
        WHERE superseded_at IS NULL
          AND (opened_run_id = NEW.id OR id IN (
            SELECT incident_id FROM learning_interventions WHERE run_id = NEW.id
          ));
      END;
    `);
  }

  createSession(input: CreateLearningSessionInput): LearningSessionDto {
    const goal = clean(input.goal, 500);
    const profileId = clean(input.profileId, 100);
    if (!goal || !profileId) throw new Error("Learning goal and profile are required");
    const status = input.status ?? "active";
    const datasetKind = input.datasetKind ?? "live";
    const executionMode = input.executionMode ?? (datasetKind === "demo" ? "deterministic" : "agent");
    if (
      !has(["suggested", "active"] as const, status) ||
      !has(LEARNING_DATASET_KINDS, datasetKind) ||
      !has(LEARNING_EXECUTION_MODES, executionMode)
    )
      throw new Error("Invalid learning session state");
    if (executionMode === "deterministic" && datasetKind !== "demo")
      throw new Error("Deterministic learning execution is available only for demo sessions");
    const now = this.clock();
    const id = randomUUID();
    try {
      this.database
        .prepare(
          `INSERT INTO learning_sessions (id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, execution_mode, suggestion_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.conversationId,
          profileId,
          goal,
          topic(input.topicKey),
          status,
          datasetKind,
          executionMode,
          clean(input.suggestionReason ?? "", 500) || null,
          now,
          now
        );
    } catch (error) {
      if (String(error).includes("learning_sessions.conversation_id"))
        throw learningConflict("A learning session already exists for this conversation");
      throw error;
    }
    return this.requireSession(id);
  }

  getSession(id: string): LearningSessionDto | null {
    const row = this.database.prepare("SELECT * FROM learning_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  getSessionForConversation(conversationId: string): LearningSessionDto | null {
    const row = this.database
      .prepare("SELECT * FROM learning_sessions WHERE conversation_id = ?")
      .get(conversationId) as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  updateSessionDetails(id: string, input: { goal?: string; topicKey?: string | null }): LearningSessionDto {
    const session = this.requireSession(id);
    if (session.status === "completed" || session.status === "dismissed")
      throw learningConflict("Closed learning sessions cannot be edited");
    const goal = input.goal === undefined ? session.goal : clean(input.goal, 500);
    if (!goal) throw new Error("Learning goal is required");
    const nextTopic = input.topicKey === undefined ? topic(session.topicKey) : topic(input.topicKey);
    this.database
      .prepare("UPDATE learning_sessions SET goal = ?, topic_key = ?, updated_at = ? WHERE id = ?")
      .run(goal, nextTopic, this.clock(), id);
    return this.requireSession(id);
  }

  transitionSession(id: string, status: LearningSessionStatus): LearningSessionDto {
    const session = this.requireSession(id);
    const allowed: Record<LearningSessionStatus, LearningSessionStatus[]> = {
      suggested: ["active", "dismissed"],
      active: ["paused", "completed"],
      paused: ["active", "completed"],
      completed: [],
      dismissed: []
    };
    if (!allowed[session.status].includes(status))
      throw learningConflict(`Cannot transition learning session from ${session.status} to ${status}`);
    const now = this.clock();
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE learning_sessions SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(status, now, status === "completed" ? now : null, id);
      if (status === "completed") {
        this.database
          .prepare(
            `UPDATE learning_incidents
           SET status = 'abandoned', updated_at = ?, closed_at = ?, closed_snapshot_json = ?
           WHERE session_id = ? AND status IN ('observing', 'diagnosed', 'intervening', 'verifying')`
          )
          .run(now, now, JSON.stringify({ reason: "session_completed", closedAt: now }), id);
      }
    })();
    return this.requireSession(id);
  }

  openIncident(input: OpenLearningIncidentInput): LearningIncidentDto {
    const session = this.requireSession(input.sessionId);
    if (session.status !== "active") throw learningConflict("Learning incidents require an active session");
    if (!has(LEARNING_DIFFICULTY_TYPES, input.difficultyType)) throw new Error("Invalid learning difficulty type");
    const hypothesis = clean(input.hypothesis, 1_000);
    if (
      !hypothesis ||
      input.confidence < 0 ||
      input.confidence > 1 ||
      !Number.isFinite(input.confidence) ||
      !Number.isInteger(input.severity) ||
      input.severity < 1 ||
      input.severity > 5
    )
      throw new Error("Invalid learning incident");
    const open = this.database
      .prepare(
        `SELECT id FROM learning_incidents WHERE session_id = ? AND superseded_at IS NULL
       AND status IN ('observing', 'diagnosed', 'intervening', 'verifying') LIMIT 1`
      )
      .get(input.sessionId) as { id: string } | undefined;
    if (open) throw learningConflict("Only one active learning incident is allowed per session");
    const now = this.clock();
    const id = randomUUID();
    const evidence = [...new Set(input.evidenceMessageIds.map((value) => clean(value, 200)).filter(Boolean))];
    if (evidence.length === 0) throw new Error("Learning incident evidence is required");
    const placeholders = evidence.map(() => "?").join(",");
    const validEvidence = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM messages
       WHERE conversation_id = ? AND id IN (${placeholders}) AND role IN ('user', 'assistant')`
        )
        .get(session.conversationId, ...evidence) as { count: number }
    ).count;
    if (validEvidence !== evidence.length)
      throw new Error("Learning incident evidence must belong to the session conversation");
    if (input.runId) this.assertRunInConversation(input.runId, session.conversationId, "Learning incident");
    this.database
      .prepare(
        `INSERT INTO learning_incidents
       (id, session_id, difficulty_type, hypothesis, confidence, severity, evidence_message_ids_json, opened_run_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'diagnosed', ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.difficultyType,
        hypothesis,
        input.confidence,
        input.severity,
        JSON.stringify(evidence),
        input.runId ?? null,
        now,
        now
      );
    return this.requireIncident(id);
  }

  getIncident(id: string): LearningIncidentDto | null {
    const row = this.database.prepare("SELECT * FROM learning_incidents WHERE id = ?").get(id) as
      | IncidentRow
      | undefined;
    return row ? this.toIncident(row) : null;
  }

  listIncidents(sessionId: string, includeSuperseded = false): LearningIncidentDto[] {
    const where = includeSuperseded ? "session_id = ?" : "session_id = ? AND superseded_at IS NULL";
    return (
      this.database
        .prepare(`SELECT * FROM learning_incidents WHERE ${where} ORDER BY created_at ASC`)
        .all(sessionId) as IncidentRow[]
    ).map((row) => this.toIncident(row));
  }

  recordIntervention(input: {
    incidentId: string;
    strategy: LearningInterventionStrategy;
    rationale: string;
    expectedSignal: string;
    policyRevisionId?: string | null;
    runId?: string | null;
    messageId?: string | null;
  }): LearningInterventionDto {
    const incident = this.requireIncident(input.incidentId);
    this.assertIncidentCurrent(incident);
    if (
      !has(LEARNING_INTERVENTION_STRATEGIES, input.strategy) ||
      !["diagnosed", "intervening"].includes(incident.status)
    )
      throw learningConflict("Intervention is not allowed for this learning incident");
    const rationale = clean(input.rationale, 2_000);
    const expectedSignal = clean(input.expectedSignal, 1_000);
    if (!rationale || !expectedSignal) throw new Error("Intervention rationale and expected signal are required");
    const session = this.sessionForIncident(incident.id);
    this.assertSessionActive(session);
    if (input.runId) this.assertRunInConversation(input.runId, session.conversationId, "Learning intervention");
    if (input.messageId)
      this.assertMessageInConversation(input.messageId, session.conversationId, "assistant", "Learning intervention");
    if (input.runId && input.messageId) this.assertMessageRun(input.messageId, input.runId, "Learning intervention");
    const round =
      (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM learning_interventions WHERE incident_id = ?")
          .get(incident.id) as { count: number }
      ).count + 1;
    if (round > 3) throw learningConflict("Learning incidents allow at most three interventions");
    const id = randomUUID();
    const now = this.clock();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO learning_interventions (id, incident_id, strategy, rationale, expected_signal, policy_revision_id, run_id, message_id, round, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          incident.id,
          input.strategy,
          rationale,
          expectedSignal,
          input.policyRevisionId ?? null,
          input.runId ?? null,
          input.messageId ?? null,
          round,
          now
        );
      this.database
        .prepare("UPDATE learning_incidents SET status = 'intervening', updated_at = ? WHERE id = ?")
        .run(now, incident.id);
    })();
    return this.requireIntervention(id);
  }

  requestVerification(input: {
    incidentId: string;
    interventionId?: string | null;
    method: LearningVerificationMethod;
    prompt: string;
    rubric: string;
    runId?: string | null;
    messageId?: string | null;
  }): LearningVerificationDto {
    const incident = this.requireIncident(input.incidentId);
    this.assertIncidentCurrent(incident);
    if (incident.status !== "intervening" || !has(LEARNING_VERIFICATION_METHODS, input.method))
      throw learningConflict("Verification is not allowed for this learning incident");
    if (input.interventionId) {
      const row = this.database
        .prepare("SELECT incident_id FROM learning_interventions WHERE id = ?")
        .get(input.interventionId) as { incident_id: string } | undefined;
      if (!row || row.incident_id !== incident.id)
        throw learningConflict("Verification intervention does not belong to the incident");
    }
    const prompt = clean(input.prompt, 4_000);
    const rubric = clean(input.rubric, 4_000);
    if (!prompt || !rubric) throw new Error("Verification prompt and rubric are required");
    const session = this.sessionForIncident(incident.id);
    this.assertSessionActive(session);
    if (input.runId) this.assertRunInConversation(input.runId, session.conversationId, "Learning verification");
    if (input.messageId)
      this.assertMessageInConversation(input.messageId, session.conversationId, "assistant", "Learning verification");
    if (input.runId && input.messageId) this.assertMessageRun(input.messageId, input.runId, "Learning verification");
    const responseAfter = (
      this.database
        .prepare("SELECT MAX(created_at) AS created_at FROM runs WHERE conversation_id = ?")
        .get(session.conversationId) as { created_at: number | null }
    ).created_at;
    const id = randomUUID();
    const now = this.clock();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO learning_verifications
         (id, incident_id, intervention_id, method, prompt, rubric, requested_run_id, requested_message_id,
          response_after_run_created_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          incident.id,
          input.interventionId ?? null,
          input.method,
          prompt,
          rubric,
          input.runId ?? null,
          input.messageId ?? null,
          responseAfter,
          now
        );
      this.database
        .prepare("UPDATE learning_incidents SET status = 'verifying', updated_at = ? WHERE id = ?")
        .run(now, incident.id);
    })();
    return this.requireVerification(id);
  }

  proposeSystemOutcome(
    id: string,
    verdict: LearningOutcome,
    confidence: number,
    context?: { runId: string; userMessageId: string; assistantMessageId: string }
  ): LearningVerificationDto {
    const verification = this.requireVerification(id);
    const incident = this.requireIncident(verification.incidentId);
    this.assertIncidentCurrent(incident);
    if (
      incident.status !== "verifying" ||
      verification.finalVerdict ||
      !has(LEARNING_OUTCOMES, verdict) ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      throw learningConflict("System outcome is not allowed for this verification");
    const session = this.sessionForIncident(incident.id);
    this.assertSessionActive(session);
    if (verification.requestedRunId) {
      if (!context || context.runId === verification.requestedRunId) {
        throw learningConflict("Learning outcome requires a later learner turn after the verification prompt");
      }
      this.assertRunInConversation(context.runId, session.conversationId, "Learning outcome");
      const proposedRun = this.database.prepare("SELECT created_at FROM runs WHERE id = ?").get(context.runId) as
        | { created_at: number }
        | undefined;
      const responseBoundary =
        (
          this.database
            .prepare("SELECT response_after_run_created_at FROM learning_verifications WHERE id = ?")
            .get(id) as { response_after_run_created_at: number | null } | undefined
        )?.response_after_run_created_at ?? new Date(verification.createdAt).getTime();
      if (!proposedRun || proposedRun.created_at <= responseBoundary) {
        throw learningConflict("Learning outcome requires a learner turn created after the verification prompt");
      }
      this.assertMessageInConversation(context.userMessageId, session.conversationId, "user", "Learning outcome");
      this.assertMessageInConversation(
        context.assistantMessageId,
        session.conversationId,
        "assistant",
        "Learning outcome"
      );
      const userMessage = this.database
        .prepare("SELECT run_id FROM messages WHERE id = ?")
        .get(context.userMessageId) as { run_id: string | null } | undefined;
      const assistantMessage = this.database
        .prepare("SELECT run_id FROM messages WHERE id = ?")
        .get(context.assistantMessageId) as { run_id: string | null } | undefined;
      if (userMessage?.run_id !== context.runId || assistantMessage?.run_id !== context.runId) {
        throw new Error("Learning outcome messages must belong to the proposing run");
      }
    }
    const now = this.clock();
    this.database
      .prepare(
        `UPDATE learning_verifications SET system_verdict = ?, system_confidence = ?, proposed_run_id = ?,
       proposed_message_id = ?, proposed_at = ? WHERE id = ?`
      )
      .run(verdict, confidence, context?.runId ?? null, context?.assistantMessageId ?? null, now, id);
    return this.requireVerification(id);
  }

  escalateIncident(id: string, reason: string): LearningIncidentDto {
    const incident = this.requireIncident(id);
    this.assertIncidentCurrent(incident);
    if (TERMINAL_INCIDENTS.has(incident.status)) throw learningConflict("Learning incident is already closed");
    this.assertSessionActive(this.sessionForIncident(incident.id));
    const now = this.clock();
    this.database
      .prepare(
        "UPDATE learning_incidents SET status = 'escalated', updated_at = ?, closed_at = ?, closed_snapshot_json = ? WHERE id = ?"
      )
      .run(now, now, JSON.stringify({ reason: clean(reason, 2_000), closedAt: now }), id);
    return this.requireIncident(id);
  }

  confirmVerification(id: string, verdict: Exclude<LearningOutcome, "unknown">): LearningVerificationDto {
    if (!has(["resolved", "partial", "unresolved"] as const, verdict)) throw new Error("Invalid user learning outcome");
    const verification = this.requireVerification(id);
    const incident = this.requireIncident(verification.incidentId);
    this.assertIncidentCurrent(incident);
    if (incident.status !== "verifying" || verification.finalVerdict || !verification.systemVerdict) {
      throw learningConflict("Verification cannot be confirmed before a system outcome proposal");
    }
    const intervention = verification.interventionId
      ? this.requireIntervention(verification.interventionId)
      : this.latestIntervention(incident.id);
    if (!intervention) throw new Error("A verified learning outcome requires an intervention");
    const session = this.sessionForIncident(incident.id);
    const now = this.clock();
    const closedSnapshot = {
      difficultyType: incident.difficultyType,
      hypothesis: incident.hypothesis,
      confidence: incident.confidence,
      severity: incident.severity,
      evidenceMessageIds: incident.evidenceMessageIds,
      interventions: this.listInterventions(incident.id).map((item) => ({
        strategy: item.strategy,
        rationale: item.rationale,
        expectedSignal: item.expectedSignal,
        round: item.round,
        policyRevisionId: item.policyRevisionId
      })),
      verification: {
        method: verification.method,
        prompt: verification.prompt,
        rubric: verification.rubric,
        systemVerdict: verification.systemVerdict,
        systemConfidence: verification.systemConfidence,
        userVerdict: verdict,
        finalVerdict: verdict
      },
      closedAt: now
    };
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE learning_verifications SET user_verdict = ?, final_verdict = ?, confirmed_at = ? WHERE id = ?")
        .run(verdict, verdict, now, id);
      const interventionCount = (
        this.database
          .prepare("SELECT COUNT(*) AS count FROM learning_interventions WHERE incident_id = ?")
          .get(incident.id) as { count: number }
      ).count;
      const incidentStatus: LearningIncidentStatus =
        verdict === "resolved"
          ? "resolved"
          : verdict === "unresolved" && interventionCount >= 3
            ? "escalated"
            : "diagnosed";
      this.database
        .prepare(
          `UPDATE learning_incidents SET status = ?, updated_at = ?, closed_at = ?, closed_snapshot_json = ? WHERE id = ?`
        )
        .run(
          incidentStatus,
          now,
          TERMINAL_INCIDENTS.has(incidentStatus) ? now : null,
          TERMINAL_INCIDENTS.has(incidentStatus) ? JSON.stringify(closedSnapshot) : null,
          incident.id
        );
      if (session.datasetKind !== "replay") {
        this.database
          .prepare(
            `INSERT INTO learning_experiences
           (id, verification_id, incident_id, profile_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, snapshot_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
            id,
            incident.id,
            session.profileId,
            topic(session.topicKey),
            incident.difficultyType,
            intervention.strategy,
            verdict,
            session.datasetKind,
            JSON.stringify(closedSnapshot),
            now
          );
      }
    })();
    return this.requireVerification(id);
  }

  selectStrategy(input: {
    profileId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    datasetKind: LearningDatasetKind;
    failedStrategies?: LearningInterventionStrategy[];
  }): LearningStrategySelection {
    if (!has(LEARNING_DIFFICULTY_TYPES, input.difficultyType) || !has(LEARNING_DATASET_KINDS, input.datasetKind))
      throw new Error("Invalid learning strategy scope");
    const profileId = clean(input.profileId, 100);
    if (!profileId) throw new Error("Profile is required for strategy selection");
    if (input.datasetKind === "replay")
      return this.selection([...DEFAULT_STRATEGIES], null, 0, {}, input.failedStrategies ?? [], "default");
    const scope = {
      profileId,
      topicKey: topic(input.topicKey),
      difficultyType: input.difficultyType,
      datasetKind: input.datasetKind
    };
    const enabled = this.enabledPolicy(scope);
    const base = enabled?.orderedStrategies ?? [...DEFAULT_STRATEGIES];
    const rows = this.database
      .prepare(
        `SELECT e.* FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.profile_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.dataset_kind = ?
         AND i.superseded_at IS NULL
       ORDER BY e.created_at ASC`
      )
      .all(scope.profileId, scope.topicKey, scope.difficultyType, input.datasetKind) as ExperienceRow[];
    if (rows.length < 3)
      return this.selection(
        base,
        enabled?.id ?? null,
        rows.length,
        {},
        input.failedStrategies ?? [],
        enabled ? "policy" : "default"
      );
    const scores = Object.fromEntries(DEFAULT_STRATEGIES.map((strategy) => [strategy, 0.5])) as Record<
      LearningInterventionStrategy,
      number
    >;
    for (const strategy of DEFAULT_STRATEGIES) {
      let success = 0;
      let failure = 0;
      for (const row of rows)
        if (row.strategy === strategy) {
          if (row.outcome === "resolved") success += 1;
          else if (row.outcome === "partial") {
            success += 0.5;
            failure += 0.5;
          } else failure += 1;
        }
      scores[strategy] = (1 + success) / (2 + success + failure);
    }
    const ordered = [...base].sort(
      (left, right) => scores[right] - scores[left] || base.indexOf(left) - base.indexOf(right)
    );
    return this.selection(ordered, enabled?.id ?? null, rows.length, scores, input.failedStrategies ?? [], "evidence");
  }

  maybeCreatePendingPolicyRevision(input: {
    profileId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    datasetKind: LearningDatasetKind;
  }): LearningPolicyRevisionDto | null {
    if (input.datasetKind === "replay") return null;
    const selection = this.selectStrategy(input);
    if (selection.historyCount < 5 || selection.reason !== "evidence") return null;
    const scope = {
      profileId: clean(input.profileId, 100),
      topicKey: topic(input.topicKey),
      difficultyType: input.difficultyType,
      datasetKind: input.datasetKind
    };
    const current = this.enabledPolicy(scope);
    const currentOrdered = current?.orderedStrategies ?? [...DEFAULT_STRATEGIES];
    const candidate = selection.orderedStrategies[0]!;
    const currentFirst = currentOrdered[0]!;
    if (candidate === currentFirst || selection.scores[candidate] - selection.scores[currentFirst] < 0.1) return null;
    const existing = this.database
      .prepare(
        `SELECT * FROM learning_policy_revisions WHERE profile_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
      )
      .get(scope.profileId, scope.topicKey, scope.difficultyType, scope.datasetKind) as PolicyRow | undefined;
    if (existing) return this.toPolicy(existing);
    const evidenceRows = this.database
      .prepare(
        `SELECT e.id FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.profile_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.dataset_kind = ?
         AND i.superseded_at IS NULL
       ORDER BY e.created_at ASC`
      )
      .all(scope.profileId, scope.topicKey, scope.difficultyType, input.datasetKind) as Array<{ id: string }>;
    const orderedStrategiesJson = JSON.stringify(selection.orderedStrategies);
    const evidenceExperienceIdsJson = JSON.stringify(evidenceRows.map((row) => row.id));
    const rejected = this.database
      .prepare(
        `SELECT id FROM learning_policy_revisions
       WHERE profile_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ?
         AND status = 'rejected' AND ordered_strategies_json = ? AND evidence_experience_ids_json = ?
       LIMIT 1`
      )
      .get(
        scope.profileId,
        scope.topicKey,
        scope.difficultyType,
        scope.datasetKind,
        orderedStrategiesJson,
        evidenceExperienceIdsJson
      ) as { id: string } | undefined;
    if (rejected) return null;
    const now = this.clock();
    const id = randomUUID();
    const baselineId = current ? null : randomUUID();
    const candidateTimestamp = baselineId ? now + 1 : now;
    const summary = `候选策略 ${candidate} 的后验成功率 ${selection.scores[candidate].toFixed(2)}，当前首选 ${currentFirst} 为 ${selection.scores[currentFirst].toFixed(2)}。`;
    this.database.transaction(() => {
      if (baselineId) {
        this.database
          .prepare(
            `INSERT INTO learning_policy_revisions
           (id, profile_id, topic_key, difficulty_type, dataset_kind, ordered_strategies_json,
            evidence_experience_ids_json, previous_revision_id, status, evaluation_summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, 'enabled', ?, ?, ?)`
          )
          .run(
            baselineId,
            scope.profileId,
            scope.topicKey,
            scope.difficultyType,
            scope.datasetKind,
            JSON.stringify(DEFAULT_STRATEGIES),
            "Default strategy baseline.",
            now,
            now
          );
      }
      this.database
        .prepare(
          `INSERT INTO learning_policy_revisions (id, profile_id, topic_key, difficulty_type, dataset_kind, ordered_strategies_json, evidence_experience_ids_json, previous_revision_id, status, evaluation_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .run(
          id,
          scope.profileId,
          scope.topicKey,
          scope.difficultyType,
          scope.datasetKind,
          orderedStrategiesJson,
          evidenceExperienceIdsJson,
          current?.id ?? baselineId,
          summary,
          candidateTimestamp,
          candidateTimestamp
        );
    })();
    return this.requirePolicy(id);
  }

  reviewPolicyRevision(id: string, verdict: "enabled" | "rejected"): LearningPolicyRevisionDto {
    const policy = this.requirePolicy(id);
    if (policy.status !== "pending") throw learningConflict("Only pending learning policies can be reviewed");
    const now = this.clock();
    this.database.transaction(() => {
      if (verdict === "enabled") {
        this.database
          .prepare(
            `UPDATE learning_policy_revisions SET status = 'disabled', updated_at = ?
           WHERE profile_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ? AND status = 'enabled'`
          )
          .run(now, policy.profileId, topic(policy.topicKey), policy.difficultyType, policy.datasetKind);
      }
      this.database
        .prepare("UPDATE learning_policy_revisions SET status = ?, updated_at = ? WHERE id = ?")
        .run(verdict, now, id);
    })();
    return this.requirePolicy(id);
  }

  rollbackPolicyRevision(id: string): LearningPolicyRevisionDto {
    const policy = this.requirePolicy(id);
    if (policy.status !== "enabled" || !policy.previousRevisionId)
      throw learningConflict("Only an enabled policy with a previous revision can be rolled back");
    const previous = this.requirePolicy(policy.previousRevisionId);
    const now = this.clock();
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE learning_policy_revisions SET status = 'disabled', updated_at = ? WHERE id = ?")
        .run(now, policy.id);
      this.database
        .prepare("UPDATE learning_policy_revisions SET status = 'enabled', updated_at = ? WHERE id = ?")
        .run(now, previous.id);
    })();
    return this.requirePolicy(previous.id);
  }

  listPolicies(input: {
    profileId: string;
    topicKey?: string | null;
    difficultyType?: LearningDifficultyType;
    datasetKind: Exclude<LearningDatasetKind, "replay">;
    includeDisabled?: boolean;
  }): LearningPolicyRevisionDto[] {
    const clauses = ["profile_id = ?", "topic_key = ?", "dataset_kind = ?"];
    const params: unknown[] = [clean(input.profileId, 100), topic(input.topicKey), input.datasetKind];
    if (input.difficultyType) {
      clauses.push("difficulty_type = ?");
      params.push(input.difficultyType);
    }
    if (!input.includeDisabled) clauses.push("status != 'disabled'");
    return (
      this.database
        .prepare(`SELECT * FROM learning_policy_revisions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
        .all(...params) as PolicyRow[]
    ).map((row) => this.toPolicy(row));
  }

  listInterventions(incidentId: string): LearningInterventionDto[] {
    return (
      this.database
        .prepare("SELECT * FROM learning_interventions WHERE incident_id = ? ORDER BY round ASC")
        .all(incidentId) as InterventionRow[]
    ).map((row) => this.toIntervention(row));
  }

  listVerifications(incidentId: string): LearningVerificationDto[] {
    return (
      this.database
        .prepare("SELECT * FROM learning_verifications WHERE incident_id = ? ORDER BY created_at ASC")
        .all(incidentId) as VerificationRow[]
    ).map((row) => this.toVerification(row));
  }

  getVerification(id: string): LearningVerificationDto | null {
    const row = this.database.prepare("SELECT * FROM learning_verifications WHERE id = ?").get(id) as
      | VerificationRow
      | undefined;
    return row ? this.toVerification(row) : null;
  }

  getSessionForIncident(incidentId: string): LearningSessionDto | null {
    try {
      return this.sessionForIncident(incidentId);
    } catch {
      return null;
    }
  }

  getPolicyRevision(id: string): LearningPolicyRevisionDto | null {
    const row = this.database.prepare("SELECT * FROM learning_policy_revisions WHERE id = ?").get(id) as
      | PolicyRow
      | undefined;
    return row ? this.toPolicy(row) : null;
  }

  previewPolicyRevision(id: string): LearningPolicyPreview | null {
    const row = this.database.prepare("SELECT * FROM learning_policy_revisions WHERE id = ?").get(id) as
      | PolicyRow
      | undefined;
    return row ? this.previewPolicy(row) : null;
  }

  listExperiences(input: {
    profileId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    datasetKind: Exclude<LearningDatasetKind, "replay">;
  }): LearningExperienceDto[] {
    return (
      this.database
        .prepare(
          `SELECT e.* FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.profile_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.dataset_kind = ?
         AND i.superseded_at IS NULL
       ORDER BY e.created_at ASC`
        )
        .all(
          clean(input.profileId, 100),
          topic(input.topicKey),
          input.difficultyType,
          input.datasetKind
        ) as ExperienceRow[]
    ).map((row) => this.toExperience(row));
  }

  seedDemoExperiences(
    sessionId: string,
    difficultyType: LearningDifficultyType,
    seeds: DemoLearningExperienceSeed[],
    locale: "zh" | "en" = "zh"
  ): number {
    const session = this.requireSession(sessionId);
    if (session.datasetKind !== "demo") throw new Error("Synthetic experiences require a demo learning session");
    if (!has(LEARNING_DIFFICULTY_TYPES, difficultyType)) throw new Error("Invalid demo learning difficulty type");
    const existing = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id WHERE i.session_id = ?`
        )
        .get(sessionId) as { count: number }
    ).count;
    if (existing > 0) return existing;
    let created = 0;
    this.database.transaction(() => {
      for (const seed of seeds) {
        if (
          !has(LEARNING_INTERVENTION_STRATEGIES, seed.strategy) ||
          !has(["resolved", "partial", "unresolved"] as const, seed.outcome) ||
          !Number.isInteger(seed.count) ||
          seed.count < 1 ||
          seed.count > 20
        ) {
          throw new Error("Invalid synthetic learning experience seed");
        }
        for (let index = 0; index < seed.count; index += 1) {
          const now = this.clock() + created;
          const incidentId = randomUUID();
          const interventionId = randomUUID();
          const verificationId = randomUUID();
          const experienceId = randomUUID();
          const incidentStatus: LearningIncidentStatus = seed.outcome === "resolved" ? "resolved" : "unresolved";
          const copy =
            locale === "en"
              ? {
                  hypothesis: `Synthetic demo history ${created + 1}`,
                  rationale: "Synthetic demo strategy record",
                  expectedSignal: "Synthetic verification signal",
                  verificationPrompt: "Synthetic demo verification",
                  rubric: "Synthetic demo rubric"
                }
              : {
                  hypothesis: `合成演示历史 ${created + 1}`,
                  rationale: "合成演示策略记录",
                  expectedSignal: "合成演示验证信号",
                  verificationPrompt: "合成演示验证",
                  rubric: "合成演示 rubric"
                };
          this.database
            .prepare(
              `INSERT INTO learning_incidents
             (id, session_id, difficulty_type, hypothesis, confidence, severity, evidence_message_ids_json, status,
              closed_snapshot_json, created_at, updated_at, closed_at)
             VALUES (?, ?, ?, ?, 0.8, 2, '[]', ?, ?, ?, ?, ?)`
            )
            .run(
              incidentId,
              sessionId,
              difficultyType,
              copy.hypothesis,
              incidentStatus,
              JSON.stringify({ synthetic: true, strategy: seed.strategy, finalVerdict: seed.outcome }),
              now,
              now,
              now
            );
          this.database
            .prepare(
              `INSERT INTO learning_interventions
             (id, incident_id, strategy, rationale, expected_signal, round, created_at)
             VALUES (?, ?, ?, ?, ?, 1, ?)`
            )
            .run(interventionId, incidentId, seed.strategy, copy.rationale, copy.expectedSignal, now);
          this.database
            .prepare(
              `INSERT INTO learning_verifications
             (id, incident_id, intervention_id, method, prompt, rubric, system_verdict, system_confidence,
              user_verdict, final_verdict, created_at, proposed_at, confirmed_at)
             VALUES (?, ?, ?, 'user_report', ?, ?, ?, 0.8, ?, ?, ?, ?, ?)`
            )
            .run(
              verificationId,
              incidentId,
              interventionId,
              copy.verificationPrompt,
              copy.rubric,
              seed.outcome,
              seed.outcome,
              seed.outcome,
              now,
              now,
              now
            );
          this.database
            .prepare(
              `INSERT INTO learning_experiences
             (id, verification_id, incident_id, profile_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, snapshot_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?)`
            )
            .run(
              experienceId,
              verificationId,
              incidentId,
              session.profileId,
              topic(session.topicKey),
              difficultyType,
              seed.strategy,
              seed.outcome,
              JSON.stringify({
                synthetic: true,
                interventions: [{ strategy: seed.strategy, round: 1 }],
                verification: { finalVerdict: seed.outcome }
              }),
              now
            );
          created += 1;
        }
      }
    })();
    return created;
  }

  private selection(
    base: LearningInterventionStrategy[],
    policyRevisionId: string | null,
    historyCount: number,
    scores: Partial<Record<LearningInterventionStrategy, number>>,
    failed: LearningInterventionStrategy[],
    reason: LearningStrategySelection["reason"]
  ): LearningStrategySelection {
    const failedSet = new Set(failed);
    const usable = base.filter((strategy) => !failedSet.has(strategy));
    const ordered = usable.length ? [...usable, ...base.filter((strategy) => failedSet.has(strategy))] : [...base];
    const allScores = Object.fromEntries(
      DEFAULT_STRATEGIES.map((strategy) => [strategy, scores[strategy] ?? 0.5])
    ) as Record<LearningInterventionStrategy, number>;
    return {
      strategy: ordered[0]!,
      orderedStrategies: ordered,
      policyRevisionId,
      historyCount,
      scores: allScores,
      reason
    };
  }

  private enabledPolicy(scope: {
    profileId: string;
    topicKey: string;
    difficultyType: LearningDifficultyType;
    datasetKind: Exclude<LearningDatasetKind, "replay">;
  }): LearningPolicyRevisionDto | null {
    const row = this.database
      .prepare(
        `SELECT * FROM learning_policy_revisions WHERE profile_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ? AND status = 'enabled' ORDER BY updated_at DESC LIMIT 1`
      )
      .get(scope.profileId, scope.topicKey, scope.difficultyType, scope.datasetKind) as PolicyRow | undefined;
    return row ? this.toPolicy(row) : null;
  }

  private latestIntervention(incidentId: string): LearningInterventionDto | null {
    const row = this.database
      .prepare("SELECT * FROM learning_interventions WHERE incident_id = ? ORDER BY round DESC LIMIT 1")
      .get(incidentId) as InterventionRow | undefined;
    return row ? this.toIntervention(row) : null;
  }

  private sessionForIncident(incidentId: string): LearningSessionDto {
    const row = this.database
      .prepare(`SELECT s.* FROM learning_sessions s JOIN learning_incidents i ON i.session_id = s.id WHERE i.id = ?`)
      .get(incidentId) as SessionRow | undefined;
    if (!row) throw new Error("Learning session not found for incident");
    return this.toSession(row);
  }

  private requireSession(id: string): LearningSessionDto {
    const value = this.getSession(id);
    if (!value) throw new LearningNotFoundError("Learning session not found");
    return value;
  }
  private requireIncident(id: string): LearningIncidentDto {
    const value = this.getIncident(id);
    if (!value) throw new LearningNotFoundError("Learning incident not found");
    return value;
  }
  private requireIntervention(id: string): LearningInterventionDto {
    const row = this.database.prepare("SELECT * FROM learning_interventions WHERE id = ?").get(id) as
      | InterventionRow
      | undefined;
    if (!row) throw new LearningNotFoundError("Learning intervention not found");
    return this.toIntervention(row);
  }
  private requireVerification(id: string): LearningVerificationDto {
    const row = this.database.prepare("SELECT * FROM learning_verifications WHERE id = ?").get(id) as
      | VerificationRow
      | undefined;
    if (!row) throw new LearningNotFoundError("Learning verification not found");
    return this.toVerification(row);
  }
  private requirePolicy(id: string): LearningPolicyRevisionDto {
    const row = this.database.prepare("SELECT * FROM learning_policy_revisions WHERE id = ?").get(id) as
      | PolicyRow
      | undefined;
    if (!row) throw new LearningNotFoundError("Learning policy revision not found");
    return this.toPolicy(row);
  }

  private assertIncidentCurrent(incident: LearningIncidentDto): void {
    if (incident.supersededAt) throw learningConflict("Learning incident was superseded by an edited branch");
  }

  private assertSessionActive(session: LearningSessionDto): void {
    if (session.status !== "active") throw learningConflict("Learning runtime mutations require an active session");
  }

  private assertRunInConversation(runId: string, conversationId: string, label: string): void {
    const run = this.database.prepare("SELECT conversation_id, superseded_at FROM runs WHERE id = ?").get(runId) as
      | { conversation_id: string; superseded_at: number | null }
      | undefined;
    if (!run || run.conversation_id !== conversationId || run.superseded_at !== null) {
      throw new Error(`${label} run does not belong to the active session conversation`);
    }
  }

  private assertMessageInConversation(
    messageId: string,
    conversationId: string,
    role: "user" | "assistant",
    label: string
  ): void {
    const message = this.database.prepare("SELECT conversation_id, role FROM messages WHERE id = ?").get(messageId) as
      | { conversation_id: string; role: string }
      | undefined;
    if (!message || message.conversation_id !== conversationId || message.role !== role) {
      throw new Error(`${label} message does not belong to the active session conversation`);
    }
  }

  private assertMessageRun(messageId: string, runId: string, label: string): void {
    const message = this.database.prepare("SELECT run_id FROM messages WHERE id = ?").get(messageId) as
      | { run_id: string | null }
      | undefined;
    if (!message || message.run_id !== runId) throw new Error(`${label} message does not belong to its run`);
  }

  private previewPolicy(row: PolicyRow): LearningPolicyPreview | null {
    const candidateOrder = parseJson<LearningInterventionStrategy[]>(String(row.ordered_strategies_json), [
      ...DEFAULT_STRATEGIES
    ]);
    const previousId = row.previous_revision_id === null ? null : String(row.previous_revision_id);
    const previous = previousId
      ? (this.database
          .prepare("SELECT ordered_strategies_json FROM learning_policy_revisions WHERE id = ?")
          .get(previousId) as { ordered_strategies_json: string } | undefined)
      : undefined;
    const currentOrder = previous
      ? parseJson<LearningInterventionStrategy[]>(previous.ordered_strategies_json, [...DEFAULT_STRATEGIES])
      : [...DEFAULT_STRATEGIES];
    const evidenceIds = parseJson<string[]>(String(row.evidence_experience_ids_json), []);
    if (evidenceIds.length === 0 || currentOrder.length === 0 || candidateOrder.length === 0) return null;
    const placeholders = evidenceIds.map(() => "?").join(",");
    const snapshots = this.database
      .prepare(
        `SELECT e.incident_id AS id, e.snapshot_json
       FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.id IN (${placeholders}) AND i.superseded_at IS NULL`
      )
      .all(...evidenceIds) as Array<{ id: string; snapshot_json: string }>;
    const comparisons = snapshots.map((snapshot) => {
      const closed = parseJson<Record<string, unknown>>(snapshot.snapshot_json, {});
      const interventions = Array.isArray(closed.interventions) ? closed.interventions : [];
      const tried = interventions.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const strategy = String((item as Record<string, unknown>).strategy ?? "");
        return has(LEARNING_INTERVENTION_STRATEGIES, strategy) ? [strategy] : [];
      });
      const finalVerdict =
        closed.verification && typeof closed.verification === "object"
          ? String((closed.verification as Record<string, unknown>).finalVerdict ?? "")
          : String(closed.finalVerdict ?? "");
      const syntheticStrategy = String(closed.strategy ?? "");
      if (
        tried.length === 0 &&
        finalVerdict !== "resolved" &&
        has(LEARNING_INTERVENTION_STRATEGIES, syntheticStrategy)
      ) {
        tried.push(syntheticStrategy);
      }
      const failedStrategies = [...new Set(finalVerdict === "resolved" ? tried.slice(0, -1) : tried)];
      const choose = (order: LearningInterventionStrategy[]) =>
        order.find((strategy) => !failedStrategies.includes(strategy)) ?? order[0]!;
      return {
        incidentId: snapshot.id,
        currentStrategy: choose(currentOrder),
        candidateStrategy: choose(candidateOrder),
        failedStrategies
      };
    });
    return {
      currentFirstStrategy: currentOrder[0]!,
      candidateFirstStrategy: candidateOrder[0]!,
      snapshotCount: comparisons.length,
      changedSelectionCount: comparisons.filter((item) => item.currentStrategy !== item.candidateStrategy).length,
      comparisons
    };
  }

  private toSession(row: SessionRow): LearningSessionDto {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      profileId: String(row.profile_id),
      goal: String(row.goal),
      topicKey: optionalTopic(String(row.topic_key)),
      status: String(row.status) as LearningSessionStatus,
      datasetKind: String(row.dataset_kind) as LearningDatasetKind,
      executionMode: String(row.execution_mode ?? "agent") as LearningExecutionMode,
      suggestionReason: row.suggestion_reason === null ? null : String(row.suggestion_reason),
      createdAt: iso(Number(row.created_at))!,
      updatedAt: iso(Number(row.updated_at))!,
      completedAt: row.completed_at === null ? null : iso(Number(row.completed_at))
    };
  }
  private toIncident(row: IncidentRow): LearningIncidentDto {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      difficultyType: String(row.difficulty_type) as LearningDifficultyType,
      hypothesis: String(row.hypothesis),
      confidence: Number(row.confidence),
      severity: Number(row.severity),
      evidenceMessageIds: parseJson(String(row.evidence_message_ids_json), []),
      openedRunId: row.opened_run_id === null || row.opened_run_id === undefined ? null : String(row.opened_run_id),
      status: String(row.status) as LearningIncidentStatus,
      closedSnapshot: row.closed_snapshot_json === null ? null : parseJson(String(row.closed_snapshot_json), null),
      createdAt: iso(Number(row.created_at))!,
      updatedAt: iso(Number(row.updated_at))!,
      closedAt: row.closed_at === null ? null : iso(Number(row.closed_at)),
      supersededAt:
        row.superseded_at === null || row.superseded_at === undefined ? null : iso(Number(row.superseded_at))
    };
  }
  private toIntervention(row: InterventionRow): LearningInterventionDto {
    return {
      id: String(row.id),
      incidentId: String(row.incident_id),
      strategy: String(row.strategy) as LearningInterventionStrategy,
      rationale: String(row.rationale),
      expectedSignal: String(row.expected_signal),
      policyRevisionId: row.policy_revision_id === null ? null : String(row.policy_revision_id),
      runId: row.run_id === null ? null : String(row.run_id),
      messageId: row.message_id === null ? null : String(row.message_id),
      round: Number(row.round),
      createdAt: iso(Number(row.created_at))!
    };
  }
  private toVerification(row: VerificationRow): LearningVerificationDto {
    return {
      id: String(row.id),
      incidentId: String(row.incident_id),
      interventionId: row.intervention_id === null ? null : String(row.intervention_id),
      method: String(row.method) as LearningVerificationMethod,
      prompt: String(row.prompt),
      rubric: String(row.rubric),
      systemVerdict: row.system_verdict === null ? null : (String(row.system_verdict) as LearningOutcome),
      systemConfidence: row.system_confidence === null ? null : Number(row.system_confidence),
      userVerdict: row.user_verdict === null ? null : (String(row.user_verdict) as Exclude<LearningOutcome, "unknown">),
      finalVerdict: row.final_verdict === null ? null : (String(row.final_verdict) as LearningOutcome),
      requestedRunId:
        row.requested_run_id === null || row.requested_run_id === undefined ? null : String(row.requested_run_id),
      requestedMessageId:
        row.requested_message_id === null || row.requested_message_id === undefined
          ? null
          : String(row.requested_message_id),
      proposedRunId:
        row.proposed_run_id === null || row.proposed_run_id === undefined ? null : String(row.proposed_run_id),
      proposedMessageId:
        row.proposed_message_id === null || row.proposed_message_id === undefined
          ? null
          : String(row.proposed_message_id),
      createdAt: iso(Number(row.created_at))!,
      proposedAt: row.proposed_at === null ? null : iso(Number(row.proposed_at)),
      confirmedAt: row.confirmed_at === null ? null : iso(Number(row.confirmed_at))
    };
  }
  private toExperience(row: ExperienceRow): LearningExperienceDto {
    return {
      id: String(row.id),
      verificationId: String(row.verification_id),
      incidentId: String(row.incident_id),
      profileId: String(row.profile_id),
      topicKey: optionalTopic(String(row.topic_key)),
      difficultyType: String(row.difficulty_type) as LearningDifficultyType,
      strategy: String(row.strategy) as LearningInterventionStrategy,
      outcome: String(row.outcome) as Exclude<LearningOutcome, "unknown">,
      datasetKind: String(row.dataset_kind) as Exclude<LearningDatasetKind, "replay">,
      createdAt: iso(Number(row.created_at))!
    };
  }
  private toPolicy(row: PolicyRow): LearningPolicyRevisionDto {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      topicKey: optionalTopic(String(row.topic_key)),
      difficultyType: String(row.difficulty_type) as LearningDifficultyType,
      datasetKind: String(row.dataset_kind) as Exclude<LearningDatasetKind, "replay">,
      orderedStrategies: parseJson(String(row.ordered_strategies_json), [...DEFAULT_STRATEGIES]),
      evidenceExperienceIds: parseJson(String(row.evidence_experience_ids_json), []),
      previousRevisionId: row.previous_revision_id === null ? null : String(row.previous_revision_id),
      status: String(row.status) as LearningPolicyStatus,
      evaluationSummary: String(row.evaluation_summary),
      preview: this.previewPolicy(row),
      createdAt: iso(Number(row.created_at))!,
      updatedAt: iso(Number(row.updated_at))!
    };
  }
}
