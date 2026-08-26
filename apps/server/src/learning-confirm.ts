import type { EventStore } from "./event-store.js";
import type { LearningStore } from "./learning-store.js";
import type { AgentRuntime } from "./runtime.js";
import { maybeDistillFromResolvedIncident } from "./learning-invention.js";

type LearningStoreConfirm = ReturnType<LearningStore["confirmVerification"]>;
type LearningStoreIncident = NonNullable<ReturnType<LearningStore["getIncident"]>>;
type LearningStoreSession = NonNullable<ReturnType<LearningStore["getSessionForIncident"]>>;
type LearningStorePolicy = ReturnType<LearningStore["maybeCreatePendingPolicyRevision"]>;

/**
 * The learner-voiced follow-ups the web client auto-sends when a confirmation leaves the
 * incident `diagnosed` — i.e. the loop wants another round (i18n `learningTryAnotherPrompt`
 * / `learningPartialPrompt`). The Feishu confirm card sends the same message server-side so
 * the next intervention round starts on every channel.
 */
export const LEARNING_TRY_ANOTHER_PROMPT = "我仍未解决。请使用下一种教学策略换种讲法，并在新情境中再次验证我的理解。";
export const LEARNING_PARTIAL_PROMPT =
  "我只理解了一部分。请针对我还没弄懂的地方换种讲法，并在新情境中再次验证我的理解。";

/**
 * `diagnosed` after a confirmation means the loop is owed another round, and that is true of
 * `partial` as much as of `unresolved` — gate the follow-up on the incident status, never on
 * the verdict alone, or a partial confirmation parks the incident forever.
 */
export function learningFollowUpPrompt(verdict: "resolved" | "partial" | "unresolved"): string | null {
  if (verdict === "partial") return LEARNING_PARTIAL_PROMPT;
  if (verdict === "unresolved") return LEARNING_TRY_ANOTHER_PROMPT;
  return null;
}

type LearningConfirmStore = Pick<
  LearningStore,
  | "confirmVerification"
  | "getIncident"
  | "getSessionForIncident"
  | "maybeCreatePendingPolicyRevision"
  | "maybeRecommendVariantPromotion"
>;

/** Optional wiring for 讲法 distillation; confirmation works without it (e.g. demo runtimes). */
export interface LearningInventionDeps {
  learning: LearningStore;
  store: { getMessage(id: string): { content: string } | null | undefined };
  runtime: Pick<AgentRuntime, "distillTeachingApproach">;
  workspaceRoot: string;
}

interface ConversationLookup {
  getConversation(id: string): { id: string; activeBranchId: string } | null | undefined;
}

export interface LearningConfirmResult {
  verification: LearningStoreConfirm;
  incident: LearningStoreIncident;
  session: LearningStoreSession;
  policy: LearningStorePolicy;
}

/**
 * Confirms a learning verification with the learner's verdict and fans out the incident and
 * policy events — the one semantic shared by the web confirm route and the Feishu confirm card.
 */
export function confirmLearningVerification(
  deps: {
    learning: LearningConfirmStore;
    store: ConversationLookup;
    events: EventStore;
    invention?: LearningInventionDeps | undefined;
  },
  verificationId: string,
  verdict: "resolved" | "partial" | "unresolved"
): LearningConfirmResult {
  const verification = deps.learning.confirmVerification(verificationId, verdict);
  const incident = deps.learning.getIncident(verification.incidentId);
  if (!incident) throw new Error("Learning incident not found after confirmation");
  const session = deps.learning.getSessionForIncident(incident.id);
  if (!session) throw new Error("Learning session not found after confirmation");
  const conversation = deps.store.getConversation(session.conversationId);
  if (conversation) {
    deps.events.append({
      type: "learning.incident.updated",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { incident }
    });
  }
  const policy = deps.learning.maybeCreatePendingPolicyRevision({
    profileId: session.profileId,
    participantId: session.participantId,
    topicKey: session.topicKey,
    difficultyType: incident.difficultyType,
    datasetKind: session.datasetKind
  });
  if (policy && conversation) {
    deps.events.append({
      type: "learning.policy.updated",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { policy }
    });
  }
  if (session.datasetKind === "live" && session.condition === "on-call") {
    try {
      // Cheap SQL: each confirmed outcome may shift a trial variant's posterior.
      deps.learning.maybeRecommendVariantPromotion({
        profileId: session.profileId,
        participantId: session.participantId,
        topicKey: session.topicKey,
        difficultyType: incident.difficultyType
      });
    } catch {
      // Recommendations are advisory; never fail the confirmation over them.
    }
    if (deps.invention && incident.status === "resolved") {
      // Fire-and-forget: a 20s background model call must not hold the learner's click.
      void maybeDistillFromResolvedIncident({ ...deps.invention, incidentId: incident.id });
    }
  }
  return { verification, incident, session, policy };
}
