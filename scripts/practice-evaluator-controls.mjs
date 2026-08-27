#!/usr/bin/env node
/**
 * Adversarial controls for the practice-item evaluator (tier 3).
 *
 * In production the evaluator has never rejected anything, and the deterministic gates have
 * never fired, so an approval is indistinguishable from a check that silently failed open.
 * This runs deliberately flawed drafts — each labelled with the gate and check that should
 * stop it — through the real judge and reports whether it catches them.
 *
 * It measures the evaluator's DISCRIMINATIVE POWER on manufactured cases. It is not an
 * inter-rater result and does not license "the evaluator's judgments are trustworthy" —
 * that claim needs human labels (scripts/practice-item-calibration.mjs).
 *
 *   node scripts/practice-evaluator-controls.mjs
 *     [--only <id,id>]        # run a subset by fixture id
 *     [--model <name>]        # override the judged model (default: what the server would use)
 *     [--base <url>]          # override the API base
 *     [--key <token>]
 *     [--concurrency 4]
 *     [--out data/eval-runs/practice-evaluator-controls.md]
 *
 * Fidelity note: the judged model defaults to the one the SERVER resolves for background
 * calls — local_settings.runtime.config first (the UI writes a provider override there),
 * then .env. Judging with a different model measures an evaluator nobody runs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_DIR = path.join(repo, "apps/server/eval/practice-controls");
const CHECKS = ["correctness", "fitToHypothesis", "difficulty", "novelty"];

function parseArgs(argv) {
  const args = { concurrency: 4, out: "data/eval-runs/practice-evaluator-controls.md" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (key === "only") args.only = new Set(value.split(",").map((item) => item.trim()));
    else if (key === "concurrency") args.concurrency = Number(value);
    else args[key] = value;
    i += 1;
  }
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
    /* no .env is fine; flags or process env must cover it */
  }
  return env;
}

/**
 * Resolve the model the server would actually use for a background call. The UI writes a
 * provider override into local_settings, and `backgroundModelName` reads it before the
 * environment — so a harness that only consults .env can silently judge with a different
 * model than the one under test.
 */
function serverBackgroundModel(env) {
  const fallback = {
    model: env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "sonnet",
    base: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    key: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "",
    source: ".env"
  };
  try {
    const require = createRequire(path.join(repo, "apps/server/package.json"));
    const Database = require("better-sqlite3");
    const database = new Database(path.join(repo, "data/agent.db"), { readonly: true });
    const row = database.prepare("SELECT value_json FROM local_settings WHERE key = 'runtime.config'").get();
    database.close();
    if (!row) return fallback;
    const settings = JSON.parse(row.value_json);
    const mapped = settings.modelMappings?.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME?.trim();
    return {
      model: mapped || settings.model || fallback.model,
      base: settings.baseUrl || fallback.base,
      key: settings.authToken || fallback.key,
      source: "local_settings.runtime.config"
    };
  } catch {
    return fallback;
  }
}

async function loadFixtures(only) {
  const files = (await fs.readdir(CONTROL_DIR)).filter((name) => name.endsWith(".json")).sort();
  const fixtures = [];
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(path.join(CONTROL_DIR, file), "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array of fixtures`);
    for (const fixture of parsed) {
      for (const field of ["id", "expectedGate", "why", "draft"]) {
        if (!fixture[field]) throw new Error(`Fixture ${fixture.id ?? "?"} is missing ${field}`);
      }
      fixtures.push({ ...fixture, file });
    }
  }
  const ids = new Set(fixtures.map((item) => item.id));
  if (ids.size !== fixtures.length) throw new Error("Duplicate control fixture ids");
  // Only fixtures that survive the deterministic gates ever reach the judge in production;
  // the rest are asserted offline in apps/server/test/practice-controls.test.ts.
  return fixtures.filter((item) => {
    if (only && !only.has(item.id)) return false;
    // `judge: false` marks a fixture that probes deterministic arithmetic and is not a
    // well-formed task — asking the model to approve it would score the label, not the judge.
    if (item.judge === false) return false;
    return item.expectedGate === "evaluator" || item.expectedGate === "none";
  });
}

