#!/usr/bin/env node
/**
 * Re-grade the archived post-test answers twice to measure judge stability.
 * Stability is repeatability, not evidence that either repeated judgment is correct.
 *
 *   node scripts/learning-posttest-stability.mjs
 *     [--input data/eval-runs/<run>/results.json] [--out data/eval-runs/<dir>]
 *     [--repeats 2] [--concurrency 4] [--judge-model <id>]
 *   node scripts/learning-posttest-stability.mjs --resume <results.json>
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvalProvenance, gradeAnswer, gradeRegex, loadItems, verifyServerBuild } from "./learning-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const DEFAULT_INPUT = "data/eval-runs/2026-08-27T19-54-00-687Z/results.json";
const DEFAULT_REPEATS = 2;
const DEFAULT_CONCURRENCY = 4;
const EXPECTED_ITEMS = 27;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gradingKey = (itemId, repeat) => `${itemId}\0${repeat}`;
const sortedConcepts = (matched) => [...(matched ?? [])].sort();

function discoverPostTestAnswers(payload, expectedCount = EXPECTED_ITEMS) {
  const records = Array.isArray(payload) ? payload : payload?.records;
  if (!Array.isArray(records)) throw new Error("Input must contain a records array");
  if (records.length !== expectedCount)
    throw new Error(`Expected exactly ${expectedCount} records; found ${records.length}`);

  const answers = records
    .filter((record) => typeof record?.finalPostTestAnswer === "string" && record.finalPostTestAnswer.trim())
    .map((record) => ({ itemId: String(record.itemId ?? ""), answer: record.finalPostTestAnswer }));
  if (answers.length !== expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} nonempty final post-test answers; found ${answers.length}`);
  }
  if (answers.some((answer) => !answer.itemId)) throw new Error("Every post-test answer must have an itemId");

  const unique = new Set(answers.map((answer) => answer.itemId));
  if (unique.size !== answers.length) throw new Error("Post-test answer itemIds must be unique");
  return answers;
}

function planPendingGradings(answers, completedGradings = [], repeats = DEFAULT_REPEATS) {
  const itemIds = new Set(answers.map((answer) => answer.itemId));
  const completed = new Set();
  for (const grading of completedGradings) {
    if (!itemIds.has(grading.itemId)) throw new Error(`Resume contains unknown itemId: ${grading.itemId}`);
    if (!Number.isInteger(grading.repeat) || grading.repeat < 1 || grading.repeat > repeats) {
      throw new Error(`Resume contains invalid repeat for ${grading.itemId}: ${grading.repeat}`);
    }
    const key = gradingKey(grading.itemId, grading.repeat);
    if (completed.has(key))
      throw new Error(`Resume contains duplicate grading: ${grading.itemId} repeat ${grading.repeat}`);
    completed.add(key);
  }
  return answers.flatMap((answer) =>
    Array.from({ length: repeats }, (_, index) => ({ ...answer, repeat: index + 1 })).filter(
      (grading) => !completed.has(gradingKey(grading.itemId, grading.repeat))
    )
  );
}

function summarizeStability(gradings, itemIds, repeats = DEFAULT_REPEATS) {
  const byItem = new Map(itemIds.map((itemId) => [itemId, []]));
  for (const grading of gradings) {
    if (byItem.has(grading.itemId)) byItem.get(grading.itemId).push(grading);
  }

  let verdictAgreements = 0;
  let exactConceptAgreements = 0;
  let completeItems = 0;
  const itemResults = [];
  for (const itemId of itemIds) {
    const entries = byItem.get(itemId).sort((a, b) => a.repeat - b.repeat);
    const successful = entries.filter((entry) => !entry.error);
    const complete = entries.length === repeats && successful.length === repeats;
    const verdictAgreement = complete && new Set(successful.map((entry) => entry.verdict)).size === 1;
    const conceptSignatures = successful.map((entry) => JSON.stringify(sortedConcepts(entry.matched)));
    const exactConceptAgreement = complete && new Set(conceptSignatures).size === 1;
    if (complete) completeItems += 1;
    if (verdictAgreement) verdictAgreements += 1;
    if (exactConceptAgreement) exactConceptAgreements += 1;
    itemResults.push({
      itemId,
      complete,
      verdictAgreement,
      exactConceptAgreement,
      verdicts: entries.map((entry) => entry.verdict ?? null),
      matched: entries.map((entry) => sortedConcepts(entry.matched)),
      errors: entries.map((entry) => entry.error ?? null)
    });
  }

  const successful = gradings.filter((grading) => !grading.error);
  const regexComparable = successful.filter((grading) => typeof grading.agreed === "boolean");
  return {
    itemCount: itemIds.length,
    repeats,
    expectedGradings: itemIds.length * repeats,
    completedGradings: gradings.length,
    successfulGradings: successful.length,
    judgeErrors: gradings.filter((grading) => grading.error).length,
    completeItems,
    verdictAgreements,
    exactConceptAgreements,
    regexAgreements: regexComparable.filter((grading) => grading.agreed).length,
    regexComparable: regexComparable.length,
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
  return {
    thresholds: { minimumVerdictAgreements, minimumExactConceptAgreements },
    errorGate,
    verdictGate,
    exactConceptGate,
    overallPass: errorGate && verdictGate && exactConceptGate
  };
}

function validateResume(result, { input, repeats, protocol, config }) {
  if (result.input?.sha256 !== input.sha256) throw new Error("Resume input SHA-256 does not match the current input");
  if (result.repeats !== repeats) throw new Error("Resume repeat count does not match --repeats");
  if (result.protocol?.fingerprint !== protocol.fingerprint) {
    throw new Error("Resume protocol fingerprint does not match the current checkout and item bank");
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

function orderedGradings(gradings, itemIds) {
  const order = new Map(itemIds.map((itemId, index) => [itemId, index]));
  return [...gradings].sort(
    (left, right) =>
      (order.get(left.itemId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.itemId) ?? Number.MAX_SAFE_INTEGER) ||
      left.repeat - right.repeat
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
            `| \`${item.itemId}\` | ${item.complete ? "yes" : "no"} | ${item.verdictAgreement ? "yes" : "no"} | ${item.exactConceptAgreement ? "yes" : "no"} |`
        )
        .join("\n")
    : "| — | yes | yes | yes |";
  return `# Post-test judge stability

> This experiment measures repeatability, not validity. Agreement across repeated model judgments does not show that either judgment is correct.

## Result

- Overall: **${status(gate.overallPass)}**
- Judge errors: ${summary.judgeErrors}/${summary.expectedGradings} (${status(gate.errorGate)}; requires 0 errors and a complete batch)
- Verdict agreement: ${summary.verdictAgreements}/${summary.itemCount} (${status(gate.verdictGate)}; requires at least ${gate.thresholds.minimumVerdictAgreements})
- Exact concept-set agreement: ${summary.exactConceptAgreements}/${summary.itemCount} (${status(gate.exactConceptGate)}; requires at least ${gate.thresholds.minimumExactConceptAgreements})
- Judge/regex second-opinion agreement: ${summary.regexAgreements}/${summary.regexComparable} successful comparable gradings (reported only; not a gate)

## Instrument

- Input SHA-256: \`${result.input.sha256}\`
- Git SHA: \`${result.protocol.gitSha}\`${result.protocol.gitDirty ? " (dirty checkout)" : ""}
- Build SHA: \`${result.protocol.buildIdentity.gitSha}\`${result.protocol.buildIdentity.gitDirty ? " (dirty build)" : ""}
- Item-bank SHA-256: \`${result.protocol.itemBankSha256}\`
- Judge-prompt SHA-256: \`${result.protocol.judgePromptSha256}\`
- Judge model: \`${result.config.judgeModel}\`
- Provider endpoint: \`${result.config.learnerBase}\`

## Incomplete or unstable items

| Item | Complete | Verdict agrees | Exact concepts agree |
| --- | --- | --- | --- |
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
  const answers = discoverPostTestAnswers(JSON.parse(inputBytes.toString("utf8")));
  const itemIds = answers.map((answer) => answer.itemId);
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
  const protocol = await buildEvalProvenance(itemIds);
  if (protocol.gitDirty) throw new Error("Refusing to grade from a dirty checkout");
  const buildVerification = verifyServerBuild(protocol, await readBuildIdentity());
  protocol.buildIdentity = buildVerification.serverBuild;
  protocol.buildIdentityVerified = buildVerification.serverBuildVerified;
  const redactedConfig = {
    learnerBase: cfg.learnerBase,
    judgeModel: cfg.judgeModel,
    learnerKey: "[redacted]"
  };
  let result;
  let resultsFile;
  if (args.resume) {
    resultsFile = path.resolve(repo, args.resume);
    result = JSON.parse(await fs.readFile(resultsFile, "utf8"));
    validateResume(result, { input, repeats: args.repeats, protocol, config: redactedConfig });
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
      const judged = await gradeAnswer(cfg, itemById.get(task.itemId), task.answer);
      grading = {
        itemId: task.itemId,
        repeat: task.repeat,
        startedAt,
        durationMs: Date.now() - started,
        error: null,
        verdict: judged.verdict,
        matched: judged.matched,
        coverage: judged.coverage,
        reasons: judged.reasons,
        regexMatched: judged.regexMatched,
        regexCoverage: judged.regexCoverage,
        agreed: judged.agreed
      };
    } catch (error) {
      const regex = gradeRegex(itemById.get(task.itemId), task.answer);
      grading = {
        itemId: task.itemId,
        repeat: task.repeat,
        startedAt,
        durationMs: Date.now() - started,
        error: String(error?.message ?? error),
        verdict: null,
        matched: [],
        coverage: null,
        reasons: {},
        regexMatched: regex.matched,
        regexCoverage: regex.coverage,
        agreed: null
      };
    }
    result.gradings.push(grading);
    checkpoint = checkpoint.then(async () => {
      result.gradings = orderedGradings(result.gradings, itemIds);
      result.summary = summarizeStability(result.gradings, itemIds, args.repeats);
      result.gate = evaluateStabilityGate(result.summary);
      await writeAtomic(resultsFile, result);
    });
    await checkpoint;
    console.log(
      `  ${task.itemId} repeat ${task.repeat}: ${grading.error ? `ERROR ${grading.error}` : grading.verdict}`
    );
  });

  await checkpoint;
  result.completedAt = new Date().toISOString();
  result.gradings = orderedGradings(result.gradings, itemIds);
  result.summary = summarizeStability(result.gradings, itemIds, args.repeats);
  result.gate = evaluateStabilityGate(result.summary);
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
  renderReport
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`learning-posttest-stability failed: ${error.message ?? error}`);
    process.exitCode = 1;
  });
}
