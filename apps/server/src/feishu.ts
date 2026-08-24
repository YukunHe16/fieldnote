import { createHash } from "node:crypto";
import type { AgentRunEvent, AskUserQuestionDto, ChannelAdapter } from "@fieldnote/contracts";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuRuntimeConfig } from "./config.js";
import type { EventStore } from "./event-store.js";
import type { RunOrchestrator } from "./orchestrator.js";
import fs from "node:fs";
import path from "node:path";
import type { AgentStore, RunRecord, StoredAttachment } from "./store.js";
import { DEFAULT_PROFILE_ID, getAgentProfile, isAgentProfileId, type AgentProfileId } from "./agent-profiles.js";
import type { EvolutionCoordinator } from "./evolution-coordinator.js";
import type { EvolvedArtifactDto, EvolutionReviewVerdict, FeishuSenderCandidateDto } from "@fieldnote/contracts";
import { readUiLocale, type UiLocale } from "./locale.js";
import type { CollaborationStore } from "./collaboration-store.js";
import { LearningConflictError, type LearningStore, type LearningSessionDto } from "./learning-store.js";
import { LEARNING_TRY_ANOTHER_PROMPT, confirmLearningVerification } from "./learning-confirm.js";
import type { AgentRuntime } from "./runtime.js";
import { chineseStrategy } from "./learning-coordinator.js";
import type { LearningHandoffReportDto } from "@fieldnote/contracts";
import { MAX_INPUT_FILE_BYTES } from "./input-file-manifest.js";
import {
  askUserAnswersFromCard,
  buildFeishuAskUserAnsweredCard,
  buildFeishuAskUserCard,
  feishuConversationWebButton,
  feishuReplyOptions,
  feishuRoomKey,
  inboundFilesFromMessage,
  normalizeInboundMessage,
  sanitizeInboundFileName,
  type FeishuInboundFile
} from "./feishu-room.js";

type NormalizedFeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  rootId?: string;
  threadId?: string;
  mentionedBot?: boolean;
  messageType?: string;
  files?: Array<Record<string, unknown>>;
  images?: Array<Record<string, unknown>>;
  raw?: unknown;
};

class InboundFileTooLargeError extends Error {}

function boundedInboundBuffer(buffer: Buffer): Buffer {
  if (buffer.length > MAX_INPUT_FILE_BYTES) throw new InboundFileTooLargeError();
  return buffer;
}

type FeishuCardActionEvent = {
  messageId: string;
  chatId: string;
  operator: { openId: string };
  action: { value: unknown };
};

type FeishuCardActionValue = {
  action:
    | "stop"
    | "retry"
    | "new"
    | "profile"
    | "evolution_approve"
    | "evolution_reject"
    | "evolution_disable"
    | "evolution_keep"
    | "ask_answer"
    | "learning_confirm";
  conversationId?: string;
  runId?: string;
  assistantMessageId?: string;
  profileId?: AgentProfileId;
  artifactId?: string;
  answer?: string;
  verificationId?: string;
  verdict?: "resolved" | "partial" | "unresolved";
};

type FeishuBindingMetadata = {
  externalKey?: string;
  chatId: string;
  messageId?: string;
  group?: boolean;
  rootId?: string | null;
  threadId?: string | null;
};

type FeishuInboundFileResult = {
  attachmentIds: string[];
  failures: string[];
};

type FeishuCardReference = { chatId: string; messageId: string };

type FeishuSenderCandidate = {
  openId: string;
  chatType: "p2p" | "group";
  authorized: boolean;
  lastSeenAt: number;
};

/** Local-settings keys this channel owns. */
const FEISHU_CANDIDATES_SETTING = "feishu.candidates";
const FEISHU_EVOLUTION_CARDS_SETTING = "feishu.evolutionCards";
const MAX_FEISHU_SENDER_CANDIDATES = 10;
const MAX_FEISHU_EVOLUTION_CARDS = 50;

/**
 * The single line an unrecognised sender gets when a non-empty allowlist rejects them.
 * It never starts a run, registers a binding, or hints at what the bot can do.
 */
const UNAUTHORIZED_NOTICE: Readonly<Record<UiLocale, string>> = {
  zh: "此机器人为私人助手。",
  en: "This bot is a private assistant."
};

function toCardReference(value: unknown): FeishuCardReference | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const chatId = typeof raw.chatId === "string" ? raw.chatId : "";
  const messageId = typeof raw.messageId === "string" ? raw.messageId : "";
  return chatId && messageId ? { chatId, messageId } : null;
}

/**
 * Approval cards used to live in a bare Map, so a restart orphaned every pending card: the
 * artifact could still be approved but its card never updated. The index keeps the same
 * get/set semantics and mirrors itself into local settings, newest last, capped so a long-lived
 * install cannot grow the row without bound.
 */
class FeishuEvolutionCardIndex {
  private readonly entries = new Map<string, FeishuCardReference>();

