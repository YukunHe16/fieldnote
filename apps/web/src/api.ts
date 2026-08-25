import type {
  AgentEvent,
  AgentProfileSummary,
  ApiList,
  AssistantBlockDto,
  Attachment,
  Capabilities,
  ChatMessage,
  ConversationDetail,
  ConversationState,
  ConversationSummary,
  EvolutionPolarity,
  HandbookDocument,
  EvolvedArtifact,
  ProfileEquipment,
  ShelfItem,
  ConversationReplay,
  FeishuChannelStatus,
  FeishuSettingsInput,
  DiagnosticsReport,
  OnboardingState,
  RuntimeConfigInput,
  RuntimeConfigStatus,
  RuntimeTestInput,
  RuntimeTestResult,
  MemoryCategory,
  MemoryItemDto,
  MemoryMaintenanceStatusDto,
  MemoryReferenceDto,
  MemorySettingsDto,
  MemorySourceDto,
  AdmissionsArtifact,
  AdmissionsCycle,
  AdmissionsProfile,
  AdmissionsProgram,
  AdmissionsRequirement,
  AdmissionsSource,
  AdmissionsTask,
  ScheduledJob,
  ScheduledJobRun,
  SendMessageResponse,
  SendMode,
  AskUserQuestion,
  LearningIncidentDto,
  LearningDemoScenarioDto,
  LearningInterventionDto,
  LearningHandoffReportDto,
  LearningMetricsDto,
  LearningStrategyVariantDto,
  LearningOutcome,
  LearningPolicyRevisionDto,
  LearningSessionDto,
  LearningVerificationDto,
  CollaborationFindingDto,
  CollaborationHandoffDto,
  CollaborationTaskDto,
  CollaborationTraceDto
} from "./types";

import { acceptLanguageHeader, t } from "./i18n";

