import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLocalRuntimeSettings,
  backgroundModelName,
  composeClaudeChildEnvironment,
  effectiveModelMappings,
  fieldnoteClaudeHome,
  loadConfig,
  resolveEffectiveModel
} from "../src/config.js";

describe("Claude user settings inheritance", () => {
  it("auto-detects authentication without copying secret values into AppConfig", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-settings-"));
    await fs.writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token-never-log",
          ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "test-pro",
          CLAUDE_CODE_EFFORT_LEVEL: "max"
        },
        enabledPlugins: { "example@marketplace": true }
      })
    );

    const config = loadConfig(
      { CLAUDE_CONFIG_DIR: directory, CLAUDE_SETTINGS_MODE: "auto", NODE_ENV: "test" },
      directory
    );
    expect(config.claudeAuthConfigured).toBe(true);
    expect(config.claudeAuthSource).toBe("user-settings");
    expect(config.claudeSettingsMode).toBe("inherit-user");
    expect(config.modelDisplay).toBe("test-pro");
    expect(config.effort).toBe("max");
    expect(config).not.toHaveProperty("anthropicAuthToken");

    const child = composeClaudeChildEnvironment(config, {
      NODE_ENV: "test",
      ANTHROPIC_BASE_URL: ""
    });
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe("test-token-never-log");
    expect(child.ANTHROPIC_BASE_URL).toBe("https://example.invalid/anthropic");
    expect(child.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("test-pro");

    const isolated = loadConfig(
      { CLAUDE_CONFIG_DIR: directory, CLAUDE_SETTINGS_MODE: "isolated", NODE_ENV: "test" },
      directory
    );
    expect(isolated.claudeAuthConfigured).toBe(false);
    expect(isolated.claudeSettingsMode).toBe("isolated");

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("recognizes process-level auth in isolated mode", () => {
    const config = loadConfig(
      {
        ANTHROPIC_AUTH_TOKEN: "test-process-token",
        ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
        WEB_APP_URL: "http://127.0.0.1:8787",
        CLAUDE_SETTINGS_MODE: "isolated",
        NODE_ENV: "test"
      },
      process.cwd()
    );
    expect(config.claudeAuthConfigured).toBe(true);
    expect(config.claudeAuthSource).toBe("process-env");
    expect(config.claudeSettingsMode).toBe("isolated");
    expect(config.anthropicAuthToken).toBe("test-process-token");
    expect(config.anthropicBaseUrl).toBe("https://example.invalid/anthropic");
    expect(config.webAppUrl).toBe("http://127.0.0.1:8787");

    const child = composeClaudeChildEnvironment(config, {
      NODE_ENV: "test",
      ANTHROPIC_BASE_URL: "https://stale.invalid"
    });
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe("test-process-token");
    expect(child.ANTHROPIC_BASE_URL).toBe("https://example.invalid/anthropic");
  });
});

describe("agent tool surface", () => {
  it("pins tool search off no matter how the host asks for it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-settings-"));
    await fs.writeFile(
      path.join(directory, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-token-never-log",
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "test-pro",
          ENABLE_TOOL_SEARCH: "true"
        }
      })
    );
    const config = loadConfig(
      { CLAUDE_CONFIG_DIR: directory, CLAUDE_SETTINGS_MODE: "auto", NODE_ENV: "test" },
      directory
    );
    expect(config.claudeSettingsMode).toBe("inherit-user");

    // Both ways in at once: the host process environment, and the env block Fieldnote
    // inherits from ~/.claude/settings.json. Deferring the tutor's tools behind a search
    // step costs it the learning MCP and reports nothing, so neither source may win.
    const child = composeClaudeChildEnvironment(config, { NODE_ENV: "test", ENABLE_TOOL_SEARCH: "1" });
    expect(child.ENABLE_TOOL_SEARCH).toBe("false");
    // The rest of the inherited env still has to come through.
    expect(child.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("test-pro");

    await fs.rm(directory, { recursive: true, force: true });
  });

  it("pins tool search off for an isolated runtime that never inherits settings", () => {
    const config = loadConfig({ CLAUDE_SETTINGS_MODE: "isolated", NODE_ENV: "test" }, process.cwd());
    const child = composeClaudeChildEnvironment(config, { NODE_ENV: "test", ENABLE_TOOL_SEARCH: "auto" });
    expect(child.ENABLE_TOOL_SEARCH).toBe("false");
  });
});