  constructor(
    private readonly read: () => unknown,
    private readonly write: (value: Record<string, FeishuCardReference>) => void
  ) {
    const stored = this.read();
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [artifactId, value] of Object.entries(stored as Record<string, unknown>)) {
        const reference = toCardReference(value);
        if (reference) this.entries.set(artifactId, reference);
      }
    }
    this.trim();
  }

  get(artifactId: string): FeishuCardReference | undefined {
    return this.entries.get(artifactId);
  }

  set(artifactId: string, reference: FeishuCardReference): void {
    this.entries.delete(artifactId);
    this.entries.set(artifactId, reference);
    this.trim();
    this.write(Object.fromEntries(this.entries));
  }

  private trim(): void {
    while (this.entries.size > MAX_FEISHU_EVOLUTION_CARDS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

function toSenderCandidate(value: unknown): FeishuSenderCandidate | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const openId = typeof raw.openId === "string" ? raw.openId : "";
  if (!openId) return null;
  const lastSeenAt = Number(raw.lastSeenAt);
  return {
    openId,
    chatType: raw.chatType === "group" ? "group" : "p2p",
    authorized: raw.authorized === true,
    lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : 0
  };
}

export class FeishuChannel implements ChannelAdapter {
  readonly kind = "feishu" as const;
  private channel: any;
  private connected = false;
  private lastError: string | null = null;
  private reactionWarningShown = false;
  private readonly evolutionCards: FeishuEvolutionCardIndex;
  private readonly streamingRuns = new Set<string>();
  /** One refusal per open_id per process; a rejected sender is not worth repeating to. */
  private readonly notifiedUnauthorized = new Set<string>();
  /** One handoff card per escalated incident; both escalation paths emit the same event. */
  private readonly notifiedEscalations = new Set<string>();
  /** One outcome-confirmation card per verification, however many runs finish meanwhile. */
  private readonly notifiedLearningConfirms = new Set<string>();
  private senderCandidateList: FeishuSenderCandidate[] = [];
  // Retained for symmetric teardown in stop(); flagged as unused only because assignment is conditional.
  private unsubscribeEvents: (() => void) | undefined;

  constructor(
    private currentConfig: FeishuRuntimeConfig | undefined,
    private readonly store: AgentStore,
    private readonly events: EventStore,
    private readonly orchestrator: RunOrchestrator,
    private readonly webAppUrl = "http://127.0.0.1:5173",
    private readonly workspaceRoot = "",
    private evolution?: EvolutionCoordinator,
    private readonly collaboration?: CollaborationStore,
    private readonly learning?: LearningStore,
    /** Needed only for teaching-approach distillation on card-confirmed resolutions. */
    private readonly runtime?: AgentRuntime
  ) {
    this.evolutionCards = new FeishuEvolutionCardIndex(
      () => this.readSetting(FEISHU_EVOLUTION_CARDS_SETTING),
      (value) => this.writeSetting(FEISHU_EVOLUTION_CARDS_SETTING, value)
    );
    const storedCandidates = this.readSetting(FEISHU_CANDIDATES_SETTING);
    this.senderCandidateList = (Array.isArray(storedCandidates) ? storedCandidates : [])
      .map(toSenderCandidate)
      .filter((item): item is FeishuSenderCandidate => item !== null)
      .slice(0, MAX_FEISHU_SENDER_CANDIDATES);
    if (typeof this.events?.subscribeAll === "function") {
      this.unsubscribeEvents = this.events.subscribeAll((event) => {
        if (event.type === "run.completed" && event.runId) {
          void this.mirrorCompletedRun(event.conversationId, event.runId);
        }
        if (event.type === "learning.incident.updated") {
          const incident = (event.payload as Record<string, unknown> | undefined)?.incident as
            | Record<string, unknown>
            | undefined;
          if (incident && incident.status === "escalated" && typeof incident.id === "string") {
            void this.notifyLearningEscalation(incident.id);
          }
        }
      });
    }
  }

  /**
   * Escalation is the loop admitting it needs a human: DM the owner a structured handoff
   * card, the same owner-lookup route the evolution approval card takes. Synthetic sessions
   * (demo/eval/replay) never page anyone.
   */
  private async notifyLearningEscalation(incidentId: string): Promise<void> {
    if (!this.channel || !this.learning || this.notifiedEscalations.has(incidentId)) return;
    try {
      const session = this.learning.getSessionForIncident(incidentId);
      if (!session || session.datasetKind !== "live") return;
      const report = this.learning.handoffReport(incidentId);
      if (!report) return;
      const binding = this.store.database
        .prepare(
          `SELECT metadata_json FROM channel_bindings
         WHERE channel = 'feishu' AND external_key LIKE 'p2p:%'
         ORDER BY updated_at DESC LIMIT 1`
        )
        .get() as { metadata_json: string } | undefined;
      if (!binding) return;
      this.notifiedEscalations.add(incidentId);
      const metadata = JSON.parse(binding.metadata_json) as FeishuBindingMetadata;
      await this.channel.send(metadata.chatId, {
        card: buildFeishuLearningHandoffCard(report, session.goal, this.webAppUrl)
      });
    } catch (error) {
      console.error("[feishu] learning handoff card failed", safeMessage(error));
    }
  }

  attachEvolution(evolution: EvolutionCoordinator): void {
    this.evolution = evolution;
  }

  async start(): Promise<void> {
    if (!this.currentConfig || this.channel) return;
    const createLarkChannel = (Lark as unknown as { createLarkChannel?: (options: unknown) => any }).createLarkChannel;
    if (!createLarkChannel) throw new Error("Installed @larksuiteoapi/node-sdk does not expose createLarkChannel");
    this.channel = createLarkChannel({
      appId: this.currentConfig.appId,
      appSecret: this.currentConfig.appSecret,
      domain: (Lark as any).Domain?.Feishu,
      loggerLevel: (Lark as any).LoggerLevel?.info,
      policy: { requireMention: true, dmMode: "open", respondToMentionAll: false },
      safety: { dedupWindowMs: 60 * 60_000, staleThresholdMs: 10 * 60_000 },
      includeRawInMessage: true
    });
    this.channel.on("message", (message: NormalizedFeishuMessage) => {
      this.acceptInbound(normalizeInboundMessage(message));
    });
    this.channel.on("cardAction", (event: FeishuCardActionEvent) => {
      this.acceptCardAction(event);
    });
    this.channel.on("error", (error: unknown) => {
      this.lastError = safeMessage(error);
      console.error("[feishu] inbound channel error", safeMessage(error));
    });
    this.channel.on("reconnecting", () => {
      this.connected = false;
    });
    this.channel.on("reconnected", () => {
      this.connected = true;
    });
    await this.channel.connect();
    this.connected = true;
    this.lastError = null;
  }

  async stop(): Promise<void> {
    if (this.channel) await this.channel.disconnect();
    this.channel = undefined;
    this.connected = false;
  }

  async configure(next: FeishuRuntimeConfig): Promise<void> {
    const previous = this.currentConfig;
    await this.stop();
    this.currentConfig = next;
    this.lastError = null;
    try {
      await this.start();
    } catch (error) {
      this.lastError = safeMessage(error);
      await this.stop().catch(() => undefined);
      this.currentConfig = previous;
      if (previous)
        await this.start().catch((restoreError) => {
          this.lastError = safeMessage(restoreError);
        });
      throw error;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.currentConfig?.appId && this.currentConfig.appSecret);
  }

  status(): {
    configured: boolean;
    connected: boolean;
    appId: string;
    hasSecret: boolean;
    allowedOpenIds: string[];
    error: string | null;
  } {
    return {
      configured: this.isConfigured(),
      connected: this.connected,
      appId: this.currentConfig?.appId ?? "",
      hasSecret: Boolean(this.currentConfig?.appSecret),
      allowedOpenIds: [...(this.currentConfig?.allowedOpenIds ?? [])],
      error: this.lastError
    };
  }

  async send(conversationId: string, content: string): Promise<void> {
    const metadata = this.bindingForConversation(conversationId);
    if (!metadata || !this.channel) return;
    await this.channel.send(metadata.chatId, { markdown: content }, this.replyTarget(metadata));
  }

  async stream(_conversationId: string, _events: AsyncIterable<AgentRunEvent>): Promise<void> {
    // Feishu streams are attached to the originating message in streamReply().
  }

  async notifyEvolution(input: {
    artifact: EvolvedArtifactDto;
    verdict: EvolutionReviewVerdict;
    reason: string;
    enabled: boolean;
    replayRunId?: string | null;
  }): Promise<boolean> {
    if (!this.channel) return false;
    const binding = this.store.database
      .prepare(
        `SELECT metadata_json FROM channel_bindings
       WHERE channel = 'feishu' AND external_key LIKE 'p2p:%'
       ORDER BY updated_at DESC LIMIT 1`
      )
      .get() as { metadata_json: string } | undefined;
    if (!binding) return false;
    const metadata = JSON.parse(binding.metadata_json) as FeishuBindingMetadata;
    const card = buildFeishuEvolutionCard({ ...input, webAppUrl: this.webAppUrl });
    if (input.verdict === "needs_human") {
      const result = await this.channel.send(metadata.chatId, { card });
      const messageId = String(result?.messageId ?? result?.message_id ?? "");
      if (messageId) this.evolutionCards.set(input.artifact.id, { chatId: metadata.chatId, messageId });
      return true;
    }
    const existing = this.evolutionCards.get(input.artifact.id);
    if (existing && this.channel.updateCard) {
      await this.channel.updateCard(existing.messageId, card);
    }
    return true;
  }

  async notifyUsageSuggestion(input: {
    artifact: EvolvedArtifactDto;
    uses: number;
    retriedRuns: number;
    reason: string;
  }): Promise<boolean> {
    if (!this.channel) return false;
    const binding = this.store.database
      .prepare(
        `SELECT metadata_json FROM channel_bindings
       WHERE channel = 'feishu' AND external_key LIKE 'p2p:%'
       ORDER BY updated_at DESC LIMIT 1`
      )
      .get() as { metadata_json: string } | undefined;
    if (!binding) return false;
    const metadata = JSON.parse(binding.metadata_json) as FeishuBindingMetadata;
    await this.channel.send(metadata.chatId, {
      card: buildFeishuUsageSuggestionCard({
        artifact: input.artifact,
        uses: input.uses,
        retriedRuns: input.retriedRuns,
        reason: input.reason
      })
    });
    return true;
  }

  canNotifyEvolution(): boolean {
    if (!this.channel) return false;
    try {
      const binding = this.store.database
        .prepare(
          `SELECT 1 FROM channel_bindings
         WHERE channel = 'feishu' AND external_key LIKE 'p2p:%'
         ORDER BY updated_at DESC LIMIT 1`
        )
        .get();
      return Boolean(binding);
    } catch {
      return false;
    }
  }

  async sendScheduledReport(input: { runId: string; title: string; content: string }): Promise<string> {
    if (!this.channel) throw new Error("Feishu channel is not connected");
    const binding = this.store.database
      .prepare(
        `SELECT metadata_json FROM channel_bindings
       WHERE channel = 'feishu' AND external_key LIKE 'p2p:%'
       ORDER BY updated_at DESC LIMIT 1`
      )
      .get() as { metadata_json: string } | undefined;
    if (!binding) throw new Error("No Feishu direct-message conversation is available for scheduled delivery");
    const metadata = JSON.parse(binding.metadata_json) as FeishuBindingMetadata;
    const result = await this.channel.send(metadata.chatId, {
      card: buildFeishuScheduledReportCard(input.title, input.content, input.runId, this.webAppUrl)
    });
    return String(result?.messageId ?? result?.message_id ?? input.runId);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Recent direct-message senders, newest first, for reading your own open_id off the screen. */
  senderCandidates(): FeishuSenderCandidateDto[] {
    return this.senderCandidateList.map((item) => ({
      openId: item.openId,
      chatType: item.chatType,
      authorized: item.authorized,
      lastSeenAt: new Date(item.lastSeenAt).toISOString()
    }));
  }

  private acceptInbound(message: NormalizedFeishuMessage): void {
    if (!message.messageId || !message.chatId || !message.senderId) return;
    const allowed = this.currentConfig?.allowedOpenIds;
    // An empty allowlist stays allow-all: this is a single-user local install, and the app's
    // own availability scope is the outer gate.
    const authorized = !allowed || allowed.size === 0 || allowed.has(message.senderId);
    if (message.chatType === "p2p") this.recordSenderCandidate(message.senderId, "p2p", authorized);
    if (!authorized) {
      // Group chats stay completely silent; only a direct message earns one short refusal.
      if (message.chatType === "p2p") void this.replyUnauthorizedOnce(message);
      return;
    }
    if (message.chatType === "group" && !message.mentionedBot) return;
    const inserted = this.store.registerInboundEvent("feishu", message.messageId, {
      chatId: message.chatId,
      senderId: message.senderId,
      chatType: message.chatType
    });
    if (!inserted) return;
    void this.addReceivedReaction(message.messageId);
    setImmediate(() => {
      void this.processInbound(message).catch((error) => {
        console.error("[feishu] failed to process message", safeMessage(error));
      });
    });
  }

  private async replyUnauthorizedOnce(message: NormalizedFeishuMessage): Promise<void> {
    if (!this.channel || this.notifiedUnauthorized.has(message.senderId)) return;
    this.notifiedUnauthorized.add(message.senderId);
    try {
      await this.channel.send(
        message.chatId,
        { text: UNAUTHORIZED_NOTICE[this.uiLocale()] },
        this.replyTarget(message)
      );
    } catch (error) {
      console.warn("[feishu] unable to answer an unrecognised sender", safeMessage(error));
    }
  }

  private uiLocale(): UiLocale {
    try {
      return typeof this.store?.getSetting === "function" ? readUiLocale(this.store) : "zh";
    } catch {
      return "zh";
    }
  }

  private recordSenderCandidate(openId: string, chatType: "p2p" | "group", authorized: boolean): void {
    const next = [
      { openId, chatType, authorized, lastSeenAt: Date.now() },
      ...this.senderCandidateList.filter((item) => item.openId !== openId)
    ].slice(0, MAX_FEISHU_SENDER_CANDIDATES);
    this.senderCandidateList = next;
    this.writeSetting(FEISHU_CANDIDATES_SETTING, next);
  }

  /** Local settings are best-effort: several call sites construct this channel without a store. */
  private readSetting(key: string): unknown {
    try {
      return typeof this.store?.getSetting === "function" ? this.store.getSetting(key) : null;
    } catch {
      return null;
    }
  }

  private writeSetting(key: string, value: unknown): void {
    try {
      if (typeof this.store?.setSetting === "function") this.store.setSetting(key, value);
    } catch (error) {
      console.warn("[feishu] unable to persist local setting", key, safeMessage(error));
    }
  }

  private async addReceivedReaction(messageId: string): Promise<void> {
    if (!this.channel?.addReaction) return;
    try {
      await this.channel.addReaction(messageId, "THUMBSUP");
    } catch (error) {
      if (this.reactionWarningShown) return;
      this.reactionWarningShown = true;
      console.warn(
        "[feishu] unable to acknowledge messages with an emoji; grant im:message.reactions:write_only",
        safeMessage(error)
      );
    }
  }

  private acceptCardAction(event: FeishuCardActionEvent): void {
    const value = parseCardActionValue(event.action.value);
    if (!value || !event.messageId || !event.chatId || !event.operator.openId) return;
    const allowed = this.currentConfig?.allowedOpenIds;
    if (allowed && allowed.size > 0 && !allowed.has(event.operator.openId)) return;
    setImmediate(() => {
      void this.handleCardAction(event, value).catch((error) => {
        console.error("[feishu] card action failed", safeMessage(error));
      });
    });
  }

  private async handleCardAction(event: FeishuCardActionEvent, value: FeishuCardActionValue): Promise<void> {
    if (!this.channel) return;
    if (value.action === "ask_answer") {
      if (!value.runId || !value.answer) return;
      const pending = this.orchestrator.pendingQuestion(value.runId);
      const answers = askUserAnswersFromCard(pending, value.answer);
      if (!this.orchestrator.answerQuestion(value.runId, answers)) return;
      const prompt = pending?.questions[0]?.question ?? "请选择";
      if (this.channel.updateCard) {
        await this.channel.updateCard(event.messageId, buildFeishuAskUserAnsweredCard(prompt, value.answer));
      }
      return;
    }
    if (value.action === "evolution_approve" || value.action === "evolution_reject") {
      if (!value.artifactId || !this.evolution) return;
      const verdict = value.action === "evolution_approve" ? "pass" : "reject";
      const artifact = await this.evolution.review(
        value.artifactId,
        verdict,
        value.action === "evolution_approve" ? "飞书卡片确认启用" : "飞书卡片拒绝"
      );
      if (!artifact) return;
      this.evolutionCards.set(artifact.id, { chatId: event.chatId, messageId: event.messageId });
      if (this.channel.updateCard) {
        await this.channel.updateCard(
          event.messageId,
          buildFeishuEvolutionCard({
            artifact,
            verdict,
            reason: artifact.evaluation?.reason ?? "",
            enabled: artifact.status === "enabled",
            ...(artifact.evaluation?.replayRunId !== undefined ? { replayRunId: artifact.evaluation.replayRunId } : {}),
            webAppUrl: this.webAppUrl
          })
        );
      }
      return;
    }
    if (value.action === "evolution_disable" || value.action === "evolution_keep") {
      if (!value.artifactId || !this.evolution) return;
      const artifact =
        value.action === "evolution_disable"
          ? await this.evolution.setEnabled(value.artifactId, false)
          : this.evolution.keepArtifact(value.artifactId);
      if (!artifact || !this.channel.updateCard) return;
      await this.channel.updateCard(
        event.messageId,
        buildFeishuUsageSuggestionCard({
          artifact,
          resolved: value.action === "evolution_disable" ? "disabled" : "kept"
        })
      );
      return;
    }

    if (!value.conversationId) return;
    const conversation = this.store.getConversation(value.conversationId);
    if (!conversation || conversation.channel !== "feishu") return;
    const metadata = this.bindingForConversation(value.conversationId);
    if (!metadata || metadata.chatId !== event.chatId) return;

    if (value.action === "new") {
      await this.orchestrator.interruptConversationAndWait(value.conversationId);
      const { externalKey, ...nextMetadata } = metadata;
      if (!externalKey) return;
      const created = this.store.createConversation("feishu", metadata.group === true ? "飞书群聊" : "飞书单聊", {
        profileId: conversation.profileId
      });
      this.store.setChannelBinding("feishu", externalKey, created.id, nextMetadata);
      await this.channel.send(
        event.chatId,
        { text: "新对话已创建" },
        this.replyTarget({
          messageId: event.messageId,
          ...(metadata.rootId !== undefined ? { rootId: metadata.rootId } : {}),
          ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {})
        })
      );
      return;
    }

    if (value.action === "profile") {
      const profileId = value.profileId;
      if (!profileId || !isAgentProfileId(profileId)) {
        await this.channel.send(
          event.chatId,
          { card: buildFeishuProfilePickerCard(value.conversationId) },
          this.replyTarget({
            messageId: event.messageId,
            ...(metadata.rootId !== undefined ? { rootId: metadata.rootId } : {}),
            ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {})
          })
        );
        return;
      }
      await this.orchestrator.interruptConversationAndWait(value.conversationId);
      const { externalKey, ...nextMetadata } = metadata;
      if (!externalKey) return;
      const profile = getAgentProfile(profileId);
      const created = this.store.createConversation("feishu", metadata.group === true ? "飞书群聊" : "飞书单聊", {
        profileId
      });
      this.store.setChannelBinding("feishu", externalKey, created.id, nextMetadata);
      await this.channel.send(
        event.chatId,
        { text: `已切换到${profile.name}，新对话已创建` },
        this.replyTarget({
          messageId: event.messageId,
          ...(metadata.rootId !== undefined ? { rootId: metadata.rootId } : {}),
          ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {})
        })
      );
      return;
    }

    if (value.action === "stop") {
      if (value.runId) this.orchestrator.interrupt(value.runId);
      return;
    }

    if (value.action === "learning_confirm") {
      if (!this.learning || !value.verificationId || !value.verdict) return;
      let result: ReturnType<typeof confirmLearningVerification>;
      try {
        result = confirmLearningVerification(
          {
            learning: this.learning,
            store: this.store,
            events: this.events,
            // Same deps as the web confirm route: without them, card-confirmed resolutions
            // would never distill teaching approaches and the D feature would not exist on
            // the one channel B2 made a first-class learning surface.
            ...(this.runtime
              ? {
                  invention: {
                    learning: this.learning,
                    store: this.store,
                    runtime: this.runtime,
                    workspaceRoot: this.workspaceRoot
                  }
                }
              : {})
          },
          value.verificationId,
          value.verdict
        );
      } catch (error) {
        if (error instanceof LearningConflictError) {
          // A double-click or stale card: show the terminal state instead of silent failure.
          if (this.channel.updateCard) {
            await this.channel.updateCard(
              event.messageId,
              buildFeishuLearningConfirmedCard(null, "该确认已处理过，以对话中的最新状态为准。")
            );
          }
        } else {
          // Anything else is a real failure — never dress it up as "already handled": the
          // verdict may or may not have been recorded, so send the learner to the web view.
          console.warn("[feishu] learning confirm failed", error);
          if (this.channel.updateCard) {
            await this.channel.updateCard(
              event.messageId,
              buildFeishuLearningConfirmedCard(null, "确认处理时出错了，请到网页端查看学习面板的最新状态。")
            );
          }
        }
        return;
      }
      if (this.channel.updateCard) {
        await this.channel.updateCard(event.messageId, buildFeishuLearningConfirmedCard(value.verdict));
      }
      // The web client auto-sends the try-another follow-up after an unresolved on-call
      // confirmation; the card does the same server-side so the next round starts here too.
      if (
        value.verdict === "unresolved" &&
        result.session.condition !== "one-shot" &&
        result.incident.status === "diagnosed"
      ) {
        const mode = this.orchestrator.isConversationBusy(value.conversationId) ? "queue" : "normal";
        const run = this.orchestrator.submit(value.conversationId, LEARNING_TRY_ANOTHER_PROMPT, mode);
        this.streamingRuns.add(run.id);
        void this.streamReply(
          {
            messageId: event.messageId,
            chatId: event.chatId,
            chatType: metadata.group === true ? "group" : "p2p",
            senderId: event.operator.openId,
            content: LEARNING_TRY_ANOTHER_PROMPT
          },
          run
        ).finally(() => this.streamingRuns.delete(run.id));
      }
      return;
    }

    const assistant = value.assistantMessageId ? this.store.getMessage(value.assistantMessageId) : null;
    if (!assistant || assistant.role !== "assistant" || assistant.conversationId !== value.conversationId) return;
    if (!assistant.runId) return;
    const sourceRun = this.store.getRun(assistant.runId);
    if (!sourceRun) return;
    const sourcePrompt = this.store.getMessage(sourceRun.userMessageId);
    if (!sourcePrompt) return;
    const branched = this.store.createBranchFromMessage(sourcePrompt.id, {
      asNewConversation: false,
      includeTarget: false
    });
    const run = this.orchestrator.submit(
      branched.id,
      sourcePrompt.content,
      "normal",
      sourcePrompt.attachments.map((item) => item.id)
    );
    this.streamingRuns.add(run.id);
    void this.streamReply(
      {
        messageId: event.messageId,
        chatId: event.chatId,
        chatType: metadata.group === true ? "group" : "p2p",
        senderId: event.operator.openId,
        content: sourcePrompt.content
      },
      run
    ).finally(() => this.streamingRuns.delete(run.id));
  }

  private async processInbound(message: NormalizedFeishuMessage): Promise<void> {
    const externalKey = feishuRoomKey(message);
    const command = parseCommand(message.content);
    let conversationId = this.store.getChannelBinding("feishu", externalKey);

    if (command.name === "help") {
      await this.channel.send(
        message.chatId,
        {
          markdown:
            "可用命令：`/new` 或 `/clear` 新建会话 · `/agent` 切换助手 · `/learn 目标` 开启学习模式（`/learn off` 结束） · `/stop` 暂停 · `/continue` 继续 · `/guide 文本` 引导当前任务"
        },
        this.replyTarget(message)
      );
      return;
    }
    if (command.name === "agent") {
      const requestedProfile = parseProfileArgument(command.argument);
      if (!conversationId || !requestedProfile) {
        const placeholder =
          conversationId ??
          this.store.createConversation("feishu", message.chatType === "group" ? "飞书群聊" : "飞书单聊", {
            profileId: DEFAULT_PROFILE_ID
          }).id;
        if (!conversationId)
          this.store.setChannelBinding("feishu", externalKey, placeholder, this.bindingMetadata(message));
        await this.channel.send(
          message.chatId,
          { card: buildFeishuProfilePickerCard(placeholder) },
          this.replyTarget(message)
        );
        return;
      }
      await this.orchestrator.interruptConversationAndWait(conversationId);
      const profile = getAgentProfile(requestedProfile);
      const created = this.store.createConversation("feishu", message.chatType === "group" ? "飞书群聊" : "飞书单聊", {
        profileId: requestedProfile
      });
      conversationId = created.id;
      this.store.setChannelBinding("feishu", externalKey, conversationId, this.bindingMetadata(message));
      await this.channel.send(
        message.chatId,
        { text: `已切换到${profile.name}，新对话已创建` },
        this.replyTarget(message)
      );
      return;
    }
    if (command.name === "new") {
      const currentProfileId = conversationId
        ? (this.store.getConversation(conversationId)?.profileId ?? DEFAULT_PROFILE_ID)
        : DEFAULT_PROFILE_ID;
      if (conversationId) await this.orchestrator.interruptConversationAndWait(conversationId);
      const created = this.store.createConversation("feishu", message.chatType === "group" ? "飞书群聊" : "飞书单聊", {
        profileId: currentProfileId
      });
      conversationId = created.id;
      this.store.setChannelBinding("feishu", externalKey, conversationId, this.bindingMetadata(message));
      await this.channel.send(message.chatId, { text: "新对话已创建" }, this.replyTarget(message));
      return;
    }
    if (!conversationId) {
      const created = this.store.createConversation("feishu", message.chatType === "group" ? "飞书群聊" : "飞书单聊", {
        profileId: DEFAULT_PROFILE_ID
      });
      conversationId = created.id;
      this.store.setChannelBinding("feishu", externalKey, conversationId, this.bindingMetadata(message));
    } else {
      this.store.setChannelBinding("feishu", externalKey, conversationId, this.bindingMetadata(message));
    }

    if (command.name === "stop") {
      this.orchestrator.interruptConversation(conversationId);
      await this.channel.send(message.chatId, { markdown: "正在暂停当前任务。" }, this.replyTarget(message));
      return;
    }

    if (command.name === "learn") {
      await this.handleLearnCommand(conversationId, command.argument, message);
      return;
    }

    const rawText =
      command.name === "continue"
        ? "继续刚才的任务。"
        : command.name === "guide"
          ? command.argument
          : message.content.trim();
    const inboundFiles = await this.ingestInboundFiles(conversationId, message);
    const attachmentIds = inboundFiles.attachmentIds;
    if (inboundFiles.failures.length > 0) {
      const prefix = attachmentIds.length > 0 ? "部分附件未能读取" : "附件未能读取";
      await this.channel.send(
        message.chatId,
        {
          markdown: `${prefix}：${inboundFiles.failures.slice(0, 3).join("；")}。请检查机器人文件权限，或改用 PDF、Word、Excel、图片、Markdown/文本文件。`
        },
        this.replyTarget(message)
      );
    }
    const looksLikeFileJson = rawText.startsWith("{") && /file_key|image_key|fileKey|imageKey/.test(rawText);
    const fileType = /^(file|image|media|audio|post)$/i.test(message.messageType ?? "");
    const content = looksLikeFileJson || (fileType && !rawText.trim()) ? "" : rawText;
    if (!content && attachmentIds.length === 0) return;
    const mode =
      command.name === "guide" ? "guide" : this.orchestrator.isConversationBusy(conversationId) ? "queue" : "normal";
    const run = this.orchestrator.submit(conversationId, content || "请查看附件。", mode, attachmentIds);
    this.streamingRuns.add(run.id);
    void this.streamReply(message, run).finally(() => this.streamingRuns.delete(run.id));
  }

  /** `/learn 目标` opens (or refreshes) a live learning session; `/learn off` completes it. */
  private async handleLearnCommand(
    conversationId: string,
    argument: string,
    message: NormalizedFeishuMessage
  ): Promise<void> {
    if (!this.channel) return;
    const replyTo = this.replyTarget(message);
    if (!this.learning) {
      await this.channel.send(message.chatId, { markdown: "学习模式暂不可用。" }, replyTo);
      return;
    }
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) return;
    const goal = argument.trim();
    const existing = this.learning.getSessionForConversation(conversationId);
    const announce = (session: LearningSessionDto) => {
      this.events.append({
        type: "learning.session.updated",
        conversationId,
        branchId: conversation.activeBranchId,
        payload: { session }
      });
    };
    // Mobile keyboards auto-capitalize and append punctuation; a fuzzy match keeps
    // "/learn OFF" or "/learn off。" from being taken as a new goal that overwrites the
    // real one.
    const normalizedGoal = goal.toLowerCase().replace(/[。．.!！]+$/u, "");
    if (normalizedGoal === "off" || normalizedGoal === "结束") {
      if (existing && (existing.status === "active" || existing.status === "paused")) {
        const session = this.learning.transitionSession(existing.id, "completed");
        announce(session);
        await this.channel.send(message.chatId, { markdown: "学习会话已结束。" }, replyTo);
      } else {
        await this.channel.send(message.chatId, { markdown: "当前没有进行中的学习会话。" }, replyTo);
      }
      return;
    }
    if (!goal) {
      await this.channel.send(
        message.chatId,
        {
          markdown:
            "用法：`/learn 学习目标`（例如 `/learn 理解递归的出口条件`）开启学习模式；`/learn off` 结束当前学习会话。"
        },
        replyTo
      );
      return;
    }
    let session: LearningSessionDto;
    if (existing?.status === "suggested" || existing?.status === "paused") {
      session = this.learning.updateSessionDetails(existing.id, { goal });
      session = this.learning.transitionSession(session.id, "active");
    } else if (existing?.status === "active") {
      session = this.learning.updateSessionDetails(existing.id, { goal });
    } else if (existing) {
      // Terminal sessions cannot restart and a conversation holds at most one.
      await this.channel.send(
        message.chatId,
        { markdown: "该对话的学习会话已结束；用 `/new` 开一个新对话再 `/learn`。" },
        replyTo
      );
      return;
    } else {
      session = this.learning.createSession({
        conversationId,
        profileId: conversation.profileId,
        goal,
        datasetKind: "live",
        status: "active"
      });
    }
    announce(session);
    await this.channel.send(
      message.chatId,
      {
        markdown: `学习模式已开启：${session.goal}\n直接描述你的困难，我会按学习回路来帮你；出练习之后会请你确认效果。`
      },
      replyTo
    );
  }

  private async streamReply(message: NormalizedFeishuMessage, run: RunRecord): Promise<void> {
    if (!this.channel) return;
    let accumulated = "";
    const context: FeishuReplyCardContext = {
      conversationId: run.conversationId,
      assistantMessageId: run.assistantMessageId,
      runId: run.id,
      webAppUrl: this.webAppUrl
    };
    try {
      await this.channel.stream(
        message.chatId,
        {
          card: {
            initial: buildFeishuThinkingCard(0, context),
            producer: async (stream: { update: (card: object) => Promise<void> }) => {
              let thinking = true;
              let frame = 0;
              let latestActivityLabel = "";
              let latestActivityText = "";
              let sawAnswer = false;
              const activityLabels = new Map<string, string>();
              const hiddenActivityBlocks = new Set<string>();
              const cards = createFeishuCardPump(stream);
              let timer: ReturnType<typeof setInterval> | undefined;
              const stopThinking = () => {
                thinking = false;
                if (timer) clearInterval(timer);
                timer = undefined;
              };
              timer = setInterval(() => {
                if (!thinking) return;
                frame = (frame + 1) % 4;
                void cards.push(buildFeishuThinkingCard(frame, context));
              }, 650);
              try {
                for await (const event of this.events.streamRun(run.conversationId, run.id)) {
                  if (event.type === "activity.started") {
                    const block = event.payload.block as Record<string, any> | undefined;
                    // Learning MCP activity stays invisible to the learner on every channel.
                    // Checked BEFORE stopThinking(): learning turns open with several hidden
                    // tool calls, and killing the animation for them would freeze the card on
                    // a stale frame until the first visible text arrives.
                    if (isLearningFrameworkActivity(block)) {
                      const hiddenId = String(block?.id ?? "");
                      if (hiddenId) hiddenActivityBlocks.add(hiddenId);
                      continue;
                    }
                    stopThinking();
                    const activity = block?.activity as Record<string, any> | undefined;
                    const blockId = String(block?.id ?? "");
                    latestActivityLabel = String(activity?.displayName ?? "正在处理");
                    latestActivityText = String(activity?.content ?? "");
                    if (blockId) activityLabels.set(blockId, latestActivityLabel);
                    if (!accumulated) {
                      await cards.push(buildFeishuActivityCard(latestActivityLabel, latestActivityText, context), true);
                    }
                  }
                  if (event.type === "activity.text.delta") {
                    const blockId = String(event.payload.blockId ?? "");
                    if (hiddenActivityBlocks.has(blockId)) continue;
                    stopThinking();
                    latestActivityLabel = activityLabels.get(blockId) ?? (latestActivityLabel || "正在处理");
                    latestActivityText = `${latestActivityText}${String(event.payload.delta ?? "")}`.slice(-800);
                    if (!accumulated) {
                      await cards.push(buildFeishuActivityCard(latestActivityLabel, latestActivityText, context));
                    }
                  }
                  if (
                    event.type === "activity.updated" ||
                    event.type === "activity.completed" ||
                    event.type === "activity.failed"
                  ) {
                    const block = event.payload.block as Record<string, any> | undefined;
                    if (isLearningFrameworkActivity(block)) continue;
                    const activity = block?.activity as Record<string, any> | undefined;
                    latestActivityLabel = String(activity?.displayName ?? (latestActivityLabel || "正在处理"));
                    if (!accumulated) {
                      await cards.push(
                        buildFeishuActivityCard(
                          latestActivityLabel,
                          String(activity?.content ?? latestActivityText).slice(-800),
                          context,
                          event.type === "activity.completed"
                            ? "已完成"
                            : event.type === "activity.failed"
                              ? "未完成"
                              : "正在处理"
                        )
                      );
                    }
                  }
                  if (event.type === "user.question") {
                    stopThinking();
                    const question = {
                      questions: Array.isArray(event.payload.questions) ? event.payload.questions : []
                    } as AskUserQuestionDto;
                    if (question.questions.length > 0) {
                      await cards.push(
                        buildFeishuAskUserCard(question, {
                          conversationId: context.conversationId,
                          runId: context.runId,
                          webAppUrl: context.webAppUrl
                        }),
                        true
                      );
                    }
                  }
                  if (event.type === "message.text.delta") {
                    stopThinking();
                    accumulated += String(event.payload.delta ?? "");
                    await cards.push(buildFeishuRunningCard(accumulated, context), !sawAnswer);
                    sawAnswer = true;
                  }
                  if (event.type === "run.failed") throw new Error(String(event.payload.error ?? "Agent failed"));
                  if (event.type === "run.interrupted") {
                    stopThinking();
                    accumulated = `${accumulated}${accumulated ? "\n\n" : ""}— 已暂停，以上内容可能不完整`;
                  }
                }
              } finally {
                if (timer) clearInterval(timer);
                await cards.flush();
              }
              const files = presentedAttachments(
                this.store.getStoredAttachmentsForMessage?.(run.assistantMessageId) ?? []
              );
              const body = this.withCollaborationSummary(accumulated || "（未生成内容）", run.assistantMessageId);
              await stream.update(buildFeishuReplyCard(body, context, files));
              await this.sendGeneratedFiles(message.chatId, run.conversationId, files, this.replyTarget(message));
              await this.maybeSendLearningOutcomeCard(message.chatId, run.conversationId, this.replyTarget(message));
            }
          }
        },
        this.replyTarget(message)
      );
    } catch (error) {
      const fallback = this.withCollaborationSummary(
        accumulated || `Agent 执行失败：${safeMessage(error)}`,
        run.assistantMessageId
      );
      const files = presentedAttachments(this.store.getStoredAttachmentsForMessage?.(run.assistantMessageId) ?? []);
      try {
        await this.channel.send(
          message.chatId,
          { card: buildFeishuReplyCard(fallback, context, files) },
          this.replyTarget(message)
        );
        await this.sendGeneratedFiles(message.chatId, run.conversationId, files, this.replyTarget(message));
        await this.maybeSendLearningOutcomeCard(message.chatId, run.conversationId, this.replyTarget(message));
      } catch (fallbackError) {
        try {
          await this.channel.send(message.chatId, { markdown: fallback }, this.replyTarget(message));
        } catch {
          console.error("[feishu] fallback reply failed", safeMessage(fallbackError));
        }
      }
    }
  }

  /**
   * When a run leaves a system verdict waiting for the learner's own confirmation, the
   * outcome card is the Feishu twin of the web confirm buttons.
   */
  private async maybeSendLearningOutcomeCard(
    chatId: string,
    conversationId: string,
    options: { replyTo?: string; replyInThread?: boolean }
  ): Promise<void> {
    if (!this.channel || !this.learning) return;
    try {
      const pending = this.learning.pendingLearnerConfirmation(conversationId);
      if (!pending) return;
      // One card per verification: the pending state persists across every run until the
      // learner clicks, so without this a learner who keeps typing gets an identical card
      // appended after each reply, all carrying the same verificationId.
      if (this.notifiedLearningConfirms.has(pending.verification.id)) return;
      await this.channel.send(
        chatId,
        {
          card: buildFeishuLearningOutcomeCard({
            conversationId,
            verificationId: pending.verification.id,
            finalRound: pending.finalRound
          })
        },
        options
      );
      this.notifiedLearningConfirms.add(pending.verification.id);
    } catch (error) {
      console.error("[feishu] learning outcome card failed", safeMessage(error));
    }
  }

  /**
   * Whether anything sent into this conversation can still reach a human on Feishu. `/new`
   * and `/agent` repoint the DM's single binding row, so runs submitted into the previous
   * conversation would execute invisibly; the spaced-review runner defers instead.
   */
  canReachConversation(conversationId: string): boolean {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation || conversation.channel !== "feishu") return true;
    return this.bindingForConversation(conversationId) !== null;
  }

  private async ingestInboundFiles(
    conversationId: string,
    message: NormalizedFeishuMessage
  ): Promise<FeishuInboundFileResult> {
    const files = inboundFilesFromMessage(message);
    if (files.length === 0) return { attachmentIds: [], failures: [] };
    const directory = path.join(this.workspaceRoot, conversationId, "attachments");
    fs.mkdirSync(directory, { recursive: true });
    const attachmentIds: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      const fileName = sanitizeInboundFileName(
        file.fileName || (file.kind === "image" ? "image.png" : "attachment.bin")
      );
      try {
        const buffer = file.data ?? (await this.downloadInboundFile(message.messageId, file));
        if (!buffer || buffer.length === 0) {
          failures.push(`${fileName}（下载失败或缺少权限）`);
          continue;
        }
        if (buffer.length > MAX_INPUT_FILE_BYTES) throw new InboundFileTooLargeError();
        const mimeType = file.mimeType || (file.kind === "image" ? "image/png" : "application/octet-stream");
        if (!isAllowedInboundMime(mimeType)) {
          failures.push(`${fileName}（不支持 ${mimeType}）`);
          continue;
        }
        const storedName = uniqueInboundStoredName(directory, fileName);
        const relativePath = path.join("attachments", storedName);
        fs.writeFileSync(path.join(directory, storedName), buffer);
        const attachment = this.store.createAttachment({
          conversationId,
          fileName,
          storedName,
          mimeType,
          size: buffer.length,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          relativePath
        });
        attachmentIds.push(attachment.id);
      } catch (error) {
        console.error("[feishu] unable to store inbound file", fileName, safeMessage(error));
        failures.push(
          error instanceof InboundFileTooLargeError ? `${fileName}（超过 20 MB）` : `${fileName}（保存失败）`
        );
      }
    }
    return { attachmentIds, failures };
  }

  private async downloadInboundFile(messageId: string, file: FeishuInboundFile): Promise<Buffer | null> {
    if (!this.currentConfig) return null;
    const Client = (Lark as unknown as { Client?: new (options: unknown) => any }).Client;
    if (!Client) return null;
    try {
      const client = new Client({
        appId: this.currentConfig.appId,
        appSecret: this.currentConfig.appSecret,
        domain: (Lark as any).Domain?.Feishu
      });
      const result = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: file.key },
        params: { type: file.kind === "image" ? "image" : "file" }
      });
      if (Buffer.isBuffer(result)) return boundedInboundBuffer(result);
      if (result instanceof Uint8Array) return boundedInboundBuffer(Buffer.from(result));
      const data = result?.data ?? result?.file ?? result;
      if (Buffer.isBuffer(data)) return boundedInboundBuffer(data);
      if (data instanceof Uint8Array) return boundedInboundBuffer(Buffer.from(data));
      if (typeof data?.arrayBuffer === "function") return boundedInboundBuffer(Buffer.from(await data.arrayBuffer()));
      if (typeof data?.read === "function") {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of data) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > MAX_INPUT_FILE_BYTES) throw new InboundFileTooLargeError();
          chunks.push(buffer);
        }
        return Buffer.concat(chunks);
      }
    } catch (error) {
      if (error instanceof InboundFileTooLargeError) throw error;
      console.error("[feishu] unable to download inbound file", file.fileName ?? file.key, safeMessage(error));
    }
    return null;
  }

  async mirrorCompletedRun(conversationId: string, runId: string): Promise<void> {
    if (this.streamingRuns.has(runId) || !this.channel) return;
    const conversation = this.store.getConversation?.(conversationId);
    if (!conversation || conversation.channel !== "feishu") return;
    const run = this.store.getRun?.(runId);
    if (!run) return;
    const assistant = this.store.getMessage?.(run.assistantMessageId);
    const files = presentedAttachments(this.store.getStoredAttachmentsForMessage?.(run.assistantMessageId) ?? []);
    const content = this.withCollaborationSummary(assistant?.content?.trim() ?? "", run.assistantMessageId);
    if (content) await this.send(conversationId, content);
    const metadata = this.bindingForConversation(conversationId);
    if (metadata && files.length > 0) {
      await this.sendGeneratedFiles(metadata.chatId, conversationId, files, this.replyTarget(metadata));
    }
    if (metadata) await this.maybeSendLearningOutcomeCard(metadata.chatId, conversationId, this.replyTarget(metadata));
  }

  private async sendGeneratedFiles(
    chatId: string,
    conversationId: string,
    files: StoredAttachment[],
    options: { replyTo?: string; replyInThread?: boolean }
  ): Promise<void> {
    if (!this.channel || files.length === 0) return;
    for (const file of files) {
      const absolute = this.workspaceRoot ? path.resolve(this.workspaceRoot, conversationId, file.relativePath) : "";
      if (!absolute || !fs.existsSync(absolute)) continue;
      try {
        await uploadFeishuFile(this.currentConfig, chatId, absolute, file.fileName, options);
      } catch {
        try {
          await this.channel.send(
            chatId,
            {
              file: { path: absolute, name: file.fileName, fileName: file.fileName }
            },
            options
          );
        } catch (error) {
          console.error("[feishu] unable to send generated file", file.fileName, safeMessage(error));
        }
      }
    }
  }

  private withCollaborationSummary(content: string, assistantMessageId: string): string {
    const trace = this.collaboration?.traceForMessage(assistantMessageId);
    if (!trace) return content;
    const summary = trace.summary;
    const line = `协作核验：${summary.specialistCount} 位协作助手 · ${summary.verifiedCount} 项已确认 · ${summary.conflictingCount + summary.unresolvedCount} 项待确认`;
    const notice = summary.importantNotice ? `注意：${summary.importantNotice}` : "";
    return [content, line, notice].filter(Boolean).join("\n\n");
  }

  private replyTarget(source: { messageId?: string; rootId?: string | null; threadId?: string | null }): {
    replyTo?: string;
    replyInThread: boolean;
  } {
    return feishuReplyOptions(source);
  }

  private bindingMetadata(message: NormalizedFeishuMessage): Record<string, unknown> {
    return {
      chatId: message.chatId,
      messageId: message.messageId,
      group: message.chatType === "group",
      rootId: message.rootId ?? null,
      threadId: message.threadId ?? null
    };
  }

  private bindingForConversation(conversationId: string): FeishuBindingMetadata | null {
    const binding = this.store.database
      .prepare(
        `SELECT external_key, metadata_json FROM channel_bindings
         WHERE channel = 'feishu' AND conversation_id = ? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(conversationId) as { external_key: string; metadata_json: string } | undefined;
    if (!binding) return null;
    try {
      return { ...(JSON.parse(binding.metadata_json) as FeishuBindingMetadata), externalKey: binding.external_key };
    } catch {
      return null;
    }
  }
}

export interface FeishuReplyCardContext {
  conversationId: string;
  assistantMessageId: string;
  runId: string;
  webAppUrl: string;
}

function createFeishuCardPump(stream: { update: (card: object) => Promise<void> }, intervalMs = 400) {
  let chain = Promise.resolve();
  let lastAt = 0;
  let pending: object | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (card: object) => {
    chain = chain.then(() => stream.update(card)).catch(() => undefined);
    return chain;
  };
  return {
    push(card: object, force = false) {
      pending = card;
      const now = Date.now();
      if (force || now - lastAt >= intervalMs) {
        lastAt = now;
        pending = null;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        return send(card);
      }
      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          if (!pending) return;
          lastAt = Date.now();
          const next = pending;
          pending = null;
          void send(next);
        }, intervalMs);
      }
      return Promise.resolve();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (pending) {
        const next = pending;
        pending = null;
        await send(next);
      }
      await chain;
    }
  };
}

export function buildFeishuThinkingCard(frame: number, context: FeishuReplyCardContext): object {
  const dots = "·".repeat(Math.max(0, Math.min(3, frame)));
  return buildFeishuCard(`Thinking${dots}`, [
    feishuConversationWebButton(context.webAppUrl, context.conversationId),
    callbackButton("停止回复", "stop_reply", {
      action: "stop",
      conversationId: context.conversationId,
      runId: context.runId
    })
  ]);
}

export function buildFeishuActivityCard(
  label: string,
  excerpt: string,
  context: FeishuReplyCardContext,
  status = "正在处理"
): object {
  const cleanExcerpt = excerpt.replace(/\s+/g, " ").trim();
  const content = `**${label}** · ${status}${cleanExcerpt ? `\n\n${cleanExcerpt.slice(-600)}` : ""}`;
  return buildFeishuCard(content, [
    feishuConversationWebButton(context.webAppUrl, context.conversationId),
    callbackButton("停止回复", "stop_reply", {
      action: "stop",
      conversationId: context.conversationId,
      runId: context.runId
    })
  ]);
}

function buildFeishuRunningCard(content: string, context: FeishuReplyCardContext): object {
  return buildFeishuCard(content, [
    feishuConversationWebButton(context.webAppUrl, context.conversationId),
    callbackButton("停止回复", "stop_reply", {
      action: "stop",
      conversationId: context.conversationId,
      runId: context.runId
    })
  ]);
}

export function buildFeishuReplyCard(
  content: string,
  context: FeishuReplyCardContext,
  files: Array<{ id: string; fileName: string }> = []
): object {
  const fileNote =
    files.length === 0
      ? content
      : `${content}\n\n**生成的文件**\n${files.map((file) => `- ${file.fileName}`).join("\n")}`;
  const buttons: object[] = [feishuConversationWebButton(context.webAppUrl, context.conversationId)];
  for (const file of files.slice(0, 3)) {
    const fileUrl = new URL(`/api/attachments/${encodeURIComponent(file.id)}`, context.webAppUrl);
    buttons.push({
      tag: "button",
      element_id: `open_file_${file.id.slice(0, 8)}`,
      text: { tag: "plain_text", content: `打开 ${file.fileName}` },
      type: "default",
      size: "medium",
      behaviors: [
        {
          type: "open_url",
          default_url: fileUrl.toString(),
          pc_url: fileUrl.toString(),
          ios_url: fileUrl.toString(),
          android_url: fileUrl.toString()
        }
      ]
    });
  }
  buttons.push(
    callbackButton("重新回复", "retry_reply", {
      action: "retry",
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId
    }),
    callbackButton("新对话", "new_conversation", {
      action: "new",
      conversationId: context.conversationId
    }),
    callbackButton("切换助手", "switch_profile", {
      action: "profile",
      conversationId: context.conversationId
    })
  );
  return buildFeishuCard(fileNote, buttons);
}

export function buildFeishuProfilePickerCard(conversationId: string): object {
  return buildFeishuCard("选择接下来要使用的助手", [
    callbackButton("申学助手", "profile_admissions", {
      action: "profile",
      conversationId,
      profileId: "graduate-admissions"
    }),
    callbackButton("本地助手", "profile_local", {
      action: "profile",
      conversationId,
      profileId: "local-operator"
    })
  ]);
}

export function buildFeishuScheduledReportCard(
  title: string,
  content: string,
  runId: string,
  webAppUrl: string
): object {
  const url = new URL(webAppUrl);
  url.searchParams.set("scheduledRun", runId);
  return buildFeishuCard(`## ${title}\n\n${content}`, [
    openUrlButton("去往网页端", "open_scheduled_report", url.toString())
  ]);
}

