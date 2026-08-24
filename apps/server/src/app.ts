import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  applyLocalRuntimeSettings,
  MODEL_ALIAS_ENV_KEYS,
  type AppConfig,
  type LocalRuntimeSettings
} from "./config.js";
import type { EventStore } from "./event-store.js";
import type { FeishuChannel } from "./feishu.js";
import type { MemoryCoordinator } from "./memory-coordinator.js";
import { MemoryStore } from "./memory-store.js";
import type { RunOrchestrator } from "./orchestrator.js";
import type { AgentRuntime, ConfigurableAgentRuntime } from "./runtime.js";
import { collectWorkspaceFileCandidates, describeCreatedWorkspaceFile, preflightClaudeRuntime } from "./runtime.js";
import { runDoctor } from "./doctor.js";
import { type AgentStore, InputAttachmentOverwriteError } from "./store.js";
import { deleteConversationData } from "./temporary-conversations.js";
import { DEFAULT_PROFILE_ID, getAgentProfile, isAgentProfileId, listAgentProfileSummaries } from "./agent-profiles.js";
import type { AdmissionsStore } from "./admissions-store.js";
import { registerAdmissionsRoutes } from "./admissions-routes.js";
import type { SchedulerStore } from "./scheduler-store.js";
import type { ScheduledJobRunner } from "./scheduler.js";
import { registerSchedulerRoutes } from "./scheduler-routes.js";
import { EvolutionStore } from "./evolution-store.js";
import { handbookDocument, parseHandbook } from "./handbook.js";
import { buildDomainCard } from "./domain-card.js";
import { EvolutionCoordinator } from "./evolution-coordinator.js";
import { parseUiLocale, rememberUiLocale } from "./locale.js";
import { playbookMatchesUsedSkills, skillLabelsFromBlocks } from "./overlay-context.js";
import type { DeliveryShelf } from "./delivery-shelf.js";
import type { LiveDomainCard } from "./domain-card-live.js";
import type { RunReplayStore } from "./run-replay.js";
import { InputFileManifestService, MAX_INPUT_FILE_BYTES } from "./input-file-manifest.js";
import { CollaborationStore } from "./collaboration-store.js";
import { getLearningDemoScenario, learningDemoText, LEARNING_DEMO_SCENARIOS } from "./learning-demos.js";
import {
  LEARNING_DIFFICULTY_TYPES,
  LearningStore,
  type LearningDatasetKind,
  type LearningDifficultyType
} from "./learning-store.js";

export interface AppDependencies {
  config: AppConfig;
  store: AgentStore;
  events: EventStore;
  orchestrator: RunOrchestrator;
  runtime: AgentRuntime;
  runtimeController?: Pick<ConfigurableAgentRuntime, "reconfigure">;
  feishu?: Pick<FeishuChannel, "configure" | "isConfigured" | "status"> &
    Partial<Pick<FeishuChannel, "senderCandidates">>;
  memories?: MemoryStore;
  memoryMaintenance?: Pick<MemoryCoordinator, "maintenanceStatus" | "scheduleMaintenance">;
  admissions?: AdmissionsStore;
  schedules?: SchedulerStore;
  scheduledRunner?: ScheduledJobRunner;
  evolution?: EvolutionStore;
  evolutionCoordinator?: EvolutionCoordinator;
  shelf?: DeliveryShelf;
  learning?: LearningStore;
  inputFiles?: InputFileManifestService;
  collaboration?: CollaborationStore;
  liveCard?: LiveDomainCard;
  replay?: RunReplayStore;
}

