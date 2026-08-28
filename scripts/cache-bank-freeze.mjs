#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BANK_VERSION,
  EVALUATOR_MODEL,
  EVALUATOR_ATTEMPT_PLAN,
  GENERATOR_MODEL,
  GENERATOR_ATTEMPT_PLAN,
  PUBLIC_BLUEPRINT,
  assertCacheCore,
  assertDistinctModelIds,
  canonicalStringify,
  normalizeModelId,
  protocolDescriptor,
  runCacheBankFreeze,
  sha256
} from "./cache-bank-freeze-lib.mjs";
import { validateFrozenArtifacts } from "./cache-bank-posttest-cases.mjs";
import { validateCompletedCacheStability, verifyPinnedBankPayload } from "./cache-bank-stability.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const DEFAULT_SEED = 20_260_828;
const DEFAULT_TIMEOUT_MS = 120_000;

export function parseArgs(argv) {
  const command = argv[2] === "freeze" || argv[2] === "publish" ? argv[2] : "freeze";
  const args = { command, seed: DEFAULT_SEED, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = command === argv[2] ? 3 : 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (command === "freeze" && flag === "--seed") args.seed = Number(next());
    else if (command === "freeze" && flag === "--private-dir") args.privateDir = next();
    else if (command === "freeze" && flag === "--resume") args.resume = next();
    else if (command === "freeze" && flag === "--timeout-seconds") args.timeoutMs = Number(next()) * 1_000;
    else if (command === "publish" && flag === "--freeze-result") args.freezeResult = next();
    else if (command === "publish" && flag === "--stability-results") args.stabilityResults = next();
    else if (command === "publish" && flag === "--public-dir") args.publicDir = next();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (command === "freeze") {
    if (!Number.isInteger(args.seed) || args.seed < 0) throw new Error("--seed must be a nonnegative integer");
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-seconds must be positive");
    args.privateDir ??= `data/eval-runs/cache-bank-freeze/${BANK_VERSION}-seed-${args.seed}`;
  } else {
    if (!args.freezeResult || !args.stabilityResults)
      throw new Error("publish requires --freeze-result and --stability-results");
    args.publicDir ??= `apps/server/eval/cache-bank/${BANK_VERSION}`;
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
    /* A missing .env is reported later if no API credential is available. */
  }
  return env;
}

const providerLocation = (value) => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(value);
  }
};

export async function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fs.rename(temporary, file);
}

export async function requestModelText({
  baseUrl,
  key,
  model,
  system,
  payload,
  temperature,
  timeoutMs,
  attemptPlan = GENERATOR_ATTEMPT_PLAN,
  fetchImpl = fetch
}) {
  const attempts = [];
  let lastError = "Model returned no text";
  for (const [index, plan] of attemptPlan.entries()) {
    const ordinal = index + 1;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          authorization: `Bearer ${key}`,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: plan.maxTokens,
          temperature,
          system,
          messages: [{ role: "user", content: JSON.stringify(payload) }],
          ...(plan.reasoningMode === "none" ? { reasoning: { effort: "none" } } : {})
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json();
      const blocks = Array.isArray(body.content) ? body.content : [];
      const contentBlockCounts = {};
      let text = "";
      let thinkingChars = 0;
      for (const block of blocks) {
        const type = String(block?.type ?? "unknown");
        contentBlockCounts[type] = (contentBlockCounts[type] ?? 0) + 1;
        if (type === "text") text += `${String(block?.text ?? "")}\n`;
        if (type === "thinking" || type === "redacted_thinking")
          thinkingChars += String(block?.thinking ?? block?.text ?? block?.reasoning ?? "").length;
      }
      text = text.trim();
      const attempt = {
        ordinal,
        maxTokens: plan.maxTokens,
        reasoningMode: plan.reasoningMode,
        durationMs: Date.now() - started,
        responseId: body.id ? String(body.id) : null,
        responseModel: typeof body.model === "string" ? body.model : null,
        stopReason: body.stop_reason ?? body.stopReason ?? null,
        usage: body.usage ?? null,
        contentBlockCounts,
        textChars: text.length,
        thinkingChars,
        outcome: text ? "success" : "empty_text"
      };
      if (typeof body.model !== "string" || normalizeModelId(body.model) !== normalizeModelId(model)) {
        attempt.outcome = "model_identity_mismatch";
        attempts.push(attempt);
        const error = new Error(`Model response identity does not match requested ${normalizeModelId(model)}`);
        error.modelAttempts = attempts;
        throw error;
      }
      attempts.push(attempt);
      if (text) return { text, attempts };
      lastError = "Model returned no text";
    } catch (error) {
      if (Array.isArray(error?.modelAttempts)) throw error;
      lastError = controller.signal.aborted
        ? `Model request timed out after ${timeoutMs}ms`
        : `Model request failed: ${error?.message ?? error}`;
      attempts.push({
        ordinal,
        maxTokens: plan.maxTokens,
        reasoningMode: plan.reasoningMode,
        durationMs: Date.now() - started,
        responseId: null,
        responseModel: null,
        stopReason: null,
        usage: null,
        contentBlockCounts: {},
        textChars: 0,
        thinkingChars: 0,
        outcome: controller.signal.aborted ? "timeout" : "transport_error",
        error: lastError.slice(0, 500)
      });
    } finally {
      clearTimeout(timer);
    }
  }
  const error = new Error(`${lastError} after ${attempts.length} bounded attempt(s)`);
  error.modelAttempts = attempts;
  throw error;
}

