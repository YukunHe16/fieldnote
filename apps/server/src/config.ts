import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";

const environmentSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default("./data/agent.db"),
  AGENT_WORKSPACE_ROOT: z.string().default("./data/workspaces"),
  AGENT_RUNTIME: z.enum(["auto", "claude", "demo"]).default("auto"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: z.string().optional(),
  CLAUDE_CODE_EFFORT_LEVEL: z.string().optional(),
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CLAUDE_SETTINGS_MODE: z.enum(["auto", "inherit-user", "isolated"]).default("auto"),
  FIELDNOTE_HOME: z.string().optional(),
  AGENT_MODEL: z.string().default("sonnet"),
  AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(200).default(30),
  AGENT_RUN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(20),
  AGENT_MAX_BUDGET_USD: z.coerce.number().positive().default(2),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  FEISHU_ALLOWED_OPEN_IDS: z.string().default(""),
  WEB_APP_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development")
});

export interface FeishuRuntimeConfig {
  appId: string;
  appSecret: string;
  allowedOpenIds: Set<string>;
}

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  workspaceRoot: string;
  runtime: "auto" | "claude" | "demo";
  anthropicApiKey?: string;
  anthropicAuthToken?: string;
  anthropicBaseUrl?: string;
  claudeAuthConfigured: boolean;
  claudeAuthSource: "process-env" | "user-settings" | "oauth-credentials" | "local-settings" | "none";
  /** Entitlement of a local `claude login`, when Fieldnote relies on those credentials. */
  claudeOauthSubscription: "available" | "unavailable" | "unknown";
  /** Provider preset the saved model service came from, for UI round-trip. */
  modelProvider?: string;
  /** Alias -> concrete model, forwarded to the agent child for compatible providers. */
  modelAliasEnv?: Record<string, string>;
  claudeSettingsMode: "inherit-user" | "isolated";
  claudeConfigDir: string;
  claudeConfigDirExplicit: boolean;
  model: string;
  modelDisplay: string;
  effort: string;
  maxConcurrency: number;
  maxTurns: number;
  runTimeoutMs: number;
  maxBudgetUsd: number;
  feishu?: FeishuRuntimeConfig;
  webAppUrl?: string;
  logLevel: string;
  nodeEnv: "development" | "test" | "production";
}

export interface LocalRuntimeSettings {
  authToken?: string;
  baseUrl: string;
  model: string;
  /** Preset the settings came from, so the UI can show the right provider selected. */
  provider?: string;
  /** Alias -> concrete model for an Anthropic-compatible provider (see MODEL_ALIAS_ENV_KEYS). */
  modelMappings?: Record<string, string>;
}

/**
 * The only environment variables the web UI may set on the agent child process. The child runs
 * with bypassPermissions, so this stays a closed allowlist of model-routing keys rather than an
 * open channel from an HTTP body into a subprocess environment.
 */
export const MODEL_ALIAS_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "CLAUDE_CODE_SUBAGENT_MODEL"
] as const;

