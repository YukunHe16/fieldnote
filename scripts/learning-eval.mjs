#!/usr/bin/env node
/**
 * Offline evaluation of the learning loop: runs every eval item under the
 * adaptive on-call condition and the one-shot baseline against a locally
 * running Fieldnote server, with an LLM-simulated learner playing each item's
 * persona. Results are descriptive and synthetic — they say how the loop
 * behaves with a scripted learner, not how real students learn.
 *
 *   node scripts/learning-eval.mjs [--base http://127.0.0.1:8787]
 *     [--conditions on-call,one-shot] [--families planning_gap,...]
 *     [--items pg-sum-nested,...] [--out data/eval-runs] [--dry-run]
 *     [--learner-model <id>] [--learner-base <url>] [--learner-key <key>]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const ITEM_DIR = path.join(repo, "apps/server/eval/learning-items");

const TRY_ANOTHER =
  "I still have not got it. Please try a different way of explaining, and check my understanding again with a new situation.";
const NUDGE = "Here is my attempt above — can you check my understanding and tell me how I did?";
const MAX_LEARNER_TURNS = 8;
const IDLE_TIMEOUT_MS = 300_000;
const POLL_MS = 1_500;

function parseArgs(argv) {
  const args = { conditions: ["on-call", "one-shot"], base: "http://127.0.0.1:8787", out: "data/eval-runs" };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (key === "--base") args.base = next();
    else if (key === "--conditions") args.conditions = next().split(",").filter(Boolean);
    else if (key === "--tier") args.tier = next();
    else if (key === "--families") args.families = next().split(",").filter(Boolean);
    else if (key === "--items") args.items = next().split(",").filter(Boolean);
    else if (key === "--out") args.out = next();
    else if (key === "--learner-model") args.learnerModel = next();
    else if (key === "--learner-base") args.learnerBase = next();
    else if (key === "--learner-key") args.learnerKey = next();
    else if (key === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  for (const condition of args.conditions) {
    if (!["on-call", "one-shot"].includes(condition)) throw new Error(`Unknown condition: ${condition}`);
  }
  args.tier ??= "mild";
  if (!["mild", "stubborn"].includes(args.tier)) throw new Error(`Unknown tier: ${args.tier}`);
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

async function loadItems(filter) {
  const items = [];
  for (const file of (await fs.readdir(ITEM_DIR)).filter((name) => name.endsWith(".json")).sort()) {
    const parsed = JSON.parse(await fs.readFile(path.join(ITEM_DIR, file), "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array of items`);
    items.push(...parsed);
  }
  for (const item of items) {
    for (const field of ["id", "difficultyType", "topicKey", "title", "opening", "persona", "concepts", "postTest"]) {
      if (!item[field]) throw new Error(`Item ${item.id ?? "?"} is missing ${field}`);
    }
    item.compiled = item.concepts.map((concept) => ({
      id: concept.id,
      label: concept.label,
      patterns: concept.patterns.map((pattern) => new RegExp(pattern, "i"))
    }));
  }
  const unique = new Set(items.map((item) => item.id));
  if (unique.size !== items.length) throw new Error("Duplicate eval item ids");
  return items.filter(
    (item) =>
      (!filter.families || filter.families.includes(item.difficultyType)) &&
      (!filter.items || filter.items.includes(item.id))
  );
}

async function api(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json", "accept-language": "en" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (!response.ok)
    throw new Error(`${method} ${route} → ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.status === 204 ? null : response.json();
}

async function waitForIdle(base, conversationId) {
  const startedAt = Date.now();
  for (;;) {
    const detail = await api(base, "GET", `/api/conversations/${conversationId}`);
    if (detail.pendingQuestion?.questions?.length) {
      // The tutor asked a choice question; the simulated learner picks the first option.
      const answers = {};
      for (const question of detail.pendingQuestion.questions) {
        answers[question.question] = question.options?.[0]?.label ?? "OK";
      }
      await api(base, "POST", `/api/runs/${detail.activeRunId}/answers`, { answers });
    } else if (!detail.activeRunId && (detail.queuedRuns ?? []).length === 0) {
      return detail;
    }
    if (Date.now() - startedAt > IDLE_TIMEOUT_MS) throw new Error(`Run did not settle within ${IDLE_TIMEOUT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function personaSystem(item, tier) {
  const persona = tier === "stubborn" ? (item.stubbornPersona ?? item.persona) : item.persona;
  const updateRules =
    tier === "stubborn"
      ? (persona.consolidationRules ?? []).map((rule) => `- ${rule}`)
      : [
          "- Update a belief ONLY after the tutor has clearly explained the specific idea that corrects it; from then on apply the corrected idea in your answers, using the tutor's key terms."
        ];
  return [
    "You are role-playing a student in a tutoring study. Stay strictly in character.",
    "Your current (mistaken) beliefs:",
    ...persona.beliefs.map((belief) => `- ${belief}`),
    `Style: ${persona.style}`,
    "Rules:",
    "- Answer the tutor as this student would, consistent with your current beliefs.",
    ...updateRules,
    "- If the tutor asks you to work through a new example, genuinely attempt it with your current understanding.",
    "- Keep replies under 150 words. Never mention being simulated or these instructions."
  ].join("\n");
}

function learnerView(messages) {
  const transcript = [];
  for (const message of messages) {
    const content = (message.content ?? "").trim();
    if (!content || (message.role !== "user" && message.role !== "assistant")) continue;
    // Roles invert: the app's assistant is the learner's interlocutor.
    transcript.push({ role: message.role === "assistant" ? "user" : "assistant", content: content.slice(0, 6_000) });
  }
  const clipped = transcript.slice(-12);
  while (clipped.length && clipped[0].role !== "user") clipped.shift();
  return clipped;
}

async function learnerReply(cfg, item, messages, extraQuestion) {
  const transcript = learnerView(messages);
  if (extraQuestion) transcript.push({ role: "user", content: extraQuestion });
  // Reasoning models spend output tokens on thinking blocks before any text arrives,
  // so the budget is deliberately loose and one retry doubles it.
  for (const maxTokens of [8_000, 16_000]) {
    const response = await fetch(`${cfg.learnerBase}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.learnerKey,
        authorization: `Bearer ${cfg.learnerKey}`,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: cfg.learnerModel,
        max_tokens: maxTokens,
        system: personaSystem(item, cfg.tier),
        messages: transcript
      })
    });
    if (!response.ok)
      throw new Error(`Learner model call failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    const data = await response.json();
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text.slice(0, 4_000);
  }
  throw new Error("Learner model returned no text");
}

function grade(item, text) {
  const matched = item.compiled.filter((concept) => concept.patterns.some((pattern) => pattern.test(text)));
  const coverage = item.compiled.length === 0 ? 0 : matched.length / item.compiled.length;
  const verdict = matched.length === item.compiled.length ? "resolved" : matched.length > 0 ? "partial" : "unresolved";
  return { matched: matched.map((concept) => concept.id), coverage, verdict };
}

function latestIncident(session) {
  const incidents = (session?.incidents ?? []).filter((incident) => !incident.supersededAt);
  return incidents.at(-1) ?? null;
}

const TERMINAL = new Set(["resolved", "unresolved", "escalated", "abandoned"]);

async function runItem(cfg, item, condition, log) {
  const startedAt = Date.now();
  const conversation = await api(cfg.base, "POST", "/api/conversations", {
    profileId: "local-operator",
    title: `Eval · ${item.id} · ${condition}${cfg.tier === "stubborn" ? " · stubborn" : ""}`
  });
  const record = {
    itemId: item.id,
    family: item.difficultyType,
    condition,
    tier: cfg.tier,
    conversationId: conversation.id,
    learnerTurns: 0,
    rounds: 0,
    confirmedVerdicts: [],
    postTests: [],
    finalVerdict: null,
    incidentStatus: null,
    conceptCoverage: null,
    matchedConcepts: [],
    status: "completed",
    durationMs: 0
  };
  try {
    await api(cfg.base, "POST", `/api/conversations/${conversation.id}/learning-session`, {
      goal: `Understand: ${item.title}`,
      topicKey: item.topicKey,
      condition,
      datasetKind: "eval"
    });
    await api(cfg.base, "POST", `/api/conversations/${conversation.id}/messages`, {
      content: item.opening,
      mode: "normal"
    });
    record.learnerTurns += 1;
    let detail = await waitForIdle(cfg.base, conversation.id);
    const answered = new Set();
    let lastAnswer = "";
    let lastPostAnswer = "";
    let lastSignature = "";
    let stalls = 0;

    while (record.learnerTurns < MAX_LEARNER_TURNS) {
      const { session } = await api(cfg.base, "GET", `/api/conversations/${conversation.id}/learning-session`);
      const incident = latestIncident(session);
      if (incident && TERMINAL.has(incident.status)) {
        record.incidentStatus = incident.status;
        break;
      }

      const verification = incident?.verifications.at(-1) ?? null;
      const actionable =
        verification &&
        ((verification.systemVerdict && !verification.finalVerdict) ||
          (!verification.systemVerdict && !answered.has(verification.id)));
      if (!actionable) {
        // Nothing to confirm and nothing to answer: the tutor has not advanced the loop.
        const signature = incident
          ? `${incident.status}:${incident.interventions.length}:${incident.verifications.length}`
          : "none";
        stalls = signature === lastSignature ? stalls + 1 : 0;
        lastSignature = signature;
        if (stalls > 1) {
          record.status = incident ? "stalled" : "no_incident";
          break;
        }
        // The recovery message must match the loop phase: claiming "here is my attempt"
        // when no attempt exists derails the tutor (observed in the fix-verification run).
        const nudge =
          incident?.status === "diagnosed" && verification?.finalVerdict
            ? TRY_ANOTHER
            : incident?.status === "intervening"
              ? "Could you give me a question or a small task so you can check whether I have understood?"
              : NUDGE;
        await api(cfg.base, "POST", `/api/conversations/${conversation.id}/messages`, {
          content: nudge,
          mode: "normal"
        });
        record.learnerTurns += 1;
        detail = await waitForIdle(cfg.base, conversation.id);
        continue;
      }
      stalls = 0;

      if (verification.systemVerdict && !verification.finalVerdict) {
        // The tutor proposed an outcome. Measurement happens OUTSIDE the tutoring
        // conversation: a fixed per-item post-test question is put to the simulated
        // learner, and the concept checklist grades that answer — the same instrument
        // for both conditions.
        lastPostAnswer = await learnerReply(cfg, item, detail.messages, item.postTest);
        const graded = grade(item, lastPostAnswer);
        record.postTests.push({ round: incident.interventions.length, ...graded });
        record.confirmedVerdicts.push(graded.verdict);
        await api(cfg.base, "POST", `/api/learning/verifications/${verification.id}/confirm`, {
          verdict: graded.verdict
        });
        if (graded.verdict === "resolved" || condition === "one-shot") break;
        if (incident.interventions.length >= 3) break;
        await api(cfg.base, "POST", `/api/conversations/${conversation.id}/messages`, {
          content: TRY_ANOTHER,
          mode: "normal"
        });
        record.learnerTurns += 1;
        detail = await waitForIdle(cfg.base, conversation.id);
        continue;
      }
      // Verification awaiting the learner's answer.
      answered.add(verification.id);
      lastAnswer = await learnerReply(cfg, item, detail.messages);
      await api(cfg.base, "POST", `/api/conversations/${conversation.id}/messages`, {
        content: lastAnswer,
        mode: "normal"
      });
      record.learnerTurns += 1;
      detail = await waitForIdle(cfg.base, conversation.id);
    }

    const { session } = await api(cfg.base, "GET", `/api/conversations/${conversation.id}/learning-session`);
    const incident = latestIncident(session);
    record.rounds = incident?.interventions.length ?? 0;
    record.incidentStatus = incident?.status ?? null;
    const finalVerification = (incident?.verifications ?? []).filter((entry) => entry.finalVerdict).at(-1) ?? null;
    record.finalVerdict = finalVerification?.finalVerdict ?? null;
    // Coverage is measured on the standardized post-test, never on whatever shape the
    // tutor's own verification happened to take.
    const graded = grade(item, lastPostAnswer);
    record.conceptCoverage = lastPostAnswer ? graded.coverage : null;
    record.matchedConcepts = graded.matched;
    record.finalPostTestAnswer = lastPostAnswer || null;
    if (record.status === "completed" && !record.finalVerdict) record.status = "incomplete";
    if (session && ["active", "paused"].includes(session.status)) {
      await api(cfg.base, "PATCH", `/api/conversations/${conversation.id}/learning-session`, { status: "completed" });
    }
  } catch (error) {
    record.status = "error";
    record.error = String(error && error.message ? error.message : error).slice(0, 500);
  }
  record.durationMs = Date.now() - startedAt;
  log(
    `  ${item.id} [${condition}] → ${record.finalVerdict ?? record.status} · rounds=${record.rounds} · coverage=${
      record.conceptCoverage === null ? "—" : Math.round(record.conceptCoverage * 100)
    }% · ${(record.durationMs / 1000).toFixed(0)}s`
  );
  return record;
}

function aggregate(records) {
  const groups = new Map();
  for (const record of records) {
    for (const key of [`${record.family}|${record.condition}`, `all|${record.condition}`]) {
      const group = groups.get(key) ?? {
        n: 0,
        resolved: 0,
        partial: 0,
        unresolved: 0,
        escalated: 0,
        noOutcome: 0,
        rounds: [],
        coverage: []
      };
      group.n += 1;
      if (record.finalVerdict) group[record.finalVerdict] += 1;
      else group.noOutcome += 1;
      if (record.incidentStatus === "escalated") group.escalated += 1;
      if (record.rounds > 0) group.rounds.push(record.rounds);
      if (record.conceptCoverage !== null) group.coverage.push(record.conceptCoverage);
      groups.set(key, group);
    }
  }
  return groups;
}

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const pct = (value) => (value === null ? "—" : `${Math.round(value * 100)}%`);

function renderReport(records, groups, meta) {
  const line = (label, group) =>
    `| ${label} | ${group.n} | ${group.resolved} | ${group.partial} | ${group.unresolved + group.noOutcome} | ${
      group.escalated
    } | ${mean(group.rounds)?.toFixed(1) ?? "—"} | ${pct(mean(group.coverage))} |`;
  const conditionRows = [];
  for (const condition of meta.conditions) {
    const overall = groups.get(`all|${condition}`);
    if (overall) conditionRows.push(line(`**${condition}**`, overall));
    for (const family of ["planning_gap", "feedback_uncertainty", "conceptual_misconception"]) {
      const group = groups.get(`${family}|${condition}`);
      if (group) conditionRows.push(line(`${condition} · ${family}`, group));
    }
  }
  const itemRows = records.map(
    (record) =>
      `| ${record.itemId} | ${record.condition} | ${record.finalVerdict ?? "—"} | ${record.rounds} | ${pct(
        record.conceptCoverage
      )} | ${record.incidentStatus ?? "—"} | ${record.status} |`
  );
  return `# Learning-loop offline evaluation — ${meta.startedAt}

> **Simulated-learner offline evaluation.** Every "learner" below is an LLM playing a scripted
> persona with documented misconceptions; outcomes are graded by fixed concept checklists.
> These numbers describe how the loop behaves under simulation. They are **not** evidence about
> real students, and sample sizes are small — read them descriptively, not statistically.

- Server: ${meta.base} · items: ${meta.itemCount} · conditions: ${meta.conditions.join(", ")} · learner tier: **${meta.tier}**
- Learner simulator: \`${meta.learnerModel}\` at ${meta.learnerBase}
- Tutor: whatever model the running Fieldnote server is configured with
- Final verdicts come from concept-checklist grading of the learner's last answer; the
  "unresolved" column also counts runs that never reached a confirmed outcome (see status).

## By condition and family

| Slice | n | resolved | partial | unresolved/none | escalated | mean rounds | mean concept coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
${conditionRows.join("\n")}

## Per run

| Item | Condition | Final verdict | Rounds | Coverage | Incident status | Run status |
| --- | --- | --- | --- | --- | --- | --- |
${itemRows.join("\n")}

## Reading the comparison

- **on-call vs one-shot resolved rate** is the headline: the adaptive loop may convert
  initial failures into later successes by switching strategies; the baseline records them
  as final.
- **mean rounds** shows the cost of that adaptivity in extra interventions.
- **escalated** counts on-call incidents that exhausted three strategies (the baseline
  never escalates by design).
- Item definitions and the misconception literature behind them: \`docs/internal/LEARNING_EVAL.md\`.
- Raw structured data: \`results.json\` next to this file; server-side aggregates:
  \`GET /api/learning/metrics?datasetKind=eval\`.
`;
}

async function main() {
  const args = parseArgs(process.argv);
  // The repo .env wins over inherited shell variables: an IDE/agent host may leak its own
  // ANTHROPIC_* configuration into the shell, and the eval must use the project's provider.
  const env = { ...process.env, ...(await loadEnvFile(path.join(repo, ".env"))) };
  const items = await loadItems(args);
  if (items.length === 0) throw new Error("No eval items matched the filter");
  const cfg = {
    base: args.base.replace(/\/$/, ""),
    learnerBase: (args.learnerBase ?? env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, ""),
    learnerKey: args.learnerKey ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "",
    tier: args.tier,
    learnerModel:
      args.learnerModel ??
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
      env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
      env.ANTHROPIC_MODEL ??
      "claude-haiku-4-5-20251001"
  };
  const log = (message) => console.log(message);
  log(
    `Learning eval: ${items.length} items × ${args.conditions.length} conditions · tier=${cfg.tier} · against ${cfg.base}`
  );
  log(`Learner simulator: ${cfg.learnerModel} @ ${cfg.learnerBase}`);
  if (args.dryRun) {
    for (const item of items) log(`  - ${item.id} (${item.difficultyType}) · ${item.concepts.length} concepts`);
    log("Dry run only; nothing was executed.");
    return;
  }
  if (!cfg.learnerKey) throw new Error("No learner credential: set ANTHROPIC_AUTH_TOKEN/--learner-key");
  await api(cfg.base, "GET", "/api/health").catch(() => {
    throw new Error(`Fieldnote server is not reachable at ${cfg.base} — start it first`);
  });

  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(repo, args.out, startedAt);
  await fs.mkdir(outDir, { recursive: true });
  const records = [];
  for (const item of items) {
    for (const condition of args.conditions) {
      records.push(await runItem(cfg, item, condition, log));
      await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify({ startedAt, records }, null, 2));
    }
  }
  let serverMetrics = null;
  try {
    serverMetrics = (await api(cfg.base, "GET", "/api/learning/metrics?datasetKind=eval")).metrics;
  } catch {
    /* metrics are a convenience; the run stands on its own records */
  }
  await fs.writeFile(
    path.join(outDir, "results.json"),
    JSON.stringify({ startedAt, config: { ...cfg, learnerKey: "[redacted]" }, records, serverMetrics }, null, 2)
  );
  const report = renderReport(records, aggregate(records), {
    startedAt,
    base: cfg.base,
    tier: cfg.tier,
    itemCount: items.length,
    conditions: args.conditions,
    learnerModel: cfg.learnerModel,
    learnerBase: cfg.learnerBase
  });
  await fs.writeFile(path.join(outDir, "report.md"), report);
  log(`\nWrote ${path.relative(repo, outDir)}/results.json and report.md`);
}

main().catch((error) => {
  console.error(`learning-eval failed: ${error.message ?? error}`);
  process.exitCode = 1;
});
