export type ChannelKind = "web" | "feishu";
export type ConversationState = "active" | "archived";
export type RunMode = "normal" | "guide" | "queue";
export type MessageAcceptance = "new_run" | "supplement" | "queued";
export type MemoryCategory = "profile" | "preference" | "goal" | "project" | "task";
export type MemorySourceKind = "auto" | "explicit" | "manual";
export type MemoryScope = "global" | "profile";
export type AgentActivityKind = "skill" | "mcp" | "subagent" | "cron" | "workspace";
export type AgentActivityStatus = "running" | "completed" | "failed" | "interrupted";
export type RunStatus = "queued" | "running" | "interrupting" | "interrupted" | "completed" | "failed";

export type AgentEventType =
  | "run.started"
  | "run.status"
  | "run.interrupted"
  | "run.completed"
  | "run.failed"
  | "message.started"
  | "message.updated"
  | "message.text.delta"
  | "message.completed"
  | "reasoning.summary.delta"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "tool.failed"
  | "attachment.updated"
  | "activity.started"
  | "activity.updated"
  | "activity.text.delta"
  | "activity.completed"
  | "activity.failed"
  | "memory.recalled"
  | "memory.changed"
  | "learning.suggested"
  | "learning.session.updated"
  | "learning.incident.updated"
  | "learning.policy.updated"
  | "collaboration.task.updated"
  | "collaboration.handoff.updated"
  | "conversation.updated"
  | "conversation.archived"
  | "conversation.unarchived"
  | "conversation.deleted"
  | "user.question"
  | "user.answered";

export interface AgentRunEvent<T = Record<string, unknown>> {
  eventId: string;
  type: AgentEventType;
  sequence: number;
  timestamp: string;
  conversationId: string;
  branchId: string | null;
  runId: string | null;
  payload: T;
}

export interface AgentProfileSummaryDto {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  suggestedPrompts: string[];
  channels: ChannelKind[];
}

export type ApplicationProgramStatus =
  | "researching"
  | "shortlisted"
  | "applying"
  | "submitted"
  | "interview"
  | "offer"
  | "rejected"
  | "withdrawn";
export type ApplicationRequirementStatus = "missing" | "in_progress" | "ready" | "submitted" | "waived";

