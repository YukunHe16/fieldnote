#!/usr/bin/env node
/**
 * Grade a frozen structured post-test holdout twice to measure judge stability.
 * Stability is repeatability, not evidence that either repeated judgment is correct.
 *
 *   node scripts/learning-posttest-stability.mjs
 *     [--input data/eval-runs/<holdout>/manifest.json] [--out data/eval-runs/<dir>]
 *     [--repeats 2] [--concurrency 4] [--judge-model <id>]
 *   node scripts/learning-posttest-stability.mjs --resume <results.json>
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANSWER_FORMAT_LEGACY,
  ANSWER_FORMAT_STRUCTURED,
  JUDGE_CONTRACT_VERSION,
  buildEvalProvenance,
  gradeAnswer,
  gradeRegex,
  loadItems,
  verifyServerBuild
} from "./learning-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const DEFAULT_INPUT = "data/eval-runs/posttest-holdout-v1/manifest.json";
const DEFAULT_REPEATS = 2;
const DEFAULT_CONCURRENCY = 4;
const EXPECTED_ARCHIVED_ANSWERS = 27;
const EXPECTED_HOLDOUT_ANSWERS = 12;
const HOLDOUT_ITEM_IDS = [
  "fu-wrong-endorsement-plain-dict-order",
  "fu-wrong-endorsement-plain-string-immutable",
  "fu-wrong-rejection-plain-append-returns",
  "fu-wrong-rejection-authoritative-floor-division"
];
const HOLDOUT_VARIANTS = ["complete", "original-only", "transfer-only"];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gradingKey = (answerId, repeat) => `${answerId}\0${repeat}`;
const sortedConcepts = (matched) => [...(matched ?? [])].sort();

function discoverPostTestAnswers(payload, expectedCount = EXPECTED_ARCHIVED_ANSWERS) {
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.cases)
      ? payload.cases
      : Array.isArray(payload?.answers)
        ? payload.answers
        : payload?.records;
  if (!Array.isArray(records)) throw new Error("Input must contain a records, cases, or answers array");
  if (records.length !== expectedCount)
    throw new Error(`Expected exactly ${expectedCount} answers; found ${records.length}`);

  const answers = records
    .filter((record) => {
      const answer = record?.answer ?? record?.finalPostTestAnswer;
      return typeof answer === "string" && answer.trim();
    })
    .map((record) => {
      const itemId = String(record.itemId ?? "");
      const answer = String(record.answer ?? record.finalPostTestAnswer);
      const answerFormat = String(record.answerFormat ?? payload?.answerFormat ?? ANSWER_FORMAT_LEGACY);
      const answerId = String(record.caseId ?? record.answerId ?? itemId);
      if (record.answerSha256 && record.answerSha256 !== sha256(answer)) {
        throw new Error(`Answer SHA-256 does not match for ${answerId}`);
      }
      return {
        answerId,
        itemId,
        variant: record.variant ? String(record.variant) : null,
        answer,
        answerFormat,
        answerSha256: record.answerSha256 ?? null,
        expected: record.expected ?? null
      };
    });
  if (answers.length !== expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} nonempty final post-test answers; found ${answers.length}`);
  }
  if (answers.some((answer) => !answer.itemId)) throw new Error("Every post-test answer must have an itemId");
  if (answers.some((answer) => !answer.answerId))
    throw new Error("Every post-test answer must have an answerId/caseId");

  const unique = new Set(answers.map((answer) => answer.answerId));
  if (unique.size !== answers.length) throw new Error("Post-test answerIds/caseIds must be unique");
  const formats = new Set(answers.map((answer) => answer.answerFormat));
  if (formats.size !== 1) throw new Error(`A stability report cannot mix answer formats: ${[...formats].join(", ")}`);
  if (payload?.answerFormat && !formats.has(payload.answerFormat)) {
    throw new Error(`Dataset answer format ${payload.answerFormat} conflicts with its records`);
  }
  return answers;
}

function validateHoldoutManifest(payload, answers) {
  if (payload?.schemaVersion !== "learning-posttest-holdout/v1") return;
  const expectedCases = new Set(
    HOLDOUT_ITEM_IDS.flatMap((itemId) => HOLDOUT_VARIANTS.map((variant) => `${itemId}::${variant}`))
  );
  if (answers.length !== expectedCases.size) throw new Error(`Holdout v1 must contain ${expectedCases.size} cases`);
  for (const answer of answers) {
    const expectedId = `${answer.itemId}::${answer.variant}`;
    if (!expectedCases.has(expectedId) || answer.answerId !== expectedId) {
      throw new Error(`Holdout v1 contains an unexpected item/variant/caseId: ${answer.answerId}`);
    }
    if (!/^[a-f0-9]{64}$/.test(answer.answerSha256 ?? "")) {
      throw new Error(`Holdout v1 requires a frozen SHA-256 for ${answer.answerId}`);
    }
  }
  if (new Set(answers.map((answer) => answer.answerId)).size !== expectedCases.size) {
    throw new Error("Holdout v1 must contain every item/variant exactly once");
  }
}

function planPendingGradings(answers, completedGradings = [], repeats = DEFAULT_REPEATS) {
  const normalizedAnswers = answers.map((answer) => ({ ...answer, answerId: answer.answerId ?? answer.itemId }));
  const answerIds = new Set(normalizedAnswers.map((answer) => answer.answerId));
  const completed = new Set();
  for (const grading of completedGradings) {
    const answerId = grading.answerId ?? grading.itemId;
    if (!answerIds.has(answerId)) throw new Error(`Resume contains unknown answerId: ${answerId}`);
    if (!Number.isInteger(grading.repeat) || grading.repeat < 1 || grading.repeat > repeats) {
      throw new Error(`Resume contains invalid repeat for ${answerId}: ${grading.repeat}`);
    }
    const key = gradingKey(answerId, grading.repeat);
    if (completed.has(key)) throw new Error(`Resume contains duplicate grading: ${answerId} repeat ${grading.repeat}`);
    completed.add(key);
  }
  return normalizedAnswers.flatMap((answer) =>
    Array.from({ length: repeats }, (_, index) => ({ ...answer, repeat: index + 1 })).filter(
      (grading) => !completed.has(gradingKey(grading.answerId, grading.repeat))
    )
  );
}

function summarizeStability(gradings, answerIds, repeats = DEFAULT_REPEATS) {
  const byItem = new Map(answerIds.map((answerId) => [answerId, []]));
  for (const grading of gradings) {
    const answerId = grading.answerId ?? grading.itemId;
    if (byItem.has(answerId)) byItem.get(answerId).push(grading);
  }

  let verdictAgreements = 0;
  let exactConceptAgreements = 0;
  let completeItems = 0;
  let formatParsedAnswers = 0;
  const itemResults = [];
  for (const answerId of answerIds) {
    const entries = byItem.get(answerId).sort((a, b) => a.repeat - b.repeat);
    const successful = entries.filter((entry) => !entry.error);
    const complete = entries.length === repeats && successful.length === repeats;
    const formatParsed = entries.length > 0 && entries.every((entry) => entry.formatParsed !== false);
    const verdictAgreement = complete && new Set(successful.map((entry) => entry.verdict)).size === 1;
    const conceptSignatures = successful.map((entry) => JSON.stringify(sortedConcepts(entry.matched)));
    const exactConceptAgreement = complete && new Set(conceptSignatures).size === 1;
    if (complete) completeItems += 1;
    if (formatParsed) formatParsedAnswers += 1;
    if (verdictAgreement) verdictAgreements += 1;
    if (exactConceptAgreement) exactConceptAgreements += 1;
    itemResults.push({
      answerId,
      itemId: entries[0]?.itemId ?? null,
      variant: entries[0]?.variant ?? null,
      complete,
      formatParsed,
      verdictAgreement,
      exactConceptAgreement,
      verdicts: entries.map((entry) => entry.verdict ?? null),
      matched: entries.map((entry) => sortedConcepts(entry.matched)),
      errors: entries.map((entry) => entry.error ?? null)
    });
  }

  const successful = gradings.filter((grading) => !grading.error);
  const regexComparable = successful.filter((grading) => typeof grading.agreed === "boolean");
  const creditedConcepts = successful.flatMap((grading) =>
    (grading.concepts ?? []).filter((concept) => concept.demonstrated === true)
  );
  const invalidCreditedConcepts = creditedConcepts.filter((concept) => concept.evidenceValid !== true);
  const downgradedConceptClaims = successful.flatMap((grading) =>
    (grading.concepts ?? []).filter(
      (concept) => concept.judgeDemonstrated === true && concept.demonstrated === false && concept.validationError
    )
  );
  return {
    itemCount: answerIds.length,
    answerCount: answerIds.length,
    repeats,
    expectedGradings: answerIds.length * repeats,
    completedGradings: gradings.length,
    successfulGradings: successful.length,
    judgeErrors: gradings.filter((grading) => grading.error).length,
    retriedGradings: successful.filter((grading) => (grading.judgeAttemptUsed ?? 1) > 1).length,
    noThinkingRecoveries: successful.filter((grading) =>
      (grading.judgeAttempts ?? []).some((attempt) => attempt.reasoningMode === "none" && attempt.outcome === "success")
    ).length,
    completeItems,
    formatParsedAnswers,
    verdictAgreements,
    exactConceptAgreements,
    regexAgreements: regexComparable.filter((grading) => grading.agreed).length,
    regexComparable: regexComparable.length,
    creditedConcepts: creditedConcepts.length,
    invalidCreditedConcepts: invalidCreditedConcepts.length,
    downgradedConceptClaims: downgradedConceptClaims.length,
    itemResults
  };
}

function evaluateStabilityGate(summary, { minimumVerdictAgreements = 26, minimumExactConceptAgreements = 24 } = {}) {
  const errorGate =
    summary.completedGradings === summary.expectedGradings &&
    summary.completeItems === summary.itemCount &&
    summary.judgeErrors === 0;
  const verdictGate = summary.verdictAgreements >= minimumVerdictAgreements;
  const exactConceptGate = summary.exactConceptAgreements >= minimumExactConceptAgreements;
  const formatGate = summary.formatParsedAnswers === summary.answerCount;
  const evidenceGate = summary.invalidCreditedConcepts === 0;
  return {
    thresholds: { minimumVerdictAgreements, minimumExactConceptAgreements },
    errorGate,
    verdictGate,
    exactConceptGate,
    formatGate,
    evidenceGate,
    overallPass: errorGate && verdictGate && exactConceptGate && formatGate && evidenceGate
  };
}

function validateResume(result, { input, repeats, protocol, config, thresholds }) {
  if (result.input?.sha256 !== input.sha256) throw new Error("Resume input SHA-256 does not match the current input");
  if (result.repeats !== repeats) throw new Error("Resume repeat count does not match --repeats");
  if (thresholds && JSON.stringify(result.thresholds) !== JSON.stringify(thresholds)) {
    throw new Error("Resume stability thresholds do not match the current run");
  }
  if (result.protocol?.fingerprint !== protocol.fingerprint) {
    throw new Error("Resume protocol fingerprint does not match the current checkout and item bank");
  }
  if (
    result.protocol?.answerFormat !== protocol.answerFormat ||
    result.protocol?.judgeContractVersion !== protocol.judgeContractVersion
  ) {
    throw new Error("Resume answer format or judge contract does not match the current protocol");
  }
  if (
    result.protocol?.buildIdentity?.gitSha !== protocol.buildIdentity.gitSha ||
    result.protocol?.buildIdentity?.gitDirty !== protocol.buildIdentity.gitDirty
  ) {
    throw new Error("Resume build identity does not match the current clean build");
  }
  if (result.config?.learnerBase !== config.learnerBase || result.config?.judgeModel !== config.judgeModel) {
    throw new Error("Resume judge model/provider does not match the current configuration");
  }
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    repeats: DEFAULT_REPEATS,
    concurrency: DEFAULT_CONCURRENCY
  };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${key} requires a value`);
      return argv[index];
    };
    if (key === "--input") args.input = next();
    else if (key === "--out") args.out = next();
    else if (key === "--resume") args.resume = next();
    else if (key === "--repeats") args.repeats = parsePositiveInteger(next(), key);
    else if (key === "--concurrency") args.concurrency = parsePositiveInteger(next(), key);
    else if (key === "--expected-answers") args.expectedAnswers = parsePositiveInteger(next(), key);
    else if (key === "--minimum-verdict-agreements") args.minimumVerdictAgreements = parsePositiveInteger(next(), key);
    else if (key === "--minimum-concept-agreements")
      args.minimumExactConceptAgreements = parsePositiveInteger(next(), key);
    else if (key === "--learner-model") args.learnerModel = next();
    else if (key === "--judge-model") args.judgeModel = next();
    else if (key === "--learner-base") args.learnerBase = next();
    else if (key === "--learner-key") args.learnerKey = next();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (args.resume && args.out) throw new Error("--resume and --out cannot be used together");
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
    // Flags or process environment may provide the judge configuration.
  }
  return env;
}

const bareModelId = (id) => id.replace(/\[[^\]]*\]\s*$/, "").trim() || id;

async function readBuildIdentity() {
  try {
    return JSON.parse(await fs.readFile(path.join(repo, "apps/server/dist/build-info.json"), "utf8"));
  } catch {
    return { version: "unknown", gitSha: "unknown", gitDirty: null };
  }
}

async function writeAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}

function orderedGradings(gradings, answerIds) {
  const order = new Map(answerIds.map((answerId, index) => [answerId, index]));
  return [...gradings].sort(
    (left, right) =>
      (order.get(left.answerId ?? left.itemId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.answerId ?? right.itemId) ?? Number.MAX_SAFE_INTEGER) || left.repeat - right.repeat
  );
}

function renderReport(result) {
  const { summary, gate } = result;
  const status = (pass) => (pass ? "PASS" : "FAIL");
  const disagreements = summary.itemResults.filter(
    (item) => !item.complete || !item.verdictAgreement || !item.exactConceptAgreement
  );
  const rows = disagreements.length
    ? disagreements
        .map(
          (item) =>
            `| \`${item.answerId}\` | ${item.formatParsed ? "yes" : "no"} | ${item.complete ? "yes" : "no"} | ${item.verdictAgreement ? "yes" : "no"} | ${item.exactConceptAgreement ? "yes" : "no"} |`
        )
        .join("\n")
    : "| — | yes | yes | yes | yes |";
  return `# Post-test judge stability

> This experiment measures repeatability, not validity. Agreement across repeated model judgments does not show that either judgment is correct.

## Result

- Overall: **${status(gate.overallPass)}**
- Structured answers parsed: ${summary.formatParsedAnswers}/${summary.answerCount} (${status(gate.formatGate)}; requires all answers)
- Judge errors: ${summary.judgeErrors}/${summary.expectedGradings} (${status(gate.errorGate)}; requires 0 errors and a complete batch)
- Verdict agreement: ${summary.verdictAgreements}/${summary.itemCount} (${status(gate.verdictGate)}; requires at least ${gate.thresholds.minimumVerdictAgreements})
- Exact concept-set agreement: ${summary.exactConceptAgreements}/${summary.itemCount} (${status(gate.exactConceptGate)}; requires at least ${gate.thresholds.minimumExactConceptAgreements})
- Judge/regex second-opinion agreement: ${summary.regexAgreements}/${summary.regexComparable} successful comparable gradings (reported only; not a gate)
- Successful gradings that needed a larger-budget retry: ${summary.retriedGradings}
- Successful DeepSeek no-thinking recoveries: ${summary.noThinkingRecoveries}
- Credited concepts with valid evidence: ${summary.creditedConcepts - summary.invalidCreditedConcepts}/${summary.creditedConcepts} (${status(gate.evidenceGate)})
- Judge credit claims deterministically downgraded for invalid evidence/section: ${summary.downgradedConceptClaims}

## Instrument

- Input SHA-256: \`${result.input.sha256}\`
- Git SHA: \`${result.protocol.gitSha}\`${result.protocol.gitDirty ? " (dirty checkout)" : ""}
- Build SHA: \`${result.protocol.buildIdentity.gitSha}\`${result.protocol.buildIdentity.gitDirty ? " (dirty build)" : ""}
- Item-bank SHA-256: \`${result.protocol.itemBankSha256}\`
- Judge-prompt SHA-256: \`${result.protocol.judgePromptSha256}\`
- Judge retry policy: \`${result.protocol.judgeRetryPolicy}\`
- Answer format: \`${result.protocol.answerFormat}\`
- Judge contract: \`${result.protocol.judgeContractVersion}\`
- Judge model: \`${result.config.judgeModel}\`
- Provider endpoint: \`${result.config.learnerBase}\`

## Incomplete or unstable items

| Answer | Format parsed | Complete | Verdict agrees | Exact concepts agree |
| --- | --- | --- | --- | --- |
${rows}
`;
}

async function runPool(tasks, concurrency, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= tasks.length) return;
        await worker(tasks[index]);
      }
    })
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const inputFile = path.resolve(repo, args.input);
  const inputBytes = await fs.readFile(inputFile);
  const payload = JSON.parse(inputBytes.toString("utf8"));
  const expectedAnswers =
    args.expectedAnswers ??
    payload.expectedAnswers ??
    (payload.schemaVersion === "learning-posttest-holdout/v1" ? EXPECTED_HOLDOUT_ANSWERS : EXPECTED_ARCHIVED_ANSWERS);
  const answers = discoverPostTestAnswers(payload, expectedAnswers);
  validateHoldoutManifest(payload, answers);
  const answerIds = answers.map((answer) => answer.answerId);
  const answerFormat = answers[0]?.answerFormat;
  if (answerFormat !== ANSWER_FORMAT_STRUCTURED) {
    throw new Error(`${ANSWER_FORMAT_LEGACY} inputs are read-only; use their existing stability report`);
  }
  if (payload.judgeContractVersion && payload.judgeContractVersion !== JUDGE_CONTRACT_VERSION) {
    throw new Error(`Input judge contract ${payload.judgeContractVersion} does not match ${JUDGE_CONTRACT_VERSION}`);
  }
  const itemIds = [...new Set(answers.map((answer) => answer.itemId))];
  const items = await loadItems({ items: itemIds });
  const itemById = new Map(items.map((item) => [item.id, item]));
  const missingItems = itemIds.filter((itemId) => !itemById.has(itemId));
  if (missingItems.length) throw new Error(`Archived answers reference unknown items: ${missingItems.join(", ")}`);

  const env = { ...process.env, ...(await loadEnvFile(path.join(repo, ".env"))) };
  const configuredModel =
    args.learnerModel ??
    env.LEARNER_MODEL ??
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    env.ANTHROPIC_MODEL ??
    "claude-haiku-4-5-20251001";
  const cfg = {
    learnerBase: (
      args.learnerBase ??
      env.LEARNER_ANTHROPIC_BASE_URL ??
      env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com"
    ).replace(/\/$/, ""),
    learnerKey:
      args.learnerKey ?? env.LEARNER_ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "",
    judgeModel: bareModelId(args.judgeModel ?? configuredModel)
  };
  if (!cfg.learnerKey) throw new Error("No judge credential: set ANTHROPIC_AUTH_TOKEN/--learner-key");

  const input = {
    path: path.relative(repo, inputFile),
    sha256: sha256(inputBytes),
    recordCount: answers.length
  };
  const protocol = await buildEvalProvenance(itemIds, {
    answerFormat,
    judgeContractVersion: JUDGE_CONTRACT_VERSION
  });
  protocol.fixtureManifestSha256 = input.sha256;
  if (protocol.gitDirty) throw new Error("Refusing to grade from a dirty checkout");
  const buildVerification = verifyServerBuild(protocol, await readBuildIdentity());
  protocol.buildIdentity = buildVerification.serverBuild;
  protocol.buildIdentityVerified = buildVerification.serverBuildVerified;
  const redactedConfig = {
    learnerBase: cfg.learnerBase,
    judgeModel: cfg.judgeModel,
    learnerKey: "[redacted]"
  };
  const thresholds = {
    minimumVerdictAgreements: args.minimumVerdictAgreements ?? answers.length,
    minimumExactConceptAgreements: args.minimumExactConceptAgreements ?? Math.max(1, answers.length - 1)
  };
  if (
    thresholds.minimumVerdictAgreements > answers.length ||
    thresholds.minimumExactConceptAgreements > answers.length
  ) {
    throw new Error("Stability agreement thresholds cannot exceed the answer count");
  }
  let result;
  let resultsFile;
  if (args.resume) {
    resultsFile = path.resolve(repo, args.resume);
    result = JSON.parse(await fs.readFile(resultsFile, "utf8"));
    validateResume(result, { input, repeats: args.repeats, protocol, config: redactedConfig, thresholds });
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = args.out
      ? path.resolve(repo, args.out)
      : path.join(repo, "data/eval-runs", `posttest-stability-${timestamp}`);
    await fs.mkdir(outDir, { recursive: true });
    resultsFile = path.join(outDir, "results.json");
    result = {
      startedAt: new Date().toISOString(),
      input,
      protocol,
      config: redactedConfig,
      repeats: args.repeats,
      concurrency: args.concurrency,
      thresholds,
      gradings: []
    };
  }

  const pending = planPendingGradings(answers, result.gradings ?? [], args.repeats);
  console.log(
    `Post-test stability: ${pending.length} pending of ${answers.length * args.repeats} gradings · concurrency=${args.concurrency}`
  );
  let checkpoint = Promise.resolve();
  await runPool(pending, args.concurrency, async (task) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let grading;
    try {
      const judged = await gradeAnswer(cfg, itemById.get(task.itemId), task.answer, {
        answerFormat: task.answerFormat
      });
      grading = {
        answerId: task.answerId,
        itemId: task.itemId,
        variant: task.variant,
        repeat: task.repeat,
        answerSha256: sha256(task.answer),
        startedAt,
        durationMs: Date.now() - started,
        formatParsed: true,
        error: null,
        verdict: judged.verdict,
        matched: judged.matched,
        coverage: judged.coverage,
        reasons: judged.reasons,
        concepts: judged.concepts,
        judgeAttempts: judged.judgeAttempts,
        judgeAttemptUsed: judged.judgeAttemptUsed,
        regexMatched: judged.regexMatched,
        regexCoverage: judged.regexCoverage,
        agreed: judged.agreed
      };
    } catch (error) {
      const formatParsed = error?.measurementCategory !== "post_test_format_error";
      const regex = formatParsed ? gradeRegex(itemById.get(task.itemId), task.answer) : null;
      grading = {
        answerId: task.answerId,
        itemId: task.itemId,
        variant: task.variant,
        repeat: task.repeat,
        answerSha256: sha256(task.answer),
        startedAt,
        durationMs: Date.now() - started,
        formatParsed,
        errorCategory: error?.measurementCategory ?? error?.judgeCategory ?? null,
        error: String(error?.message ?? error),
        verdict: null,
        matched: [],
        coverage: null,
        reasons: {},
        concepts: [],
        judgeAttempts: error?.judgeAttempts ?? [],
        judgeAttemptUsed: null,
        regexMatched: regex?.matched ?? [],
        regexCoverage: regex?.coverage ?? null,
        agreed: null
      };
    }
    result.gradings.push(grading);
    checkpoint = checkpoint.then(async () => {
      result.gradings = orderedGradings(result.gradings, answerIds);
      result.summary = summarizeStability(result.gradings, answerIds, args.repeats);
      result.gate = evaluateStabilityGate(result.summary, thresholds);
      await writeAtomic(resultsFile, result);
    });
    await checkpoint;
    console.log(
      `  ${task.answerId} repeat ${task.repeat}: ${grading.error ? `ERROR ${grading.error}` : grading.verdict}`
    );
  });

  await checkpoint;
  result.completedAt = new Date().toISOString();
  result.gradings = orderedGradings(result.gradings, answerIds);
  result.summary = summarizeStability(result.gradings, answerIds, args.repeats);
  result.gate = evaluateStabilityGate(result.summary, thresholds);
  await writeAtomic(resultsFile, result);
  await fs.writeFile(path.join(path.dirname(resultsFile), "report.md"), renderReport(result));
  console.log(`Wrote ${path.relative(repo, resultsFile)} and report.md · ${result.gate.overallPass ? "PASS" : "FAIL"}`);
}

export {
  discoverPostTestAnswers,
  planPendingGradings,
  summarizeStability,
  evaluateStabilityGate,
  validateResume,
  validateHoldoutManifest,
  renderReport
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`learning-posttest-stability failed: ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