function gitIdentity() {
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitSha = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  if (status) throw new Error("Cache bank freezing requires a clean checkout");
  return { gitSha, gitDirty: false };
}

export function validateBuildIdentity(identity, build) {
  if (build?.gitDirty !== false || build?.gitSha !== identity.gitSha)
    throw new Error("Clean cacheCore build SHA must match the clean Git SHA");
  return build;
}

async function loadBuiltCacheCore(identity) {
  const moduleFile = path.join(repo, "apps/server/dist/cache-bank.js");
  const buildFile = path.join(repo, "apps/server/dist/build-info.json");
  let build;
  let moduleBytes;
  try {
    [build, moduleBytes] = await Promise.all([
      fs.readFile(buildFile, "utf8").then(JSON.parse),
      fs.readFile(moduleFile)
    ]);
  } catch {
    throw new Error("A clean server build is required; run pnpm build before freezing the cache bank");
  }
  validateBuildIdentity(identity, build);
  const cacheCore = await import(`${pathToFileURL(moduleFile).href}?sha256=${sha256(moduleBytes)}`);
  return { cacheCore, build, verifierSha256: sha256(moduleBytes) };
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Publish all public artifacts with one directory rename; cache-v1 may never be changed in place. */
export async function publishFrozenBank(publicDir, result) {
  const target = path.resolve(publicDir);
  const existingMatches = async () => {
    const [existingManifest, existingBank, existingBlueprint, existingProtocol] = await Promise.all(
      ["manifest.json", "bank.json", "blueprint.json", "generation-protocol.json"].map((file) =>
        fs.readFile(path.join(target, file), "utf8").then(JSON.parse)
      )
    );
    const recomputed = sha256(canonicalStringify(existingBank.items));
    const blueprintSha = sha256(canonicalStringify(existingBlueprint));
    return (
      existingBank.finalBankSha256 === recomputed &&
      existingManifest?.hashes?.finalBankSha256 === recomputed &&
      result.manifest.hashes.finalBankSha256 === recomputed &&
      existingManifest?.hashes?.blueprintSha256 === blueprintSha &&
      result.manifest.hashes.blueprintSha256 === blueprintSha &&
      existingProtocol?.protocolSha256 === existingManifest?.hashes?.protocolSha256 &&
      canonicalStringify(existingManifest) === canonicalStringify(result.manifest) &&
      canonicalStringify(existingBlueprint) === canonicalStringify(result.blueprint) &&
      canonicalStringify(existingProtocol) === canonicalStringify(result.protocol)
    );
  };
  if (await exists(target)) {
    if (await existingMatches()) {
      return { status: "already-frozen", directory: target };
    }
    throw new Error(`${BANK_VERSION} is immutable and ${target} already contains a different bank`);
  }
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, `.${path.basename(target)}.stage-`));
  try {
    await Promise.all([
      atomicWriteJson(path.join(stage, "bank.json"), result.bank, { mode: 0o644 }),
      atomicWriteJson(path.join(stage, "blueprint.json"), result.blueprint, { mode: 0o644 }),
      atomicWriteJson(path.join(stage, "generation-protocol.json"), result.protocol, { mode: 0o644 }),
      atomicWriteJson(path.join(stage, "manifest.json"), result.manifest, { mode: 0o644 })
    ]);
    await fs.rename(stage, target);
    return { status: "frozen", directory: target };
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    if ((await exists(target)) && (await existingMatches())) return { status: "already-frozen", directory: target };
    throw error;
  }
}