/** Model name Fieldnote asks for on background work (titles, memory upkeep). */
export function backgroundModelName(config: AppConfig): string {
  return (
    config.modelAliasEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME?.trim() ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME?.trim() ||
    "sonnet"
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const parsed = environmentSchema.parse(env);
  const claudeConfigDir = parsed.CLAUDE_CONFIG_DIR
    ? path.resolve(cwd, parsed.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  const processAuthConfigured = Boolean(parsed.ANTHROPIC_API_KEY || parsed.ANTHROPIC_AUTH_TOKEN);
  const userSettings = readClaudeUserSettingsMeta(path.join(claudeConfigDir, "settings.json"));
  const userSettingsAuthConfigured = userSettings.hasAuth;
  const allowKeychainProbe = !parsed.CLAUDE_CONFIG_DIR && parsed.NODE_ENV !== "test";
  const oauthCredentialsPresent = detectOAuthCredentials(claudeConfigDir, allowKeychainProbe);
  const claudeSettingsMode =
    parsed.CLAUDE_SETTINGS_MODE === "inherit-user" ||
    (parsed.CLAUDE_SETTINGS_MODE === "auto" && (userSettingsAuthConfigured || oauthCredentialsPresent))
      ? "inherit-user"
      : "isolated";
  const claudeAuthSource = processAuthConfigured
    ? "process-env"
    : claudeSettingsMode === "inherit-user" && userSettingsAuthConfigured
      ? "user-settings"
      : claudeSettingsMode === "inherit-user" && oauthCredentialsPresent
        ? "oauth-credentials"
        : "none";
  const dataRoot = resolveDataRoot(parsed.FIELDNOTE_HOME, cwd, parsed.NODE_ENV);
  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: path.resolve(dataRoot, parsed.DATABASE_PATH),
    workspaceRoot: path.resolve(dataRoot, parsed.AGENT_WORKSPACE_ROOT),
    runtime: parsed.AGENT_RUNTIME,
    claudeAuthConfigured: claudeAuthSource !== "none",
    claudeAuthSource,
    claudeOauthSubscription:
      claudeAuthSource === "oauth-credentials" ? detectOAuthSubscriptionState(claudeConfigDir) : "unknown",
    claudeSettingsMode,
    claudeConfigDir,
    claudeConfigDirExplicit: Boolean(parsed.CLAUDE_CONFIG_DIR),
    model: parsed.AGENT_MODEL,
    modelDisplay:
      parsed.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ?? parsed.ANTHROPIC_MODEL ?? userSettings.model ?? parsed.AGENT_MODEL,
    effort: parsed.CLAUDE_CODE_EFFORT_LEVEL ?? userSettings.effort ?? "high",
    maxConcurrency: parsed.AGENT_MAX_CONCURRENCY,
    maxTurns: parsed.AGENT_MAX_TURNS,
    runTimeoutMs: parsed.AGENT_RUN_TIMEOUT_MINUTES * 60_000,
    maxBudgetUsd: parsed.AGENT_MAX_BUDGET_USD,
    webAppUrl:
      parsed.WEB_APP_URL ??
      (parsed.NODE_ENV === "production" ? `http://127.0.0.1:${parsed.PORT}` : "http://127.0.0.1:5173"),
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV
  };

  if (parsed.ANTHROPIC_API_KEY) {
    config.anthropicApiKey = parsed.ANTHROPIC_API_KEY;
  }
  if (parsed.ANTHROPIC_AUTH_TOKEN) {
    config.anthropicAuthToken = parsed.ANTHROPIC_AUTH_TOKEN;
  }
  if (parsed.ANTHROPIC_BASE_URL) {
    config.anthropicBaseUrl = parsed.ANTHROPIC_BASE_URL;
  }

  if (parsed.FEISHU_APP_ID && parsed.FEISHU_APP_SECRET) {
    config.feishu = {
      appId: parsed.FEISHU_APP_ID,
      appSecret: parsed.FEISHU_APP_SECRET,
      allowedOpenIds: new Set(
        parsed.FEISHU_ALLOWED_OPEN_IDS.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    };
  }

  return config;
}

const BLANKABLE_AUTH_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** Config directory Fieldnote owns when it supplies its own model credential. */
export function fieldnoteClaudeHome(config: AppConfig): string {
  return path.join(path.dirname(config.workspaceRoot), "claude-home");
}

/**
 * Claude Code ignores an API key it has never seen approved and silently falls back to
 * whatever subscription login exists on the machine — so a machine whose login is blocked
 * keeps failing even after the user pastes a working key. When Fieldnote carries its own
 * credential we hand the child a Fieldnote-owned config directory with that approval
 * already recorded, so the credential we were given is the one actually used.
 */
function ensureManagedClaudeHome(home: string, credential: string): void {
  try {
    fs.mkdirSync(home, { recursive: true });
    const statePath = path.join(home, ".claude.json");
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    } catch {
      state = {};
    }
    const responses = (state.customApiKeyResponses ?? {}) as { approved?: unknown; rejected?: unknown };
    const approved = new Set(Array.isArray(responses.approved) ? responses.approved.map(String) : []);
    approved.add(credential.slice(-20));
    state.customApiKeyResponses = {
      approved: [...approved],
      rejected: Array.isArray(responses.rejected) ? responses.rejected : []
    };
    state.hasCompletedOnboarding = true;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // A read-only data directory must not block the run; the child falls back to its own resolution.
  }
}

export function composeClaudeChildEnvironment(
  config: AppConfig,
  processEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { ...processEnv };
  // A bare `ANTHROPIC_API_KEY=` line in .env otherwise reaches the child as a blank
  // credential and derails its authentication.
  for (const key of BLANKABLE_AUTH_KEYS) {
    if (!childEnvironment[key]?.trim()) delete childEnvironment[key];
  }
  if (config.claudeSettingsMode === "inherit-user") {
    const inherited = readClaudeUserSettingsEnv(config.claudeConfigDir);
    for (const [key, value] of Object.entries(inherited)) {
      if (!childEnvironment[key]) childEnvironment[key] = value;
    }
  }
  const ownCredential = config.anthropicAuthToken ?? config.anthropicApiKey;
  if (config.anthropicAuthToken) {
    childEnvironment.ANTHROPIC_AUTH_TOKEN = config.anthropicAuthToken;
    delete childEnvironment.ANTHROPIC_API_KEY;
  } else if (config.anthropicApiKey) {
    childEnvironment.ANTHROPIC_API_KEY = config.anthropicApiKey;
    delete childEnvironment.ANTHROPIC_AUTH_TOKEN;
  }
  if (config.anthropicBaseUrl) {
    childEnvironment.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
  } else if (config.claudeSettingsMode === "isolated" || ownCredential) {
    delete childEnvironment.ANTHROPIC_BASE_URL;
  }
  // The saved provider mapping is authoritative: it describes the endpoint the credential
  // belongs to, so it must win over aliases inherited from the machine's own Claude setup.
  for (const [key, value] of Object.entries(config.modelAliasEnv ?? {})) {
    if ((MODEL_ALIAS_ENV_KEYS as readonly string[]).includes(key) && value.trim()) {
      childEnvironment[key] = value;
    }
  }
  if (ownCredential) {
    const home = fieldnoteClaudeHome(config);
    if (config.nodeEnv !== "test") ensureManagedClaudeHome(home, ownCredential);
    childEnvironment.CLAUDE_CONFIG_DIR = home;
  } else if (config.claudeConfigDirExplicit) {
    childEnvironment.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
  }
  childEnvironment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  childEnvironment.CLAUDE_AGENT_SDK_CLIENT_APP = "fieldnote";
  return childEnvironment;
}

export function applyLocalRuntimeSettings(config: AppConfig, settings: LocalRuntimeSettings): void {
  config.runtime = "auto";
  config.model = settings.model;
  config.modelDisplay = settings.model;
  // The saved base URL is authoritative only when the UI also owns the credential; otherwise an
  // endpoint configured in the environment (a third-party Anthropic-compatible gateway, say) would
  // be erased by a settings row that never meant to speak about endpoints at all.
  if (settings.baseUrl) config.anthropicBaseUrl = settings.baseUrl;
  else if (settings.authToken) delete config.anthropicBaseUrl;
  if (settings.provider) config.modelProvider = settings.provider;
  else delete config.modelProvider;
  const mappings = Object.fromEntries(
    Object.entries(settings.modelMappings ?? {}).filter(
      ([key, value]) => (MODEL_ALIAS_ENV_KEYS as readonly string[]).includes(key) && value.trim()
    )
  );
  if (Object.keys(mappings).length > 0) config.modelAliasEnv = mappings;
  else delete config.modelAliasEnv;
  if (settings.authToken) {
    config.anthropicAuthToken = settings.authToken;
    delete config.anthropicApiKey;
    config.claudeAuthConfigured = true;
    config.claudeAuthSource = "local-settings";
    config.claudeOauthSubscription = "unknown";
  }
}

export function readClaudeUserSettingsEnv(configDir: string): Record<string, string> {
  return readClaudeUserSettings(path.join(configDir, "settings.json")).env;
}

function readClaudeUserSettingsMeta(settingsPath: string): {
  hasAuth: boolean;
  model?: string;
  effort?: string;
} {
  const env = readClaudeUserSettings(settingsPath).env;
  const hasAuth = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const model = firstString(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, env.ANTHROPIC_MODEL);
  const effort = firstString(env.CLAUDE_CODE_EFFORT_LEVEL);
  return {
    hasAuth,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  };
}

function readClaudeUserSettings(settingsPath: string): { env: Record<string, string> } {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings.env ?? {})) {
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
    return { env };
  } catch {
    return { env: {} };
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/**
 * Detect a local Claude OAuth login (`claude login`). The Agent SDK child reads these
 * credentials on its own, so detection only decides whether the auto runtime should
 * pick Claude instead of the demo runtime. The macOS keychain probe checks existence
 * without reading the secret and is skipped for explicit config dirs and tests.
 */
function detectOAuthCredentials(configDir: string, allowKeychainProbe: boolean): boolean {
  try {
    if (fs.existsSync(path.join(configDir, ".credentials.json"))) return true;
  } catch {
    // ignore filesystem errors and fall through
  }
  if (allowKeychainProbe && process.platform === "darwin") {
    try {
      const result = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
        stdio: "ignore",
        timeout: 2_000
      });
      if (result.status === 0) return true;
    } catch {
      // ignore probe failures
    }
  }
  return false;
}

