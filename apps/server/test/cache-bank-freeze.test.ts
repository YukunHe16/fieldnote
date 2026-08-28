import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as cacheCore from "../src/cache-bank.js";
import type { CacheScenario } from "../src/cache-bank.js";
import {
  EVALUATOR_CHECKS,
  PUBLIC_BLUEPRINT,
  assertCacheCore,
  assertDistinctModelIds,
  newCheckpoint,
  parseEvaluatorResponse,
  runCacheBankFreeze,
  sha256,
  validateCheckpoint
} from "../../../scripts/cache-bank-freeze-lib.mjs";
import {
  atomicWriteJson,
  parseArgs,
  publishFrozenBank,
  requestModelText,
  validateBuildIdentity,
  validatePublishGate
} from "../../../scripts/cache-bank-freeze.mjs";
import { buildPosttestCases } from "../../../scripts/cache-bank-posttest-cases.mjs";
import {
  evaluateCacheStabilityGate,
  summarizeCacheStability,
  validateCasesPayload
} from "../../../scripts/cache-bank-stability.mjs";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const shift = (values: number[], offset: number) => values.map((value) => value + offset);
const direct = (lineSizeBytes: number, capacityLines: number) => ({
  kind: "direct" as const,
  lineSizeBytes,
  capacityLines
});
const fully = (lineSizeBytes: number, capacityLines: number) => ({
  kind: "fully-associative" as const,
  lineSizeBytes,
  capacityLines
});

function scenarioFor(setId: string, variant = 0): CacheScenario {
  const offset = variant * 256;
  if (setId === "trace-3c")
    return {
      kind: setId,
      primary: { config: direct(4, 2), accesses: shift([0, 8, 0, 4, 8], offset) },
      transfer: { config: direct(4, 2), accesses: shift([4, 12, 4, 0, 12], offset) }
    };
  if (setId === "compulsory-repeated")
    return {
      kind: setId,
      primary: { config: fully(4, 4), accesses: shift([0, 4, 0, 8, 4], offset) },
      transfer: { config: fully(4, 4), accesses: shift([8, 12, 8, 16, 12], offset) }
    };
  if (setId === "fully-associative-working-set")
    return {
      kind: setId,
      primary: { config: fully(4, 2), accesses: shift([0, 4, 0, 8, 4], offset) },
      transfer: { config: fully(4, 2), accesses: shift([8, 12, 8, 16, 12], offset) }
    };
  if (setId === "write-policy-traffic") {
    const accesses = (values: number[]) =>
      shift(values, offset).map((address) => ({ operation: "write" as const, address, sizeBytes: 1 }));
    return {
      kind: setId,
      primary: {
        config: direct(4, 1),
        accesses: accesses([0, 0, 4]),
        writeMissPolicy: "write-allocate",
        flushAtEnd: false
      },
      transfer: {
        config: direct(8, 1),
        accesses: accesses([8, 8, 0]),
        writeMissPolicy: "write-allocate",
        flushAtEnd: false
      }
    };
  }
  if (setId === "set-mapping")
    return {
      kind: setId,
      primary: {
        config: { kind: "set-associative", lineSizeBytes: 4, setCount: 4, ways: 2 },
        addresses: shift([0, 16, 4, 20], offset)
      },
      transfer: {
        config: { kind: "set-associative", lineSizeBytes: 4, setCount: 4, ways: 2 },
        addresses: shift([8, 24, 12, 28], offset)
      }
    };
  if (setId === "amat-tradeoff")
    return {
      kind: setId,
      primary: {
        optionA: { hitTimeNs: 1, missRate: 0.05, missPenaltyNs: 50 + variant },
        optionB: { hitTimeNs: 1.5, missRate: 0.02, missPenaltyNs: 60 + variant }
      },
      transfer: {
        optionA: { hitTimeNs: 0.8, missRate: 0.08, missPenaltyNs: 30 + variant },
        optionB: { hitTimeNs: 1.2, missRate: 0.03, missPenaltyNs: 45 + variant }
      }
    };
  throw new Error(`Unknown set ${setId}`);
}

const evaluatorResponse = (verdict: "pass" | "fail" | "unsure" = "pass") =>
  JSON.stringify({
    verdict,
    checks: Object.fromEntries(EVALUATOR_CHECKS.map((check) => [check, verdict])),
    reasons: [verdict === "pass" ? "equivalent and clear" : "does not clear the gate"]
  });
