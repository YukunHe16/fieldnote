#!/usr/bin/env node
/**
 * Re-grade the 48 frozen Cache-bank canonical answers twice (96 independent calls).
 * This measures repeatability and agreement with pre-registered machine expectations;
 * it is not evidence about real learners or independent human correctness.
 *
 *   node scripts/cache-bank-stability.mjs --input data/cache-bank-runs/<run>/posttest-cases.json
 *     --out data/cache-bank-runs/<run>/stability [--judge-model <id>]
 *   node scripts/cache-bank-stability.mjs --resume <results.json>
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ANSWER_FORMAT_STRUCTURED,
  JUDGE_CONTRACT_VERSION,
  gradeAnswer,
  parseStructuredAnswer
} from "./learning-eval.mjs";
import { buildPosttestCases } from "./cache-bank-posttest-cases.mjs";
import { canonicalStringify, normalizeModelId } from "./cache-bank-freeze-lib.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const EXPECTED_ITEMS = 24;
const EXPECTED_CASES = 48;
const EXPECTED_REPEATS = 2;
const EXPECTED_SETS = 6;
const VARIANTS_PER_SET = 4;
const DEFAULT_CONCURRENCY = 4;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (values) => [...(values ?? [])].map(String).sort();
const sameStrings = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const gradingKey = (caseId, repeat) => `${caseId}\0${repeat}`;

function parseArgs(argv) {
  const args = { repeats: EXPECTED_REPEATS, concurrency: DEFAULT_CONCURRENCY };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const next = () => argv[++index];
    if (key === "--input") args.input = next();
    else if (key === "--out") args.out = next();
    else if (key === "--resume") args.resume = next();
    else if (key === "--judge-model") args.judgeModel = next();
    else if (key === "--judge-base") args.judgeBase = next();
    else if (key === "--judge-key") args.judgeKey = next();
    else if (key === "--concurrency") args.concurrency = Number(next());
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (args.repeats !== EXPECTED_REPEATS) throw new Error("Cache B gate is fixed at exactly two repeats");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 12)
    throw new Error("--concurrency must be an integer from 1 to 12");
  if (args.resume && (args.input || args.out)) throw new Error("--resume cannot be combined with --input or --out");
  if (!args.resume && !args.input) throw new Error("--input is required unless --resume is used");
  return args;
}

async function loadEnvFile(file) {
  const env = {};
  try {
    for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || line.trim().startsWith("#")) continue;
      env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Explicit flags or process environment can provide the values.
  }
  return env;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Every grading item must be an object");
  const id = String(raw.id ?? "");
  const opening = String(raw.opening ?? "");
  const postTest = String(raw.postTest ?? "");
  const concepts = raw.concepts ?? raw.compiled;
  if (raw.machineVerified !== true && raw.machine_verified !== true)
    throw new Error(`Grading item ${id || "<missing id>"} is not machine-verified`);
  if (!id || !opening.trim() || !postTest.trim() || !Array.isArray(concepts) || concepts.length === 0)
    throw new Error(`Invalid grading item ${id || "<missing id>"}`);
  const conceptIds = new Set();
  const compiled = concepts.map((concept) => {
    const conceptId = String(concept?.id ?? "");
    const label = String(concept?.label ?? "");
    if (!conceptId || !label || conceptIds.has(conceptId)) throw new Error(`Invalid concepts for item ${id}`);
    conceptIds.add(conceptId);
    return {
      id: conceptId,
      label,
      credit: concept?.credit == null ? null : String(concept.credit),
      patterns: []
    };
  });
  return { id, opening, postTest, compiled };
}

function validateCasesPayload(payload) {
  if (payload?.schemaVersion !== "cache-bank-posttest-cases/v1")
    throw new Error("Expected schemaVersion cache-bank-posttest-cases/v1");
  if (payload.answerFormat !== ANSWER_FORMAT_STRUCTURED)
    throw new Error(`Cache B gate requires ${ANSWER_FORMAT_STRUCTURED}`);
  if (payload.judgeContractVersion !== JUDGE_CONTRACT_VERSION)
    throw new Error(`Cache B gate requires judge contract ${JUDGE_CONTRACT_VERSION}`);
  if (
    payload.bank?.version !== "cache-v1" ||
    !/^[a-f0-9]{64}$/.test(payload.bank?.contentSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(payload.bank?.fileSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(payload.bank?.manifestFileSha256 ?? "") ||
    typeof payload.bank?.path !== "string" ||
    typeof payload.bank?.manifestPath !== "string"
  )
    throw new Error("Cache B gate input must pin the cache-v1 bank and manifest paths and SHA-256 values");
  if (!Array.isArray(payload.items) || payload.items.length !== EXPECTED_ITEMS)
    throw new Error(`Expected exactly ${EXPECTED_ITEMS} grading items`);
  if (!Array.isArray(payload.cases) || payload.cases.length !== EXPECTED_CASES)
    throw new Error(`Expected exactly ${EXPECTED_CASES} canonical answer cases`);

  const items = payload.items.map(normalizeItem);
  const itemById = new Map(items.map((item) => [item.id, item]));
  if (itemById.size !== EXPECTED_ITEMS) throw new Error("Grading item ids must be unique");
  const caseIds = new Set();
  const itemVariantCounts = new Map();
  const setItems = new Map();
  const cases = payload.cases.map((entry) => {
    const caseId = String(entry?.caseId ?? "");
    const itemId = String(entry?.itemId ?? "");
    const setId = String(entry?.setId ?? "");
    const variant = Number(entry?.variant);
    const answerVariant = String(entry?.answerVariant ?? "");
    const answer = String(entry?.answer ?? "");
    const expectedConceptIds = sorted(entry?.expected?.conceptIds);
    const expectedVerdict = String(entry?.expected?.verdict ?? "");
    const omittedConceptId = entry?.omittedConceptId == null ? null : String(entry.omittedConceptId);
    const item = itemById.get(itemId);
    if (!caseId || caseIds.has(caseId)) throw new Error(`Duplicate or missing caseId ${caseId}`);
    if (!item) throw new Error(`Case ${caseId} references unknown item ${itemId}`);
    if (!setId || !Number.isInteger(variant) || variant < 1 || variant > VARIANTS_PER_SET)
      throw new Error(`Case ${caseId} has invalid set/variant`);
    if (answerVariant !== "complete" && answerVariant !== "omission")
      throw new Error(`Case ${caseId} has invalid answerVariant`);
    if (entry?.machineVerified !== true && entry?.machine_verified !== true)
      throw new Error(`Case ${caseId} is not machine-verified`);
    if (!answer.trim()) throw new Error(`Case ${caseId} has an empty answer`);
    if (entry.answerSha256 !== sha256(answer)) throw new Error(`Case ${caseId} answer SHA-256 mismatch`);
    try {
      parseStructuredAnswer(answer);
    } catch (error) {
      throw new Error(`Case ${caseId} violates structured-v1: ${error?.message ?? error}`);
    }
    if (expectedVerdict !== "resolved" && expectedVerdict !== "partial" && expectedVerdict !== "unresolved")
      throw new Error(`Case ${caseId} has invalid expected verdict`);
    const knownConceptIds = new Set(item.compiled.map((concept) => concept.id));
    if (expectedConceptIds.length === 0 || expectedConceptIds.some((id) => !knownConceptIds.has(id)))
      throw new Error(`Case ${caseId} has invalid expected concept ids`);
    if (answerVariant === "complete") {
      if (omittedConceptId !== null || expectedConceptIds.length !== item.compiled.length)
        throw new Error(`Complete case ${caseId} must expect every concept and omit none`);
      if (expectedVerdict !== "resolved") throw new Error(`Complete case ${caseId} must expect resolved`);
    } else {
      if (!omittedConceptId || !knownConceptIds.has(omittedConceptId))
        throw new Error(`Omission case ${caseId} must name one omitted concept`);
      if (expectedConceptIds.includes(omittedConceptId) || expectedConceptIds.length !== item.compiled.length - 1)
        throw new Error(`Omission case ${caseId} must omit exactly its pre-registered concept`);
      if (expectedVerdict !== "partial") throw new Error(`Omission case ${caseId} must expect partial`);
    }
    caseIds.add(caseId);
    const countKey = `${itemId}\0${answerVariant}`;
    itemVariantCounts.set(countKey, (itemVariantCounts.get(countKey) ?? 0) + 1);
    if (!setItems.has(setId)) setItems.set(setId, new Map());
    const variants = setItems.get(setId);
    if (!variants.has(variant)) variants.set(variant, itemId);
    else if (variants.get(variant) !== itemId) throw new Error(`Set ${setId} variant ${variant} maps to two items`);
    return {
      caseId,
      itemId,
      setId,
      variant,
      answerVariant,
      answer,
      answerSha256: entry.answerSha256,
      expectedConceptIds,
      expectedVerdict,
      omittedConceptId,
      machineVerified: true
    };
  });

  for (const item of items) {
    for (const answerVariant of ["complete", "omission"])
      if (itemVariantCounts.get(`${item.id}\0${answerVariant}`) !== 1)
        throw new Error(`Item ${item.id} must have exactly one ${answerVariant} case`);
  }
  if (setItems.size !== EXPECTED_SETS) throw new Error(`Expected exactly ${EXPECTED_SETS} sets`);
  for (const [setId, variants] of setItems)
    if (variants.size !== VARIANTS_PER_SET)
      throw new Error(`Set ${setId} must contain exactly ${VARIANTS_PER_SET} variants`);
  return { bank: payload.bank, items, itemById, cases };
}

async function verifyPinnedBankPayload(payload) {
  const bankFile = path.resolve(repo, payload?.bank?.path ?? "");
  const manifestFile = path.resolve(repo, payload?.bank?.manifestPath ?? "");
  const [bankBytes, manifestBytes] = await Promise.all([fs.readFile(bankFile), fs.readFile(manifestFile)]);
  if (sha256(bankBytes) !== payload.bank.fileSha256) throw new Error("Pinned Cache bank file SHA-256 mismatch");
  if (sha256(manifestBytes) !== payload.bank.manifestFileSha256)
    throw new Error("Pinned Cache manifest file SHA-256 mismatch");
  const rebuilt = await buildPosttestCases({
    bankBytes,
    manifestBytes,
    bankPath: payload.bank.path,
    manifestPath: payload.bank.manifestPath
  });
  if (sha256(JSON.stringify(rebuilt.items)) !== sha256(JSON.stringify(payload.items)))
    throw new Error("Cache B grading items do not deterministically match the pinned bank");
  if (sha256(JSON.stringify(rebuilt.cases)) !== sha256(JSON.stringify(payload.cases)))
    throw new Error("Cache B canonical answers do not deterministically match the pinned bank");
  if (rebuilt.bank.contentSha256 !== payload.bank.contentSha256)
    throw new Error("Pinned Cache bank content SHA-256 mismatch");
  return { bankFile, manifestFile };
}

function planGradings(cases, completed = []) {
  const caseIds = new Set(cases.map((entry) => entry.caseId));
  const seen = new Set();
  for (const grading of completed) {
    if (!caseIds.has(grading.caseId)) throw new Error(`Resume contains unknown case ${grading.caseId}`);
    if (!Number.isInteger(grading.repeat) || grading.repeat < 1 || grading.repeat > EXPECTED_REPEATS)
      throw new Error(`Resume contains invalid repeat for ${grading.caseId}`);
    const key = gradingKey(grading.caseId, grading.repeat);
    if (seen.has(key)) throw new Error(`Resume repeats ${grading.caseId} repeat ${grading.repeat}`);
    seen.add(key);
  }
  return cases.flatMap((entry) =>
    [1, 2].map((repeat) => ({ ...entry, repeat })).filter((entry) => !seen.has(gradingKey(entry.caseId, entry.repeat)))
  );
}

function orderedGradings(gradings, cases) {
  const order = new Map(cases.map((entry, index) => [entry.caseId, index]));
  return [...gradings].sort(
    (left, right) =>
      (order.get(left.caseId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.caseId) ?? Number.MAX_SAFE_INTEGER) ||
      left.repeat - right.repeat
  );
}

function summarizeCacheStability(gradings, cases) {
  const byCase = new Map(cases.map((entry) => [entry.caseId, []]));
  for (const grading of gradings) byCase.get(grading.caseId)?.push(grading);
  const caseResults = [];
  for (const entry of cases) {
    const results = (byCase.get(entry.caseId) ?? []).sort((left, right) => left.repeat - right.repeat);
    const complete = results.length === EXPECTED_REPEATS && results.every((result) => !result.error);
    const verdictAgreement = complete && results[0].verdict === results[1].verdict;
    const exactConceptAgreement = complete && sameStrings(results[0].matched, results[1].matched);
    const expectedConceptMatch =
      complete && results.every((result) => sameStrings(result.matched, entry.expectedConceptIds));
    const expectedVerdictMatch = complete && results.every((result) => result.verdict === entry.expectedVerdict);
    caseResults.push({
      caseId: entry.caseId,
      itemId: entry.itemId,
      setId: entry.setId,
      variant: entry.variant,
      answerVariant: entry.answerVariant,
      complete,
      verdictAgreement,
      exactConceptAgreement,
      expectedConceptMatch,
      expectedVerdictMatch,
      verdicts: results.map((result) => result.verdict ?? null),
      matched: results.map((result) => sorted(result.matched)),
      errors: results.map((result) => result.error ?? null)
    });
  }
  const successful = gradings.filter((grading) => !grading.error);
  const creditClaims = successful.flatMap((grading) =>
    (grading.concepts ?? []).filter((concept) => concept.judgeDemonstrated === true)
  );
  const invalidCreditClaims = creditClaims.filter((concept) => concept.evidenceValid !== true);
  return {
    itemCount: new Set(cases.map((entry) => entry.itemId)).size,
    caseCount: cases.length,
    expectedGradings: cases.length * EXPECTED_REPEATS,
    completedGradings: gradings.length,
    successfulGradings: successful.length,
    modelVerifiedGradings: successful.filter((grading) => grading.judgeResponseModelVerified === true).length,
    judgeErrors: gradings.filter((grading) => grading.error).length,
    formatParsedGradings: gradings.filter((grading) => grading.formatParsed === true).length,
    completeCases: caseResults.filter((entry) => entry.complete).length,
    verdictAgreements: caseResults.filter((entry) => entry.verdictAgreement).length,
    exactConceptAgreements: caseResults.filter((entry) => entry.exactConceptAgreement).length,
    expectedConceptMatches: caseResults.filter((entry) => entry.expectedConceptMatch).length,
    expectedVerdictMatches: caseResults.filter((entry) => entry.expectedVerdictMatch).length,
    creditClaims: creditClaims.length,
    invalidCreditClaims: invalidCreditClaims.length,
    caseResults
  };
}

function evaluateCacheStabilityGate(summary) {
  const gates = {
    shape:
      summary.itemCount === EXPECTED_ITEMS &&
      summary.caseCount === EXPECTED_CASES &&
      summary.expectedGradings === EXPECTED_CASES * EXPECTED_REPEATS,
    errors:
      summary.completedGradings === summary.expectedGradings &&
      summary.successfulGradings === summary.expectedGradings &&
      summary.modelVerifiedGradings === summary.expectedGradings &&
      summary.judgeErrors === 0 &&
      summary.formatParsedGradings === summary.expectedGradings &&
      summary.completeCases === EXPECTED_CASES,
    verdictAgreement: summary.verdictAgreements === EXPECTED_CASES,
    exactConceptAgreement: summary.exactConceptAgreements >= 46,
    expectedConceptAgreement: summary.expectedConceptMatches >= 46,
    expectedVerdicts: summary.expectedVerdictMatches === EXPECTED_CASES,
    evidence: summary.invalidCreditClaims === 0
  };
  return { ...gates, overallPass: Object.values(gates).every(Boolean) };
}

function validateCompletedCacheStability(result, payload) {
  if (result?.schemaVersion !== "cache-bank-stability-results/v1")
    throw new Error("Cache B stability result schema is invalid");
  const requestedModel = result.config?.judgeModel;
  if (typeof requestedModel !== "string") throw new Error("Cache B stability result does not pin its judge model");
  for (const grading of result.gradings ?? []) {
    if (grading.error) continue;
    const successfulAttempt = (grading.judgeAttempts ?? []).find((attempt) => attempt.outcome === "success");
    if (
      typeof successfulAttempt?.responseModel !== "string" ||
      normalizeModelId(successfulAttempt.responseModel) !== normalizeModelId(requestedModel)
    )
      throw new Error(`Cache B grading ${grading.caseId} does not verify the requested judge model`);
  }
  const { cases } = validateCasesPayload(payload);
  const pending = planGradings(cases, result.gradings ?? []);
  if (pending.length !== 0) throw new Error(`Cache B stability result is missing ${pending.length} grading(s)`);
  const summary = summarizeCacheStability(result.gradings, cases);
  const gate = evaluateCacheStabilityGate(summary);
  if (canonicalStringify(result.summary) !== canonicalStringify(summary))
    throw new Error("Cache B stored summary does not match its 96 grading records");
  if (canonicalStringify(result.gate) !== canonicalStringify(gate))
    throw new Error("Cache B stored gate does not match its 96 grading records");
  if (!gate.overallPass) throw new Error("Cache B stability gate must pass before publication");
  return { cases, summary, gate };
}

async function writeAtomic(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.rename(temporary, file);
}

async function runPool(tasks, concurrency, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= tasks.length) return;
        await worker(tasks[index]);
      }
    })
  );
}

async function gitIdentity() {
  const [{ stdout: sha }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: repo })
  ]);
  return { sha: sha.trim(), dirty: Boolean(status.trim()) };
}

async function buildIdentity() {
  const parsed = JSON.parse(await fs.readFile(path.join(repo, "apps/server/dist/build-info.json"), "utf8"));
  return { version: String(parsed.version), gitSha: String(parsed.gitSha), gitDirty: parsed.gitDirty };
}

function validateResume(result, context) {
  if (result?.schemaVersion !== "cache-bank-stability-results/v1") throw new Error("Resume schema mismatch");
  if (result.input.sha256 !== context.input.sha256 || result.input.path !== context.input.path)
    throw new Error("Resume input mismatch");
  if (
    result.protocol.gitSha !== context.protocol.gitSha ||
    result.protocol.build.gitSha !== context.protocol.build.gitSha
  )
    throw new Error("Resume Git/build identity mismatch");
  if (result.config.judgeModel !== context.config.judgeModel || result.config.judgeBase !== context.config.judgeBase)
    throw new Error("Resume judge config mismatch");
  planGradings(context.cases, result.gradings ?? []);
}

function renderReport(result) {
  const summary = result.summary;
  const gate = result.gate;
  const status = (value) => (value ? "PASS" : "FAIL");
  const rows = summary.caseResults
    .filter(
      (entry) =>
        !entry.complete ||
        !entry.verdictAgreement ||
        !entry.exactConceptAgreement ||
        !entry.expectedConceptMatch ||
        !entry.expectedVerdictMatch
    )
    .map(
      (entry) =>
        `| ${entry.caseId} | ${entry.verdicts.join(" / ")} | ${status(entry.verdictAgreement)} | ${status(entry.exactConceptAgreement)} | ${status(entry.expectedConceptMatch)} | ${status(entry.expectedVerdictMatch)} |`
    )
    .join("\n");
  return `# Cache bank post-test stability — ${gate.overallPass ? "PASS" : "FAIL"}

> Machine-generated, machine-verified canonical answers. Repeatability and agreement with
> pre-registered machine expectations are not evidence about real learners or human correctness.

- Judge errors: ${summary.judgeErrors}/${summary.expectedGradings} (${status(gate.errors)})
- Effective judge model verified: ${summary.modelVerifiedGradings}/${summary.expectedGradings} (${status(gate.errors)})
- Verdict agreement: ${summary.verdictAgreements}/${summary.caseCount} (${status(gate.verdictAgreement)}; requires 48/48)
- Exact concept-set agreement: ${summary.exactConceptAgreements}/${summary.caseCount} (${status(gate.exactConceptAgreement)}; requires at least 46/48)
- Expected concept-set agreement: ${summary.expectedConceptMatches}/${summary.caseCount} (${status(gate.expectedConceptAgreement)}; requires at least 46/48)
- Expected verdict agreement: ${summary.expectedVerdictMatches}/${summary.caseCount} (${status(gate.expectedVerdicts)}; requires 48/48)
- Judge credit claims with valid quote/section: ${summary.creditClaims - summary.invalidCreditClaims}/${summary.creditClaims} (${status(gate.evidence)})

## Provenance

- Input: \`${result.input.path}\` · SHA-256 \`${result.input.sha256}\`
- Frozen bank: \`${result.input.bankVersion}\` · SHA-256 \`${result.input.bankSha256}\`
- Git/build: \`${result.protocol.gitSha}\` / \`${result.protocol.build.gitSha}\`
- Judge contract: \`${result.protocol.judgeContractVersion}\`
- Judge implementation SHA-256: \`${result.protocol.judgeImplementationSha256}\`
- Judge: \`${result.config.judgeModel}\` at \`${result.config.judgeBase}\`

## Incomplete or disagreeing cases

| Case | Verdicts | Verdict stable | Concepts stable | Expected concepts | Expected verdict |
| --- | --- | --- | --- | --- | --- |
${rows || "| — | — | PASS | PASS | PASS | PASS |"}
`;
}

async function main() {
  const args = parseArgs(process.argv);
  let resultsFile;
  let inputFile;
  let prior = null;
  if (args.resume) {
    resultsFile = path.resolve(repo, args.resume);
    prior = JSON.parse(await fs.readFile(resultsFile, "utf8"));
    inputFile = path.resolve(repo, prior.input.path);
  } else {
    inputFile = path.resolve(repo, args.input);
  }
  const inputBytes = await fs.readFile(inputFile);
  const payload = JSON.parse(inputBytes.toString("utf8"));
  await verifyPinnedBankPayload(payload);
  const { itemById, cases } = validateCasesPayload(payload);
  const env = { ...process.env, ...(await loadEnvFile(path.join(repo, ".env"))) };
  const config = {
    judgeBase: (args.judgeBase ?? env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, ""),
    judgeKey: args.judgeKey ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "",
    judgeModel: args.judgeModel ?? "deepseek-v4-flash-vision-exp"
  };
  if (!config.judgeKey) throw new Error("No judge credential; set ANTHROPIC_AUTH_TOKEN or --judge-key");
  const git = await gitIdentity();
  const build = await buildIdentity();
  if (git.dirty) throw new Error("Refusing to run the Cache B gate from a dirty checkout");
  if (build.gitDirty || build.gitSha !== git.sha) throw new Error("Clean Git SHA and server build SHA must match");
  const judgeBytes = await fs.readFile(path.join(repo, "scripts/learning-eval.mjs"));
  const input = {
    path: path.relative(repo, inputFile),
    sha256: sha256(inputBytes),
    bankVersion: String(payload.bank.version),
    bankSha256: String(payload.bank.contentSha256),
    bankFileSha256: String(payload.bank.fileSha256),
    manifestFileSha256: String(payload.bank.manifestFileSha256)
  };
  if (!/^cache-v\d+$/.test(input.bankVersion) || !/^[a-f0-9]{64}$/.test(input.bankSha256))
    throw new Error("Input must pin a cache bank version and SHA-256");
  const protocol = {
    gitSha: git.sha,
    build,
    answerFormat: ANSWER_FORMAT_STRUCTURED,
    judgeContractVersion: JUDGE_CONTRACT_VERSION,
    judgeImplementationSha256: sha256(judgeBytes)
  };
  const redactedConfig = { judgeBase: config.judgeBase, judgeModel: config.judgeModel, judgeKey: "[redacted]" };
  const context = { input, protocol, config: redactedConfig, cases };
  let result;
  if (prior) {
    validateResume(prior, context);
    result = prior;
  } else {
    const outDir = path.resolve(repo, args.out ?? `data/cache-bank-runs/stability-${Date.now()}`);
    resultsFile = path.join(outDir, "results.json");
    result = {
      schemaVersion: "cache-bank-stability-results/v1",
      startedAt: new Date().toISOString(),
      input,
      protocol,
      config: redactedConfig,
      repeats: EXPECTED_REPEATS,
      concurrency: args.concurrency,
      gradings: []
    };
  }
  const pending = planGradings(cases, result.gradings ?? []);
  console.log(
    `Cache B stability: ${pending.length} pending of ${EXPECTED_CASES * EXPECTED_REPEATS}; concurrency=${args.concurrency}`
  );
  let checkpoint = Promise.resolve();
  await runPool(pending, args.concurrency, async (task) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let grading;
    try {
      const judged = await gradeAnswer(
        { learnerBase: config.judgeBase, learnerKey: config.judgeKey, judgeModel: config.judgeModel },
        itemById.get(task.itemId),
        task.answer,
        { answerFormat: ANSWER_FORMAT_STRUCTURED }
      );
      const successfulAttempt = (judged.judgeAttempts ?? []).find((attempt) => attempt.outcome === "success");
      const responseModel = successfulAttempt?.responseModel;
      if (
        typeof responseModel !== "string" ||
        normalizeModelId(responseModel) !== normalizeModelId(config.judgeModel)
      ) {
        const error = new Error(`Judge response model does not match requested ${normalizeModelId(config.judgeModel)}`);
        error.judgeCategory = "model_identity_mismatch";
        error.judgeAttempts = judged.judgeAttempts;
        throw error;
      }
      grading = {
        caseId: task.caseId,
        itemId: task.itemId,
        repeat: task.repeat,
        setId: task.setId,
        variant: task.variant,
        answerVariant: task.answerVariant,
        omittedConceptId: task.omittedConceptId,
        expectedConceptIds: task.expectedConceptIds,
        machineVerified: true,
        startedAt,
        durationMs: Date.now() - started,
        formatParsed: true,
        error: null,
        verdict: judged.verdict,
        matched: judged.matched,
        concepts: judged.concepts,
        judgeAttempts: judged.judgeAttempts,
        judgeAttemptUsed: judged.judgeAttemptUsed,
        judgeResponseModel: responseModel,
        judgeResponseModelVerified: true
      };
    } catch (error) {
      grading = {
        caseId: task.caseId,
        itemId: task.itemId,
        repeat: task.repeat,
        setId: task.setId,
        variant: task.variant,
        answerVariant: task.answerVariant,
        omittedConceptId: task.omittedConceptId,
        expectedConceptIds: task.expectedConceptIds,
        machineVerified: true,
        startedAt,
        durationMs: Date.now() - started,
        formatParsed: error?.measurementCategory !== "post_test_format_error",
        errorCategory: error?.measurementCategory ?? error?.judgeCategory ?? null,
        error: String(error?.message ?? error),
        verdict: null,
        matched: [],
        concepts: [],
        judgeAttempts: error?.judgeAttempts ?? [],
        judgeAttemptUsed: null,
        judgeResponseModel: null,
        judgeResponseModelVerified: false
      };
    }
    result.gradings.push(grading);
    checkpoint = checkpoint.then(async () => {
      result.gradings = orderedGradings(result.gradings, cases);
      result.summary = summarizeCacheStability(result.gradings, cases);
      result.gate = evaluateCacheStabilityGate(result.summary);
      await writeAtomic(resultsFile, result);
    });
    await checkpoint;
    console.log(
      `  ${task.caseId} repeat ${task.repeat}: ${grading.error ? `ERROR ${grading.error}` : grading.verdict}`
    );
  });
  await checkpoint;
  result.completedAt = new Date().toISOString();
  result.gradings = orderedGradings(result.gradings, cases);
  result.summary = summarizeCacheStability(result.gradings, cases);
  result.gate = evaluateCacheStabilityGate(result.summary);
  await writeAtomic(resultsFile, result);
  await fs.writeFile(path.join(path.dirname(resultsFile), "report.md"), renderReport(result));
  console.log(`Wrote ${path.relative(repo, resultsFile)} and report.md · ${result.gate.overallPass ? "PASS" : "FAIL"}`);
  if (!result.gate.overallPass) process.exitCode = 1;
}

export {
  evaluateCacheStabilityGate,
  planGradings,
  renderReport,
  summarizeCacheStability,
  validateCasesPayload,
  validateCompletedCacheStability,
  validateResume,
  verifyPinnedBankPayload
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`cache-bank-stability failed: ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
