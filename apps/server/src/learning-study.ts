import {
  has,
  LEARNING_CONDITIONS,
  type LearningCondition,
  type LearningConditionAssignment
} from "./learning-store.js";

/**
 * Study-mode condition assignment. A study draws each new learning session's research
 * condition from a seeded, block-balanced sequence so the allocation is reproducible after
 * the fact: the session's `conditionAssignment` records `(seed, index, conditions)`, which
 * re-derives the draw exactly — the arm list is part of the record because the mapping from
 * PRNG values to arms depends on it.
 */
export interface StudyConfig {
  /** When true, web sessions created without an explicit condition are randomized too. */
  randomize: boolean;
  /** The arms the draw picks between; order matters for reproducibility. */
  conditions: LearningCondition[];
  seed: number;
  /** How many draws have been consumed from this seed's sequence. */
  counter: number;
  /** Seeds retired by later seed changes; reusing one would mint duplicate (seed, index) ids. */
  usedSeeds: number[];
}

const MAX_SEED = 0xffffffff; // mulberry32 folds anything wider, silently merging sequences.

export const DEFAULT_STUDY_CONFIG: StudyConfig = Object.freeze({
  randomize: false,
  conditions: Object.freeze(["on-call", "multi-turn"]) as unknown as LearningCondition[],
  seed: 1,
  counter: 0,
  usedSeeds: Object.freeze([]) as unknown as number[]
});

const isCondition = (value: unknown): value is LearningCondition =>
  typeof value === "string" && has(LEARNING_CONDITIONS, value);

const toCount = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SEED ? value : fallback;

/** Accepts whatever is stored in settings (or a PUT body) and returns a safe config. */
export function normalizeStudyConfig(value: unknown): StudyConfig {
  const raw = (value ?? {}) as Record<string, unknown>;
  const conditions = Array.isArray(raw.conditions) ? raw.conditions.filter(isCondition) : [];
  const deduped = [...new Set(conditions)];
  const usedSeeds = Array.isArray(raw.usedSeeds)
    ? [...new Set(raw.usedSeeds.filter((seed): seed is number => toCount(seed, -1) !== -1))]
    : [];
  return {
    randomize: raw.randomize === true,
    conditions: deduped.length >= 2 ? deduped : [...DEFAULT_STUDY_CONFIG.conditions],
    seed: toCount(raw.seed, DEFAULT_STUDY_CONFIG.seed),
    counter: toCount(raw.counter, DEFAULT_STUDY_CONFIG.counter),
    usedSeeds
  };
}

// Deterministic PRNG (mulberry32). Small, dependency-free, and stable across platforms —
// integer ops only, so the same inputs reproduce the same draw in any future audit.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StudyDraw {
  condition: LearningCondition;
  assignment: LearningConditionAssignment;
  /** Persist this back to settings AFTER the session write succeeds, so a failed request never consumes an index. */
  nextConfig: StudyConfig;
}

/**
 * Draws the next condition using permuted-block randomization: with k arms, every
 * consecutive block of k draws contains each arm exactly once (a per-block Fisher–Yates
 * shuffle), so small studies cannot drift lopsided the way independent draws can.
 *
 * Re-derivation contract (this comment is the spec an auditor implements): for
 * `{seed, index, conditions}` with k = conditions.length, let block = floor(index / k) and
 * pos = index % k. Seed a fresh mulberry32 with `(seed ^ Math.imul(block + 1, 0x9e3779b1)) >>> 0`,
 * Fisher–Yates-shuffle the array [0..k-1] using its successive values
 * (for i from k-1 down to 1: j = floor(next() * (i + 1)); swap), and the drawn arm is
 * `conditions[perm[pos]]`.
 */
export function drawStudyCondition(config: StudyConfig): StudyDraw {
  const conditions = config.conditions;
  if (conditions.length < 2) throw new Error("A study needs at least two distinct conditions");
  const k = conditions.length;
  const block = Math.floor(config.counter / k);
  const pos = config.counter % k;
  const rng = mulberry32((config.seed ^ Math.imul(block + 1, 0x9e3779b1)) >>> 0);
  const perm = Array.from({ length: k }, (_, i) => i);
  for (let i = k - 1; i >= 1; i -= 1) {
    const j = Math.min(Math.floor(rng() * (i + 1)), i);
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  const condition = conditions[perm[pos]!]!;
  return {
    condition,
    assignment: { seed: config.seed, index: config.counter, conditions: [...conditions] },
    nextConfig: { ...config, conditions: [...conditions], counter: config.counter + 1 }
  };
}
