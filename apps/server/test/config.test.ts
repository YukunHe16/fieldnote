import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeClaudeChildEnvironment, loadConfig } from "../src/config.js";

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
