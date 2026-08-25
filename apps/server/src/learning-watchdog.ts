import type { LearningIncidentStatus, LearningStallCandidate, LearningStore } from "./learning-store.js";

interface WatchdogOrchestrator {
  submit(conversationId: string, content: string): { id: string } | unknown;
  isConversationBusy(conversationId: string): boolean;
}

interface ConversationLookup {
  getConversation(id: string): { id: string } | null | undefined;
}

/** Completed runs since the incident last moved before the standing prompt nudge is escalated. */
const STALL_TURNS = 2;
/** Threads with no completed run for this long are left alone — a boot-time tick must not resurrect a dead conversation. */
const MAX_STALL_AGE_MS = 24 * 60 * 60 * 1_000;
/** A nudged row with no run id and no run after it for this long is a crash orphan: the nudge never posted. */
const ORPHAN_NUDGE_MS = 5 * 60 * 1_000;

/**
 * Reliability watchdog for the learning loop. The offline eval measured ~6% of sessions
 * where the tutor stopped driving the state machine mid-run — kept asking questions in
 * prose without calling the learning tools. The prompt-level defense (nextStepInstruction)
 * is the first line; this runner is the second: when an incident owes a tutor move and two
 * completed turns pass without one, it posts a single phase-matched, bracket-labelled
 * reminder into the conversation. If the next turn still moves nothing, it records
 * `gave_up` and stops — stalls surface in the metrics rather than triggering nudge loops.
 *
 * Stateless by design: every tick reclassifies from the database (tool calls, incident
 * timestamps, and its own ledger), so restarts cannot double-nudge and failed runs are
 * still seen. Live agent sessions only — eval has its own nudge harness, and demo/replay
 * are scripted.
 */
export class LearningWatchdog {
  private running = false;

  constructor(
    private readonly learning: LearningStore,
    private readonly store: ConversationLookup,
    private readonly orchestrator: WatchdogOrchestrator,
    private readonly clock: () => number = Date.now,
    /** Channel deliverability check, same contract as LearningReviewRunner's. */
    private readonly reachable?: (conversationId: string) => boolean
  ) {}

  tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      for (const candidate of this.learning.stallCandidates()) this.inspect(candidate);
    } finally {
      this.running = false;
    }
  }

  private inspect(candidate: LearningStallCandidate): void {
    try {
      if (candidate.runsSinceProgress < STALL_TURNS) return;
      // Stale threads stay untouched: after a restart (or a learner who walked away days
      // ago) the stall is a metric, not something to resurrect with a fresh message.
      if (candidate.lastRunAt !== null && this.clock() - candidate.lastRunAt > MAX_STALL_AGE_MS) return;
      if (!this.store.getConversation(candidate.conversationId)) return;
      if (this.reachable && !this.reachable(candidate.conversationId)) return;
      // A busy conversation is mid-turn: the signature may be about to change, and a nudge
      // would queue behind an answer it might be stale for. The next tick re-evaluates.
      if (this.orchestrator.isConversationBusy(candidate.conversationId)) return;
      const nudged = this.learning.watchdogEvent(candidate.incidentId, candidate.signature, "nudged");
      if (nudged) {
        const runsAfterNudge = this.learning.completedRunsAfter(candidate.conversationId, nudged.createdAt);
        // A nudged row with no run id, no run since, and real age is a crash orphan — the
        // process died between the ledger write and the submit, so nothing was posted. It
        // must not age into a false gave_up; clear it and fall through to a fresh nudge.
        const orphan =
          nudged.runId === null && runsAfterNudge === 0 && this.clock() - nudged.createdAt > ORPHAN_NUDGE_MS;
        if (!orphan) {
          if (this.learning.watchdogEvent(candidate.incidentId, candidate.signature, "gave_up")) return;
          // Give the nudge its turn: only after a completed run that changed nothing do we
          // record the stall as final. One gave_up per signature, then silence.
          if (runsAfterNudge >= 1)
            this.learning.recordWatchdogEvent({
              sessionId: candidate.sessionId,
              incidentId: candidate.incidentId,
              signature: candidate.signature,
              action: "gave_up"
            });
          return;
        }
        this.learning.deleteWatchdogEvent(nudged.id);
      }
      // Ledger row before submit (fired-before-submit, same as spaced reviews): losing one
      // nudge beats double-posting it.
      const eventId = this.learning.recordWatchdogEvent({
        sessionId: candidate.sessionId,
        incidentId: candidate.incidentId,
        signature: candidate.signature,
        action: "nudged"
      });
      try {
        const run = this.orchestrator.submit(candidate.conversationId, watchdogPrompt(candidate.status));
        const runId = (run as { id?: unknown } | null | undefined)?.id;
        if (typeof runId === "string" && runId) this.learning.attachWatchdogRun(eventId, runId);
      } catch (error) {
        // Submit failed: compensate the ledger so the phantom nudge cannot become a stall
        // statistic, then let the outer guard swallow the error.
        this.learning.deleteWatchdogEvent(eventId);
        throw error;
      }
    } catch {
      // The watchdog is opportunistic; one failed inspection must never break the tick loop.
    }
  }
}

/**
 * Phase-matched reminders, ported from the eval harness's nudges (a phase-mismatched nudge
 * derails the tutor). Bracket-labelled like the spaced-review prompt so the authorship is
 * honest — this is the loop speaking, not a fake learner message — while the framework
 * vocabulary stays out of the tutor's visible teaching voice.
 */
function watchdogPrompt(status: LearningIncidentStatus): string {
  if (status === "diagnosed")
    return "【学习回路提醒】上一轮之后教学还没有继续。请换一种方式继续讲解，并用一个新的情境检查我的理解。";
  if (status === "intervening") return "【学习回路提醒】请给我一个小任务或问题，检查我刚才是否真的理解了。";
  return "【学习回路提醒】我在上面已经给出了我的回答，请评估我的理解情况并给出你的判断。";
}