const provenance = () => ({
  gitSha: "a".repeat(40),
  gitDirty: false,
  buildSha: "a".repeat(40),
  verifierSha256: "c".repeat(64),
  startedAt: "2026-08-28T00:00:00.000Z",
  provider: {
    protocol: "anthropic-v1-messages",
    generatorBaseUrl: "https://generator.invalid",
    evaluatorBaseUrl: "https://evaluator.invalid"
  }
});

const generator = async ({
  blueprint,
  ordinal,
  count
}: {
  blueprint: { id: string };
  ordinal: number;
  count: number;
}) => {
  const start = ordinal === 1 ? 0 : 8;
  return JSON.stringify({
    candidates: Array.from({ length: count }, (_, index) => scenarioFor(blueprint.id, start + index))
  });
};

describe("cache bank freeze protocol", () => {
  it("uses the server cache core as the only schema, oracle, renderer, and verifier", () => {
    expect(assertCacheCore(cacheCore)).toBe(cacheCore);
    expect(PUBLIC_BLUEPRINT.map((entry) => entry.id)).toEqual([...cacheCore.CACHE_BANK_SET_IDS]);
    for (const setId of cacheCore.CACHE_BANK_SET_IDS) {
      const scenario = scenarioFor(setId);
      expect(cacheCore.validateCacheScenario(scenario), setId).toMatchObject({ valid: true, issues: [] });
      expect(cacheCore.verifyCacheCandidate(cacheCore.createCacheCandidate(scenario)), setId).toMatchObject({
        valid: true,
        issues: []
      });
    }
  });

  it("freezes six SHA-selected sets of four from one eight-candidate batch", async () => {
    let checkpoint: unknown = null;
    let evaluatorSawSameSetContext = false;
    const calls: Array<{ setId: string; ordinal: number; count: number }> = [];
    const result = await runCacheBankFreeze({
      checkpoint: null,
      seed: 7,
      provenance: provenance(),
      cacheCore,
      saveCheckpoint: async (value: unknown) => {
        checkpoint = value;
      },
      generateBatch: async (input: { blueprint: { id: string }; ordinal: number; count: number }) => {
        calls.push({ setId: input.blueprint.id, ordinal: input.ordinal, count: input.count });
        return generator(input);
      },
      evaluateCandidate: async ({ request }: { request: { payload: { sameSetEarlierCandidates: unknown[] } } }) => {
        if (request.payload.sameSetEarlierCandidates.length > 0) evaluatorSawSameSetContext = true;
        return evaluatorResponse();
      }
    });

    expect(checkpoint).not.toBeNull();
    expect(calls).toHaveLength(6);
    expect(evaluatorSawSameSetContext).toBe(true);
    expect(calls.every((call) => call.ordinal === 1 && call.count === 8)).toBe(true);
    expect(result.bank).toMatchObject({ bankVersion: "cache-v1", itemCount: 24, machineVerified: true });
    expect(result.manifest.counts).toMatchObject({
      sets: 6,
      variantsPerSet: 4,
      frozenItems: 24,
      oracleVerifiedItems: 24,
      selectedApprovedCandidates: 24,
      generatedCandidates: 48,
      evaluatorErrors: 0,
      evaluatorUnsure: 0
    });
    for (const item of result.bank.items)
      expect(cacheCore.verifyCacheCandidate(item.candidate)).toMatchObject({ valid: true });
    expect(result.bank.finalBankSha256).toBe(sha256(cacheCore.stableCacheJson(result.bank.items)));
    const posttests = await buildPosttestCases({
      bankBytes: Buffer.from(JSON.stringify(result.bank)),
      manifestBytes: Buffer.from(JSON.stringify(result.manifest)),
      bankPath: "private/bank.json",
      manifestPath: "private/manifest.json"
    });
    expect(posttests.items).toHaveLength(24);
    expect(posttests.cases).toHaveLength(48);
    const cases = validateCasesPayload(posttests).cases;
    const gradings = posttests.cases.flatMap(
      (entry: { caseId: string; itemId: string; expected: { verdict: string; conceptIds: string[] } }) =>
        [1, 2].map((repeat) => ({
          caseId: entry.caseId,
          itemId: entry.itemId,
          repeat,
          formatParsed: true,
          judgeResponseModelVerified: true,
          judgeAttempts: [{ outcome: "success", responseModel: "judge-fixed" }],
          error: null,
          verdict: entry.expected.verdict,
          matched: entry.expected.conceptIds,
          concepts: entry.expected.conceptIds.map((id: string) => ({
            id,
            judgeDemonstrated: true,
            demonstrated: true,
            evidenceValid: true
          }))
        }))
    );
    const summary = summarizeCacheStability(gradings, cases);
    const gate = evaluateCacheStabilityGate(summary);
    const freezeResult = {
      schemaVersion: "cache-bank-freeze-result/v1",
      bank: result.bank,
      blueprint: result.blueprint,
      protocol: result.protocol,
      manifest: result.manifest
    };
    const stability = {
      schemaVersion: "cache-bank-stability-results/v1",
      input: { bankVersion: "cache-v1", bankSha256: result.bank.finalBankSha256 },
      config: { judgeModel: "judge-fixed" },
      protocol: { gitSha: result.manifest.gitSha, build: { gitSha: result.manifest.buildSha } },
      gradings,
      summary,
      gate
    };
    expect(
      validatePublishGate(freezeResult, stability, { payload: posttests, pinnedBank: result.bank, cacheCore })
    ).toBe(freezeResult);
    expect(() =>
      validatePublishGate(
        freezeResult,
        { ...stability, gradings: gradings.slice(1), gate: { overallPass: true } },
        {
          payload: posttests,
          pinnedBank: result.bank,
          cacheCore
        }
      )
    ).toThrow(/missing|stored/);
    const tampered = structuredClone(freezeResult);
    tampered.bank.items[0].candidate.primary.canonicalAnswer += " tampered";
    expect(() =>
      validatePublishGate(tampered, stability, { payload: posttests, pinnedBank: result.bank, cacheCore })
    ).toThrow(/SHA-256|differs|verification/);
    const tamperedProtocol = structuredClone(freezeResult);
    tamperedProtocol.protocol.selection = "manual choice";
    expect(() =>
      validatePublishGate(tamperedProtocol, stability, { payload: posttests, pinnedBank: result.bank, cacheCore })
    ).toThrow(/protocol/);
  });

  it("rejects a candidate that reuses either half of an earlier same-set parameter pair", async () => {
    const target = "trace-3c";
    const result = await runCacheBankFreeze({
      checkpoint: null,
      seed: 71,
      provenance: provenance(),
      cacheCore,
      saveCheckpoint: async () => undefined,
      generateBatch: async (input: { blueprint: { id: string }; ordinal: number; count: number }) => {
        const parsed = JSON.parse(await generator(input));
        if (input.blueprint.id === target && input.ordinal === 1)
          parsed.candidates[1].primary = structuredClone(parsed.candidates[0].primary);
        return JSON.stringify(parsed);
      },
      evaluateCandidate: async () => evaluatorResponse()
    });

    const duplicate = result.manifest.candidateVerdicts.find(
      (entry: { setId: string; hardGate: { reasons: string[] } }) =>
        entry.setId === target && entry.hardGate.reasons.some((reason) => reason.includes("primary parameters"))
    );
    expect(duplicate).toBeDefined();
    expect(duplicate.evaluator).toBeNull();
    expect(result.bank.items.filter((item: { setId: string }) => item.setId === target)).toHaveLength(4);
  });

  it("uses one fixed four-candidate supplement only when a set has fewer than four passes", async () => {
    const target = "trace-3c";
    const calls: Array<{ setId: string; ordinal: number; count: number }> = [];
    const result = await runCacheBankFreeze({
      checkpoint: null,
      seed: 8,
      provenance: provenance(),
      cacheCore,
      saveCheckpoint: async () => undefined,
      generateBatch: async (input: { blueprint: { id: string }; ordinal: number; count: number }) => {
        calls.push({ setId: input.blueprint.id, ordinal: input.ordinal, count: input.count });
        return generator(input);
      },
      evaluateCandidate: async ({ candidate }: { candidate: { setId: string; scenario: CacheScenario } }) => {
        if (candidate.setId !== target) return evaluatorResponse();
        const first = (candidate.scenario as Extract<CacheScenario, { kind: "trace-3c" }>).primary.accesses[0] ?? 0;
        const variant = first / 256;
        return evaluatorResponse(variant < 3 || variant >= 8 ? "pass" : "fail");
      }
    });

    expect(calls.filter((call) => call.setId === target)).toEqual([
      { setId: target, ordinal: 1, count: 8 },
      { setId: target, ordinal: 2, count: 4 }
    ]);
    expect(result.bank.items.filter((item: { setId: string }) => item.setId === target)).toHaveLength(4);
  });

  it("fails the whole freeze on any evaluator error or unsure verdict", async () => {
    for (const response of ["not json", evaluatorResponse("unsure")]) {
      let first = true;
      await expect(
        runCacheBankFreeze({
          checkpoint: null,
          seed: 9,
          provenance: provenance(),
          cacheCore,
          saveCheckpoint: async () => undefined,
          generateBatch: generator,
          evaluateCandidate: async () => {
            if (first) {
              first = false;
              return response;
            }
            return evaluatorResponse();
          }
        })
      ).rejects.toThrow(/evaluator (error|unsure)/i);
    }
  });

  it("checkpoints the exact Generator text and attempts before failing strict response parsing", async () => {
    let checkpoint: unknown = null;
    const rawResponse = JSON.stringify({ schemaVersion: "unexpected", candidates: [] });
    await expect(
      runCacheBankFreeze({
        checkpoint: null,
        seed: 91,
        provenance: provenance(),
        cacheCore,
        saveCheckpoint: async (value: unknown) => {
          checkpoint = value;
        },
        generateBatch: async () => ({
          text: rawResponse,
          attempts: [{ ordinal: 1, outcome: "success", responseModel: "deepseek-v4-pro" }]
        }),
        evaluateCandidate: async () => evaluatorResponse()
      })
    ).rejects.toThrow("only a candidates array");

    const saved = checkpoint as {
      sets: Record<
        string,
        { batches: Array<{ status: string; rawResponse: string; rawResponseSha256: string; modelAttempts: unknown[] }> }
      >;
    };
    expect(saved.sets["trace-3c"].batches[0]).toMatchObject({
      status: "failed",
      rawResponse,
      rawResponseSha256: sha256(rawResponse),
      modelAttempts: [expect.objectContaining({ outcome: "success" })]
    });
  });

  it("resumes a complete checkpoint without another model call", async () => {
    let checkpoint: unknown = null;
    const common = {
      seed: 10,
      provenance: provenance(),
      cacheCore,
      saveCheckpoint: async (value: unknown) => {
        checkpoint = value;
      }
    };
    const first = await runCacheBankFreeze({
      checkpoint: null,
      ...common,
      generateBatch: generator,
      evaluateCandidate: async () => evaluatorResponse()
    });
    let calls = 0;
    const resumed = await runCacheBankFreeze({
      checkpoint,
      ...common,
      generateBatch: async () => {
        calls += 1;
        throw new Error("must not regenerate");
      },
      evaluateCandidate: async () => {
        calls += 1;
        throw new Error("must not reevaluate");
      }
    });
    expect(calls).toBe(0);
    expect(resumed.bank.finalBankSha256).toBe(first.bank.finalBankSha256);
  });

  it("pins model separation, cacheCore protocol, and resume provenance", () => {
    expect(assertDistinctModelIds()).toEqual({
      generator: "deepseek-v4-pro",
      evaluator: "deepseek-v4-flash-vision-exp"
    });
    expect(() => assertDistinctModelIds("proxy/DEEPSEEK-V4-PRO[1M]", "deepseek-v4-pro")).toThrow("same model");
    const original = provenance();
    const checkpoint = newCheckpoint({ seed: 11, provenance: original, cacheCore });
    expect(() =>
      validateCheckpoint(checkpoint, { seed: 11, provenance: { ...original, buildSha: "changed" }, cacheCore })
    ).toThrow("buildSha");
  });

  it("keeps evaluator fail, unsure, malformed, and incoherent outcomes fail-closed", () => {
    expect(parseEvaluatorResponse(evaluatorResponse("fail"))).toMatchObject({ status: "rejected" });
    expect(parseEvaluatorResponse(evaluatorResponse("unsure"))).toMatchObject({
      status: "rejected",
      verdict: "unsure"
    });
    expect(parseEvaluatorResponse("```json\n{}\n```")).toMatchObject({ status: "error" });
    const incoherent = JSON.parse(evaluatorResponse());
    incoherent.checks.novelty = "fail";
    expect(parseEvaluatorResponse(JSON.stringify(incoherent))).toMatchObject({ status: "rejected", verdict: "fail" });
  });
});

