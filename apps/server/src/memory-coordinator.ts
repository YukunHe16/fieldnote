import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryItemDto, MemoryMaintenanceStatusDto } from "@fieldnote/contracts";
import type { AppConfig } from "./config.js";
import type { EventStore } from "./event-store.js";
import { containsSensitiveContent, type MemoryStore } from "./memory-store.js";
import type { AgentRuntime, TurnAnalysis } from "./runtime.js";
import { emptyTurnAnalysis } from "./runtime.js";
import { DEFAULT_PARTICIPANT_ID, type AgentStore, type RunRecord } from "./store.js";
import type { EvolutionCoordinator } from "./evolution-coordinator.js";
import { countMatchedPlaybooks, skillLabelsFromBlocks, subagentLabelsFromBlocks } from "./overlay-context.js";
import type { LiveDomainCard } from "./domain-card-live.js";
import type { AdmissionsStore } from "./admissions-store.js";
import type { LearningStore } from "./learning-store.js";
import { detectLearningOpportunity } from "./learning-opportunity.js";
import { isEvolutionEligibleConversation } from "./evolution-eligibility.js";
import type { RunReplayStore } from "./run-replay.js";

const CASUAL_PROMPT_CHARS = 20;
const CASUAL_THINKING_MS = 4_000;
const CASUAL_OUTPUT_TOKENS = 40;
const EXPLICIT_MEMORY_OR_EVOLVE =
  /做成\s*(skill|技能)|做成子代理|交给子代理|(?:请|麻烦|帮我)?(?:记住|记得|记一下|保存到记忆)|(?:please\s+)?remember\b/i;

