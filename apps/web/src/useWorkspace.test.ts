import { describe, expect, it } from "vitest";
import { normalizeAssistantBlock } from "./api";
import { mergeActivityBlock } from "./useWorkspace";

describe("live activity block timing", () => {
  it("keeps the persisted start time when a canonical completion arrives over SSE", () => {
    const started = normalizeAssistantBlock({
      id: "activity-1",
      kind: "activity",
      activity: {
        id: "activity-1",
        kind: "mcp",
        displayName: "网页搜索",
        technicalName: "WebSearch",
        status: "running",
        startedAt: "2026-08-19T10:00:00.000Z",
        completedAt: null
      }
    });
    const completed = normalizeAssistantBlock({
      id: "activity-1",
      kind: "activity",
      activity: {
        id: "activity-1",
        kind: "mcp",
        displayName: "网页搜索",
        technicalName: "WebSearch",
        status: "completed",
        startedAt: "2026-08-19T10:00:00.000Z",
        completedAt: "2026-08-19T10:00:02.350Z"
      }
    });

    const merged = mergeActivityBlock(started, completed, "activity.completed", "2026-08-19T10:00:02.351Z");
    expect(merged.startedAt).toBe("2026-08-19T10:00:00.000Z");
    expect(merged.completedAt).toBe("2026-08-19T10:00:02.350Z");
  });

  it("uses the terminal event time only for a legacy event without a completion timestamp", () => {
    const current = normalizeAssistantBlock({
      id: "legacy-1",
      type: "tool",
      status: "running",
      startedAt: "2026-08-19T10:00:00.000Z"
    });
    const incoming = normalizeAssistantBlock({ id: "legacy-1", type: "tool", status: "completed" });
    const merged = mergeActivityBlock(current, incoming, "activity.completed", "2026-08-19T10:00:01.200Z");
    expect(merged.startedAt).toBe("2026-08-19T10:00:00.000Z");
    expect(merged.completedAt).toBe("2026-08-19T10:00:01.200Z");
  });
});