async function judge(fixture, cfg, evaluator) {
  const request = evaluator.buildPracticeEvaluatorRequest({
    draft: fixture.draft,
    hypothesis: fixture.hypothesis ?? fixture.draft.targetHypothesis,
    goal: fixture.goal ?? "",
    corpus: fixture.corpus ?? []
  });
  // Reasoning models spend output tokens thinking before any text arrives, so the budget is
  // loose and one retry doubles it — same convention as the other harnesses.
  for (const maxTokens of [4_000, 8_000]) {
    const response = await fetch(`${cfg.base.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.key,
        authorization: `Bearer ${cfg.key}`,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0,
        system: `${request.systemPrompt}\n\nReply with JSON only, matching this schema: ${JSON.stringify(request.schema)}`,
        messages: [{ role: "user", content: request.prompt }]
      })
    });
    if (!response.ok) throw new Error(`Judge call failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) continue;
    try {
      return evaluator.parsePracticeEvaluatorVerdict(JSON.parse(match[0]));
    } catch {
      /* malformed JSON: fall through to the larger budget */
    }
  }
  return { status: "error", reasons: ["judge returned no parseable verdict"] };
}

async function runAll(fixtures, cfg, evaluator, concurrency) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < fixtures.length) {
      const fixture = fixtures[cursor++];
      const deterministic = evaluator.programmaticPracticeGate(fixture.draft);
      const novelty = evaluator.noveltyScore(fixture.draft.taskText, fixture.corpus ?? []);
      let verdict;
      try {
        verdict = await judge(fixture, cfg, evaluator);
      } catch (error) {
        verdict = { status: "error", reasons: [String(error?.message ?? error)] };
      }
      results.push({
        id: fixture.id,
        expectedGate: fixture.expectedGate,
        expectedCheck: fixture.expectedCheck ?? null,
        why: fixture.why,
        judgeOnly: Boolean(fixture.judgeOnly),
        deterministicWouldCatch: deterministic.length > 0 || novelty > evaluator.PRACTICE_NOVELTY_THRESHOLD,
        noveltyScore: novelty,
        verdict
      });
      process.stderr.write(`  judged ${fixture.id}: ${verdict.status}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, fixtures.length)) }, worker));
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

/** Cohen's kappa over decisive pairs, "fail" as the positive class — same contract as the calibration report. */
function binaryAgreement(pairs) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let exact = 0;
  let unsureEither = 0;
  for (const [machine, expected] of pairs) {
    if (machine === expected) exact += 1;
    if (machine === "unsure" || expected === "unsure") {
      unsureEither += 1;
      continue;
    }
    if (machine === "fail" && expected === "fail") tp += 1;
    else if (machine === "fail" && expected === "pass") fp += 1;
    else if (machine === "pass" && expected === "fail") fn += 1;
    else tn += 1;
  }
  const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
  const decisive = tp + fp + fn + tn;
  const observed = rate(tp + tn, decisive);
  const chance = decisive === 0 ? null : ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (decisive * decisive);
  return {
    n: pairs.length,
    exactAgreement: rate(exact, pairs.length),
    unsureEither,
    precision: rate(tp, tp + fp),
    recall: rate(tp, tp + fn),
    kappa: chance === null || chance === 1 ? null : (observed - chance) / (1 - chance),
    decisive,
    tp,
    fp,
    fn,
    tn
  };
}

const percent = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);
const fixed = (value) => (value === null || value === undefined ? "n/a" : value.toFixed(2));

function renderReport(results, cfg, isIncoherent) {
  const judged = results.filter((row) => row.verdict.status !== "error");
  const failOpen = results.filter((row) => row.verdict.status === "error");
  const negatives = results.filter((row) => row.expectedGate === "evaluator");
  const positives = results.filter((row) => row.expectedGate === "none");
  const caughtNegatives = negatives.filter((row) => row.verdict.status === "rejected");
  const falseRejects = positives.filter((row) => row.verdict.status === "rejected");
  const incoherent = judged.filter((row) => isIncoherent(row.verdict));

  const perCheck = CHECKS.map((check) => {
    const pairs = judged
      .filter((row) => row.expectedGate === "evaluator" || row.expectedGate === "none")
      .map((row) => [row.verdict.checks[check], row.expectedCheck === check ? "fail" : "pass"]);
    return { check, stats: binaryAgreement(pairs) };
  });

  const lines = [];
  lines.push("# Practice-evaluator adversarial controls");
  lines.push("");
  lines.push(
    "Deliberately flawed drafts, each labelled with the check that should reject it, judged by the model the server uses for background calls. This measures whether the evaluator **can** reject — not whether its judgments agree with a human's. An inter-rater number still requires human labels (`scripts/practice-item-calibration.mjs`)."
  );
  lines.push("");
  lines.push(`- Judged model: \`${cfg.model}\` via \`${cfg.base}\` (resolved from ${cfg.source})`);
  lines.push(
    `- Fixtures judged: ${results.length} (${negatives.length} should reject, ${positives.length} should approve)`
  );
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(`- Flawed drafts rejected: **${caughtNegatives.length}/${negatives.length}**`);
  lines.push(`- Good drafts wrongly rejected: **${falseRejects.length}/${positives.length}**`);
  lines.push(
    `- Verdicts that approved while failing a check (incoherent — only \`approved\` is load-bearing in production): **${incoherent.length}**`
  );
  lines.push(`- Fail-opens (judge produced no verdict; the pipeline would approve these): **${failOpen.length}**`);
  lines.push("");
  lines.push("## Per-check agreement with the intended defect");
  lines.push("");
  lines.push('"fail" is the positive class. The expected column is the fixture label, not a human judgment.');
  lines.push("");
  lines.push("| check | pairs | exact | κ | fail-precision | fail-recall | unsure |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const { check, stats } of perCheck) {
    lines.push(
      `| ${check} | ${stats.decisive} | ${percent(stats.exactAgreement)} | ${fixed(stats.kappa)} | ${percent(stats.precision)} (${stats.tp}/${stats.tp + stats.fp}) | ${percent(stats.recall)} (${stats.tp}/${stats.tp + stats.fn}) | ${stats.unsureEither} |`
    );
  }
  lines.push("");
  lines.push("## Every fixture");
  lines.push("");
  lines.push("| fixture | expected | verdict | checks failed | notes |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of results) {
    const failed =
      row.verdict.status === "error"
        ? "—"
        : CHECKS.filter((check) => row.verdict.checks[check] === "fail").join(", ") || "none";
    const notes = [];
    if (row.judgeOnly) notes.push("judge-only (deterministic gate would catch it first by design)");
    else if (row.deterministicWouldCatch) notes.push("⚠ a deterministic gate would catch this first");
    if (row.verdict.status !== "error" && isIncoherent(row.verdict)) notes.push("⚠ approved with a failed check");
    if (row.verdict.status === "error") notes.push(row.verdict.reasons[0] ?? "no verdict");
    lines.push(
      `| \`${row.id}\` | ${row.expectedGate === "none" ? "approve" : `reject (${row.expectedCheck ?? "any"})`} | ${row.verdict.status} | ${failed} | ${notes.join("; ") || ""} |`
    );
  }
  lines.push("");
  lines.push("## Misses");
  lines.push("");
  const misses = negatives.filter((row) => row.verdict.status !== "rejected");
  if (misses.length === 0) lines.push("- none: every flawed draft was rejected.");
  for (const row of misses) {
    lines.push(`- **${row.id}** (should fail \`${row.expectedCheck}\`) — ${row.why}`);
  }
  if (falseRejects.length > 0) {
    lines.push("");
    lines.push("## False rejections");
    lines.push("");
    for (const row of falseRejects) {
      lines.push(`- **${row.id}** — ${row.verdict.reasons.join(" ") || "no reason given"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const env = { ...process.env, ...(await loadEnvFile(path.join(repo, ".env"))) };
  const resolved = serverBackgroundModel(env);
  const cfg = {
    model: args.model ?? resolved.model,
    base: args.base ?? resolved.base,
    key: args.key ?? resolved.key,
    source: args.model || args.base ? "command line" : resolved.source
  };
  if (!cfg.key) throw new Error("No API credential: set ANTHROPIC_AUTH_TOKEN in .env or pass --key");

  const require = createRequire(path.join(repo, "apps/server/package.json"));
  const evaluatorPath = path.join(repo, "apps/server/dist/practice-evaluator.js");
  try {
    await fs.access(evaluatorPath);
  } catch {
    throw new Error("apps/server/dist not built — run `pnpm --filter @fieldnote/server build` first");
  }
  const evaluator = await import(evaluatorPath);
  void require;

  const fixtures = await loadFixtures(args.only);
  if (fixtures.length === 0) throw new Error("No control fixtures matched the filter");
  process.stderr.write(`Judging ${fixtures.length} fixtures with ${cfg.model} (${cfg.source})\n`);

  const results = await runAll(fixtures, cfg, evaluator, args.concurrency);
  const report = renderReport(results, cfg, evaluator.verdictIsIncoherent);
  const outPath = path.resolve(repo, args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, report, "utf8");
  await fs.writeFile(
    outPath.replace(/\.md$/, ".json"),
    JSON.stringify({ config: { ...cfg, key: "[redacted]" }, results }, null, 2),
    "utf8"
  );
  process.stderr.write(`\nReport: ${path.relative(repo, outPath)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
