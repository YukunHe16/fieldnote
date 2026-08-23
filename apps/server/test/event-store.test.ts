import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { EventStore } from "../src/event-store.js";
import { AgentStore } from "../src/store.js";

describe("EventStore", () => {
  it("persists monotonic replayable events", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const events = new EventStore(database);
    const first = events.append({
      type: "conversation.updated",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { title: "A" }
    });
    const second = events.append({
      type: "run.status",
      conversationId: conversation.id,
      branchId: conversation.activeBranchId,
      payload: { status: "queued" }
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(events.list(conversation.id, 1).map((event) => event.eventId)).toEqual([second.eventId]);
    database.close();
  });

  it("replays a deep run without being truncated by unrelated conversation events", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const events = new EventStore(database);
    for (let index = 0; index < 2_100; index += 1) {
      events.append({ type: "conversation.updated", conversationId: conversation.id, payload: { index } });
    }
    const run = store.createRun(conversation.id, "target", "normal");
    const target = events.append({
      type: "run.started",
      conversationId: conversation.id,
      runId: run.id,
      payload: { status: "running" }
    });
    const completed = events.append({
      type: "run.completed",
      conversationId: conversation.id,
      runId: run.id,
      payload: { status: "completed" }
    });
    expect(events.listRun(conversation.id, run.id).map((event) => event.eventId)).toEqual([
      target.eventId,
      completed.eventId
    ]);
    database.close();
  });

  it("paginates more than 2,000 events for one streamed run", async () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const conversation = store.createConversation();
    const events = new EventStore(database);
    const run = store.createRun(conversation.id, "target", "normal");
    for (let index = 0; index < 2_001; index += 1) {
      events.append({
        type: "run.status",
        conversationId: conversation.id,
        runId: run.id,
        payload: { status: "running", index }
      });
    }
    events.append({
      type: "run.completed",
      conversationId: conversation.id,
      runId: run.id,
      payload: { status: "completed" }
    });
    const replayed: number[] = [];
    for await (const event of events.streamRun(conversation.id, run.id)) replayed.push(event.sequence);
    expect(replayed).toHaveLength(2_002);
    expect(replayed.at(-1)).toBe(2_002);
    database.close();
  });
});