export class MemoryCoordinator {
  private draining = false;
  private maintenancePromise: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: AgentStore,
    private readonly memories: MemoryStore,
    private readonly events: EventStore,
    private readonly runtime: AgentRuntime,
    private readonly evolution?: EvolutionCoordinator,
    private readonly liveCard?: LiveDomainCard,
    private readonly admissions?: AdmissionsStore,
    private readonly learning?: LearningStore,
    private readonly replay?: RunReplayStore
  ) {
    this.memories.recoverExtractions();
    this.memories.recoverMaintenance();
    void this.drain();
    this.scheduleMaintenance();
  }

  enqueue(run: RunRecord): void {
    this.memories.enqueueExtraction(run.id);
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    while (this.draining) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.maintenancePromise?.catch(() => undefined);
  }

  maintenanceStatus(now = Date.now()): MemoryMaintenanceStatusDto {
    return this.memories.getMaintenanceStatus(now);
  }

  scheduleMaintenance(force = false, now = Date.now()): MemoryMaintenanceStatusDto {
    const status = this.memories.getMaintenanceStatus(now);
    if (this.stopping || this.maintenancePromise || status.status === "running") return status;
    const settings = this.memories.getSettings();
    if (!settings.enabled || (!force && !settings.autoSave) || (!force && !status.due)) return status;
    const candidates = this.memories.maintenanceCandidates(50, now, force);
    if (candidates.length < 1) return this.memories.markMaintenanceCompleted(now);
    const started = this.memories.markMaintenanceRunning(now);
    this.maintenancePromise = this.runMaintenance(now, force)
      .catch(() => undefined)
      .finally(() => {
        this.maintenancePromise = null;
      });
    return started;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopping) return;
    this.draining = true;
    try {
      while (!this.stopping) {
        const job = this.memories.nextExtraction();
        if (!job) break;
        const started = this.memories.markExtraction(job.runId, "running");
        try {
          const result = await this.process(job.runId);
          this.memories.markExtraction(job.runId, result);
        } catch (error) {
          const message = safeError(error);
          if ((started?.attempts ?? 1) >= 3) this.memories.markExtraction(job.runId, "failed", message);
          else this.memories.markExtraction(job.runId, "queued", message);
        }
      }
    } finally {
      this.draining = false;
      this.scheduleMaintenance();
      this.evolution?.scheduleReview();
    }
  }

  private async runMaintenance(watermark: number, includeBeforeCutoff: boolean): Promise<void> {
    try {
      const workspacePath = path.join(this.config.workspaceRoot, ".memory-maintenance");
      await fs.mkdir(workspacePath, { recursive: true });
      let processedBatch = false;
      while (true) {
        const candidates = this.memories.maintenanceCandidates(50, watermark, includeBeforeCutoff);
        if (candidates.length === 0) break;
        const editable = candidates.filter((memory) => memory.sourceKind === "auto" && !memory.pinned);
        const batchTarget = editable[0] ? { scope: editable[0].scope, profileId: editable[0].profileId } : null;
        const editableIds = editable.map((memory) => memory.id);
        if (editableIds.length === 0 && processedBatch) break;
        if (!batchTarget) break;
        let refinement: Awaited<ReturnType<NonNullable<AgentRuntime["refineMemories"]>>> | undefined;
        let _lastError = "Memory maintenance failed";
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            refinement = await this.runtime.refineMemories?.({
              workspacePath,
              memories: candidates.map((memory) => ({
                id: memory.id,
                category: memory.category,
                title: memory.title,
                content: memory.content,
                keywords: memory.keywords,
                importance: memory.importance,
                sourceKind: memory.sourceKind,
                scope: memory.scope,
                profileId: memory.profileId,
                pinned: memory.pinned,
                sources: memory.sources.slice(0, 3).map((source) => ({
                  conversationTitle: source.conversationTitle,
                  excerpt: source.excerpt,
                  createdAt: source.createdAt
                }))
              }))
            });
            if (!refinement) throw new Error("Runtime does not support memory refinement");
            break;
          } catch (error) {
            _lastError = safeError(error);
          }
        }
        if (!refinement) {
          applyHeuristicMaintenance(this.memories, editable, batchTarget);
          this.memories.markMemoriesMaintained(editableIds, watermark, batchTarget);
          processedBatch = true;
          continue;
        }
        applyRefinementSafely(this.memories, candidates, refinement, batchTarget);
        this.memories.markMemoriesMaintained(editableIds, watermark, batchTarget);
        processedBatch = true;
        if (editableIds.length === 0) break;
      }
      this.memories.markMaintenanceCompleted(watermark);
    } catch (error) {
      this.memories.markMaintenanceFailed(safeError(error));
      throw error;
    }
  }

  private async process(runId: string): Promise<"completed" | "skipped"> {
    const run = this.activeCompletedRun(runId);
    if (!run) return "skipped";
    const conversation = this.store.getConversation(run.conversationId);
    const messages = this.store.getMessagesForRun(runId);
    const userMessages = messages.filter((message) => message.role === "user");
    const assistant = messages.find((message) => message.id === run.assistantMessageId);
    if (!conversation || userMessages.length === 0 || !assistant?.content.trim()) {
      return "skipped";
    }
    if (conversation.temporary) return "skipped";
    // Synthetic conversations (demo/eval/replay) skip everything, as before. Non-default
    // participants are gated SURGICALLY below instead: their turns still earn a title and
    // a learning suggestion — the entry paths the participant axis exists for — while the
    // owner's memory store and capability evolution stay untouched in both directions.
    if (
      !isEvolutionEligibleConversation(conversation.id, {
        learning: this.learning,
        replay: this.replay
      })
    )
      return "skipped";
    const ownerConversation = conversation.participantId === DEFAULT_PARTICIPANT_ID;
    const prompt = userMessages
      .map((message) => message.content)
      .filter(Boolean)
      .join("\n\n补充：");
    const usedSkills = skillLabelsFromBlocks(assistant.blocks ?? []);
    const usedSubagents = subagentLabelsFromBlocks(assistant.blocks ?? []);
    const injectedPlaybooks = this.evolution?.injectedPlaybooksForRun(run.id) ?? [];
    const existingArtifacts = this.evolution?.artifactSummaries(conversation.profileId) ?? [];
    const retried = this.evolution?.hasRetryOrEditForRun(run.id) ?? false;
    const workspacePath = path.join(this.config.workspaceRoot, run.conversationId);
    await fs.mkdir(workspacePath, { recursive: true });
    if (!this.activeCompletedRun(runId)) return "skipped";
    const skipCasual = shouldSkipCasualAnalyze({
      prompt,
      usedSkills,
      usedSubagents,
      injectedPlaybookCount: countMatchedPlaybooks(injectedPlaybooks, prompt),
      toolCount: this.store.countToolEvents(run.id),
      thinkingMs: this.store.assistantBlocks.thinkingDurationMs(assistant.id),
      outputTokens: estimateOutputTokens(assistant.content),
      reasoningChars: (assistant.reasoningSummary ?? "").trim().length
    });
    const analysis = skipCasual
      ? emptyTurnAnalysis(prompt)
      : await this.runtime.analyzeTurn?.({
          prompt,
          response: assistant.content,
          workspacePath,
          // A participant's text must not be analyzed against the owner's memory list.
          existingMemories: (ownerConversation ? this.memories.list({ profileId: conversation.profileId }) : []).map(
            (memory) => ({
              id: memory.id,
              category: memory.category,
              title: memory.title,
              content: memory.content,
              sourceKind: memory.sourceKind,
              scope: memory.scope,
              profileId: memory.profileId
            })
          ),
          injectedPlaybooks,
          usedSkills,
          usedSubagents,
          retried,
          existingArtifacts
        });
    if (!analysis) throw new Error("Runtime does not support memory analysis");
    const activeRun = this.activeCompletedRun(runId);
    if (!activeRun) return "skipped";
    this.applyTitle(activeRun, conversation.title, analysis);
    const settings = this.memories.getSettings();
    if (ownerConversation && settings.enabled && settings.autoSave) {
      this.applyMemories(activeRun, conversation.title, assistant.id, prompt, analysis, conversation.profileId);
    }
    if (ownerConversation) {
      try {
        await this.evolution?.applyTurnEvolution({
          profileId: conversation.profileId,
          runId,
          conversationId: conversation.id,
          retried,
          usedSkills,
          usedSubagents,
          injectedPlaybooks,
          analysis
        });
        if (!this.activeCompletedRun(runId)) return "skipped";
        await this.evolution?.proposeFromPrompt({
          profileId: conversation.profileId,
          prompt,
          runId
        });
        if (!this.activeCompletedRun(runId)) return "skipped";
        this.evolution?.scheduleReview();
      } catch {
        // Evolution is opportunistic and must not fail memory extraction.
      }
    }
    if (!this.activeCompletedRun(runId)) return "skipped";
    if (this.learning && conversation.channel === "web" && !this.learning.getSessionForConversation(conversation.id)) {
      const latestConversation = this.store.getConversation(conversation.id);
      const opportunity = latestConversation
        ? detectLearningOpportunity(
            latestConversation.messages.map((message) => ({ role: message.role, content: message.content }))
          )
        : null;
      if (opportunity && opportunity.confidence >= 0.75) {
        try {
          const session = this.learning.createSession({
            conversationId: conversation.id,
            profileId: conversation.profileId,
            goal: opportunity.goal,
            status: "suggested",
            datasetKind: "live",
            suggestionReason: opportunity.reason
          });
          this.events.append({
            type: "learning.suggested",
            conversationId: conversation.id,
            branchId: activeRun.branchId,
            runId: activeRun.id,
            payload: { session, confidence: opportunity.confidence }
          });
        } catch {
          // Suggestions are best-effort and never fail memory extraction.
        }
      }
    }
    this.liveCard?.capture(
      conversation.profileId,
      this.memories.stableContext(conversation.profileId),
      this.admissions
    );
    return "completed";
  }

  private activeCompletedRun(runId: string): RunRecord | null {
    const run = this.store.getRun(runId);
    return run?.status === "completed" && !run.supersededAt ? run : null;
  }

  private applyTitle(run: RunRecord, currentTitle: string, analysis: TurnAnalysis): void {
    if (!analysis.title || !isDefaultConversationTitle(currentTitle)) return;
    const latest = this.store.getConversation(run.conversationId);
    if (!latest || !isDefaultConversationTitle(latest.title)) return;
    const conversation = this.store.updateConversation(run.conversationId, { title: analysis.title });
    if (!conversation) return;
    this.events.append({
      type: "conversation.updated",
      conversationId: run.conversationId,
      branchId: run.branchId,
      runId: run.id,
      payload: { conversation }
    });
  }

  private applyMemories(
    run: RunRecord,
    conversationTitle: string,
    assistantMessageId: string,
    prompt: string,
    analysis: TurnAnalysis,
    profileId: string
  ): void {
    const source = {
      conversationId: run.conversationId,
      messageId: assistantMessageId,
      runId: run.id,
      conversationTitle,
      excerpt: analysis.task?.summary ?? ""
    };
    const changed: MemoryItemDto[] = [];
    if (shouldStoreTaskMemory(prompt, analysis) && analysis.task && !containsSensitiveContent(analysis.task.summary)) {
      changed.push(
        this.memories.create({
          category: "task",
          title: analysis.task.title,
          content: analysis.task.summary,
          keywords: analysis.task.keywords,
          sourceKind: "auto",
          importance: analysis.task.importance,
          scope: "profile",
          profileId,
          source
        })
      );
    }
    for (const item of analysis.memories) {
      if (containsSensitiveContent(`${item.title}\n${item.content}\n${item.keywords.join(" ")}`)) continue;
      const scope = item.category === "profile" || item.category === "preference" ? "global" : "profile";
      const scopedProfileId = scope === "profile" ? profileId : null;
      const candidate = item.memoryId ? this.memories.get(item.memoryId) : null;
      const existing =
        candidate && candidate.scope === scope && candidate.profileId === scopedProfileId
          ? candidate
          : this.memories.findRelated(item.category, item.title, item.keywords, scope, scopedProfileId);
      if (existing?.sourceKind === "auto" && existing.category !== "task") {
        const updated = this.memories.update(existing.id, {
          category: item.category,
          title: item.title,
          content: item.content,
          keywords: item.keywords,
          importance: item.importance
        });
        if (updated) {
          this.memories.addSource(updated.id, source);
          changed.push(updated);
        }
      } else if (!existing) {
        changed.push(
          this.memories.create({
            category: item.category,
            title: item.title,
            content: item.content,
            keywords: item.keywords,
            sourceKind: "auto",
            importance: item.importance,
            scope,
            profileId: scopedProfileId,
            source
          })
        );
      }
    }
    if (changed.length > 0) {
      this.events.append({
        type: "memory.changed",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { automatic: true, memoryIds: [...new Set(changed.map((memory) => memory.id))] }
      });
    }
  }
}

