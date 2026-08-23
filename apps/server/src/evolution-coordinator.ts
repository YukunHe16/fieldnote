import type {
  EvolvedArtifactDto,
  EvolutionReviewVerdict,
  PlaybookDto,
  PlaybookPolarity,
  ProfileEquipmentDto
} from "@fieldnote/contracts";
import { officialEquipment, isAgentProfileId, listAgentProfiles } from "./agent-profiles.js";
import type { AppConfig } from "./config.js";
import { evaluateArtifactProgrammatically } from "./evolution-evaluator.js";
import { runShadowCheck, skillMatchesPrompt } from "./domain-evolution-check.js";
import type { RunReplayStore } from "./run-replay.js";
import { methodsSimilar, preparePlaybookInstruction, type EvolutionStore } from "./evolution-store.js";
import { evolvedSkillDescription, renderEvolvedSkillBody, syncEvolvedOverlay } from "./evolved-overlay.js";
import type { MemoryStore } from "./memory-store.js";
import { scoreOverlayText } from "./overlay-context.js";
import type { TurnAnalysis } from "./runtime.js";

const USED_DELEGATE = /项目研究员|资料核验|文书写作|文书审校/;
const DELEGATED_WORK = /委派|交给子代理|做成子代理|交给研究员|交给审校|delegate_/i;

export interface EvolutionNotifier {
  canNotifyEvolution?(): boolean;
  notifyEvolution(input: {
    artifact: EvolvedArtifactDto;
    verdict: EvolutionReviewVerdict;
    reason: string;
    enabled: boolean;
    replayRunId?: string | null;
  }): Promise<boolean>;
}

const EXPLICIT_SKILL_REQUEST = /做成\s*(skill|技能)|做成子代理|交给子代理/i;

