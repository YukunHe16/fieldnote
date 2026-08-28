import { createHash } from "node:crypto";

export const BANK_VERSION = "cache-v1";
export const CHECKPOINT_SCHEMA_VERSION = "cache-bank-freeze-checkpoint/v1";
export const BANK_SCHEMA_VERSION = "cache-bank/v1";
export const MANIFEST_SCHEMA_VERSION = "cache-bank-manifest/v1";
export const GENERATOR_MODEL = "deepseek-v4-pro";
export const EVALUATOR_MODEL = "deepseek-v4-flash-vision-exp";
export const GENERATOR_CANDIDATES = 8;
export const SUPPLEMENTAL_CANDIDATES = 4;
export const FROZEN_VARIANTS = 4;
export const EVALUATOR_CHECKS = ["clarity", "concept", "difficulty", "answerLeakage", "novelty", "equivalence"];
export const GENERATOR_ATTEMPT_PLAN = Object.freeze([
  { maxTokens: 12_000, reasoningMode: "default" },
  { maxTokens: 24_000, reasoningMode: "default" },
  { maxTokens: 12_000, reasoningMode: "none" }
]);
export const EVALUATOR_ATTEMPT_PLAN = Object.freeze([
  { maxTokens: 4_000, reasoningMode: "default" },
  { maxTokens: 8_000, reasoningMode: "default" },
  { maxTokens: 4_000, reasoningMode: "none" }
]);

const CACHE_ORGANIZATION_SCHEMA = {
  oneOf: [
    {
      exactKeys: ["kind", "lineSizeBytes", "capacityLines"],
      properties: {
        kind: { const: "direct" },
        lineSizeBytes: { type: "integer", powerOfTwo: true, minimum: 4, maximum: 256 },
        capacityLines: { type: "integer", powerOfTwo: true, minimum: 1, maximum: 128 }
      }
    },
    {
      exactKeys: ["kind", "lineSizeBytes", "setCount", "ways"],
      properties: {
        kind: { const: "set-associative" },
        lineSizeBytes: { type: "integer", powerOfTwo: true, minimum: 4, maximum: 256 },
        setCount: { type: "integer", powerOfTwo: true, minimum: 1, maximum: 64 },
        ways: { type: "integer", powerOfTwo: true, minimum: 2, maximum: 16 }
      }
    },
    {
      exactKeys: ["kind", "lineSizeBytes", "capacityLines"],
      properties: {
        kind: { const: "fully-associative" },
        lineSizeBytes: { type: "integer", powerOfTwo: true, minimum: 4, maximum: 256 },
        capacityLines: { type: "integer", powerOfTwo: true, minimum: 1, maximum: 128 }
      }
    }
  ]
};

const traceProblemSchema = {
  exactKeys: ["config", "accesses"],
  properties: {
    config: CACHE_ORGANIZATION_SCHEMA,
    accesses: { type: "array", minItems: 3, maxItems: 24, items: { type: "integer", minimum: 0, maximum: 0xffffff } }
  }
};
const traceScenarioSchema = (kind) => ({
  exactKeys: ["kind", "primary", "transfer"],
  properties: { kind: { const: kind }, primary: traceProblemSchema, transfer: traceProblemSchema },
  additionalProperties: false
});
const writeProblemSchema = {
  exactKeys: ["config", "accesses", "writeMissPolicy", "flushAtEnd"],
  properties: {
    config: CACHE_ORGANIZATION_SCHEMA,
    accesses: {
      type: "array",
      minItems: 3,
      maxItems: 24,
      items: {
        exactKeys: ["address", "operation", "sizeBytes"],
        properties: {
          address: { type: "integer", minimum: 0, maximum: 0xffffff },
          operation: { enum: ["read", "write"] },
          sizeBytes: { type: "integer", minimum: 1, note: "must fit inside one configured cache line" }
        },
        additionalProperties: false
      }
    },
    writeMissPolicy: { enum: ["write-allocate", "no-write-allocate"] },
    flushAtEnd: { type: "boolean" }
  }
};
const mappingProblemSchema = {
  exactKeys: ["config", "addresses"],
  properties: {
    config: CACHE_ORGANIZATION_SCHEMA,
    addresses: { type: "array", minItems: 3, maxItems: 24, items: { type: "integer", minimum: 0, maximum: 0xffffff } }
  }
};
const amatOptionSchema = {
  exactKeys: ["hitTimeNs", "missRate", "missPenaltyNs"],
  properties: {
    hitTimeNs: { type: "number", minimum: 0.1, maximum: 20 },
    missRate: { type: "number", minimum: 0, maximum: 1 },
    missPenaltyNs: { type: "number", minimum: 1, maximum: 1_000 }
  }
};
const amatProblemSchema = {
  exactKeys: ["optionA", "optionB"],
  properties: { optionA: amatOptionSchema, optionB: amatOptionSchema }
};

