import { afterEach, describe, expect, it, vi } from "vitest";
import { gradeAnswer } from "../../../scripts/learning-eval.mjs";

const cfg = {
  learnerBase: "https://judge.invalid",
  learnerKey: "test-key",
  judgeModel: "test-judge"
};

const item = {
  postTest: "Explain alpha.",
  compiled: [
    {
      id: "alpha",
      label: "states alpha",
      credit: null,
      patterns: [/alpha/i]
    }
  ]
};

const judgeResponse = (content: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ content }),
  text: async () => ""
});

afterEach(() => vi.unstubAllGlobals());

describe("learning eval post-test judge", () => {
  it("retries an empty reasoning-model response with a larger output budget", async () => {
    const requests: Array<{ max_tokens: number }> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { max_tokens: number });
      if (requests.length === 1) return judgeResponse([]);
      return judgeResponse([
        {
          type: "text",
          text: JSON.stringify({ concepts: [{ id: "alpha", demonstrated: true, why: "stated" }] })
        }
      ]);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(gradeAnswer(cfg, item, "alpha is present")).resolves.toMatchObject({
      method: "judge",
      verdict: "resolved",
      matched: ["alpha"],
      agreed: true
    });
    expect(requests.map((request) => request.max_tokens)).toEqual([4_000, 8_000]);
  });

  it("fails the measurement after both judge attempts instead of using the regex verdict", async () => {
    const fetch = vi.fn(async () => judgeResponse([]));
    vi.stubGlobal("fetch", fetch);

    await expect(gradeAnswer(cfg, item, "alpha is present")).rejects.toThrow("Judge returned no JSON");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
