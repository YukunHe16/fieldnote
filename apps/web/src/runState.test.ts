import { describe, expect, it } from "vitest";
import { applyRunEventState, settleRunMessages } from "./runState";
import type { AgentEvent, ConversationDetail } from "./types";

function detail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: "c1",
    title: "对话",
    state: "active",
    updatedAt: "2026-08-18T00:00:00Z",
    messages: [],
    events: [],
    runState: "running",
    activeRunId: "r1",
    ...overrides
  };
}

describe("run state transitions", () => {
  it("does not revive a terminal run with a late running event", () => {
    const completed: AgentEvent = { id: "done", type: "run.completed", runId: "r1", status: "completed" };
    const afterCompletion = detail({ events: [completed], runState: "completed", activeRunId: undefined });
    expect(
      applyRunEventState(afterCompletion, { id: "late", type: "run.status", runId: "r1", status: "running" })
    ).toEqual({ runState: "completed", activeRunId: undefined });
  });

  it("ignores terminal events from a different run", () => {
    expect(
      applyRunEventState(detail({ activeRunId: "r2" }), { id: "old", type: "run.completed", runId: "r1" })
    ).toEqual({ runState: "running", activeRunId: "r2" });
  });

  it("allows a new run to start after the previous run completed", () => {
    const current = detail({
      events: [{ id: "done", type: "run.completed", runId: "r1" }],
      runState: "completed",
      activeRunId: undefined
    });
    expect(applyRunEventState(current, { id: "next", type: "run.started", runId: "r2" })).toEqual({
      runState: "running",
      activeRunId: "r2"
    });
  });
});

describe("settleRunMessages", () => {
  it("closes a streaming message and nested activities when a recovered run is interrupted", () => {
    const [message] = settleRunMessages(
      [
        {
          id: "m1",
          role: "assistant",
          runId: "r1",
          content: "",
          createdAt: "2026-08-19T00:00:00.000Z",
          status: "streaming",
          blocks: [
            {
              id: "b1",
              type: "subagent",
              status: "running",
              children: [{ id: "b2", type: "mcp", status: "queued", children: [] }]
            }
          ]
        }
      ],
      "r1",
      "interrupted"
    );
    expect(message).toMatchObject({ status: "interrupted" });
    expect(message?.blocks?.[0]).toMatchObject({ status: "interrupted" });
    expect(message?.blocks?.[0]?.children[0]).toMatchObject({ status: "interrupted" });
  });
});
