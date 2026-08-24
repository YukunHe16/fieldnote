import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AskUserQuestionDto, RunMode } from "@fieldnote/contracts";
import type { AppConfig } from "./config.js";
import type { EventStore } from "./event-store.js";
import type { MemoryCoordinator } from "./memory-coordinator.js";
import { RuntimeInputQueue, type AgentRuntime, type RuntimeEvent } from "./runtime.js";
import type { AgentStore, RunRecord, StoredAttachment } from "./store.js";
import { isAgentProfileId, LEGACY_PROFILE_ID } from "./agent-profiles.js";
import { readUiLocale } from "./locale.js";
import type { DeliveryShelf } from "./delivery-shelf.js";
import type { RunReplayStore } from "./run-replay.js";
import type { LiveDomainCard } from "./domain-card-live.js";
import type { MemoryStore } from "./memory-store.js";
import type { AdmissionsStore } from "./admissions-store.js";
import type { EvolutionStore } from "./evolution-store.js";
import type { InputFileManifestService } from "./input-file-manifest.js";
import type { InputFileManifestItem } from "./input-file-manifest.js";
import type { LearningStore } from "./learning-store.js";
import type { CollaborationStore } from "./collaboration-store.js";

export type OrchestratorServices = {
  shelf?: DeliveryShelf;
  replay?: RunReplayStore;
  liveCard?: LiveDomainCard;
  memories?: MemoryStore;
  admissions?: AdmissionsStore;
  evolution?: EvolutionStore;
  inputFiles?: InputFileManifestService;
  learning?: LearningStore;
  collaboration?: CollaborationStore;
};

export interface SupplementAcceptance {
  run: RunRecord;
  message: NonNullable<ReturnType<AgentStore["getMessage"]>>;
  duplicate: boolean;
}

export interface SteerAcceptance extends SupplementAcceptance {
  acceptedAs: "supplement" | "queued";
}

