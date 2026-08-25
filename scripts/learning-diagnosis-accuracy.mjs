#!/usr/bin/env node
/**
 * Diagnosis accuracy over archived eval runs.
 *
 * The outcome half of the offline evaluation depends on an LLM-simulated learner failing
 * to learn believably, which docs/internal/EVAL_LESSONS.md shows it cannot do. The
 * diagnosis half does not: every eval item scripts the learner's misconception verbatim
 * (persona.beliefs), and the loop's first act on a session is to record a written
 * hypothesis about the difficulty. This script judges, for every archived eval session,
 * whether that hypothesis identified the scripted misconception — ground truth is the
 * script, not learner behavior.
 *
 *   node scripts/learning-diagnosis-accuracy.mjs [--db data/agent.db]
 *     [--runs data/eval-runs] [--judge-model <id>] [--out data/eval-runs/diagnosis-accuracy.md]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadItems } from "./learning-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const require = createRequire(path.join(repo, "apps/server/package.json"));
const Database = require("better-sqlite3");

function parseArgs(argv) {
  const args = {
    db: path.join(repo, "data/agent.db"),
    runs: path.join(repo, "data/eval-runs"),
    out: path.join(repo, "data/eval-runs/diagnosis-accuracy.md")
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === "--db") args.db = next();
    else if (key === "--runs") args.runs = next();
    else if (key === "--judge-model") args.judgeModel = next();
    else if (key === "--out") args.out = next();
    else throw new Error(`Unknown argument: ${key}`);
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
    /* flags or process env must cover it */
  }
  return env;
}

const JUDGE_SYSTEM = [
  "You audit a tutoring system's diagnosis against the study script that produced the learner.",
  "The learner is an LLM role-playing a scripted misconception; the script's belief list is the",
  "ground truth for what the learner's difficulty actually is.",
  "",
  "Grade only whether the diagnosis identifies that scripted difficulty:",
  '- "match": it names the core mistaken belief or mechanism the script describes. Different',
  "  wording is fine; the mechanism must be the same one.",
  '- "partial": it lands in the right area but misses the core mechanism, or adds a substantial',
  "  claim the script does not support.",
  '- "miss": it describes a different difficulty than the scripted one.',
  "",
  "A diagnosis often also states the correct plan the learner is missing; that is not a",
  "mismatch. Judge only whether the learner's scripted difficulty is identified.",
  "",
  'Reply with JSON only: {"verdict":"match"|"partial"|"miss","why":"<= 20 words"}'
].join("\n");

