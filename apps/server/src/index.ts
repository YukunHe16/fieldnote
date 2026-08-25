import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { buildApp } from "./app.js";
import {
  applyLocalRuntimeSettings,
  loadConfig,
  type FeishuRuntimeConfig,
  type LocalRuntimeSettings
} from "./config.js";
import { openDatabase } from "./database.js";
import { EventStore } from "./event-store.js";
import { FeishuChannel } from "./feishu.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryCoordinator } from "./memory-coordinator.js";
import { RunOrchestrator } from "./orchestrator.js";
import { ConfigurableAgentRuntime } from "./runtime.js";
import { SqliteSessionStore } from "./session-store.js";
import { AgentStore } from "./store.js";
import { sweepExpiredTemporaryConversations } from "./temporary-conversations.js";
import { AdmissionsStore } from "./admissions-store.js";
import { SchedulerStore } from "./scheduler-store.js";
import { ScheduledJobRunner } from "./scheduler.js";
import { LearningReviewRunner } from "./learning-review.js";
import { EvolutionStore } from "./evolution-store.js";
import { EvolutionCoordinator } from "./evolution-coordinator.js";
import { DeliveryShelf } from "./delivery-shelf.js";
import { LiveDomainCard } from "./domain-card-live.js";
import { RunReplayStore } from "./run-replay.js";
import { InputFileManifestService } from "./input-file-manifest.js";
import { CollaborationStore } from "./collaboration-store.js";
import { LearningStore } from "./learning-store.js";
import { LearningCoordinator } from "./learning-coordinator.js";

/**
 * Pick the `.env` file to load. A repository checkout keeps the legacy behavior
 * (always `<repo>/.env`); an installed CLI has no checkout next to its dist, so it
 * falls back to the writable data home — `<FIELDNOTE_HOME>/.env`, then
 * `~/.fieldnote/.env` — and loads nothing when neither exists.
 */
