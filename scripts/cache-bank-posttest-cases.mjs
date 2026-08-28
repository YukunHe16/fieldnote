#!/usr/bin/env node
/**
 * Deterministically derives the two pre-registered structured-v1 canonical answers for
 * every frozen Cache-bank item: one complete answer and one answer with exactly one
 * primary-method concept omitted. The output is private gate input, not a public bank file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStructuredAnswer } from "./learning-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const EXPECTED_SET_IDS = [
  "trace-3c",
  "compulsory-repeated",
  "fully-associative-working-set",
  "write-policy-traffic",
  "set-mapping",
  "amat-tradeoff"
];
const VARIANTS_PER_SET = 4;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object")
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key])])
      );
    return entry;
  };
  return JSON.stringify(normalize(value));
};

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index];
    if (flag === "--bank") args.bank = next();
    else if (flag === "--manifest") args.manifest = next();
    else if (flag === "--out") args.out = next();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.bank || !args.manifest || !args.out) throw new Error("--bank, --manifest and --out are required");
  return args;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const traceCounts = (result) =>
  `${plural(result.hits, "hit")}, ${plural(result.compulsoryMisses, "compulsory miss")}, ${plural(result.conflictMisses, "conflict miss")}, and ${plural(result.capacityMisses, "capacity miss")}`;

const specifications = {
  "trace-3c": {
    conclusionId: "primary-3c-classification",
    evidenceId: "primary-trace-evidence",
    methodId: "associativity-test",
    conclusion: (part) => `The primary trace contains ${traceCounts(part.oracle.result)}.`,
    transferConclusion: (part) => `The transfer trace contains ${traceCounts(part.oracle.result)}.`,
    method:
      "For a repeated miss, compare against a cold, equal-capacity fully associative LRU cache: a baseline hit means conflict, a baseline miss means capacity; a block's first touch is compulsory.",
    labels: {
      conclusion: "states the primary trace's correct hit and 3C miss totals",
      evidence: "gives the correct access-by-access primary hit/miss classification",
      method:
        "explicitly uses an equal-capacity fully associative LRU baseline to distinguish conflict from capacity while preserving first-touch compulsory misses"
    }
  },
  "compulsory-repeated": {
    conclusionId: "first-touch-rule-applied",
    evidenceId: "repeated-access-residency",
    methodId: "trace-walk",
    conclusion: (part) => `The primary trace contains ${traceCounts(part.oracle.result)}.`,
    transferConclusion: (part) => `The transfer trace contains ${traceCounts(part.oracle.result)}.`,
    method:
      "Compulsory means the first touch of each distinct block, not every miss in a cold run; later accesses must be decided by walking residency one access at a time.",
    labels: {
      conclusion: "applies the first-touch rule correctly to the primary trace",
      evidence: "identifies the primary repeated accesses as hits or non-compulsory misses from residency",
      method: "states the per-distinct-block first-touch rule and the access-by-access residency method"
    }
  },
  "fully-associative-working-set": {
    conclusionId: "working-set-limit",
    evidenceId: "lru-state-evidence",
    methodId: "lru-recency-update-rule",
    conclusion: (part) =>
      `The primary trace has ${part.oracle.uniqueBlocks} unique blocks competing for ${part.oracle.capacityLines} fully associative lines, with ${plural(part.oracle.result.hits, "hit")} and ${plural(part.oracle.result.misses, "miss")}.`,
    transferConclusion: (part) =>
      `The transfer trace has ${part.oracle.uniqueBlocks} unique blocks competing for ${part.oracle.capacityLines} fully associative lines, with ${plural(part.oracle.result.hits, "hit")} and ${plural(part.oracle.result.misses, "miss")}.`,
    method:
      "For true LRU, every hit moves that block to most-recently-used; on a miss to a full cache, evict the least-recently-used block before inserting the new block.",
    labels: {
      conclusion: "compares the primary unique working set with fully associative capacity",
      evidence: "tracks the primary LRU hits, misses, and victims correctly",
      method: "states both the hit recency update and the full-cache least-recently-used victim rule"
    }
  },
  "write-policy-traffic": {
    conclusionId: "lower-traffic-policy",
    evidenceId: "write-traffic-accounting",
    methodId: "dirty-coalescing-rule",
    conclusion: (part) =>
      `For the primary trace, the lower total-memory-traffic result is ${part.oracle.lowerTrafficPolicy}.`,
    transferConclusion: (part) =>
      `For the transfer trace, the lower total-memory-traffic result is ${part.oracle.lowerTrafficPolicy}.`,
    method:
      "Write-through sends each store to memory, while write-back coalesces repeated stores in a dirty line and writes a full line only on dirty eviction or the explicitly stated final flush.",
    labels: {
      conclusion: "chooses the primary lower-traffic write policy from the computed totals",
      evidence: "accounts for the primary line fills, write-through writes, and dirty write-backs in bytes",
      method:
        "states the dirty-line coalescing and eviction/flush rule that distinguishes write-back from write-through"
    }
  },
  "set-mapping": {
    conclusionId: "same-set-collision",
    evidenceId: "address-decomposition",
    methodId: "index-formula",
    conclusion: (part) =>
      `In the primary mapping, the different-tag same-set collision indices are ${part.oracle.collisionSets.join(", ")}.`,
    transferConclusion: (part) =>
      `In the transfer mapping, the different-tag same-set collision indices are ${part.oracle.collisionSets.join(", ")}.`,
    method:
      "First divide the byte address by line size to get the block and remainder offset; then use block modulo set count for the set and integer division by set count for the tag.",
    labels: {
      conclusion: "identifies the primary same-set/different-tag collisions",
      evidence: "computes the primary block, offset, set, and tag values correctly",
      method: "states the block/offset, block-mod-set-count index, and tag formulas explicitly"
    }
  },
  "amat-tradeoff": {
    conclusionId: "lower-amat-choice",
    evidenceId: "amat-calculation",
    methodId: "tradeoff-reasoning",
    conclusion: (part) => `For the primary comparison, option ${part.oracle.lowerAmatOption} has the lower AMAT.`,
    transferConclusion: (part) =>
      `For the transfer comparison, option ${part.oracle.lowerAmatOption} has the lower AMAT.`,
    method:
      "AMAT equals hit time plus miss rate times the additional miss penalty: hit time is paid on every access, while the penalty term is weighted by the miss rate, so neither hit time nor miss rate alone decides the trade-off.",
    labels: {
      conclusion: "chooses the primary lower-AMAT option from both computed values",
      evidence: "computes both primary AMAT values with miss rate as a fraction",
      method:
        "explains why hit time is paid every access and miss penalty is miss-rate weighted, so the trade-off must use the full AMAT"
    }
  }
};

function assertPart(part, expectedKind, label) {
  if (!part || typeof part !== "object" || part.oracle?.kind !== expectedKind)
    throw new Error(`${label} oracle kind must be ${expectedKind}`);
  if (!String(part.prompt ?? "").trim() || !String(part.canonicalAnswer ?? "").trim())
    throw new Error(`${label} is missing its deterministic prompt or canonical answer`);
}

function buildGradingItem(item) {
  const candidate = item?.candidate;
  if (!candidate || candidate.machineVerified !== true || candidate.setId !== item.setId)
    throw new Error(`${item?.id ?? "<missing id>"} has no matching machine-verified frozen candidate`);
  const spec = specifications[item.setId];
  if (!spec) throw new Error(`Unknown Cache set ${item.setId}`);
  assertPart(candidate.primary, item.setId, `${item.id}.primary`);
  assertPart(candidate.transfer, item.setId, `${item.id}.transfer`);
  const primaryConclusion = spec.conclusion(candidate.primary);
  const transferConclusion = spec.transferConclusion(candidate.transfer);
  const concepts = [
    {
      id: spec.conclusionId,
      label: spec.labels.conclusion,
      credit: `Credit requires the explicit, oracle-consistent primary conclusion. The frozen conclusion is: ${primaryConclusion}`
    },
    {
      id: spec.evidenceId,
      label: spec.labels.evidence,
      credit: `Credit requires concrete primary calculations or cache states consistent with: ${candidate.primary.canonicalAnswer}`
    },
    {
      id: spec.methodId,
      label: spec.labels.method,
      credit: `Credit requires the reusable rule explicitly; a correct numerical result alone is not enough. Required rule: ${spec.method}`
    },
    {
      id: "transfer-applied",
      label: "independently solves the frozen transfer scenario with its own conclusion and supporting calculation",
      credit: `Credit requires both the transfer conclusion and transfer evidence to match this frozen oracle: ${transferConclusion} ${candidate.transfer.canonicalAnswer}`
    }
  ];
  return {
    id: item.id,
    setId: item.setId,
    variant: item.variant,
    machineVerified: true,
    opening: candidate.primary.prompt,
    postTest: `Answer the primary scenario above, state the reusable method, then independently solve this transfer scenario:\n${candidate.transfer.prompt}`,
    concepts,
    answerParts: {
      primaryConclusion,
      primaryEvidence: candidate.primary.canonicalAnswer,
      completeMethod: `${spec.method} I kept the primary and transfer calculations separate and recomputed each from its own parameters.`,
      omissionMethod:
        "I kept the primary and transfer calculations separate and recomputed each from its own parameters.",
      transferConclusion,
      transferEvidence: candidate.transfer.canonicalAnswer,
      omittedConceptId: spec.methodId
    }
  };
}

function structuredAnswer(parts, omitMethod) {
  const answer = [
    `ORIGINAL_CONCLUSION:\n${parts.primaryConclusion}`,
    `ORIGINAL_EVIDENCE:\n${parts.primaryEvidence}`,
    `GENERAL_METHOD:\n${omitMethod ? parts.omissionMethod : parts.completeMethod}`,
    `TRANSFER_CONCLUSION:\n${parts.transferConclusion}`,
    `TRANSFER_EVIDENCE:\n${parts.transferEvidence}`
  ].join("\n");
  parseStructuredAnswer(answer);
  return answer;
}

function validateFrozenArtifacts(bank, manifest) {
  if (bank?.schemaVersion !== "cache-bank/v1" || manifest?.schemaVersion !== "cache-bank-manifest/v1")
    throw new Error("Cache bank/manifest schema mismatch");
  if (bank.bankVersion !== "cache-v1" || manifest.bankVersion !== bank.bankVersion)
    throw new Error("Cache bank version mismatch");
  if (bank.immutable !== true || bank.machineVerified !== true || manifest.immutable !== true)
    throw new Error("Cache bank must be immutable and machine-verified");
  if (
    manifest.gitDirty !== false ||
    !/^[a-f0-9]{40}$/.test(manifest.gitSha ?? "") ||
    manifest.buildSha !== manifest.gitSha
  )
    throw new Error("Cache bank manifest must pin one clean Git/build SHA");
  if (
    manifest.models?.generator?.normalizedId !== "glm-5.3-flash" ||
    manifest.models?.evaluator?.normalizedId !== "deepseek-v4-flash-vision-exp" ||
    manifest.models.generator.normalizedId === manifest.models.evaluator.normalizedId
  )
    throw new Error("Cache bank manifest must pin distinct approved Generator and Evaluator models");
  if (
    manifest.counts?.sets !== EXPECTED_SET_IDS.length ||
    manifest.counts?.variantsPerSet !== VARIANTS_PER_SET ||
    manifest.counts?.frozenItems !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET ||
    manifest.counts?.oracleVerifiedItems !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET ||
    manifest.counts?.selectedApprovedCandidates !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET ||
    manifest.counts?.evaluatorErrors !== 0 ||
    manifest.counts?.evaluatorUnsure !== 0
  )
    throw new Error("Cache bank manifest does not satisfy the 6×4 oracle/Evaluator gate");
  const selected = (manifest.candidateVerdicts ?? []).filter((entry) => entry.selected);
  if (
    selected.length !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET ||
    selected.some((entry) => entry.hardGate?.status !== "passed" || entry.evaluator?.status !== "approved")
  )
    throw new Error("Cache bank manifest selected candidates are not all hard-gate-passed and Evaluator-approved");
  if (!Array.isArray(bank.items) || bank.items.length !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET)
    throw new Error("Cache bank must contain exactly 24 items");
  const selectedHashes = selected.map((entry) => entry.candidateSha256).sort();
  const bankHashes = bank.items.map((item) => item.candidate?.candidateSha256).sort();
  if (
    new Set(selectedHashes).size !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET ||
    new Set(bankHashes).size !== EXPECTED_SET_IDS.length * VARIANTS_PER_SET ||
    stable(selectedHashes) !== stable(bankHashes)
  )
    throw new Error("Cache bank items are not the 24 Evaluator-approved selected candidates in the manifest");
  const bankSetByHash = new Map(bank.items.map((item) => [item.candidate.candidateSha256, item.setId]));
  if (selected.some((entry) => bankSetByHash.get(entry.candidateSha256) !== entry.setId))
    throw new Error("Cache bank selected candidate set ids do not match the manifest");
  const contentSha = sha256(stable(bank.items));
  if (bank.finalBankSha256 !== contentSha || manifest.hashes?.finalBankSha256 !== contentSha)
    throw new Error("Cache bank content SHA-256 mismatch");
  const ids = new Set();
  for (const setId of EXPECTED_SET_IDS) {
    const members = bank.items.filter((item) => item.setId === setId);
    if (members.length !== VARIANTS_PER_SET) throw new Error(`${setId} must contain four variants`);
    if (
      members
        .map((item) => item.variant)
        .sort()
        .join(",") !== "1,2,3,4"
    )
      throw new Error(`${setId} variants must be exactly 1,2,3,4`);
    for (const item of members) {
      if (
        !item.id ||
        ids.has(item.id) ||
        item.bankVersion !== bank.bankVersion ||
        item.candidate?.machineVerified !== true ||
        item.candidate?.setId !== setId
      )
        throw new Error(`Invalid or duplicate frozen item ${item.id}`);
      ids.add(item.id);
    }
  }
  return contentSha;
}

async function buildPosttestCases({ bankBytes, manifestBytes, bankPath, manifestPath }) {
  const bank = JSON.parse(bankBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const contentSha256 = validateFrozenArtifacts(bank, manifest);
  const gradingItems = bank.items.map(buildGradingItem);
  const cases = gradingItems.flatMap((item) => {
    const conceptIds = item.concepts.map((concept) => concept.id);
    const complete = structuredAnswer(item.answerParts, false);
    const omission = structuredAnswer(item.answerParts, true);
    return [
      {
        caseId: `${item.id}::complete`,
        itemId: item.id,
        setId: item.setId,
        variant: item.variant,
        answerVariant: "complete",
        omittedConceptId: null,
        machineVerified: true,
        answer: complete,
        answerSha256: sha256(complete),
        expected: { verdict: "resolved", conceptIds }
      },
      {
        caseId: `${item.id}::omission::${item.answerParts.omittedConceptId}`,
        itemId: item.id,
        setId: item.setId,
        variant: item.variant,
        answerVariant: "omission",
        omittedConceptId: item.answerParts.omittedConceptId,
        machineVerified: true,
        answer: omission,
        answerSha256: sha256(omission),
        expected: {
          verdict: "partial",
          conceptIds: conceptIds.filter((conceptId) => conceptId !== item.answerParts.omittedConceptId)
        }
      }
    ];
  });
  return {
    schemaVersion: "cache-bank-posttest-cases/v1",
    answerFormat: "structured-v1",
    judgeContractVersion: "evidence-v2",
    bank: {
      version: bank.bankVersion,
      contentSha256,
      fileSha256: sha256(bankBytes),
      path: bankPath,
      manifestPath,
      manifestFileSha256: sha256(manifestBytes)
    },
    items: gradingItems.map(({ answerParts: _answerParts, ...item }) => item),
    cases
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const bankFile = path.resolve(repo, args.bank);
  const manifestFile = path.resolve(repo, args.manifest);
  const outputFile = path.resolve(repo, args.out);
  const [bankBytes, manifestBytes] = await Promise.all([fs.readFile(bankFile), fs.readFile(manifestFile)]);
  const payload = await buildPosttestCases({
    bankBytes,
    manifestBytes,
    bankPath: path.relative(repo, bankFile),
    manifestPath: path.relative(repo, manifestFile)
  });
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.rename(temporary, outputFile);
  process.stdout.write(
    `Wrote ${path.relative(repo, outputFile)}: ${payload.items.length} items, ${payload.cases.length} cases\n`
  );
}

export { buildGradingItem, buildPosttestCases, structuredAnswer, validateFrozenArtifacts };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cache-bank-posttest-cases failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