export function buildFeishuEvolutionCard(input: {
  artifact: Pick<EvolvedArtifactDto, "id" | "profileId" | "kind" | "name" | "description">;
  verdict: EvolutionReviewVerdict;
  reason: string;
  enabled?: boolean;
  replayRunId?: string | null;
  webAppUrl?: string;
}): object {
  const profileName = isAgentProfileId(input.artifact.profileId)
    ? getAgentProfile(input.artifact.profileId).name
    : input.artifact.profileId;
  const kindLabel = input.artifact.kind === "skill" ? "Skill" : "子代理";
  const statusLine =
    input.verdict === "pass"
      ? `已启用「${input.artifact.name}」。可在能力页关闭。`
      : input.verdict === "reject"
        ? `已拒绝「${input.artifact.name}」。`
        : `待你确认：${input.reason}`;
  const content = [
    `助手：${profileName}`,
    `类型：${kindLabel}`,
    `名称：${input.artifact.name}`,
    `说明：${input.artifact.description}`,
    `检查：${input.reason}`,
    statusLine,
    input.replayRunId ? "网页能力页可对照「启用前 / 后」重放。" : ""
  ]
    .filter(Boolean)
    .join("\n");
  const buttons =
    input.verdict === "needs_human"
      ? [
          callbackButton("通过并启用", "evolution_approve", {
            action: "evolution_approve",
            artifactId: input.artifact.id
          }),
          callbackButton("拒绝", "evolution_reject", { action: "evolution_reject", artifactId: input.artifact.id }),
          ...replayOpenUrlButtons(input)
        ]
      : [];
  const header =
    input.verdict === "pass"
      ? { title: { tag: "plain_text", content: "已通过" }, template: "green" }
      : input.verdict === "reject"
        ? { title: { tag: "plain_text", content: "已拒绝" }, template: "red" }
        : { title: { tag: "plain_text", content: "助手能力有更新" }, template: "orange" };
  return buildFeishuCard(content, buttons, header);
}