async function judge(cfg, item, tier, hypothesis) {
  const persona = tier === "stubborn" ? (item.stubbornPersona ?? item.persona) : item.persona;
  const prompt = [
    `Scripted misconception (ground truth) for item "${item.id}":`,
    ...persona.beliefs.map((belief) => `- ${belief}`),
    `\nThe exercise the learner opened with:\n${item.title}`,
    `\nThe system's recorded diagnosis:\n${hypothesis}`
  ].join("\n");
  // Transient failures (empty replies from a reasoning model that spent its budget thinking,
  // dropped connections) get one retry with a doubled budget, mirroring learning-eval.mjs.
  let lastError;
  for (const maxTokens of [2_000, 4_000]) {
    try {
      const response = await fetch(`${cfg.base}/v1/messages`, {
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
          system: JUDGE_SYSTEM,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!response.ok)
        throw new Error(`Judge call failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
      const data = await response.json();
      const raw = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const json = /\{[\s\S]*\}/.exec(raw);
      if (!json) throw new Error(`Judge returned no JSON: ${raw.slice(0, 120)}`);
      const parsed = JSON.parse(json[0]);
      if (!["match", "partial", "miss"].includes(parsed.verdict)) throw new Error(`Bad verdict: ${parsed.verdict}`);
      return { verdict: parsed.verdict, why: String(parsed.why ?? "") };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main() {
  const args = parseArgs(process.argv);
  const env = { ...process.env, ...(await loadEnvFile(path.join(repo, ".env"))) };
  const cfg = {
    base: (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, ""),
    key: env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "",
    model: args.judgeModel ?? env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001"
  };
  if (!cfg.key) throw new Error("No judge credential: set ANTHROPIC_AUTH_TOKEN in .env");
  const items = Object.fromEntries((await loadItems({})).map((item) => [item.id, item]));

  const database = new Database(args.db, { readonly: true });
  const firstIncident = database.prepare(
    `SELECT inc.hypothesis AS hypothesis
     FROM learning_incidents inc
     JOIN learning_sessions s ON s.id = inc.session_id
     WHERE s.conversation_id = ?
     ORDER BY inc.created_at ASC
     LIMIT 1`
  );

  // One row per archived eval session. Conversations never repeat across run directories,
  // so no dedup is needed; sessions that never opened an incident are counted separately —
  // a run that produced no diagnosis is a loop-reliability failure, not a diagnosis error.
  const rows = [];
  let noIncident = 0;
  for (const dir of (await fs.readdir(args.runs)).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(args.runs, dir, "results.json"), "utf8"));
    } catch {
      continue; // not a run directory
    }
    for (const record of parsed.records ?? []) {
      if (!record.conversationId || !items[record.itemId]) continue;
      const incident = firstIncident.get(record.conversationId);
      if (!incident) {
        noIncident += 1;
        continue;
      }
      rows.push({
        runDir: dir,
        itemId: record.itemId,
        family: record.family,
        tier: record.tier ?? "mild",
        condition: record.condition,
        hypothesis: incident.hypothesis
      });
    }
  }
  database.close();
  console.log(`Judging ${rows.length} diagnoses (${noIncident} session(s) never opened an incident) with ${cfg.model}`);

  let cursor = 0;
  let errors = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= rows.length) return;
        const row = rows[index];
        try {
          Object.assign(row, await judge(cfg, items[row.itemId], row.tier, row.hypothesis));
        } catch (error) {
          errors += 1;
          row.verdict = "judge_error";
          row.why = String(error.message ?? error).slice(0, 120);
        }
        if ((index + 1) % 25 === 0) console.log(`  ${index + 1}/${rows.length}`);
      }
    })
  );

  const judged = rows.filter((row) => row.verdict !== "judge_error");
  const count = (subset, verdict) => subset.filter((row) => row.verdict === verdict).length;
  const pct = (n, d) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
  const slice = (label, subset) =>
    `| ${label} | ${subset.length} | ${count(subset, "match")} | ${count(subset, "partial")} | ${count(subset, "miss")} | ${pct(count(subset, "match"), subset.length)} |`;

  const families = [...new Set(judged.map((row) => row.family))].sort();
  const tiers = [...new Set(judged.map((row) => row.tier))].sort();
  const report = `# Diagnosis accuracy — archived eval sessions

> **Simulated-learner offline evaluation.** The learner in every session below is an LLM
> role-playing a scripted misconception. Ground truth for each diagnosis is that script —
> not learner behavior — so this measurement does not depend on the simulated learner
> failing to learn believably (see \`docs/internal/EVAL_LESSONS.md\` for why the outcome
> half of the evaluation does, and what that implies). Nothing here is evidence about
> real students.

- Sessions judged: ${judged.length}${errors ? ` · judge errors: ${errors}` : ""} · sessions that never opened an incident: ${noIncident} (loop-reliability failures, tracked separately)
- Judge: \`${cfg.model}\` at temperature 0 · verdicts: **match** (names the scripted mechanism), **partial** (right area, core mechanism missed or overclaimed), **miss** (different difficulty)
- Reproduce: \`node scripts/learning-diagnosis-accuracy.mjs\`

## Headline

**${count(judged, "match")}/${judged.length} (${pct(count(judged, "match"), judged.length)}) of first diagnoses match the scripted misconception; ${pct(count(judged, "match") + count(judged, "partial"), judged.length)} at least land in the right area.**

## By slice

| Slice | n | match | partial | miss | match rate |
| --- | --- | --- | --- | --- | --- |
${slice("**all**", judged)}
${families
  .map((family) =>
    slice(
      family,
      judged.filter((row) => row.family === family)
    )
  )
  .join("\n")}
${tiers
  .map((tier) =>
    slice(
      `tier: ${tier}`,
      judged.filter((row) => row.tier === tier)
    )
  )
  .join("\n")}

## Per session

| Run | Item | Tier | Condition | Verdict | Why |
| --- | --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.runDir} | ${row.itemId} | ${row.tier} | ${row.condition} | ${row.verdict} | ${row.why} |`).join("\n")}
`;
  await fs.writeFile(args.out, report);
  console.log(
    `\nmatch ${count(judged, "match")}/${judged.length} · partial ${count(judged, "partial")} · miss ${count(judged, "miss")} · errors ${errors}`
  );
  console.log(`Wrote ${path.relative(repo, args.out)}`);
}

main().catch((error) => {
  console.error(`diagnosis-accuracy failed: ${error.message ?? error}`);
  process.exitCode = 1;
});
