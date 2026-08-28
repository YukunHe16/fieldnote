import { describe, expect, it } from "vitest";
import {
  CACHE_BANK_SET_IDS,
  CacheBankValidationError,
  calculateAmat,
  calculateWriteTraffic,
  classifyColdCacheMisses,
  createCacheCandidate,
  mapCacheAddress,
  simulateColdCache,
  stableCacheJson,
  validateCacheScenario,
  verifyCacheCandidate,
  type CacheScenario
} from "../src/cache-bank.js";

const direct2 = { kind: "direct", lineSizeBytes: 4, capacityLines: 2 } as const;
const fully4 = { kind: "fully-associative", lineSizeBytes: 4, capacityLines: 4 } as const;
const fully2 = { kind: "fully-associative", lineSizeBytes: 4, capacityLines: 2 } as const;

const scenarios: Record<CacheScenario["kind"], CacheScenario> = {
  "trace-3c": {
    kind: "trace-3c",
    primary: { config: direct2, accesses: [0, 8, 0, 4, 8] },
    transfer: { config: direct2, accesses: [4, 12, 4, 0, 12] }
  },
  "compulsory-repeated": {
    kind: "compulsory-repeated",
    primary: { config: fully4, accesses: [0, 4, 0, 8, 4] },
    transfer: { config: fully4, accesses: [8, 12, 8, 16, 12] }
  },
  "fully-associative-working-set": {
    kind: "fully-associative-working-set",
    primary: { config: fully2, accesses: [0, 4, 0, 8, 4] },
    transfer: { config: fully2, accesses: [8, 12, 8, 16, 12] }
  },
  "write-policy-traffic": {
    kind: "write-policy-traffic",
    primary: {
      config: { kind: "direct", lineSizeBytes: 4, capacityLines: 1 },
      accesses: [
        { operation: "write", address: 0, sizeBytes: 1 },
        { operation: "write", address: 0, sizeBytes: 1 },
        { operation: "write", address: 4, sizeBytes: 1 }
      ],
      writeMissPolicy: "write-allocate",
      flushAtEnd: false
    },
    transfer: {
      config: { kind: "direct", lineSizeBytes: 8, capacityLines: 1 },
      accesses: [
        { operation: "write", address: 8, sizeBytes: 1 },
        { operation: "write", address: 8, sizeBytes: 1 },
        { operation: "write", address: 0, sizeBytes: 1 }
      ],
      writeMissPolicy: "write-allocate",
      flushAtEnd: false
    }
  },
  "set-mapping": {
    kind: "set-mapping",
    primary: {
      config: { kind: "set-associative", lineSizeBytes: 4, setCount: 4, ways: 2 },
      addresses: [0, 16, 4, 20]
    },
    transfer: {
      config: { kind: "set-associative", lineSizeBytes: 4, setCount: 4, ways: 2 },
      addresses: [8, 24, 12, 28]
    }
  },
  "amat-tradeoff": {
    kind: "amat-tradeoff",
    primary: {
      optionA: { hitTimeNs: 1, missRate: 0.05, missPenaltyNs: 50 },
      optionB: { hitTimeNs: 1.5, missRate: 0.02, missPenaltyNs: 60 }
    },
    transfer: {
      optionA: { hitTimeNs: 0.8, missRate: 0.08, missPenaltyNs: 30 },
      optionB: { hitTimeNs: 1.2, missRate: 0.03, missPenaltyNs: 45 }
    }
  }
};

