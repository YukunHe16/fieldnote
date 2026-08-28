import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPosttestCases, validateFrozenArtifacts } from "../../../scripts/cache-bank-posttest-cases.mjs";
import { CACHE_BANK_SET_IDS, createCacheCandidate, stableCacheJson, type CacheScenario } from "../src/cache-bank.js";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const shift = (values: number[], offset: number) => values.map((value) => value + offset);

function scenario(setId: CacheScenario["kind"], variant: number): CacheScenario {
  const offset = variant * 64;
  if (setId === "trace-3c")
    return {
      kind: setId,
      primary: {
        config: { kind: "direct", lineSizeBytes: 4, capacityLines: 2 },
        accesses: shift([0, 8, 0, 4, 8], offset)
      },
      transfer: {
        config: { kind: "direct", lineSizeBytes: 4, capacityLines: 2 },
        accesses: shift([4, 12, 4, 8, 12], offset)
      }
    };
  if (setId === "compulsory-repeated")
    return {
      kind: setId,
      primary: {
        config: { kind: "fully-associative", lineSizeBytes: 4, capacityLines: 4 },
        accesses: shift([0, 4, 0, 8, 4], offset)
      },
      transfer: {
        config: { kind: "fully-associative", lineSizeBytes: 4, capacityLines: 4 },
        accesses: shift([8, 12, 8, 16, 12], offset)
      }
    };
  if (setId === "fully-associative-working-set")
    return {
      kind: setId,
      primary: {
        config: { kind: "fully-associative", lineSizeBytes: 4, capacityLines: 2 },
        accesses: shift([0, 4, 0, 8, 4], offset)
      },
      transfer: {
        config: { kind: "fully-associative", lineSizeBytes: 4, capacityLines: 2 },
        accesses: shift([8, 12, 8, 16, 12], offset)
      }
    };
  if (setId === "write-policy-traffic")
    return {
      kind: setId,
      primary: {
        config: { kind: "direct", lineSizeBytes: 4, capacityLines: 1 },
        accesses: [
          { operation: "write", address: offset, sizeBytes: 1 },
          { operation: "write", address: offset, sizeBytes: 1 },
          { operation: "write", address: offset + 4, sizeBytes: 1 }
        ],
        writeMissPolicy: "write-allocate",
        flushAtEnd: false
      },
      transfer: {
        config: { kind: "direct", lineSizeBytes: 8, capacityLines: 1 },
        accesses: [
          { operation: "write", address: offset + 8, sizeBytes: 1 },
          { operation: "write", address: offset + 8, sizeBytes: 1 },
          { operation: "write", address: offset, sizeBytes: 1 }
        ],
        writeMissPolicy: "write-allocate",
        flushAtEnd: false
      }
    };
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
  return {
    kind: "amat-tradeoff",
    primary: {
      optionA: { hitTimeNs: 1, missRate: 0.05, missPenaltyNs: 50 + variant },
      optionB: { hitTimeNs: 1.5, missRate: 0.02, missPenaltyNs: 60 + variant }
    },
    transfer: {
      optionA: { hitTimeNs: 0.8, missRate: 0.08, missPenaltyNs: 30 + variant },
      optionB: { hitTimeNs: 1.2, missRate: 0.03, missPenaltyNs: 45 + variant }
    }
  };
}

function frozenFixture() {
  const items = CACHE_BANK_SET_IDS.flatMap((setId) =>
    Array.from({ length: 4 }, (_, index) => {
      const variant = index + 1;
      const candidate = createCacheCandidate(scenario(setId, variant));
      return {
        id: `${setId}--v${variant}`,
        bankVersion: "cache-v1",
        setId,
        variant,
        candidate
      };
    })
  );
  const finalBankSha256 = sha256(stableCacheJson(items));
  const bank = {
    schemaVersion: "cache-bank/v1",
    bankVersion: "cache-v1",
    immutable: true,
    machineVerified: true,
    itemCount: 24,
    finalBankSha256,
    items
  };
  const manifest = {
    schemaVersion: "cache-bank-manifest/v1",
    bankVersion: "cache-v1",
    immutable: true,
    gitSha: "a".repeat(40),
    gitDirty: false,
    buildSha: "a".repeat(40),
    models: {
      generator: { normalizedId: "glm-5.3-flash" },
      evaluator: { normalizedId: "deepseek-v4-flash-vision-exp" }
    },
    counts: {
      sets: 6,
      variantsPerSet: 4,
      frozenItems: 24,
      oracleVerifiedItems: 24,
      selectedApprovedCandidates: 24,
      evaluatorErrors: 0,
      evaluatorUnsure: 0
    },
    hashes: { finalBankSha256 },
    candidateVerdicts: items.map((item) => ({
      candidateSha256: item.candidate.candidateSha256,
      setId: item.setId,
      selected: true,
      hardGate: { status: "passed", reasons: [] },
      evaluator: { status: "approved", verdict: "pass" }
    }))
  };
  return { bank, manifest };
}

describe("Cache bank canonical post-test cases", () => {
  it("derives 24 judge snapshots and complete/omission structured-v1 answers without model calls", async () => {
    const { bank, manifest } = frozenFixture();
    const bankBytes = Buffer.from(`${JSON.stringify(bank)}\n`);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const payload = await buildPosttestCases({
      bankBytes,
      manifestBytes,
      bankPath: "private/bank.json",
      manifestPath: "private/manifest.json"
    });

    expect(payload.items).toHaveLength(24);
    expect(payload.cases).toHaveLength(48);
    expect(new Set(payload.cases.map((entry: { caseId: string }) => entry.caseId)).size).toBe(48);
    for (const item of payload.items) {
      expect(item.concepts).toHaveLength(4);
      expect(item.concepts.at(-1)?.id).toBe("transfer-applied");
      const cases = payload.cases.filter((entry: { itemId: string }) => entry.itemId === item.id);
      expect(cases.map((entry: { answerVariant: string }) => entry.answerVariant).sort()).toEqual([
        "complete",
        "omission"
      ]);
      const omission = cases.find((entry: { answerVariant: string }) => entry.answerVariant === "omission");
      expect(omission.expected.conceptIds).not.toContain(omission.omittedConceptId);
      expect(omission.answer).toContain("GENERAL_METHOD:\nI kept the primary and transfer calculations separate");
    }
    expect(payload.bank).toMatchObject({
      version: "cache-v1",
      contentSha256: bank.finalBankSha256,
      fileSha256: sha256(bankBytes),
      manifestFileSha256: sha256(manifestBytes)
    });
  });

  it("rejects content or manifest hash drift before creating canonical answers", () => {
    const { bank, manifest } = frozenFixture();
    const tampered = structuredClone(bank);
    tampered.items[0].candidate.primary.canonicalAnswer += " changed";
    expect(() => validateFrozenArtifacts(tampered, manifest)).toThrow(/SHA-256 mismatch/);

    const wrongManifest = structuredClone(manifest);
    wrongManifest.hashes.finalBankSha256 = "0".repeat(64);
    expect(() => validateFrozenArtifacts(bank, wrongManifest)).toThrow(/SHA-256 mismatch/);

    const wrongSelection = structuredClone(manifest);
    wrongSelection.candidateVerdicts[0].candidateSha256 = "f".repeat(64);
    expect(() => validateFrozenArtifacts(bank, wrongSelection)).toThrow(/24 Evaluator-approved/);
  });
});