function buildFeishuCard(
  content: string,
  buttons: object[],
  header?: { title: { tag: string; content: string }; template: string }
): object {
  const elements: object[] = [{ tag: "markdown", element_id: "answer", content }];
  if (buttons.length > 0) {
    elements.push({
      tag: "column_set",
      element_id: "reply_actions",
      flex_mode: "none",
      horizontal_spacing: "8px",
      columns: buttons.map((button) => ({
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [button]
      }))
    });
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summarizeCard(header ? `${header.title.content} ${content}` : content) }
    },
    ...(header ? { header } : {}),
    body: {
      direction: "vertical",
      vertical_spacing: "8px",
      padding: "12px",
      elements
    }
  };
}

function replayOpenUrlButtons(input: {
  artifact: Pick<EvolvedArtifactDto, "id">;
  replayRunId?: string | null;
  webAppUrl?: string;
}): object[] {
  if (!input.replayRunId || !input.webAppUrl) return [];
  try {
    const url = new URL(input.webAppUrl);
    if (new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) return [];
    const before = new URL(url);
    before.searchParams.set("replayRun", input.replayRunId);
    const after = new URL(url);
    after.searchParams.set("replayRun", input.replayRunId);
    after.searchParams.set("withArtifact", input.artifact.id);
    return [
      openUrlButton("启用前回放", "replay_before", before.toString()),
      openUrlButton("启用后回放", "replay_after", after.toString())
    ];
  } catch {
    return [];
  }
}