export function verifyFrozenBankWithCacheCore(bank, cacheCore) {
  assertCacheCore(cacheCore);
  if (!Array.isArray(bank?.items) || bank.items.length !== 24) throw new Error("Frozen bank must contain 24 items");
  for (const item of bank.items) {
    const verification = cacheCore.verifyCacheCandidate(item?.candidate);
    if (!verification.valid) throw new Error(`Frozen item ${item?.id ?? "<missing id>"} failed cacheCore verification`);
  }
  const recomputed = sha256(cacheCore.stableCacheJson(bank.items));
  if (bank.finalBankSha256 !== recomputed) throw new Error("Frozen bank items do not match their SHA-256");
  return recomputed;
}

export function validatePublishGate(result, stability, { payload, pinnedBank, cacheCore }) {
  if (result?.schemaVersion !== "cache-bank-freeze-result/v1") throw new Error("Freeze result schema is invalid");
  assertDistinctModelIds(GENERATOR_MODEL, EVALUATOR_MODEL);
  const expectedProtocol = protocolDescriptor(cacheCore);
  if (canonicalStringify(result.blueprint) !== canonicalStringify(PUBLIC_BLUEPRINT))
    throw new Error("Freeze result blueprint does not match the public cache-v1 blueprint");
  if (canonicalStringify(result.protocol) !== canonicalStringify(expectedProtocol))
    throw new Error("Freeze result generation protocol does not match this cache-v1 implementation");
  if (
    result.manifest?.hashes?.blueprintSha256 !== sha256(canonicalStringify(result.blueprint)) ||
    result.manifest?.hashes?.protocolSha256 !== result.protocol.protocolSha256
  )
    throw new Error("Freeze result blueprint/protocol hashes do not match the manifest");
  validateCompletedCacheStability(stability, payload);
  validateFrozenArtifacts(result.bank, result.manifest);
  verifyFrozenBankWithCacheCore(result.bank, cacheCore);
  verifyFrozenBankWithCacheCore(pinnedBank, cacheCore);
  if (cacheCore.stableCacheJson(result.bank) !== cacheCore.stableCacheJson(pinnedBank))
    throw new Error("Freeze result bank differs from the bank that passed Cache B stability");
  const bankSha = result.manifest?.hashes?.finalBankSha256;
  if (!bankSha || result.bank?.finalBankSha256 !== bankSha || stability.input?.bankSha256 !== bankSha)
    throw new Error("Freeze result and Cache B stability result must pin the same bank SHA-256");
  if (stability.input?.bankVersion !== BANK_VERSION || result.manifest?.bankVersion !== BANK_VERSION)
    throw new Error("Freeze result and Cache B stability result must both pin cache-v1");
  if (
    stability.protocol?.gitSha !== result.manifest.gitSha ||
    stability.protocol?.build?.gitSha !== result.manifest.buildSha
  )
    throw new Error("Freeze result and Cache B stability Git/build identity do not match");
  return result;
}