describe("cache-bank deterministic oracles", () => {
  it("simulates direct, set-associative, and fully associative caches with LRU", () => {
    const direct = simulateColdCache(direct2, [0, 8, 0, 4, 8]);
    expect(direct.steps.map((step) => [step.hit, step.evictedBlock])).toEqual([
      [false, null],
      [false, 0],
      [false, 2],
      [false, null],
      [false, 0]
    ]);

    const set = simulateColdCache(
      { kind: "set-associative", lineSizeBytes: 4, setCount: 2, ways: 2 },
      [0, 8, 0, 16, 8]
    );
    expect(set.steps.map((step) => step.hit)).toEqual([false, false, true, false, false]);
    // The hit on block 0 makes block 2 the LRU victim when block 4 enters.
    expect(set.steps[3]?.evictedBlock).toBe(2);
    expect(set.steps[4]?.evictedBlock).toBe(0);

    const fully = simulateColdCache(fully2, [0, 4, 0, 8, 4]);
    expect(fully.steps.map((step) => step.hit)).toEqual([false, false, true, false, false]);
    expect(fully.steps[3]?.evictedBlock).toBe(1);
    expect(fully.steps[4]?.evictedBlock).toBe(0);
  });

  it("uses an equal-capacity fully associative baseline for exact 3C classification", () => {
    const result = classifyColdCacheMisses(direct2, [0, 8, 0, 4, 8]);
    expect(result.steps.map((step) => (step.hit ? "hit" : step.missClass))).toEqual([
      "compulsory",
      "compulsory",
      "conflict",
      "compulsory",
      "capacity"
    ]);
    expect(result).toMatchObject({ hits: 0, misses: 5, compulsoryMisses: 3, conflictMisses: 1, capacityMisses: 1 });

    const fully = classifyColdCacheMisses(fully2, [0, 4, 0, 8, 4]);
    expect(fully.conflictMisses).toBe(0);
    expect(fully.capacityMisses).toBe(1);
  });

  it("computes write-through, write-back, no-write-allocate, eviction, and flush traffic", () => {
    const accesses = [
      { operation: "write", address: 0, sizeBytes: 1 },
      { operation: "write", address: 0, sizeBytes: 1 },
      { operation: "write", address: 4, sizeBytes: 1 }
    ] as const;
    const config = { kind: "direct", lineSizeBytes: 4, capacityLines: 1 } as const;
    expect(
      calculateWriteTraffic(config, accesses, {
        policy: "write-through",
        writeMissPolicy: "write-allocate",
        flushAtEnd: false
      })
    ).toMatchObject({
      hits: 1,
      misses: 2,
      memoryReadBytes: 8,
      memoryWriteBytes: 3,
      writeBacks: 0,
      totalTrafficBytes: 11
    });
    expect(
      calculateWriteTraffic(config, accesses, {
        policy: "write-back",
        writeMissPolicy: "write-allocate",
        flushAtEnd: false
      })
    ).toMatchObject({
      hits: 1,
      misses: 2,
      memoryReadBytes: 8,
      memoryWriteBytes: 4,
      writeBacks: 1,
      totalTrafficBytes: 12
    });
    expect(
      calculateWriteTraffic(config, [{ operation: "write", address: 0, sizeBytes: 2 }], {
        policy: "write-back",
        writeMissPolicy: "no-write-allocate",
        flushAtEnd: true
      })
    ).toMatchObject({ memoryReadBytes: 0, memoryWriteBytes: 2, writeBacks: 0, totalTrafficBytes: 2 });
    expect(
      calculateWriteTraffic(config, [{ operation: "write", address: 0, sizeBytes: 1 }], {
        policy: "write-back",
        writeMissPolicy: "write-allocate",
        flushAtEnd: true
      })
    ).toMatchObject({ memoryReadBytes: 4, memoryWriteBytes: 4, writeBacks: 1, totalTrafficBytes: 8 });
  });

  it("maps block, set, tag, and offset and computes AMAT at boundary miss rates", () => {
    const config = { kind: "set-associative", lineSizeBytes: 16, setCount: 4, ways: 2 } as const;
    expect(mapCacheAddress(config, 0x5f)).toEqual({ address: 0x5f, blockNumber: 5, offset: 15, setIndex: 1, tag: 1 });
    expect(calculateAmat({ hitTimeNs: 1, missRate: 0, missPenaltyNs: 100 })).toBe(1);
    expect(calculateAmat({ hitTimeNs: 1, missRate: 1, missPenaltyNs: 100 })).toBe(101);
  });
});

