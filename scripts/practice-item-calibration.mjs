#!/usr/bin/env node
/**
 * Calibration protocol for in-loop practice generation: exports a labeling sheet of
 * learning_practice_items and, once the human columns are filled, computes an
 * evaluator-versus-human agreement report (per-check precision/recall on "fail",
 * plus a disagreement typology).
 *
 * The numbers describe agreement between the LLM evaluator and a human labeler on
 * item quality — they are NOT learning-outcome evidence, and the self-labeled run is
 * a protocol smoke test, not an inter-rater result (the labeler column says which).
 *
 *   node scripts/practice-item-calibration.mjs export
 *     [--base http://127.0.0.1:8787 | --input export.json]
 *     [--out data/eval-runs/practice-calibration-sample.csv] [--sample N] [--seed S]
 *     [--dataset live,eval]   # keep only items from these datasetKinds (default: all;
 *                             # the real protocol labels live/eval items — demo items are
 *                             # fixture noise). Sampling reproduces from (seed, filtered
 *                             # item order), so the same filter must be repeated.
 *
 *   node scripts/practice-item-calibration.mjs report --labels <filled.csv>
 *     [--labeler self] [--out data/eval-runs/practice-calibration.md]
 *
 * Label vocabulary (leave blank to skip a row): per-check columns take
 * pass | fail | unsure; human_overall takes approve | reject.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CHECKS = ["correctness", "fitToHypothesis", "difficulty", "novelty"];

function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:8787",
    seed: 1,
    labeler: "self"
  };
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (key === "--base") args.base = next();
    else if (key === "--input") args.input = next();
    else if (key === "--out") args.out = next();
    else if (key === "--labels") args.labels = next();
    else if (key === "--labeler") args.labeler = next();
    else if (key === "--sample") args.sample = Number(next());
    else if (key === "--seed") args.seed = Number(next());
    else if (key === "--dataset") args.dataset = next();
    else positional.push(key);
  }
  args.command = positional[0];
  return args;
}

// Same PRNG family as the server's condition randomization, so a sample is
// reproducible from (seed, item order) alone.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadExport(args) {
  if (args.input) return JSON.parse(await fs.readFile(args.input, "utf8"));
  const response = await fetch(`${args.base}/api/learning/export`);
  if (!response.ok) throw new Error(`export endpoint returned ${response.status} — is the server running?`);
  return response.json();
}

/**
 * itemId-independent labeling context: which arm and dataset each item's session ran
 * under. Demo items are fixture noise for the real protocol, and a labeler cannot judge
 * "fit to the study" without seeing the arm — so both ride along as sheet columns.
 */
