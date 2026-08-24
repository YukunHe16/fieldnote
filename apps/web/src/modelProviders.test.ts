import { describe, expect, it } from "vitest";
import { detectProvider, mappingsFor, providerById } from "./modelProviders";

describe("model provider presets", () => {
  it("recognises a saved base URL without an explicit provider id", () => {
    expect(detectProvider("https://api.deepseek.com/anthropic")).toBe("deepseek");
    expect(detectProvider("https://api.deepseek.com/anthropic/")).toBe("deepseek");
    expect(detectProvider("")).toBe("anthropic");
    expect(detectProvider("https://gateway.invalid/anthropic")).toBe("custom");
  });

  it("prefers the stored provider id over base-URL matching", () => {
    expect(detectProvider("https://api.deepseek.com/anthropic", "custom")).toBe("custom");
  });

  it("sends no mapping for the official endpoint", () => {
    expect(mappingsFor("anthropic", "sonnet")).toEqual({});
  });

  it("splits a preset across strong and fast models", () => {
    const preset = providerById("deepseek");
    const mappings = mappingsFor("deepseek", preset!.defaultModel);
    expect(mappings.ANTHROPIC_MODEL).toBe(preset!.strong!.id);
    expect(mappings.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe(preset!.fast!.name);
    expect(mappings.CLAUDE_CODE_SUBAGENT_MODEL).toBe(preset!.fast!.id);
  });

  it("points every alias at the one model a custom endpoint was given", () => {
    const mappings = mappingsFor("custom", "my-model");
    expect(new Set(Object.values(mappings))).toEqual(new Set(["my-model"]));
    expect(mappings.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBe("my-model");
  });

  it("sends no mapping when a custom endpoint has no model yet", () => {
    expect(mappingsFor("custom", "  ")).toEqual({});
  });
});