describe("credential precedence over a local Claude login", () => {
  it("drops a blank ANTHROPIC_API_KEY inherited from .env", () => {
    const config = loadConfig({ CLAUDE_SETTINGS_MODE: "isolated", NODE_ENV: "test" }, process.cwd());
    const child = composeClaudeChildEnvironment(config, { NODE_ENV: "test", ANTHROPIC_API_KEY: "" });
    expect(child).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("points the child at a Fieldnote-owned config dir when Fieldnote supplies the credential", () => {
    const config = loadConfig(
      {
        ANTHROPIC_AUTH_TOKEN: "test-process-token",
        CLAUDE_SETTINGS_MODE: "isolated",
        NODE_ENV: "test"
      },
      process.cwd()
    );
    const child = composeClaudeChildEnvironment(config, { NODE_ENV: "test" });
    expect(child.CLAUDE_CONFIG_DIR).toBe(fieldnoteClaudeHome(config));
    expect(child.CLAUDE_CONFIG_DIR).not.toBe(config.claudeConfigDir);
  });

  it("records the key approval so Claude Code does not fall back to the machine login", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fieldnote-home-"));
    const config = loadConfig(
      {
        ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdefghij",
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
        CLAUDE_SETTINGS_MODE: "isolated",
        NODE_ENV: "production",
        WEB_APP_URL: "http://127.0.0.1:8787"
      },
      root
    );
    const child = composeClaudeChildEnvironment(config, { NODE_ENV: "production" });
    const state = JSON.parse(await fs.readFile(path.join(child.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8"));
    expect(state.customApiKeyResponses.approved).toContain("sk-ant-test-0123456789abcdefghij".slice(-20));
    expect(child.ANTHROPIC_API_KEY).toBe("sk-ant-test-0123456789abcdefghij");
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("provider model mapping", () => {
  it("separates the UI display name from the concrete model used by an SDK alias", () => {
    const processEnv = {
      NODE_ENV: "test",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "provider-pro",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "provider-flash"
    };
    const config = loadConfig(
      { ...processEnv, AGENT_MODEL: "sonnet", CLAUDE_SETTINGS_MODE: "isolated" },
      process.cwd()
    );
    const mappings = effectiveModelMappings(config, processEnv);

    expect(config.modelDisplay).toBe("provider-flash");
    expect(resolveEffectiveModel(config.model, mappings)).toBe("provider-pro");
    expect(backgroundModelName(config, processEnv)).toBe("provider-flash");
    expect(resolveEffectiveModel(backgroundModelName(config, processEnv), mappings)).toBe("provider-flash");
  });

  it("forwards the saved alias mapping to the child and ignores keys outside the allowlist", () => {
    const config = loadConfig({ CLAUDE_SETTINGS_MODE: "isolated", NODE_ENV: "test" }, process.cwd());
    applyLocalRuntimeSettings(config, {
      baseUrl: "https://example.invalid/anthropic",
      model: "provider-strong",
      authToken: "test-token",
      provider: "example",
      modelMappings: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "provider-fast",
        CLAUDE_CODE_SUBAGENT_MODEL: "provider-fast",
        PATH: "/attacker/bin",
        ANTHROPIC_AUTH_TOKEN: "smuggled"
      }
    });
    expect(config.modelProvider).toBe("example");
    expect(config.modelAliasEnv).toEqual({
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "provider-fast",
      CLAUDE_CODE_SUBAGENT_MODEL: "provider-fast"
    });

    const child = composeClaudeChildEnvironment(config, { NODE_ENV: "test", PATH: "/usr/bin" });
    expect(child.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("provider-fast");
    expect(child.CLAUDE_CODE_SUBAGENT_MODEL).toBe("provider-fast");
    expect(child.PATH).toBe("/usr/bin");
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe("test-token");
  });

  it("clears a previous mapping when the next provider has none", () => {
    const config = loadConfig({ CLAUDE_SETTINGS_MODE: "isolated", NODE_ENV: "test" }, process.cwd());
    applyLocalRuntimeSettings(config, {
      baseUrl: "https://example.invalid/anthropic",
      model: "a",
      modelMappings: { ANTHROPIC_MODEL: "a" }
    });
    expect(config.modelAliasEnv).toBeDefined();
    applyLocalRuntimeSettings(config, { baseUrl: "", model: "sonnet" });
    expect(config.modelAliasEnv).toBeUndefined();
    expect(config.modelProvider).toBeUndefined();
  });
});
