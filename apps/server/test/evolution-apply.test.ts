import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { openDatabase } from "../src/database.js";
import { EvolutionCoordinator } from "../src/evolution-coordinator.js";
import { EvolutionStore } from "../src/evolution-store.js";
import { evaluateArtifactProgrammatically } from "../src/evolution-evaluator.js";
import { backgroundAnalysisModel, emptyTurnAnalysis, normalizeTurnAnalysisPayload } from "../src/runtime.js";

function testConfig(root: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    databasePath: ":memory:",
    workspaceRoot: path.join(root, "workspaces"),
    runtime: "demo",
    claudeAuthConfigured: false,
    claudeAuthSource: "none",
    claudeSettingsMode: "isolated",
    claudeConfigDir: path.join(root, ".claude"),
    claudeConfigDirExplicit: false,
    model: "sonnet",
    modelDisplay: "sonnet",
    effort: "high",
    maxConcurrency: 2,
    maxTurns: 30,
    runTimeoutMs: 20_000,
    maxBudgetUsd: 2,
    logLevel: "silent",
    nodeEnv: "test"
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evolution-apply-"));
  const database = openDatabase(":memory:");
  const evolution = new EvolutionStore(database);
  const coordinator = new EvolutionCoordinator(testConfig(root), evolution);
  return { root, database, evolution, coordinator };
}

function acceptAnalysis(method = "先核官方页面再写进材料") {
  return {
    ...emptyTurnAnalysis(method),
    methodVerdict: "accept" as const,
    method,
    polarity: "do" as const,
    evolveTarget: "skill" as const,
    evolveKindHint: "主代理以后遇到同类请求应走的步骤"
  };
}

describe("turn analysis normalization", () => {
  it("uses sonnet for background analysis", () => {
    expect(backgroundAnalysisModel()).toBe(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME?.trim() || "sonnet");
  });

  it("fills missing evolution fields as none", () => {
    const normalized = normalizeTurnAnalysisPayload({
      title: "标题",
      meaningfulTask: false,
      memories: []
    }) as {
      methodVerdict: string;
      evolveTarget: string;
      method: string;
      matchedPlaybookIds: string[];
    };
    expect(normalized).toMatchObject({
      methodVerdict: "none",
      evolveTarget: "none",
      method: "",
      matchedPlaybookIds: []
    });
  });
});

describe("applyTurnEvolution", () => {
  it("confirms an injected playbook on accept and writes a distilled method otherwise", async () => {
    const { root, database, evolution, coordinator } = await setup();
    const playbook = evolution.createPlaybook({
      title: "先核官方",
      instruction: "先核官方页面再写进材料",
      polarity: "do",
      origin: "distilled",
      scope: "profile",
      profileId: "graduate-admissions"
    });
    const confirmed = await coordinator.applyTurnEvolution({
      profileId: "graduate-admissions",
      retried: false,
      usedSkills: ["项目调研"],
      usedSubagents: [],
      injectedPlaybooks: [playbook],
      analysis: { ...acceptAnalysis(), matchedPlaybookIds: [playbook.id], evolveTarget: "playbook" }
    });
    expect(confirmed.playbooks[0]?.origin).toBe("confirmed");
    expect(evolution.listArtifacts("graduate-admissions")).toHaveLength(0);

    const fresh = await setup();
    const created = await fresh.coordinator.applyTurnEvolution({
      profileId: "graduate-admissions",
      retried: false,
      usedSkills: [],
      usedSubagents: [],
      injectedPlaybooks: [],
      analysis: { ...acceptAnalysis(), evolveTarget: "playbook" }
    });
    expect(created.playbooks[0]).toMatchObject({
      origin: "distilled",
      instruction: "先核官方页面再写进材料"
    });
    expect(created.artifacts).toHaveLength(0);
    fresh.database.close();
    await fs.rm(fresh.root, { recursive: true, force: true });
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not treat a weakly overlapping filler playbook as the same method", async () => {
    const { root, database, evolution, coordinator } = await setup();
    const filler = evolution.createPlaybook({
      title: "核官方任职",
      instruction: "套磁前确认官方任职页",
      polarity: "do",
      origin: "distilled",
      scope: "profile",
      profileId: "graduate-admissions"
    });
    const created = await coordinator.applyTurnEvolution({
      profileId: "graduate-admissions",
      retried: false,
      usedSkills: [],
      usedSubagents: [],
      injectedPlaybooks: [filler],
      analysis: { ...acceptAnalysis(), evolveTarget: "playbook" }
    });
    expect(evolution.getPlaybook(filler.id)?.origin).toBe("distilled");
    expect(created.playbooks[0]?.id).not.toBe(filler.id);
    expect(created.playbooks[0]).toMatchObject({
      origin: "distilled",
      instruction: "先核官方页面再写进材料"
    });
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("vetoes model accept when the turn was a retry", async () => {
    const { root, database, evolution, coordinator } = await setup();
    const result = await coordinator.applyTurnEvolution({
      profileId: "graduate-admissions",
      retried: true,
      usedSkills: [],
      usedSubagents: [],
      injectedPlaybooks: [],
      analysis: acceptAnalysis()
    });
    expect(result.playbooks).toHaveLength(0);
    expect(result.artifacts).toHaveLength(0);
    expect(evolution.activePlaybooks("graduate-admissions")).toHaveLength(0);
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("proposes one pending skill after three same-method accepts and does not enable it", async () => {
    const { root, database, evolution, coordinator } = await setup();
    const input = {
      profileId: "graduate-admissions",
      retried: false,
      usedSkills: ["项目调研"],
      usedSubagents: [] as string[],
      injectedPlaybooks: [],
      analysis: acceptAnalysis()
    };
    await coordinator.applyTurnEvolution(input);
    await coordinator.applyTurnEvolution(input);
    expect(evolution.listArtifacts("graduate-admissions")).toHaveLength(0);
    const third = await coordinator.applyTurnEvolution(input);
    expect(third.artifacts).toHaveLength(1);
    expect(third.artifacts[0]).toMatchObject({
      kind: "skill",
      slug: "evolved-personal-method",
      status: "pending",
      origin: "distilled"
    });
    expect(evolution.enabledArtifacts("graduate-admissions")).toHaveLength(0);
    const fourth = await coordinator.applyTurnEvolution(input);
    expect(evolution.pendingArtifacts("graduate-admissions")).toHaveLength(1);
    expect(fourth.artifacts[0]?.slug).toBe("evolved-personal-method");
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("proposes a pending subagent for repeated delegated work that cannot nest", async () => {
    const { root, database, evolution, coordinator } = await setup();
    const input = {
      profileId: "graduate-admissions",
      retried: false,
      usedSkills: [] as string[],
      usedSubagents: ["项目研究员"],
      injectedPlaybooks: [],
      analysis: {
        ...acceptAnalysis("长时间调研一个项目并核验官方页面"),
        evolveTarget: "subagent" as const,
        evolveKindHint: "本轮已是独立调研任务"
      }
    };
    await coordinator.applyTurnEvolution(input);
    await coordinator.applyTurnEvolution(input);
    await coordinator.applyTurnEvolution(input);
    const artifacts = evolution.pendingArtifacts("graduate-admissions");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "subagent",
      status: "pending"
    });
    const spec = JSON.parse(artifacts[0]!.body) as { allowDelegation?: boolean };
    expect(spec.allowDelegation).toBe(false);
    expect(evaluateArtifactProgrammatically(artifacts[0]!).verdict).not.toBe("reject");
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});