const JSON_HEADERS = { "Content-Type": "application/json" };

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", acceptLanguageHeader());
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new ApiError(
      body?.message ?? body?.error ?? t("requestFailed", { status: response.status }),
      response.status
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function now(): string {
  return new Date().toISOString();
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeMemorySource(input: unknown): MemorySourceDto {
  const raw = object(input);
  const conversationId = string(raw.conversationId ?? raw.conversation_id);
  return {
    id: string(raw.id, crypto.randomUUID()),
    conversationId: conversationId || null,
    conversationTitle: string(raw.conversationTitle ?? raw.conversation_title, t("sourceDeleted")),
    excerpt: string(raw.excerpt ?? raw.summary),
    sourceDeleted: bool(raw.sourceDeleted ?? raw.source_deleted) ?? !conversationId,
    createdAt: string(raw.createdAt ?? raw.created_at, now())
  };
}

export function normalizeMemoryReference(input: unknown): MemoryReferenceDto {
  const raw = object(input);
  const category = string(raw.category) as MemoryCategory;
  return {
    memoryId: string(raw.memoryId ?? raw.memory_id ?? raw.id, crypto.randomUUID()),
    category: ["profile", "preference", "goal", "project", "task"].includes(category) ? category : "task",
    title: string(raw.title, t("unnamedMemory")),
    content: string(raw.content ?? raw.summary),
    source: raw.source ? normalizeMemorySource(raw.source) : null
  };
}

export function normalizeMemory(input: unknown): MemoryItemDto {
  const raw = object(input);
  const category = string(raw.category) as MemoryCategory;
  const sourceKind = string(raw.sourceKind ?? raw.source_kind);
  return {
    id: string(raw.id, crypto.randomUUID()),
    category: ["profile", "preference", "goal", "project", "task"].includes(category) ? category : "task",
    title: string(raw.title, t("unnamedMemory")),
    content: string(raw.content),
    keywords: Array.isArray(raw.keywords)
      ? raw.keywords.filter((item): item is string => typeof item === "string")
      : [],
    sourceKind: sourceKind === "explicit" || sourceKind === "manual" ? sourceKind : "auto",
    scope: raw.scope === "profile" ? "profile" : "global",
    profileId: string(raw.profileId ?? raw.profile_id) || null,
    importance: Math.min(5, Math.max(1, number(raw.importance, 3))),
    pinned: bool(raw.pinned) ?? false,
    status: raw.status === "superseded" ? "superseded" : "active",
    sources: Array.isArray(raw.sources) ? raw.sources.map(normalizeMemorySource) : [],
    createdAt: string(raw.createdAt ?? raw.created_at, now()),
    updatedAt: string(raw.updatedAt ?? raw.updated_at, now())
  };
}

export function attachmentOpenUrl(id: string) {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

export function attachmentDownloadUrl(id: string) {
  return `${attachmentOpenUrl(id)}?download=1`;
}

export function normalizeAttachment(input: unknown): Attachment {
  const raw = object(input);
  const id = string(raw.id, crypto.randomUUID());
  return {
    ...raw,
    id,
    name: string(raw.name ?? raw.fileName ?? raw.filename, t("unnamedFile")),
    size: typeof raw.size === "number" ? raw.size : undefined,
    type: string(raw.type ?? raw.mimeType) || undefined,
    url: string(raw.url) || attachmentOpenUrl(id),
    status: raw.status === "uploading" || raw.status === "failed" ? raw.status : "ready",
    presented:
      raw.presented === false || raw.presented === 0
        ? false
        : raw.presented === true || raw.presented === 1
          ? true
          : undefined
  };
}

export function normalizeAssistantBlock(input: unknown): AssistantBlockDto {
  const raw = object(input);
  const activityRaw = object(raw.activity);
  const rawType = string(raw.type, "activity").toLowerCase();
  const canonicalKind = string(raw.kind).toLowerCase();
  const wireType = string(
    canonicalKind === "text" || canonicalKind === "subagent"
      ? canonicalKind
      : (activityRaw.kind ??
          (rawType === "activity" ? (raw.activityType ?? raw.activity_type ?? canonicalKind ?? rawType) : rawType))
  ).toLowerCase();
  const type: AssistantBlockDto["type"] =
    wireType.includes("thinking") || wireType === "thinking"
      ? "thinking"
      : wireType.includes("subagent") || wireType.includes("delegate") || wireType === "agent"
        ? "subagent"
        : wireType.includes("skill")
          ? "skill"
          : wireType.includes("mcp")
            ? "mcp"
            : wireType.includes("cron") || wireType.includes("schedule")
              ? "cron"
              : wireType === "text" || wireType.endsWith("text")
                ? "text"
                : wireType.includes("tool")
                  ? "tool"
                  : "activity";
  const wireStatus = string(activityRaw.status ?? raw.status ?? raw.state, "completed");
  const status: AssistantBlockDto["status"] =
    wireStatus === "queued" || wireStatus === "running" || wireStatus === "failed" || wireStatus === "interrupted"
      ? wireStatus
      : "completed";
  const children = raw.children ?? raw.blocks ?? raw.activities;
  const parentBlockId = string(raw.parentBlockId ?? raw.parent_block_id);
  const canonicalActivity =
    raw.activity && typeof raw.activity === "object"
      ? {
          id: string(activityRaw.id, string(raw.id, crypto.randomUUID())),
          parentActivityId: string(activityRaw.parentActivityId ?? activityRaw.parent_activity_id) || null,
          kind: (["skill", "mcp", "subagent", "cron", "workspace"].includes(string(activityRaw.kind))
            ? string(activityRaw.kind)
            : "workspace") as "skill" | "mcp" | "subagent" | "cron" | "workspace",
          displayName: string(activityRaw.displayName ?? activityRaw.display_name),
          technicalName: string(activityRaw.technicalName ?? activityRaw.technical_name),
          status: (["running", "completed", "failed", "interrupted"].includes(string(activityRaw.status))
            ? string(activityRaw.status)
            : "completed") as "running" | "completed" | "failed" | "interrupted",
          content: string(activityRaw.content),
          inputSummary: string(activityRaw.inputSummary ?? activityRaw.input_summary),
          outputSummary: string(activityRaw.outputSummary ?? activityRaw.output_summary),
          startedAt: string(activityRaw.startedAt ?? activityRaw.started_at),
          completedAt: string(activityRaw.completedAt ?? activityRaw.completed_at) || null
        }
      : null;
  return {
    ...raw,
    id: string(raw.id ?? raw.blockId ?? raw.block_id ?? raw.activityId ?? raw.activity_id, crypto.randomUUID()),
    runId: string(raw.runId ?? raw.run_id) || null,
    messageId: string(raw.messageId ?? raw.message_id) || undefined,
    parentBlockId: parentBlockId || null,
    owner: raw.owner === "subagent" ? "subagent" : "main",
    kind:
      canonicalKind === "text" || canonicalKind === "thinking" || canonicalKind === "subagent"
        ? canonicalKind
        : "activity",
    order: number(raw.order),
    content: string(raw.content) || undefined,
    activity: canonicalActivity,
    type,
    status,
    text: string(raw.text ?? raw.content ?? activityRaw.content ?? raw.delta) || undefined,
    title:
      string(
        raw.title ??
          raw.label ??
          raw.displayName ??
          raw.display_name ??
          activityRaw.displayName ??
          activityRaw.display_name
      ) || undefined,
    name:
      string(raw.name ?? raw.displayName ?? raw.display_name ?? activityRaw.displayName ?? activityRaw.display_name) ||
      undefined,
    technicalName:
      string(
        raw.technicalName ??
          raw.technical_name ??
          raw.toolName ??
          raw.tool_name ??
          raw.serverName ??
          raw.server_name ??
          activityRaw.technicalName ??
          activityRaw.technical_name ??
          raw.name
      ) || undefined,
    parentId:
      string(raw.parentId ?? raw.parent_id ?? raw.parentActivityId ?? raw.parent_activity_id ?? parentBlockId) ||
      undefined,
    startedAt: string(raw.startedAt ?? raw.started_at ?? activityRaw.startedAt ?? activityRaw.started_at) || undefined,
    completedAt:
      string(raw.completedAt ?? raw.completed_at ?? activityRaw.completedAt ?? activityRaw.completed_at) || undefined,
    durationMs: number(raw.durationMs ?? raw.duration_ms) || undefined,
    input: raw.input ?? raw.parameters ?? raw.params ?? activityRaw.inputSummary ?? activityRaw.input_summary,
    inputSummary:
      string(raw.inputSummary ?? raw.input_summary ?? activityRaw.inputSummary ?? activityRaw.input_summary) ||
      undefined,
    outputSummary:
      string(raw.outputSummary ?? raw.output_summary ?? activityRaw.outputSummary ?? activityRaw.output_summary) ||
      undefined,
    error: string(raw.error ?? raw.errorMessage ?? raw.error_message) || undefined,
    children: Array.isArray(children) ? children.map(normalizeAssistantBlock) : []
  };
}

export function nestAssistantBlocks(blocks: AssistantBlockDto[]): AssistantBlockDto[] {
  const byId = new Map(blocks.map((block) => [block.id, { ...block, children: [...block.children] }]));
  const roots: AssistantBlockDto[] = [];
  for (const block of byId.values()) {
    const parentId = block.parentBlockId ?? block.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(block);
    else roots.push(block);
  }
  const sort = (items: AssistantBlockDto[]): AssistantBlockDto[] =>
    items
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((block) => ({ ...block, children: sort(block.children) }));
  return sort(roots);
}

function httpUrl(value: unknown): string | null {
  const candidate = string(value).trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function boundedCount(value: unknown): number {
  return Math.max(0, Math.floor(number(value)));
}

export function normalizeCollaborationTrace(input: unknown): CollaborationTraceDto | null {
  const raw = object(input);
  const normalizeFinding = (input: unknown): CollaborationFindingDto | null => {
    const finding = object(input);
    const claim = string(finding.claim).trim();
    if (!claim) return null;
    const status = includes(["verified", "conflicting", "unresolved"] as const, finding.status, "unresolved");
    const rawSourceUrls = finding.sourceUrls ?? finding.source_urls;
    const sourceUrls = Array.isArray(rawSourceUrls)
      ? [...new Set(rawSourceUrls.map(httpUrl).filter((url): url is string => Boolean(url)))]
      : [];
    const verifiedAt = string(finding.verifiedAt ?? finding.verified_at).trim();
    return { claim, status, sourceUrls, ...(verifiedAt ? { verifiedAt } : {}) };
  };
  const normalizeTask = (input: unknown): CollaborationTaskDto | null => {
    const task = object(input);
    const id = string(task.id).trim();
    if (!id) return null;
    const resultRaw = object(task.result);
    const resultSummary = string(task.resultSummary ?? task.result_summary).trim() || null;
    const rawOpenQuestions = resultRaw.openQuestions ?? resultRaw.open_questions;
    const rawRecommendedFollowups = resultRaw.recommendedFollowups ?? resultRaw.recommended_followups;
    const result =
      task.result && typeof task.result === "object"
        ? {
            summary: string(resultRaw.summary).trim(),
            findings: Array.isArray(resultRaw.findings)
              ? resultRaw.findings.flatMap((finding) => {
                  const normalized = normalizeFinding(finding);
                  return normalized ? [normalized] : [];
                })
              : [],
            openQuestions: Array.isArray(rawOpenQuestions)
              ? rawOpenQuestions.flatMap((question) => {
                  const text = string(question).trim();
                  return text ? [text] : [];
                })
              : [],
            recommendedFollowups: Array.isArray(rawRecommendedFollowups)
              ? rawRecommendedFollowups.flatMap((followup) => {
                  const value = object(followup);
                  const specialistId = string(value.specialistId ?? value.specialist_id).trim();
                  const question = string(value.question).trim();
                  return specialistId && question ? [{ specialistId, question }] : [];
                })
              : []
          }
        : null;
    return {
      id,
      runId: string(task.runId ?? task.run_id),
      assistantMessageId: string(task.assistantMessageId ?? task.assistant_message_id),
      specialistId: string(task.specialistId ?? task.specialist_id),
      displayName: string(task.displayName ?? task.display_name) || string(task.specialistId ?? task.specialist_id),
      sourceTaskId: string(task.sourceTaskId ?? task.source_task_id) || null,
      requestSummary: string(task.requestSummary ?? task.request_summary),
      status: includes(["queued", "running", "completed", "failed", "interrupted"] as const, task.status, "queued"),
      resultSummary,
      structured: bool(task.structured) ?? false,
      result,
      error: string(task.error).trim() || null,
      createdAt: string(task.createdAt ?? task.created_at, now()),
      startedAt: optionalDate(task.startedAt ?? task.started_at),
      finishedAt: optionalDate(task.finishedAt ?? task.finished_at)
    };
  };
  const normalizeHandoff = (input: unknown): CollaborationHandoffDto | null => {
    const handoff = object(input);
    const id = string(handoff.id).trim();
    if (!id) return null;
    return {
      id,
      runId: string(handoff.runId ?? handoff.run_id),
      sourceTaskId: string(handoff.sourceTaskId ?? handoff.source_task_id),
      targetTaskId: string(handoff.targetTaskId ?? handoff.target_task_id),
      question: string(handoff.question).trim(),
      status: includes(["queued", "running", "completed", "failed", "interrupted"] as const, handoff.status, "queued"),
      error: string(handoff.error).trim() || null,
      createdAt: string(handoff.createdAt ?? handoff.created_at, now()),
      finishedAt: optionalDate(handoff.finishedAt ?? handoff.finished_at)
    };
  };
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.flatMap((task) => {
        const normalized = normalizeTask(task);
        return normalized ? [normalized] : [];
      })
    : [];
  const handoffs = Array.isArray(raw.handoffs)
    ? raw.handoffs.flatMap((handoff) => {
        const normalized = normalizeHandoff(handoff);
        return normalized ? [normalized] : [];
      })
    : [];
  if (!tasks.length && !handoffs.length) return null;
  const summary = object(raw.summary);
  return {
    tasks,
    handoffs,
    summary: {
      specialistCount: boundedCount(summary.specialistCount ?? summary.specialist_count),
      verifiedCount: boundedCount(summary.verifiedCount ?? summary.verified_count),
      conflictingCount: boundedCount(summary.conflictingCount ?? summary.conflicting_count),
      unresolvedCount: boundedCount(summary.unresolvedCount ?? summary.unresolved_count),
      sourceCount: boundedCount(summary.sourceCount ?? summary.source_count),
      importantNotice: string(summary.importantNotice ?? summary.important_notice).trim() || null
    }
  };
}

export function normalizeMessage(input: unknown): ChatMessage {
  const raw = object(input);
  const role = raw.role === "user" || raw.role === "system" ? raw.role : "assistant";
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.map(normalizeAttachment) : undefined;
  const wireBlocks = raw.blocks ?? raw.assistantBlocks ?? raw.assistant_blocks;
  return {
    ...raw,
    id: string(raw.id, crypto.randomUUID()),
    role,
    content: string(raw.content ?? raw.text),
    createdAt: string(raw.createdAt ?? raw.created_at, now()),
    status:
      raw.status === "streaming" || raw.status === "queued" || raw.status === "interrupted" || raw.status === "failed"
        ? raw.status === "queued"
          ? "streaming"
          : raw.status
        : "completed",
    attachments,
    parentId: string(raw.parentId ?? raw.parent_id) || undefined,
    runId: string(raw.runId ?? raw.run_id) || undefined,
    clientMessageId: string(raw.clientMessageId ?? raw.client_message_id) || undefined,
    memoryReferences: Array.isArray(raw.memoryReferences ?? raw.memory_references)
      ? ((raw.memoryReferences ?? raw.memory_references) as unknown[]).map(normalizeMemoryReference)
      : [],
    reasoningSummary: string(raw.reasoningSummary ?? raw.reasoning_summary) || undefined,
    blocks: Array.isArray(wireBlocks) ? nestAssistantBlocks(wireBlocks.map(normalizeAssistantBlock)) : [],
    rating: raw.rating === "up" || raw.rating === "down" ? raw.rating : null,
    playbookReferences: Array.isArray(raw.playbookReferences ?? raw.playbook_references)
      ? (
          (raw.playbookReferences ?? raw.playbook_references) as Array<{
            id?: unknown;
            title?: unknown;
            polarity?: unknown;
          }>
        )
          .filter((item) => typeof item?.id === "string" && typeof item?.title === "string")
          .map((item) => ({
            id: String(item.id),
            title: String(item.title),
            polarity: item.polarity === "dont" ? ("dont" as const) : ("do" as const)
          }))
      : [],
    skillReferences: Array.isArray(raw.skillReferences ?? raw.skill_references)
      ? ((raw.skillReferences ?? raw.skill_references) as unknown[]).flatMap((item) =>
          typeof item === "string" && item.trim() ? [item.trim()] : []
        )
      : [],
    learningVerifications: Array.isArray(raw.learningVerifications ?? raw.learning_verifications)
      ? ((raw.learningVerifications ?? raw.learning_verifications) as unknown[]).map(normalizeLearningVerification)
      : [],
    collaboration: normalizeCollaborationTrace(raw.collaboration)
  };
}

const includes = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
const optionalString = (value: unknown): string | null => string(value) || null;
const optionalDate = (value: unknown): string | null => string(value) || null;

export function normalizeLearningIntervention(input: unknown): LearningInterventionDto {
  const raw = object(input);
  return {
    id: string(raw.id, crypto.randomUUID()),
    incidentId: string(raw.incidentId ?? raw.incident_id),
    strategy: includes(
      [
        "socratic_question",
        "conceptual_hint",
        "contrastive_example",
        "worked_example",
        "analogical_example",
        "direct_explanation",
        "evidence_check",
        "abstain_escalate"
      ] as const,
      raw.strategy,
      "socratic_question"
    ),
    rationale: string(raw.rationale),
    expectedSignal: string(raw.expectedSignal ?? raw.expected_signal),
    policyRevisionId: optionalString(raw.policyRevisionId ?? raw.policy_revision_id),
    runId: optionalString(raw.runId ?? raw.run_id),
    messageId: optionalString(raw.messageId ?? raw.message_id),
    round: number(raw.round, 1),
    createdAt: string(raw.createdAt ?? raw.created_at, now())
  };
}

export function normalizeLearningVerification(input: unknown): LearningVerificationDto {
  const raw = object(input);
  const outcome = (value: unknown): LearningOutcome | null =>
    typeof value === "string" && ["resolved", "partial", "unresolved", "unknown"].includes(value)
      ? (value as LearningOutcome)
      : null;
  const userVerdict = outcome(raw.userVerdict ?? raw.user_verdict);
  return {
    id: string(raw.id, crypto.randomUUID()),
    incidentId: string(raw.incidentId ?? raw.incident_id),
    interventionId: optionalString(raw.interventionId ?? raw.intervention_id),
    method: includes(
      ["self_explanation", "transfer_example", "prediction", "comparison", "user_report"] as const,
      raw.method,
      "user_report"
    ),
    prompt: string(raw.prompt),
    rubric: string(raw.rubric),
    systemVerdict: outcome(raw.systemVerdict ?? raw.system_verdict),
    systemConfidence:
      typeof (raw.systemConfidence ?? raw.system_confidence) === "number"
        ? number(raw.systemConfidence ?? raw.system_confidence)
        : null,
    userVerdict: userVerdict === "unknown" ? null : userVerdict,
    finalVerdict: outcome(raw.finalVerdict ?? raw.final_verdict),
    requestedRunId: optionalString(raw.requestedRunId ?? raw.requested_run_id),
    requestedMessageId: optionalString(raw.requestedMessageId ?? raw.requested_message_id),
    proposedRunId: optionalString(raw.proposedRunId ?? raw.proposed_run_id),
    proposedMessageId: optionalString(raw.proposedMessageId ?? raw.proposed_message_id),
    createdAt: string(raw.createdAt ?? raw.created_at, now()),
    proposedAt: optionalDate(raw.proposedAt ?? raw.proposed_at),
    confirmedAt: optionalDate(raw.confirmedAt ?? raw.confirmed_at)
  };
}

export function normalizeLearningIncident(input: unknown): LearningIncidentDto {
  const raw = object(input);
  const evidence = raw.evidenceMessageIds ?? raw.evidence_message_ids;
  return {
    id: string(raw.id, crypto.randomUUID()),
    sessionId: string(raw.sessionId ?? raw.session_id),
    difficultyType: includes(
      [
        "planning_gap",
        "conceptual_misconception",
        "procedural_gap",
        "feedback_uncertainty",
        "prerequisite_gap",
        "other"
      ] as const,
      raw.difficultyType ?? raw.difficulty_type,
      "other"
    ),
    hypothesis: string(raw.hypothesis),
    confidence: number(raw.confidence),
    severity: number(raw.severity, 1),
    evidenceMessageIds: Array.isArray(evidence) ? evidence.filter((id): id is string => typeof id === "string") : [],
    openedRunId: optionalString(raw.openedRunId ?? raw.opened_run_id),
    status: includes(
      [
        "observing",
        "diagnosed",
        "intervening",
        "verifying",
        "resolved",
        "unresolved",
        "escalated",
        "abandoned"
      ] as const,
      raw.status,
      "observing"
    ),
    closedSnapshot: raw.closedSnapshot ?? raw.closed_snapshot ?? null,
    createdAt: string(raw.createdAt ?? raw.created_at, now()),
    updatedAt: string(raw.updatedAt ?? raw.updated_at, now()),
    closedAt: optionalDate(raw.closedAt ?? raw.closed_at),
    supersededAt: optionalDate(raw.supersededAt ?? raw.superseded_at),
    interventions: Array.isArray(raw.interventions) ? raw.interventions.map(normalizeLearningIntervention) : [],
    verifications: Array.isArray(raw.verifications) ? raw.verifications.map(normalizeLearningVerification) : []
  };
}

export function normalizeLearningSession(input: unknown): LearningSessionDto | null {
  const raw = object(input);
  const id = string(raw.id);
  if (!id) return null;
  const datasetKind = includes(
    ["live", "demo", "replay", "eval"] as const,
    raw.datasetKind ?? raw.dataset_kind,
    "live"
  );
  return {
    id,
    conversationId: string(raw.conversationId ?? raw.conversation_id),
    profileId: string(raw.profileId ?? raw.profile_id),
    goal: string(raw.goal),
    topicKey: optionalString(raw.topicKey ?? raw.topic_key),
    status: includes(["suggested", "active", "paused", "completed", "dismissed"] as const, raw.status, "active"),
    datasetKind,
    condition: includes(["on-call", "one-shot", "multi-turn"] as const, raw.condition, "on-call"),
    executionMode: includes(
      ["agent", "deterministic"] as const,
      raw.executionMode ?? raw.execution_mode,
      datasetKind === "demo" ? "deterministic" : "agent"
    ),
    suggestionReason: optionalString(raw.suggestionReason ?? raw.suggestion_reason),
    createdAt: string(raw.createdAt ?? raw.created_at, now()),
    updatedAt: string(raw.updatedAt ?? raw.updated_at, now()),
    completedAt: optionalDate(raw.completedAt ?? raw.completed_at),
    incidents: Array.isArray(raw.incidents) ? raw.incidents.map(normalizeLearningIncident) : []
  };
}

export function normalizeLearningPolicy(input: unknown): LearningPolicyRevisionDto {
  const raw = object(input);
  const orderedStrategies = raw.orderedStrategies ?? raw.ordered_strategies;
  const evidenceExperienceIds = raw.evidenceExperienceIds ?? raw.evidence_experience_ids;
  const rawPreview = object(raw.preview);
  const strategy = (value: unknown) =>
    includes(
      [
        "socratic_question",
        "conceptual_hint",
        "contrastive_example",
        "worked_example",
        "analogical_example",
        "direct_explanation",
        "evidence_check",
        "abstain_escalate"
      ] as const,
      value,
      "socratic_question"
    );
  const preview = Object.keys(rawPreview).length
    ? {
        currentFirstStrategy: strategy(rawPreview.currentFirstStrategy ?? rawPreview.current_first_strategy),
        candidateFirstStrategy: strategy(rawPreview.candidateFirstStrategy ?? rawPreview.candidate_first_strategy),
        snapshotCount: number(rawPreview.snapshotCount ?? rawPreview.snapshot_count),
        changedSelectionCount: number(rawPreview.changedSelectionCount ?? rawPreview.changed_selection_count),
        comparisons: Array.isArray(rawPreview.comparisons)
          ? rawPreview.comparisons.map((value) => {
              const comparison = object(value);
              const failed = comparison.failedStrategies ?? comparison.failed_strategies;
              return {
                incidentId: string(comparison.incidentId ?? comparison.incident_id),
                currentStrategy: strategy(comparison.currentStrategy ?? comparison.current_strategy),
                candidateStrategy: strategy(comparison.candidateStrategy ?? comparison.candidate_strategy),
                failedStrategies: Array.isArray(failed) ? failed.map(strategy) : []
              };
            })
          : []
      }
    : null;
  return {
    id: string(raw.id, crypto.randomUUID()),
    profileId: string(raw.profileId ?? raw.profile_id),
    topicKey: optionalString(raw.topicKey ?? raw.topic_key),
    difficultyType: includes(
      [
        "planning_gap",
        "conceptual_misconception",
        "procedural_gap",
        "feedback_uncertainty",
        "prerequisite_gap",
        "other"
      ] as const,
      raw.difficultyType ?? raw.difficulty_type,
      "other"
    ),
    datasetKind: includes(["live", "demo"] as const, raw.datasetKind ?? raw.dataset_kind, "live"),
    orderedStrategies: Array.isArray(orderedStrategies)
      ? orderedStrategies.filter(
          (item): item is LearningPolicyRevisionDto["orderedStrategies"][number] => typeof item === "string"
        )
      : [],
    evidenceExperienceIds: Array.isArray(evidenceExperienceIds)
      ? evidenceExperienceIds.filter((item): item is string => typeof item === "string")
      : [],
    previousRevisionId: optionalString(raw.previousRevisionId ?? raw.previous_revision_id),
    status: includes(["pending", "enabled", "rejected", "disabled"] as const, raw.status, "pending"),
    evaluationSummary: string(raw.evaluationSummary ?? raw.evaluation_summary),
    preview,
    createdAt: string(raw.createdAt ?? raw.created_at, now()),
    updatedAt: string(raw.updatedAt ?? raw.updated_at, now())
  };
}

export function normalizeLearningDemoScenario(input: unknown): LearningDemoScenarioDto {
  const raw = object(input);
  return {
    id: string(raw.id, crypto.randomUUID()),
    title: string(raw.title),
    description: string(raw.description),
    preview: string(raw.preview),
    loop: string(raw.loop),
    goal: string(raw.goal),
    topicKey: string(raw.topicKey ?? raw.topic_key),
    difficultyType: includes(
      [
        "planning_gap",
        "conceptual_misconception",
        "procedural_gap",
        "feedback_uncertainty",
        "prerequisite_gap",
        "other"
      ] as const,
      raw.difficultyType ?? raw.difficulty_type,
      "other"
    ),
    synthetic: true,
    agentAvailable: bool(raw.agentAvailable ?? raw.agent_available) ?? false
  };
}

export function normalizeConversation(
  input: unknown,
  fallbackState: ConversationState = "active"
): ConversationSummary {
  const raw = object(input);
  const state: ConversationState = raw.state === "archived" || raw.archived === true ? "archived" : fallbackState;
  const wireRunState = string(raw.runState ?? raw.run_state ?? raw.status);
  const runState = (wireRunState === "queued" ? "submitting" : wireRunState) as ConversationSummary["runState"];
  return {
    ...raw,
    id: string(raw.id, crypto.randomUUID()),
    title: string(raw.title, t("newConversation")),
    state,
    pinned: bool(raw.pinned) ?? false,
    updatedAt: string(raw.updatedAt ?? raw.updated_at, now()),
    preview: string(raw.preview ?? raw.lastMessagePreview ?? raw.last_message_preview) || undefined,
    channel: string(raw.channel, "Web"),
    runState: runState || "idle",
    activeRunId: string(raw.activeRunId ?? raw.active_run_id) || undefined,
    temporary: bool(raw.temporary) ?? false,
    expiresAt: string(raw.expiresAt ?? raw.expires_at) || undefined,
    profileId: string(raw.profileId ?? raw.profile_id) || undefined,
    profileName: string(raw.profileName ?? raw.profile_name) || undefined
  };
}

export function normalizeEvent(input: unknown): AgentEvent {
  const outer = object(input);
  const payload = object(outer.data ?? outer.payload);
  const raw = { ...payload, ...outer };
  return {
    ...raw,
    id: string(raw.id ?? raw.eventId ?? raw.event_id, crypto.randomUUID()),
    type: string(raw.type, "agent.unknown"),
    sequence: typeof raw.sequence === "number" ? raw.sequence : undefined,
    createdAt: string(raw.createdAt ?? raw.created_at ?? raw.timestamp) || undefined,
    cursor: string(raw.cursor) || (typeof raw.sequence === "number" ? String(raw.sequence) : undefined),
    conversationId: string(raw.conversationId ?? raw.conversation_id) || undefined,
    runId: string(raw.runId ?? raw.run_id) || undefined,
    messageId: string(raw.messageId ?? raw.message_id) || undefined,
    content: string(raw.content ?? raw.text ?? raw.delta) || undefined,
    summary: string(raw.summary ?? (string(raw.type).startsWith("reasoning.") ? raw.delta : undefined)) || undefined,
    name: string(raw.name ?? raw.toolName ?? raw.tool_name) || undefined,
    status: string(raw.status) || undefined,
    error: string(raw.error ?? raw.message) || undefined,
    input: raw.input ?? raw.inputSummary ?? raw.input_summary,
    output: raw.output ?? raw.outputSummary ?? raw.output_summary,
    inputSummary: string(raw.inputSummary ?? raw.input_summary) || undefined,
    outputSummary: string(raw.outputSummary ?? raw.output_summary) || undefined,
    data: payload
  };
}

/** A Feishu direct-message sender the server saw recently, offered for the allowlist. */
export interface FeishuSenderCandidate {
  openId: string;
  chatType: "p2p" | "group";
  authorized: boolean;
  lastSeenAt: string;
}

export function normalizeFeishuSenderCandidate(input: unknown): FeishuSenderCandidate {
  const raw = object(input);
  return {
    openId: string(raw.openId ?? raw.open_id),
    chatType: (raw.chatType ?? raw.chat_type) === "group" ? "group" : "p2p",
    authorized: (raw.authorized ?? raw.allowed) === true,
    lastSeenAt: string(raw.lastSeenAt ?? raw.last_seen_at)
  };
}

export function normalizeScheduledJobRun(input: unknown): ScheduledJobRun {
  const raw = object(input);
  const blocks = Array.isArray(raw.blocks) ? nestAssistantBlocks(raw.blocks.map(normalizeAssistantBlock)) : [];
  return {
    ...raw,
    id: string(raw.id, crypto.randomUUID()),
    jobId: string(raw.jobId ?? raw.job_id) || undefined,
    status: string(raw.status) || undefined,
    startedAt: string(raw.startedAt ?? raw.started_at) || undefined,
    completedAt: string(raw.completedAt ?? raw.completed_at) || undefined,
    title: string(raw.title) || undefined,
    summary: string(raw.summary) || undefined,
    content: string(raw.content) || undefined,
    blocks
  };
}

export function normalizeConversationDetail(input: unknown): ConversationDetail {
  const source = object(input);
  const queuedRuns = Array.isArray(source.queuedRuns)
    ? source.queuedRuns.flatMap((item) => {
        const raw = object(item);
        const runId = string(raw.runId ?? raw.run_id ?? raw.id);
        const userMessageId = string(raw.userMessageId ?? raw.user_message_id);
        return runId && userMessageId ? [{ runId, userMessageId }] : [];
      })
    : [];
  return {
    ...source,
    ...normalizeConversation(source),
    messages: Array.isArray(source.messages) ? source.messages.map(normalizeMessage) : [],
    events: Array.isArray(source.events) ? source.events.map(normalizeEvent) : [],
    queuedRuns,
    pendingQuestion: normalizeAskUserQuestion(source.pendingQuestion ?? source.pending_question),
    replay: normalizeReplay(source.replay),
    learningSession: normalizeLearningSession(source.learningSession ?? source.learning_session)
  } satisfies ConversationDetail;
}

function normalizeReplay(input: unknown): ConversationReplay | null {
  const raw = object(input);
  const sourceRunId = string(raw.sourceRunId ?? raw.source_run_id);
  if (!sourceRunId) return null;
  const overlayRaw = object(raw.overlay);
  const playbooks = Array.isArray(overlayRaw.playbooks)
    ? overlayRaw.playbooks.flatMap((item) => {
        const playbook = object(item);
        const id = string(playbook.id);
        const title = string(playbook.title);
        return id && title
          ? [{ id, title, polarity: playbook.polarity === "dont" ? ("dont" as const) : ("do" as const) }]
          : [];
      })
    : [];
  return {
    sourceRunId,
    mode: raw.mode === "with-artifact" ? "with-artifact" : "frozen",
    includeArtifactId: string(raw.includeArtifactId ?? raw.include_artifact_id) || null,
    prompt: string(raw.prompt),
    overlay: {
      playbookIds: Array.isArray(overlayRaw.playbookIds) ? overlayRaw.playbookIds.map((id) => String(id)) : [],
      artifactIds: Array.isArray(overlayRaw.artifactIds) ? overlayRaw.artifactIds.map((id) => String(id)) : [],
      cardTitle: string(overlayRaw.cardTitle ?? overlayRaw.card_title) || null,
      playbooks
    }
  };
}

export function normalizeAskUserQuestion(input: unknown): AskUserQuestion | null {
  const source = object(input);
  const questions = Array.isArray(source.questions)
    ? source.questions.flatMap((item) => {
        const raw = object(item);
        const question = string(raw.question);
        const options = Array.isArray(raw.options)
          ? raw.options.flatMap((option) => {
              const value = object(option);
              const label = string(value.label);
              return label
                ? [
                    {
                      label,
                      description: string(value.description) || undefined,
                      preview: string(value.preview) || undefined,
                      freeForm: value.freeForm === true || value.free_form === true
                    }
                  ]
                : [];
            })
          : [];
        return question
          ? [
              {
                question,
                header: string(raw.header) || undefined,
                options,
                multiSelect: raw.multiSelect === true || raw.multi_select === true
              }
            ]
          : [];
      })
    : [];
  return questions.length > 0 ? { questions } : null;
}

function unwrapList<T>(input: ApiList<T> | T[]): T[] {
  if (Array.isArray(input)) return input;
  return input.data ?? input.items ?? input.conversations ?? [];
}

function unwrapNamedList<T>(input: unknown, names: string[]): T[] {
  if (Array.isArray(input)) return input as T[];
  const raw = object(input);
  for (const name of ["data", "items", ...names]) if (Array.isArray(raw[name])) return raw[name] as T[];
  return [];
}

export const api = {
  async capabilities() {
    const raw = await request<
      Capabilities & {
        limits?: { maxAttachments?: number; maxAttachmentBytes?: number; acceptedMimeTypes?: string[] };
        features?: Record<string, boolean>;
      }
    >("/api/capabilities");
    return {
      ...raw,
      attachments: {
        enabled: true,
        maxFiles: raw.attachments?.maxFiles ?? raw.limits?.maxAttachments,
        maxBytes: raw.attachments?.maxBytes ?? raw.limits?.maxAttachmentBytes,
        accept: raw.attachments?.accept ?? raw.limits?.acceptedMimeTypes
      },
      reasoningSummary: raw.reasoningSummary ?? raw.features?.toolTimeline ?? true,
      tools: raw.tools ?? raw.features?.toolTimeline ?? true
    } satisfies Capabilities;
  },

  feishuStatus: () => request<FeishuChannelStatus>("/api/channels/feishu"),

  async feishuSenderCandidates() {
    return unwrapNamedList<FeishuSenderCandidate>(await request("/api/channels/feishu/candidates"), ["candidates"])
      .map(normalizeFeishuSenderCandidate)
      .filter((candidate) => candidate.openId);
  },

  saveFeishuSettings: (settings: FeishuSettingsInput) =>
    request<FeishuChannelStatus>("/api/channels/feishu", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(settings)
    }),

  runtimeConfig: () => request<RuntimeConfigStatus>("/api/runtime/config"),

  saveRuntimeConfig: (settings: RuntimeConfigInput) =>
    request<RuntimeConfigStatus>("/api/runtime/config", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(settings)
    }),

  testRuntime: (settings: RuntimeTestInput = {}) =>
    request<RuntimeTestResult>("/api/runtime/test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(settings)
    }),

  diagnostics: () => request<DiagnosticsReport>("/api/diagnostics"),

  onboardingState: () => request<OnboardingState>("/api/onboarding-state"),

  saveOnboardingState: (completed: boolean) =>
    request<OnboardingState>("/api/onboarding-state", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ completed })
    }),

  async conversations(state: ConversationState, query = "") {
    const params = new URLSearchParams({ state });
    if (query.trim()) params.set("query", query.trim());
    const response = await request<ApiList<ConversationSummary> | ConversationSummary[]>(
      `/api/conversations?${params}`
    );
    return unwrapList(response).map((item) => normalizeConversation(item, state));
  },

  async agentProfiles() {
    const response = await request<unknown>("/api/agent-profiles");
    return unwrapNamedList<AgentProfileSummary>(response, ["profiles"]).map((item) => {
      const raw = object(item);
      return { id: string(raw.id), name: string(raw.name, string(raw.id)), description: string(raw.description) };
    });
  },

  async createConversation(temporary = false, profileId = "graduate-admissions") {
    const response = await request<ConversationSummary | { conversation: ConversationSummary }>("/api/conversations", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ profileId, temporary })
    });
    return normalizeConversation("conversation" in response ? response.conversation : response);
  },

  async conversation(id: string) {
    const response = await request<ConversationDetail | { conversation: ConversationDetail }>(
      `/api/conversations/${id}`
    );
    return normalizeConversationDetail("conversation" in response ? response.conversation : response);
  },

  async updateConversation(id: string, patch: Partial<Pick<ConversationSummary, "title" | "state" | "pinned">>) {
    const wirePatch = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.state !== undefined ? { archived: patch.state === "archived" } : {})
    };
    const response = await request<ConversationSummary | { conversation: ConversationSummary }>(
      `/api/conversations/${id}`,
      {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(wirePatch)
      }
    );
    return normalizeConversation("conversation" in response ? response.conversation : response, patch.state);
  },

  deleteConversation: (id: string) => request<void>(`/api/conversations/${id}`, { method: "DELETE" }),

  async learningSession(conversationId: string) {
    const response = await request<{ session?: unknown }>(`/api/conversations/${conversationId}/learning-session`);
    return normalizeLearningSession(response.session);
  },
  async createLearningSession(
    conversationId: string,
    input: { goal: string; topicKey?: string | null; condition?: "on-call" | "one-shot" | "multi-turn" }
  ) {
    const response = await request<{ session?: unknown }>(`/api/conversations/${conversationId}/learning-session`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    });
    return normalizeLearningSession(response.session);
  },
  async updateLearningSession(
    conversationId: string,
    input: { status?: "active" | "paused" | "completed" | "dismissed"; goal?: string; topicKey?: string | null }
  ) {
    const response = await request<{ session?: unknown }>(`/api/conversations/${conversationId}/learning-session`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    });
    return normalizeLearningSession(response.session);
  },
  async confirmLearningVerification(id: string, verdict: Exclude<LearningOutcome, "unknown">) {
    const response = await request<{ verification?: unknown; incident?: unknown; policy?: unknown }>(
      `/api/learning/verifications/${id}/confirm`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ verdict })
      }
    );
    return {
      verification: response.verification ? normalizeLearningVerification(response.verification) : undefined,
      incident: response.incident ? normalizeLearningIncident(response.incident) : undefined,
      policy: response.policy ? normalizeLearningPolicy(response.policy) : undefined
    };
  },
  async learningPolicies(input: {
    profileId: string;
    topicKey?: string | null;
    difficultyType?: string;
    datasetKind?: "live" | "demo";
    includeDisabled?: boolean;
  }) {
    const params = new URLSearchParams({ profileId: input.profileId, datasetKind: input.datasetKind ?? "live" });
    if (input.topicKey !== undefined && input.topicKey !== null) params.set("topicKey", input.topicKey);
    if (input.difficultyType) params.set("difficultyType", input.difficultyType);
    if (input.includeDisabled) params.set("includeDisabled", "true");
    const response = await request<{ policies?: unknown[] }>(`/api/learning/policies?${params}`);
    return (response.policies ?? []).map(normalizeLearningPolicy);
  },
  async reviewLearningPolicy(id: string, verdict: "pass" | "reject", conversationId?: string) {
    const response = await request<{ policy?: unknown }>(`/api/learning/policies/${id}/review`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ verdict, ...(conversationId ? { conversationId } : {}) })
    });
    return response.policy ? normalizeLearningPolicy(response.policy) : undefined;
  },
  async rollbackLearningPolicy(id: string, conversationId?: string) {
    const response = await request<{ policy?: unknown }>(`/api/learning/policies/${id}/rollback`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(conversationId ? { conversationId } : {})
    });
    return response.policy ? normalizeLearningPolicy(response.policy) : undefined;
  },
  async learningDemoScenarios() {
    const response = await request<{ scenarios?: unknown[] }>("/api/learning/demo-scenarios");
    return (response.scenarios ?? []).map(normalizeLearningDemoScenario);
  },
  async startLearningDemoScenario(
    id: string,
    executionMode: "deterministic" | "agent",
    condition: "on-call" | "one-shot" | "multi-turn" = "on-call"
  ) {
    const response = await request<{ conversation?: ConversationDetail }>(
      `/api/learning/demo-scenarios/${encodeURIComponent(id)}/start`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ executionMode, condition })
      }
    );
    return response.conversation ? normalizeConversationDetail(response.conversation) : undefined;
  },

  async learningMetrics(input: {
    profileId?: string;
    topicKey?: string | null;
    difficultyType?: string;
    datasetKind?: string;
  }) {
    const params = new URLSearchParams();
    if (input.profileId) params.set("profileId", input.profileId);
    if (input.topicKey) params.set("topicKey", input.topicKey);
    if (input.difficultyType) params.set("difficultyType", input.difficultyType);
    if (input.datasetKind) params.set("datasetKind", input.datasetKind);
    const response = await request<{ metrics: LearningMetricsDto }>(`/api/learning/metrics?${params}`);
    return response.metrics;
  },

  async learningVariants(input: { profileId: string; topicKey?: string | null }) {
    const params = new URLSearchParams();
    params.set("profileId", input.profileId);
    // A topicless session's scope is the empty topic, which is a real filter value —
    // omitting the param would list every topic's variants for the profile.
    if (input.topicKey !== undefined) params.set("topicKey", input.topicKey ?? "");
    const response = await request<{ variants: LearningStrategyVariantDto[] }>(`/api/learning/variants?${params}`);
    return response.variants;
  },

  async reviewLearningVariant(
    id: string,
    verdict: "trial" | "reject" | "enable" | "retire" | "keep",
    conversationId?: string
  ) {
    const response = await request<{ variant: LearningStrategyVariantDto }>(`/api/learning/variants/${id}/review`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ verdict, ...(conversationId ? { conversationId } : {}) })
    });
    return response.variant;
  },

  async learningHandoff(incidentId: string) {
    const response = await request<{ report: LearningHandoffReportDto }>(
      `/api/learning/incidents/${incidentId}/handoff`
    );
    return response.report;
  },

  researchSettings: () => request<{ enabled: boolean }>("/api/research/settings"),
  updateResearchSettings: (enabled: boolean) =>
    request<{ enabled: boolean }>("/api/research/settings", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled })
    }),

  async sendMessage(id: string, content: string, mode: SendMode, attachmentIds: string[], clientMessageId: string) {
    const response = await request<SendMessageResponse & { conversation?: ConversationDetail }>(
      `/api/conversations/${id}/messages`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ content, mode, attachmentIds, clientMessageId })
      }
    );
    return {
      ...response,
      message: normalizeMessage(response.message),
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },

  interrupt: (runId: string) => request<void>(`/api/runs/${runId}/interrupt`, { method: "POST" }),

  answerQuestion: (runId: string, answers: Record<string, string>) =>
    request<{ runId: string; accepted: boolean }>(`/api/runs/${runId}/answers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ answers })
    }),

  async replayRun(runId: string, options?: { includeArtifactId?: string }) {
    const response = await request<{ conversation?: ConversationDetail }>(`/api/runs/${runId}/replay`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(options ?? {})
    });
    return {
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },

  async steerQueuedRun(runId: string) {
    const response = await request<SendMessageResponse & { conversation?: ConversationDetail }>(
      `/api/runs/${runId}/steer`,
      { method: "POST" }
    );
    return {
      ...response,
      message: normalizeMessage(response.message),
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },
  async updateQueuedRun(runId: string, content: string) {
    const response = await request<SendMessageResponse & { conversation?: ConversationDetail }>(`/api/runs/${runId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ content })
    });
    return {
      ...response,
      message: normalizeMessage(response.message),
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },
  async deleteQueuedRun(runId: string) {
    const response = await request<{ runId: string; conversation?: ConversationDetail }>(`/api/runs/${runId}`, {
      method: "DELETE"
    });
    return {
      ...response,
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },
  async retryMessage(messageId: string) {
    const response = await request<{ runId?: string; run?: { id?: string }; conversation?: ConversationDetail }>(
      `/api/messages/${messageId}/retry`,
      { method: "POST" }
    );
    return {
      runId: response.runId ?? response.run?.id,
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },
  async branchMessage(messageId: string, content?: string, asNewConversation = false) {
    const response = await request<SendMessageResponse & { conversation?: ConversationDetail; run?: { id?: string } }>(
      `/api/messages/${messageId}/branch`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ content, asNewConversation })
      }
    );
    return {
      ...response,
      runId: response.runId ?? response.run?.id,
      conversation: response.conversation ? normalizeConversationDetail(response.conversation) : undefined
    };
  },

  async uploadAttachment(conversationId: string, file: File) {
    const form = new FormData();
    form.set("file", file);
    const response = await request<Attachment | { attachment: Attachment }>(
      `/api/attachments?conversationId=${encodeURIComponent(conversationId)}`,
      { method: "POST", body: form }
    );
    return normalizeAttachment("attachment" in response ? response.attachment : response);
  },

  deleteAttachment: (id: string) => request<void>(`/api/attachments/${id}`, { method: "DELETE" }),

  async memorySettings() {
    const raw = await request<Partial<MemorySettingsDto>>("/api/memory/settings");
    return {
      enabled: raw.enabled !== false,
      autoSave: raw.autoSave !== false,
      referenceHistory: raw.referenceHistory !== false
    } satisfies MemorySettingsDto;
  },

  saveMemorySettings: (settings: Partial<MemorySettingsDto>) =>
    request<MemorySettingsDto>("/api/memory/settings", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(settings)
    }),

  memoryMaintenance: () => request<MemoryMaintenanceStatusDto>("/api/memory/maintenance"),
  startMemoryMaintenance: () => request<MemoryMaintenanceStatusDto>("/api/memory/maintenance", { method: "POST" }),

  async memories(category?: MemoryCategory, query = "") {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (query.trim()) params.set("query", query.trim());
    const response = await request<ApiList<MemoryItemDto> | MemoryItemDto[]>(`/api/memories?${params}`);
    return unwrapList(response).map(normalizeMemory);
  },

  async createMemory(
    input: Pick<MemoryItemDto, "category" | "title" | "content"> &
      Partial<Pick<MemoryItemDto, "keywords" | "importance" | "pinned" | "profileId">>
  ) {
    return normalizeMemory(
      await request<MemoryItemDto>("/api/memories", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(input)
      })
    );
  },

  async updateMemory(
    id: string,
    input: Partial<
      Pick<MemoryItemDto, "category" | "title" | "content" | "keywords" | "importance" | "pinned" | "profileId">
    >
  ) {
    return normalizeMemory(
      await request<MemoryItemDto>(`/api/memories/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(input)
      })
    );
  },

  deleteMemory: (id: string) => request<void>(`/api/memories/${id}`, { method: "DELETE" }),
  clearMemories: () => request<{ deleted: number }>("/api/memories", { method: "DELETE" }),

  async undoMemoryMutation(id: string) {
    const result = await request<{ memory: MemoryItemDto | null }>(`/api/memory/mutations/${id}/undo`, {
      method: "POST"
    });
    return result.memory ? normalizeMemory(result.memory) : null;
  },

  createSignal: (input: {
    kind: "thumb" | "retry" | "edit" | "correct";
    polarity: EvolutionPolarity;
    reason?: string;
    conversationId?: string;
    messageId?: string;
    runId?: string;
    confirmAsPlaybook?: boolean;
    playbookInstruction?: string;
  }) =>
    request("/api/signals", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ source: "user", ...input })
    }),

  handbook: (profileId: string) =>
    request<HandbookDocument>(`/api/handbook?profileId=${encodeURIComponent(profileId)}`),
  saveHandbook: (profileId: string, markdown: string) =>
    request<HandbookDocument>("/api/handbook", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ profileId, markdown })
    }),
  async shelf(profileId: string) {
    const response = await request<{ items?: ShelfItem[] }>(`/api/shelf?profileId=${encodeURIComponent(profileId)}`);
    return Array.isArray(response.items)
      ? response.items.map((item) => ({
          id: String(item.id),
          profileId: String(item.profileId ?? profileId),
          conversationId: item.conversationId ?? null,
          fileName: String(item.fileName ?? ""),
          mimeType: String(item.mimeType ?? ""),
          relativePath: String(item.relativePath ?? ""),
          createdAt: String(item.createdAt ?? "")
        }))
      : [];
  },
  shelfOpenUrl: (id: string) => `/api/shelf/${encodeURIComponent(id)}`,
  shelfDownloadUrl: (id: string) => `/api/shelf/${encodeURIComponent(id)}?download=1`,
  deleteShelfItem: (id: string) => request<void>(`/api/shelf/${encodeURIComponent(id)}`, { method: "DELETE" }),
  latestSnapshot: (profileId: string) =>
    request<{ runId: string; prompt: string }>(`/api/snapshots/latest?profileId=${encodeURIComponent(profileId)}`),
  equipment: (profileId: string) =>
    request<ProfileEquipment>(`/api/equipment?profileId=${encodeURIComponent(profileId)}`),
  setEvolvedArtifactEnabled: (id: string, enabled: boolean) =>
    request<EvolvedArtifact>(`/api/evolved-artifacts/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled })
    }),
  keepEvolvedArtifact: (id: string) =>
    request<EvolvedArtifact>(`/api/evolved-artifacts/${id}/keep`, { method: "POST", headers: JSON_HEADERS }),
  reviewEvolvedArtifact: (id: string, verdict: "pass" | "reject", reason: string) =>
    request<EvolvedArtifact>(`/api/evolved-artifacts/${id}/review`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ verdict, reason })
    }),
  getEvolvedArtifact: (id: string) => request<EvolvedArtifact>(`/api/evolved-artifacts/${id}`),

  async admissionsCycles() {
    return unwrapNamedList<AdmissionsCycle>(await request("/api/admissions/cycles"), ["cycles"]);
  },
  createAdmissionsCycle: (input: Partial<AdmissionsCycle>) =>
    request<AdmissionsCycle>("/api/admissions/cycles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  updateAdmissionsCycle: (id: string, input: Partial<AdmissionsCycle>) =>
    request<AdmissionsCycle>("/api/admissions/cycles", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, ...input })
    }),
  admissionsProfile: () => request<AdmissionsProfile>("/api/admissions/profile"),
  createAdmissionsProfile: (input: Partial<AdmissionsProfile>) =>
    request<AdmissionsProfile>("/api/admissions/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  saveAdmissionsProfile: (input: Partial<AdmissionsProfile>) =>
    request<AdmissionsProfile>("/api/admissions/profile", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  async admissionsPrograms() {
    return unwrapNamedList<AdmissionsProgram>(await request("/api/admissions/programs"), ["programs"]);
  },
  createAdmissionsProgram: (input: Partial<AdmissionsProgram>) =>
    request<AdmissionsProgram>("/api/admissions/programs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  updateAdmissionsProgram: (id: string, input: Partial<AdmissionsProgram>) =>
    request<AdmissionsProgram>("/api/admissions/programs", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, ...input })
    }),
  deleteAdmissionsProgram: (id: string) =>
    request<void>(`/api/admissions/programs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  async admissionsRequirements(programId: string) {
    return unwrapNamedList<AdmissionsRequirement>(await request(`/api/admissions/programs/${programId}/requirements`), [
      "requirements"
    ]);
  },
  createAdmissionsRequirement: (programId: string, input: Partial<AdmissionsRequirement>) =>
    request<AdmissionsRequirement>(`/api/admissions/programs/${programId}/requirements`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  updateAdmissionsRequirement: (programId: string, id: string, input: Partial<AdmissionsRequirement>) =>
    request<AdmissionsRequirement>(`/api/admissions/programs/${programId}/requirements`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, ...input })
    }),
  async admissionsTasks() {
    return unwrapNamedList<AdmissionsTask>(await request("/api/admissions/tasks"), ["tasks"]);
  },
  createAdmissionsTask: (input: Partial<AdmissionsTask>) =>
    request<AdmissionsTask>("/api/admissions/tasks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  updateAdmissionsTask: (id: string, input: Partial<AdmissionsTask>) =>
    request<AdmissionsTask>("/api/admissions/tasks", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, ...input })
    }),
  async admissionsSources() {
    return unwrapNamedList<AdmissionsSource>(await request("/api/admissions/sources"), ["sources"]);
  },
  createAdmissionsSource: (input: Partial<AdmissionsSource>) =>
    request<AdmissionsSource>("/api/admissions/sources", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  updateAdmissionsSource: (id: string, input: Partial<AdmissionsSource>) =>
    request<AdmissionsSource>("/api/admissions/sources", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, ...input })
    }),
  async admissionsArtifacts() {
    return unwrapNamedList<AdmissionsArtifact>(await request("/api/admissions/artifacts"), ["artifacts"]);
  },
  admissionsArtifactDownloadUrl: (id: string) => `/api/admissions/artifacts/${encodeURIComponent(id)}/download`,

  async scheduledJobs() {
    return unwrapNamedList<ScheduledJob>(await request("/api/scheduled-jobs"), ["jobs"]);
  },
  createScheduledJob: (input: Partial<ScheduledJob>) =>
    request<ScheduledJob>("/api/scheduled-jobs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input)
    }),
  updateScheduledJob: (id: string, input: Partial<ScheduledJob>) =>
    request<ScheduledJob>("/api/scheduled-jobs", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ id, ...input })
    }),
  async scheduledJobRuns(id: string) {
    return unwrapNamedList<ScheduledJobRun>(await request(`/api/scheduled-jobs/${id}/runs`), ["runs"]).map(
      normalizeScheduledJobRun
    );
  },
  scheduledJobRun: async (id: string) =>
    normalizeScheduledJobRun(await request<ScheduledJobRun>(`/api/scheduled-job-runs/${id}`)),
  runScheduledJob: (id: string) => request<ScheduledJobRun>(`/api/scheduled-jobs/${id}/run`, { method: "POST" })
};

export function createEventStream(
  conversationId: string,
  after: string | undefined,
  onEvent: (event: AgentEvent) => void,
  onConnection: (connected: boolean) => void
) {
  const params = new URLSearchParams();
  if (after) params.set("after", after);
  const source = new EventSource(`/api/conversations/${conversationId}/events?${params}`);
  source.onopen = () => onConnection(true);
  source.onmessage = (message) => {
    try {
      onEvent(normalizeEvent(JSON.parse(message.data)));
    } catch {
      onEvent(normalizeEvent({ type: "stream.parse_error", error: t("streamParseError") }));
    }
  };
  source.onerror = () => onConnection(false);
  return () => source.close();
}
