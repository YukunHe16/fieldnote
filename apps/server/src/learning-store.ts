import { randomUUID } from "node:crypto";
import type {
  LearningCalibrationBinDto,
  LearningHandoffReportDto,
  LearningMetricsCellDto,
  LearningMetricsDto
} from "@fieldnote/contracts";
import { overlayTokens } from "./overlay-context.js";
import type { SqliteDatabase } from "./database.js";

export const LEARNING_SESSION_STATUSES = ["suggested", "active", "paused", "completed", "dismissed"] as const;
export const LEARNING_DATASET_KINDS = ["live", "demo", "replay", "eval"] as const;
// on-call is the adaptive loop. The other two are baselines that differ from it in exactly
// one way each, so a win can be attributed:
//   one-shot   — one intervention, then the incident closes. Isolates "did the extra rounds
//                happen at all", but confounds adaptivity with simply talking longer.
//   multi-turn — the same round budget as on-call, but no strategy recommendation, no bar on
//                repeating a strategy that already failed, and no escalation. This is the
//                learner who just keeps asking, which is what a confused student actually
//                does. Comparing on-call against it isolates the structured part — the
//                bookkeeping and the forced switch — from the turns themselves.
export const LEARNING_CONDITIONS = ["on-call", "one-shot", "multi-turn"] as const;
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
export type LearningCondition = (typeof LEARNING_CONDITIONS)[number];
/** Dataset kinds whose confirmed outcomes may feed strategy evolution. */
export type LearningEvolvingDatasetKind = Exclude<LearningDatasetKind, "replay" | "eval">;
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

/**
 * Present when the research condition was drawn from a seeded study sequence, not chosen by
 * hand. The arm list is part of the record: the draw maps PRNG values through it, so
 * (seed, index) alone would stop re-deriving the condition the moment the study's arms change.
 */
export interface LearningConditionAssignment {
  seed: number;
  index: number;
  conditions: LearningCondition[];
}

export interface LearningSessionDto {
  id: string;
  conversationId: string;
  profileId: string;
  participantId: string;
  goal: string;
  topicKey: string | null;
  status: LearningSessionStatus;
  datasetKind: LearningDatasetKind;
  condition: LearningCondition;
  conditionAssignment: LearningConditionAssignment | null;
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
  /**
   * Set when this incident was opened by a spaced-review revisit: the earlier incident being
   * revisited, and which revisit it was. A revisit deliberately gets its own loop so the
   * decay has its own timestamps, strategy and outcome — but without this link the two read
   * as unrelated problems, which is exactly how a resolved loop plus its partial revisit
   * turns into "one difficulty, two rows" in the panel.
   */
  reviewOf: { incidentId: string; round: number } | null;
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
  strategyVariantId: string | null;
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
  /** Set when the check was a host-reviewed generated practice item. */
  practiceItemId: string | null;
  createdAt: string;
  proposedAt: string | null;
  confirmedAt: string | null;
}

export interface LearningExperienceDto {
  id: string;
  verificationId: string;
  incidentId: string;
  profileId: string;
  participantId: string;
  topicKey: string | null;
  difficultyType: LearningDifficultyType;
  strategy: LearningInterventionStrategy;
  outcome: Exclude<LearningOutcome, "unknown">;
  datasetKind: LearningEvolvingDatasetKind;
  strategyVariantId: string | null;
  createdAt: string;
}

export type LearningVariantStatus = "pending" | "trial" | "enabled" | "rejected" | "retired";

/**
 * An invented teaching approach (讲法): a concrete way of delivering one of the eight base
 * strategies, distilled from a winning live intervention. It refines a base strategy and
 * never replaces the closed strategy set.
 */
export interface LearningStrategyVariantDto {
  id: string;
  profileId: string;
  participantId: string;
  topicKey: string;
  difficultyType: LearningDifficultyType;
  baseStrategy: LearningInterventionStrategy;
  title: string;
  instruction: string;
  origin: "distilled";
  status: LearningVariantStatus;
  sourceIncidentId: string | null;
  recommendation: "promote" | "retire" | null;
  recommendationSummary: string;
  evidenceExperienceIds: string[];
  attributedCount: number;
  createdAt: string;
  updatedAt: string;
}

interface VariantRow {
  id: string;
  profile_id: string;
  participant_id: string;
  topic_key: string;
  difficulty_type: string;
  base_strategy: string;
  title: string;
  instruction: string;
  origin: string;
  status: string;
  source_incident_id: string | null;
  recommendation: string | null;
  recommendation_summary: string;
  evidence_experience_ids_json: string;
  rejected_evidence_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface LearningPolicyRevisionDto {
  id: string;
  profileId: string;
  participantId: string;
  topicKey: string | null;
  difficultyType: LearningDifficultyType;
  datasetKind: LearningEvolvingDatasetKind;
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
  condition?: LearningCondition;
  conditionAssignment?: LearningConditionAssignment | null;
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

export type LearningReviewStatus = "pending" | "fired" | "completed" | "cancelled";

export type LearningPracticeItemStatus = "approved" | "rejected" | "consumed" | "expired";

/** A generated practice task drafted by the tutor and reviewed by the host before delivery. */
export interface LearningPracticeItemDto {
  id: string;
  incidentId: string;
  participantId: string;
  round: number;
  source: "tutor" | "review";
  status: LearningPracticeItemStatus;
  taskText: string;
  targetHypothesis: string;
  expectedAnswerSketch: string;
  difficulty: number;
  method: LearningVerificationMethod;
  gate: "programmatic" | "novelty" | "evaluator" | "none";
  evaluatorVerdict: unknown | null;
  noveltyScore: number;
  createdAt: string;
}

/** A live session whose loop owes the next move and has not made it for runsSinceProgress turns. */
export interface LearningStallCandidate {
  sessionId: string;
  conversationId: string;
  condition: LearningCondition;
  incidentId: string;
  status: LearningIncidentStatus;
  /** status:interventions:verifications — any loop progress changes it, so per-signature actions are idempotent. */
  signature: string;
  runsSinceProgress: number;
  /** When the conversation last completed a run; lets the watchdog leave long-dead threads alone. */
  lastRunAt: number | null;
}

/** A spaced-review revisit booked when a live on-call incident resolves. */
export interface LearningReviewTask {
  id: string;
  incidentId: string;
  sessionId: string;
  conversationId: string;
  profileId: string;
  participantId: string;
  round: 1 | 2;
  dueAt: number;
  status: LearningReviewStatus;
  firedRunId: string | null;
}

/** Everything one learning loop produced, assembled for that loop's own report page. */
export interface LearningLoopReportDto {
  incident: LearningIncidentDto;
  session: LearningSessionDto;
  interventions: LearningInterventionDto[];
  verifications: LearningVerificationDto[];
  practiceItems: LearningPracticeItemDto[];
  reviewTasks: LearningReviewTask[];
  experiences: LearningExperienceDto[];
  /** Invented moves credited by this loop's experiences, so the report can name what was used. */
  variants: LearningStrategyVariantDto[];
}

interface ReviewTaskRow {
  id: string;
  incident_id: string;
  session_id: string;
  conversation_id: string;
  profile_id: string;
  participant_id: string;
  round: number;
  due_at: number;
  status: string;
  fired_run_id: string | null;
}

function toReviewTask(row: ReviewTaskRow): LearningReviewTask {
  return {
    id: row.id,
    incidentId: row.incident_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    profileId: row.profile_id,
    participantId: row.participant_id ?? "default",
    round: row.round === 2 ? 2 : 1,
    dueAt: row.due_at,
    status:
      (["pending", "fired", "completed", "cancelled"] as const).find((item) => item === row.status) ?? "cancelled",
    firedRunId: row.fired_run_id ?? null
  };
}

const LEARNING_EXPERIENCES_TABLE = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL UNIQUE REFERENCES learning_verifications(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  participant_id TEXT NOT NULL DEFAULT 'default',
  topic_key TEXT NOT NULL DEFAULT '',
  difficulty_type TEXT NOT NULL CHECK (difficulty_type IN ('planning_gap', 'conceptual_misconception', 'procedural_gap', 'feedback_uncertainty', 'prerequisite_gap', 'other')),
  strategy TEXT NOT NULL CHECK (strategy IN ('socratic_question', 'conceptual_hint', 'contrastive_example', 'worked_example', 'analogical_example', 'direct_explanation', 'evidence_check', 'abstain_escalate')),
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'partial', 'unresolved')),
  dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('live', 'demo', 'eval')),
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  strategy_variant_id TEXT REFERENCES learning_strategy_variants(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);`;

// NOTE: the constructor's rebuild migrations copy this table with explicit INSERT ... SELECT
// column lists. When adding a column here, audit those lists: a rebuild that can run on a
// schema which already has the new column must copy it, or the data is silently dropped.
const LEARNING_SESSIONS_TABLE = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  participant_id TEXT NOT NULL DEFAULT 'default',
  goal TEXT NOT NULL,
  topic_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('suggested', 'active', 'paused', 'completed', 'dismissed')),
  dataset_kind TEXT NOT NULL CHECK (dataset_kind IN ('live', 'demo', 'replay', 'eval')),
  condition TEXT NOT NULL DEFAULT 'on-call' CHECK (condition IN ('on-call', 'one-shot', 'multi-turn')),
  condition_assignment TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK (execution_mode IN ('agent', 'deterministic')),
  suggestion_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);`;