function resolveEnvironmentFile(root: string): string | undefined {
  if (existsSync(path.join(root, "pnpm-workspace.yaml"))) return path.join(root, ".env");
  const home = process.env.FIELDNOTE_HOME;
  if (home) {
    const candidate = path.join(path.resolve(root, home), ".env");
    if (existsSync(candidate)) return candidate;
  }
  const fallback = path.join(os.homedir(), ".fieldnote", ".env");
  return existsSync(fallback) ? fallback : undefined;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const environmentFile = resolveEnvironmentFile(repositoryRoot);
if (environmentFile) dotenv.config({ path: environmentFile });
const config = loadConfig(process.env, repositoryRoot);

if (!new Set(["127.0.0.1", "localhost", "::1"]).has(config.host)) {
  throw new Error("The unauthenticated v1 server may only bind to a loopback host");
}

await fs.mkdir(config.workspaceRoot, { recursive: true });
const database = openDatabase(config.databasePath);
const store = new AgentStore(database);
await sweepExpiredTemporaryConversations(store, config.workspaceRoot);
const storedRuntime = store.getSetting<LocalRuntimeSettings>("runtime.config");
if (storedRuntime) applyLocalRuntimeSettings(config, storedRuntime);
const storedFeishu = store.getSetting<{ appId: string; appSecret: string; allowedOpenIds: string[] }>("feishu.config");
const initialFeishu: FeishuRuntimeConfig | undefined = storedFeishu
  ? {
      appId: storedFeishu.appId,
      appSecret: storedFeishu.appSecret,
      allowedOpenIds: new Set(storedFeishu.allowedOpenIds)
    }
  : config.feishu;
const events = new EventStore(database);
const sessionStore = new SqliteSessionStore(database);
const memoryStore = new MemoryStore(database);
const evolutionStore = new EvolutionStore(database);
const admissionsStore = new AdmissionsStore(database);
const schedulerStore = new SchedulerStore(database);
schedulerStore.ensureProfileTemplates("graduate-admissions");
let scheduledRunner: ScheduledJobRunner | undefined;
const schedulerProxy = { runNow: (jobId: string) => scheduledRunner?.runNow(jobId) ?? null };
const evolutionCoordinator = new EvolutionCoordinator(config, evolutionStore, memoryStore);
const shelf = new DeliveryShelf(database);
const inputFiles = new InputFileManifestService(store, config.workspaceRoot);
const collaboration = new CollaborationStore(database);
const learning = new LearningStore(database, undefined, config.learningEvalEvolution);
const learningCoordinator = new LearningCoordinator(learning);
const liveCard = new LiveDomainCard(database);
const replay = new RunReplayStore(database, path.join(config.workspaceRoot, ".snapshots"));
const runtime = new ConfigurableAgentRuntime(
  config,
  sessionStore,
  memoryStore,
  admissionsStore,
  schedulerStore,
  schedulerProxy,
  evolutionStore,
  evolutionCoordinator,
  { shelf, inputFiles, collaboration, learning: learningCoordinator }
);
const memoryCoordinator = new MemoryCoordinator(
  config,
  store,
  memoryStore,
  events,
  runtime,
  evolutionCoordinator,
  liveCard,
  admissionsStore,
  learning,
  replay
);
const orchestrator = new RunOrchestrator(config, store, events, runtime, memoryCoordinator, {
  shelf,
  replay,
  liveCard,
  memories: memoryStore,
  admissions: admissionsStore,
  evolution: evolutionStore,
  inputFiles,
  learning,
  collaboration
});
const feishu = new FeishuChannel(
  initialFeishu,
  store,
  events,
  orchestrator,
  config.webAppUrl,
  config.workspaceRoot,
  evolutionCoordinator,
  collaboration,
  learning,
  runtime
);
evolutionCoordinator.setNotifier(feishu);
evolutionCoordinator.setReplay(replay);
const runner = new ScheduledJobRunner(
  config,
  schedulerStore,
  admissionsStore,
  store,
  runtime,
  {
    async deliver(destination, report) {
      if (destination === "web") return report.run.id;
      return feishu.sendScheduledReport({ runId: report.run.id, title: report.title, content: report.content });
    }
  },
  (operation) => orchestrator.withRuntimeSlot(operation),
  liveCard,
  memoryStore
);
scheduledRunner = runner;
const app = await buildApp({
  config,
  store,
  events,
  orchestrator,
  runtime,
  runtimeController: runtime,
  feishu,
  memories: memoryStore,
  memoryMaintenance: memoryCoordinator,
  admissions: admissionsStore,
  schedules: schedulerStore,
  scheduledRunner: runner,
  evolution: evolutionStore,
  evolutionCoordinator,
  shelf,
  learning,
  inputFiles,
  collaboration,
  liveCard,
  replay
});

await app.listen({ host: config.host, port: config.port });
app.log.info(
  {
    url: `http://${config.host}:${config.port}`,
    runtime: runtime.kind,
    claudeAuthSource: config.claudeAuthSource,
    claudeSettingsMode: config.claudeSettingsMode,
    feishuConfigured: feishu.isConfigured()
  },
  "local agent workbench is ready"
);

if (feishu.isConfigured()) {
  try {
    await feishu.start();
    app.log.info("Feishu long connection is ready");
  } catch (error) {
    app.log.error({ err: error }, "Feishu channel failed to start; web remains available");
  }
}

const temporarySweepTimer = setInterval(() => {
  void sweepExpiredTemporaryConversations(store, config.workspaceRoot, {
    beforeDelete: (conversationId) => orchestrator.interruptConversationAndWait(conversationId)
  }).catch((error) => app.log.warn({ err: error }, "temporary conversation cleanup failed"));
}, 15 * 60_000);
temporarySweepTimer.unref();

const memoryMaintenanceTimer = setInterval(() => {
  memoryCoordinator.scheduleMaintenance();
  evolutionCoordinator.scheduleReview();
}, 60 * 60_000);
memoryMaintenanceTimer.unref();

runner.tick();
const learningReviews = new LearningReviewRunner(learning, store, orchestrator, Date.now, (conversationId) =>
  feishu.canReachConversation(conversationId)
);
learningReviews.tick();
const scheduledJobTimer = setInterval(() => {
  runner.tick();
  learningReviews.tick();
}, 60_000);
scheduledJobTimer.unref();

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  clearInterval(temporarySweepTimer);
  clearInterval(memoryMaintenanceTimer);
  clearInterval(scheduledJobTimer);
  app.log.info({ signal }, "shutting down");
  await Promise.allSettled([feishu.stop(), orchestrator.stop(), memoryCoordinator.stop(), runner.stop(), app.close()]);
  database.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
