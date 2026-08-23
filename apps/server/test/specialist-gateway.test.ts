import { describe, expect, it, vi } from "vitest";
import { LocalClaudeSpecialistGateway } from "../src/specialist-gateway.js";

describe("LocalClaudeSpecialistGateway", () => {
  it("owns the local child-query transport and yields its events", async () => {
    const queryFactory = vi.fn(() =>
      (async function* () {
        yield { type: "stream_event", event: { type: "content_block_delta" } };
        yield { type: "result", subtype: "success" };
      })()
    );
    const gateway = new LocalClaudeSpecialistGateway(queryFactory);
    const events = [];
    for await (const event of gateway.run({ prompt: "verify", options: { maxTurns: 4 } })) events.push(event);

    expect(gateway.describe()).toEqual({ id: "local-claude", transport: "local-claude" });
    expect(queryFactory).toHaveBeenCalledWith({ prompt: "verify", options: { maxTurns: 4 } });
    expect(events.map((event) => event.type)).toEqual(["stream_event", "result"]);
  });
});
