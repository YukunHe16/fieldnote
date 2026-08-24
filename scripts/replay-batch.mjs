#!/usr/bin/env node
/**
 * Batch replay evaluation: re-runs a set of frozen run snapshots against a locally
 * running Fieldnote server, in a baseline arm and (optionally) a candidate arm that
 * pins one pending/enabled capability artifact, then writes a side-by-side report.
 *
 * Replays re-execute the real agent, so results are not byte-deterministic — they are
 * descriptive behavioural comparisons over an auditable input boundary, nothing more.
 *
 *   node scripts/replay-batch.mjs [--base http://127.0.0.1:8787] --profile local-operator
 *     [--limit 3] [--runs runId,runId] [--match keyword] [--artifact <artifactId>]
 *     [--out data/eval-runs] [--dry-run]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const IDLE_TIMEOUT_MS = 300_000;
const POLL_MS = 1_500;

function parseArgs(argv) {
  const args = { base: "http://127.0.0.1:8787", out: "data/eval-runs", limit: 3 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (key === "--base") args.base = next();
    else if (key === "--profile") args.profile = next();
    else if (key === "--limit") args.limit = Number.parseInt(next(), 10) || 3;
    else if (key === "--runs") args.runs = next().split(",").filter(Boolean);
    else if (key === "--match") args.match = next();
    else if (key === "--artifact") args.artifact = next();
    else if (key === "--out") args.out = next();
    else if (key === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.profile) throw new Error("--profile is required (e.g. --profile local-operator)");
  return args;
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

function summarizeConversation(detail) {
  const assistants = (detail.messages ?? []).filter((message) => message.role === "assistant");
  const last = assistants.at(-1);
  const blocks = last?.blocks ?? [];
  const toolBlocks = blocks.filter((block) => block?.activity);
  return {
    status: last?.status ?? "unknown",
    answerChars: (last?.content ?? "").length,
    toolCalls: toolBlocks.length,
    assistantMessages: assistants.length
  };
}

async function learningOutcomes(base, conversationId) {
  try {
    const detail = await api(base, "GET", `/api/conversations/${conversationId}/learning-session`);
    const incidents = detail?.session?.incidents ?? [];
    return {
      incidents: incidents.length,
      resolved: incidents.filter((incident) => incident.status === "resolved").length,
      escalated: incidents.filter((incident) => incident.status === "escalated").length
    };
  } catch {
    return null;
  }
}

async function runArm(base, snapshot, arm, artifact) {
  const startedAt = Date.now();
  const body =
    arm === "with-artifact"
      ? { includeArtifactId: artifact }
      : // A true baseline strips the candidate from the frozen overlay too: snapshots
        // frozen AFTER the artifact was enabled already carry it, and without the
        // exclusion both arms would replay with the artifact and compare nothing.
        artifact
        ? { excludeArtifactId: artifact }
        : {};
  const notStarted = (error) => {
    console.warn(`  ! ${arm} arm could not start: ${String(error).slice(0, 160)}`);
    return {
      arm,
      conversationId: null,
      durationMs: Date.now() - startedAt,
      failed: true,
      status: "not-started",
      answerChars: 0,
      toolCalls: 0,
      assistantMessages: 0,
      learning: null
    };
  };
  let replay;
  try {
    replay = await api(base, "POST", `/api/runs/${snapshot.runId}/replay`, body);
  } catch (error) {
    // A single unreplayable snapshot (input file changed, artifact since rejected) must
    // not abort the batch and discard every arm that already ran.
    return notStarted(error);
  }
  const conversationId = replay.conversation?.id ?? replay.run?.conversationId;
  if (!conversationId) return notStarted(new Error("Replay did not return a conversation"));
  let failed = false;
  let detail;
  try {
    detail = await waitForIdle(base, conversationId);
  } catch (error) {
    failed = true;
    detail = await api(base, "GET", `/api/conversations/${conversationId}`).catch(() => ({ messages: [] }));
    console.warn(`  ! ${arm} arm did not settle: ${String(error).slice(0, 160)}`);
  }
  return {
    arm,
    conversationId,
    durationMs: Date.now() - startedAt,
    failed,
    ...summarizeConversation(detail),
    learning: await learningOutcomes(base, conversationId)
  };
}

function renderReport(context, results) {
  const lines = [];
  lines.push("# Replay batch report");
  lines.push("");
  lines.push(
    `Profile \`${context.profile}\` · ${results.length} snapshots · arms: baseline${context.artifact ? " + with-artifact" : ""}`
  );
  if (context.artifact) {
    lines.push(`Candidate artifact: \`${context.artifact}\``);
    lines.push(
      "The baseline arm replays the frozen overlay WITHOUT the candidate (excluded even if it was enabled at freeze time); the with-artifact arm replays it with the candidate's current body."
    );
  }
  lines.push("");
  lines.push(
    "Replays re-execute the real agent over frozen inputs; numbers are descriptive behaviour, not deterministic ground truth."
  );
  lines.push("");
  lines.push("| snapshot | prompt | arm | status | tool calls | answer chars | duration | learning |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of results) {
    for (const arm of entry.arms) {
      const learning = arm.learning
        ? `${arm.learning.resolved}/${arm.learning.incidents} resolved${arm.learning.escalated ? ` · ${arm.learning.escalated} escalated` : ""}`
        : "—";
      lines.push(
        `| ${entry.runId.slice(0, 8)} | ${entry.prompt.replace(/\|/g, "\\|").slice(0, 60)} | ${arm.arm} | ${
          arm.failed ? "failed" : arm.status
        } | ${arm.toolCalls} | ${arm.answerChars} | ${(arm.durationMs / 1000).toFixed(0)}s | ${learning} |`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const listed = await api(args.base, "GET", `/api/snapshots?profileId=${encodeURIComponent(args.profile)}&limit=100`);
  let snapshots = listed.snapshots ?? [];
  if (args.runs) snapshots = snapshots.filter((snapshot) => args.runs.includes(snapshot.runId));
  if (args.match)
    snapshots = snapshots.filter((snapshot) => snapshot.prompt.toLowerCase().includes(args.match.toLowerCase()));
  snapshots = snapshots.slice(0, args.limit);
  if (snapshots.length === 0) throw new Error("No snapshots matched; freeze some runs first or loosen the filters");

  console.log(`Replay batch: ${snapshots.length} snapshots × ${args.artifact ? 2 : 1} arm(s)`);
  for (const snapshot of snapshots) console.log(`  - ${snapshot.runId} ${snapshot.prompt.slice(0, 80)}`);
  if (args.dryRun) return;

  const results = [];
  for (const snapshot of snapshots) {
    console.log(`▶ ${snapshot.runId}`);
    // Belt and braces: runArm already degrades per-arm, but nothing inside this loop may
    // unwind past the report writing below — completed arms are minutes of real agent time.
    try {
      const arms = [await runArm(args.base, snapshot, "baseline", args.artifact)];
      if (args.artifact) arms.push(await runArm(args.base, snapshot, "with-artifact", args.artifact));
      results.push({ runId: snapshot.runId, prompt: snapshot.prompt, hasLearning: snapshot.hasLearning, arms });
    } catch (error) {
      console.warn(`  ! snapshot failed entirely: ${String(error).slice(0, 160)}`);
      results.push({ runId: snapshot.runId, prompt: snapshot.prompt, hasLearning: snapshot.hasLearning, arms: [] });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(repo, args.out, `replay-${stamp}`);
  await fs.mkdir(outDir, { recursive: true });
  const context = { profile: args.profile, artifact: args.artifact ?? null, base: args.base };
  await fs.writeFile(path.join(outDir, "results.json"), `${JSON.stringify({ context, results }, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, "report.md"), `${renderReport(context, results)}\n`);
  console.log(`Report: ${path.join(outDir, "report.md")}`);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
