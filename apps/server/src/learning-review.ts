import type { LearningReviewTask, LearningStore } from "./learning-store.js";

interface ReviewSubmitter {
  submit(conversationId: string, content: string): { id: string } | unknown;
}

interface ConversationLookup {
  getConversation(id: string): { id: string } | null | undefined;
}

/** Held tasks (paused session, unreachable channel) retry after an hour instead of blocking. */
const HOLD_DEFER_MS = 60 * 60 * 1_000;
/** A fired revisit whose confirmation never linked back is abandoned after a week. */
const FIRED_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Fires due spaced-review tasks by posting a learner-voiced revisit prompt into the
 * original learning conversation, where the real agent runs the loop again with a fresh
 * transfer task. Enqueueing and round-two booking live in LearningStore.confirmVerification;
 * this runner only decides whether a due task can still fire.
 */
export class LearningReviewRunner {
  private running = false;

  constructor(
    private readonly learning: LearningStore,
    private readonly store: ConversationLookup,
    private readonly orchestrator: ReviewSubmitter,
    private readonly clock: () => number = Date.now,
    /**
     * Channel deliverability check (e.g. a Feishu conversation whose binding rotated away
     * after /new cannot show the learner anything). Undefined means always deliverable.
     */
    private readonly reachable?: (conversationId: string) => boolean
  ) {}

  tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.learning.expireFiredReviewTasks(this.clock() - FIRED_EXPIRY_MS);
      for (const task of this.learning.dueReviewTasks(this.clock())) this.fire(task);
    } finally {
      this.running = false;
    }
  }

  private fire(task: LearningReviewTask): void {
    try {
      if (!this.store.getConversation(task.conversationId)) {
        this.learning.markReviewTask(task.id, "cancelled");
        return;
      }
      const session = this.learning.getSessionForConversation(task.conversationId);
      if (
        !session ||
        session.id !== task.sessionId ||
        session.status === "completed" ||
        session.status === "dismissed"
      ) {
        this.learning.markReviewTask(task.id, "cancelled");
        return;
      }
      // Held tasks are DEFERRED, not left due: a pile of overdue tasks from paused sessions
      // sitting at the head of the due window would otherwise starve every later-due task.
      if (session.status !== "active" || (this.reachable && !this.reachable(task.conversationId))) {
        this.learning.deferReviewTask(task.id, this.clock() + HOLD_DEFER_MS);
        return;
      }
      const incident = this.learning.getIncident(task.incidentId);
      const focus = (incident?.hypothesis || session.goal || "").replace(/\s+/g, " ").trim().slice(0, 120);
      // Fired before submit: losing one revisit beats double-posting it into the chat.
      this.learning.markReviewTask(task.id, "fired");
      const run = this.orchestrator.submit(task.conversationId, reviewPrompt(task.round, focus));
      // The run id is the linkage confirmVerification uses to tell the revisit's own
      // confirmation apart from unrelated confirmations in the same session.
      const runId = (run as { id?: unknown } | null | undefined)?.id;
      if (typeof runId === "string" && runId) this.learning.attachReviewRun(task.id, runId);
    } catch {
      // Reviews are opportunistic; a failed fire must never break the shared tick loop.
    }
  }
}

function reviewPrompt(round: 1 | 2, focus: string): string {
  const opener = round === 1 ? "距离我们解决这个困难已经过了两天" : "距离上次复习又过了几天";
  const anchor = focus ? `（${focus}）` : "";
  return `【间隔复习回访】${opener}。请针对我此前的困难${anchor}出一道全新的迁移小任务考考我——换一个情境，不要重复原题——并照常走学习回路记录这次回访。`;
}