/**
 * Claude Code caches the signed-in account's entitlement locally. A login whose organization
 * has turned Claude Code off still leaves valid-looking credentials on disk, so credential
 * presence alone would report a working runtime that fails on the first message. Read-only,
 * best-effort: an unreadable or absent cache reports "unknown" and changes nothing.
 */
function detectOAuthSubscriptionState(configDir: string): "available" | "unavailable" | "unknown" {
  const candidates = [path.join(configDir, ".claude.json"), path.join(os.homedir(), ".claude.json")];
  for (const candidate of candidates) {
    try {
      const state = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        hasAvailableSubscription?: unknown;
        cachedExtraUsageDisabledReason?: unknown;
      };
      if (state.hasAvailableSubscription === false) return "unavailable";
      if (state.cachedExtraUsageDisabledReason === "org_level_disabled") return "unavailable";
      if (state.hasAvailableSubscription === true) return "available";
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

/**
 * Resolve the base directory that relative DATABASE_PATH / AGENT_WORKSPACE_ROOT values
 * resolve against. Priority: FIELDNOTE_HOME > repository checkout (unchanged legacy
 * behavior) > ~/.fieldnote for installed CLI runs. Tests keep the provided cwd so
 * fixtures stay hermetic.
 */
function resolveDataRoot(fieldnoteHome: string | undefined, cwd: string, nodeEnv: string): string {
  if (fieldnoteHome) return path.resolve(cwd, fieldnoteHome);
  if (nodeEnv === "test") return cwd;
  try {
    if (fs.existsSync(path.join(cwd, "pnpm-workspace.yaml")) && fs.existsSync(path.join(cwd, "apps"))) {
      return cwd;
    }
  } catch {
    // fall through to the home default
  }
  return path.join(os.homedir(), ".fieldnote");
}