function openUrlButton(text: string, elementId: string, href: string): object {
  return {
    tag: "button",
    element_id: elementId,
    text: { tag: "plain_text", content: text },
    type: "default",
    size: "medium",
    behaviors: [
      {
        type: "open_url",
        default_url: href,
        pc_url: href,
        ios_url: href,
        android_url: href
      }
    ]
  };
}

function callbackButton(text: string, elementId: string, value: FeishuCardActionValue): object {
  return {
    tag: "button",
    element_id: elementId,
    text: { tag: "plain_text", content: text },
    type: "default",
    size: "medium",
    behaviors: [{ type: "callback", value }]
  };
}

export function parseCardActionValue(value: unknown): FeishuCardActionValue | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    !new Set([
      "stop",
      "retry",
      "new",
      "profile",
      "evolution_approve",
      "evolution_reject",
      "evolution_disable",
      "evolution_keep",
      "ask_answer",
      "learning_confirm"
    ]).has(String(raw.action))
  )
    return null;
  const evolutionAction =
    raw.action === "evolution_approve" ||
    raw.action === "evolution_reject" ||
    raw.action === "evolution_disable" ||
    raw.action === "evolution_keep";
  const askAction = raw.action === "ask_answer";
  if (evolutionAction && (typeof raw.artifactId !== "string" || !raw.artifactId)) return null;
  if (!evolutionAction && !askAction && (typeof raw.conversationId !== "string" || !raw.conversationId)) return null;
  if (askAction && (typeof raw.runId !== "string" || typeof raw.answer !== "string")) return null;
  const learningVerdict = ["resolved", "partial", "unresolved"].includes(String(raw.verdict))
    ? (raw.verdict as "resolved" | "partial" | "unresolved")
    : null;
  if (raw.action === "learning_confirm" && (typeof raw.verificationId !== "string" || !learningVerdict)) return null;
  return {
    action: raw.action as FeishuCardActionValue["action"],
    ...(typeof raw.conversationId === "string" ? { conversationId: raw.conversationId } : {}),
    ...(typeof raw.artifactId === "string" ? { artifactId: raw.artifactId } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(typeof raw.assistantMessageId === "string" ? { assistantMessageId: raw.assistantMessageId } : {}),
    ...(typeof raw.profileId === "string" && isAgentProfileId(raw.profileId) ? { profileId: raw.profileId } : {}),
    ...(typeof raw.answer === "string" ? { answer: raw.answer } : {}),
    ...(typeof raw.verificationId === "string" ? { verificationId: raw.verificationId } : {}),
    ...(learningVerdict ? { verdict: learningVerdict } : {})
  };
}

