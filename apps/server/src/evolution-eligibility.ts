import type { LearningStore } from "./learning-store.js";
import type { RunReplayStore } from "./run-replay.js";
import { DEFAULT_PARTICIPANT_ID, type AgentStore } from "./store.js";

/**
 * Synthetic conversations must stay out of user memories and self-evolution
 * statistics: demo/eval learning sessions carry scripted or simulated learners,
 * and replay conversations re-execute frozen inputs as experiments. Replay
 * conversations of ordinary runs have no learning session, so the replay mark
 * is the only reliable detector for them.
 *
 * Non-default participants are excluded the same way WHEN the store dep is passed:
 * memories and capability evolution belong to the machine's owner, and a study
 * participant's session must neither read from nor write into them — zero crosstalk
 * in both directions is a property of the study design, not just hygiene. The memory
 * coordinator deliberately omits the store dep and applies the participant rule
 * surgically instead, so titles and learning suggestions keep working for everyone.
 */
export function isEvolutionEligibleConversation(
  conversationId: string,
  deps: {
    learning?: Pick<LearningStore, "getSessionForConversation"> | null | undefined;
    replay?: Pick<RunReplayStore, "markForConversation"> | null | undefined;
    store?: Pick<AgentStore, "getConversation"> | null | undefined;
  }
): boolean {
  const session = deps.learning?.getSessionForConversation(conversationId);
  if (session && session.datasetKind !== "live") return false;
  if (deps.replay?.markForConversation(conversationId)) return false;
  const conversation = deps.store?.getConversation(conversationId);
  if (conversation && conversation.participantId !== DEFAULT_PARTICIPANT_ID) return false;
  return true;
}
