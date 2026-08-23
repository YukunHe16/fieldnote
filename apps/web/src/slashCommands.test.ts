import { describe, expect, it } from "vitest";
import { matchSlashCommands, slashQuery } from "./slashCommands";

describe("slash command registry", () => {
  it("opens only when slash is the first non-space character", () => {
    expect(slashQuery("  /")).toBe("");
    expect(slashQuery("hello /new")).toBeUndefined();
  });

  it("filters by command and Chinese label", () => {
    expect(matchSlashCommands("/st")).toEqual([]);
    expect(matchSlashCommands("/归档").map((item) => item.id)).toEqual(["archive"]);
    expect(matchSlashCommands("/")).toHaveLength(2);
    expect(matchSlashCommands("/help")).toEqual([]);
  });

  it("returns no command for unknown input", () => {
    expect(matchSlashCommands("/does-not-exist")).toEqual([]);
  });
});
