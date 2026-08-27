import { afterEach, describe, expect, it } from "vitest";
import { applyLocale, detectLocale, interpolate, localizedProfile, migrateStoredKey, t } from "./i18n";

if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      }
    }
  });
}

describe("i18n", () => {
  afterEach(() => {
    applyLocale("zh");
  });

  it("interpolates named placeholders", () => {
    expect(interpolate("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
  });

  it("switches catalogs when the locale changes", () => {
    applyLocale("en");
    expect(t("appTitle")).toBe("Fieldnote");
    expect(t("memory")).toBe("Memory");
    expect(t("profileLocalDesc")).toBe("General files, research, and the learning loop");
    expect(t("emptyLocalBody")).toContain("learning loop tracks understanding");
    expect(localizedProfile("local-operator", "本地助手").name).toBe("Local");
    applyLocale("zh");
    expect(t("appTitle")).toBe("Fieldnote");
    expect(t("memory")).toBe("记忆");
    expect(t("profileLocalDesc")).toBe("通用文件、研究与学习回路");
    expect(t("emptyLocalBody")).toContain("学习回路会跟踪理解");
  });

  it("reads a saved locale from storage", () => {
    localStorage.setItem("fieldnote-locale", "en");
    expect(detectLocale()).toBe("en");
    localStorage.setItem("fieldnote-locale", "zh");
    expect(detectLocale()).toBe("zh");
  });

  it("moves a legacy key over exactly once", () => {
    localStorage.removeItem("fieldnote-locale");
    localStorage.setItem("quiet-locale", "en");

    migrateStoredKey("fieldnote-locale", "quiet-locale");
    expect(localStorage.getItem("fieldnote-locale")).toBe("en");
    expect(localStorage.getItem("quiet-locale")).toBe(null);
    expect(detectLocale()).toBe("en");

    // A later legacy write must not win over the value already migrated.
    localStorage.setItem("quiet-locale", "zh");
    migrateStoredKey("fieldnote-locale", "quiet-locale");
    expect(localStorage.getItem("fieldnote-locale")).toBe("en");
    expect(localStorage.getItem("quiet-locale")).toBe("zh");

    localStorage.removeItem("quiet-locale");
    localStorage.setItem("fieldnote-locale", "zh");
  });
});
