import { describe, expect, it } from "vitest";
import { DEFAULT_STUDY_CONFIG, drawStudyCondition, normalizeStudyConfig } from "../src/learning-study.js";

describe("learning study assignment", () => {
  it("normalizes stored config and rejects malformed values", () => {
    expect(normalizeStudyConfig(undefined)).toEqual({ ...DEFAULT_STUDY_CONFIG, usedSeeds: [] });
    expect(
      normalizeStudyConfig({ randomize: true, conditions: ["one-shot", "one-shot", "nope"], seed: -3, counter: 1.5 })
    ).toEqual({
      // A single valid arm is not a study; fall back to the default pair.
      randomize: true,
      conditions: [...DEFAULT_STUDY_CONFIG.conditions],
      seed: DEFAULT_STUDY_CONFIG.seed,
      counter: DEFAULT_STUDY_CONFIG.counter,
      usedSeeds: []
    });
    // Seeds wider than 32 bits would be silently folded by the PRNG, merging sequences that
    // record distinct seeds — normalize refuses them.
    expect(normalizeStudyConfig({ seed: 2 ** 33 }).seed).toBe(DEFAULT_STUDY_CONFIG.seed);
    expect(
      normalizeStudyConfig({
        randomize: false,
        conditions: ["one-shot", "multi-turn"],
        seed: 9,
        counter: 4,
        usedSeeds: [1, 1, 3]
      })
    ).toEqual({ randomize: false, conditions: ["one-shot", "multi-turn"], seed: 9, counter: 4, usedSeeds: [1, 3] });
  });

  it("balances every block: with k arms, each consecutive block of k draws contains each arm once", () => {
    let config = normalizeStudyConfig({ conditions: ["on-call", "multi-turn"], seed: 42, counter: 0 });
    const sequence: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const draw = drawStudyCondition(config);
      expect(draw.assignment).toEqual({ seed: 42, index: i, conditions: ["on-call", "multi-turn"] });
      sequence.push(draw.condition);
      config = draw.nextConfig;
    }
    for (let block = 0; block < 10; block += 1) {
      expect(new Set(sequence.slice(block * 2, block * 2 + 2))).toEqual(new Set(["on-call", "multi-turn"]));
    }
    // Not a fixed alternation either: across enough blocks both orders occur.
    const firstOfBlock = new Set(Array.from({ length: 10 }, (_, block) => sequence[block * 2]));
    expect(firstOfBlock.size).toBe(2);
  });

  it("re-derives any assignment from (seed, index, conditions) alone", () => {
    const arms = ["one-shot", "multi-turn", "on-call"] as const;
    let config = normalizeStudyConfig({ conditions: [...arms], seed: 7, counter: 0 });
    const drawn: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const draw = drawStudyCondition(config);
      drawn.push(draw.condition);
      config = draw.nextConfig;
    }
    for (let i = 0; i < 9; i += 1) {
      const replay = drawStudyCondition(normalizeStudyConfig({ conditions: [...arms], seed: 7, counter: i }));
      expect(replay.condition).toBe(drawn[i]);
    }
    // Three arms → every block of three is a permutation of all arms.
    for (let block = 0; block < 3; block += 1) {
      expect(new Set(drawn.slice(block * 3, block * 3 + 3)).size).toBe(3);
    }
  });

  it("throws instead of substituting arms when the config is degenerate", () => {
    expect(() =>
      drawStudyCondition({ randomize: true, conditions: [], seed: 1, counter: 0, usedSeeds: [] })
    ).toThrowError(/two distinct conditions/);
  });
});
