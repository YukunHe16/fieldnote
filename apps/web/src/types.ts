export type ConversationState = "active" | "archived";
export type RunState =
  | "idle"
  | "submitting"
  | "running"
  | "interrupting"
  | "interrupted"
  | "completed"
  | "failed"
  | "reconnecting";

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "streaming" | "completed" | "interrupted" | "failed";
export type SendMode = "normal" | "guide" | "queue";
export type MessageAcceptance = "new_run" | "supplement" | "queued";
export type MemoryCategory = "profile" | "preference" | "goal" | "project" | "task";
export type MemorySourceKind = "auto" | "explicit" | "manual";
export type EvolutionPolarity = "up" | "down";
export type PlaybookPolarity = "do" | "dont";
export type PlaybookOrigin = "user" | "confirmed" | "distilled";

export interface Playbook {
  id: string;
  title: string;
  instruction: string;
  polarity: PlaybookPolarity;
  origin: PlaybookOrigin;
  enabled: boolean;
}

export interface HandbookDocument {
  profileId: string | null;
  markdown: string;
  playbooks: Playbook[];
}

export interface ShelfItem {
  id: string;
  profileId: string;
  conversationId: string | null;
  fileName: string;
  mimeType: string;
  relativePath: string;
  createdAt: string;
}

export interface ConversationReplay {
  sourceRunId: string;
  mode: "frozen" | "with-artifact";
  includeArtifactId?: string | null;
  prompt: string;
  overlay: {
    playbookIds: string[];
    artifactIds: string[];
    cardTitle: string | null;
    playbooks: Array<{ id: string; title: string; polarity: PlaybookPolarity; instruction?: string }>;
  };
}

export type WorkspaceTab = "memory" | "handbook" | "capabilities" | "shelf";
export type EquipmentOrigin = "official" | "evolved";
export type EvolvedArtifactStatus = "pending" | "enabled" | "rejected" | "disabled";

export interface EquipmentItem {
  id: string;
  name: string;
  description: string;
  origin: EquipmentOrigin;
  enabled: boolean;
  artifactId?: string;
}

export interface EvolvedArtifact {
  id: string;
  profileId: string;
  kind: "skill" | "subagent";
  slug: string;
  name: string;
  description: string;
  body: string;
  status: EvolvedArtifactStatus;
  origin: "user" | "distilled";
  revision: number;
  evaluation: { verdict: "pass" | "reject" | "needs_human"; reason: string; replayRunId?: string | null } | null;
}

export interface ProfileEquipment {
  profileId: string;
  skills: EquipmentItem[];
  delegates: EquipmentItem[];
  pending: EvolvedArtifact[];
  usage?: Record<string, { uses: number; retriedRuns: number }>;
  suggestions?: Record<string, string>;
}
export type AgentProfileId = "local-operator" | string;
export type AssistantBlockStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export type AssistantBlockKind = "text" | "activity" | "subagent" | "skill" | "mcp" | "cron" | "tool" | "thinking";