/** The outcome-confirmation card for the learning loop; mirrors the web confirm buttons. */
export function buildFeishuLearningOutcomeCard(input: {
  conversationId: string;
  verificationId: string;
  finalRound: boolean;
}): object {
  const value = (verdict: "resolved" | "partial" | "unresolved"): FeishuCardActionValue => ({
    action: "learning_confirm",
    conversationId: input.conversationId,
    verificationId: input.verificationId,
    verdict
  });
  return buildFeishuCard(
    "刚才的讲解和练习之后，这个难点你自己觉得解决了吗？",
    [
      callbackButton("听懂了", "learning_resolved", value("resolved")),
      callbackButton("部分懂了", "learning_partial", value("partial")),
      callbackButton(input.finalRound ? "仍未解决" : "仍未解决，换种讲法", "learning_unresolved", value("unresolved"))
    ],
    { title: { tag: "plain_text", content: "学习确认" }, template: "turquoise" }
  );
}

/** Post-enablement outcome alert: a capability that keeps getting retried, awaiting the owner. */
export function buildFeishuUsageSuggestionCard(input: {
  artifact: EvolvedArtifactDto;
  uses?: number;
  retriedRuns?: number;
  reason?: string;
  resolved?: "disabled" | "kept";
}): object {
  const kindLabel = input.artifact.kind === "skill" ? "Skill" : "子代理";
  if (input.resolved) {
    return buildFeishuCard(
      `${kindLabel}「${input.artifact.name}」${input.resolved === "disabled" ? "已停用。" : "已保留，两周内不再提醒。"}`,
      [],
      {
        title: { tag: "plain_text", content: "能力效果提醒" },
        template: input.resolved === "disabled" ? "grey" : "green"
      }
    );
  }
  const value = (action: "evolution_disable" | "evolution_keep"): FeishuCardActionValue => ({
    action,
    artifactId: input.artifact.id
  });
  return buildFeishuCard(
    `${kindLabel}「${input.artifact.name}」\n${input.reason ?? ""}\n表现明显差于该助手的平均水平；停用后随时可在能力页重新启用。`,
    [
      callbackButton("停用", "evolution_disable", value("evolution_disable")),
      callbackButton("保留", "evolution_keep", value("evolution_keep"))
    ],
    { title: { tag: "plain_text", content: "能力效果提醒" }, template: "orange" }
  );
}

