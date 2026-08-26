import path from "node:path";
import type { LearningStore, LearningStrategyVariantDto } from "./learning-store.js";
import type { AgentRuntime } from "./runtime.js";

interface MessageLookup {
  getMessage(id: string): { content: string } | null | undefined;
}

/**
 * Teaching-approach invention, step one: when a live on-call incident resolves after an
 * earlier strategy failed, the winning round carried something worth keeping. A one-turn
 * background call distills it into a pending 讲法 candidate; a human decides whether it
 * even enters a trial. Everything here is opportunistic — errors never surface into the
 * learner's confirmation flow.
 */
export async function maybeDistillFromResolvedIncident(deps: {
  learning: LearningStore;
  store: MessageLookup;
  runtime: Pick<AgentRuntime, "distillTeachingApproach">;
  workspaceRoot: string;
  incidentId: string;
}): Promise<LearningStrategyVariantDto | null> {
  try {
    if (!deps.runtime.distillTeachingApproach) return null;
    const incident = deps.learning.getIncident(deps.incidentId);
    if (!incident || incident.status !== "resolved") return null;
    const session = deps.learning.getSessionForIncident(deps.incidentId);
    if (!session || session.datasetKind !== "live" || session.condition !== "on-call") return null;
    if (session.executionMode !== "agent") return null;
    const interventions = deps.learning.listInterventions(deps.incidentId);
    // Round one already worked → the generic strategy sufficed; nothing to invent.
    if (interventions.length < 2) return null;
    const verifications = deps.learning.listVerifications(deps.incidentId);
    const confirmed = verifications.filter((item) => item.finalVerdict === "resolved").at(-1);
    const winning =
      (confirmed?.interventionId ? interventions.find((item) => item.id === confirmed.interventionId) : undefined) ??
      interventions.at(-1)!;
    if (!winning.messageId) return null;
    const message = deps.store.getMessage(winning.messageId);
    const interventionText = message?.content?.trim() ?? "";
    if (!interventionText) return null;
    const failedStrategies = interventions.filter((item) => item.id !== winning.id).map((item) => item.strategy);
    const distilled = await deps.runtime.distillTeachingApproach({
      workspacePath: path.join(deps.workspaceRoot, session.conversationId),
      goal: session.goal,
      hypothesis: incident.hypothesis,
      difficultyType: incident.difficultyType,
      failedStrategies,
      winningStrategy: winning.strategy,
      interventionText,
      verificationPrompt: confirmed?.prompt ?? ""
    });
    if (!distilled) return null;
    return deps.learning.createVariant({
      profileId: session.profileId,
      participantId: session.participantId,
      topicKey: session.topicKey,
      difficultyType: incident.difficultyType,
      // The host, not the model, decides which base strategy the approach refines.
      baseStrategy: winning.strategy,
      title: distilled.title,
      instruction: distilled.instruction,
      sourceIncidentId: incident.id
    });
  } catch {
    // Invention is opportunistic and must never fail the confirmation that triggered it.
    return null;
  }
}