export interface AssistantActivityDto {
  id: string;
  parentActivityId: string | null;
  kind: "skill" | "mcp" | "subagent" | "cron" | "workspace";
  displayName: string;
  technicalName: string;
  status: "running" | "completed" | "failed" | "interrupted";
  content: string;
  inputSummary: string;
  outputSummary: string;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentProfileSummary {
  id: AgentProfileId;
  name: string;
  description: string;
}

export interface AssistantBlockDto {
  id: string;
  runId?: string | null;
  messageId?: string;
  parentBlockId?: string | null;
  owner?: "main" | "subagent";
  kind?: "text" | "activity" | "subagent" | "thinking";
  order?: number;
  content?: string;
  activity?: AssistantActivityDto | null;
  type: AssistantBlockKind;
  status: AssistantBlockStatus;
  text?: string;
  title?: string;
  name?: string;
  technicalName?: string;
  parentId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  children: AssistantBlockDto[];
  [key: string]: unknown;
}

export interface Capabilities {
  attachments?: {
    enabled?: boolean;
    maxFiles?: number;
    maxBytes?: number;
    accept?: string[];
  };
  runtime?: "claude" | "demo";
  claudeConfigured?: boolean;
  claudeAuthSource?: RuntimeAuthSource;
  reasoningSummary?: boolean;
  tools?: boolean;
  channels?: string[];
  [key: string]: unknown;
}

export interface FeishuChannelStatus {
  configured: boolean;
  connected: boolean;
  appId: string;
  hasSecret: boolean;
  allowedOpenIds: string[];
  error: string | null;
}

export interface FeishuSettingsInput {
  appId: string;
  appSecret?: string;
  allowedOpenIds: string[];
}

export type RuntimeAuthSource = "process-env" | "user-settings" | "oauth-credentials" | "local-settings" | "none";

export interface RuntimeConfigStatus {
  runtime: "claude" | "demo";
  authConfigured: boolean;
  authSource: RuntimeAuthSource;
  hasAuthToken: boolean;
  baseUrl: string;
  model: string;
  provider?: string;
  modelMappings?: Record<string, string>;
}

export interface RuntimeConfigInput {
  authToken?: string;
  baseUrl: string;
  model: string;
  provider?: string;
  modelMappings?: Record<string, string>;
}

export interface RuntimeTestInput {
  authToken?: string;
  baseUrl?: string;
  model?: string;
  modelMappings?: Record<string, string>;
}

export interface RuntimeTestResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

export type DiagnosticsStatus = "ok" | "warn" | "fail";

export interface DiagnosticsCheck {
  id: string;
  status: DiagnosticsStatus;
  label: string;
  labelEn: string;
  detail?: string;
  hint?: string;
  hintEn?: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  checks: DiagnosticsCheck[];
}

export interface OnboardingState {
  completed: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  size?: number;
  type?: string;
  url?: string;
  status?: "uploading" | "ready" | "failed";
  [key: string]: unknown;
}

export interface MemorySourceDto {
  id: string;
  conversationId: string | null;
  conversationTitle: string;
  excerpt: string;
  sourceDeleted: boolean;
  createdAt: string;
}

export interface MemoryItemDto {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  keywords: string[];
  sourceKind: MemorySourceKind;
  scope: "global" | "profile";
  profileId: string | null;
  importance: number;
  pinned: boolean;
  status: "active" | "superseded";
  sources: MemorySourceDto[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryReferenceDto {
  memoryId: string;
  category: MemoryCategory;
  title: string;
  content: string;
  source: MemorySourceDto | null;
}

export interface MemorySettingsDto {
  enabled: boolean;
  autoSave: boolean;
  referenceHistory: boolean;
}

export interface MemoryMaintenanceStatusDto {
  status: "idle" | "running" | "failed";
  lastRunAt: string;
  lastCompletedAt: string | null;
  nextScheduledAt: string;
  newTaskCount: number;
  taskThreshold: number;
  intervalDays: number;
  due: boolean;
  lastError: string | null;
}

export type LearningSessionStatus = "suggested" | "active" | "paused" | "completed" | "dismissed";
export type LearningDatasetKind = "live" | "demo" | "replay" | "eval";
export type LearningCondition = "on-call" | "one-shot" | "multi-turn";
/** Present when the condition was drawn from a seeded study sequence rather than picked by hand. */
export interface LearningConditionAssignment {
  seed: number;
  index: number;
  conditions: LearningCondition[];
}
export type LearningExecutionMode = "agent" | "deterministic";
export type LearningIncidentStatus =
  | "observing"
  | "diagnosed"
  | "intervening"
  | "verifying"
  | "resolved"
  | "unresolved"
  | "escalated"
  | "abandoned";
export type LearningDifficultyType =
  | "planning_gap"
  | "conceptual_misconception"
  | "procedural_gap"
  | "feedback_uncertainty"
  | "prerequisite_gap"
  | "other";
export type LearningInterventionStrategy =
  | "socratic_question"
  | "conceptual_hint"
  | "contrastive_example"
  | "worked_example"
  | "analogical_example"
  | "direct_explanation"
  | "evidence_check"
  | "abstain_escalate";
export type LearningVerificationMethod =
  | "self_explanation"
  | "transfer_example"
  | "prediction"
  | "comparison"
  | "user_report";
export type LearningOutcome = "resolved" | "partial" | "unresolved" | "unknown";
export type LearningPolicyStatus = "pending" | "enabled" | "rejected" | "disabled";

export interface LearningSessionDto {
  id: string;
  conversationId: string;
  profileId: string;
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
  incidents: LearningIncidentDto[];
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
  reviewOf: { incidentId: string; round: number } | null;
  status: LearningIncidentStatus;
  closedSnapshot: unknown | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  supersededAt: string | null;
  interventions: LearningInterventionDto[];
  verifications: LearningVerificationDto[];
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
  practiceItemId: string | null;
  createdAt: string;
  proposedAt: string | null;
  confirmedAt: string | null;
}

export interface LearningPolicyRevisionDto {
  id: string;
  profileId: string;
  topicKey: string | null;
  difficultyType: LearningDifficultyType;
  datasetKind: Exclude<LearningDatasetKind, "replay" | "eval">;
  orderedStrategies: LearningInterventionStrategy[];
  evidenceExperienceIds: string[];
  previousRevisionId: string | null;
  status: LearningPolicyStatus;
  evaluationSummary: string;
  preview: {
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
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningMetricsCellDto {
  incidents: number;
  outcomes: { resolved: number; partial: number; unresolved: number };
  escalated: number;
  meanInterventionRounds: number | null;
  medianInterventionRounds: number | null;
  firstRoundResolutionRate: number | null;
  resolutionWithoutEscalationRate: number | null;
  meanTimeToCloseMs: number | null;
  strategyOutcomes: Array<{
    strategy: LearningInterventionStrategy;
    resolved: number;
    partial: number;
    unresolved: number;
  }>;
}

export interface LearningCalibrationBinDto {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number | null;
  agreementRate: number | null;
}

export interface LearningMetricsDto {
  scope: {
    profileId: string | null;
    topicKey: string | null;
    difficultyType: LearningDifficultyType | null;
    datasetKind: LearningDatasetKind | null;
  };
  overall: LearningMetricsCellDto;
  conditions: Array<{ condition: LearningCondition } & LearningMetricsCellDto>;
  sessions: LearningSessionsHealthDto | null;
  calibration: LearningCalibrationBinDto[];
  generatedAt: string;
}

/** Session-denominator reliability counts; null under a difficultyType filter. */
export interface LearningSessionsHealthDto {
  total: number;
  neverOpened: number;
  stalledMidLoop: number;
  errored: number;
  unhealthy: number;
  nudged: number;
  recoveredAfterNudge: number;
  conditions: Array<{
    condition: LearningCondition;
    total: number;
    neverOpened: number;
    stalledMidLoop: number;
    errored: number;
    unhealthy: number;
  }>;
}

export type LearningVariantStatus = "pending" | "trial" | "enabled" | "rejected" | "retired";

export interface LearningStrategyVariantDto {
  id: string;
  profileId: string;
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

export interface LearningHandoffAttemptDto {
  round: number;
  strategy: LearningInterventionStrategy;
  rationale: string;
  expectedSignal: string;
  verificationPrompt: string | null;
  outcome: LearningOutcome | null;
}

export interface LearningHandoffReportDto {
  incidentId: string;
  goal: string;
  topicKey: string;
  difficultyType: LearningDifficultyType;
  hypothesis: string;
  confidence: number;
  severity: number;
  escalationReason: string | null;
  attempts: LearningHandoffAttemptDto[];
  stillOpen: string[];
  suggestedNextStrategies: LearningInterventionStrategy[];
  closedAt: string | null;
}

export interface LearningDemoScenarioDto {
  id: string;
  title: string;
  description: string;
  preview: string;
  loop: string;
  goal: string;
  topicKey: string;
  difficultyType: LearningDifficultyType;
  synthetic: true;
  agentAvailable: boolean;
}

export type CollaborationTaskStatus = "queued" | "running" | "completed" | "failed" | "interrupted";
export type CollaborationFindingStatus = "verified" | "conflicting" | "unresolved";

export interface CollaborationFindingDto {
  claim: string;
  status: CollaborationFindingStatus;
  sourceUrls: string[];
  verifiedAt?: string;
}

export interface CollaborationTaskDto {
  id: string;
  runId: string;
  assistantMessageId: string;
  specialistId: string;
  displayName: string;
  sourceTaskId: string | null;
  requestSummary: string;
  status: CollaborationTaskStatus;
  resultSummary: string | null;
  structured: boolean;
  result: {
    summary: string;
    findings: CollaborationFindingDto[];
    openQuestions: string[];
    recommendedFollowups: Array<{ specialistId: string; question: string }>;
  } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CollaborationHandoffDto {
  id: string;
  runId: string;
  sourceTaskId: string;
  targetTaskId: string;
  question: string;
  status: CollaborationTaskStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CollaborationTraceDto {
  tasks: CollaborationTaskDto[];
  handoffs: CollaborationHandoffDto[];
  summary: {
    specialistCount: number;
    verifiedCount: number;
    conflictingCount: number;
    unresolvedCount: number;
    sourceCount: number;
    importantNotice: string | null;
  };
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status?: MessageStatus;
  attachments?: Attachment[];
  parentId?: string;
  runId?: string;
  clientMessageId?: string;
  memoryReferences?: MemoryReferenceDto[];
  blocks?: AssistantBlockDto[];
  reasoningSummary?: string | null;
  rating?: EvolutionPolarity | null;
  playbookReferences?: Array<{ id: string; title: string; polarity: PlaybookPolarity }>;
  skillReferences?: string[];
  learningVerifications?: LearningVerificationDto[];
  collaboration?: CollaborationTraceDto | null;
  [key: string]: unknown;
}

export interface Participant {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  state: ConversationState;
  pinned?: boolean;
  updatedAt: string;
  preview?: string;
  channel?: string;
  runState?: RunState;
  activeRunId?: string;
  temporary?: boolean;
  expiresAt?: string;
  profileId?: AgentProfileId;
  profileName?: string;
  participantId?: string;
  [key: string]: unknown;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
  freeForm?: boolean;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestion {
  questions: AskUserQuestionItem[];
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
  events?: AgentEvent[];
  queuedRuns?: Array<{ runId: string; userMessageId: string }>;
  lastEventSequence?: number;
  pendingQuestion?: AskUserQuestion | null;
  replay?: ConversationReplay | null;
  learningSession?: LearningSessionDto | null;
}

export interface AgentEvent {
  id: string;
  type: string;
  sequence?: number;
  createdAt?: string;
  cursor?: string;
  conversationId?: string;
  runId?: string;
  messageId?: string;
  content?: string;
  summary?: string;
  name?: string;
  status?: string;
  toolUseId?: string;
  tool_use_id?: string;
  callId?: string;
  call_id?: string;
  inputSummary?: string;
  outputSummary?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ApiList<T> {
  data?: T[];
  items?: T[];
  conversations?: T[];
  [key: string]: unknown;
}

export interface SendMessageResponse {
  message: ChatMessage;
  runId: string;
  acceptedAs: MessageAcceptance;
  conversation?: ConversationDetail;
  [key: string]: unknown;
}

export interface ToastMessage {
  id: string;
  message: string;
  tone?: "default" | "success" | "danger";
  action?: { label: string; onClick: () => void };
}