const updateConversationSchema = z.object({
  title: z.string().max(120).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional()
});
const messageSchema = z.object({
  content: z.string().max(200_000).default(""),
  mode: z.enum(["normal", "guide", "queue"]).default("normal"),
  attachmentIds: z.array(z.string().uuid()).max(5).default([]),
  clientMessageId: z.string().uuid().optional()
});
const branchSchema = z.object({
  content: z.string().max(200_000).optional(),
  asNewConversation: z.boolean().default(false)
});
const feishuSettingsSchema = z.object({
  appId: z.string().trim().min(3).max(128),
  appSecret: z.string().trim().min(6).max(256).optional(),
  allowedOpenIds: z.array(z.string().trim().min(1).max(128)).max(100).default([])
});
const modelMappingsSchema = z.record(z.enum(MODEL_ALIAS_ENV_KEYS), z.string().trim().max(200)).optional();
const runtimeSettingsSchema = z.object({
  provider: z.string().trim().max(64).optional(),
  modelMappings: modelMappingsSchema,
  authToken: z.string().trim().min(1).max(4_096).optional(),
  baseUrl: z
    .string()
    .trim()
    .max(2_048)
    .refine((value) => value === "" || isHttpUrl(value), "Base URL must be an HTTP or HTTPS URL")
    .default(""),
  model: z.string().trim().min(1).max(200)
});
const memoryCategorySchema = z.enum(["profile", "preference", "goal", "project", "task"]);
const memorySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  autoSave: z.boolean().optional(),
  referenceHistory: z.boolean().optional()
});
const createMemorySchema = z.object({
  category: memoryCategorySchema,
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2_000),
  keywords: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  pinned: z.boolean().default(false),
  profileId: z.string().trim().nullable().optional()
});
const updateMemorySchema = createMemorySchema.partial().extend({
  status: z.enum(["active", "superseded"]).optional()
});
const createSignalSchema = z.object({
  source: z.enum(["user", "implicit"]).default("user"),
  kind: z.enum(["thumb", "retry", "edit", "correct"]),
  polarity: z.enum(["up", "down"]),
  reason: z.string().trim().max(500).optional(),
  conversationId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  confirmAsPlaybook: z.boolean().optional(),
  playbookInstruction: z.string().trim().max(200).optional()
});
const handbookSchema = z.object({
  profileId: z.string().trim().min(1).max(64).nullable().optional(),
  markdown: z.string().max(20_000)
});
const createArtifactSchema = z.object({
  profileId: z.string().trim().min(1),
  kind: z.enum(["skill", "subagent"]),
  slug: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(8).max(240),
  body: z.string().trim().min(20).max(8_000),
  origin: z.enum(["user", "distilled"]).default("user"),
  holdForHuman: z.boolean().optional()
});
const artifactStatusSchema = z.object({
  enabled: z.boolean().optional(),
  status: z.enum(["enabled", "disabled", "rejected", "pending"]).optional()
});
const artifactReviewSchema = z.object({
  verdict: z.enum(["pass", "reject", "needs_human"]),
  reason: z.string().trim().min(1).max(400)
});
const learningDemoStartSchema = z.object({
  executionMode: z.enum(["deterministic", "agent"]).default("deterministic")
});

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, store, events, orchestrator, runtime, runtimeController, feishu } = dependencies;
  const memories = dependencies.memories ?? new MemoryStore(store.database);
  const evolution = dependencies.evolution ?? new EvolutionStore(store.database);
  const evolutionCoordinator =
    dependencies.evolutionCoordinator ?? new EvolutionCoordinator(config, evolution, memories);
  const learning = dependencies.learning ?? new LearningStore(store.database);
  const inputFiles = dependencies.inputFiles ?? new InputFileManifestService(store, config.workspaceRoot);
  const collaboration = dependencies.collaboration ?? new CollaborationStore(store.database);
  const learningDetail = (conversationId: string) => {
    const session = learning.getSessionForConversation(conversationId);
    if (!session) return null;
    return {
      ...session,
      incidents: learning.listIncidents(session.id).map((incident) => ({
        ...incident,
        interventions: learning.listInterventions(incident.id),
        verifications: learning.listVerifications(incident.id)
      }))
    };
  };
  const presentConversation = (conversation: NonNullable<ReturnType<AgentStore["getConversation"]>>) => {
    const presented = evolution.decorateConversation(memories.decorateConversation(conversation));
    return {
      ...presented,
      messages: presented.messages.map((message) => {
        if (message.role !== "assistant") return message;
        const trace = collaboration.traceForMessage(message.id);
        if (!trace) return message;
        return {
          ...message,
          collaboration: {
            tasks: trace.tasks.map((task) => ({
              id: task.id,
              runId: task.runId,
              assistantMessageId: task.assistantMessageId,
              specialistId: task.specialistId,
              displayName: task.displayName,
              sourceTaskId: task.sourceTaskId,
              requestSummary: task.requestSummary,
              status: task.status,
              resultSummary: task.resultSummary,
              structured: task.structured,
              result: task.result,
              error: task.error,
              createdAt: new Date(task.createdAt).toISOString(),
              startedAt: task.startedAt === null ? null : new Date(task.startedAt).toISOString(),
              finishedAt: task.finishedAt === null ? null : new Date(task.finishedAt).toISOString()
            })),
            handoffs: trace.handoffs.map((handoff) => ({
              id: handoff.id,
              runId: handoff.runId,
              sourceTaskId: handoff.sourceTaskId,
              targetTaskId: handoff.targetTaskId,
              question: handoff.question,
              status: handoff.status,
              error: handoff.error,
              createdAt: new Date(handoff.createdAt).toISOString(),
              finishedAt: handoff.finishedAt === null ? null : new Date(handoff.finishedAt).toISOString()
            })),
            summary: trace.summary
          }
        };
      })
    };
  };
  const conversationDetail = async (id: string) => {
    const conversation = store.getConversation(id);
    if (!conversation) return null;
    await recoverGeneratedWorkspaceFiles(store, config.workspaceRoot, conversation);
    const next = store.getConversation(id);
    if (!next) return null;
    const presented = presentConversation(next);
    const replay = dependencies.replay?.markForConversation(presented.id);
    return {
      ...presented,
      pendingQuestion: orchestrator.pendingQuestion(presented.activeRunId),
      learningSession: learningDetail(presented.id),
      replay: replay
        ? {
            sourceRunId: replay.sourceRunId,
            mode: replay.mode,
            includeArtifactId: replay.includeArtifactId ?? null,
            prompt: replay.prompt,
            overlay: replay.overlay
          }
        : null
    };
  };
  const captureLiveCard = () => {
    const profileId = "graduate-admissions";
    dependencies.liveCard?.capture(profileId, memories.stableContext(profileId), dependencies.admissions);
  };
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.body.apiKey",
        "req.body.authToken",
        "req.body.appSecret",
        "res.headers.set-cookie"
      ]
    },
    bodyLimit: 2 * 1024 * 1024
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) callback(null, true);
      else callback(new Error("Only local web clients are allowed"), false);
    }
  });
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_INPUT_FILE_BYTES, fields: 5 }
  });
  if (dependencies.admissions) registerAdmissionsRoutes(app, dependencies.admissions, config, captureLiveCard);
  if (dependencies.schedules && dependencies.scheduledRunner) {
    registerSchedulerRoutes(app, dependencies.schedules, dependencies.scheduledRunner);
  }

  app.get("/api/health", async () => ({
    ok: true,
    runtime: runtime.kind,
    claudeAuthSource: config.claudeAuthSource,
    claudeSettingsMode: config.claudeSettingsMode,
    feishuConfigured: feishu?.isConfigured() ?? Boolean(config.feishu),
    timestamp: new Date().toISOString()
  }));

  app.get("/api/capabilities", async () => ({
    runtime: runtime.kind,
    claudeConfigured: config.claudeAuthConfigured,
    claudeAuthSource: config.claudeAuthSource,
    claudeSettingsMode: config.claudeSettingsMode,
    feishuConfigured: feishu?.isConfigured() ?? Boolean(config.feishu),
    limits: {
      maxAttachments: 5,
      maxAttachmentBytes: MAX_INPUT_FILE_BYTES,
      acceptedMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json"
      ]
    },
    features: {
      archive: true,
      branching: true,
      interrupt: true,
      guide: true,
      queue: true,
      toolTimeline: true,
      approvals: false,
      memory: true,
      temporaryChats: true
    }
  }));

  app.get("/api/agent-profiles", async () => ({ items: listAgentProfileSummaries() }));

  app.get(
    "/api/channels/feishu",
    async () =>
      feishu?.status() ?? {
        configured: Boolean(config.feishu),
        connected: false,
        appId: config.feishu?.appId ?? "",
        hasSecret: Boolean(config.feishu?.appSecret),
        allowedOpenIds: [...(config.feishu?.allowedOpenIds ?? [])],
        error: null
      }
  );

  /** Recent direct-message senders, so the owner can copy their own open_id into the allowlist. */
  app.get("/api/channels/feishu/candidates", async () => ({
    items: feishu?.senderCandidates?.() ?? []
  }));

  const runtimeConfigStatus = () => {
    const stored = store.getSetting<LocalRuntimeSettings>("runtime.config");
    return {
      runtime: runtime.kind,
      authConfigured: config.claudeAuthConfigured,
      authSource: config.claudeAuthSource,
      hasAuthToken: Boolean(stored?.authToken || config.anthropicAuthToken),
      baseUrl: config.anthropicBaseUrl ?? "",
      model: config.model,
      provider: config.modelProvider ?? stored?.provider ?? "",
      modelMappings: config.modelAliasEnv ?? {}
    };
  };

  app.get("/api/runtime/config", async () => runtimeConfigStatus());

  app.put("/api/runtime/config", async (request, reply) => {
    if (!runtimeController) return reply.code(503).send({ error: "Runtime configuration is unavailable" });
    const input = runtimeSettingsSchema.parse(request.body ?? {});
    const stored = store.getSetting<LocalRuntimeSettings>("runtime.config");
    const authToken = input.authToken ?? stored?.authToken;
    if (!authToken && !config.claudeAuthConfigured) {
      return reply.code(400).send({ error: "首次配置需要填写 ANTHROPIC_AUTH_TOKEN" });
    }
    const next: LocalRuntimeSettings = {
      baseUrl: input.baseUrl,
      model: input.model,
      ...(authToken ? { authToken } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.modelMappings ? { modelMappings: input.modelMappings } : {})
    };
    store.setSetting("runtime.config", next);
    applyLocalRuntimeSettings(config, next);
    runtimeController.reconfigure();
    return runtimeConfigStatus();
  });

  const runtimeTestSchema = z.object({
    authToken: z.string().trim().min(6).max(512).optional(),
    baseUrl: z.union([z.string().trim().url(), z.literal("")]).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    modelMappings: modelMappingsSchema
  });

  app.post("/api/runtime/test", async (request, reply) => {
    const input = runtimeTestSchema.parse(request.body ?? {});
    if (!input.authToken && !config.claudeAuthConfigured) {
      return reply.code(200).send({
        ok: false,
        error: "no-credentials"
      });
    }
    const overrides: {
      authToken?: string;
      baseUrl?: string;
      model?: string;
      modelMappings?: Record<string, string>;
    } = {};
    if (input.authToken) overrides.authToken = input.authToken;
    if (input.baseUrl !== undefined) overrides.baseUrl = input.baseUrl;
    if (input.model) overrides.model = input.model;
    if (input.modelMappings) overrides.modelMappings = input.modelMappings;
    return preflightClaudeRuntime(config, overrides);
  });

  app.get("/api/diagnostics", async () => {
    const feishuStatus = feishu?.status();
    return runDoctor(config, {
      feishuConfigured: feishu?.isConfigured() ?? Boolean(config.feishu),
      ...(feishuStatus ? { feishuConnected: feishuStatus.connected } : {}),
      allowedOpenIdsCount: feishuStatus?.allowedOpenIds?.length ?? config.feishu?.allowedOpenIds.size ?? 0,
      includeExternalTools: config.nodeEnv !== "test",
      webDistPresent: fs.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist"))
    });
  });

  const onboardingStateSchema = z.object({ completed: z.boolean() });

  app.get("/api/onboarding-state", async () => ({
    completed: store.getSetting<boolean>("onboarding.completed") ?? false
  }));

  app.put("/api/onboarding-state", async (request, reply) => {
    const input = onboardingStateSchema.safeParse(request.body ?? {});
    if (!input.success) return reply.code(400).send({ error: "completed must be a boolean" });
    store.setSetting("onboarding.completed", input.data.completed);
    return { completed: input.data.completed };
  });

  app.get("/api/memory/settings", async () => memories.getSettings());

  app.put("/api/memory/settings", async (request) => {
    const input = memorySettingsSchema.parse(request.body ?? {});
    const changes: { enabled?: boolean; autoSave?: boolean; referenceHistory?: boolean } = {};
    if (input.enabled !== undefined) changes.enabled = input.enabled;
    if (input.autoSave !== undefined) changes.autoSave = input.autoSave;
    if (input.referenceHistory !== undefined) changes.referenceHistory = input.referenceHistory;
    return memories.updateSettings(changes);
  });

  app.get(
    "/api/memory/maintenance",
    async () => dependencies.memoryMaintenance?.maintenanceStatus() ?? memories.getMaintenanceStatus()
  );

  app.post("/api/memory/maintenance", async (_request, reply) => {
    if (!dependencies.memoryMaintenance) {
      return reply.code(503).send({ error: "Memory maintenance is unavailable" });
    }
    const status = dependencies.memoryMaintenance.scheduleMaintenance(true);
    return reply.code(202).send(status);
  });

  app.get("/api/memories", async (request) => {
    const query = request.query as { category?: string; query?: string; q?: string };
    const category = query.category ? memoryCategorySchema.parse(query.category) : undefined;
    return {
      items: memories.list({
        ...(category ? { category } : {}),
        query: query.query ?? query.q ?? ""
      })
    };
  });

  app.post("/api/memories", async (request, reply) => {
    const input = createMemorySchema.parse(request.body ?? {});
    const scope = memoryScopeForCategory(input.category, input.profileId);
    if (scope instanceof Error) return reply.code(400).send({ error: scope.message });
    const memory = memories.create({ ...input, ...scope, sourceKind: "manual" });
    return reply.code(201).send(memory);
  });

  app.patch("/api/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateMemorySchema.parse(request.body ?? {});
    const current = memories.get(id);
    if (!current) return reply.code(404).send({ error: "Memory not found" });
    const requestedProfileId = input.profileId === undefined ? current.profileId : input.profileId;
    const scope = memoryScopeForCategory(input.category ?? current.category, requestedProfileId);
    if (scope instanceof Error) return reply.code(400).send({ error: scope.message });
    const changes: Parameters<MemoryStore["update"]>[1] = {};
    if (input.category !== undefined) changes.category = input.category;
    if (input.title !== undefined) changes.title = input.title;
    if (input.content !== undefined) changes.content = input.content;
    if (input.keywords !== undefined) changes.keywords = input.keywords;
    if (input.importance !== undefined) changes.importance = input.importance;
    if (input.pinned !== undefined) changes.pinned = input.pinned;
    if (input.status !== undefined) changes.status = input.status;
    changes.scope = scope.scope;
    changes.profileId = scope.profileId;
    return memories.update(id, changes)!;
  });

  app.delete("/api/memories/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    return memories.delete(id) ? reply.code(204).send() : reply.code(404).send({ error: "Memory not found" });
  });

  app.delete("/api/memories", async (_request, reply) => {
    const deleted = memories.clear();
    return reply.send({ deleted });
  });

  app.post("/api/memory/mutations/:id/undo", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { memory: memories.undoMutation(id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to undo memory change";
      const status = /not found/i.test(message) ? 404 : 409;
      return reply.code(status).send({ error: message });
    }
  });

  app.get("/api/conversations/:id/learning-session", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "Conversation not found" });
    return { session: learningDetail(id) };
  });

  app.post("/api/conversations/:id/learning-session", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
    if (conversation.channel !== "web")
      return reply.code(400).send({ error: "Learning mode v1 is available on the web only" });
    const input = z
      .object({
        goal: z.string().trim().min(1).max(500),
        topicKey: z.string().trim().max(100).nullable().optional()
      })
      .parse(request.body ?? {});
    let session = learning.getSessionForConversation(id);
    if (session?.status === "suggested") {
      session = learning.updateSessionDetails(session.id, {
        goal: input.goal,
        ...(input.topicKey !== undefined ? { topicKey: input.topicKey } : {})
      });
      session = learning.transitionSession(session.id, "active");
    } else if (session) {
      return reply
        .code(409)
        .send({ error: "A learning session already exists for this conversation", session: learningDetail(id) });
    } else {
      session = learning.createSession({
        conversationId: id,
        profileId: conversation.profileId,
        goal: input.goal,
        ...(input.topicKey !== undefined ? { topicKey: input.topicKey } : {}),
        datasetKind: "live",
        status: "active"
      });
    }
    events.append({
      type: "learning.session.updated",
      conversationId: id,
      branchId: conversation.activeBranchId,
      payload: { session }
    });
    return reply.code(201).send({ session: learningDetail(id) });
  });

  app.patch("/api/conversations/:id/learning-session", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.getConversation(id);
    const current = learning.getSessionForConversation(id);
    if (!conversation || !current) return reply.code(404).send({ error: "Learning session not found" });
    const input = z
      .object({
        status: z.enum(["active", "paused", "completed", "dismissed"]).optional(),
        goal: z.string().trim().min(1).max(500).optional(),
        topicKey: z.string().trim().max(100).nullable().optional()
      })
      .parse(request.body ?? {});
    let session =
      input.goal !== undefined || input.topicKey !== undefined
        ? learning.updateSessionDetails(current.id, {
            ...(input.goal !== undefined ? { goal: input.goal } : {}),
            ...(input.topicKey !== undefined ? { topicKey: input.topicKey } : {})
          })
        : current;
    if (input.status && input.status !== session.status) session = learning.transitionSession(session.id, input.status);
    events.append({
      type: session.status === "suggested" ? "learning.suggested" : "learning.session.updated",
      conversationId: id,
      branchId: conversation.activeBranchId,
      payload: { session }
    });
    return { session: learningDetail(id) };
  });

  app.post("/api/learning/verifications/:id/confirm", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = learning.getVerification(id);
    if (!before) return reply.code(404).send({ error: "Learning verification not found" });
    const input = z.object({ verdict: z.enum(["resolved", "partial", "unresolved"]) }).parse(request.body ?? {});
    const verification = learning.confirmVerification(id, input.verdict);
    const incident = learning.getIncident(verification.incidentId)!;
    const session = learning.getSessionForIncident(incident.id)!;
    const conversation = store.getConversation(session.conversationId);
    if (conversation) {
      events.append({
        type: "learning.incident.updated",
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        payload: { incident }
      });
    }
    const policy = learning.maybeCreatePendingPolicyRevision({
      profileId: session.profileId,
      topicKey: session.topicKey,
      difficultyType: incident.difficultyType,
      datasetKind: session.datasetKind
    });
    if (policy && conversation) {
      events.append({
        type: "learning.policy.updated",
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        payload: { policy }
      });
    }
    return { verification, incident, policy };
  });

  app.get("/api/learning/policies", async (request, reply) => {
    const query = request.query as {
      profileId?: string;
      topicKey?: string;
      difficultyType?: string;
      datasetKind?: string;
      includeDisabled?: string;
    };
    if (!query.profileId) return reply.code(400).send({ error: "profileId is required" });
    const datasetKind = (query.datasetKind === "demo" ? "demo" : "live") as Exclude<LearningDatasetKind, "replay">;
    const difficultyType =
      query.difficultyType && LEARNING_DIFFICULTY_TYPES.includes(query.difficultyType as LearningDifficultyType)
        ? (query.difficultyType as LearningDifficultyType)
        : undefined;
    return {
      policies: learning.listPolicies({
        profileId: query.profileId,
        ...(query.topicKey !== undefined ? { topicKey: query.topicKey } : {}),
        datasetKind,
        ...(difficultyType ? { difficultyType } : {}),
        includeDisabled: query.includeDisabled === "true"
      })
    };
  });

  app.post("/api/learning/policies/:id/review", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!learning.getPolicyRevision(id)) return reply.code(404).send({ error: "Learning policy not found" });
    const input = z
      .object({ verdict: z.enum(["pass", "reject"]), conversationId: z.string().uuid().optional() })
      .parse(request.body ?? {});
    const policy = learning.reviewPolicyRevision(id, input.verdict === "pass" ? "enabled" : "rejected");
    const conversation = input.conversationId ? store.getConversation(input.conversationId) : null;
    if (conversation)
      events.append({
        type: "learning.policy.updated",
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        payload: { policy }
      });
    return { policy };
  });

  app.post("/api/learning/policies/:id/rollback", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!learning.getPolicyRevision(id)) return reply.code(404).send({ error: "Learning policy not found" });
    const input = z.object({ conversationId: z.string().uuid().optional() }).parse(request.body ?? {});
    const policy = learning.rollbackPolicyRevision(id);
    const conversation = input.conversationId ? store.getConversation(input.conversationId) : null;
    if (conversation)
      events.append({
        type: "learning.policy.updated",
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        payload: { policy }
      });
    return { policy };
  });

  app.get("/api/learning/demo-scenarios", async (request) => {
    const locale = parseUiLocale(request.headers["accept-language"]);
    const agentAvailable = runtime.kind === "claude";
    return {
      scenarios: LEARNING_DEMO_SCENARIOS.map((scenario) => {
        const localized = learningDemoText(scenario, locale);
        return {
          id: scenario.id,
          title: localized.title,
          description: localized.description,
          preview: localized.preview,
          loop: localized.loop,
          goal: localized.goal,
          topicKey: scenario.topicKey,
          difficultyType: scenario.difficultyType,
          agentAvailable,
          synthetic: true as const
        };
      })
    };
  });

  app.post("/api/learning/demo-scenarios/:id/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    const scenario = getLearningDemoScenario(id);
    if (!scenario) return reply.code(404).send({ error: "Learning demo scenario not found" });
    const { executionMode } = learningDemoStartSchema.parse(request.body ?? {});
    if (executionMode === "agent" && runtime.kind !== "claude") {
      return reply.code(409).send({ error: "Real Agent demo requires an active Claude runtime" });
    }
    const locale = rememberUiLocale(store, request.headers["accept-language"]);
    const localized = learningDemoText(scenario, locale);
    const conversation = store.createConversation(
      "web",
      `${executionMode === "agent" ? (locale === "en" ? "Agent demo" : "Agent 演示") : locale === "en" ? "Synthetic demo" : "合成演示"} · ${localized.title}`,
      { profileId: "local-operator" }
    );
    try {
      const session = learning.createSession({
        conversationId: conversation.id,
        profileId: "local-operator",
        goal: localized.goal,
        topicKey: scenario.topicKey,
        datasetKind: "demo",
        executionMode,
        status: "active"
      });
      learning.seedDemoExperiences(session.id, scenario.difficultyType, [...scenario.seeds], locale);
      const policy = learning.maybeCreatePendingPolicyRevision({
        profileId: session.profileId,
        topicKey: session.topicKey,
        difficultyType: scenario.difficultyType,
        datasetKind: "demo"
      });
      events.append({
        type: "learning.session.updated",
        conversationId: conversation.id,
        branchId: conversation.activeBranchId,
        payload: { session, synthetic: true, executionMode }
      });
      if (policy)
        events.append({
          type: "learning.policy.updated",
          conversationId: conversation.id,
          branchId: conversation.activeBranchId,
          payload: { policy, synthetic: true }
        });
      const run = orchestrator.submit(conversation.id, localized.initialPrompt, "normal");
      return reply.code(202).send({
        scenario: {
          id: scenario.id,
          title: localized.title,
          description: localized.description,
          preview: localized.preview,
          loop: localized.loop,
          goal: localized.goal,
          topicKey: scenario.topicKey,
          difficultyType: scenario.difficultyType,
          agentAvailable: runtime.kind === "claude",
          executionMode,
          synthetic: true
        },
        run,
        conversation: await conversationDetail(conversation.id)
      });
    } catch (error) {
      await deleteConversationData(store, config.workspaceRoot, conversation.id);
      throw error;
    }
  });

  app.post("/api/signals", async (request, reply) => {
    const input = createSignalSchema.parse(request.body ?? {});
    const message = input.messageId ? store.getMessage(input.messageId) : null;
    if (input.messageId && !message) return reply.code(404).send({ error: "Message not found" });
    const conversationId = input.conversationId ?? message?.conversationId ?? null;
    const conversation = conversationId ? store.getConversation(conversationId) : null;
    if (conversationId && !conversation) return reply.code(404).send({ error: "Conversation not found" });
    const runId = input.runId ?? message?.runId ?? null;
    const overlay = runId ? evolution.overlayForRun(runId) : null;
    const signal = evolution.createSignal({
      source: input.source,
      kind: input.kind,
      polarity: input.polarity,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      profileId: conversation?.profileId ?? null,
      conversationId,
      messageId: message?.id ?? null,
      runId,
      overlayRevision: overlay?.id ?? null
    });
    if (input.polarity === "up") {
      const usedSkills = skillLabelsFromBlocks(message?.blocks ?? []);
      for (const playbookId of overlay?.playbookIds ?? []) {
        const playbook = evolution.getPlaybook(playbookId);
        if (playbook && playbookMatchesUsedSkills(playbook, usedSkills)) {
          evolution.updatePlaybook(playbookId, { origin: "confirmed" });
        }
      }
      const instruction = input.playbookInstruction?.trim() || (input.confirmAsPlaybook ? input.reason?.trim() : "");
      if (input.confirmAsPlaybook && instruction && conversation?.profileId) {
        evolution.createPlaybook({
          title: instruction.slice(0, 80),
          instruction,
          polarity: /不要|别再|避免|dont\b/i.test(instruction) ? "dont" : "do",
          origin: "confirmed",
          scope: "profile",
          profileId: conversation.profileId,
          sourceRunId: runId,
          sourceSignalId: signal.id
        });
      }
    }
    return reply.code(201).send(signal);
  });

  app.get("/api/handbook", async (request, reply) => {
    const profileId = requestedProfileId((request.query as { profileId?: string }).profileId);
    if (!profileId) return reply.code(400).send({ error: "手册需要指定助手" });
    return handbookDocument("工作手册", profileId, evolution.listPlaybooks(profileId, true));
  });

  app.put("/api/handbook", async (request, reply) => {
    const input = handbookSchema.parse(request.body ?? {});
    const profileId = requestedProfileId(input.profileId);
    if (!profileId) return reply.code(400).send({ error: "手册需要指定助手" });
    const parsed = parseHandbook(input.markdown);
    if (parsed.errors.length > 0) {
      return reply.code(400).send({ error: parsed.errors[0], errors: parsed.errors });
    }
    try {
      const playbooks = evolution.replacePlaybooks(
        profileId,
        parsed.items.map((item) => ({
          ...item,
          scope: "profile"
        }))
      );
      return handbookDocument("工作手册", profileId, playbooks);
    } catch (error) {
      const message = error instanceof Error ? error.message : "手册未能保存";
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/api/domain-card", async (request, reply) => {
    const profileId = requestedProfileId((request.query as { profileId?: string }).profileId);
    if (!profileId) return reply.code(400).send({ error: "作战卡需要指定助手" });
    const captured =
      dependencies.liveCard?.capture(profileId, memories.stableContext(profileId), dependencies.admissions) ??
      buildDomainCard(profileId, memories.stableContext(profileId), dependencies.admissions);
    if (!captured) return null;
    const latest = dependencies.liveCard?.latest(profileId);
    return {
      profileId: captured.profileId,
      title: captured.title,
      lines: captured.lines,
      ...(latest ? { patch: latest.patch, createdAt: new Date(latest.createdAt).toISOString() } : {})
    };
  });

  app.get("/api/equipment", async (request, reply) => {
    const profileId = requestedProfileId((request.query as { profileId?: string }).profileId);
    if (!profileId) return reply.code(400).send({ error: "能力列表需要指定助手" });
    return evolutionCoordinator.equipment(profileId);
  });

  app.get("/api/evolved-artifacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifact = evolution.getArtifact(id);
    return artifact ? artifact : reply.code(404).send({ error: "Artifact not found" });
  });

  app.post("/api/evolved-artifacts", async (request, reply) => {
    const input = createArtifactSchema.parse(request.body ?? {});
    if (!isAgentProfileId(input.profileId)) return reply.code(400).send({ error: "Unknown agent profile" });
    const artifact = await evolutionCoordinator.propose({
      ...input,
      holdForHuman: input.holdForHuman === true
    });
    return reply.code(201).send(artifact);
  });

  app.patch("/api/evolved-artifacts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = artifactStatusSchema.parse(request.body ?? {});
    const artifact =
      input.enabled !== undefined
        ? await evolutionCoordinator.setEnabled(id, input.enabled)
        : input.status === "disabled"
          ? await evolutionCoordinator.rollback(id)
          : evolution.getArtifact(id);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    if (input.enabled === true && artifact.status !== "enabled") {
      return reply.code(409).send({ error: artifact.evaluation?.reason ?? "未能启用这条能力", artifact });
    }
    return artifact;
  });

  app.post("/api/evolved-artifacts/:id/review", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = artifactReviewSchema.parse(request.body ?? {});
    const artifact = await evolutionCoordinator.review(id, input.verdict, input.reason);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    if (input.verdict === "pass" && artifact.status !== "enabled") {
      return reply.code(409).send({ error: artifact.evaluation?.reason ?? "硬检查未通过，不能启用", artifact });
    }
    return artifact;
  });

  app.put("/api/channels/feishu", async (request, reply) => {
    if (!feishu) return reply.code(503).send({ error: "Feishu configuration is unavailable" });
    const input = feishuSettingsSchema.parse(request.body ?? {});
    const stored = store.getSetting<{ appId: string; appSecret: string; allowedOpenIds: string[] }>("feishu.config");
    const appSecret = input.appSecret ?? stored?.appSecret ?? config.feishu?.appSecret;
    if (!appSecret) return reply.code(400).send({ error: "App Secret is required for the first connection" });
    const next = {
      appId: input.appId,
      appSecret,
      allowedOpenIds: new Set(input.allowedOpenIds)
    };
    try {
      await feishu.configure(next);
      store.setSetting("feishu.config", {
        appId: next.appId,
        appSecret: next.appSecret,
        allowedOpenIds: [...next.allowedOpenIds]
      });
      return feishu.status();
    } catch (error) {
      request.log.warn({ err: error }, "Feishu configuration test failed");
      return reply.code(400).send({ error: "无法连接飞书，请检查 App ID、App Secret 与应用状态" });
    }
  });

  app.get("/api/conversations", async (request) => {
    const query = request.query as { state?: string; query?: string; q?: string };
    const state = query.state === "archived" ? "archived" : "active";
    return { items: store.listConversations(state, query.query ?? query.q ?? "") };
  });

  app.post("/api/conversations", async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string;
      channel?: "web" | "feishu";
      temporary?: boolean;
      profileId?: string;
    };
    const channel = body.channel ?? "web";
    if (body.temporary && channel !== "web") {
      return reply.code(400).send({ error: "Temporary conversations are only available on the web" });
    }
    const profileId = body.profileId ?? DEFAULT_PROFILE_ID;
    if (!isAgentProfileId(profileId)) {
      return reply.code(400).send({ error: "Unknown agent profile" });
    }
    if (!getAgentProfile(profileId).channelPolicy[channel]) {
      return reply.code(400).send({ error: "Agent profile is unavailable on this channel" });
    }
    const conversation = store.createConversation(channel, body.title?.trim() || "新对话", {
      profileId,
      temporary: body.temporary === true,
      ...(body.temporary ? { expiresAt: Date.now() + 24 * 60 * 60_000 } : {})
    });
    events.append({
      type: "conversation.updated",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { conversation }
    });
    return reply.code(201).send(presentConversation(conversation));
  });

  app.get("/api/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await conversationDetail(id);
    return conversation
      ? { ...conversation, events: events.list(id) }
      : reply.code(404).send({ error: "Conversation not found" });
  });

  app.patch("/api/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateConversationSchema.parse(request.body);
    const before = store.getConversation(id);
    if (before?.temporary && (input.archived !== undefined || input.pinned !== undefined)) {
      return reply.code(400).send({ error: "Temporary conversations cannot be archived or pinned" });
    }
    if (input.archived === true) await orchestrator.interruptConversationAndWait(id);
    const changes: { title?: string; pinned?: boolean; archived?: boolean } = {};
    if (input.title !== undefined) changes.title = input.title;
    if (input.pinned !== undefined) changes.pinned = input.pinned;
    if (input.archived !== undefined) changes.archived = input.archived;
    const conversation = store.updateConversation(id, changes);
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
    const type =
      input.archived === true
        ? "conversation.archived"
        : input.archived === false
          ? "conversation.unarchived"
          : "conversation.updated";
    events.append({
      type,
      conversationId: id,
      branchId: conversation.activeBranchId,
      payload: { conversation }
    });
    return presentConversation(conversation);
  });

  app.delete("/api/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = store.getConversation(id);
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
    await orchestrator.interruptConversationAndWait(id);
    events.append({
      type: "conversation.deleted",
      conversationId: id,
      branchId: conversation.activeBranchId,
      payload: { conversationId: id }
    });
    await deleteConversationData(store, config.workspaceRoot, id);
    return reply.code(204).send();
  });

  app.post("/api/conversations/:id/messages", async (request, reply) => {
    rememberUiLocale(store, request.headers["accept-language"]);
    const { id } = request.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "Conversation not found" });
    const input = messageSchema.parse(request.body);
    if (input.clientMessageId) {
      const existing = store.getMessageByClientMessageId(id, input.clientMessageId);
      if (existing?.runId) {
        const run = store.getRun(existing.runId);
        if (run) {
          const acceptedAs =
            existing.id === run.userMessageId ? (run.mode === "queue" ? "queued" : "new_run") : "supplement";
          return reply.code(202).send({
            message: existing,
            runId: run.id,
            acceptedAs,
            conversation: await conversationDetail(id)
          });
        }
      }
    }
    const wasBusy = orchestrator.isConversationBusy(id);
    if (wasBusy && input.mode !== "queue") {
      const accepted = await orchestrator.supplement(id, input.content, input.attachmentIds, input.clientMessageId);
      if (accepted) {
        return reply.code(202).send({
          message: accepted.message,
          runId: accepted.run.id,
          acceptedAs: "supplement",
          conversation: await conversationDetail(id)
        });
      }
    }
    const run = orchestrator.submit(id, input.content, input.mode, input.attachmentIds, input.clientMessageId);
    return reply.code(202).send({
      message: store.getMessage(run.userMessageId),
      runId: run.id,
      acceptedAs: wasBusy && input.mode === "queue" ? "queued" : "new_run",
      conversation: await conversationDetail(id)
    });
  });

  app.post("/api/runs/:id/interrupt", async (request, reply) => {
    const { id } = request.params as { id: string };
    return orchestrator.interrupt(id)
      ? reply.code(202).send({ runId: id, status: "interrupting" })
      : reply.code(404).send({ error: "Active or queued run not found" });
  });

  app.post("/api/runs/:id/answers", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = z.object({ answers: z.record(z.string(), z.string().trim().min(1)) }).parse(request.body ?? {});
    return orchestrator.answerQuestion(id, input.answers)
      ? reply.code(202).send({ runId: id, accepted: true })
      : reply.code(404).send({ error: "No pending question for this run" });
  });

  app.get("/api/shelf", async (request, reply) => {
    const profileId = requestedProfileId((request.query as { profileId?: string }).profileId);
    if (!profileId) return reply.code(400).send({ error: "货架需要指定助手" });
    const query = String((request.query as { query?: string }).query ?? "");
    const items = query.trim() ? dependencies.shelf?.search(profileId, query) : dependencies.shelf?.list(profileId);
    return {
      items: (items ?? []).map((item) => ({
        id: item.id,
        profileId: item.profileId,
        conversationId: item.conversationId,
        fileName: item.fileName,
        mimeType: item.mimeType,
        relativePath: item.relativePath,
        createdAt: new Date(item.createdAt).toISOString()
      }))
    };
  });

  app.get("/api/shelf/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const shelf = dependencies.shelf;
    const item = shelf?.get(id);
    if (!shelf || !item) return reply.code(404).send({ error: "Shelf item not found" });
    const absolute = shelf.fileAbsolutePath(item, config.workspaceRoot);
    if (!absolute) return reply.code(404).send({ error: "Shelf file is missing" });
    const forceDownload = (request.query as { download?: string }).download === "1";
    const inline = !forceDownload && isInlinePreviewable(item.mimeType, item.fileName);
    return reply
      .header("Content-Type", item.mimeType || "application/octet-stream")
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.fileName)}`
      )
      .send(fs.createReadStream(absolute));
  });

  app.delete("/api/shelf/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = dependencies.shelf?.remove(id);
    if (!removed) return reply.code(404).send({ error: "Shelf item not found" });
    return reply.code(204).send();
  });

  app.get("/api/runs/:id/snapshot", async (request, reply) => {
    const { id } = request.params as { id: string };
    const snapshot = dependencies.replay?.getByRun(id);
    return snapshot
      ? {
          id: snapshot.id,
          runId: snapshot.runId,
          conversationId: snapshot.conversationId,
          profileId: snapshot.profileId,
          prompt: snapshot.prompt,
          createdAt: new Date(snapshot.createdAt).toISOString()
        }
      : reply.code(404).send({ error: "Snapshot not found" });
  });

  app.get("/api/snapshots/latest", async (request, reply) => {
    const profileId = requestedProfileId((request.query as { profileId?: string }).profileId);
    if (!profileId) return reply.code(400).send({ error: "回放需要指定助手" });
    const snapshot = dependencies.replay?.latestForProfile(profileId);
    return snapshot
      ? {
          id: snapshot.id,
          runId: snapshot.runId,
          conversationId: snapshot.conversationId,
          profileId: snapshot.profileId,
          prompt: snapshot.prompt,
          createdAt: new Date(snapshot.createdAt).toISOString()
        }
      : reply.code(404).send({ error: "Snapshot not found" });
  });

  app.post("/api/runs/:id/replay", async (request, reply) => {
    rememberUiLocale(store, request.headers["accept-language"]);
    const { id } = request.params as { id: string };
    const input = z.object({ includeArtifactId: z.string().uuid().optional() }).parse(request.body ?? {});
    const snapshot = dependencies.replay?.getByRun(id);
    if (!snapshot || !dependencies.replay) return reply.code(404).send({ error: "Snapshot not found" });
    let includedArtifact: ReturnType<EvolutionStore["getArtifact"]> = null;
    if (input.includeArtifactId) {
      includedArtifact = evolution.getArtifact(input.includeArtifactId);
      if (!includedArtifact || includedArtifact.profileId !== snapshot.profileId) {
        return reply.code(400).send({ error: "Artifact does not belong to this snapshot" });
      }
      if (includedArtifact.status !== "pending" && includedArtifact.status !== "enabled") {
        return reply.code(400).send({ error: "Artifact is not pending or enabled" });
      }
    }
    const source = store.getConversation(snapshot.conversationId);
    const withArtifact = Boolean(input.includeArtifactId);
    const created = store.createConversation(
      "web",
      `${withArtifact ? "回放（启用后）" : "回放"} · ${source?.title ?? "对话"}`,
      {
        profileId: snapshot.profileId
      }
    );
    const workspacePath = path.join(config.workspaceRoot, created.id);
    if (!dependencies.replay.restoreInto(id, workspacePath)) {
      await deleteConversationData(store, config.workspaceRoot, created.id);
      return reply.code(409).send({ error: "Replay workspace could not be restored" });
    }
    const overlay = { ...snapshot.overlay };
    const replayAttachmentIds: string[] = [];
    const seenReplayPaths = new Set<string>();
    for (const file of snapshot.overlay.inputFiles ?? []) {
      if (seenReplayPaths.has(file.relativePath)) continue;
      seenReplayPaths.add(file.relativePath);
      const root = path.resolve(workspacePath);
      const absolute = path.resolve(root, file.relativePath);
      const relative = path.relative(root, absolute);
      try {
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe path");
        const buffer = await fsp.readFile(absolute);
        const sha256 = createHash("sha256").update(buffer).digest("hex");
        if (buffer.length !== file.size || sha256 !== file.sha256) throw new Error("content mismatch");
        const attachment = store.createAttachment({
          conversationId: created.id,
          fileName: file.originalFileName,
          storedName: path.basename(file.relativePath),
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          relativePath: file.relativePath
        });
        replayAttachmentIds.push(attachment.id);
      } catch {
        await deleteConversationData(store, config.workspaceRoot, created.id);
        return reply.code(409).send({ error: `Replay input file is missing or changed: ${file.originalFileName}` });
      }
    }
    if (input.includeArtifactId && !overlay.artifactIds.includes(input.includeArtifactId)) {
      overlay.artifactIds = [...overlay.artifactIds, input.includeArtifactId];
    }
    if (includedArtifact) {
      const frozenArtifacts =
        snapshot.overlay.artifacts ??
        snapshot.overlay.artifactIds
          .map((artifactId) => evolution.getArtifact(artifactId))
          .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
      overlay.artifacts = [
        ...frozenArtifacts.filter((artifact) => artifact.id !== includedArtifact.id),
        includedArtifact
      ];
    }
    if (snapshot.overlay.learning) {
      const replaySession = learning.createSession({
        conversationId: created.id,
        profileId: snapshot.profileId,
        goal: snapshot.overlay.learning.goal,
        topicKey: snapshot.overlay.learning.topicKey,
        datasetKind: "replay",
        status: "active"
      });
      overlay.learning = {
        ...snapshot.overlay.learning,
        ...replaySession,
        datasetKind: "replay",
        status: "active",
        incidents: snapshot.overlay.learning.incidents
      };
    }
    dependencies.replay.pinConversation(created.id, {
      sourceRunId: snapshot.runId,
      mode: withArtifact ? "with-artifact" : "frozen",
      includeArtifactId: input.includeArtifactId ?? null,
      prompt: snapshot.prompt,
      overlay
    });
    const run = orchestrator.submit(created.id, snapshot.prompt, "normal", replayAttachmentIds);
    return reply.code(202).send({ run, conversation: await conversationDetail(created.id) });
  });

  app.post("/api/runs/:id/steer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const accepted = await orchestrator.steerQueuedRun(id);
    if (!accepted) {
      return reply.code(404).send({ error: "这条排队消息已经不存在" });
    }
    return reply.code(202).send({
      message: accepted.message,
      runId: accepted.run.id,
      acceptedAs: accepted.acceptedAs,
      conversation: await conversationDetail(accepted.run.conversationId)
    });
  });

  app.patch("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = z.object({ content: z.string().max(200_000) }).parse(request.body ?? {});
    const message = orchestrator.updateQueuedRun(id, input.content);
    if (!message) return reply.code(404).send({ error: "这条排队消息已经不存在" });
    const run = store.getRun(id);
    return reply.code(200).send({
      message,
      runId: id,
      conversation: run ? await conversationDetail(run.conversationId) : undefined
    });
  });

  app.delete("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!orchestrator.deleteQueuedRun(id) || !run) {
      return reply.code(404).send({ error: "这条排队消息已经不存在" });
    }
    return reply.code(200).send({ runId: id, conversation: await conversationDetail(run.conversationId) });
  });

  app.post("/api/messages/:id/retry", async (request, reply) => {
    rememberUiLocale(store, request.headers["accept-language"]);
    const { id } = request.params as { id: string };
    const message = store.getMessage(id);
    if (!message || message.role !== "assistant" || !message.runId) {
      return reply.code(400).send({ error: "Only an assistant response can be retried" });
    }
    const sourceRun = store.getRun(message.runId);
    if (!sourceRun) return reply.code(404).send({ error: "Source run not found" });
    const sourcePrompt = store.getMessage(sourceRun.userMessageId);
    if (!sourcePrompt) return reply.code(404).send({ error: "Source prompt not found" });
    const branched = store.createBranchFromMessage(sourcePrompt.id, {
      asNewConversation: false,
      includeTarget: false
    });
    orchestrator.interruptSupersededRuns(branched.id);
    orchestrator.restoreWorkspaceFromRun(sourceRun.id, branched.id);
    const run = orchestrator.submit(
      branched.id,
      sourcePrompt.content,
      "normal",
      sourcePrompt.attachments.map((item) => item.id)
    );
    const conversation = store.getConversation(branched.id);
    const overlay = evolution.overlayForRun(sourceRun.id);
    evolution.createSignal({
      source: "implicit",
      kind: "retry",
      polarity: "down",
      profileId: conversation?.profileId ?? null,
      conversationId: branched.id,
      messageId: message.id,
      runId: run.id,
      overlayRevision: overlay?.id ?? null
    });
    return reply.code(202).send({ run, conversation: await conversationDetail(branched.id) });
  });

  app.post("/api/messages/:id/branch", async (request, reply) => {
    rememberUiLocale(store, request.headers["accept-language"]);
    const { id } = request.params as { id: string };
    const input = branchSchema.parse(request.body ?? {});
    const sourceMessage = store.getMessage(id);
    const sourceConversation = sourceMessage ? store.getConversation(sourceMessage.conversationId) : null;
    if (!sourceMessage || !sourceConversation) return reply.code(404).send({ error: "Message not found" });
    const targetIndex = sourceConversation.messages.findIndex((message) => message.id === id);
    const includeTarget = input.content === undefined;
    const visibleSourceMessages =
      targetIndex >= 0 ? sourceConversation.messages.slice(0, targetIndex + (includeTarget ? 1 : 0)) : [];
    const manifests = input.asNewConversation
      ? await Promise.all(
          visibleSourceMessages
            .filter((message) => message.role === "user")
            .map(async (message) => ({
              message,
              manifest: await inputFiles.buildForMessage(sourceConversation.id, message.id, "branch_copy")
            }))
        )
      : [];
    const manifestErrors = manifests.flatMap((item) => item.manifest.errors);
    if (manifestErrors.length > 0) {
      return reply.code(409).send({
        error: `Cannot create branch because an input file is unavailable: ${manifestErrors.map((item) => item.fileName ?? item.attachmentId).join(", ")}`
      });
    }
    const branched = store.createBranchFromMessage(id, {
      asNewConversation: input.asNewConversation,
      includeTarget
    });
    if (!input.asNewConversation) orchestrator.interruptSupersededRuns(branched.id);
    if (input.asNewConversation && manifests.length > 0) {
      try {
        const targetUserMessages = branched.messages.filter((message) => message.role === "user");
        for (let index = 0; index < manifests.length; index += 1) {
          const targetMessage = targetUserMessages[index];
          if (!targetMessage) throw new Error("Cloned input message is missing");
          for (const file of manifests[index]!.manifest.items) {
            const sourceAbsolute = path.resolve(config.workspaceRoot, sourceConversation.id, file.relativePath);
            const targetDirectory = path.resolve(config.workspaceRoot, branched.id, "attachments");
            await fsp.mkdir(targetDirectory, { recursive: true });
            const storedName = await uniqueAttachmentStoredName(targetDirectory, file.originalFileName, file.mimeType);
            const relativePath = path.join("attachments", storedName);
            await fsp.copyFile(sourceAbsolute, path.join(targetDirectory, storedName));
            const attachment = store.createAttachment({
              conversationId: branched.id,
              fileName: file.originalFileName,
              storedName,
              mimeType: file.mimeType,
              size: file.size,
              sha256: file.sha256,
              relativePath
            });
            store.database
              .prepare("INSERT INTO message_attachments (message_id, attachment_id) VALUES (?, ?)")
              .run(targetMessage.id, attachment.id);
          }
        }
      } catch {
        await deleteConversationData(store, config.workspaceRoot, branched.id);
        return reply.code(409).send({ error: "Could not copy input files into the new branch conversation" });
      }
    }
    if (input.content !== undefined) {
      const sourceRun = store.getMessage(id)?.runId;
      if (sourceRun) orchestrator.restoreWorkspaceFromRun(sourceRun, branched.id);
      const run = orchestrator.submit(branched.id, input.content, "normal");
      const conversation = store.getConversation(branched.id);
      evolution.createSignal({
        source: "implicit",
        kind: "edit",
        polarity: "down",
        profileId: conversation?.profileId ?? null,
        conversationId: branched.id,
        messageId: id,
        runId: run.id
      });
      return reply.code(201).send({ run, conversation: await conversationDetail(branched.id) });
    }
    return reply.code(201).send({ conversation: await conversationDetail(branched.id) });
  });

  app.get("/api/conversations/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "Conversation not found" });
    const queryParams = request.query as { after?: string };
    const headerAfter = request.headers["last-event-id"];
    let lastSequence = Number(headerAfter ?? queryParams.after ?? 0) || 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(": connected\n\n");
    const send = (event: ReturnType<EventStore["list"]>[number]) => {
      if (event.sequence <= lastSequence || reply.raw.destroyed) return;
      lastSequence = event.sequence;
      reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const watermark = events.latestSequence(id);
    let replaying = true;
    const liveDuringReplay: ReturnType<EventStore["list"]> = [];
    const unsubscribe = events.subscribe(id, (event) => {
      if (replaying) liveDuringReplay.push(event);
      else send(event);
    });
    while (lastSequence < watermark) {
      const page = events.list(id, lastSequence);
      if (!page.length) break;
      for (const event of page) send(event);
    }
    replaying = false;
    for (const event of liveDuringReplay.sort((a, b) => a.sequence - b.sequence)) send(event);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 20_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.destroyed) reply.raw.end();
    });
  });

  app.post("/api/attachments", async (request, reply) => {
    const query = request.query as { conversationId?: string };
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "A file is required" });
    const fieldConversationId = part.fields.conversationId;
    const conversationId =
      query.conversationId ||
      (fieldConversationId && "value" in fieldConversationId ? String(fieldConversationId.value) : "");
    if (!conversationId || !store.getConversation(conversationId)) {
      return reply.code(404).send({ error: "Conversation not found" });
    }
    if (!isAllowedMime(part.mimetype)) return reply.code(415).send({ error: "Unsupported attachment type" });
    const buffer = await part.toBuffer();
    const fileName = sanitizeFileName(part.filename);
    const directory = path.join(config.workspaceRoot, conversationId, "attachments");
    await fsp.mkdir(directory, { recursive: true });
    const storedName = await uniqueAttachmentStoredName(directory, fileName, part.mimetype);
    const relativePath = path.join("attachments", storedName);
    await fsp.writeFile(path.join(directory, storedName), buffer, { flag: "wx" });
    const attachment = store.createAttachment({
      conversationId,
      fileName,
      storedName,
      mimeType: part.mimetype,
      size: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      relativePath
    });
    events.append({
      type: "attachment.updated",
      conversationId,
      branchId: store.getConversation(conversationId)?.activeBranchId ?? null,
      payload: { attachment }
    });
    return reply.code(201).send(attachment);
  });

  app.get("/api/attachments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = store.getStoredAttachment(id);
    const conversationId = store.database.prepare("SELECT conversation_id FROM attachments WHERE id = ?").get(id) as
      | { conversation_id: string }
      | undefined;
    if (!attachment || !conversationId) return reply.code(404).send({ error: "Attachment not found" });
    const root = path.resolve(config.workspaceRoot, conversationId.conversation_id);
    const absolute = path.resolve(root, attachment.relativePath);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return reply.code(404).send({ error: "Attachment not found" });
    }
    try {
      await fsp.access(absolute);
    } catch {
      return reply.code(404).send({ error: "Attachment file is missing" });
    }
    const forceDownload = (request.query as { download?: string }).download === "1";
    const inline = !forceDownload && isInlinePreviewable(attachment.mimeType, attachment.fileName);
    return reply
      .header("Content-Type", attachment.mimeType || "application/octet-stream")
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`
      )
      .send(fs.createReadStream(absolute));
  });

  app.delete("/api/attachments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = store.database.prepare("SELECT conversation_id, relative_path FROM attachments WHERE id = ?").get(id) as
      | { conversation_id: string; relative_path: string }
      | undefined;
    const attachment = store.deleteAttachment(id);
    if (!attachment) return reply.code(404).send({ error: "Attachment not found" });
    const root = path.resolve(config.workspaceRoot);
    if (row) await safeRemoveFile(root, path.join(root, row.conversation_id, row.relative_path));
    return reply.code(204).send();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.code(400).send({ error: "Invalid request", details: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    app.log.error({ err: error }, "request failed");
    const declaredStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? Number((error as { statusCode: number }).statusCode)
        : null;
    const status =
      declaredStatus && declaredStatus >= 400 && declaredStatus < 600
        ? declaredStatus
        : /not found/i.test(message)
          ? 404
          : /invalid attachment|does not belong to this conversation|not ready|附件.*(?:不属于当前对话|不存在|尚未准备|路径|缺失|校验失败|无法读取)/i.test(
                message
              )
            ? 400
            : 500;
    void reply.code(status).send({ error: message });
  });

  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (config.nodeEnv === "production" && fs.existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  return app;
}

async function recoverGeneratedWorkspaceFiles(
  store: AgentStore,
  workspaceRoot: string,
  conversation: NonNullable<ReturnType<AgentStore["getConversation"]>>
): Promise<void> {
  const workspace = path.resolve(workspaceRoot, conversation.id);
  for (const message of conversation.messages) {
    if (message.role !== "assistant") continue;
    const attached = new Set((message.attachments ?? []).map((item) => item.fileName));
    for (const candidate of collectWorkspaceFileCandidates(message)) {
      const created = await describeCreatedWorkspaceFile(workspace, candidate);
      if (!created || attached.has(created.fileName)) continue;
      try {
        store.attachGeneratedFile({
          conversationId: conversation.id,
          messageId: message.id,
          fileName: created.fileName,
          mimeType: created.mimeType,
          size: created.size,
          sha256: created.sha256,
          relativePath: created.relativePath,
          presented: false
        });
      } catch (error) {
        if (error instanceof InputAttachmentOverwriteError) continue;
        throw error;
      }
      attached.add(created.fileName);
    }
  }
}

function requestedProfileId(value?: string | null): string | null {
  return value && isAgentProfileId(value) ? value : null;
}

function memoryScopeForCategory(
  category: z.infer<typeof memoryCategorySchema>,
  profileId?: string | null
): { scope: "global" | "profile"; profileId: string | null } | Error {
  if (category === "profile" || category === "preference") return { scope: "global", profileId: null };
  if (!profileId || !isAgentProfileId(profileId))
    return new Error("Goal, project, and task memories require a valid profileId");
  return { scope: "profile", profileId };
}

export function sanitizeFileName(value: string): string {
  const base = path
    .basename(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .trim();
  return (base || "attachment").slice(0, 180);
}

const attachmentExtensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json"
};

export function attachmentStoredName(fileName: string, mimeType: string, taken: Iterable<string> = []): string {
  const sanitized = sanitizeFileName(fileName);
  const preferred = path.extname(sanitized) ? sanitized : `${sanitized}${attachmentExtensions[mimeType] ?? ""}`;
  const used = new Set([...taken].map((item) => item.toLowerCase()));
  if (!used.has(preferred.toLowerCase())) return preferred;
  const ext = path.extname(preferred);
  const stem = preferred.slice(0, preferred.length - ext.length) || "attachment";
  return `${stem}-${randomUUID().slice(0, 8)}${ext}`;
}

async function uniqueAttachmentStoredName(directory: string, fileName: string, mimeType: string): Promise<string> {
  let existing: string[] = [];
  try {
    existing = await fsp.readdir(directory);
  } catch {
    existing = [];
  }
  return attachmentStoredName(fileName, mimeType, existing);
}

function isInlinePreviewable(mimeType: string, fileName: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType === "application/json" ||
    fileName.toLowerCase().endsWith(".md")
  );
}

function isAllowedMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json"
    ].includes(mimeType)
  );
}

function isHttpUrl(value: string): boolean {
  try {
    return new Set(["http:", "https:"]).has(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function safeRemoveFile(root: string, target: string): Promise<void> {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe attachment target");
  await fsp.rm(target, { force: true });
}
