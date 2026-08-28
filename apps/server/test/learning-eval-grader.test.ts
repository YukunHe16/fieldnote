import { afterEach, describe, expect, it, vi } from "vitest";
import { gradeAnswer, verifyServerBuild } from "../../../scripts/learning-eval.mjs";

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

describe("learning eval server identity", () => {
  const protocol = { gitSha: "abc123" };

  it("accepts only the clean server build from the runner checkout", () => {
    expect(verifyServerBuild(protocol, { version: "0.1.0", gitSha: "abc123", gitDirty: false })).toEqual({
      serverBuild: { version: "0.1.0", gitSha: "abc123", gitDirty: false },
      serverBuildVerified: true
    });
    expect(() => verifyServerBuild(protocol, { version: "0.1.0", gitSha: "old", gitDirty: false })).toThrow(
      "does not match runner"
    );
  });

  it("allows an explicitly non-comparable smoke test while marking it unverified", () => {
    expect(verifyServerBuild(protocol, null, true)).toMatchObject({
      serverBuild: { gitSha: "unknown", gitDirty: null },
      serverBuildVerified: false
    });
  });
});