/** Structured escalation handoff sent to the owner when the learning loop gives up. */
export function buildFeishuLearningHandoffCard(
  report: LearningHandoffReportDto,
  goal: string,
  webAppUrl: string
): object {
  const attempts = report.attempts
    .map(
      (attempt) =>
        `${attempt.round}. ${chineseStrategy(attempt.strategy)} → ${
          attempt.outcome === "resolved"
            ? "已解决"
            : attempt.outcome === "partial"
              ? "部分理解"
              : attempt.outcome === "unresolved"
                ? "未解决"
                : "未验证"
        }`
    )
    .join("\n");
  const stillOpen = report.stillOpen
    .slice(0, 2)
    .map((item) => `- ${item}`)
    .join("\n");
  const suggestions = report.suggestedNextStrategies.map((strategy) => chineseStrategy(strategy)).join("、");
  const lines = [
    `**目标**：${goal}`,
    `**诊断**：${report.hypothesis}`,
    attempts ? `**已尝试**：\n${attempts}` : "",
    stillOpen ? `**学习者仍未达到**：\n${stillOpen}` : "",
    suggestions ? `**建议接手讲法**：${suggestions}` : "",
    report.escalationReason ? `**升级原因**：${report.escalationReason}` : ""
  ].filter(Boolean);
  return buildFeishuCard(lines.join("\n"), [openUrlButton("去往网页端查看", "handoff_open", webAppUrl)], {
    title: { tag: "plain_text", content: "学习升级 · 需要人工接手" },
    template: "red"
  });
}

