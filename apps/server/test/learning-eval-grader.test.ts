import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJudgePrompt, gradeAnswer, verifyServerBuild } from "../../../scripts/learning-eval.mjs";

const cfg = {
  learnerBase: "https://judge.invalid",
  learnerKey: "test-key",
  judgeModel: "test-judge"
};

const item = {
  opening: "Original worked example with Grader A.",
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

const judgeResponse = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ content, ...extra }),
  text: async () => ""
});

afterEach(() => vi.unstubAllGlobals());

describe("learning eval post-test judge", () => {
  it("shows the worked example and keeps original concepts separate from transfer evidence", () => {
    const prompt = buildJudgePrompt(
      {
        ...item,
        compiled: [...item.compiled, { id: "transfer-applied", label: "fresh case", credit: null, patterns: [] }]
      },
      "student answer"
    );

    expect(prompt).toContain("Worked example:\nOriginal worked example with Grader A.");
    expect(prompt).toContain("scope: original worked example or explicitly stated general method");
    expect(prompt).toContain("scope: fresh transfer case only");
  });

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
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return judgeResponse([]);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(gradeAnswer(cfg, item, "alpha is present")).rejects.toThrow("Judge returned no JSON");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests.every((request) => request.reasoning === undefined)).toBe(true);
  });

  it("uses one bounded DeepSeek no-thinking recovery after two thinking-only responses", async () => {
    const requests: Array<{ max_tokens: number; reasoning?: { effort: string } }> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { max_tokens: number; reasoning?: { effort: string } });
      if (requests.length < 3) {
        return judgeResponse([{ type: "thinking", thinking: '{"concepts":[{"id":"alpha"}]}' }]);
      }
      return judgeResponse(
        [
          {
            type: "text",
            text: JSON.stringify({ concepts: [{ id: "alpha", demonstrated: true, why: "stated" }] })
          }
        ],
        {
          id: "response-3",
          model: "test-judge-resolved",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 20 }
        }
      );
    });
    vi.stubGlobal("fetch", fetch);

    const result = await gradeAnswer(
      { ...cfg, learnerBase: "https://api.deepseek.com/anthropic" },
      item,
      "alpha is present"
    );
    expect(requests).toEqual([
      expect.objectContaining({ max_tokens: 4_000 }),
      expect.objectContaining({ max_tokens: 8_000 }),
      expect.objectContaining({ max_tokens: 4_000, reasoning: { effort: "none" } })
    ]);
    expect(requests[0]?.reasoning).toBeUndefined();
    expect(requests[1]?.reasoning).toBeUndefined();
    expect(result).toMatchObject({ judgeAttemptUsed: 3, verdict: "resolved" });
    expect(result.judgeAttempts.map((attempt: { outcome: string }) => attempt.outcome)).toEqual([
      "empty_text",
      "empty_text",
      "success"
    ]);
    expect(result.judgeAttempts[0].thinkingChars).toBeGreaterThan(0);
    expect(result.judgeAttempts[2]).toMatchObject({
      responseId: "response-3",
      responseModel: "test-judge-resolved",
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
      contentBlockCounts: { text: 1 },
      textChars: expect.any(Number),
      thinkingChars: 0,
      transportRequests: 1
    });
  });

  it("keeps three empty DeepSeek attempts fail-closed with attempt provenance", async () => {
    const fetch = vi.fn(async () => judgeResponse([]));
    vi.stubGlobal("fetch", fetch);

    let failure: any;
    try {
      await gradeAnswer({ ...cfg, learnerBase: "https://api.deepseek.com/anthropic" }, item, "alpha is present");
    } catch (error) {
      failure = error;
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(failure?.judgeAttempts).toHaveLength(3);
    expect(failure?.judgeAttempts[2]).toMatchObject({ reasoningMode: "none", outcome: "empty_text" });
  });

  it("does not change judging mode for malformed text responses", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return judgeResponse([{ type: "text", text: "not json" }]);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      gradeAnswer({ ...cfg, learnerBase: "https://api.deepseek.com/anthropic" }, item, "alpha is present")
    ).rejects.toThrow("Judge returned no JSON");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.reasoning === undefined)).toBe(true);
  });

  it("does not use no-thinking recovery when the judge omits a concept", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return judgeResponse([{ type: "text", text: JSON.stringify({ concepts: [] }) }]);
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      gradeAnswer({ ...cfg, learnerBase: "https://api.deepseek.com/anthropic" }, item, "alpha is present")
    ).rejects.toThrow("Judge omitted concept alpha");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.reasoning === undefined)).toBe(true);
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