function sessionLookup(parsed) {
  const sessions = new Map((parsed.sessions ?? []).map((session) => [session.id, session]));
  const byIncident = new Map();
  for (const incident of parsed.incidents ?? []) {
    const session = sessions.get(incident.sessionId);
    if (session)
      byIncident.set(incident.id, { datasetKind: session.datasetKind ?? "", condition: session.condition ?? "" });
  }
  return byIncident;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Minimal RFC4180 reader: quoted cells may contain commas, quotes, and newlines. Lenient
 * where spreadsheets are (a stray quote mid-cell — 35" wide — is literal text, and
 * Excel's UTF-8 BOM is stripped), strict where silence would corrupt the metrics: an
 * unterminated cell-opening quote would swallow every following row into one cell, so it
 * errors instead.
 */
function parseCsv(text) {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      cellStarted = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      cellStarted = false;
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      cell += ch;
      cellStarted = true;
    }
  }
  if (quoted)
    throw new Error(
      `unterminated quote in the sheet (a cell opened with " and never closed) around row ${rows.length + 1} — fix that cell and rerun`
    );
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

const SHEET_COLUMNS = [
  "itemId",
  "incidentId",
  "round",
  "source",
  "datasetKind",
  "condition",
  "pipelineStatus",
  "gate",
  "noveltyScore",
  "difficulty",
  "method",
  "taskText",
  "targetHypothesis",
  "expectedAnswerSketch",
  ...CHECKS.map((check) => `evaluator_${check}`),
  "evaluator_status",
  ...CHECKS.map((check) => `human_${check}`),
  "human_overall",
  "human_notes"
];

async function runExport(args) {
  // The doc promises (--sample N --seed S)-reproducible samples; a NaN or negative value
  // would silently produce something else (slice(0,-5) drops instead of samples), so
  // malformed values error up front.
  if (args.sample !== undefined && (!Number.isInteger(args.sample) || args.sample <= 0))
    throw new Error(`--sample must be a positive integer, got "${args.sample}"`);
  if (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 0xffffffff)
    throw new Error(`--seed must be an integer in [0, 4294967295], got "${args.seed}"`);
  const parsed = await loadExport(args);
  const lookup = sessionLookup(parsed);
  let items = parsed.practiceItems ?? [];
  const sourceItems = items.length;
  const sourceSha256 = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  if (args.dataset) {
    const wanted = new Set(
      args.dataset
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean)
    );
    if (wanted.size === 0) throw new Error('--dataset needs at least one kind, e.g. "live" or "live,eval"');
    // A payload without session context cannot honor the filter; silence here would label
    // the wrong corpus, so it errors instead of exporting everything.
    if (lookup.size === 0 && items.length > 0)
      throw new Error("the export payload carries no sessions/incidents context — cannot filter by dataset");
    items = items.filter((item) => wanted.has(lookup.get(item.incidentId)?.datasetKind ?? ""));
  }
  const eligibleItems = items.length;
  if (args.sample && args.sample < items.length) {
    const rng = mulberry32(args.seed);
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    items = shuffled.slice(0, args.sample);
  }
  const lines = [SHEET_COLUMNS.join(",")];
  for (const item of items) {
    const verdict = item.evaluatorVerdict ?? null;
    const checks = verdict && typeof verdict === "object" ? (verdict.checks ?? {}) : {};
    const context = lookup.get(item.incidentId) ?? { datasetKind: "", condition: "" };
    lines.push(
      [
        item.id,
        item.incidentId,
        item.round,
        item.source,
        context.datasetKind,
        context.condition,
        item.status,
        item.gate,
        item.noveltyScore,
        item.difficulty,
        item.method,
        item.taskText,
        item.targetHypothesis,
        item.expectedAnswerSketch,
        ...CHECKS.map((check) => checks[check] ?? ""),
        verdict && typeof verdict === "object" ? (verdict.status ?? "") : "",
        ...CHECKS.map(() => ""),
        "",
        ""
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const out = args.out ?? "data/eval-runs/practice-calibration-sample.csv";
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${lines.join("\n")}\n`, "utf8");
  await fs.writeFile(
    `${out}.manifest.json`,
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        seed: args.seed,
        dataset: args.dataset ?? null,
        requestedSample: args.sample ?? null,
        sourceItems,
        eligibleItems,
        selectedItemIds: items.map((item) => item.id),
        sourcePracticeItemsSha256: sourceSha256
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(
    `wrote ${items.length}/${eligibleItems} eligible practice items to ${out} (${sourceItems} before filtering; seed ${args.seed}${
      args.dataset ? `, dataset ${args.dataset}` : ""
    }); manifest: ${out}.manifest.json. Fill the human_* columns with pass|fail|unsure and human_overall with approve|reject, then run the report command.`
  );
}

function normalizedLabel(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "" ? null : text;
}

function binaryAgreement(pairs) {
  // "fail" is the positive class: the evaluator's job is catching bad items.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let exact = 0;
  let unsureEither = 0;
  for (const [machine, human] of pairs) {
    if (machine === human) exact += 1;
    if (machine === "unsure" || human === "unsure") {
      unsureEither += 1;
      continue;
    }
    if (machine === "fail" && human === "fail") tp += 1;
    else if (machine === "fail" && human === "pass") fp += 1;
    else if (machine === "pass" && human === "fail") fn += 1;
    else tn += 1;
  }
  const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
  // Cohen's kappa over the decisive (non-unsure) pairs: raw agreement is inflated by
  // class imbalance — a corpus the human approves wholesale scores 100% agreement with
  // any evaluator — so the report must carry a chance-corrected number next to it.
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
    machineFails: tp + fp,
    humanFails: tp + fn,
    tp,
    fp,
    fn,
    tn
  };
}

const percent = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const clip = (text, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Every column the report actually reads; a sheet missing one errors instead of degrading. */
const REPORT_COLUMNS = [
  "itemId",
  "pipelineStatus",
  "gate",
  "taskText",
  "evaluator_status",
  ...CHECKS.map((check) => `evaluator_${check}`),
  ...CHECKS.map((check) => `human_${check}`),
  "human_overall",
  "human_notes"
];

async function runReport(args) {
  if (!args.labels) throw new Error("report requires --labels <filled.csv>");
  const rows = parseCsv(await fs.readFile(args.labels, "utf8"));
  const header = rows[0] ?? [];
  const index = new Map(header.map((name, position) => [name.trim(), position]));
  const missing = REPORT_COLUMNS.filter((name) => !index.has(name));
  if (missing.length > 0)
    throw new Error(`labels file is missing the column(s): ${missing.join(", ")} — re-export or restore them`);
  // A row with the wrong cell count means a hand-edit broke the CSV structure; every
  // metric downstream would be silently misaligned, so stop here.
  const badRows = [];
  rows.slice(1).forEach((row, position) => {
    if (row.length !== header.length) badRows.push(position + 2);
  });
  if (badRows.length > 0)
    throw new Error(
      `sheet row(s) ${badRows.join(", ")} have the wrong number of cells (expected ${header.length}) — usually a stray quote or comma from hand-editing`
    );
  const cell = (row, name) => row[index.get(name)] ?? "";

  // Strict label vocabulary: the adjacent evaluator_status column displays
  // "approved"/"rejected", so a labeler mirroring it would otherwise have every human
  // rejection silently counted as an approve and the whole report inverted.
  const labelErrors = [];
  rows.slice(1).forEach((row, position) => {
    const line = position + 2;
    const overall = normalizedLabel(cell(row, "human_overall"));
    if (overall && overall !== "approve" && overall !== "reject")
      labelErrors.push(`row ${line}: human_overall "${cell(row, "human_overall").trim()}" (use approve | reject)`);
    for (const check of CHECKS) {
      const value = normalizedLabel(cell(row, `human_${check}`));
      if (value && value !== "pass" && value !== "fail" && value !== "unsure")
        labelErrors.push(
          `row ${line}: human_${check} "${cell(row, `human_${check}`).trim()}" (use pass | fail | unsure)`
        );
    }
  });
  if (labelErrors.length > 0)
    throw new Error(`invalid labels — fix these cells and rerun:\n  ${labelErrors.join("\n  ")}`);

  const labeled = [];
  let unlabeled = 0;
  for (const row of rows.slice(1)) {
    const overall = normalizedLabel(cell(row, "human_overall"));
    if (!overall) {
      unlabeled += 1;
      continue;
    }
    labeled.push(row);
  }

  // Pipeline level: any-tier decision versus the human overall, all labeled rows.
  const pipelinePairs = labeled.map((row) => [
    normalizedLabel(cell(row, "pipelineStatus")) === "rejected" ? "fail" : "pass",
    normalizedLabel(cell(row, "human_overall")) === "reject" ? "fail" : "pass"
  ]);
  const pipeline = binaryAgreement(pipelinePairs);

  // Evaluator level: only rows where the LLM tier actually returned a verdict.
  const evaluatorRows = labeled.filter((row) => {
    const status = normalizedLabel(cell(row, "evaluator_status"));
    return status === "approved" || status === "rejected";
  });
  // Fail-opens are the evaluator tier silently not running (the first live run lost every
  // verdict to a timeout and nobody could see it); the report must carry the count.
  const failOpenRows = rows.slice(1).filter((row) => normalizedLabel(cell(row, "evaluator_status")) === "error");
  const evaluatorOverall = binaryAgreement(
    evaluatorRows.map((row) => [
      normalizedLabel(cell(row, "evaluator_status")) === "rejected" ? "fail" : "pass",
      normalizedLabel(cell(row, "human_overall")) === "reject" ? "fail" : "pass"
    ])
  );
  const perCheck = CHECKS.map((check) => {
    const pairs = [];
    for (const row of evaluatorRows) {
      const machine = normalizedLabel(cell(row, `evaluator_${check}`));
      const human = normalizedLabel(cell(row, `human_${check}`));
      if (machine && human) pairs.push([machine, human]);
    }
    return { check, ...binaryAgreement(pairs) };
  });

  // Disagreement typology, the actionable part of the report.
  const falseApproves = [];
  const falseRejects = [];
  for (const row of evaluatorRows) {
    const machine = normalizedLabel(cell(row, "evaluator_status"));
    const human = normalizedLabel(cell(row, "human_overall"));
    if (machine === "approved" && human === "reject") {
      const failedChecks = CHECKS.filter((check) => normalizedLabel(cell(row, `human_${check}`)) === "fail");
      falseApproves.push({ row, dims: failedChecks });
    } else if (machine === "rejected" && human === "approve") {
      const firedChecks = CHECKS.filter((check) => normalizedLabel(cell(row, `evaluator_${check}`)) === "fail");
      falseRejects.push({ row, dims: firedChecks });
    }
  }
  const hardGateRows = labeled.filter((row) =>
    ["programmatic", "novelty"].includes(normalizedLabel(cell(row, "gate")) ?? "")
  );
  const hardGateHumanApproves = hardGateRows.filter((row) => normalizedLabel(cell(row, "human_overall")) === "approve");

  // Free text is flattened before it lands in Markdown: a multi-line taskText starting
  // a line with # or - would otherwise restructure the report.
  const disagreementLine = ({ row, dims }) =>
    `- \`${cell(row, "itemId")}\` (${dims.join("+") || "no dimension marked"}): ${clip(cell(row, "taskText"))}${
      normalizedLabel(cell(row, "human_notes")) ? ` — ${clip(cell(row, "human_notes"), 120)}` : ""
    }`;
  const fraction = (rateValue, numerator, denominator) =>
    rateValue === null ? "n/a" : `${percent(rateValue)} (${numerator}/${denominator})`;
  const agreementLine = (stats) =>
    `κ ${stats.kappa === null ? "n/a" : stats.kappa.toFixed(2)} · reject precision ${fraction(
      stats.precision,
      stats.tp,
      stats.tp + stats.fp
    )} · reject recall ${fraction(stats.recall, stats.tp, stats.tp + stats.fn)}`;
  const baseRateLine = (stats) =>
    `Base rates (decisive pairs): machine rejects ${stats.machineFails}/${stats.decisive}, human rejects ${stats.humanFails}/${stats.decisive}` +
    (stats.decisive < 20 ? " — ⚠ fewer than 20 decisive pairs; read as protocol output, not a stable rate" : "");
  const checkTable = perCheck
    .map(
      (entry) =>
        `| ${entry.check} | ${entry.n} | ${percent(entry.exactAgreement)} | ${
          entry.kappa === null ? "n/a" : entry.kappa.toFixed(2)
        } | ${fraction(entry.precision, entry.tp, entry.tp + entry.fp)} | ${fraction(entry.recall, entry.tp, entry.tp + entry.fn)} | ${entry.unsureEither} |`
    )
    .join("\n");

  const report = `# Practice-item calibration report

Generated ${new Date().toISOString()} · labels: \`${path.basename(args.labels)}\` · labeler: **${args.labeler}**${
    args.labeler === "self" ? " (self-labeled — a protocol smoke test, not an inter-rater result)" : ""
  }

Agreement between the pipeline/LLM evaluator and a human labeler on drafted practice
items. Quality-review agreement only — not learning-outcome evidence. "fail" is the
positive class throughout: precision = when the machine flags an item, how often the
human agrees; recall = of the items the human flags at that tier, how many the machine
caught. Raw agreement is inflated by class imbalance (a corpus the human approves
wholesale agrees 100% with any evaluator), so read it against the base rates and κ.

## Coverage

- Rows in sheet: ${rows.length - 1}; labeled: ${labeled.length}; skipped (blank human_overall): ${unlabeled}
- Rows with an LLM-evaluator verdict: ${evaluatorRows.length} (hard-gate rejections and evaluator errors are excluded from evaluator-level metrics, so evaluator-level recall is conditional on having survived the deterministic gates)
- Evaluator fail-opens in sheet (status "error" — the tier did not run and the item passed on the deterministic gates alone): ${failOpenRows.length}${
    failOpenRows.length > 0 ? " ⚠" : ""
  }

## Pipeline level (all tiers, ${pipeline.n} labeled items)

- Exact agreement (approve/reject): ${percent(pipeline.exactAgreement)} · ${agreementLine(pipeline)}
- ${baseRateLine(pipeline)}
- Hard-gate rejections among labeled rows: ${hardGateRows.length}; human disagreed with ${hardGateHumanApproves.length} of them

## Evaluator level (${evaluatorRows.length} items with a verdict)

- Overall verdict: exact agreement ${percent(evaluatorOverall.exactAgreement)} · ${agreementLine(evaluatorOverall)}
- ${baseRateLine(evaluatorOverall)}

| check | pairs | exact | κ | fail-precision | fail-recall | unsure (either side) |
| --- | --- | --- | --- | --- | --- | --- |
${checkTable}

Per-check rows count only pairs where both sides labeled the dimension; "unsure" on
either side is excluded from κ/precision/recall (their fractions show the decisive
denominators) and tallied separately.

## Disagreement typology

### Evaluator approved, human rejected (${falseApproves.length}) — the risky direction
${falseApproves.map(disagreementLine).join("\n") || "- none"}

### Evaluator rejected, human approved (${falseRejects.length}) — over-strictness
${falseRejects.map(disagreementLine).join("\n") || "- none"}

### Hard-gate rejections the human would have approved (${hardGateHumanApproves.length})
${hardGateHumanApproves.map((row) => disagreementLine({ row, dims: [cell(row, "gate")] })).join("\n") || "- none"}
`;

  const out = args.out ?? "data/eval-runs/practice-calibration.md";
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, report, "utf8");
  console.log(`wrote ${out} (${labeled.length} labeled rows, ${evaluatorRows.length} with evaluator verdicts)`);
}

const args = parseArgs(process.argv);
try {
  if (args.command === "export") await runExport(args);
  else if (args.command === "report") await runReport(args);
  else {
    console.error("usage: practice-item-calibration.mjs <export|report> [options] — see the header comment");
    process.exit(2);
  }
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