export class EvolutionCoordinator {
  private notifier: EvolutionNotifier | null = null;
  private reviewPromise: Promise<void> | null = null;
  private replay: RunReplayStore | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly evolution: EvolutionStore,
    private readonly memories?: MemoryStore
  ) {
    this.evolution.recoverReviews();
  }

  setNotifier(notifier: EvolutionNotifier | null): void {
    this.notifier = notifier;
  }

  setReplay(replay: RunReplayStore | null): void {
    this.replay = replay;
  }

  injectedPlaybooksForRun(runId: string): PlaybookDto[] {
    const overlay = this.evolution.overlayForRun(runId);
    if (!overlay) return [];
    return overlay.playbookIds
      .map((id) => this.evolution.getPlaybook(id))
      .filter((item): item is PlaybookDto => Boolean(item));
  }

  artifactSummaries(profileId: string): Array<{
    kind: EvolvedArtifactDto["kind"];
    slug: string;
    name: string;
    status: EvolvedArtifactDto["status"];
  }> {
    return this.evolution
      .listArtifacts(profileId)
      .filter((item) => item.status === "pending" || item.status === "enabled")
      .slice(0, 20)
      .map((item) => ({ kind: item.kind, slug: item.slug, name: item.name, status: item.status }));
  }

  hasRetryOrEditForRun(runId: string): boolean {
    return this.evolution.hasRetryOrEditForRun(runId);
  }

  async applyTurnEvolution(input: {
    profileId: string;
    runId?: string;
    conversationId?: string;
    retried: boolean;
    usedSkills: string[];
    usedSubagents: string[];
    injectedPlaybooks: PlaybookDto[];
    analysis: TurnAnalysis;
  }): Promise<{ playbooks: PlaybookDto[]; artifacts: EvolvedArtifactDto[] }> {
    if (!isAgentProfileId(input.profileId)) return { playbooks: [], artifacts: [] };
    const verdict =
      input.retried && input.analysis.methodVerdict === "accept" ? "reject" : (input.analysis.methodVerdict ?? "none");
    const method = preparePlaybookInstruction(input.analysis.method ?? "");
    const polarity: PlaybookPolarity = input.analysis.polarity === "dont" ? "dont" : "do";
    if (verdict !== "accept" || !method) return { playbooks: [], artifacts: [] };

    this.evolution.createSignal({
      source: "implicit",
      kind: "method",
      polarity: "up",
      reason: method,
      profileId: input.profileId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.runId ? { runId: input.runId } : {})
    });

    const playbooks = this.writePlaybooksFromAccept({
      profileId: input.profileId,
      method,
      polarity,
      injectedPlaybooks: input.injectedPlaybooks,
      matchedPlaybookIds: input.analysis.matchedPlaybookIds ?? [],
      ...(input.runId ? { runId: input.runId } : {})
    });

    const artifacts = await this.maybeProposeTurnArtifact({
      profileId: input.profileId,
      method,
      polarity,
      evolveTarget: input.analysis.evolveTarget ?? "none",
      evolveKindHint: input.analysis.evolveKindHint ?? "",
      usedSkills: input.usedSkills,
      usedSubagents: input.usedSubagents
    });
    return { playbooks, artifacts };
  }

  equipment(profileId: string): ProfileEquipmentDto {
    const official = isAgentProfileId(profileId) ? officialEquipment(profileId) : { skills: [], delegates: [] };
    const evolved = this.evolution.listArtifacts(profileId);
    const visible = evolved.filter((item) => item.status === "enabled" || item.status === "disabled");
    const evolvedSkills = visible
      .filter((item) => item.kind === "skill")
      .map((item) => ({
        id: item.slug,
        name: item.name,
        description: item.description,
        origin: "evolved" as const,
        enabled: item.status === "enabled",
        artifactId: item.id
      }));
    const evolvedDelegates = visible
      .filter((item) => item.kind === "subagent")
      .map((item) => ({
        id: item.slug,
        name: item.name,
        description: item.description,
        origin: "evolved" as const,
        enabled: item.status === "enabled",
        artifactId: item.id
      }));
    return {
      profileId,
      skills: [
        ...official.skills.map((item) => ({ ...item, origin: "official" as const, enabled: true })),
        ...evolvedSkills
      ],
      delegates: [
        ...official.delegates.map((item) => ({ ...item, origin: "official" as const, enabled: true })),
        ...evolvedDelegates
      ],
      pending: evolved.filter((item) => item.status === "pending")
    };
  }

  async propose(input: {
    profileId: string;
    kind: "skill" | "subagent";
    slug: string;
    name: string;
    description: string;
    body: string;
    origin?: "user" | "distilled";
    holdForHuman?: boolean;
    reviewReason?: string;
  }): Promise<EvolvedArtifactDto> {
    const artifact = this.evolution.createArtifact({
      profileId: input.profileId,
      kind: input.kind,
      slug: input.slug,
      name: input.name,
      description: input.description,
      body: input.body,
      origin: input.origin ?? "user",
      status: "pending"
    });
    return this.evaluateAndApply(artifact.id, input.holdForHuman === true, input.reviewReason);
  }

  async proposeFromPrompt(input: {
    profileId: string;
    prompt: string;
    runId?: string;
  }): Promise<EvolvedArtifactDto | null> {
    if (!EXPLICIT_SKILL_REQUEST.test(input.prompt)) return null;
    const playbooks = this.evolution.activePlaybooks(input.profileId, 8);
    const confirmed = playbooks.filter((item) => item.origin === "user" || item.origin === "confirmed");
    const steps = (confirmed.length > 0 ? confirmed : playbooks).map((item) => item.instruction);
    if (steps.length === 0) return null;
    const asSubagent = /子代理/.test(input.prompt);
    const kind = asSubagent ? ("subagent" as const) : ("skill" as const);
    const existing = this.evolution
      .pendingArtifacts(input.profileId)
      .find((item) => item.origin === "distilled" && item.kind === kind);
    if (existing) return existing;
    const baseSlug = asSubagent ? "evolved-personal-delegate" : "evolved-personal-method";
    const slug = this.evolution.nextAvailableSlug(input.profileId, kind, baseSlug);
    const name = asSubagent ? "个人流程子代理" : "个人工作方法";
    const description = evolvedSkillDescription(steps);
    const body = asSubagent
      ? JSON.stringify(
          {
            systemPrompt: `Complete one bounded task using this personal method:\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\nCurrent user input always wins. Do not invent facts.`,
            skills: [],
            mcpFactories: [],
            maxTurns: 8,
            allowDelegation: false
          },
          null,
          2
        )
      : renderEvolvedSkillBody({ slug, name, description, steps });
    return this.propose({
      profileId: input.profileId,
      kind,
      slug,
      name,
      description,
      body,
      origin: "distilled",
      holdForHuman: true,
      reviewReason: "用户明确要求把做法做成能力，待你启用。"
    });
  }

  scheduleReview(now = Date.now()): void {
    if (!this.memories || this.reviewPromise) return;
    this.reviewPromise = this.reviewNow(now)
      .catch(() => undefined)
      .finally(() => {
        this.reviewPromise = null;
      });
  }

  async reviewNow(now = Date.now()): Promise<void> {
    await this.runReviews(now);
  }

  async proposeFromReview(profileId: string): Promise<EvolvedArtifactDto | null> {
    if (!isAgentProfileId(profileId)) return null;
    const pending = this.evolution.pendingArtifacts(profileId).filter((item) => item.origin === "distilled");
    const playbooks = this.evolution.activePlaybooks(profileId, 12);
    const confirmed = playbooks.filter((item) => item.origin === "user" || item.origin === "confirmed");
    const distilled = playbooks.filter((item) => item.origin === "distilled");
    const tasks = this.memories?.recentAutoTasks(profileId, 30) ?? [];
    const similarCount = largestSimilarTaskGroup(tasks.map((item) => item.title));
    const similarDistilled = largestSimilarTaskGroup(distilled.map((item) => item.title));
    const enoughPlaybooks = confirmed.length >= 2;
    const enoughRepeatedWork = similarCount >= 3 || similarDistilled >= 3;
    if (!enoughPlaybooks && !enoughRepeatedWork) return null;

    const steps = (confirmed.length > 0 ? confirmed : playbooks).map((item) => item.instruction);
    if (steps.length === 0) {
      for (const task of tasks.slice(0, 6)) {
        if (task.content.trim()) steps.push(task.content.trim().slice(0, 200));
      }
    }
    if (steps.length === 0) {
      steps.push("按用户确认过的个人工作方法处理同类请求。");
    }

    let skill: EvolvedArtifactDto | null = null;
    if (!pending.some((item) => item.kind === "skill")) {
      const slug = this.evolution.nextAvailableSlug(profileId, "skill", "evolved-reviewed-method");
      const name = "个人工作方法";
      const description = evolvedSkillDescription(steps);
      const reason = enoughPlaybooks
        ? `定期回顾提出：已有 ${confirmed.length} 条确认过的工作方法，待你启用。`
        : `定期回顾提出：近期有 ${Math.max(similarCount, similarDistilled)} 次相近任务，待你启用。`;
      skill = await this.propose({
        profileId,
        kind: "skill",
        slug,
        name,
        description,
        body: renderEvolvedSkillBody({ slug, name, description, steps }),
        origin: "distilled",
        holdForHuman: true,
        reviewReason: reason
      });
    }

    let subagent: EvolvedArtifactDto | null = null;
    if (
      !pending.some((item) => item.kind === "subagent") &&
      looksDelegated([
        ...playbooks.map((item) => item.instruction),
        ...tasks.map((item) => `${item.title} ${item.content}`)
      ])
    ) {
      subagent = await this.proposePendingSubagent(profileId, steps, "定期回顾提出：重复工作一直走委派，待你启用。");
    }
    return skill ?? subagent;
  }

  async review(id: string, verdict: EvolutionReviewVerdict, reason: string): Promise<EvolvedArtifactDto | null> {
    const current = this.evolution.getArtifact(id);
    if (!current) return null;
    if (verdict === "pass") {
      const hardCheck = evaluateArtifactProgrammatically(current);
      if (hardCheck.verdict === "reject") {
        const artifact = this.evolution.setArtifactStatus(id, "rejected", {
          verdict: "reject",
          reason: `${hardCheck.reason} 人审不能覆盖硬检查。`
        });
        if (!artifact) return null;
        await this.afterStatus(artifact, artifact.evaluation ?? hardCheck);
        return this.evolution.getArtifact(id);
      }
    }
    const status = verdict === "pass" ? "enabled" : verdict === "reject" ? "rejected" : "pending";
    const artifact = this.evolution.setArtifactStatus(id, status, { verdict, reason });
    if (!artifact) return null;
    await this.afterStatus(artifact, { verdict, reason });
    return this.evolution.getArtifact(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<EvolvedArtifactDto | null> {
    const current = this.evolution.getArtifact(id);
    if (!current) return null;
    if (!enabled) {
      const artifact = this.evolution.setArtifactStatus(id, "disabled");
      if (!artifact) return null;
      await syncEvolvedOverlay(this.config.workspaceRoot, artifact);
      return artifact;
    }
    return this.evaluateAndApply(id);
  }

  async rollback(id: string): Promise<EvolvedArtifactDto | null> {
    return this.setEnabled(id, false);
  }

  private async runReviews(now: number): Promise<void> {
    if (!this.memories) return;
    for (const profileId of this.reviewableProfiles()) {
      const newTaskCount = this.memories.countAutoTasksSince(
        profileId,
        this.evolution.getReviewStatus(profileId, 0, now).lastRunAt
      );
      const status = this.evolution.getReviewStatus(profileId, newTaskCount, now);
      if (!status.due) continue;
      this.evolution.markReviewRunning(profileId, now);
      try {
        await this.proposeFromReview(profileId);
        this.evolution.markReviewCompleted(profileId, now, now);
      } catch (error) {
        this.evolution.markReviewFailed(profileId, error instanceof Error ? error.message : String(error), now);
      }
    }
  }

  private writePlaybooksFromAccept(input: {
    profileId: string;
    method: string;
    polarity: PlaybookPolarity;
    injectedPlaybooks: PlaybookDto[];
    matchedPlaybookIds: string[];
    runId?: string;
  }): PlaybookDto[] {
    const changed: PlaybookDto[] = [];
    const matched = input.injectedPlaybooks.filter(
      (item) =>
        input.matchedPlaybookIds.includes(item.id) || methodsSimilar(`${item.title} ${item.instruction}`, input.method)
    );
    for (const item of matched) {
      if (item.origin === "distilled") {
        const updated = this.evolution.updatePlaybook(item.id, { origin: "confirmed" });
        if (updated) changed.push(updated);
      }
    }
    if (matched.length > 0) return changed;

    const similar = this.evolution
      .activePlaybooks(input.profileId, 20)
      .filter((item) => methodsSimilar(`${item.title} ${item.instruction}`, input.method))
      .sort(
        (left, right) =>
          scoreOverlayText(`${right.title} ${right.instruction}`, input.method) -
          scoreOverlayText(`${left.title} ${left.instruction}`, input.method)
      )[0];
    if (similar) {
      if (similar.origin === "distilled" && similar.instruction !== input.method) {
        const updated = this.evolution.updatePlaybook(similar.id, { instruction: input.method });
        if (updated) changed.push(updated);
      }
      return changed;
    }
    changed.push(
      this.evolution.createPlaybook({
        title: input.method.slice(0, 80),
        instruction: input.method,
        polarity: input.polarity,
        origin: "distilled",
        scope: "profile",
        profileId: input.profileId,
        ...(input.runId ? { sourceRunId: input.runId } : {})
      })
    );
    return changed;
  }

  private async maybeProposeTurnArtifact(input: {
    profileId: string;
    method: string;
    polarity: PlaybookPolarity;
    evolveTarget: TurnAnalysis["evolveTarget"];
    evolveKindHint: string;
    usedSkills: string[];
    usedSubagents: string[];
  }): Promise<EvolvedArtifactDto[]> {
    const acceptCount = this.evolution.countSimilarMethodAccepts(input.profileId, input.method);
    const confirmedSimilar = this.evolution
      .activePlaybooks(input.profileId, 20)
      .filter(
        (item) =>
          (item.origin === "user" || item.origin === "confirmed") &&
          methodsSimilar(`${item.title} ${item.instruction}`, input.method)
      );
    if (acceptCount < 3 && confirmedSimilar.length < 2) return [];

    const delegated = input.usedSubagents.some((label) => USED_DELEGATE.test(label));
    const mainAgentFlow = input.usedSkills.length > 0 && input.usedSubagents.length === 0;
    let target = input.evolveTarget;
    if (target === "none" || target === "playbook") {
      if (delegated) target = "subagent";
      else if (mainAgentFlow || /主代理|流程|提纲/.test(input.evolveKindHint)) target = "skill";
      else return [];
    }

    const steps = uniqueSteps([
      ...confirmedSimilar.map((item) => item.instruction),
      ...this.evolution
        .activePlaybooks(input.profileId, 12)
        .filter((item) => methodsSimilar(`${item.title} ${item.instruction}`, input.method))
        .map((item) => item.instruction),
      input.method
    ]);
    const reason = `本轮做法已重复 ${Math.max(acceptCount, confirmedSimilar.length)} 次，待你启用。`;
    if (target === "subagent") {
      const artifact = await this.proposeOrRevisePending({
        profileId: input.profileId,
        kind: "subagent",
        baseSlug: "evolved-personal-delegate",
        name: "个人流程子代理",
        method: input.method,
        description: evolvedSkillDescription(steps),
        body: renderSubagentBody(steps),
        reason
      });
      return artifact ? [artifact] : [];
    }
    const artifact = await this.proposeOrRevisePending({
      profileId: input.profileId,
      kind: "skill",
      baseSlug: "evolved-personal-method",
      name: "个人工作方法",
      method: input.method,
      description: evolvedSkillDescription(steps),
      body: "",
      steps,
      reason
    });
    return artifact ? [artifact] : [];
  }

  private async proposeOrRevisePending(input: {
    profileId: string;
    kind: "skill" | "subagent";
    baseSlug: string;
    name: string;
    method: string;
    description: string;
    body: string;
    steps?: string[];
    reason: string;
  }): Promise<EvolvedArtifactDto | null> {
    const pending = this.evolution
      .pendingArtifacts(input.profileId)
      .filter(
        (item) =>
          item.kind === input.kind &&
          item.origin === "distilled" &&
          (item.slug.startsWith(input.baseSlug) || methodsSimilar(`${item.name} ${item.description}`, input.method))
      )[0];
    const slug = pending?.slug ?? this.evolution.nextAvailableSlug(input.profileId, input.kind, input.baseSlug);
    const body =
      input.kind === "skill"
        ? renderEvolvedSkillBody({
            slug,
            name: input.name,
            description: input.description,
            steps: input.steps && input.steps.length > 0 ? input.steps : [input.method]
          })
        : input.body;
    return this.propose({
      profileId: input.profileId,
      kind: input.kind,
      slug,
      name: input.name,
      description: input.description,
      body,
      origin: "distilled",
      holdForHuman: true,
      reviewReason: input.reason
    });
  }

  private async proposePendingSubagent(
    profileId: string,
    steps: string[],
    reason: string
  ): Promise<EvolvedArtifactDto> {
    const slug = this.evolution.nextAvailableSlug(profileId, "subagent", "evolved-reviewed-delegate");
    const name = "个人流程子代理";
    const description = evolvedSkillDescription(steps);
    return this.propose({
      profileId,
      kind: "subagent",
      slug,
      name,
      description,
      body: renderSubagentBody(steps),
      origin: "distilled",
      holdForHuman: true,
      reviewReason: reason
    });
  }

  private reviewableProfiles(): string[] {
    const ids = new Set<string>([
      ...this.evolution.listPlaybookProfileIds(),
      ...(this.memories?.listAutoTaskProfileIds() ?? [])
    ]);
    return listAgentProfiles()
      .map((item) => item.id)
      .filter((id) => ids.has(id));
  }

  private async evaluateAndApply(id: string, holdForHuman = false, reviewReason?: string): Promise<EvolvedArtifactDto> {
    const current = this.evolution.getArtifact(id);
    if (!current) throw new Error("Artifact not found");
    const hard = evaluateArtifactProgrammatically(current);
    const snapshot = this.replay?.latestMatching(current.profileId, (item) => skillMatchesPrompt(current, item.prompt));
    const domain = runShadowCheck(current, snapshot);
    const evaluation =
      hard.verdict === "reject"
        ? hard
        : !domain.ok
          ? {
              verdict: "needs_human" as const,
              reason: `领域检查未通过：${domain.reason}`,
              replayRunId: domain.replayRunId
            }
          : { ...hard, replayRunId: domain.replayRunId };
    const recorded =
      holdForHuman && evaluation.verdict === "pass"
        ? {
            verdict: "needs_human" as const,
            reason: reviewReason ?? `定期回顾提出：${evaluation.reason}`,
            replayRunId: domain.replayRunId
          }
        : evaluation;
    const status =
      recorded.verdict === "reject"
        ? "rejected"
        : holdForHuman || recorded.verdict === "needs_human"
          ? "pending"
          : "enabled";
    const artifact = this.evolution.setArtifactStatus(id, status, recorded) ?? current;
    await this.afterStatus(artifact, recorded);
    return this.evolution.getArtifact(id) ?? artifact;
  }

  private async afterStatus(
    artifact: EvolvedArtifactDto,
    evaluation: { verdict: EvolutionReviewVerdict; reason: string; replayRunId?: string | null }
  ): Promise<void> {
    await syncEvolvedOverlay(this.config.workspaceRoot, artifact);
    if (!this.notifier || this.notifier.canNotifyEvolution?.() === false) return;
    const replayRunId = evaluation.replayRunId ?? artifact.evaluation?.replayRunId ?? null;
    let notified = false;
    try {
      notified =
        (await this.notifier?.notifyEvolution({
          artifact,
          verdict: evaluation.verdict,
          reason: evaluation.reason,
          enabled: artifact.status === "enabled",
          replayRunId
        })) ?? false;
    } catch {
      notified = false;
    }
    if (notified || /飞书未发送/.test(evaluation.reason)) return;
    this.evolution.setArtifactStatus(artifact.id, artifact.status, {
      verdict: evaluation.verdict,
      reason: `${evaluation.reason} 飞书未发送，已记在能力面板。`,
      replayRunId
    });
  }
}

function uniqueSteps(steps: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const step of steps) {
    const cleaned = step.replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= 8) break;
  }
  return result;
}

function looksDelegated(texts: string[]): boolean {
  return texts.some((text) => DELEGATED_WORK.test(text));
}

function renderSubagentBody(steps: string[]): string {
  return JSON.stringify(
    {
      systemPrompt: `Complete one bounded task using this personal method:\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\nCurrent user input always wins. Do not invent facts.`,
      skills: [],
      mcpFactories: [],
      maxTurns: 8,
      allowDelegation: false
    },
    null,
    2
  );
}

function largestSimilarTaskGroup(titles: string[]): number {
  const groups = new Map<string, number>();
  for (const title of titles) {
    const key = title.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!key) continue;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return groups.size === 0 ? 0 : Math.max(...groups.values());
}