/** Terminal state of the outcome card after a click (or after a stale double-click). */
export function buildFeishuLearningConfirmedCard(
  verdict: "resolved" | "partial" | "unresolved" | null,
  note?: string
): object {
  const label =
    verdict === "resolved"
      ? "听懂了"
      : verdict === "partial"
        ? "部分懂了"
        : verdict === "unresolved"
          ? "仍未解决"
          : "已处理";
  return buildFeishuCard(note ? `${note}` : `已记录：${label}`, [], {
    title: { tag: "plain_text", content: "学习确认" },
    template: verdict === "resolved" ? "green" : verdict === "partial" ? "yellow" : "grey"
  });
}

/**
 * Learning MCP activity must stay invisible to the learner on every channel — the same
 * rule the web enforces with isLearningFrameworkBlock.
 */
function isLearningFrameworkActivity(block: Record<string, any> | undefined): boolean {
  const activity = block?.activity as Record<string, any> | undefined;
  return /mcp__learning__|open_learning_incident|record_learning_intervention|request_learning_verification|propose_learning_outcome|escalate_learning_incident/i.test(
    `${block?.technicalName ?? ""} ${block?.name ?? ""} ${block?.title ?? ""} ${activity?.technicalName ?? ""} ${activity?.displayName ?? ""}`
  );
}

function summarizeCard(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "Agent 回复";
  return clean.length <= 60 ? clean : `${clean.slice(0, 59)}…`;
}

type Command = {
  name: "new" | "stop" | "continue" | "guide" | "help" | "agent" | "learn" | "message";
  argument: string;
};

export function parseCommand(content: string): Command {
  const value = content.trim();
  if (value === "/new" || value === "/clear") return { name: "new", argument: "" };
  if (value === "/stop") return { name: "stop", argument: "" };
  if (value === "/continue") return { name: "continue", argument: "" };
  if (value === "/help") return { name: "help", argument: "" };
  if (value === "/agent" || value.startsWith("/agent ")) return { name: "agent", argument: value.slice(6).trim() };
  if (value === "/learn" || value.startsWith("/learn ")) return { name: "learn", argument: value.slice(6).trim() };
  if (value.startsWith("/guide")) return { name: "guide", argument: value.slice(6).trim() };
  return { name: "message", argument: value };
}

function parseProfileArgument(value: string): AgentProfileId | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (["申学", "申学助手", "admissions", "graduate-admissions"].includes(normalized)) return "graduate-admissions";
  if (["通用", "本地", "本地助手", "general", "local", "local-operator"].includes(normalized)) return "local-operator";
  return null;
}

async function uploadFeishuFile(
  config: FeishuRuntimeConfig | undefined,
  chatId: string,
  absolute: string,
  fileName: string,
  options: { replyTo?: string; replyInThread?: boolean }
): Promise<void> {
  const Client = (Lark as unknown as { Client?: new (options: unknown) => any }).Client;
  if (!Client || !config) throw new Error("Feishu client is unavailable");
  const client = new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: (Lark as any).Domain?.Feishu
  });
  const uploaded = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: fileName,
      file: fs.createReadStream(absolute)
    }
  });
  const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key;
  if (!fileKey) throw new Error("Feishu file upload did not return a file_key");
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
      ...(options.replyTo ? { uuid: options.replyTo } : {})
    }
  });
}

function presentedAttachments(files: StoredAttachment[]): StoredAttachment[] {
  return files.filter((file) => file.presented !== false);
}

function isAllowedInboundMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/octet-stream"
    ].includes(mimeType)
  );
}

function uniqueInboundStoredName(directory: string, fileName: string): string {
  const preferred = fileName;
  const used = new Set(fs.existsSync(directory) ? fs.readdirSync(directory).map((item) => item.toLowerCase()) : []);
  if (!used.has(preferred.toLowerCase())) return preferred;
  const ext = path.extname(preferred);
  const stem = preferred.slice(0, preferred.length - ext.length) || "attachment";
  let index = 2;
  while (used.has(`${stem}-${index}${ext}`.toLowerCase())) index += 1;
  return `${stem}-${index}${ext}`;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, "[REDACTED]")
    .slice(0, 500);
}