export class RunOrchestrator {
  private readonly queue: string[] = [];
  private readonly activeRuns = new Map<string, { run: RunRecord; controller: AbortController }>();
  private readonly inputQueues = new Map<string, RuntimeInputQueue>();
  private readonly activeConversations = new Set<string>();
  private readonly pendingQuestions = new Map<
    string,
    {
      question: AskUserQuestionDto;
      resolve: (answers: Record<string, string>) => void;
      reject: (error: Error) => void;
    }
  >();
  private externalRuntimeSlots = 0;
  private readonly externalSlotWaiters: Array<() => void> = [];
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: AgentStore,
    private readonly events: EventStore,
    private readonly runtime: AgentRuntime,
    private readonly memoryCoordinator?: MemoryCoordinator,
    private readonly services?: OrchestratorServices
  ) {
    this.recoverInterruptedRuns();
  }

  submit(
    conversationId: string,
    content: string,
    mode: RunMode = "normal",
    attachmentIds: string[] = [],
    clientMessageId?: string
  ): RunRecord {
    const normalized = content.trim();
    if (!normalized && attachmentIds.length === 0) throw new Error("Message cannot be empty");
    const run = this.store.createRun(conversationId, normalized, mode, attachmentIds, clientMessageId);
    this.inputQueues.set(run.id, new RuntimeInputQueue());
    this.events.append({
      type: "message.started",
      conversationId,
      branchId: run.branchId,
      runId: run.id,
      payload: {
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId,
        mode
      }
    });
    this.events.append({
      type: "run.status",
      conversationId,
      branchId: run.branchId,
      runId: run.id,
      payload: { status: "queued" }
    });
    this.queue.push(run.id);
    void this.drain();
    return run;
  }

  async supplement(
    conversationId: string,
    content: string,
    attachmentIds: string[] = [],
    clientMessageId?: string
  ): Promise<SupplementAcceptance | null> {
    const run = this.currentRun(conversationId);
    if (!run) return null;
    const inputQueue = this.inputQueues.get(run.id);
    if (!inputQueue?.isOpen) return null;
    if (clientMessageId) {
      const existing = this.store.getMessageByClientMessageId(conversationId, clientMessageId);
      if (existing) return { run, message: existing, duplicate: true };
    }
    const normalized = content.trim();
    if (!normalized && attachmentIds.length === 0) throw new Error("Message cannot be empty");
    const messageId = randomUUID();
    const manifest = this.services?.inputFiles
      ? await this.services.inputFiles.buildForPendingAttachments(conversationId, attachmentIds, messageId)
      : { items: [], errors: [] };
    if (manifest.errors.length > 0) {
      throw new Error(
        manifest.errors.map((item) => `${item.fileName ?? item.attachmentId ?? "附件"}：${item.message}`).join("；")
      );
    }
    if (clientMessageId) {
      const existing = this.store.getMessageByClientMessageId(conversationId, clientMessageId);
      if (existing) return { run, message: existing, duplicate: true };
    }
    const current = this.currentRun(conversationId);
    const currentRun = current?.id === run.id ? this.store.getRun(run.id) : null;
    const currentInputQueue = currentRun ? this.inputQueues.get(currentRun.id) : undefined;
    if (!currentRun || !["queued", "running"].includes(currentRun.status) || !currentInputQueue?.isOpen) return null;

    const message = this.store.createSupplementMessage({
      runId: currentRun.id,
      content: normalized,
      attachmentIds,
      messageId,
      ...(clientMessageId ? { clientMessageId } : {})
    });
    const attachments = this.store.getStoredAttachmentsForMessage(message.id);
    if (!currentInputQueue.push({ prompt: normalized, attachments, inputFiles: manifest.items })) return null;
    this.events.append({
      type: "message.started",
      conversationId,
      branchId: currentRun.branchId,
      runId: currentRun.id,
      payload: { messageId: message.id, mode: "guide", supplemental: true }
    });
    return { run: currentRun, message, duplicate: false };
  }

  async steerQueuedRun(runId: string): Promise<SteerAcceptance | null> {
    const queuedRun = this.store.getRun(runId);
    if (!queuedRun || queuedRun.mode !== "queue") return null;
    const queuedMessage = this.store.getMessage(queuedRun.userMessageId);
    if (!queuedMessage) return null;
    const queuedIndex = this.queue.indexOf(runId);
    if (queuedIndex < 0) {
      return { run: queuedRun, message: queuedMessage, duplicate: false, acceptedAs: "queued" };
    }
    const active = [...this.activeRuns.values()].find((entry) => entry.run.conversationId === queuedRun.conversationId);
    const activeInput = active ? this.inputQueues.get(active.run.id) : undefined;
    if (!active || !activeInput?.isOpen) {
      this.queue.splice(queuedIndex, 1);
      this.queue.unshift(queuedRun.id);
      void this.drain();
      return { run: queuedRun, message: queuedMessage, duplicate: false, acceptedAs: "queued" };
    }
    const manifest = this.services?.inputFiles
      ? await this.services.inputFiles.buildForMessage(queuedRun.conversationId, queuedRun.userMessageId)
      : { items: [], errors: [] };
    if (manifest.errors.length > 0) {
      throw new Error(
        manifest.errors.map((item) => `${item.fileName ?? item.attachmentId ?? "附件"}：${item.message}`).join("；")
      );
    }
    const currentQueuedRun = this.store.getRun(runId);
    const currentQueuedMessage = currentQueuedRun ? this.store.getMessage(currentQueuedRun.userMessageId) : null;
    if (
      !currentQueuedRun ||
      currentQueuedRun.status !== "queued" ||
      currentQueuedRun.mode !== "queue" ||
      !currentQueuedMessage
    ) {
      return null;
    }
    const currentQueuedIndex = this.queue.indexOf(runId);
    const currentActive = [...this.activeRuns.values()].find(
      (entry) => entry.run.conversationId === currentQueuedRun.conversationId
    );
    const currentActiveRun = currentActive ? this.store.getRun(currentActive.run.id) : null;
    const currentActiveInput = currentActiveRun ? this.inputQueues.get(currentActiveRun.id) : undefined;
    if (
      currentQueuedIndex < 0 ||
      !currentActiveRun ||
      currentActiveRun.status !== "running" ||
      !currentActiveInput?.isOpen
    ) {
      return { run: currentQueuedRun, message: currentQueuedMessage, duplicate: false, acceptedAs: "queued" };
    }

    const attachments = this.store.getAttachments(currentQueuedMessage.attachments.map((item) => item.id));
    const message = this.store.convertQueuedRunToSupplement(currentQueuedRun.id, currentActiveRun.id);

    this.queue.splice(currentQueuedIndex, 1);
    this.inputQueues.get(currentQueuedRun.id)?.close();
    this.inputQueues.delete(currentQueuedRun.id);
    if (!currentActiveInput.push({ prompt: message.content, attachments, inputFiles: manifest.items })) {
      throw new Error("Active run stopped before the queued message could be steered");
    }
    this.events.append({
      type: "run.interrupted",
      conversationId: currentQueuedRun.conversationId,
      branchId: currentQueuedRun.branchId,
      runId: currentQueuedRun.id,
      payload: { status: "interrupted", reason: "steered_into_active_run" }
    });
    this.events.append({
      type: "message.started",
      conversationId: currentActiveRun.conversationId,
      branchId: currentActiveRun.branchId,
      runId: currentActiveRun.id,
      payload: { messageId: message.id, mode: "guide", supplemental: true, steered: true }
    });
    return { run: currentActiveRun, message, duplicate: false, acceptedAs: "supplement" };
  }

  updateQueuedRun(runId: string, content: string): NonNullable<ReturnType<AgentStore["getMessage"]>> | null {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "queued" || run.mode !== "queue") return null;
    const message = this.store.updateQueuedRunContent(runId, content);
    if (!message) return null;
    this.events.append({
      type: "message.updated",
      conversationId: run.conversationId,
      branchId: run.branchId,
      runId,
      payload: { messageId: message.id, content: message.content }
    });
    return message;
  }

  deleteQueuedRun(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "queued" || run.mode !== "queue") return false;
    const queuedIndex = this.queue.indexOf(runId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.inputQueues.get(runId)?.close();
    this.inputQueues.delete(runId);
    if (!this.store.deleteQueuedRun(runId)) return false;
    this.events.append({
      type: "run.interrupted",
      conversationId: run.conversationId,
      branchId: run.branchId,
      runId,
      payload: { status: "interrupted", reason: "queued_run_deleted" }
    });
    return true;
  }

  interrupt(runId: string): boolean {
    const active = this.activeRuns.get(runId);
    if (active) {
      this.inputQueues.get(runId)?.close();
      this.store.setRunStatus(runId, "interrupting");
      this.events.append({
        type: "run.status",
        conversationId: active.run.conversationId,
        branchId: active.run.branchId,
        runId,
        payload: { status: "interrupting" }
      });
      this.rejectPendingQuestion(runId);
      active.controller.abort();
      return true;
    }
    const queuedIndex = this.queue.indexOf(runId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.inputQueues.get(runId)?.close();
      this.inputQueues.delete(runId);
      const run = this.store.getRun(runId);
      if (!run) return false;
      this.store.setRunStatus(runId, "interrupted");
      this.store.setMessageStatus(run.assistantMessageId, "interrupted");
      this.events.append({
        type: "run.interrupted",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId,
        payload: { status: "interrupted", reason: "queued_run_cancelled" }
      });
      return true;
    }
    return false;
  }

  interruptConversation(conversationId: string): boolean {
    let interrupted = false;
    for (const [runId, active] of this.activeRuns) {
      if (active.run.conversationId === conversationId) interrupted = this.interrupt(runId) || interrupted;
    }
    const queued = this.queue.filter((runId) => this.store.getRun(runId)?.conversationId === conversationId);
    for (const runId of queued) interrupted = this.interrupt(runId) || interrupted;
    return interrupted;
  }

  interruptSupersededRuns(conversationId: string): number {
    const candidates = [...[...this.activeRuns.keys()], ...this.queue]
      .filter((runId, index, all) => all.indexOf(runId) === index)
      .filter((runId) => {
        const run = this.store.getRun(runId);
        return run?.conversationId === conversationId && Boolean(run.supersededAt);
      });
    return candidates.filter((runId) => this.interrupt(runId)).length;
  }

  async interruptConversationAndWait(conversationId: string, timeoutMs = 8_000): Promise<void> {
    this.interruptConversation(conversationId);
    const deadline = Date.now() + timeoutMs;
    while (this.isConversationBusy(conversationId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.isConversationBusy(conversationId)) {
      throw new Error("Agent is still stopping; try again shortly");
    }
  }

  isConversationBusy(conversationId: string): boolean {
    if (this.activeConversations.has(conversationId)) return true;
    return this.queue.some((runId) => this.store.getRun(runId)?.conversationId === conversationId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    while (this.externalSlotWaiters.length) this.externalSlotWaiters.shift()?.();
    for (const [runId, active] of this.activeRuns) {
      this.inputQueues.get(runId)?.close();
      active.controller.abort();
    }
    await Promise.allSettled(
      [...this.activeRuns.keys()].map(async (runId) => {
        while (this.activeRuns.has(runId)) await new Promise((resolve) => setTimeout(resolve, 10));
      })
    );
  }

  /** Lets short-lived system jobs share the same runtime concurrency budget as chat runs. */
  async withRuntimeSlot<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireExternalRuntimeSlot();
    try {
      return await operation();
    } finally {
      if (!this.handoffRuntimeSlot(true)) this.externalRuntimeSlots -= 1;
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.stopping) return;
    while (this.activeRuns.size + this.externalRuntimeSlots < this.config.maxConcurrency) {
      const index = this.queue.findIndex((runId) => {
        const run = this.store.getRun(runId);
        return Boolean(run && !this.activeConversations.has(run.conversationId));
      });
      if (index < 0) return;
      const [runId] = this.queue.splice(index, 1);
      if (!runId) return;
      const run = this.store.getRun(runId);
      if (!run) continue;
      const controller = new AbortController();
      const inputQueue = this.inputQueues.get(run.id) ?? new RuntimeInputQueue();
      this.inputQueues.set(run.id, inputQueue);
      this.activeRuns.set(run.id, { run, controller });
      this.activeConversations.add(run.conversationId);
      void this.processRun(run, controller, inputQueue).finally(() => {
        inputQueue.close();
        this.inputQueues.delete(run.id);
        this.activeRuns.delete(run.id);
        this.activeConversations.delete(run.conversationId);
        this.handoffRuntimeSlot();
        void this.drain();
      });
    }
  }

  pendingQuestion(runId: string | null | undefined): AskUserQuestionDto | null {
    if (!runId) return null;
    return this.pendingQuestions.get(runId)?.question ?? null;
  }

  answerQuestion(runId: string, answers: Record<string, string>): boolean {
    const pending = this.pendingQuestions.get(runId);
    if (!pending) return false;
    this.pendingQuestions.delete(runId);
    this.events.append({
      type: "user.answered",
      conversationId: this.store.getRun(runId)?.conversationId ?? "",
      branchId: this.store.getRun(runId)?.branchId ?? null,
      runId,
      payload: { answers }
    });
    pending.resolve(answers);
    return true;
  }

  private rejectPendingQuestion(runId: string): void {
    const pending = this.pendingQuestions.get(runId);
    if (!pending) return;
    this.pendingQuestions.delete(runId);
    pending.reject(Object.assign(new Error("Interrupted"), { name: "AbortError" }));
  }

  private async processRun(run: RunRecord, controller: AbortController, inputQueue: RuntimeInputQueue): Promise<void> {
    let timeout = setTimeout(() => controller.abort(), this.config.runTimeoutMs);
    const workspacePath = path.join(this.config.workspaceRoot, run.conversationId);
    try {
      if (this.store.getRun(run.id)?.supersededAt) {
        this.store.setRunStatus(run.id, "interrupted", "Run was superseded by an edited branch");
        this.store.setMessageStatus(run.assistantMessageId, "interrupted");
        this.events.append({
          type: "run.interrupted",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { status: "interrupted", reason: "superseded_by_branch" }
        });
        return;
      }
      await fs.mkdir(workspacePath, { recursive: true });
      this.store.prepareQueuedRunForStart(run.id);
      const userMessage = this.store.getMessage(run.userMessageId);
      const branch = this.store.getBranchRuntime(run.branchId);
      const conversation = this.store.getConversation(run.conversationId);
      if (!userMessage || !branch || !conversation) throw new Error("Run input is missing");
      const inputFiles = this.services?.inputFiles
        ? await this.services.inputFiles.buildForMessage(run.conversationId, run.userMessageId)
        : { items: [], errors: [] };
      if (inputFiles.errors.length > 0) {
        throw new Error(
          inputFiles.errors.map((item) => `${item.fileName ?? item.attachmentId ?? "附件"}：${item.message}`).join("；")
        );
      }
      const attachments =
        inputFiles.items.length > 0
          ? inputFiles.items.flatMap((item) => {
              const attachment = this.store.getStoredAttachment(item.attachmentId);
              return attachment ? [attachment] : [];
            })
          : this.store.getAttachments(userMessage.attachments.map((item) => item.id));
      const prompt = branch.sdkSessionId ? userMessage.content : this.withVisibleHistory(run, userMessage.content);

      this.store.setRunStatus(run.id, "running");
      this.store.setMessageStatus(run.assistantMessageId, "streaming");
      this.events.append({
        type: "run.started",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { status: "running", runtime: this.runtime.kind }
      });

      let totalCostUsd: number | undefined;
      for await (const event of this.runtime.run({
        runId: run.id,
        conversationId: run.conversationId,
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId,
        conversationTitle: conversation.title,
        memoryEnabled: !conversation.temporary,
        profileId: isAgentProfileId(conversation.profileId) ? conversation.profileId : LEGACY_PROFILE_ID,
        prompt,
        workspacePath,
        attachments,
        inputFiles: inputFiles.items,
        branch: {
          sdkSessionId: branch.sdkSessionId,
          resumeSessionAt: branch.resumeSessionAt
        },
        supplements: inputQueue,
        abortController: controller,
        locale: readUiLocale(this.store),
        ...replayRuntimeFields(this.services?.replay, run.conversationId),
        askUser: async (question) => {
          clearTimeout(timeout);
          this.events.append({
            type: "user.question",
            conversationId: run.conversationId,
            branchId: run.branchId,
            runId: run.id,
            payload: { questions: question.questions }
          });
          try {
            return await new Promise<Record<string, string>>((resolve, reject) => {
              const onAbort = () => {
                this.pendingQuestions.delete(run.id);
                reject(Object.assign(new Error("Interrupted"), { name: "AbortError" }));
              };
              if (controller.signal.aborted) {
                onAbort();
                return;
              }
              controller.signal.addEventListener("abort", onAbort, { once: true });
              this.pendingQuestions.set(run.id, {
                question,
                resolve: (answers) => {
                  controller.signal.removeEventListener("abort", onAbort);
                  resolve(answers);
                },
                reject
              });
            });
          } finally {
            this.pendingQuestions.delete(run.id);
            timeout = setTimeout(() => controller.abort(), this.config.runTimeoutMs);
          }
        }
      })) {
        if (controller.signal.aborted) throw Object.assign(new Error("Interrupted"), { name: "AbortError" });
        const cost = this.applyRuntimeEvent(run, event);
        if (cost !== undefined) totalCostUsd = cost;
      }

      const assistant = this.store.getMessage(run.assistantMessageId);
      if (assistant && !assistant.content) this.store.replaceMessageText(run.assistantMessageId, "（未生成内容）");
      const frozenInputFiles = await this.verifiedInputFilesForRun(run, inputFiles.items);
      this.store.assistantBlocks.completeOpenTextBlocks(run.assistantMessageId, "completed");
      this.store.assistantBlocks.completeOpenActivities(run.assistantMessageId, "completed");
      this.store.setMessageStatus(run.assistantMessageId, "completed");
      this.store.setRunStatus(run.id, "completed", undefined, totalCostUsd);
      this.freezeRun(
        run,
        workspacePath,
        this.frozenPromptForRun(run, userMessage.content),
        conversation.profileId,
        frozenInputFiles
      );
      this.captureDomainCard(conversation.profileId);
      this.events.append({
        type: "message.completed",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { messageId: run.assistantMessageId, status: "completed" }
      });
      this.events.append({
        type: "run.completed",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { status: "completed", totalCostUsd: totalCostUsd ?? null }
      });
      this.memoryCoordinator?.enqueue(run);
    } catch (error) {
      this.rejectPendingQuestion(run.id);
      const interrupted = controller.signal.aborted || isAbortError(error);
      if (interrupted) {
        this.store.assistantBlocks.completeOpenTextBlocks(run.assistantMessageId, "interrupted");
        this.store.assistantBlocks.completeOpenActivities(run.assistantMessageId, "interrupted");
        this.store.setRunStatus(run.id, "interrupted");
        this.store.setMessageStatus(run.assistantMessageId, "interrupted");
        this.events.append({
          type: "run.interrupted",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { status: "interrupted", reason: "user_or_timeout" }
        });
      } else {
        const message = safeError(error);
        this.store.assistantBlocks.completeOpenTextBlocks(run.assistantMessageId, "failed");
        this.store.assistantBlocks.completeOpenActivities(run.assistantMessageId, "failed");
        this.store.setRunStatus(run.id, "failed", message);
        this.store.setMessageStatus(run.assistantMessageId, "failed");
        this.events.append({
          type: "run.failed",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { status: "failed", error: message }
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private currentRun(conversationId: string): RunRecord | null {
    for (const active of this.activeRuns.values()) {
      if (active.run.conversationId === conversationId) return active.run;
    }
    const queuedId = this.queue.find((runId) => this.store.getRun(runId)?.conversationId === conversationId);
    return queuedId ? this.store.getRun(queuedId) : null;
  }

  private applyRuntimeEvent(run: RunRecord, event: RuntimeEvent): number | undefined {
    if (event.type === "status") {
      this.events.append({
        type: "run.status",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { status: "running", message: event.message }
      });
    } else if (event.type === "text.delta") {
      this.store.appendMessageText(run.assistantMessageId, event.delta);
      const block = this.store.assistantBlocks.appendText({
        runId: run.id,
        messageId: run.assistantMessageId,
        streamId: event.messageUuid ?? `${run.id}:main`,
        delta: event.delta
      });
      this.events.append({
        type: "message.text.delta",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { messageId: run.assistantMessageId, blockId: block.id, delta: event.delta }
      });
    } else if (event.type === "reasoning.summary.delta") {
      this.store.appendReasoningSummary(run.assistantMessageId, event.delta);
      const block = this.store.assistantBlocks.appendThinking({
        runId: run.id,
        messageId: run.assistantMessageId,
        streamId: `${run.id}:thinking`,
        delta: event.delta
      });
      this.events.append({
        type: "reasoning.summary.delta",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { messageId: run.assistantMessageId, blockId: block.id, delta: event.delta }
      });
    } else if (event.type === "activity.started") {
      const parentBlockId = event.parentActivityId
        ? (this.store.assistantBlocks.findByExternalId(run.id, event.parentActivityId)?.id ?? null)
        : null;
      const block = this.store.assistantBlocks.startActivity({
        runId: run.id,
        messageId: run.assistantMessageId,
        externalId: event.activityId,
        parentBlockId,
        owner: event.parentActivityId ? "subagent" : "main",
        kind: event.activityKind,
        displayName: event.displayName,
        technicalName: event.technicalName,
        inputSummary: event.inputSummary ?? null
      });
      this.events.append({
        type: "activity.started",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { messageId: run.assistantMessageId, block }
      });
    } else if (event.type === "activity.text.delta") {
      const block = this.store.assistantBlocks.appendActivityText(run.id, event.activityId, event.delta);
      if (block) {
        this.events.append({
          type: "activity.text.delta",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, blockId: block.id, delta: event.delta }
        });
      }
    } else if (event.type === "activity.updated") {
      const block = persistActivityUpdate(this.store.assistantBlocks, run.id, event.activityId, event);
      if (block) {
        this.events.append({
          type: "activity.updated",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, block }
        });
      }
    } else if (event.type === "activity.completed") {
      const block = this.store.assistantBlocks.completeActivity(
        run.id,
        event.activityId,
        "completed",
        event.outputSummary
      );
      if (block) {
        this.events.append({
          type: "activity.completed",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, block }
        });
      }
    } else if (event.type === "activity.failed") {
      const block = this.store.assistantBlocks.completeActivity(
        run.id,
        event.activityId,
        event.interrupted ? "interrupted" : "failed",
        event.error
      );
      if (block) {
        this.events.append({
          type: "activity.failed",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, block }
        });
      }
    } else if (event.type === "tool.started") {
      const tool = this.store.upsertToolEvent({
        runId: run.id,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        status: "running",
        inputSummary: event.inputSummary
      });
      const block = this.store.assistantBlocks.startActivity({
        runId: run.id,
        messageId: run.assistantMessageId,
        externalId: event.toolUseId,
        kind: event.activityKind,
        displayName: event.displayName,
        technicalName: event.toolName,
        inputSummary: event.inputSummary
      });
      this.events.append({
        type: "activity.started",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { messageId: run.assistantMessageId, block }
      });
      this.events.append({
        type: "tool.started",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: tool as unknown as Record<string, unknown>
      });
    } else if (event.type === "tool.updated") {
      if (event.inputSummary) {
        this.store.upsertToolEvent({
          runId: run.id,
          toolUseId: event.toolUseId,
          toolName: "Tool",
          status: "running",
          inputSummary: event.inputSummary
        });
      }
      const block = persistActivityUpdate(this.store.assistantBlocks, run.id, event.toolUseId, event);
      if (block) {
        this.events.append({
          type: "activity.updated",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, block }
        });
      }
      this.events.append({
        type: "tool.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { toolUseId: event.toolUseId, message: event.message, inputSummary: event.inputSummary }
      });
    } else if (event.type === "tool.completed") {
      const tool = this.store.upsertToolEvent({
        runId: run.id,
        toolUseId: event.toolUseId,
        toolName: "Tool",
        status: "completed",
        outputSummary: event.outputSummary
      });
      const block = this.store.assistantBlocks.completeActivity(
        run.id,
        event.toolUseId,
        "completed",
        event.outputSummary
      );
      if (block) {
        this.events.append({
          type: "activity.completed",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, block }
        });
      }
      this.events.append({
        type: "tool.completed",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: tool as unknown as Record<string, unknown>
      });
    } else if (event.type === "tool.failed") {
      const tool = this.store.upsertToolEvent({
        runId: run.id,
        toolUseId: event.toolUseId,
        toolName: "Tool",
        status: "failed",
        outputSummary: event.error
      });
      const block = this.store.assistantBlocks.completeActivity(run.id, event.toolUseId, "failed", event.error);
      if (block) {
        this.events.append({
          type: "activity.failed",
          conversationId: run.conversationId,
          branchId: run.branchId,
          runId: run.id,
          payload: { messageId: run.assistantMessageId, block }
        });
      }
      this.events.append({
        type: "tool.failed",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: tool as unknown as Record<string, unknown>
      });
    } else if (event.type === "user.uuid") {
      this.store.setMessageSdkUuid(run.userMessageId, event.uuid);
    } else if (event.type === "assistant.uuid") {
      this.store.setMessageSdkUuid(run.assistantMessageId, event.uuid);
    } else if (event.type === "session") {
      this.store.updateBranchSession(run.branchId, event.sessionId);
    } else if (event.type === "memory.recalled") {
      this.events.append({
        type: "memory.recalled",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { references: event.references }
      });
    } else if (event.type === "memory.changed") {
      this.events.append({
        type: "memory.changed",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: {
          operation: event.operation,
          message: event.message,
          mutationId: event.mutationId,
          undoExpiresAt: event.undoExpiresAt
        }
      });
    } else if (event.type === "learning.session.updated") {
      this.events.append({
        type: "learning.session.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { session: event.session }
      });
    } else if (event.type === "learning.incident.updated") {
      this.events.append({
        type: "learning.incident.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { incident: event.incident }
      });
    } else if (event.type === "learning.policy.updated") {
      this.events.append({
        type: "learning.policy.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { policy: event.policy }
      });
    } else if (event.type === "collaboration.task.updated") {
      this.events.append({
        type: "collaboration.task.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { task: event.task }
      });
    } else if (event.type === "collaboration.handoff.updated") {
      this.events.append({
        type: "collaboration.handoff.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { handoff: event.handoff }
      });
    } else if (event.type === "file.created") {
      const attachment = this.store.attachGeneratedFile({
        conversationId: run.conversationId,
        messageId: run.assistantMessageId,
        fileName: event.fileName,
        mimeType: event.mimeType,
        size: event.size,
        sha256: event.sha256,
        relativePath: event.relativePath,
        presented: event.presented === true
      });
      if (event.presented === true) this.putOnShelf(run, attachment);
      this.events.append({
        type: "attachment.updated",
        conversationId: run.conversationId,
        branchId: run.branchId,
        runId: run.id,
        payload: { messageId: run.assistantMessageId, attachment }
      });
    } else if (event.type === "completed") {
      return event.totalCostUsd;
    }
    return undefined;
  }

  restoreWorkspaceFromRun(runId: string, conversationId: string): boolean {
    const target = path.join(this.config.workspaceRoot, conversationId);
    return this.services?.replay?.restoreInto(runId, target) === true;
  }

  private freezeRun(
    run: RunRecord,
    workspacePath: string,
    prompt: string,
    profileId: string,
    inputFiles: InputFileManifestItem[]
  ): void {
    const baseOverlay = this.services?.evolution?.overlayForRun(run.id);
    const session = this.services?.learning?.getSessionForConversation(run.conversationId) ?? null;
    const replayLearning = this.services?.replay?.markForConversation(run.conversationId)?.overlay.learning ?? null;
    const learning = session
      ? {
          ...session,
          incidents: (this.services?.learning?.listIncidents(session.id) ?? []).map((incident) => ({
            ...incident,
            interventions: this.services?.learning?.listInterventions(incident.id) ?? [],
            verifications: this.services?.learning?.listVerifications(incident.id) ?? []
          })),
          policyContext:
            session.datasetKind === "replay"
              ? (replayLearning?.policyContext ?? [])
              : session.datasetKind === "eval"
                ? // Eval runs pin the default strategy order, so there is no policy to freeze.
                  []
                : (this.services?.learning?.listPolicies({
                    profileId: session.profileId,
                    topicKey: session.topicKey,
                    datasetKind: session.datasetKind,
                    includeDisabled: true
                  }) ?? [])
        }
      : null;
    const overlay = {
      ...(baseOverlay ?? {
        id: "",
        playbookIds: [],
        artifactIds: [],
        cardTitle: null,
        playbooks: [],
        card: null,
        memories: [],
        artifacts: []
      }),
      inputFiles,
      learning
    };
    this.services?.replay?.freeze({
      runId: run.id,
      conversationId: run.conversationId,
      profileId,
      prompt,
      overlay,
      workspacePath
    });
  }

  private async verifiedInputFilesForRun(
    run: RunRecord,
    fallback: InputFileManifestItem[]
  ): Promise<InputFileManifestItem[]> {
    const service = this.services?.inputFiles;
    if (!service) return fallback;
    const userMessages = this.store.getMessagesForRun(run.id).filter((message) => message.role === "user");
    const results = await Promise.all(
      userMessages.map((message) =>
        service.buildForMessage(
          run.conversationId,
          message.id,
          message.id === run.userMessageId ? "current_message" : "history"
        )
      )
    );
    const errors = results.flatMap((result) => result.errors);
    if (errors.length > 0) {
      throw new Error(
        errors.map((item) => `${item.fileName ?? item.attachmentId ?? "附件"}：${item.message}`).join("；")
      );
    }
    const files = results.flatMap((result) => result.items);
    return files.filter(
      (file, index) => files.findIndex((candidate) => candidate.attachmentId === file.attachmentId) === index
    );
  }

  private frozenPromptForRun(run: RunRecord, fallback: string): string {
    const prompts = this.store
      .getMessagesForRun(run.id)
      .filter((message) => message.role === "user" && message.content.trim())
      .map((message) => message.content.trim());
    if (prompts.length === 0) return fallback;
    return prompts.map((prompt, index) => (index === 0 ? prompt : `补充信息：${prompt}`)).join("\n\n");
  }

  private captureDomainCard(profileId: string): void {
    if (!this.services?.liveCard) return;
    this.services.liveCard.capture(
      profileId,
      this.services.memories?.stableContext(profileId) ?? [],
      this.services.admissions
    );
  }

  private putOnShelf(run: RunRecord, attachment: StoredAttachment): void {
    const conversation = this.store.getConversation(run.conversationId);
    this.services?.shelf?.put({
      profileId: conversation?.profileId ?? "graduate-admissions",
      conversationId: run.conversationId,
      attachmentId: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      relativePath: attachment.relativePath,
      sourceWorkspace: path.join(this.config.workspaceRoot, run.conversationId)
    });
  }

  private recoverInterruptedRuns(): void {
    const rows = this.store.database
      .prepare(
        "SELECT id, conversation_id, branch_id, assistant_message_id FROM runs WHERE status IN ('running','interrupting')"
      )
      .all() as Array<{ id: string; conversation_id: string; branch_id: string; assistant_message_id: string }>;
    this.store.database.transaction(() => {
      for (const row of rows) {
        this.services?.collaboration?.interruptRun(row.id, "Server restarted during the specialist run");
        this.store.setRunStatus(row.id, "interrupted", "Server restarted during the run");
        this.store.setMessageStatus(row.assistant_message_id, "interrupted");
        this.store.assistantBlocks.completeOpenTextBlocks(row.assistant_message_id, "interrupted");
        this.store.assistantBlocks.completeOpenActivities(row.assistant_message_id, "interrupted");
        this.events.append({
          type: "run.interrupted",
          conversationId: row.conversation_id,
          branchId: row.branch_id,
          runId: row.id,
          payload: { status: "interrupted", reason: "server_restarted" }
        });
      }
    })();
    const queued = this.store.database
      .prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at ASC")
      .all() as Array<{ id: string }>;
    for (const row of queued) {
      this.queue.push(row.id);
      this.inputQueues.set(row.id, new RuntimeInputQueue());
    }
    if (queued.length > 0) void this.drain();
  }

  private async acquireExternalRuntimeSlot(): Promise<void> {
    if (this.stopping) throw new Error("Server is stopping");
    if (this.activeRuns.size + this.externalRuntimeSlots < this.config.maxConcurrency) {
      this.externalRuntimeSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => this.externalSlotWaiters.push(resolve));
    if (this.stopping) throw new Error("Server is stopping");
  }

  /** Transfer a freed slot to a waiting system job without exceeding the global cap. */
  private handoffRuntimeSlot(slotAlreadyHeld = false): boolean {
    const waiter = this.externalSlotWaiters.shift();
    if (!waiter) return false;
    if (!slotAlreadyHeld) this.externalRuntimeSlots += 1;
    waiter();
    return true;
  }

  private withVisibleHistory(run: RunRecord, prompt: string): string {
    const conversation = this.store.getConversation(run.conversationId);
    if (!conversation) return prompt;
    const history = conversation.messages
      .filter((message) => message.runId !== run.id && message.role !== "system" && message.content.trim())
      .slice(-20)
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.slice(0, 4_000)}`)
      .join("\n\n");
    return history
      ? `Continue from this application-visible conversation context:\n\n${history}\n\nNew user message:\n${prompt}`
      : prompt;
  }
}

function replayRuntimeFields(replay: RunReplayStore | undefined, conversationId: string) {
  const mark = replay?.markForConversation(conversationId);
  if (!mark) return {};
  const artifactIds = [...mark.overlay.artifactIds];
  if (mark.includeArtifactId && !artifactIds.includes(mark.includeArtifactId)) {
    artifactIds.push(mark.includeArtifactId);
  }
  return {
    pinnedOverlay: { ...mark.overlay, artifactIds },
    previewArtifactIds: mark.includeArtifactId ? [mark.includeArtifactId] : [],
    replayMark: mark
  };
}

function persistActivityUpdate(
  blocks: AgentStore["assistantBlocks"],
  runId: string,
  externalId: string,
  event: { message?: string; inputSummary?: string }
) {
  const withInput = event.inputSummary ? blocks.updateActivityInput(runId, externalId, event.inputSummary) : null;
  if (event.message) return blocks.updateActivity(runId, externalId, event.message) ?? withInput;
  return withInput;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /interrupt|aborted/i.test(error.message));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 2_000);
}