describe("cache-bank rendering and hard gates", () => {
  it("renders all six sets deterministically with independent primary and transfer instruments", () => {
    expect(Object.keys(scenarios).sort()).toEqual([...CACHE_BANK_SET_IDS].sort());
    const hashes = new Set<string>();
    const signatures = new Set<string>();
    for (const setId of CACHE_BANK_SET_IDS) {
      const first = createCacheCandidate(scenarios[setId] as CacheScenario);
      const second = createCacheCandidate(structuredClone(scenarios[setId]) as CacheScenario);
      expect(first).toEqual(second);
      expect(first.setId).toBe(setId);
      expect(first.machineVerified).toBe(true);
      expect(first.primary.prompt).not.toBe(first.transfer.prompt);
      expect(first.parameterSignature).toMatch(new RegExp(`^${setId}:[a-f0-9]{64}$`));
      expect(first.candidateSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyCacheCandidate(first)).toEqual({
        valid: true,
        issues: [],
        parameterSignature: first.parameterSignature
      });
      hashes.add(first.candidateSha256);
      signatures.add(first.parameterSignature);
    }
    expect(hashes.size).toBe(6);
    expect(signatures.size).toBe(6);
  });

  it("canonicalizes object key order while preserving trace order", () => {
    expect(stableCacheJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(stableCacheJson({ values: [2, 1] })).not.toBe(stableCacheJson({ values: [1, 2] }));
    expect(() => stableCacheJson({ bad: Number.NaN })).toThrow(/Non-finite/);
  });

  it("rejects malformed schemas, out-of-range geometry, dependent transfers, and weak difficulty", () => {
    expect(validateCacheScenario({ kind: "unknown", primary: {}, transfer: {} })).toMatchObject({
      valid: false,
      issues: ["schema:scenario.kind is invalid"]
    });

    const extraKeys = structuredClone(scenarios["write-policy-traffic"]) as Extract<
      CacheScenario,
      { kind: "write-policy-traffic" }
    >;
    Object.assign(extraKeys, { answer: "leaked" });
    Object.assign(extraKeys.primary.config, { unexpected: true });
    Object.assign(extraKeys.primary.accesses[0]!, { hint: "extra" });
    expect(validateCacheScenario(extraKeys).issues).toEqual(
      expect.arrayContaining([
        "schema:scenario has unknown key answer",
        "schema:primary.config has unknown key unexpected",
        "schema:primary.accesses[0] has unknown key hint"
      ])
    );

    const badRange = structuredClone(scenarios["trace-3c"]) as Extract<CacheScenario, { kind: "trace-3c" }>;
    badRange.primary.config = { kind: "direct", lineSizeBytes: 3, capacityLines: 2 };
    expect(validateCacheScenario(badRange).issues).toContain(
      "range:primary.config.lineSizeBytes must be a power of two from 4 to 256"
    );

    const dependent = structuredClone(scenarios["trace-3c"]) as Extract<CacheScenario, { kind: "trace-3c" }>;
    dependent.transfer = structuredClone(dependent.primary);
    expect(validateCacheScenario(dependent).issues).toContain(
      "independence:primary and transfer parameters must differ"
    );

    const weak = structuredClone(scenarios["trace-3c"]) as Extract<CacheScenario, { kind: "trace-3c" }>;
    weak.primary.accesses = [0, 4, 8];
    expect(validateCacheScenario(weak).issues).toContain(
      "difficulty:primary must exhibit compulsory, conflict, and capacity misses"
    );

    const wrongOrganization = structuredClone(scenarios["fully-associative-working-set"]) as Extract<
      CacheScenario,
      { kind: "fully-associative-working-set" }
    >;
    wrongOrganization.primary.config = direct2;
    expect(validateCacheScenario(wrongOrganization).issues).toContain(
      "single_target:primary must use a fully associative cache"
    );
  });

  it("rejects cross-candidate duplicate parameters before rendering", () => {
    const candidate = createCacheCandidate(scenarios["amat-tradeoff"] as CacheScenario);
    const result = validateCacheScenario(scenarios["amat-tradeoff"], {
      seenParameterSignatures: new Set([candidate.parameterSignature])
    });
    expect(result).toMatchObject({ valid: false });
    expect(result.issues).toContain("duplicate_parameters:parameter signature already exists in this bank build");
    expect(() =>
      createCacheCandidate(scenarios["amat-tradeoff"] as CacheScenario, {
        seenParameterSignatures: new Set([candidate.parameterSignature])
      })
    ).toThrow(CacheBankValidationError);
  });

  it("recomputes oracles and rejects answer leakage, target drift, or content tampering", () => {
    const original = createCacheCandidate(scenarios["trace-3c"] as CacheScenario);

    const badOracle = structuredClone(original);
    if (badOracle.primary.oracle.kind !== "trace-3c") throw new Error("fixture drift");
    badOracle.primary.oracle.result.hits += 1;
    expect(verifyCacheCandidate(badOracle).issues).toContain("oracle_mismatch:primary oracle does not recompute");

    const leaked = structuredClone(original);
    leaked.transfer.prompt = `Answer is: ${leaked.transfer.canonicalAnswer}`;
    expect(verifyCacheCandidate(leaked).issues).toContain(
      "answer_leakage:transfer prompt exposes the canonical answer"
    );

    const drifted = structuredClone(original);
    drifted.targetConcept = "average-memory-access-time";
    expect(verifyCacheCandidate(drifted).issues).toContain(
      "single_target:set id or target concept does not match the scenario kind"
    );

    const staleHash = structuredClone(original);
    staleHash.primary.rubric = [...staleHash.primary.rubric, "invented criterion"];
    expect(verifyCacheCandidate(staleHash).issues).toEqual(
      expect.arrayContaining([
        "oracle_mismatch:primary rendering, rubric, or answer is not canonical",
        "oracle_mismatch:candidate SHA does not match canonical content"
      ])
    );
  });

  it("rejects line-crossing accesses and exercises inclusive calculator bounds", () => {
    const crossing = structuredClone(scenarios["write-policy-traffic"]) as Extract<
      CacheScenario,
      { kind: "write-policy-traffic" }
    >;
    crossing.primary.accesses[0] = { operation: "write", address: 3, sizeBytes: 2 };
    expect(validateCacheScenario(crossing).issues).toContain("range:primary.accesses[0] crosses a cache-line boundary");
    expect(() => simulateColdCache({ kind: "direct", lineSizeBytes: 4, capacityLines: 1 }, [-1])).toThrow(
      CacheBankValidationError
    );
    expect(() => calculateAmat({ hitTimeNs: 0.09, missRate: 0.5, missPenaltyNs: 10 })).toThrow(
      CacheBankValidationError
    );
  });
});