export interface ApplicationCycleDto {
  id: string;
  name: string;
  degree: string;
  fieldOfStudy: string;
  intakeTerm: string;
  targetRegions: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationProgramDeadlineDto {
  id: string;
  label: string;
  dueAt: string;
}

export interface ApplicationProgramDto {
  id: string;
  cycleId: string;
  school: string;
  program: string;
  country: string;
  degree: string;
  status: ApplicationProgramStatus;
  officialUrl: string;
  applicationFee: number | null;
  feeCurrency: string | null;
  deadlineAt: string | null;
  deadlines: ApplicationProgramDeadlineDto[];
  fundingSummary: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleTemplateId = "weekly-application-review" | "daily-application-plan";
export interface ScheduledJobDto {
  id: string;
  profileId: string;
  templateId: ScheduleTemplateId;
  name: string;
  description: string;
  schedule: string;
  /** IANA zone the schedule's wall-clock time is anchored to. */
  timezone: string;
  enabled: boolean;
  destinations: ChannelKind[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRunDto {
  id: string;
  jobId: string;
  scheduledAt: string;
  status: "queued" | "running" | "completed" | "failed";
  title: string | null;
  content: string;
  blocks: unknown[];
  retryCount: number;
  mergedScheduleCount: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AttachmentDto {
  id: string;
  messageId: string | null;
  fileName: string;
  mimeType: string;
  size: number;
  status: "ready" | "failed";
  presented: boolean;
  createdAt: string;
}

export interface ToolEventDto {
  id: string;
  runId: string;
  toolUseId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  inputSummary: string | null;
  outputSummary: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentActivityDto {
  id: string;
  parentActivityId: string | null;
  kind: AgentActivityKind;
  displayName: string;
  technicalName: string;
  status: AgentActivityStatus;
  content: string;
  inputSummary: string | null;
  outputSummary: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AssistantBlockDto {
  id: string;
  runId: string | null;
  messageId: string;
  parentBlockId: string | null;
  owner: "main" | "subagent";
  kind: "text" | "activity" | "subagent" | "thinking";
  order: number;
  content: string;
  status?: AgentActivityStatus;
  activity: AgentActivityDto | null;
}

export interface MemorySourceDto {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
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
  scope: MemoryScope;
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

export type LearningSessionStatus = "suggested" | "active" | "paused" | "completed" | "dismissed";
export type LearningDatasetKind = "live" | "demo" | "replay";
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
  interventions: LearningInterventionDto[];
  verifications: LearningVerificationDto[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  supersededAt: string | null;
}

export interface LearningSessionDto {
  id: string;
  conversationId: string;
  profileId: string;
  goal: string;
  topicKey: string | null;
  status: LearningSessionStatus;
  datasetKind: LearningDatasetKind;
  suggestionReason: string | null;
  incidents: LearningIncidentDto[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface LearningPolicyPreviewDto {
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
  preview: LearningPolicyPreviewDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface FrozenLearningSessionDto extends LearningSessionDto {
  policyContext?: LearningPolicyRevisionDto[];
}

export interface LearningDemoScenarioDto {
  id: string;
  title: string;
  description: string;
  goal: string;
  topicKey: string;
  difficultyType: LearningDifficultyType;
  synthetic: true;
}

export type EvolutionSignalSource = "user" | "implicit";
export type EvolutionSignalKind = "thumb" | "retry" | "edit" | "correct" | "method";
export type EvolutionPolarity = "up" | "down";
export type PlaybookPolarity = "do" | "dont";
export type PlaybookOrigin = "user" | "confirmed" | "distilled";
export type EvolvedArtifactKind = "skill" | "subagent";
export type EvolvedArtifactStatus = "pending" | "enabled" | "rejected" | "disabled";
export type EvolutionReviewVerdict = "pass" | "reject" | "needs_human";
export type EquipmentOrigin = "official" | "evolved";

export interface EvolutionSignalDto {
  id: string;
  source: EvolutionSignalSource;
  kind: EvolutionSignalKind;
  polarity: EvolutionPolarity;
  reason: string | null;
  profileId: string | null;
  conversationId: string | null;
  messageId: string | null;
  runId: string | null;
  overlayRevision: string | null;
  createdAt: string;
}

export interface PlaybookDto {
  id: string;
  title: string;
  instruction: string;
  polarity: PlaybookPolarity;
  origin: PlaybookOrigin;
  scope: MemoryScope;
  profileId: string | null;
  enabled: boolean;
  expiresAt: string | null;
  revision: number;
  sourceRunId: string | null;
  sourceSignalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HandbookDocumentDto {
  profileId: string | null;
  markdown: string;
  playbooks: PlaybookDto[];
}

export interface DomainCardDto {
  profileId: string;
  title: string;
  lines: string[];
  patch?: string | null;
  createdAt?: string;
}

export interface CollaborationFindingDto {
  claim: string;
  status: "verified" | "conflicting" | "unresolved";
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
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
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
  status: "queued" | "running" | "completed" | "failed" | "interrupted";
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

export interface ShelfItemDto {
  id: string;
  profileId: string;
  conversationId: string | null;
  fileName: string;
  mimeType: string;
  relativePath: string;
  createdAt: string;
}

export interface InputFileManifestItemDto {
  attachmentId: string;
  conversationId: string;
  sourceMessageId: string;
  originalFileName: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: "current_message" | "history" | "branch_copy" | "replay";
}

export interface RunSnapshotDto {
  id: string;
  runId: string;
  conversationId: string;
  profileId: string;
  prompt: string;
  createdAt: string;
}

export interface OverlaySnapshotDto {
  id: string;
  playbookIds: string[];
  artifactIds: string[];
  cardTitle: string | null;
  playbooks: Array<{ id: string; title: string; polarity: PlaybookPolarity; instruction?: string }>;
  card?: { title: string; lines: string[] } | null;
  memories?: Array<Pick<MemoryItemDto, "id" | "category" | "title" | "content">>;
  artifacts?: EvolvedArtifactDto[];
  inputFiles?: InputFileManifestItemDto[];
  learning?: FrozenLearningSessionDto | null;
}

export interface ConversationReplayDto {
  sourceRunId: string;
  mode: "frozen" | "with-artifact";
  includeArtifactId?: string | null;
  prompt: string;
  overlay: OverlaySnapshotDto;
}

export interface EvolvedArtifactDto {
  id: string;
  profileId: string;
  kind: EvolvedArtifactKind;
  slug: string;
  name: string;
  description: string;
  body: string;
  status: EvolvedArtifactStatus;
  origin: "user" | "distilled";
  revision: number;
  evaluation: { verdict: EvolutionReviewVerdict; reason: string; replayRunId?: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface EquipmentItemDto {
  id: string;
  name: string;
  description: string;
  origin: EquipmentOrigin;
  enabled: boolean;
  artifactId?: string;
}

export interface ProfileEquipmentDto {
  profileId: string;
  skills: EquipmentItemDto[];
  delegates: EquipmentItemDto[];
  pending: EvolvedArtifactDto[];
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

export interface MessageDto {
  id: string;
  conversationId: string;
  branchId: string;
  runId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  status: "queued" | "streaming" | "completed" | "interrupted" | "failed";
  reasoningSummary: string | null;
  sdkUuid: string | null;
  clientMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentDto[];
  memoryReferences: MemoryReferenceDto[];
  blocks: AssistantBlockDto[];
  rating?: EvolutionPolarity | null;
  playbookReferences?: Array<{ id: string; title: string; polarity: PlaybookPolarity }>;
  skillReferences?: string[];
  collaboration?: CollaborationTraceDto | null;
}

export interface ConversationSummaryDto {
  id: string;
  title: string;
  channel: ChannelKind;
  profileId: string;
  profileName: string;
  archived: boolean;
  pinned: boolean;
  temporary: boolean;
  expiresAt: string | null;
  status: RunStatus | "idle";
  lastMessagePreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface AskUserQuestionOptionDto {
  label: string;
  description?: string;
  preview?: string;
  freeForm?: boolean;
}

export interface AskUserQuestionItemDto {
  question: string;
  header?: string;
  options: AskUserQuestionOptionDto[];
  multiSelect?: boolean;
}

export interface AskUserQuestionDto {
  questions: AskUserQuestionItemDto[];
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  activeBranchId: string;
  messages: MessageDto[];
  toolEvents: ToolEventDto[];
  activeRunId: string | null;
  queuedRuns?: Array<{ runId: string; userMessageId: string }>;
  lastEventSequence: number;
  pendingQuestion?: AskUserQuestionDto | null;
  learningSession?: LearningSessionDto | null;
  replay?: ConversationReplayDto | null;
}

export interface ChannelInboundMessage {
  channel: ChannelKind;
  idempotencyKey: string;
  externalConversationKey: string;
  externalMessageId: string;
  actorId: string;
  content: string;
  threadId?: string;
  attachmentIds?: string[];
}

/**
 * A recently seen Feishu direct-message sender, offered so the owner can read their own
 * open_id off the screen instead of digging through the developer console event log.
 */
export interface FeishuSenderCandidateDto {
  openId: string;
  chatType: "p2p" | "group";
  /** Whether the allowlist in force at the time accepted this sender. */
  authorized: boolean;
  lastSeenAt: string;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conversationId: string, content: string): Promise<void>;
  stream(conversationId: string, events: AsyncIterable<AgentRunEvent>): Promise<void>;
}