describe("cache bank CLI gates", () => {
  it("defaults to private freeze and requires explicit gated publication inputs", () => {
    expect(parseArgs(["node", "script", "--seed", "42"])).toMatchObject({ command: "freeze", seed: 42 });
    expect(() => parseArgs(["node", "script", "freeze", "--public-dir", "x"])).toThrow("Unknown argument");
    expect(() => parseArgs(["node", "script", "publish", "--freeze-result", "x"])).toThrow("--stability-results");
    expect(
      parseArgs([
        "node",
        "script",
        "publish",
        "--freeze-result",
        "freeze.json",
        "--stability-results",
        "stability.json"
      ])
    ).toMatchObject({ command: "publish" });
  });

  it("requires clean build SHA = Git SHA", () => {
    expect(validateBuildIdentity({ gitSha: "same" }, { gitSha: "same", gitDirty: false })).toMatchObject({
      gitSha: "same"
    });
    expect(() => validateBuildIdentity({ gitSha: "a" }, { gitSha: "b", gitDirty: false })).toThrow("must match");
    expect(() => validateBuildIdentity({ gitSha: "a" }, { gitSha: "a", gitDirty: true })).toThrow("must match");
  });

  it("writes atomically, enforces cache-v1 immutability, and times out model calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cache-bank-freeze-"));
    cleanups.push(root);
    const checkpoint = path.join(root, "private", "checkpoint.json");
    await atomicWriteJson(checkpoint, { step: 1 });
    expect(JSON.parse(await fs.readFile(checkpoint, "utf8"))).toEqual({ step: 1 });

    const publicItems = [{ id: "one", value: 1 }];
    const publicBankSha = sha256(cacheCore.stableCacheJson(publicItems));
    const publicBlueprintSha = sha256(cacheCore.stableCacheJson([]));
    const result = {
      bank: { items: publicItems, finalBankSha256: publicBankSha },
      blueprint: [],
      protocol: { protocolSha256: "protocol-one" },
      manifest: {
        hashes: {
          finalBankSha256: publicBankSha,
          blueprintSha256: publicBlueprintSha,
          protocolSha256: "protocol-one"
        }
      }
    };
    const publicDir = path.join(root, "public", "cache-v1");
    expect(await publishFrozenBank(publicDir, result)).toMatchObject({ status: "frozen" });
    expect(await publishFrozenBank(publicDir, result)).toMatchObject({ status: "already-frozen" });
    await fs.writeFile(path.join(publicDir, "bank.json"), JSON.stringify({ ...result.bank, items: [] }));
    await expect(publishFrozenBank(publicDir, result)).rejects.toThrow("immutable");
    await fs.writeFile(path.join(publicDir, "bank.json"), JSON.stringify(result.bank));
    await expect(
      publishFrozenBank(publicDir, {
        ...result,
        manifest: { hashes: { finalBankSha256: "0".repeat(64) } }
      })
    ).rejects.toThrow("immutable");

    const responseFor = (model: string) => async () =>
      ({
        ok: true,
        json: async () => ({ model, content: [{ type: "text", text: "{}" }] })
      }) as Response;
    await expect(
      requestModelText({
        baseUrl: "https://model.invalid",
        key: "test",
        model: "deepseek-v4-pro",
        system: "json",
        payload: {},
        temperature: 0,
        timeoutMs: 100,
        fetchImpl: responseFor("deepseek-v4-pro")
      })
    ).resolves.toMatchObject({
      text: "{}",
      attempts: [expect.objectContaining({ outcome: "success", responseModel: "deepseek-v4-pro" })]
    });
    await expect(
      requestModelText({
        baseUrl: "https://model.invalid",
        key: "test",
        model: "deepseek-v4-pro",
        system: "json",
        payload: {},
        temperature: 0,
        timeoutMs: 100,
        fetchImpl: responseFor("deepseek-v4-flash-vision-exp")
      })
    ).rejects.toThrow("identity");

    const requests: Array<{ max_tokens: number; reasoning?: { effort: string } }> = [];
    const thinkingThenText = async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          model: "deepseek-v4-pro",
          content:
            requests.length === 1
              ? [{ type: "thinking", thinking: "reasoning without final JSON" }]
              : [{ type: "text", text: '{"candidates":[]}' }]
        })
      } as Response;
    };
    await expect(
      requestModelText({
        baseUrl: "https://model.invalid",
        key: "test",
        model: "deepseek-v4-pro",
        system: "json",
        payload: {},
        temperature: 0,
        timeoutMs: 100,
        attemptPlan: [
          { maxTokens: 12_000, reasoningMode: "default" },
          { maxTokens: 4_000, reasoningMode: "none" }
        ],
        fetchImpl: thinkingThenText
      })
    ).resolves.toMatchObject({
      text: '{"candidates":[]}',
      attempts: [
        expect.objectContaining({ outcome: "empty_text", thinkingChars: expect.any(Number) }),
        expect.objectContaining({ outcome: "success", reasoningMode: "none" })
      ]
    });
    expect(requests).toEqual([
      expect.objectContaining({ max_tokens: 12_000 }),
      expect.objectContaining({ max_tokens: 4_000, reasoning: { effort: "none" } })
    ]);

    const fetchImpl = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      });
    await expect(
      requestModelText({
        baseUrl: "https://model.invalid",
        key: "test",
        model: "deepseek-v4-pro",
        system: "json",
        payload: {},
        temperature: 0,
        timeoutMs: 1,
        fetchImpl
      })
    ).rejects.toThrow("timed out");
  });
});
