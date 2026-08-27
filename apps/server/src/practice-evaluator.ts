/**
 * Quality gates for in-loop practice-task generation. Three tiers, in order:
 *
 *   1. programmatic checks — deterministic, hard: caps, answer leakage;
 *   2. novelty vs the session's corpus — deterministic, hard: a reused or re-skinned task
 *      would let the learner pass verification from memory;
 *   3. an LLM evaluator — advisory-strict: its rejection counts, but an infrastructure
 *      error fails OPEN (the deterministic gates already passed, and background model
 *      calls must never block the loop).
 *
 * The pipeline is pure apart from the injected `evaluate` callback, so every path is
 * unit-testable without a model.
 */

export interface PracticeDraft {
  taskText: string;
  targetHypothesis: string;
  expectedAnswerSketch: string;
  difficulty: number;
}

export interface PracticeEvaluatorChecks {
  correctness: "pass" | "fail" | "unsure";
  fitToHypothesis: "pass" | "fail" | "unsure";
  difficulty: "pass" | "fail" | "unsure";
  novelty: "pass" | "fail" | "unsure";
}

export type PracticeEvaluatorVerdict =
  | { status: "approved" | "rejected"; checks: PracticeEvaluatorChecks; reasons: string[] }
  | { status: "error"; reasons: string[] };

export interface PracticePipelineResult {
  status: "approved" | "rejected";
  gate: "programmatic" | "novelty" | "evaluator" | "none";
  noveltyScore: number;
  verdict: PracticeEvaluatorVerdict | null;
  reasons: string[];
}

export const PRACTICE_NOVELTY_THRESHOLD = 0.6;
const ANSWER_LEAK_THRESHOLD = 0.75;

/**
 * Tokens for overlap comparison, script-agnostic: latin-ish words plus CJK character
 * bigrams, so both "conflict miss" and "冲突未命中" compare meaningfully without a
 * language-specific tokenizer.
 */
export function overlapTokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const match of lower.matchAll(/[a-z0-9_]+/g)) tokens.add(match[0]);
  const cjk = [...lower].filter((char) => /\p{Script=Han}/u.test(char));
  for (let i = 0; i < cjk.length - 1; i += 1) tokens.add(cjk[i]! + cjk[i + 1]!);
  if (cjk.length === 1) tokens.add(cjk[0]!);
  return tokens;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Highest similarity between the task and any corpus entry — 0 when the corpus is empty. */
export function noveltyScore(taskText: string, corpus: string[]): number {
  const task = overlapTokens(taskText);
  let worst = 0;
  for (const entry of corpus) {
    const score = jaccard(task, overlapTokens(entry));
    if (score > worst) worst = score;
  }
  return worst;
}

/**
 * Length guard for the leak checks, weighted so both scripts qualify at comparable
 * information content: a CJK character carries roughly a latin word's worth per two
 * characters, so a 6-character Chinese sentence fragment counts like a 12-letter one.
 * Very short sketches ("命中", "yes") stay exempt — they appear in any legitimate task
 * and would make the substring check fire constantly.
 */
function leakGuardWeight(text: string): number {
  let weight = 0;
  for (const char of text) weight += /\p{Script=Han}/u.test(char) ? 2 : 1;
  return weight;
}

/** Deterministic tier-1 checks. Reasons are written for the tutor model to act on. */
export function programmaticPracticeGate(draft: PracticeDraft): string[] {
  const reasons: string[] = [];
  if (!draft.taskText.trim()) reasons.push("The task text is empty.");
  if (!Number.isInteger(draft.difficulty) || draft.difficulty < 1 || draft.difficulty > 5)
    reasons.push("Difficulty must be an integer from 1 to 5.");
  // Answer leakage: a task that contains its own expected answer verifies memory of this
  // very message, not understanding.
  const sketch = draft.expectedAnswerSketch.trim();
  if (leakGuardWeight(sketch) >= 12) {
    const normalizedTask = draft.taskText.toLowerCase().replace(/\s+/g, " ");
    const normalizedSketch = sketch.toLowerCase().replace(/\s+/g, " ");
    if (normalizedTask.includes(normalizedSketch))
      reasons.push(
        "The task text contains the expected answer verbatim; the check would test copying, not understanding."
      );
  }
  // Containment, not symmetric Jaccard: a task is always longer than its answer, so the
  // symmetric ratio can never clear a high threshold — what matters is how much of the
  // ANSWER already sits inside the task. Guarded to multi-token sketches because a single
  // term ("命中") legitimately appears in the task that asks about it.
  const sketchTokens = overlapTokens(sketch);
  if (sketchTokens.size >= 4) {
    const taskTokens = overlapTokens(draft.taskText);
    let contained = 0;
    for (const token of sketchTokens) if (taskTokens.has(token)) contained += 1;
    if (contained / sketchTokens.size > ANSWER_LEAK_THRESHOLD)
      reasons.push(
        "The task text already contains almost all of the expected answer; rephrase the task so the answer is not given away."
      );
  }
  return reasons;
}

/**
 * How much of the learner-visible corpus the tier-3 judge is shown. The novelty check is
 * only as informed as what it can see, and a background call has to stay small.
 */