export const LEARNING_STORE_SCHEMA = `
${LEARNING_SESSIONS_TABLE("learning_sessions")}
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

CREATE TABLE IF NOT EXISTS learning_strategy_variants (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  participant_id TEXT NOT NULL DEFAULT 'default',
  topic_key TEXT NOT NULL DEFAULT '',
  difficulty_type TEXT NOT NULL CHECK (difficulty_type IN ('planning_gap', 'conceptual_misconception', 'procedural_gap', 'feedback_uncertainty', 'prerequisite_gap', 'other')),
  base_strategy TEXT NOT NULL CHECK (base_strategy IN ('socratic_question', 'conceptual_hint', 'contrastive_example', 'worked_example', 'analogical_example', 'direct_explanation', 'evidence_check', 'abstain_escalate')),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'distilled' CHECK (origin IN ('distilled')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'trial', 'enabled', 'rejected', 'retired')),
  source_incident_id TEXT REFERENCES learning_incidents(id) ON DELETE SET NULL,
  recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('promote', 'retire')),
  recommendation_summary TEXT NOT NULL DEFAULT '',
  evidence_experience_ids_json TEXT NOT NULL DEFAULT '[]',
  rejected_evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_variants_scope ON learning_strategy_variants(profile_id, topic_key, difficulty_type, base_strategy, status, created_at);

CREATE TABLE IF NOT EXISTS learning_interventions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('socratic_question', 'conceptual_hint', 'contrastive_example', 'worked_example', 'analogical_example', 'direct_explanation', 'evidence_check', 'abstain_escalate')),
  rationale TEXT NOT NULL,
  expected_signal TEXT NOT NULL,
  policy_revision_id TEXT REFERENCES learning_policy_revisions(id) ON DELETE SET NULL,
  strategy_variant_id TEXT REFERENCES learning_strategy_variants(id) ON DELETE SET NULL,
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
  confirmed_at INTEGER,
  practice_item_id TEXT REFERENCES learning_practice_items(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_verifications_incident ON learning_verifications(incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_practice_items (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL DEFAULT 'default',
  round INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'tutor' CHECK (source IN ('tutor', 'review')),
  status TEXT NOT NULL CHECK (status IN ('approved', 'rejected', 'consumed', 'expired')),
  task_text TEXT NOT NULL,
  target_hypothesis TEXT NOT NULL,
  expected_answer_sketch TEXT NOT NULL,
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  method TEXT NOT NULL CHECK (method IN ('self_explanation', 'transfer_example', 'prediction', 'comparison', 'user_report')),
  gate TEXT NOT NULL DEFAULT 'none' CHECK (gate IN ('programmatic', 'novelty', 'evaluator', 'none')),
  evaluator_verdict_json TEXT,
  novelty_score REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_practice_items_incident
  ON learning_practice_items(incident_id, round, status);

${LEARNING_EXPERIENCES_TABLE("learning_experiences")}
CREATE INDEX IF NOT EXISTS idx_learning_experiences_selector ON learning_experiences(profile_id, topic_key, difficulty_type, dataset_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_policy_revisions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  participant_id TEXT NOT NULL DEFAULT 'default',
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
CREATE TABLE IF NOT EXISTS learning_review_tasks (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  participant_id TEXT NOT NULL DEFAULT 'default',
  round INTEGER NOT NULL CHECK (round IN (1, 2)),
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'completed', 'cancelled')),
  fired_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_review_due ON learning_review_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_learning_review_session ON learning_review_tasks(session_id, status);
CREATE INDEX IF NOT EXISTS idx_learning_review_fired_run ON learning_review_tasks(fired_run_id);

CREATE TABLE IF NOT EXISTS learning_watchdog_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('nudged', 'gave_up')),
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_watchdog_incident
  ON learning_watchdog_events(incident_id, signature, action);
CREATE INDEX IF NOT EXISTS idx_learning_watchdog_session
  ON learning_watchdog_events(session_id, action);

CREATE TABLE IF NOT EXISTS learning_variant_offers (
  incident_id TEXT NOT NULL REFERENCES learning_incidents(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 3),
  variant_id TEXT NOT NULL REFERENCES learning_strategy_variants(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id, round)
);
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
const DAY_MS = 24 * 60 * 60 * 1_000;
/**
 * Spaced-review delays. The research design is +2d / +5d; the env overrides exist ONLY so a
 * local operator can watch the revisit flow without waiting days (e.g. 300000 = 5 minutes).
 * Any real study run must leave them unset — the delayed-retention metric is defined by the
 * defaults, and a shortened revisit is a different (and much weaker) measurement.
 */
// Read at SCHEDULING time, not module load: index.ts loads .env in its module body, which
// runs after every static import's body — a module-level constant here would be baked in
// before dotenv runs and the documented override could never work.
const reviewDelayFromEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 60_000 ? raw : fallback;
};
/** First revisit after a live on-call resolution (default two days). */
const reviewRound1DelayMs = (): number => reviewDelayFromEnv("LEARNING_REVIEW_ROUND1_DELAY_MS", 2 * DAY_MS);
/** Second revisit after the first one is confirmed (default five days, ≈ a week after the fix). */
const reviewRound2DelayMs = (): number => reviewDelayFromEnv("LEARNING_REVIEW_ROUND2_DELAY_MS", 5 * DAY_MS);
export const has = <T extends readonly string[]>(values: T, value: string): value is T[number] =>
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

/**
 * Length-normalized similarity for teaching-approach texts. methodsSimilar's absolute
 * overlap threshold (tuned for ~10-char playbook method strings) misfires on 100+-char
 * Chinese instructions, where generic pedagogy bigrams alone clear it — measured: 8 of 9
 * clearly distinct realistic instruction pairs were flagged similar. Dice on the same
 * token/bigram sets is scale-free: rewordings of one approach score high at any length,
 * genuinely different approaches stay low.
 */
const variantTextsSimilar = (left: string, right: string): boolean => {
  const a = overlayTokens(left);
  const b = overlayTokens(right);
  if (a.size === 0 || b.size === 0) return left.trim() === right.trim();
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size) >= 0.55;
};

/**
 * Posterior mean of a Beta(1,1) prior over learning outcomes, counting a partial outcome as
 * half a success and half a failure. Strategy ranking and variant promotion share it so both
 * read the same evidence on the same scale; an empty set returns the 0.5 prior.
 */
const outcomePosterior = (outcomes: readonly string[]): number => {
  let success = 0;
  let failure = 0;
  for (const outcome of outcomes) {
    if (outcome === "resolved") success += 1;
    else if (outcome === "partial") {
      success += 0.5;
      failure += 0.5;
    } else failure += 1;
  }
  return (1 + success) / (2 + success + failure);
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
    private readonly clock: () => number = () => Date.now(),
    // Off by default: a standard eval run must stay order-independent, so every item sees the
    // same fixed strategy order no matter what earlier items concluded. Turning it on asks a
    // different question — whether the policy gets better as evidence accumulates — which
    // requires exactly the order-dependence the default forbids. Evidence stays scoped to
    // dataset_kind = 'eval', so live statistics are untouched either way.
    private readonly evalPolicyEvolution = false
  ) {
    this.database.exec(LEARNING_STORE_SCHEMA);
    const sessionColumns = this.database.pragma("table_info(learning_sessions)") as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "execution_mode")) {
      this.database.exec(
        "ALTER TABLE learning_sessions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK (execution_mode IN ('agent', 'deterministic'))"
      );
      this.database.exec("UPDATE learning_sessions SET execution_mode = 'deterministic' WHERE dataset_kind = 'demo'");
    }
    if (!sessionColumns.some((column) => column.name === "condition")) {
      // The research condition ships together with the 'eval' dataset kind; CHECK constraints
      // cannot be altered in place, so rebuild the table (same recipe as database.ts rebuilds).
      this.database.pragma("foreign_keys = OFF");
      this.database.exec(`
        ${LEARNING_SESSIONS_TABLE("learning_sessions_research")}
        INSERT INTO learning_sessions_research
          (id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, execution_mode, suggestion_reason, created_at, updated_at, completed_at)
        SELECT id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, execution_mode, suggestion_reason, created_at, updated_at, completed_at
        FROM learning_sessions;
        DROP TABLE learning_sessions;
        ALTER TABLE learning_sessions_research RENAME TO learning_sessions;
        CREATE INDEX IF NOT EXISTS idx_learning_sessions_status ON learning_sessions(status, updated_at DESC);
      `);
      this.database.pragma("foreign_keys = ON");
    }
    // Adding the multi-turn baseline widens the same CHECK, which again cannot be altered in
    // place. Keyed on the constraint text rather than a column so it runs exactly once.
    const sessionsSql = (
      this.database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learning_sessions'")
        .get() as { sql: string } | undefined
    )?.sql;
    if (sessionsSql && !sessionsSql.includes("multi-turn")) {
      this.database.pragma("foreign_keys = OFF");
      this.database.exec(`
        ${LEARNING_SESSIONS_TABLE("learning_sessions_multiturn")}
        INSERT INTO learning_sessions_multiturn
          (id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, condition, execution_mode, suggestion_reason, created_at, updated_at, completed_at)
        SELECT id, conversation_id, profile_id, goal, topic_key, status, dataset_kind, condition, execution_mode, suggestion_reason, created_at, updated_at, completed_at
        FROM learning_sessions;
        DROP TABLE learning_sessions;
        ALTER TABLE learning_sessions_multiturn RENAME TO learning_sessions;
        CREATE INDEX IF NOT EXISTS idx_learning_sessions_status ON learning_sessions(status, updated_at DESC);
      `);
      this.database.pragma("foreign_keys = ON");
    }
    // Randomized-assignment provenance; nullable and CHECK-free, so a plain ADD COLUMN works.
    // Re-read the columns: the rebuilds above may have recreated the table (template already
    // carries the column on fresh schemas and rebuilds).
    const sessionColumnsAfterRebuilds = this.database.pragma("table_info(learning_sessions)") as Array<{
      name: string;
    }>;
    if (!sessionColumnsAfterRebuilds.some((column) => column.name === "condition_assignment")) {
      this.database.exec("ALTER TABLE learning_sessions ADD COLUMN condition_assignment TEXT");
    }
    // Experiences never expected an eval row, because an order-independent eval writes none.
    // An opted-in evolving eval does, and its evidence is filed under dataset_kind = 'eval'
    // so the live posterior still cannot see it.
    const experiencesSql = (
      this.database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learning_experiences'")
        .get() as { sql: string } | undefined
    )?.sql;
    if (experiencesSql && !/dataset_kind[^,]*'eval'/.test(experiencesSql)) {
      this.database.pragma("foreign_keys = OFF");
      // learning_supersede_run reads this table, and a modern RENAME re-parses every trigger
      // in the schema — which fails while the old table is dropped and the new one has not
      // been renamed into place yet. The legacy pragma skips that re-parse for the rename;
      // the trigger is valid again the moment the name lands.
      this.database.pragma("legacy_alter_table = ON");
      this.database.exec(`
        ${LEARNING_EXPERIENCES_TABLE("learning_experiences_eval")}
        INSERT INTO learning_experiences_eval
          (id, verification_id, incident_id, profile_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, snapshot_json, strategy_variant_id, created_at)
        SELECT id, verification_id, incident_id, profile_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, snapshot_json, strategy_variant_id, created_at
        FROM learning_experiences;
        DROP TABLE learning_experiences;
        ALTER TABLE learning_experiences_eval RENAME TO learning_experiences;
        CREATE INDEX IF NOT EXISTS idx_learning_experiences_selector ON learning_experiences(profile_id, topic_key, difficulty_type, dataset_kind, created_at DESC);
      `);
      this.database.pragma("legacy_alter_table = OFF");
      this.database.pragma("foreign_keys = ON");
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
      ["proposed_message_id", "messages(id)"],
      ["practice_item_id", "learning_practice_items(id)"]
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
    const interventionColumns = this.database.pragma("table_info(learning_interventions)") as Array<{ name: string }>;
    if (!interventionColumns.some((column) => column.name === "strategy_variant_id")) {
      this.database.exec(
        "ALTER TABLE learning_interventions ADD COLUMN strategy_variant_id TEXT REFERENCES learning_strategy_variants(id) ON DELETE SET NULL"
      );
    }
    if (!experienceColumns.some((column) => column.name === "strategy_variant_id")) {
      this.database.exec(
        "ALTER TABLE learning_experiences ADD COLUMN strategy_variant_id TEXT REFERENCES learning_strategy_variants(id) ON DELETE SET NULL"
      );
    }
    const reviewTaskColumns = this.database.pragma("table_info(learning_review_tasks)") as Array<{ name: string }>;
    if (!reviewTaskColumns.some((column) => column.name === "fired_run_id")) {
      this.database.exec(
        "ALTER TABLE learning_review_tasks ADD COLUMN fired_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL"
      );
    }
    // Heal for the old run-based source rule: a revisit incident's round-two-and-later
    // drafts happened in runs after the fired one, so they landed as 'tutor'. Source is
    // now derived from the incident at write time; this idempotent pass relabels rows
    // written under the old rule (no-op once clean).
    this.database.exec(`
      UPDATE learning_practice_items SET source = 'review'
      WHERE source != 'review'
        AND incident_id IN (
          SELECT incident.id FROM learning_incidents incident
            JOIN learning_review_tasks task ON task.fired_run_id = incident.opened_run_id
        );
    `);
    // Participant axis: upgraded databases gain the denormalized column with DEFAULT
    // 'default', which is exactly the backfill — every pre-participant row belongs to the
    // default participant, so single-user behavior is unchanged.
    for (const table of [
      "learning_sessions",
      "learning_experiences",
      "learning_strategy_variants",
      "learning_policy_revisions",
      "learning_review_tasks",
      "learning_practice_items"
    ]) {
      const columns = this.database.pragma(`table_info(${table})`) as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "participant_id")) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN participant_id TEXT NOT NULL DEFAULT 'default'`);
      }
    }
    // Created here rather than in the static schema: on an upgraded database the column only
    // exists after the guarded ALTER above has run.
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS idx_learning_experiences_variant ON learning_experiences(strategy_variant_id) WHERE strategy_variant_id IS NOT NULL"
    );
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
    const condition = input.condition ?? "on-call";
    const executionMode = input.executionMode ?? (datasetKind === "demo" ? "deterministic" : "agent");
    if (
      !has(["suggested", "active"] as const, status) ||
      !has(LEARNING_DATASET_KINDS, datasetKind) ||
      !has(LEARNING_CONDITIONS, condition) ||
      !has(LEARNING_EXECUTION_MODES, executionMode)
    )
      throw new Error("Invalid learning session state");
    if (executionMode === "deterministic" && datasetKind !== "demo")
      throw new Error("Deterministic learning execution is available only for demo sessions");
    const now = this.clock();
    const id = randomUUID();
    // The conversation is the participant anchor: sessions inherit it at creation so no
    // caller can stamp a person the conversation does not belong to.
    const participantId = this.conversationParticipant(input.conversationId);
    try {
      this.database
        .prepare(
          `INSERT INTO learning_sessions (id, conversation_id, profile_id, participant_id, goal, topic_key, status, dataset_kind, condition, condition_assignment, execution_mode, suggestion_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.conversationId,
          profileId,
          participantId,
          goal,
          topic(input.topicKey),
          status,
          datasetKind,
          condition,
          input.conditionAssignment ? JSON.stringify(input.conditionAssignment) : null,
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

  private conversationParticipant(conversationId: string): string {
    const row = this.database.prepare("SELECT participant_id FROM conversations WHERE id = ?").get(conversationId) as
      | { participant_id: string | null }
      | undefined;
    return row?.participant_id ?? "default";
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

  /**
   * Sets the research condition of a still-suggested session. Suggested sessions are created
   * by the coordinator without a condition (they default to on-call); the real assignment
   * point is the moment the user opts in and the session activates. Once a session has been
   * active, its condition is write-once — no path may change it.
   */
  assignCondition(
    id: string,
    condition: LearningCondition,
    assignment: LearningConditionAssignment | null
  ): LearningSessionDto {
    const session = this.requireSession(id);
    if (session.status !== "suggested")
      throw learningConflict("The research condition can only be assigned while a session is still suggested");
    if (!has(LEARNING_CONDITIONS, condition)) throw new Error("Invalid learning session state");
    this.database
      .prepare("UPDATE learning_sessions SET condition = ?, condition_assignment = ?, updated_at = ? WHERE id = ?")
      .run(condition, assignment ? JSON.stringify(assignment) : null, this.clock(), id);
    return this.requireSession(id);
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
    if (!has(LEARNING_INTERVENTION_STRATEGIES, input.strategy))
      throw learningConflict("Intervention is not allowed for this learning incident");
    if (!["diagnosed", "intervening"].includes(incident.status))
      throw learningConflict(
        incident.status === "verifying"
          ? // Redirect instead of dead-ending: models that only hear "not allowed" stop
            // driving the loop altogether (observed in the offline evaluation).
            "Intervention is not allowed while a verification is pending: propose_learning_outcome after the learner replies, then wait for the learner's confirmation before the next intervention round"
          : `Intervention is not allowed for a ${incident.status} learning incident`
      );
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
    if (session.condition === "one-shot" && round > 1)
      throw learningConflict("One-shot learning sessions allow a single intervention");
    if (round > 3) throw learningConflict("Learning incidents allow at most three interventions");
    // Delivery-verified attribution: stamp only the variant whose instruction the PROMPT of
    // this round actually carried (the render-time ledger written by offerVariantForPrompt),
    // and only when the tutor recorded that strategy. Recomputing the offer here instead
    // would also stamp rounds whose prompt never contained the approach — every incident
    // opened mid-run has such a round one, since the context renders before it exists.
    // No tool parameter — self-report by the model is not trustworthy.
    let strategyVariantId: string | null = null;
    if (session.datasetKind === "live" && session.condition === "on-call") {
      const offer = this.database
        .prepare("SELECT variant_id, strategy FROM learning_variant_offers WHERE incident_id = ? AND round = ?")
        .get(incident.id, round) as { variant_id: string; strategy: string } | undefined;
      if (offer && offer.strategy === input.strategy) strategyVariantId = offer.variant_id;
    }
    const id = randomUUID();
    const now = this.clock();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO learning_interventions (id, incident_id, strategy, rationale, expected_signal, policy_revision_id, strategy_variant_id, run_id, message_id, round, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          incident.id,
          input.strategy,
          rationale,
          expectedSignal,
          input.policyRevisionId ?? null,
          strategyVariantId,
          input.runId ?? null,
          input.messageId ?? null,
          round,
          now
        );
      this.database
        .prepare("UPDATE learning_incidents SET status = 'intervening', updated_at = ? WHERE id = ?")
        .run(now, incident.id);
      // The round moved on: approved drafts from earlier rounds can never satisfy the
      // round-binding check again, so retire them instead of leaving phantom "approved,
      // pending use" rows in the research export.
      this.database
        .prepare(
          "UPDATE learning_practice_items SET status = 'expired' WHERE incident_id = ? AND status = 'approved' AND round < ?"
        )
        .run(incident.id, round);
    })();
    return this.requireIntervention(id);
  }

  requestVerification(input: {
    incidentId: string;
    interventionId?: string | null;
    method: LearningVerificationMethod;
    prompt: string;
    rubric: string;
    practiceItemId?: string | null;
    runId?: string | null;
    messageId?: string | null;
  }): LearningVerificationDto {
    const incident = this.requireIncident(input.incidentId);
    this.assertIncidentCurrent(incident);
    if (!has(LEARNING_VERIFICATION_METHODS, input.method))
      throw learningConflict("Verification is not allowed for this learning incident");
    if (incident.status !== "intervening")
      throw learningConflict(
        incident.status === "diagnosed"
          ? "Verification requires an intervention first: call record_learning_intervention for this incident, then request the verification"
          : `Verification is not allowed for a ${incident.status} learning incident`
      );
    if (input.interventionId) {
      const row = this.database
        .prepare("SELECT incident_id FROM learning_interventions WHERE id = ?")
        .get(input.interventionId) as { incident_id: string } | undefined;
      if (!row || row.incident_id !== incident.id)
        throw learningConflict("Verification intervention does not belong to the incident");
    }
    // interventionId is optional in the MCP tool and models routinely omit it. Backfill from
    // the latest intervention at write time so downstream joins (handoff reports, research
    // exports) see every attempt linked instead of rendering it as never-verified.
    const interventionId = input.interventionId ?? this.latestIntervention(incident.id)?.id ?? null;
    let prompt = clean(input.prompt, 4_000);
    const rubric = clean(input.rubric, 4_000);
    if (!prompt || !rubric) throw new Error("Verification prompt and rubric are required");
    const session = this.sessionForIncident(incident.id);
    this.assertSessionActive(session);
    // In-loop generation: the treatment arm's checks are drafted first and host-reviewed.
    // The record is what the host verified — with an approved item, its task text AND
    // method become the verification's, so the draft and the delivered check cannot drift
    // apart (a reviewed transfer task must not be refiled as an un-gated user_report).
    const round = this.interventionCount(incident.id);
    const practiceEnforced =
      session.condition === "on-call" &&
      session.executionMode === "agent" &&
      (session.datasetKind === "live" || session.datasetKind === "eval");
    let practiceItemId: string | null = null;
    let method: LearningVerificationMethod = input.method;
    if (input.practiceItemId) {
      const item = this.getPracticeItem(input.practiceItemId);
      if (!item || item.incidentId !== incident.id)
        throw learningConflict("The practice item does not belong to this incident");
      if (item.status === "consumed") throw learningConflict("The practice item was already used by a verification");
      if (item.status !== "approved")
        throw learningConflict("The practice item was not approved; draft a new one with draft_practice_task");
      if (item.round !== round)
        throw learningConflict("The practice item belongs to a different round; draft a fresh one for this round");
      practiceItemId = item.id;
      prompt = item.taskText;
      method = item.method;
    } else if (practiceEnforced && this.practiceRejectionCount(incident.id, round) < 2) {
      throw learningConflict(
        "This session drafts its checks first: call draft_practice_task for this incident, then request the verification with the approved practiceItemId"
      );
    }
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
          response_after_run_created_at, practice_item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          incident.id,
          interventionId,
          method,
          prompt,
          rubric,
          input.runId ?? null,
          input.messageId ?? null,
          responseAfter,
          practiceItemId,
          now
        );
      if (practiceItemId) {
        this.database
          .prepare("UPDATE learning_practice_items SET status = 'consumed' WHERE id = ?")
          .run(practiceItemId);
      }
      // The round got its check: any approved-but-unused drafts for it can never be used
      // again (this also covers the prose fallback, which bypasses an approved sibling).
      this.database
        .prepare(
          "UPDATE learning_practice_items SET status = 'expired' WHERE incident_id = ? AND round = ? AND status = 'approved'"
        )
        .run(incident.id, round);
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
    const session = this.sessionForIncident(incident.id);
    this.assertSessionActive(session);
    // Escalation is part of the structure on trial, so the baselines must not reach it even
    // if the model calls the tool anyway.
    if (session.condition !== "on-call")
      throw learningConflict("Escalation is available only in the adaptive on-call condition");
    const now = this.clock();
    // The tool path closes with the same rich snapshot the three-round auto-escalation
    // writes, so the handoff report never depends on which path escalated.
    const verification = this.listVerifications(incident.id).at(-1) ?? null;
    const snapshot = {
      ...this.buildClosedSnapshot(incident, verification, verification?.userVerdict ?? null, now),
      reason: clean(reason, 2_000)
    };
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE learning_incidents SET status = 'escalated', updated_at = ?, closed_at = ?, closed_snapshot_json = ? WHERE id = ?"
        )
        .run(now, now, JSON.stringify(snapshot), id);
      this.expirePracticeItems(incident.id);
    })();
    return this.requireIncident(id);
  }

  /** A closed or handed-off incident can never consume a draft; retire what is left. */
  private expirePracticeItems(incidentId: string): void {
    this.database
      .prepare("UPDATE learning_practice_items SET status = 'expired' WHERE incident_id = ? AND status = 'approved'")
      .run(incidentId);
  }

  private buildClosedSnapshot(
    incident: LearningIncidentDto,
    verification: LearningVerificationDto | null,
    userVerdict: Exclude<LearningOutcome, "unknown"> | null,
    now: number
  ): Record<string, unknown> {
    return {
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
      ...(verification
        ? {
            verification: {
              method: verification.method,
              prompt: verification.prompt,
              rubric: verification.rubric,
              systemVerdict: verification.systemVerdict,
              systemConfidence: verification.systemConfidence,
              userVerdict: userVerdict ?? verification.userVerdict,
              finalVerdict: userVerdict ?? verification.finalVerdict
            }
          }
        : {}),
      closedAt: now
    };
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
    const closedSnapshot = this.buildClosedSnapshot(incident, verification, verdict, now);
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
          : session.condition === "one-shot"
            ? // The one-shot baseline ends after its single feedback round; nothing escalates.
              "unresolved"
            : verdict === "unresolved" && interventionCount >= 3
              ? // multi-turn spends the same rounds but has no escalation path — handing off
                // is part of the structure being tested, so the baseline must not get it.
                session.condition === "multi-turn"
                ? "unresolved"
                : "escalated"
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
      if (TERMINAL_INCIDENTS.has(incidentStatus)) this.expirePracticeItems(incident.id);
      // Spaced review: a live on-call resolution earns a +2d revisit. Only the revisit's OWN
      // confirmation completes the fired task — the confirmed incident must have been opened
      // by the run the review runner submitted (fired_run_id), otherwise an unrelated
      // confirmation in the same session would swallow the task, book a phantom round two,
      // and rob the new incident of its own round-one review. Unmatched fired tasks are
      // expired by the runner instead.
      if (session.datasetKind === "live" && session.condition === "on-call") {
        const fired = this.database
          .prepare(
            "SELECT id, incident_id, round, fired_run_id FROM learning_review_tasks WHERE session_id = ? AND status = 'fired' ORDER BY created_at DESC LIMIT 1"
          )
          .get(session.id) as
          | { id: string; incident_id: string; round: number; fired_run_id: string | null }
          | undefined;
        // Linked when the confirmed incident was opened by the review run, or cites one of
        // that run's messages as evidence (the incident may open only after the learner
        // answers the revisit question).
        const openedRunId = (
          this.database.prepare("SELECT opened_run_id FROM learning_incidents WHERE id = ?").get(incident.id) as {
            opened_run_id: string | null;
          }
        ).opened_run_id;
        const linked = fired?.fired_run_id
          ? openedRunId === fired.fired_run_id ||
            Boolean(
              this.database
                .prepare(
                  `SELECT 1 FROM json_each((SELECT evidence_message_ids_json FROM learning_incidents WHERE id = ?)) evidence
                 JOIN messages message ON message.id = evidence.value
                WHERE message.run_id = ? LIMIT 1`
                )
                .get(incident.id, fired.fired_run_id)
            )
          : false;
        if (fired && linked) {
          this.database
            .prepare("UPDATE learning_review_tasks SET status = 'completed', updated_at = ? WHERE id = ?")
            .run(now, fired.id);
          if (fired.round === 1 && verdict === "resolved")
            this.insertReviewTask(session, fired.incident_id, 2, now + reviewRound2DelayMs(), now);
        } else if (incidentStatus === "resolved") {
          this.insertReviewTask(session, incident.id, 1, now + reviewRound1DelayMs(), now);
        }
      }
      // Experiences exist solely to feed strategy evolution: replay must not write live statistics,
      // eval runs must stay order-independent, and the one-shot baseline never adapted a strategy.
      // Only the adaptive arm feeds the posterior: baseline sessions ignore the
      // recommendation, so their outcomes are not evidence about it — and letting a control
      // arm train the treatment policy would cross-contaminate any comparison.
      const recordsExperience =
        session.datasetKind === "eval"
          ? this.evalPolicyEvolution && session.condition === "on-call"
          : session.datasetKind !== "replay" && session.condition === "on-call";
      if (recordsExperience) {
        this.database
          .prepare(
            `INSERT INTO learning_experiences
           (id, verification_id, incident_id, profile_id, participant_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, snapshot_json, strategy_variant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
            id,
            incident.id,
            session.profileId,
            session.participantId,
            topic(session.topicKey),
            incident.difficultyType,
            intervention.strategy,
            verdict,
            session.datasetKind,
            JSON.stringify(closedSnapshot),
            intervention.strategyVariantId,
            now
          );
      }
    })();
    return this.requireVerification(id);
  }

  private insertReviewTask(
    session: LearningSessionDto,
    incidentId: string,
    round: 1 | 2,
    dueAt: number,
    now: number
  ): void {
    this.database
      .prepare(
        `INSERT INTO learning_review_tasks
         (id, incident_id, session_id, conversation_id, profile_id, participant_id, round, due_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        randomUUID(),
        incidentId,
        session.id,
        session.conversationId,
        session.profileId,
        session.participantId,
        round,
        dueAt,
        now,
        now
      );
  }

  dueReviewTasks(now = this.clock(), limit = 10): LearningReviewTask[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM learning_review_tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?"
      )
      .all(now, Math.max(1, Math.min(50, limit))) as ReviewTaskRow[];
    return rows.map(toReviewTask);
  }

  listReviewTasks(sessionId: string): LearningReviewTask[] {
    const rows = this.database
      .prepare("SELECT * FROM learning_review_tasks WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as ReviewTaskRow[];
    return rows.map(toReviewTask);
  }

  markReviewTask(id: string, status: "fired" | "completed" | "cancelled"): void {
    this.database
      .prepare("UPDATE learning_review_tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.clock(), id);
  }

  /** Records which run delivered the revisit, so its confirmation can be matched back. */
  attachReviewRun(id: string, runId: string): void {
    this.database
      .prepare("UPDATE learning_review_tasks SET fired_run_id = ?, updated_at = ? WHERE id = ?")
      .run(runId, this.clock(), id);
  }

  /**
   * Pushes a due task back without firing it (paused session, unreachable channel). Deferring
   * instead of holding keeps stuck tasks out of the head of the due window, so they cannot
   * starve later-due tasks of active sessions.
   */
  deferReviewTask(id: string, dueAt: number): void {
    this.database
      .prepare("UPDATE learning_review_tasks SET due_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(dueAt, this.clock(), id);
  }

  /**
   * A fired task whose revisit never produced a linked confirmation (learner ignored it, the
   * run failed, or the channel binding moved on) would otherwise stay 'fired' forever.
   */
  expireFiredReviewTasks(firedBefore: number): number {
    return this.database
      .prepare(
        "UPDATE learning_review_tasks SET status = 'cancelled', updated_at = ? WHERE status = 'fired' AND updated_at < ?"
      )
      .run(this.clock(), firedBefore).changes;
  }

  private variantAttributedCounts(variantIds: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (variantIds.length === 0) return counts;
    const placeholders = variantIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT e.strategy_variant_id AS variant_id, COUNT(*) AS count
       FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
      WHERE e.strategy_variant_id IN (${placeholders}) AND i.superseded_at IS NULL
      GROUP BY e.strategy_variant_id`
      )
      .all(...variantIds) as Array<{ variant_id: string; count: number }>;
    for (const row of rows) counts.set(row.variant_id, row.count);
    return counts;
  }

  getVariant(id: string): LearningStrategyVariantDto | null {
    const row = this.database.prepare("SELECT * FROM learning_strategy_variants WHERE id = ?").get(id) as
      | VariantRow
      | undefined;
    if (!row) return null;
    return this.toVariant(row, this.variantAttributedCounts([row.id]).get(row.id) ?? 0);
  }

  listVariants(input: {
    profileId: string;
    participantId: string;
    topicKey?: string | null;
    difficultyType?: LearningDifficultyType;
  }): LearningStrategyVariantDto[] {
    const conditions = ["profile_id = ?", "participant_id = ?"];
    const values: unknown[] = [clean(input.profileId, 100), input.participantId];
    if (input.topicKey !== undefined) {
      conditions.push("topic_key = ?");
      values.push(topic(input.topicKey));
    }
    if (input.difficultyType) {
      conditions.push("difficulty_type = ?");
      values.push(input.difficultyType);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM learning_strategy_variants WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 100`
      )
      .all(...values) as VariantRow[];
    const counts = this.variantAttributedCounts(rows.map((row) => row.id));
    return rows.map((row) => this.toVariant(row, counts.get(row.id) ?? 0));
  }

  /**
   * Distills a candidate teaching approach. Similar wording anywhere in the scope —
   * including rejected and retired variants — blocks re-proposal (the rejection memory),
   * and a scope+base pair holds at most one pending candidate at a time.
   */
  createVariant(input: {
    profileId: string;
    participantId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    baseStrategy: LearningInterventionStrategy;
    title: string;
    instruction: string;
    sourceIncidentId?: string | null;
  }): LearningStrategyVariantDto | null {
    if (
      !has(LEARNING_DIFFICULTY_TYPES, input.difficultyType) ||
      !has(LEARNING_INTERVENTION_STRATEGIES, input.baseStrategy)
    )
      throw new Error("Invalid learning variant scope");
    const profileId = clean(input.profileId, 100);
    const title = clean(input.title, 80);
    const instruction = clean(input.instruction, 300);
    if (!profileId || !title || !instruction) return null;
    const topicKey = topic(input.topicKey);
    // Rejection memory stays per base strategy: a variant refines one strategy, so a
    // rejected 讲法 under one strategy must not block candidates for the other seven.
    const scoped = this.database
      .prepare(
        "SELECT * FROM learning_strategy_variants WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND base_strategy = ?"
      )
      .all(profileId, input.participantId, topicKey, input.difficultyType, input.baseStrategy) as VariantRow[];
    for (const row of scoped) {
      if (variantTextsSimilar(`${row.title} ${row.instruction}`, `${title} ${instruction}`)) return null;
    }
    if (scoped.some((row) => row.status === "pending")) return null;
    const now = this.clock();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO learning_strategy_variants
         (id, profile_id, participant_id, topic_key, difficulty_type, base_strategy, title, instruction, origin, status, source_incident_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'distilled', 'pending', ?, ?, ?)`
      )
      .run(
        id,
        profileId,
        input.participantId,
        topicKey,
        input.difficultyType,
        input.baseStrategy,
        title,
        instruction,
        input.sourceIncidentId ?? null,
        now,
        now
      );
    return this.getVariant(id);
  }

  /**
   * The offer for one (scope, base strategy): the enabled variant if any, else the trial
   * variant with the fewest attributed experiences (oldest on ties). Only live on-call
   * sessions ever see variants — eval stays order-independent and one-shot stays a pure
   * baseline. Attribution does NOT recompute this; it reads the ledger that
   * offerVariantForPrompt writes at render time, so only actually-delivered instructions
   * are ever stamped.
   */
  offerVariant(input: {
    profileId: string;
    participantId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    baseStrategy: LearningInterventionStrategy;
    datasetKind: LearningDatasetKind;
    condition: LearningCondition;
  }): LearningStrategyVariantDto | null {
    if (input.datasetKind !== "live" || input.condition !== "on-call") return null;
    const rows = this.database
      .prepare(
        `SELECT * FROM learning_strategy_variants
       WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND base_strategy = ?
         AND status IN ('enabled', 'trial')
       ORDER BY created_at ASC`
      )
      .all(
        clean(input.profileId, 100),
        input.participantId,
        topic(input.topicKey),
        input.difficultyType,
        input.baseStrategy
      ) as VariantRow[];
    if (rows.length === 0) return null;
    const enabled = rows.find((row) => row.status === "enabled");
    if (enabled) return this.toVariant(enabled, this.variantAttributedCounts([enabled.id]).get(enabled.id) ?? 0);
    const counts = this.variantAttributedCounts(rows.map((row) => row.id));
    const trial = [...rows].sort(
      (left, right) => (counts.get(left.id) ?? 0) - (counts.get(right.id) ?? 0) || left.created_at - right.created_at
    )[0]!;
    return this.toVariant(trial, counts.get(trial.id) ?? 0);
  }

  /**
   * The prompt-render entry point: computes the offer AND writes it into the delivery
   * ledger for (incident, round), which is the sole source recordIntervention's attribution
   * reads. A re-render of the same round replaces the entry; a render that no longer offers
   * anything (the variant retired mid-round) clears it.
   */
  offerVariantForPrompt(
    input: Parameters<LearningStore["offerVariant"]>[0] & { incidentId: string; round: number }
  ): LearningStrategyVariantDto | null {
    const offer = this.offerVariant(input);
    if (input.round < 1 || input.round > 3) return offer;
    if (offer) {
      this.database
        .prepare(
          `INSERT INTO learning_variant_offers (incident_id, round, variant_id, strategy, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(incident_id, round) DO UPDATE SET
           variant_id = excluded.variant_id, strategy = excluded.strategy, created_at = excluded.created_at`
        )
        .run(input.incidentId, input.round, offer.id, input.baseStrategy, this.clock());
    } else {
      this.database
        .prepare("DELETE FROM learning_variant_offers WHERE incident_id = ? AND round = ?")
        .run(input.incidentId, input.round);
    }
    return offer;
  }

  reviewVariant(id: string, verdict: "trial" | "reject" | "enable" | "retire" | "keep"): LearningStrategyVariantDto {
    const row = this.database.prepare("SELECT * FROM learning_strategy_variants WHERE id = ?").get(id) as
      | VariantRow
      | undefined;
    if (!row) throw new Error("Learning strategy variant not found");
    const now = this.clock();
    const update = (fields: string, values: unknown[]) =>
      this.database
        .prepare(`UPDATE learning_strategy_variants SET ${fields}, updated_at = ? WHERE id = ?`)
        .run(...values, now, id);
    if (verdict === "trial") {
      if (row.status !== "pending") throw learningConflict("Only pending variants can enter a trial");
      const trials = (
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM learning_strategy_variants
           WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND base_strategy = ? AND status = 'trial'`
          )
          .get(row.profile_id, row.participant_id, row.topic_key, row.difficulty_type, row.base_strategy) as {
          count: number;
        }
      ).count;
      if (trials >= 2) throw learningConflict("At most two variants may trial per strategy and difficulty");
      update("status = 'trial'", []);
    } else if (verdict === "reject") {
      if (row.status !== "pending") throw learningConflict("Only pending variants can be rejected");
      update("status = 'rejected'", []);
    } else if (verdict === "enable") {
      if (row.status !== "trial") throw learningConflict("Only trial variants can be promoted");
      this.database.transaction(() => {
        // Promotion is a switch: offerVariant serves exactly one enabled variant per scope
        // (the oldest), so a sibling left enabled would silently shadow the newly promoted
        // one forever. Retiring it is part of the same human decision.
        this.database
          .prepare(
            `UPDATE learning_strategy_variants
             SET status = 'retired', recommendation = NULL, recommendation_summary = '已被新转正的讲法替代', updated_at = ?
             WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND base_strategy = ? AND status = 'enabled' AND id != ?`
          )
          .run(now, row.profile_id, row.participant_id, row.topic_key, row.difficulty_type, row.base_strategy, id);
        update("status = 'enabled', recommendation = NULL", []);
      })();
    } else if (verdict === "retire") {
      if (row.status !== "trial" && row.status !== "enabled")
        throw learningConflict("Only trial or enabled variants can retire");
      update("status = 'retired', recommendation = NULL", []);
    } else {
      // keep: dismiss the current recommendation and remember its evidence set so the
      // identical recommendation is not re-raised (mirrors the policy rejection memory).
      if (row.status !== "trial") throw learningConflict("Only trial variants can be kept as-is");
      update("recommendation = NULL, rejected_evidence_json = ?", [row.evidence_experience_ids_json]);
    }
    return this.getVariant(id)!;
  }

  /**
   * After ≥5 attributed non-superseded outcomes, compare the variant's Beta posterior with
   * same-scope experiences of its base strategy recorded without the variant; a ±0.10 gap
   * recommends promotion or retirement. The recommendation is advice — every transition
   * stays behind reviewVariant.
   */
  maybeRecommendVariantPromotion(input: {
    profileId: string;
    participantId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
  }): LearningStrategyVariantDto[] {
    const profileId = clean(input.profileId, 100);
    const topicKey = topic(input.topicKey);
    const rows = this.database
      .prepare(
        `SELECT * FROM learning_strategy_variants
       WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND status = 'trial'`
      )
      .all(profileId, input.participantId, topicKey, input.difficultyType) as VariantRow[];
    const changed: LearningStrategyVariantDto[] = [];
    for (const row of rows) {
      const experiences = this.database
        .prepare(
          `SELECT e.id, e.outcome, e.strategy_variant_id FROM learning_experiences e
         JOIN learning_incidents i ON i.id = e.incident_id
        WHERE e.profile_id = ? AND e.participant_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.strategy = ?
          AND e.dataset_kind = 'live' AND i.superseded_at IS NULL`
        )
        .all(profileId, input.participantId, topicKey, input.difficultyType, row.base_strategy) as Array<{
        id: string;
        outcome: string;
        strategy_variant_id: string | null;
      }>;
      const attributed = experiences.filter((item) => item.strategy_variant_id === row.id);
      if (attributed.length < 5) continue;
      const bare = experiences.filter((item) => item.strategy_variant_id === null);
      // No controls (possible when the winning round's own experience was superseded away):
      // the base posterior would be the bare Beta(1,1) prior, and a recommendation against
      // pure prior is advice built on no evidence. Wait for at least one real control.
      if (bare.length === 0) continue;
      const evidenceIds = attributed.map((item) => item.id).sort();
      const rejected = row.rejected_evidence_json ? parseJson<string[]>(row.rejected_evidence_json, []) : null;
      if (rejected && JSON.stringify([...rejected].sort()) === JSON.stringify(evidenceIds)) continue;
      const variantPosterior = outcomePosterior(attributed.map((item) => item.outcome));
      const basePosterior = outcomePosterior(bare.map((item) => item.outcome));
      const diff = variantPosterior - basePosterior;
      const recommendation = diff >= 0.1 ? "promote" : diff <= -0.1 ? "retire" : null;
      if (!recommendation) continue;
      const summary =
        `讲法后验 ${variantPosterior.toFixed(2)}（${attributed.length} 条归因），` +
        `基础策略后验 ${basePosterior.toFixed(2)}（${bare.length} 条对照）→ ` +
        (recommendation === "promote" ? "建议转正" : "建议退役");
      this.database
        .prepare(
          `UPDATE learning_strategy_variants
         SET recommendation = ?, recommendation_summary = ?, evidence_experience_ids_json = ?, updated_at = ?
         WHERE id = ?`
        )
        .run(recommendation, summary, JSON.stringify(evidenceIds), this.clock(), row.id);
      changed.push(this.getVariant(row.id)!);
    }
    return changed;
  }

  selectStrategy(input: {
    profileId: string;
    participantId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    datasetKind: LearningDatasetKind;
    failedStrategies?: LearningInterventionStrategy[];
  }): LearningStrategySelection {
    if (!has(LEARNING_DIFFICULTY_TYPES, input.difficultyType) || !has(LEARNING_DATASET_KINDS, input.datasetKind))
      throw new Error("Invalid learning strategy scope");
    const profileId = clean(input.profileId, 100);
    if (!profileId) throw new Error("Profile is required for strategy selection");
    // Replay must not read live statistics; eval runs use the fixed default order so every
    // evaluation item sees the same policy regardless of what earlier items concluded.
    if (input.datasetKind === "replay" || (input.datasetKind === "eval" && !this.evalPolicyEvolution))
      return this.selection([...DEFAULT_STRATEGIES], null, 0, {}, input.failedStrategies ?? [], "default");
    const scope = {
      profileId,
      participantId: input.participantId,
      topicKey: topic(input.topicKey),
      difficultyType: input.difficultyType,
      datasetKind: input.datasetKind
    };
    // Human-reviewed policy revisions are a separate mechanism and stay out of the eval even
    // when evolution is on: what an evolving eval exercises is the outcome posterior below,
    // and mixing in a promoted policy would make the two indistinguishable.
    const enabled =
      input.datasetKind === "eval" ? null : this.enabledPolicy({ ...scope, datasetKind: input.datasetKind });
    const base = enabled?.orderedStrategies ?? [...DEFAULT_STRATEGIES];
    const rows = this.database
      .prepare(
        `SELECT e.* FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.profile_id = ? AND e.participant_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.dataset_kind = ?
         AND i.superseded_at IS NULL
       ORDER BY e.created_at ASC`
      )
      .all(
        scope.profileId,
        scope.participantId,
        scope.topicKey,
        scope.difficultyType,
        input.datasetKind
      ) as ExperienceRow[];
    if (rows.length < 3)
      return this.selection(
        base,
        enabled?.id ?? null,
        rows.length,
        {},
        input.failedStrategies ?? [],
        enabled ? "policy" : "default"
      );
    const outcomesByStrategy = new Map<unknown, string[]>();
    for (const row of rows) {
      const bucket = outcomesByStrategy.get(row.strategy);
      if (bucket) bucket.push(String(row.outcome));
      else outcomesByStrategy.set(row.strategy, [String(row.outcome)]);
    }
    const scores = Object.fromEntries(
      DEFAULT_STRATEGIES.map((strategy) => [strategy, outcomePosterior(outcomesByStrategy.get(strategy) ?? [])])
    ) as Record<LearningInterventionStrategy, number>;
    const ordered = [...base].sort(
      (left, right) => scores[right] - scores[left] || base.indexOf(left) - base.indexOf(right)
    );
    return this.selection(ordered, enabled?.id ?? null, rows.length, scores, input.failedStrategies ?? [], "evidence");
  }

  maybeCreatePendingPolicyRevision(input: {
    profileId: string;
    participantId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    datasetKind: LearningDatasetKind;
  }): LearningPolicyRevisionDto | null {
    if (input.datasetKind === "replay" || input.datasetKind === "eval") return null;
    const selection = this.selectStrategy(input);
    if (selection.historyCount < 5 || selection.reason !== "evidence") return null;
    const scope = {
      profileId: clean(input.profileId, 100),
      participantId: input.participantId,
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
        `SELECT * FROM learning_policy_revisions WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
      )
      .get(scope.profileId, scope.participantId, scope.topicKey, scope.difficultyType, scope.datasetKind) as
      | PolicyRow
      | undefined;
    if (existing) return this.toPolicy(existing);
    const evidenceRows = this.database
      .prepare(
        `SELECT e.id FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.profile_id = ? AND e.participant_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.dataset_kind = ?
         AND i.superseded_at IS NULL
       ORDER BY e.created_at ASC`
      )
      .all(scope.profileId, scope.participantId, scope.topicKey, scope.difficultyType, input.datasetKind) as Array<{
      id: string;
    }>;
    const orderedStrategiesJson = JSON.stringify(selection.orderedStrategies);
    const evidenceExperienceIdsJson = JSON.stringify(evidenceRows.map((row) => row.id));
    const rejected = this.database
      .prepare(
        `SELECT id FROM learning_policy_revisions
       WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ?
         AND status = 'rejected' AND ordered_strategies_json = ? AND evidence_experience_ids_json = ?
       LIMIT 1`
      )
      .get(
        scope.profileId,
        scope.participantId,
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
           (id, profile_id, participant_id, topic_key, difficulty_type, dataset_kind, ordered_strategies_json,
            evidence_experience_ids_json, previous_revision_id, status, evaluation_summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, 'enabled', ?, ?, ?)`
          )
          .run(
            baselineId,
            scope.profileId,
            scope.participantId,
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
          `INSERT INTO learning_policy_revisions (id, profile_id, participant_id, topic_key, difficulty_type, dataset_kind, ordered_strategies_json, evidence_experience_ids_json, previous_revision_id, status, evaluation_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
        )
        .run(
          id,
          scope.profileId,
          scope.participantId,
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
           WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ? AND status = 'enabled'`
          )
          .run(
            now,
            policy.profileId,
            policy.participantId,
            topic(policy.topicKey),
            policy.difficultyType,
            policy.datasetKind
          );
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
    participantId: string;
    topicKey?: string | null;
    difficultyType?: LearningDifficultyType;
    datasetKind: LearningEvolvingDatasetKind;
    includeDisabled?: boolean;
  }): LearningPolicyRevisionDto[] {
    const clauses = ["profile_id = ?", "participant_id = ?", "topic_key = ?", "dataset_kind = ?"];
    const params: unknown[] = [
      clean(input.profileId, 100),
      input.participantId,
      topic(input.topicKey),
      input.datasetKind
    ];
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

  /** Topics this participant has studied before, most used first — suggestions, not a fixed set. */
  listTopicKeys(participantId: string): string[] {
    return (
      this.database
        .prepare(
          `SELECT topic_key AS topicKey, COUNT(*) AS uses FROM learning_sessions
             WHERE participant_id = ? AND topic_key IS NOT NULL AND TRIM(topic_key) != ''
             GROUP BY topic_key ORDER BY uses DESC, topic_key ASC LIMIT 40`
        )
        .all(participantId) as Array<{ topicKey: string }>
    ).map((row) => row.topicKey);
  }

  listPracticeItems(incidentId: string): LearningPracticeItemDto[] {
    return (
      this.database
        .prepare("SELECT * FROM learning_practice_items WHERE incident_id = ? ORDER BY round ASC, created_at ASC")
        .all(incidentId) as Record<string, unknown>[]
    ).map((row) => this.toPracticeItem(row));
  }

  /**
   * One loop, whole: the diagnosis, every round spent on it, every practice draft it burned
   * (the rejected ones included — those are the evidence the gates did their job), the
   * learner's own verdict, and any revisit booked afterwards.
   *
   * Null until the learner has confirmed at least one verification: before that the loop has
   * no outcome, and a report claiming one would be the system grading itself.
   */
  loopReport(incidentId: string): LearningLoopReportDto | null {
    const incident = this.getIncident(incidentId);
    if (!incident) return null;
    const session = this.getSessionForIncident(incidentId);
    if (!session) return null;
    const verifications = this.listVerifications(incidentId);
    if (!verifications.some((entry) => entry.finalVerdict)) return null;
    const experiences = (
      this.database
        .prepare("SELECT * FROM learning_experiences WHERE incident_id = ? ORDER BY created_at ASC")
        .all(incidentId) as ExperienceRow[]
    ).map((row) => this.toExperience(row));
    const variantIds = [
      ...new Set(experiences.map((entry) => entry.strategyVariantId).filter((id): id is string => Boolean(id)))
    ];
    return {
      incident,
      session,
      interventions: this.listInterventions(incidentId),
      verifications,
      practiceItems: this.listPracticeItems(incidentId),
      reviewTasks: (
        this.database
          .prepare("SELECT * FROM learning_review_tasks WHERE incident_id = ? ORDER BY round ASC")
          .all(incidentId) as ReviewTaskRow[]
      ).map((row) => toReviewTask(row)),
      experiences,
      variants: variantIds
        .map((id) => this.getVariant(id))
        .filter((variant): variant is LearningStrategyVariantDto => variant !== null)
    };
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

  /**
   * Validates that a practice draft is allowed right now and returns the drafting context.
   * Errors are redirect-style: they tell the model which tool to call instead.
   * `expectedSessionId` pins a model-supplied incident id to the session the tool is
   * mounted for — without it a foreign incident UUID could farm rejections into another
   * session's fallback counter.
   */
  practiceDraftContext(
    incidentId: string,
    expectedSessionId?: string
  ): {
    incident: LearningIncidentDto;
    session: LearningSessionDto;
    round: number;
  } {
    const incident = this.requireIncident(incidentId);
    this.assertIncidentCurrent(incident);
    if (incident.status === "diagnosed")
      throw learningConflict(
        "Drafting a check requires an intervention first: call record_learning_intervention for this incident, then draft the practice task"
      );
    if (incident.status !== "intervening")
      throw learningConflict(`A practice task cannot be drafted for a ${incident.status} learning incident`);
    const session = this.sessionForIncident(incident.id);
    if (expectedSessionId && session.id !== expectedSessionId)
      throw learningConflict("The incident does not belong to this learning session");
    this.assertSessionActive(session);
    return { incident, session, round: this.interventionCount(incident.id) };
  }

  /**
   * Texts a fresh practice task must not repeat: the session's approved/delivered practice
   * items and verification prompts (the most common duplicate is re-asking a previous
   * check), plus the session goal itself. Rejected and expired drafts are deliberately
   * excluded — the learner never saw them, and counting a rejected draft against its own
   * revision would turn every substantive rejection into an automatic novelty rejection
   * on retry (two strikes and the prose fallback unlocks, gutting the treatment arm).
   */
  practiceCorpus(incidentId: string): string[] {
    const session = this.sessionForIncident(incidentId);
    const items = this.database
      .prepare(
        `SELECT p.task_text FROM learning_practice_items p
           JOIN learning_incidents i ON i.id = p.incident_id
          WHERE i.session_id = ? AND p.status IN ('approved', 'consumed') ORDER BY p.created_at ASC`
      )
      .all(session.id) as Array<{ task_text: string }>;
    const prompts = this.database
      .prepare(
        `SELECT v.prompt FROM learning_verifications v
           JOIN learning_incidents i ON i.id = v.incident_id
          WHERE i.session_id = ? ORDER BY v.created_at ASC`
      )
      .all(session.id) as Array<{ prompt: string }>;
    return [
      ...items.map((row) => row.task_text),
      ...prompts.map((row) => row.prompt),
      ...(session.goal ? [session.goal] : [])
    ];
  }

  recordPracticeItem(input: {
    incidentId: string;
    round: number;
    status: "approved" | "rejected";
    taskText: string;
    targetHypothesis: string;
    expectedAnswerSketch: string;
    difficulty: number;
    method: LearningVerificationMethod;
    gate: "programmatic" | "novelty" | "evaluator" | "none";
    evaluatorVerdict?: unknown;
    noveltyScore: number;
    expectedSessionId?: string;
  }): LearningPracticeItemDto {
    // The evaluator tier can hold the draft for up to 15s, during which the learner may
    // send a message (superseding the incident), escalate, pause the session, or the tutor
    // may record another intervention. Re-derive the drafting context at write time so a
    // stale draft errors instead of landing as a live attempt against a moved state.
    const context = this.practiceDraftContext(input.incidentId, input.expectedSessionId);
    const participantId = context.session.participantId;
    if (context.round !== input.round)
      throw learningConflict(
        "The learning state moved while the draft was under review; draft a fresh task for the current round"
      );
    // A revisit incident's checks are review-sourced for ALL its rounds. Round two of a
    // revisit is drafted in a later run than the one the review runner fired, so run
    // identity would split one revisit's items across both source values; the incident is
    // the category boundary.
    const source = context.incident.reviewOf ? "review" : "tutor";
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO learning_practice_items
           (id, incident_id, participant_id, round, source, status, task_text, target_hypothesis, expected_answer_sketch,
            difficulty, method, gate, evaluator_verdict_json, novelty_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.incidentId,
        participantId,
        input.round,
        source,
        input.status,
        clean(input.taskText, 2_000),
        clean(input.targetHypothesis, 1_000),
        clean(input.expectedAnswerSketch, 1_000),
        input.difficulty,
        input.method,
        input.gate,
        input.evaluatorVerdict === undefined ? null : JSON.stringify(input.evaluatorVerdict),
        input.noveltyScore,
        this.clock()
      );
    return this.requirePracticeItem(id);
  }

  getPracticeItem(id: string): LearningPracticeItemDto | null {
    const row = this.database.prepare("SELECT * FROM learning_practice_items WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toPracticeItem(row) : null;
  }

  /**
   * Substantive rejections only: novelty/evaluator disagreements unlock the prose fallback
   * after two strikes, but programmatic-gate failures do not count — they are form errors
   * (empty text, out-of-range difficulty, pasted answer) the tutor can always fix, and
   * counting them would let two deliberately malformed drafts buy an un-gated verification.
   */
  practiceRejectionCount(incidentId: string, round: number): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS n FROM learning_practice_items WHERE incident_id = ? AND round = ? AND status = 'rejected' AND gate != 'programmatic'"
      )
      .get(incidentId, round) as { n: number };
    return row.n;
  }

  private requirePracticeItem(id: string): LearningPracticeItemDto {
    const item = this.getPracticeItem(id);
    if (!item) throw new LearningNotFoundError("Learning practice item not found");
    return item;
  }

  private interventionCount(incidentId: string): number {
    return (
      this.database
        .prepare("SELECT COUNT(*) AS n FROM learning_interventions WHERE incident_id = ?")
        .get(incidentId) as {
        n: number;
      }
    ).n;
  }

  private toPracticeItem(row: Record<string, unknown>): LearningPracticeItemDto {
    return {
      id: String(row.id),
      incidentId: String(row.incident_id),
      participantId: String(row.participant_id ?? "default"),
      round: Number(row.round),
      source: row.source === "review" ? "review" : "tutor",
      status: String(row.status) as LearningPracticeItemStatus,
      taskText: String(row.task_text),
      targetHypothesis: String(row.target_hypothesis),
      expectedAnswerSketch: String(row.expected_answer_sketch),
      difficulty: Number(row.difficulty),
      method: String(row.method) as LearningVerificationMethod,
      gate: String(row.gate) as LearningPracticeItemDto["gate"],
      evaluatorVerdict:
        row.evaluator_verdict_json === null || row.evaluator_verdict_json === undefined
          ? null
          : parseJson<unknown>(String(row.evaluator_verdict_json), null),
      noveltyScore: Number(row.novelty_score ?? 0),
      createdAt: iso(Number(row.created_at))!
    };
  }

  /**
   * Live, active, agent-mode sessions whose open incident sits in a state where the tutor —
   * not the learner — owes the next move, with the two learner-owed states excluded:
   * waiting for the learner's confirmation, and waiting for the learner to answer a
   * requested verification. `runsSinceProgress` counts completed runs since the incident
   * last moved, so the watchdog's threshold is turn-based and a slow human cannot trip it.
   */
  stallCandidates(): LearningStallCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT s.id AS session_id, s.conversation_id, s.condition, i.id AS incident_id, i.status,
                (SELECT COUNT(*) FROM learning_interventions x WHERE x.incident_id = i.id) AS n_interventions,
                (SELECT COUNT(*) FROM learning_verifications v WHERE v.incident_id = i.id) AS n_verifications,
                (SELECT COUNT(*) FROM runs r
                  WHERE r.conversation_id = s.conversation_id AND r.status = 'completed'
                    AND r.created_at > i.updated_at) AS runs_since_progress,
                (SELECT MAX(r.created_at) FROM runs r
                  WHERE r.conversation_id = s.conversation_id AND r.status = 'completed') AS last_run_at
           FROM learning_sessions s
           JOIN learning_incidents i ON i.session_id = s.id AND i.superseded_at IS NULL
          WHERE s.dataset_kind = 'live' AND s.status = 'active' AND s.execution_mode = 'agent'
            AND i.status IN ('diagnosed', 'intervening', 'verifying')`
      )
      .all() as Array<{
      session_id: string;
      conversation_id: string;
      condition: string;
      incident_id: string;
      status: string;
      n_interventions: number;
      n_verifications: number;
      runs_since_progress: number;
      last_run_at: number | null;
    }>;
    const candidates: LearningStallCandidate[] = [];
    for (const row of rows) {
      if (row.status === "verifying") {
        const verification = this.database
          .prepare(
            `SELECT system_verdict, response_after_run_created_at FROM learning_verifications
              WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1`
          )
          .get(row.incident_id) as
          | { system_verdict: string | null; response_after_run_created_at: number | null }
          | undefined;
        // Learner-owed states are not stalls: a proposed verdict awaiting confirmation, or a
        // question the learner has not answered yet. "Answered" counts only learner turns —
        // a spaced-review prompt or a watchdog nudge completing its own run is not an answer.
        if (verification?.system_verdict !== null && verification?.system_verdict !== undefined) continue;
        if (this.completedLearnerRunsAfter(row.conversation_id, verification?.response_after_run_created_at ?? 0) === 0)
          continue;
      }
      candidates.push({
        sessionId: row.session_id,
        conversationId: row.conversation_id,
        condition: row.condition as LearningCondition,
        incidentId: row.incident_id,
        status: row.status as LearningIncidentStatus,
        signature: `${row.status}:${row.n_interventions}:${row.n_verifications}`,
        runsSinceProgress: row.runs_since_progress,
        lastRunAt: row.last_run_at
      });
    }
    return candidates;
  }

  completedRunsAfter(conversationId: string, timestamp: number): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ? AND status = 'completed' AND created_at > ?")
      .get(conversationId, timestamp) as { n: number };
    return row.n;
  }

  /**
   * Completed runs after `timestamp` that the learner actually initiated: runs submitted by
   * the harness itself — watchdog nudges and spaced-review revisits — are excluded, so
   * "the learner has answered" can never be satisfied by the loop talking to itself.
   */
  completedLearnerRunsAfter(conversationId: string, timestamp: number): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS n FROM runs r
          WHERE r.conversation_id = ? AND r.status = 'completed' AND r.created_at > ?
            AND NOT EXISTS(SELECT 1 FROM learning_watchdog_events w WHERE w.run_id = r.id)
            AND NOT EXISTS(SELECT 1 FROM learning_review_tasks task WHERE task.fired_run_id = r.id)`
      )
      .get(conversationId, timestamp) as { n: number };
    return row.n;
  }

  watchdogEvent(
    incidentId: string,
    signature: string,
    action: "nudged" | "gave_up"
  ): { id: string; createdAt: number; runId: string | null } | null {
    const row = this.database
      .prepare(
        `SELECT id, created_at, run_id FROM learning_watchdog_events
          WHERE incident_id = ? AND signature = ? AND action = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(incidentId, signature, action) as { id: string; created_at: number; run_id: string | null } | undefined;
    return row ? { id: row.id, createdAt: row.created_at, runId: row.run_id ?? null } : null;
  }

  deleteWatchdogEvent(id: string): void {
    this.database.prepare("DELETE FROM learning_watchdog_events WHERE id = ?").run(id);
  }

  recordWatchdogEvent(input: {
    sessionId: string;
    incidentId: string;
    signature: string;
    action: "nudged" | "gave_up";
  }): string {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO learning_watchdog_events (id, session_id, incident_id, signature, action, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(id, input.sessionId, input.incidentId, input.signature, input.action, this.clock());
    return id;
  }

  attachWatchdogRun(id: string, runId: string): void {
    this.database.prepare("UPDATE learning_watchdog_events SET run_id = ? WHERE id = ?").run(runId, id);
  }

  /**
   * The verification currently waiting for the learner's own confirmation in this
   * conversation, if any — the server-side twin of the web's confirm-button gate.
   */
  pendingLearnerConfirmation(conversationId: string): {
    verification: LearningVerificationDto;
    incident: LearningIncidentDto;
    finalRound: boolean;
  } | null {
    const session = this.getSessionForConversation(conversationId);
    if (!session || session.status !== "active") return null;
    const row = this.database
      .prepare(
        `SELECT v.id FROM learning_verifications v
           JOIN learning_incidents i ON i.id = v.incident_id
          WHERE i.session_id = ? AND i.superseded_at IS NULL AND i.status = 'verifying'
            AND v.system_verdict IS NOT NULL AND v.user_verdict IS NULL
          ORDER BY v.created_at DESC LIMIT 1`
      )
      .get(session.id) as { id: string } | undefined;
    if (!row) return null;
    const verification = this.getVerification(row.id);
    if (!verification) return null;
    const incident = this.getIncident(verification.incidentId);
    if (!incident) return null;
    const interventionCount = (
      this.database
        .prepare("SELECT COUNT(*) AS count FROM learning_interventions WHERE incident_id = ?")
        .get(incident.id) as { count: number }
    ).count;
    return { verification, incident, finalRound: session.condition === "one-shot" || interventionCount >= 3 };
  }

  /**
   * The structured handoff for an escalated incident: what was tried round by round, what
   * the learner still cannot do, and which strategies a human tutor has not seen fail yet.
   * Deterministically rendered from the live tables — no model call.
   */
  handoffReport(incidentId: string): LearningHandoffReportDto | null {
    const incident = this.getIncident(incidentId);
    if (!incident || incident.status !== "escalated") return null;
    const session = this.getSessionForIncident(incidentId);
    if (!session) return null;
    const interventions = this.listInterventions(incidentId);
    const verifications = this.listVerifications(incidentId);
    // New verification rows always carry an interventionId (backfilled at write time), but
    // rows written before the backfill may not: link those to the latest intervention that
    // existed when the verification was requested, instead of rendering the attempt 未验证.
    const effectiveInterventionId = (entry: (typeof verifications)[number]): string | null =>
      entry.interventionId ??
      [...interventions].reverse().find((item) => item.createdAt <= entry.createdAt)?.id ??
      null;
    const attempts = interventions.map((item) => {
      const verification = verifications.filter((entry) => effectiveInterventionId(entry) === item.id).at(-1) ?? null;
      return {
        round: item.round,
        strategy: item.strategy,
        rationale: item.rationale,
        expectedSignal: item.expectedSignal,
        verificationPrompt: verification?.prompt ?? null,
        outcome: verification?.finalVerdict ?? verification?.systemVerdict ?? null
      };
    });
    const stillOpen = [
      ...new Set(
        verifications
          .filter((entry) => {
            const outcome = entry.finalVerdict ?? entry.systemVerdict;
            return outcome !== null && outcome !== "resolved" && entry.rubric.trim().length > 0;
          })
          .map((entry) => entry.rubric.trim())
      )
    ];
    const tried = [...new Set(interventions.map((item) => item.strategy))];
    const selection = this.selectStrategy({
      profileId: session.profileId,
      participantId: session.participantId,
      topicKey: session.topicKey,
      difficultyType: incident.difficultyType,
      datasetKind: session.datasetKind,
      failedStrategies: tried
    });
    const suggestedNextStrategies = selection.orderedStrategies
      .filter((strategy) => !tried.includes(strategy) && strategy !== "abstain_escalate")
      .slice(0, 3);
    const snapshot =
      incident.closedSnapshot && typeof incident.closedSnapshot === "object"
        ? (incident.closedSnapshot as Record<string, unknown>)
        : null;
    return {
      incidentId: incident.id,
      goal: session.goal,
      topicKey: session.topicKey ?? "",
      difficultyType: incident.difficultyType,
      hypothesis: incident.hypothesis,
      confidence: incident.confidence,
      severity: incident.severity,
      escalationReason: typeof snapshot?.reason === "string" ? snapshot.reason : null,
      attempts,
      stillOpen,
      suggestedNextStrategies,
      closedAt: incident.closedAt
    };
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
    participantId: string;
    topicKey?: string | null;
    difficultyType: LearningDifficultyType;
    datasetKind: LearningEvolvingDatasetKind;
  }): LearningExperienceDto[] {
    return (
      this.database
        .prepare(
          `SELECT e.* FROM learning_experiences e
       JOIN learning_incidents i ON i.id = e.incident_id
       WHERE e.profile_id = ? AND e.participant_id = ? AND e.topic_key = ? AND e.difficulty_type = ? AND e.dataset_kind = ?
         AND i.superseded_at IS NULL
       ORDER BY e.created_at ASC`
        )
        .all(
          clean(input.profileId, 100),
          input.participantId,
          topic(input.topicKey),
          input.difficultyType,
          input.datasetKind
        ) as ExperienceRow[]
    ).map((row) => this.toExperience(row));
  }

  /**
   * Descriptive aggregates over closed incidents, split by research condition. Everything is
   * computed from incidents/interventions/verifications so eval and one-shot runs are covered
   * even though they never write strategy experiences.
   */
  metricsSummary(input: {
    profileId?: string | null;
    /** Required and explicit: a participant id scopes, null is the whole-study view. */
    participantId: string | null;
    topicKey?: string | null;
    difficultyType?: LearningDifficultyType | null;
    datasetKind?: LearningDatasetKind | null;
  }): LearningMetricsDto {
    const clauses = ["i.superseded_at IS NULL"];
    const params: unknown[] = [];
    if (input.profileId) {
      clauses.push("s.profile_id = ?");
      params.push(clean(input.profileId, 100));
    }
    if (input.participantId) {
      clauses.push("s.participant_id = ?");
      params.push(input.participantId);
    }
    if (input.topicKey) {
      clauses.push("s.topic_key = ?");
      params.push(topic(input.topicKey));
    }
    if (input.difficultyType) {
      clauses.push("i.difficulty_type = ?");
      params.push(input.difficultyType);
    }
    if (input.datasetKind) {
      clauses.push("s.dataset_kind = ?");
      params.push(input.datasetKind);
    }
    const scoped = this.database
      .prepare(
        `SELECT i.id, i.status, i.created_at, i.closed_at, s.condition
       FROM learning_incidents i JOIN learning_sessions s ON s.id = i.session_id
       WHERE ${clauses.join(" AND ")}`
      )
      .all(...params) as Array<{
      id: string;
      status: string;
      created_at: number;
      closed_at: number | null;
      condition: string;
    }>;
    const scopedIds = new Set(scoped.map((row) => row.id));
    // Cells count only genuinely closed incidents; calibration below is verification-level
    // and also covers incidents that were later abandoned or are still open.
    const incidents = scoped.filter((row) => ["resolved", "unresolved", "escalated"].includes(row.status));
    const ids = new Set(incidents.map((row) => row.id));
    const rounds = new Map<string, number>();
    for (const row of this.database
      .prepare("SELECT incident_id, COUNT(*) AS rounds FROM learning_interventions GROUP BY incident_id")
      .all() as Array<{ incident_id: string; rounds: number }>) {
      if (ids.has(row.incident_id)) rounds.set(row.incident_id, row.rounds);
    }
    const confirmed = (
      this.database
        .prepare(
          `SELECT v.incident_id, v.final_verdict, v.system_verdict, v.system_confidence, v.created_at, iv.strategy
       FROM learning_verifications v LEFT JOIN learning_interventions iv ON iv.id = v.intervention_id
       WHERE v.final_verdict IN ('resolved', 'partial', 'unresolved')
       ORDER BY v.created_at ASC`
        )
        .all() as Array<{
        incident_id: string;
        final_verdict: "resolved" | "partial" | "unresolved";
        system_verdict: string | null;
        system_confidence: number | null;
        created_at: number;
        strategy: string | null;
      }>
    ).filter((row) => scopedIds.has(row.incident_id));
    const finalOutcome = new Map<string, "resolved" | "partial" | "unresolved">();
    for (const row of confirmed) if (ids.has(row.incident_id)) finalOutcome.set(row.incident_id, row.final_verdict);

    const cell = (subset: typeof incidents): LearningMetricsCellDto => {
      const outcomes = { resolved: 0, partial: 0, unresolved: 0 };
      const roundCounts: number[] = [];
      const closeTimes: number[] = [];
      let escalated = 0;
      let firstRoundResolved = 0;
      const strategyMap = new Map<string, { resolved: number; partial: number; unresolved: number }>();
      const subsetIds = new Set(subset.map((row) => row.id));
      for (const row of subset) {
        const outcome = finalOutcome.get(row.id) ?? "unresolved";
        outcomes[outcome] += 1;
        if (row.status === "escalated") escalated += 1;
        const roundCount = rounds.get(row.id) ?? 0;
        roundCounts.push(roundCount);
        if (outcome === "resolved" && roundCount <= 1) firstRoundResolved += 1;
        if (row.closed_at !== null) closeTimes.push(row.closed_at - row.created_at);
      }
      for (const row of confirmed) {
        if (!subsetIds.has(row.incident_id) || !row.strategy) continue;
        const entry = strategyMap.get(row.strategy) ?? { resolved: 0, partial: 0, unresolved: 0 };
        entry[row.final_verdict] += 1;
        strategyMap.set(row.strategy, entry);
      }
      const total = subset.length;
      const sorted = [...roundCounts].sort((left, right) => left - right);
      const median =
        sorted.length === 0
          ? null
          : sorted.length % 2 === 1
            ? sorted[(sorted.length - 1) / 2]!
            : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
      const mean = (values: number[]) =>
        values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
      return {
        incidents: total,
        outcomes,
        escalated,
        meanInterventionRounds: mean(roundCounts),
        medianInterventionRounds: median,
        firstRoundResolutionRate: total === 0 ? null : firstRoundResolved / total,
        resolutionWithoutEscalationRate:
          total === 0
            ? null
            : subset.filter(
                (row) => row.status !== "escalated" && (finalOutcome.get(row.id) ?? "unresolved") !== "unresolved"
              ).length / total,
        meanTimeToCloseMs: mean(closeTimes),
        strategyOutcomes: [...strategyMap.entries()]
          .map(([strategy, entry]) => ({ strategy: strategy as LearningInterventionStrategy, ...entry }))
          .sort((left, right) => left.strategy.localeCompare(right.strategy))
      };
    };

    const bins = [
      { lower: 0, upper: 0.6 },
      { lower: 0.6, upper: 0.7 },
      { lower: 0.7, upper: 0.8 },
      { lower: 0.8, upper: 0.9 },
      { lower: 0.9, upper: 1.000_001 }
    ];
    const calibration: LearningCalibrationBinDto[] = bins.map(({ lower, upper }) => {
      const rows = confirmed.filter(
        (row) =>
          row.system_confidence !== null &&
          row.system_verdict !== null &&
          row.system_confidence >= lower &&
          row.system_confidence < upper
      );
      const agreements = rows.filter((row) => row.system_verdict === row.final_verdict).length;
      return {
        lower,
        upper: Math.min(upper, 1),
        count: rows.length,
        meanConfidence:
          rows.length === 0 ? null : rows.reduce((sum, row) => sum + (row.system_confidence ?? 0), 0) / rows.length,
        agreementRate: rows.length === 0 ? null : agreements / rows.length
      };
    });

    // Session-level reliability: the incident cells above only see closed incidents, so a
    // loop that never opened one, stalled mid-way, or died on an errored run is invisible
    // there. The denominator here is sessions. difficultyType is incident-scoped, so this
    // block has no meaningful answer under that filter and reports null instead.
    let sessions: LearningMetricsDto["sessions"] = null;
    if (!input.difficultyType) {
      const sessionClauses = ["s.status NOT IN ('suggested', 'dismissed')", "s.execution_mode = 'agent'"];
      const sessionParams: unknown[] = [];
      if (input.profileId) {
        sessionClauses.push("s.profile_id = ?");
        sessionParams.push(clean(input.profileId, 100));
      }
      if (input.participantId) {
        sessionClauses.push("s.participant_id = ?");
        sessionParams.push(input.participantId);
      }
      if (input.topicKey) {
        sessionClauses.push("s.topic_key = ?");
        sessionParams.push(topic(input.topicKey));
      }
      if (input.datasetKind) {
        sessionClauses.push("s.dataset_kind = ?");
        sessionParams.push(input.datasetKind);
      }
      const sessionRows = this.database
        .prepare(
          `SELECT s.id, s.condition,
                  (SELECT COUNT(*) FROM learning_incidents i WHERE i.session_id = s.id) AS incident_count,
                  (SELECT COUNT(*) FROM runs r
                    WHERE r.conversation_id = s.conversation_id AND r.status = 'completed'
                      AND r.created_at >= s.created_at) AS completed_runs,
                  EXISTS(SELECT 1 FROM runs r
                          WHERE r.conversation_id = s.conversation_id AND r.status = 'failed'
                            AND r.created_at >= s.created_at) AS errored,
                  EXISTS(SELECT 1 FROM learning_watchdog_events w
                          WHERE w.session_id = s.id AND w.action = 'gave_up') AS gave_up,
                  EXISTS(SELECT 1 FROM learning_watchdog_events w
                          WHERE w.session_id = s.id AND w.action = 'nudged') AS nudged,
                  EXISTS(SELECT 1 FROM learning_watchdog_events w
                          WHERE w.session_id = s.id AND w.action = 'nudged'
                            AND (EXISTS(SELECT 1 FROM learning_interventions x
                                         WHERE x.incident_id = w.incident_id AND x.created_at > w.created_at)
                                 OR EXISTS(SELECT 1 FROM learning_verifications v
                                            WHERE v.incident_id = w.incident_id
                                              AND (v.created_at > w.created_at
                                                   OR v.proposed_at > w.created_at
                                                   OR v.confirmed_at > w.created_at)))) AS recovered
             FROM learning_sessions s
            WHERE ${sessionClauses.join(" AND ")}`
        )
        .all(...sessionParams) as Array<{
        id: string;
        condition: string;
        incident_count: number;
        completed_runs: number;
        errored: number;
        gave_up: number;
        nudged: number;
        recovered: number;
      }>;
      // The three failure categories are independent predicates, not a partition — a session
      // can be several at once. `unhealthy` counts distinct sessions so a rate over it can
      // never exceed 100%.
      const isNeverOpened = (row: (typeof sessionRows)[number]) => row.incident_count === 0 && row.completed_runs >= 3;
      const tally = (rows: typeof sessionRows) => ({
        total: rows.length,
        neverOpened: rows.filter(isNeverOpened).length,
        stalledMidLoop: rows.filter((row) => row.gave_up === 1).length,
        errored: rows.filter((row) => row.errored === 1).length,
        unhealthy: rows.filter((row) => isNeverOpened(row) || row.gave_up === 1 || row.errored === 1).length
      });
      sessions = {
        ...tally(sessionRows),
        nudged: sessionRows.filter((row) => row.nudged === 1).length,
        recoveredAfterNudge: sessionRows.filter((row) => row.recovered === 1).length,
        conditions: LEARNING_CONDITIONS.map((condition) => ({
          condition,
          ...tally(sessionRows.filter((row) => row.condition === condition))
        }))
      };
    }

    return {
      scope: {
        profileId: input.profileId ? clean(input.profileId, 100) : null,
        participantId: input.participantId ?? null,
        topicKey: input.topicKey ? topic(input.topicKey) : null,
        difficultyType: input.difficultyType ?? null,
        datasetKind: input.datasetKind ?? null
      },
      overall: cell(incidents),
      conditions: LEARNING_CONDITIONS.map((condition) => ({
        condition,
        ...cell(incidents.filter((row) => row.condition === condition))
      })),
      sessions,
      calibration,
      generatedAt: iso(this.clock())!
    };
  }

  /** Everything the research export needs, as plain DTOs; redaction happens at the API layer. */
  exportResearch(participantId?: string): {
    sessions: LearningSessionDto[];
    incidents: LearningIncidentDto[];
    interventions: LearningInterventionDto[];
    verifications: LearningVerificationDto[];
    experiences: LearningExperienceDto[];
    policyRevisions: LearningPolicyRevisionDto[];
    handoffs: LearningHandoffReportDto[];
    strategyVariants: LearningStrategyVariantDto[];
    practiceItems: LearningPracticeItemDto[];
    reviewTasks: LearningReviewTask[];
    watchdogEvents: Array<{
      id: string;
      sessionId: string;
      incidentId: string;
      signature: string;
      action: string;
      runId: string | null;
      createdAt: string;
    }>;
  } {
    // With a participant filter, every table is scoped through its own participant column
    // or its incident/session lineage, so a per-person export is self-consistent (joins
    // inside it never dangle).
    const bySession = "session_id IN (SELECT id FROM learning_sessions WHERE participant_id = ?)";
    const byIncident =
      "incident_id IN (SELECT i.id FROM learning_incidents i JOIN learning_sessions s ON s.id = i.session_id WHERE s.participant_id = ?)";
    const all = <T>(table: string, map: (row: Record<string, unknown>) => T, where?: string): T[] => {
      const filter = participantId && where ? ` WHERE ${where}` : "";
      const params = participantId && where ? [participantId] : [];
      return (
        this.database.prepare(`SELECT * FROM ${table}${filter} ORDER BY created_at ASC`).all(...params) as Record<
          string,
          unknown
        >[]
      ).map(map);
    };
    const incidents = all("learning_incidents", (row) => this.toIncident(row), bySession);
    return {
      sessions: all("learning_sessions", (row) => this.toSession(row), "participant_id = ?"),
      incidents,
      interventions: all("learning_interventions", (row) => this.toIntervention(row), byIncident),
      verifications: all("learning_verifications", (row) => this.toVerification(row), byIncident),
      experiences: all("learning_experiences", (row) => this.toExperience(row), "participant_id = ?"),
      policyRevisions: all("learning_policy_revisions", (row) => this.toPolicy(row), "participant_id = ?"),
      handoffs: incidents
        .filter((incident) => incident.status === "escalated")
        .map((incident) => this.handoffReport(incident.id))
        .filter((report): report is LearningHandoffReportDto => report !== null),
      strategyVariants: (() => {
        const rows = (
          participantId
            ? this.database
                .prepare("SELECT * FROM learning_strategy_variants WHERE participant_id = ? ORDER BY created_at ASC")
                .all(participantId)
            : this.database.prepare("SELECT * FROM learning_strategy_variants ORDER BY created_at ASC").all()
        ) as VariantRow[];
        const counts = this.variantAttributedCounts(rows.map((row) => row.id));
        return rows.map((row) => this.toVariant(row, counts.get(row.id) ?? 0));
      })(),
      practiceItems: all("learning_practice_items", (row) => this.toPracticeItem(row), "participant_id = ?"),
      // Reliability is research data too: without the ledger, the sessions-health metrics
      // (stalled/nudged/recovered) could not be recomputed from the export.
      reviewTasks: all(
        "learning_review_tasks",
        (row) => toReviewTask(row as unknown as ReviewTaskRow),
        "participant_id = ?"
      ),
      watchdogEvents: all(
        "learning_watchdog_events",
        (row) => ({
          id: String(row.id),
          sessionId: String(row.session_id),
          incidentId: String(row.incident_id),
          signature: String(row.signature),
          action: String(row.action),
          runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
          createdAt: iso(Number(row.created_at))!
        }),
        bySession
      )
    };
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
             (id, verification_id, incident_id, profile_id, participant_id, topic_key, difficulty_type, strategy, outcome, dataset_kind, snapshot_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?)`
            )
            .run(
              experienceId,
              verificationId,
              incidentId,
              session.profileId,
              session.participantId,
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
    participantId: string;
    topicKey: string;
    difficultyType: LearningDifficultyType;
    datasetKind: LearningEvolvingDatasetKind;
  }): LearningPolicyRevisionDto | null {
    const row = this.database
      .prepare(
        `SELECT * FROM learning_policy_revisions WHERE profile_id = ? AND participant_id = ? AND topic_key = ? AND difficulty_type = ? AND dataset_kind = ? AND status = 'enabled' ORDER BY updated_at DESC LIMIT 1`
      )
      .get(scope.profileId, scope.participantId, scope.topicKey, scope.difficultyType, scope.datasetKind) as
      | PolicyRow
      | undefined;
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

  private toConditionAssignment(value: unknown): LearningConditionAssignment | null {
    // Research provenance must be well-formed or absent — a hand-edited row must not flow
    // into the export looking like a valid assignment.
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    const conditions = Array.isArray(raw.conditions)
      ? raw.conditions.filter(
          (item): item is LearningCondition => typeof item === "string" && has(LEARNING_CONDITIONS, item)
        )
      : [];
    if (
      typeof raw.seed !== "number" ||
      !Number.isInteger(raw.seed) ||
      raw.seed < 0 ||
      typeof raw.index !== "number" ||
      !Number.isInteger(raw.index) ||
      raw.index < 0 ||
      conditions.length < 2
    )
      return null;
    return { seed: raw.seed, index: raw.index, conditions };
  }

  private toSession(row: SessionRow): LearningSessionDto {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      profileId: String(row.profile_id),
      participantId: String(row.participant_id ?? "default"),
      goal: String(row.goal),
      topicKey: optionalTopic(String(row.topic_key)),
      status: String(row.status) as LearningSessionStatus,
      datasetKind: String(row.dataset_kind) as LearningDatasetKind,
      condition: String(row.condition ?? "on-call") as LearningCondition,
      conditionAssignment:
        row.condition_assignment === null || row.condition_assignment === undefined
          ? null
          : this.toConditionAssignment(parseJson<unknown>(String(row.condition_assignment), null)),
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
      reviewOf: this.reviewOrigin(
        row.opened_run_id === null || row.opened_run_id === undefined ? null : String(row.opened_run_id)
      ),
      status: String(row.status) as LearningIncidentStatus,
      closedSnapshot: row.closed_snapshot_json === null ? null : parseJson(String(row.closed_snapshot_json), null),
      createdAt: iso(Number(row.created_at))!,
      updatedAt: iso(Number(row.updated_at))!,
      closedAt: row.closed_at === null ? null : iso(Number(row.closed_at)),
      supersededAt:
        row.superseded_at === null || row.superseded_at === undefined ? null : iso(Number(row.superseded_at))
    };
  }
  /** The revisit that opened this incident, if a fired review task submitted its run. */
  private reviewOrigin(openedRunId: string | null): { incidentId: string; round: number } | null {
    if (!openedRunId) return null;
    const row = this.database
      .prepare("SELECT incident_id, round FROM learning_review_tasks WHERE fired_run_id = ? LIMIT 1")
      .get(openedRunId) as { incident_id: string; round: number } | undefined;
    return row ? { incidentId: String(row.incident_id), round: Number(row.round) } : null;
  }
  private toIntervention(row: InterventionRow): LearningInterventionDto {
    return {
      id: String(row.id),
      incidentId: String(row.incident_id),
      strategy: String(row.strategy) as LearningInterventionStrategy,
      rationale: String(row.rationale),
      expectedSignal: String(row.expected_signal),
      policyRevisionId: row.policy_revision_id === null ? null : String(row.policy_revision_id),
      strategyVariantId:
        row.strategy_variant_id === null || row.strategy_variant_id === undefined
          ? null
          : String(row.strategy_variant_id),
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
      practiceItemId:
        row.practice_item_id === null || row.practice_item_id === undefined ? null : String(row.practice_item_id),
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
      participantId: String(row.participant_id ?? "default"),
      topicKey: optionalTopic(String(row.topic_key)),
      difficultyType: String(row.difficulty_type) as LearningDifficultyType,
      strategy: String(row.strategy) as LearningInterventionStrategy,
      outcome: String(row.outcome) as Exclude<LearningOutcome, "unknown">,
      datasetKind: String(row.dataset_kind) as LearningEvolvingDatasetKind,
      strategyVariantId:
        row.strategy_variant_id === null || row.strategy_variant_id === undefined
          ? null
          : String(row.strategy_variant_id),
      createdAt: iso(Number(row.created_at))!
    };
  }
  private toVariant(row: VariantRow, attributedCount = 0): LearningStrategyVariantDto {
    return {
      id: row.id,
      profileId: row.profile_id,
      participantId: row.participant_id ?? "default",
      topicKey: row.topic_key,
      difficultyType: row.difficulty_type as LearningDifficultyType,
      baseStrategy: row.base_strategy as LearningInterventionStrategy,
      title: row.title,
      instruction: row.instruction,
      origin: "distilled",
      status: row.status as LearningVariantStatus,
      sourceIncidentId: row.source_incident_id,
      recommendation: row.recommendation === "promote" || row.recommendation === "retire" ? row.recommendation : null,
      recommendationSummary: row.recommendation_summary,
      evidenceExperienceIds: parseJson<string[]>(row.evidence_experience_ids_json, []),
      attributedCount,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!
    };
  }
  private toPolicy(row: PolicyRow): LearningPolicyRevisionDto {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      participantId: String(row.participant_id ?? "default"),
      topicKey: optionalTopic(String(row.topic_key)),
      difficultyType: String(row.difficulty_type) as LearningDifficultyType,
      datasetKind: String(row.dataset_kind) as LearningEvolvingDatasetKind,
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