async function freeze(args) {
  assertDistinctModelIds(GENERATOR_MODEL, EVALUATOR_MODEL);
  const fileEnv = await loadEnvFile(path.join(repo, ".env"));
  const env = { ...process.env, ...fileEnv };
  const generatorBase =
    env.CACHE_BANK_GENERATOR_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic";
  const evaluatorBase =
    env.CACHE_BANK_EVALUATOR_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic";
  const generatorKey =
    env.CACHE_BANK_GENERATOR_API_KEY ??
    env.CACHE_BANK_API_KEY ??
    env.ANTHROPIC_AUTH_TOKEN ??
    env.ANTHROPIC_API_KEY ??
    "";
  const evaluatorKey =
    env.CACHE_BANK_EVALUATOR_API_KEY ??
    env.CACHE_BANK_API_KEY ??
    env.ANTHROPIC_AUTH_TOKEN ??
    env.ANTHROPIC_API_KEY ??
    "";
  if (!generatorKey || !evaluatorKey)
    throw new Error("Cache bank generator and evaluator API credentials are required");
  const identity = gitIdentity();
  const { cacheCore, build, verifierSha256 } = await loadBuiltCacheCore(identity);
  const provenance = {
    ...identity,
    buildSha: build.gitSha,
    verifierSha256,
    startedAt: new Date().toISOString(),
    provider: {
      protocol: "anthropic-v1-messages",
      generatorBaseUrl: providerLocation(generatorBase),
      evaluatorBaseUrl: providerLocation(evaluatorBase)
    }
  };
  const privateDir = path.resolve(repo, args.privateDir);
  const checkpointPath = args.resume ? path.resolve(repo, args.resume) : path.join(privateDir, "checkpoint.json");
  const checkpoint = (await exists(checkpointPath)) ? JSON.parse(await fs.readFile(checkpointPath, "utf8")) : null;
  const result = await runCacheBankFreeze({
    checkpoint,
    seed: args.seed,
    provenance,
    cacheCore,
    saveCheckpoint: (value) => atomicWriteJson(checkpointPath, value),
    generateBatch: ({ request }) =>
      requestModelText({
        baseUrl: generatorBase,
        key: generatorKey,
        model: GENERATOR_MODEL,
        system: request.system,
        payload: request.payload,
        temperature: 0.4,
        timeoutMs: args.timeoutMs,
        attemptPlan: GENERATOR_ATTEMPT_PLAN
      }),
    evaluateCandidate: ({ request }) =>
      requestModelText({
        baseUrl: evaluatorBase,
        key: evaluatorKey,
        model: EVALUATOR_MODEL,
        system: request.system,
        payload: request.payload,
        temperature: 0,
        timeoutMs: args.timeoutMs,
        attemptPlan: EVALUATOR_ATTEMPT_PLAN
      })
  });
  const freezeResultFile = path.join(privateDir, "freeze-result.json");
  const freezeResult = {
    schemaVersion: "cache-bank-freeze-result/v1",
    completedAt: new Date().toISOString(),
    bank: result.bank,
    blueprint: result.blueprint,
    protocol: result.protocol,
    manifest: result.manifest
  };
  await Promise.all([
    atomicWriteJson(freezeResultFile, freezeResult),
    atomicWriteJson(path.join(privateDir, "bank.json"), result.bank),
    atomicWriteJson(path.join(privateDir, "blueprint.json"), result.blueprint),
    atomicWriteJson(path.join(privateDir, "generation-protocol.json"), result.protocol),
    atomicWriteJson(path.join(privateDir, "manifest.json"), result.manifest)
  ]);
  process.stdout.write(
    `private freeze complete: ${result.bank.itemCount} items across ${PUBLIC_BLUEPRINT.length} sets; SHA-256 ${result.bank.finalBankSha256}\n${freezeResultFile}\n`
  );
}

async function publish(args) {
  const identity = gitIdentity();
  const { build, cacheCore } = await loadBuiltCacheCore(identity);
  const [result, stability] = await Promise.all(
    [args.freezeResult, args.stabilityResults].map((file) =>
      fs.readFile(path.resolve(repo, file), "utf8").then(JSON.parse)
    )
  );
  const inputFile = path.resolve(repo, stability.input?.path ?? "");
  const inputBytes = await fs.readFile(inputFile);
  if (sha256(inputBytes) !== stability.input?.sha256)
    throw new Error("Cache B stability input file no longer matches its SHA-256");
  const payload = JSON.parse(inputBytes.toString("utf8"));
  await verifyPinnedBankPayload(payload);
  const pinnedBank = JSON.parse(await fs.readFile(path.resolve(repo, payload.bank.path), "utf8"));
  validatePublishGate(result, stability, { payload, pinnedBank, cacheCore });
  if (result.manifest.gitSha !== identity.gitSha || result.manifest.buildSha !== build.gitSha)
    throw new Error("Publication checkout/build identity must match the frozen bank");
  const published = await publishFrozenBank(path.resolve(repo, args.publicDir), result);
  process.stdout.write(`${published.status}: SHA-256 ${result.bank.finalBankSha256}\n${published.directory}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command === "publish") await publish(args);
  else await freeze(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cache-bank-freeze failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