/** This public object is the generator's complete domain input. */
export const PUBLIC_BLUEPRINT = Object.freeze([
  {
    id: "trace-3c",
    title: "Conflict versus capacity trace",
    targetConcept: "Use a same-capacity fully-associative LRU baseline to separate conflict and capacity misses.",
    parameterRanges: {
      kind: "trace-3c",
      organization: ["direct", "set-associative"],
      lineSizeBytes: "power of two, 4..256",
      capacityLines: "power of two, 2..128",
      accesses: "3..24 byte addresses, 0..0xFFFFFF"
    },
    responseSchema: traceScenarioSchema("trace-3c"),
    equivalenceAnchor: "Primary and transfer must each contain compulsory, conflict, and capacity misses."
  },
  {
    id: "compulsory-repeated",
    title: "Compulsory versus repeated access",
    targetConcept: "Distinguish first touches from repeated accesses and identify repeated hits from cache residency.",
    parameterRanges: {
      kind: "compulsory-repeated",
      organization: ["direct", "set-associative", "fully-associative"],
      lineSizeBytes: "power of two, 4..256",
      accesses: "3..24 byte addresses, 0..0xFFFFFF"
    },
    responseSchema: traceScenarioSchema("compulsory-repeated"),
    equivalenceAnchor: "Primary and transfer each contain at least two first touches and a repeated-access hit."
  },
  {
    id: "fully-associative-working-set",
    title: "Fully-associative LRU working-set limit",
    targetConcept: "Track LRU residency and explain capacity misses when the working set exceeds the line limit.",
    parameterRanges: {
      kind: "fully-associative-working-set",
      organization: "fully-associative only",
      lineSizeBytes: "power of two, 4..256",
      capacityLines: "power of two, 1..128",
      accesses: "3..24 byte addresses, 0..0xFFFFFF"
    },
    responseSchema: traceScenarioSchema("fully-associative-working-set"),
    equivalenceAnchor: "Primary and transfer each exceed capacity and include both a hit and a capacity miss."
  },
  {
    id: "write-policy-traffic",
    title: "Write-through versus write-back traffic",
    targetConcept: "Compute byte traffic for write-through and write-back under identical allocation and flush rules.",
    parameterRanges: {
      kind: "write-policy-traffic",
      organization: ["direct", "set-associative", "fully-associative"],
      writeMissPolicy: ["write-allocate", "no-write-allocate"],
      flushAtEnd: "boolean",
      accesses: "3..24 read/write byte-address operations; no access crosses a line"
    },
    responseSchema: {
      exactKeys: ["kind", "primary", "transfer"],
      properties: {
        kind: { const: "write-policy-traffic" },
        primary: writeProblemSchema,
        transfer: writeProblemSchema
      },
      additionalProperties: false
    },
    equivalenceAnchor: "Primary and transfer each contain a write hit and produce different policy traffic totals."
  },
  {
    id: "set-mapping",
    title: "Set index and associativity mapping",
    targetConcept: "Map byte addresses to offset, block, set, and tag and identify same-set tag collisions.",
    parameterRanges: {
      kind: "set-mapping",
      organization: ["direct", "set-associative"],
      lineSizeBytes: "power of two, 4..256",
      addresses: "3..24 byte addresses, 0..0xFFFFFF"
    },
    responseSchema: {
      exactKeys: ["kind", "primary", "transfer"],
      properties: { kind: { const: "set-mapping" }, primary: mappingProblemSchema, transfer: mappingProblemSchema },
      additionalProperties: false
    },
    equivalenceAnchor: "Primary and transfer each cover multiple sets and a same-set/different-tag collision."
  },
  {
    id: "amat-tradeoff",
    title: "AMAT trade-off",
    targetConcept: "Compute hit time + miss rate × miss penalty and compare two non-equivalent designs.",
    parameterRanges: {
      kind: "amat-tradeoff",
      hitTimeNs: "0.1..20",
      missRate: "0..1",
      missPenaltyNs: "1..1000"
    },
    responseSchema: {
      exactKeys: ["kind", "primary", "transfer"],
      properties: { kind: { const: "amat-tradeoff" }, primary: amatProblemSchema, transfer: amatProblemSchema },
      additionalProperties: false
    },
    equivalenceAnchor: "Primary and transfer each compare distinct options whose AMATs differ by at least 0.1 ns."
  }
]);