export const EVALUATOR_CORPUS_ENTRIES = 8;
export const EVALUATOR_CORPUS_ENTRY_CHARS = 400;

export const PRACTICE_EVALUATOR_SYSTEM_PROMPT =
  "You review a drafted practice task before it reaches a learner. Judge only what is in front of you. Reject when: the task's premise or expected answer is wrong (correctness); the task would not discriminate the stated misconception — a learner still holding it could answer correctly (fitToHypothesis); the difficulty is clearly mismatched to the stated level (difficulty); or the task is a trivial re-skin of one of the alreadySeenByLearner texts (novelty). Approve otherwise. Give short, actionable reasons when rejecting.";

/**
 * The tier-3 request, built here rather than at the call site so an offline harness judges
 * with exactly the prompt production uses. A harness holding its own copy would drift
 * silently, and a drifted harness measures a evaluator nobody runs.
 */
export function buildPracticeEvaluatorRequest(input: {
  draft: PracticeDraft;
  hypothesis: string;
  goal: string;
  corpus: string[];
}): { systemPrompt: string; prompt: string; schema: Record<string, unknown> } {
  const checkEnum = { type: "string", enum: ["pass", "fail", "unsure"] };
  return {
    systemPrompt: PRACTICE_EVALUATOR_SYSTEM_PROMPT,
    prompt: JSON.stringify({
      learningGoal: input.goal,
      diagnosedMisconception: input.hypothesis,
      alreadySeenByLearner: input.corpus
        .slice(-EVALUATOR_CORPUS_ENTRIES)
        .map((text) => text.slice(0, EVALUATOR_CORPUS_ENTRY_CHARS)),
      draft: input.draft
    }),
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["approved", "checks", "reasons"],
      properties: {
        approved: { type: "boolean" },
        checks: {
          type: "object",
          additionalProperties: false,
          required: ["correctness", "fitToHypothesis", "difficulty", "novelty"],
          properties: {
            correctness: checkEnum,
            fitToHypothesis: checkEnum,
            difficulty: checkEnum,
            novelty: checkEnum
          }
        },
        reasons: { type: "array", items: { type: "string" } }
      }
    }
  };
}

/**
 * Verdict decided by `approved` alone. The four checks are recorded for the calibration
 * protocol but deliberately do not vote: a model that rejects has to say so in the field
 * the pipeline reads, and one that approves while failing a check is a disagreement worth
 * seeing in the record rather than one silently overridden here.
 */
export function parsePracticeEvaluatorVerdict(raw: Record<string, unknown> | null): PracticeEvaluatorVerdict {
  if (!raw || typeof raw.approved !== "boolean") return { status: "error", reasons: ["evaluator returned no verdict"] };
  const checks = (raw.checks ?? {}) as Record<string, unknown>;
  const check = (value: unknown): "pass" | "fail" | "unsure" =>
    value === "pass" || value === "fail" ? value : "unsure";
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.map((reason) => String(reason)).slice(0, 8) : [];
  return {
    status: raw.approved ? "approved" : "rejected",
    checks: {
      correctness: check(checks.correctness),
      fitToHypothesis: check(checks.fitToHypothesis),
      difficulty: check(checks.difficulty),
      novelty: check(checks.novelty)
    },
    reasons:
      raw.approved || reasons.length > 0
        ? reasons
        : ["The evaluator rejected the draft without naming a reason; revise and retry."]
  };
}

/** True when the model approved a draft while marking one of the four checks failed. */
export function verdictIsIncoherent(verdict: PracticeEvaluatorVerdict): boolean {
  if (verdict.status !== "approved") return false;
  return Object.values(verdict.checks).some((value) => value === "fail");
}

/**
 * Full three-tier pipeline. `evaluate` runs the LLM tier and may throw or return
 * `{status:"error"}`; both fail open per the loop's background-call convention — the
 * deterministic gates stay hard either way.
 */
export async function runPracticePipeline(input: {
  draft: PracticeDraft;
  corpus: string[];
  evaluate: (draft: PracticeDraft) => Promise<PracticeEvaluatorVerdict>;
}): Promise<PracticePipelineResult> {
  const programmatic = programmaticPracticeGate(input.draft);
  const novelty = noveltyScore(input.draft.taskText, input.corpus);
  if (programmatic.length > 0)
    return { status: "rejected", gate: "programmatic", noveltyScore: novelty, verdict: null, reasons: programmatic };
  if (novelty > PRACTICE_NOVELTY_THRESHOLD)
    return {
      status: "rejected",
      gate: "novelty",
      noveltyScore: novelty,
      verdict: null,
      reasons: [
        "The task is too close to an earlier task or verification in this session; the learner could pass it from memory. Change the situation, not just the wording."
      ]
    };
  let verdict: PracticeEvaluatorVerdict;
  try {
    verdict = await input.evaluate(input.draft);
  } catch (error) {
    verdict = { status: "error", reasons: [String((error as Error)?.message ?? error)] };
  }
  if (verdict.status === "rejected")
    return { status: "rejected", gate: "evaluator", noveltyScore: novelty, verdict, reasons: verdict.reasons };
  return { status: "approved", gate: "none", noveltyScore: novelty, verdict, reasons: [] };
}
