import { afterEach, describe, expect, it } from "vitest";
import { appendOpenId, lastSeenLabel, parseAllowedOpenIds } from "./components/FeishuSettingsDialog";
import { applyLocale, t } from "./i18n";

afterEach(() => applyLocale("zh"));

describe("Feishu allowlist editing", () => {
  it("reads open IDs from either newline or comma separated text", () => {
    expect(parseAllowedOpenIds(" ou_one\nou_two , ou_three \n\n")).toEqual(["ou_one", "ou_two", "ou_three"]);
    expect(parseAllowedOpenIds("")).toEqual([]);
  });

  it("appends a candidate once and leaves an already listed open ID alone", () => {
    expect(appendOpenId("", "ou_me")).toBe("ou_me");
    expect(appendOpenId("ou_me", "ou_other")).toBe("ou_me\nou_other");
    expect(appendOpenId("ou_me, ou_other", "ou_me")).toBe("ou_me, ou_other");
    expect(appendOpenId("ou_me", "")).toBe("ou_me");
  });

  it("labels how long ago a sender was seen and tolerates a missing timestamp", () => {
    expect(lastSeenLabel(new Date().toISOString(), t)).toBe("刚刚");
    expect(lastSeenLabel(new Date(Date.now() - 12 * 60_000).toISOString(), t)).toBe("12 分钟前");
    applyLocale("en");
    expect(lastSeenLabel(new Date(Date.now() - 12 * 60_000).toISOString(), t)).toBe("12 min ago");
    expect(lastSeenLabel("", t)).toBe("");
    expect(lastSeenLabel("not a date", t)).toBe("");
  });

  it("keeps both languages of the single-user notices in the catalogue", () => {
    applyLocale("zh");
    expect(t("feishuAllowEmpty")).toContain("留空");
    expect(t("feishuStoredOverridesEnv")).toContain(".env");
    expect(t("feishuCandidates")).toBe("读取最近发信人");
    applyLocale("en");
    expect(t("feishuAllowEmpty")).toContain("blank");
    expect(t("feishuStoredOverridesEnv")).toContain(".env");
    expect(t("feishuCandidateAllowed")).toBe("Allowed");
  });
});