export const GENERATOR_SYSTEM_PROMPT = `Generate typed CacheScenario JSON for a frozen research item bank.
Return JSON only. Do not write question prose, answers, hints, rubrics, explanations, learner data, tutoring history, experimental conditions, candidate ids, or scores.
Use only the supplied public blueprint, seed, parameter ranges, and batch count. Each candidate is the CacheScenario union member whose kind exactly equals the blueprint id, with primary and transfer fields.`;

export const EVALUATOR_SYSTEM_PROMPT = `You are the independent fail-closed reviewer for a frozen cache post-test bank.
Judge only the supplied host-rendered candidate against its public blueprint and equivalence anchor.
Check clarity, target-concept fit, intended difficulty, answer leakage, substantive novelty, and equivalence to the anchor.
Use sameSetEarlierCandidates to reject a candidate that is only a cosmetic or near-parameter copy of an earlier candidate in its set.
Return JSON only. verdict must be pass, fail, or unsure. Use unsure whenever evidence is insufficient. A pass requires every check to pass.`;

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
    .join(",")}}`;
}

export function normalizeModelId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]\s*$/, "")
    .replace(/^.*\//, "")
    .trim();
  if (!normalized) throw new Error("Model id must not be empty");
  return normalized;
}

export function assertDistinctModelIds(generatorModel = GENERATOR_MODEL, evaluatorModel = EVALUATOR_MODEL) {
  const generator = normalizeModelId(generatorModel);
  const evaluator = normalizeModelId(evaluatorModel);
  if (generator === evaluator) throw new Error(`Generator and evaluator resolve to the same model: ${generator}`);
  return { generator, evaluator };
}

export function assertCacheCore(cacheCore) {
  for (const name of ["validateCacheScenario", "createCacheCandidate", "verifyCacheCandidate", "stableCacheJson"])
    if (typeof cacheCore?.[name] !== "function") throw new Error(`cacheCore adapter is missing ${name}`);
  if (cacheCore.CACHE_BANK_VERSION !== BANK_VERSION) throw new Error("cacheCore bank version does not match cache-v1");
  if (
    canonicalStringify([...(cacheCore.CACHE_BANK_SET_IDS ?? [])]) !==
    canonicalStringify(PUBLIC_BLUEPRINT.map((entry) => entry.id))
  )
    throw new Error("cacheCore set ids do not match the public blueprint");
  return cacheCore;
}

export function buildGeneratorRequest(blueprint, seed, batchOrdinal, count) {
  if (![1, 2].includes(batchOrdinal)) throw new Error("Generator batchOrdinal must be 1 or 2");
  const expected = batchOrdinal === 1 ? GENERATOR_CANDIDATES : SUPPLEMENTAL_CANDIDATES;
  if (count !== expected) throw new Error(`Batch ${batchOrdinal} must request exactly ${expected} candidates`);
  return {
    system: GENERATOR_SYSTEM_PROMPT,
    payload: {
      schemaVersion: "cache-bank-generator-request/v1",
      blueprint,
      seed,
      batchOrdinal,
      candidateCount: count,
      responseShape: { candidates: [`exactly ${count} CacheScenario objects with kind ${blueprint.id}`] }
    }
  };
}

export function parseGeneratorResponse(text, expectedSetId, expectedCount) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch {
    throw new Error("Generator returned invalid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed.candidates)
  )
    throw new Error("Generator response must contain only a candidates array");
  if (parsed.candidates.length !== expectedCount)
    throw new Error(`Generator must return exactly ${expectedCount} candidates for ${expectedSetId}`);
  return parsed.candidates;
}

export function buildEvaluatorRequest(blueprint, candidate, sameSetEarlierCandidates = []) {
  return {
    system: EVALUATOR_SYSTEM_PROMPT,
    payload: {
      schemaVersion: "cache-bank-evaluator-request/v1",
      blueprint: {
        id: blueprint.id,
        targetConcept: blueprint.targetConcept,
        equivalenceAnchor: blueprint.equivalenceAnchor
      },
      candidate,
      sameSetEarlierCandidates: sameSetEarlierCandidates.map((entry) => ({
        candidateSha256: entry.candidateSha256,
        scenario: entry.scenario,
        primaryPrompt: entry.primary.prompt,
        transferPrompt: entry.transfer.prompt
      })),
      responseShape: {
        verdict: "pass | fail | unsure",
        checks: Object.fromEntries(EVALUATOR_CHECKS.map((check) => [check, "pass | fail | unsure"])),
        reasons: ["short reason strings"]
      }
    }
  };
}

export function parseEvaluatorResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch {
    return { status: "error", verdict: "error", checks: null, reasons: ["evaluator returned invalid JSON"] };
  }
  const reasons = [];
  const expectedKeys = ["checks", "reasons", "verdict"];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    reasons.push("evaluator response must be an object");
  else {
    if (canonicalStringify(Object.keys(parsed).sort()) !== canonicalStringify(expectedKeys))
      reasons.push("evaluator response keys are invalid");
    if (!["pass", "fail", "unsure"].includes(parsed.verdict)) reasons.push("evaluator verdict is invalid");
    const checkKeys = parsed.checks && typeof parsed.checks === "object" ? Object.keys(parsed.checks).sort() : [];
    if (canonicalStringify(checkKeys) !== canonicalStringify([...EVALUATOR_CHECKS].sort()))
      reasons.push("evaluator checks are invalid");
    else
      for (const check of EVALUATOR_CHECKS)
        if (!["pass", "fail", "unsure"].includes(parsed.checks[check]))
          reasons.push(`evaluator check ${check} is invalid`);
    if (!Array.isArray(parsed.reasons) || parsed.reasons.some((reason) => typeof reason !== "string" || !reason.trim()))
      reasons.push("evaluator reasons must be nonempty strings");
  }
  if (reasons.length) return { status: "error", verdict: "error", checks: null, reasons };
  const allPass = EVALUATOR_CHECKS.every((check) => parsed.checks[check] === "pass");
  if (parsed.verdict === "pass" && !allPass)
    return {
      status: "rejected",
      verdict: "fail",
      checks: parsed.checks,
      reasons: ["pass verdict is incoherent with a non-pass check", ...parsed.reasons]
    };
  return {
    status: parsed.verdict === "pass" && allPass ? "approved" : "rejected",
    verdict: parsed.verdict,
    checks: parsed.checks,
    reasons: parsed.reasons
  };
}

export function protocolDescriptor(cacheCore) {
  assertCacheCore(cacheCore);
  const models = assertDistinctModelIds();
  const descriptor = {
    schemaVersion: "cache-bank-generation-protocol/v1",
    bankVersion: BANK_VERSION,
    cacheCoreSetIds: [...cacheCore.CACHE_BANK_SET_IDS],
    generator: {
      model: GENERATOR_MODEL,
      normalizedModel: models.generator,
      responseModelIdentityRequired: true,
      candidates: GENERATOR_CANDIDATES,
      attemptPlan: GENERATOR_ATTEMPT_PLAN
    },
    evaluator: {
      model: EVALUATOR_MODEL,
      normalizedModel: models.evaluator,
      responseModelIdentityRequired: true,
      sameSetEarlierCandidatesProvided: true,
      failClosed: true,
      checks: EVALUATOR_CHECKS,
      attemptPlan: EVALUATOR_ATTEMPT_PLAN
    },
    supplementalBatch: {
      condition: `fewer than ${FROZEN_VARIANTS} approved unique candidates`,
      candidates: SUPPLEMENTAL_CANDIDATES,
      maximumBatches: 2
    },
    selection: "cacheCore parameter signature dedupe, candidate SHA-256 sort, first four",
    generatorPromptSha256: sha256(GENERATOR_SYSTEM_PROMPT),
    evaluatorPromptSha256: sha256(EVALUATOR_SYSTEM_PROMPT),
    blueprintSha256: sha256(canonicalStringify(PUBLIC_BLUEPRINT))
  };
  return { ...descriptor, protocolSha256: sha256(canonicalStringify(descriptor)) };
}

export function newCheckpoint({ seed, provenance, cacheCore }) {
  if (!Number.isInteger(seed) || seed < 0) throw new Error("Cache bank seed must be a nonnegative integer");
  const protocol = protocolDescriptor(cacheCore);
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    bankVersion: BANK_VERSION,
    seed,
    protocolSha256: protocol.protocolSha256,
    provenance,
    createdAt: provenance.startedAt,
    updatedAt: provenance.startedAt,
    sets: Object.fromEntries(PUBLIC_BLUEPRINT.map((blueprint) => [blueprint.id, { batches: [], candidates: [] }]))
  };
}

export function validateCheckpoint(checkpoint, { seed, provenance, cacheCore }) {
  if (checkpoint?.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || checkpoint.bankVersion !== BANK_VERSION)
    throw new Error("Resume checkpoint schema or bank version is incompatible");
  if (checkpoint.seed !== seed) throw new Error("Resume checkpoint seed does not match");
  if (checkpoint.protocolSha256 !== protocolDescriptor(cacheCore).protocolSha256)
    throw new Error("Resume checkpoint protocol does not match this implementation");
  for (const field of ["gitSha", "buildSha", "verifierSha256"])
    if (checkpoint.provenance?.[field] !== provenance[field])
      throw new Error(`Resume checkpoint ${field} does not match`);
  if (canonicalStringify(checkpoint.provenance?.provider) !== canonicalStringify(provenance.provider))
    throw new Error("Resume checkpoint provider does not match");
  return checkpoint;
}

const batchSeed = (seed, setId, ordinal) => Number.parseInt(sha256(`${seed}\0${setId}\0${ordinal}`).slice(0, 8), 16);
const clone = (value) => structuredClone(value);

async function persist(checkpoint, saveCheckpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  await saveCheckpoint(clone(checkpoint));
}

async function ensureBatch({ checkpoint, blueprint, ordinal, count, generateBatch, saveCheckpoint }) {
  const state = checkpoint.sets[blueprint.id];
  const existing = state.batches.find((batch) => batch.ordinal === ordinal);
  if (existing?.status === "completed") return;
  if (existing?.status === "failed")
    throw new Error(`Generator batch ${blueprint.id}/${ordinal} previously failed: ${existing.error}`);
  const seed = batchSeed(checkpoint.seed, blueprint.id, ordinal);
  const request = buildGeneratorRequest(blueprint, seed, ordinal, count);
  const batch = existing ?? {
    ordinal,
    count,
    seed,
    status: "requested",
    requestSha256: sha256(canonicalStringify(request.payload)),
    rawResponse: null,
    rawResponseSha256: null,
    modelAttempts: [],
    error: null
  };
  if (!existing) state.batches.push(batch);
  await persist(checkpoint, saveCheckpoint);
  try {
    const modelResult = await generateBatch({ blueprint, seed, ordinal, count, request });
    const rawResponse = typeof modelResult === "string" ? modelResult : modelResult.text;
    batch.modelAttempts = typeof modelResult === "string" ? [] : (modelResult.attempts ?? []);
    const scenarios = parseGeneratorResponse(rawResponse, blueprint.id, count);
    Object.assign(batch, { rawResponse, rawResponseSha256: sha256(rawResponse), status: "completed" });
    for (const [candidateIndex, scenario] of scenarios.entries())
      state.candidates.push({
        setId: blueprint.id,
        batchOrdinal: ordinal,
        candidateIndex,
        scenario,
        hardGate: null,
        candidate: null,
        evaluator: null
      });
    await persist(checkpoint, saveCheckpoint);
  } catch (error) {
    batch.status = "failed";
    batch.error = String(error?.message ?? error).slice(0, 1_000);
    if (Array.isArray(error?.modelAttempts)) batch.modelAttempts = error.modelAttempts;
    await persist(checkpoint, saveCheckpoint);
    throw error;
  }
}

async function evaluatePending({ checkpoint, blueprint, cacheCore, evaluateCandidate, saveCheckpoint }) {
  const records = checkpoint.sets[blueprint.id].candidates.sort(
    (left, right) => left.batchOrdinal - right.batchOrdinal || left.candidateIndex - right.candidateIndex
  );
  const seen = new Set();
  const seenParts = new Set();
  for (const record of records) {
    if (!record.hardGate) {
      const validation =
        record.scenario?.kind === blueprint.id
          ? cacheCore.validateCacheScenario(record.scenario, { seenParameterSignatures: seen })
          : {
              valid: false,
              issues: [`single_target:scenario kind must be ${blueprint.id}`],
              parameterSignature: null
            };
      const partSignatures =
        record.scenario?.primary && record.scenario?.transfer
          ? [
              sha256(cacheCore.stableCacheJson(record.scenario.primary)),
              sha256(cacheCore.stableCacheJson(record.scenario.transfer))
            ]
          : [];
      const duplicateIssues = partSignatures.flatMap((signature, index) =>
        seenParts.has(signature)
          ? [`duplicate_parameters:${index === 0 ? "primary" : "transfer"} parameters already appeared in this set`]
          : []
      );
      const valid = validation.valid && duplicateIssues.length === 0;
      record.hardGate = {
        status: valid ? "passed" : "rejected",
        reasons: [...validation.issues, ...duplicateIssues]
      };
      if (valid)
        try {
          const candidate = cacheCore.createCacheCandidate(record.scenario, { seenParameterSignatures: seen });
          const verification = cacheCore.verifyCacheCandidate(candidate);
          if (verification.valid) record.candidate = candidate;
          else record.hardGate = { status: "rejected", reasons: verification.issues };
        } catch (error) {
          record.hardGate = { status: "rejected", reasons: [String(error?.message ?? error)] };
        }
      await persist(checkpoint, saveCheckpoint);
    }
    const signature =
      record.candidate?.parameterSignature ?? cacheCore.validateCacheScenario(record.scenario).parameterSignature;
    if (signature) seen.add(signature);
    if (record.candidate) {
      seenParts.add(sha256(cacheCore.stableCacheJson(record.candidate.scenario.primary)));
      seenParts.add(sha256(cacheCore.stableCacheJson(record.candidate.scenario.transfer)));
    }
    if (record.hardGate.status !== "passed" || record.evaluator) continue;
    try {
      const sameSetEarlierCandidates = records
        .filter(
          (entry) =>
            entry !== record &&
            entry.candidate &&
            (entry.batchOrdinal < record.batchOrdinal ||
              (entry.batchOrdinal === record.batchOrdinal && entry.candidateIndex < record.candidateIndex))
        )
        .map((entry) => entry.candidate);
      const request = buildEvaluatorRequest(blueprint, record.candidate, sameSetEarlierCandidates);
      const modelResult = await evaluateCandidate({ blueprint, candidate: record.candidate, request });
      const rawResponse = typeof modelResult === "string" ? modelResult : modelResult.text;
      const verdict = parseEvaluatorResponse(rawResponse);
      record.evaluator = {
        ...verdict,
        rawResponse,
        rawResponseSha256: sha256(rawResponse),
        modelAttempts: typeof modelResult === "string" ? [] : (modelResult.attempts ?? [])
      };
    } catch (error) {
      record.evaluator = {
        status: "error",
        verdict: "error",
        checks: null,
        reasons: [String(error?.message ?? error).slice(0, 1_000)],
        rawResponse: null,
        rawResponseSha256: null,
        modelAttempts: Array.isArray(error?.modelAttempts) ? error.modelAttempts : []
      };
    }
    await persist(checkpoint, saveCheckpoint);
  }
}

const approvedRecords = (checkpoint, setId) =>
  checkpoint.sets[setId].candidates.filter(
    (record) => record.hardGate?.status === "passed" && record.evaluator?.status === "approved"
  );

function assertEvaluatorInstrument(checkpoint) {
  const records = PUBLIC_BLUEPRINT.flatMap((blueprint) => checkpoint.sets[blueprint.id].candidates);
  const error = records.find((record) => record.evaluator?.status === "error");
  const unsure = records.find((record) => record.evaluator?.verdict === "unsure");
  if (error) throw new Error(`Bank evaluator error on ${error.setId}/${error.batchOrdinal}/${error.candidateIndex}`);
  if (unsure)
    throw new Error(`Bank evaluator unsure on ${unsure.setId}/${unsure.batchOrdinal}/${unsure.candidateIndex}`);
}

const publicVerdict = (record, selected) => ({
  setId: record.setId,
  batchOrdinal: record.batchOrdinal,
  candidateIndex: record.candidateIndex,
  candidateSha256: record.candidate?.candidateSha256 ?? sha256(canonicalStringify(record.scenario)),
  parameterSignature: record.candidate?.parameterSignature ?? null,
  hardGate: record.hardGate,
  evaluator: record.evaluator
    ? {
        status: record.evaluator.status,
        verdict: record.evaluator.verdict,
        checks: record.evaluator.checks,
        reasons: record.evaluator.reasons,
        rawResponseSha256: record.evaluator.rawResponseSha256,
        modelAttempts: record.evaluator.modelAttempts
      }
    : null,
  selected
});

export async function runCacheBankFreeze({
  checkpoint,
  seed,
  provenance,
  cacheCore,
  generateBatch,
  evaluateCandidate,
  saveCheckpoint
}) {
  assertCacheCore(cacheCore);
  const state = checkpoint
    ? validateCheckpoint(checkpoint, { seed, provenance, cacheCore })
    : newCheckpoint({ seed, provenance, cacheCore });
  await persist(state, saveCheckpoint);
  for (const blueprint of PUBLIC_BLUEPRINT) {
    await ensureBatch({
      checkpoint: state,
      blueprint,
      ordinal: 1,
      count: GENERATOR_CANDIDATES,
      generateBatch,
      saveCheckpoint
    });
    await evaluatePending({ checkpoint: state, blueprint, cacheCore, evaluateCandidate, saveCheckpoint });
    assertEvaluatorInstrument(state);
    if (approvedRecords(state, blueprint.id).length < FROZEN_VARIANTS) {
      await ensureBatch({
        checkpoint: state,
        blueprint,
        ordinal: 2,
        count: SUPPLEMENTAL_CANDIDATES,
        generateBatch,
        saveCheckpoint
      });
      await evaluatePending({ checkpoint: state, blueprint, cacheCore, evaluateCandidate, saveCheckpoint });
      assertEvaluatorInstrument(state);
    }
    if (approvedRecords(state, blueprint.id).length < FROZEN_VARIANTS)
      throw new Error(
        `${blueprint.id} has fewer than ${FROZEN_VARIANTS} approved unique candidates after its fixed supplemental batch`
      );
  }

  const items = [];
  const selectedHashes = new Set();
  for (const blueprint of PUBLIC_BLUEPRINT) {
    const selected = approvedRecords(state, blueprint.id)
      .slice()
      .sort((left, right) => left.candidate.candidateSha256.localeCompare(right.candidate.candidateSha256))
      .slice(0, FROZEN_VARIANTS);
    for (const [index, record] of selected.entries()) {
      const verification = cacheCore.verifyCacheCandidate(record.candidate);
      if (!verification.valid)
        throw new Error(`Selected candidate ${record.candidate.candidateSha256} failed cacheCore recomputation`);
      selectedHashes.add(record.candidate.candidateSha256);
      items.push({
        id: `${blueprint.id}--v${index + 1}--${record.candidate.candidateSha256.slice(0, 12)}`,
        bankVersion: BANK_VERSION,
        setId: blueprint.id,
        variant: index + 1,
        candidate: record.candidate
      });
    }
  }
  if (items.length !== PUBLIC_BLUEPRINT.length * FROZEN_VARIANTS)
    throw new Error("Frozen bank must contain exactly 24 items");
  const finalBankSha256 = sha256(cacheCore.stableCacheJson(items));
  const bank = {
    schemaVersion: BANK_SCHEMA_VERSION,
    bankVersion: BANK_VERSION,
    immutable: true,
    machineVerified: true,
    itemCount: items.length,
    finalBankSha256,
    items
  };
  const protocol = protocolDescriptor(cacheCore);
  const candidateVerdicts = PUBLIC_BLUEPRINT.flatMap((blueprint) =>
    state.sets[blueprint.id].candidates.map((record) =>
      publicVerdict(record, selectedHashes.has(record.candidate?.candidateSha256))
    )
  );
  const counts = {
    sets: PUBLIC_BLUEPRINT.length,
    variantsPerSet: FROZEN_VARIANTS,
    frozenItems: items.length,
    oracleVerifiedItems: items.length,
    generatedCandidates: candidateVerdicts.length,
    approvedCandidates: candidateVerdicts.filter((entry) => entry.evaluator?.status === "approved").length,
    selectedApprovedCandidates: candidateVerdicts.filter(
      (entry) => entry.selected && entry.hardGate?.status === "passed" && entry.evaluator?.status === "approved"
    ).length,
    evaluatorErrors: candidateVerdicts.filter((entry) => entry.evaluator?.status === "error").length,
    evaluatorUnsure: candidateVerdicts.filter((entry) => entry.evaluator?.verdict === "unsure").length
  };
  if (
    counts.oracleVerifiedItems !== PUBLIC_BLUEPRINT.length * FROZEN_VARIANTS ||
    counts.selectedApprovedCandidates !== PUBLIC_BLUEPRINT.length * FROZEN_VARIANTS
  )
    throw new Error("Frozen bank requires 24 oracle-verified, evaluator-approved selected candidates");
  if (counts.evaluatorErrors || counts.evaluatorUnsure)
    throw new Error("Frozen bank requires zero evaluator errors and zero unsure verdicts");
  const generatorBatches = PUBLIC_BLUEPRINT.flatMap((blueprint) =>
    state.sets[blueprint.id].batches.map((batch) => ({
      setId: blueprint.id,
      ordinal: batch.ordinal,
      count: batch.count,
      seed: batch.seed,
      status: batch.status,
      requestSha256: batch.requestSha256,
      rawResponseSha256: batch.rawResponseSha256,
      modelAttempts: batch.modelAttempts
    }))
  );
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bankVersion: BANK_VERSION,
    immutable: true,
    createdAt: new Date().toISOString(),
    gitSha: provenance.gitSha,
    gitDirty: provenance.gitDirty,
    buildSha: provenance.buildSha,
    seed,
    provider: provenance.provider,
    models: {
      generator: { id: GENERATOR_MODEL, normalizedId: normalizeModelId(GENERATOR_MODEL), effort: "default" },
      evaluator: { id: EVALUATOR_MODEL, normalizedId: normalizeModelId(EVALUATOR_MODEL), effort: "default" }
    },
    hashes: {
      generatorPromptSha256: protocol.generatorPromptSha256,
      evaluatorPromptSha256: protocol.evaluatorPromptSha256,
      blueprintSha256: protocol.blueprintSha256,
      protocolSha256: protocol.protocolSha256,
      verifierSha256: provenance.verifierSha256,
      finalBankSha256
    },
    counts,
    generatorBatches,
    candidateVerdicts
  };
  return { checkpoint: state, bank, blueprint: PUBLIC_BLUEPRINT, protocol, manifest };
}
