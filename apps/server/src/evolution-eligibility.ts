import type { LearningStore } from "./learning-store.js";
import type { RunReplayStore } from "./run-replay.js";

/**
 * Synthetic conversations must stay out of user memories and self-evolution
 * statistics: demo/eval learning sessions carry scripted or simulated learners,
 * and replay conversations re-execute frozen inputs as experiments. Replay
 * conversations of ordinary runs have no learning session, so the replay mark
 * is the only reliable detector for them.
 */
export function isEvolutionEligibleConversation(
  conversationId: string,
  deps: {
    learning?: Pick<LearningStore, "getSessionForConversation"> | null | undefined;
    replay?: Pick<RunReplayStore, "markForConversation"> | null | undefined;
  }
): boolean {
  const session = deps.learning?.getSessionForConversation(conversationId);
  if (session && session.datasetKind !== "live") return false;
  if (deps.replay?.markForConversation(conversationId)) return false;
  return true;
}