function applyRefinementSafely(
  memories: MemoryStore,
  candidates: MemoryItemDto[],
  refinement: NonNullable<Awaited<ReturnType<NonNullable<AgentRuntime["refineMemories"]>>>>,
  batchTarget: { scope: MemoryItemDto["scope"]; profileId: string | null }
): void {
  const candidateMap = new Map(candidates.map((memory) => [memory.id, memory]));
  const usedIds = new Set<string>();
  for (const group of refinement.groups) {
    const sourceMemoryIds = group.sourceMemoryIds.filter((id) => {
      const memory = candidateMap.get(id);
      return Boolean(
        memory &&
          !usedIds.has(id) &&
          memory.sourceKind === "auto" &&
          !memory.pinned &&
          memory.scope === batchTarget.scope &&
          memory.profileId === batchTarget.profileId
      );
    });
    if (sourceMemoryIds.length < 2) continue;
    if (!group.title.trim() || !group.content.trim()) continue;
    if (containsSensitiveContent(`${group.title}\n${group.content}\n${group.keywords.join(" ")}`)) continue;
    try {
      const merged = memories.mergeTaskMemories({ ...group, sourceMemoryIds, target: batchTarget });
      if (merged) sourceMemoryIds.forEach((id) => usedIds.add(id));
    } catch {}
  }
  const supersedeIds = refinement.supersedeIds.filter((id) => {
    if (usedIds.has(id)) return false;
    const current = candidateMap.get(id);
    return Boolean(current && current.sourceKind === "auto" && !current.pinned);
  });
  memories.supersedeAutomaticMemories(supersedeIds, batchTarget);
  supersedeIds.forEach((id) => usedIds.add(id));
  for (const update of refinement.updates) {
    if (usedIds.has(update.memoryId)) continue;
    const current = candidateMap.get(update.memoryId);
    if (!current || current.sourceKind !== "auto" || current.pinned) continue;
    if (!update.title.trim() || !update.content.trim()) continue;
    if (containsSensitiveContent(`${update.title}\n${update.content}\n${update.keywords.join(" ")}`)) continue;
    try {
      memories.updateAutomaticMemory(
        update.memoryId,
        {
          title: update.title,
          content: update.content,
          keywords: update.keywords,
          importance: update.importance
        },
        batchTarget
      );
    } catch {}
  }
}

function applyHeuristicMaintenance(
  memories: MemoryStore,
  editable: MemoryItemDto[],
  batchTarget: { scope: MemoryItemDto["scope"]; profileId: string | null }
): void {
  const groups = new Map<string, MemoryItemDto[]>();
  for (const memory of editable) {
    if (memory.category !== "task") continue;
    const key = memory.title.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!key) continue;
    const current = groups.get(key) ?? [];
    current.push(memory);
    groups.set(key, current);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    try {
      memories.mergeTaskMemories({
        sourceMemoryIds: group.map((memory) => memory.id),
        category: "task",
        title: group[0]!.title,
        content: group[0]!.content,
        keywords: group[0]!.keywords,
        importance: Math.max(...group.map((memory) => memory.importance)),
        target: batchTarget
      });
    } catch {}
  }
}

function isDefaultConversationTitle(title: string): boolean {
  const normalized = title.trim();
  return new Set(["", "新对话", "新的对话", "New conversation", "飞书单聊", "飞书群聊", "飞书话题"]).has(normalized);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
}

export function estimateOutputTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fff]/.test(char)) tokens += 1;
    else if (/\s/.test(char)) continue;
    else tokens += 0.25;
  }
  return Math.ceil(tokens);
}

export function shouldSkipCasualAnalyze(input: {
  prompt: string;
  usedSkills: string[];
  usedSubagents: string[];
  injectedPlaybookCount: number;
  toolCount: number;
  thinkingMs: number;
  outputTokens: number;
  reasoningChars?: number;
}): boolean {
  if (input.toolCount > 0) return false;
  if (input.usedSkills.length > 0 || input.usedSubagents.length > 0) return false;
  if (input.injectedPlaybookCount > 0) return false;
  if (input.thinkingMs >= CASUAL_THINKING_MS) return false;
  if ((input.reasoningChars ?? 0) >= 80) return false;
  if (input.outputTokens >= CASUAL_OUTPUT_TOKENS) return false;
  if (EXPLICIT_MEMORY_OR_EVOLVE.test(input.prompt)) return false;
  return [...input.prompt.replace(/\s+/g, "")].length < CASUAL_PROMPT_CHARS;
}

function shouldStoreTaskMemory(prompt: string, analysis: TurnAnalysis): boolean {
  if (!analysis.meaningfulTask || analysis.taskType !== "durable_task") return false;
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (
    normalized.length <= 160 &&
    /^(?:(?:(?:请|麻烦|可以|能否)(?:你)?(?:帮我)?|帮我|以后(?:请)?|务必(?:帮我)?)?(?:记住|记得|记一下|保存到记忆|忘记|忘掉|不要记住)|(?:please\s+)?(?:remember|forget)\b)/i.test(
      normalized
    )
  ) {
    return false;
  }
  if (
    normalized.length <= 160 &&
    /^(?:(?:(?:能|可以)(?:不能)?(?:告诉我|说说)|请告诉我|告诉我|说说)?(?:我(?:今年)?(?:几岁|多大)|我叫(?:什么|什么名字)|我的(?:年龄|名字|偏好)(?:是什么|多少)|(?:你)?(?:还)?记得.*(?:我|之前)|你.*知道.*(?:我|之前))|what do you remember|how old am i|do you remember)/i.test(
      normalized
    )
  ) {
    return false;
  }
  return true;
}
