import { afterEach, describe, expect, it, vi } from "vitest";
import {
  complianceRepairRunIds,
  learnerView,
  resolveTutorRuntime,
  shouldStopAfterRecord,
  throwIfToolComplianceError,
  waitForIdle
} from "../../../scripts/learning-eval.mjs";

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

afterEach(() => vi.unstubAllGlobals());

describe("learning eval tutor settle timeout", () => {
  it("interrupts the active run and waits for quiescence before reporting timeout", async () => {
    let detailReads = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return response({ runId: "run-1", status: "interrupting" }, 202);
      detailReads += 1;
      return response(
        detailReads === 1
          ? { activeRunId: "run-1", queuedRuns: [] }
          : { activeRunId: null, queuedRuns: [], messages: [] }
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(waitForIdle("http://server.invalid", "conversation-1", -1)).rejects.toMatchObject({
      measurementCategory: "tutor_settle_timeout",
      evalFatal: false,
      settleTimeout: {
        runIds: ["run-1"],
        stopped: true,
        interruptErrors: []
      }
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://server.invalid/api/runs/run-1/interrupt",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("treats an interrupt 404 as a completion race when the conversation is already idle", async () => {
    let detailReads = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return response({ error: "not active" }, 404);
      detailReads += 1;
      return response(detailReads === 1 ? { activeRunId: "run-1", queuedRuns: [] } : { queuedRuns: [] });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(waitForIdle("http://server.invalid", "conversation-1", -1)).rejects.toMatchObject({
      evalFatal: false,
      settleTimeout: { stopped: true, interruptErrors: [] }
    });
  });

  it("marks a cleanup-grace failure fatal so no later item can start", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return response({ runId: "run-1", status: "interrupting" }, 202);
      return response({ activeRunId: "run-1", queuedRuns: [] });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      waitForIdle("http://server.invalid", "conversation-1", -1, { cleanupTimeoutMs: 0, cleanupPollMs: 0 })
    ).rejects.toMatchObject({
      evalFatal: true,
      settleTimeout: { stopped: false }
    });
  });
});

describe("learning eval fail-fast gate", () => {
  it("stops on execution/measurement failures but not descriptive outcomes", () => {
    expect(shouldStopAfterRecord({ status: "error", measurementError: null }, true)).toBe(true);
    expect(shouldStopAfterRecord({ status: "stalled", measurementError: null }, true)).toBe(true);
    expect(shouldStopAfterRecord({ status: "completed", measurementError: "judge_error" }, true)).toBe(true);
    expect(shouldStopAfterRecord({ status: "incomplete", measurementError: null }, true)).toBe(false);
    expect(
      shouldStopAfterRecord(
        {
          status: "completed",
          measurementError: null,
          family: "feedback_uncertainty",
          diagnosedDifficultyType: "conceptual_misconception"
        },
        true
      )
    ).toBe(true);
    expect(
      shouldStopAfterRecord(
        {
          status: "completed",
          measurementError: null,
          family: "feedback_uncertainty",
          diagnosedDifficultyType: "feedback_uncertainty"
        },
        true
      )
    ).toBe(false);
    expect(shouldStopAfterRecord({ status: "error", measurementError: null }, false)).toBe(false);
    expect(shouldStopAfterRecord({ status: "completed", fatalError: true }, false)).toBe(true);
  });
});

describe("learning eval compliance repair transcript", () => {
  const session = {
    complianceEvents: [
      {
        id: "event-1",
        action: "requested",
        signature: "intervening:1:0",
        repairRunId: "repair-1"
      }
    ]
  };

  it("filters both sides of a repair run from the simulated learner transcript", () => {
    const repairRunIds = complianceRepairRunIds(session);
    expect([...repairRunIds]).toEqual(["repair-1"]);
    expect(
      learnerView(
        [
          { role: "assistant", content: "original tutor task", runId: "source" },
          { role: "user", content: "【学习回路修复】", runId: "repair-1" },
          { role: "assistant", content: "registered", runId: "repair-1" }
        ],
        repairRunIds
      )
    ).toEqual([{ role: "user", content: "original tutor task" }]);
  });

  it("maps a gave-up repair to a measurement error immediately", () => {
    expect(() =>
      throwIfToolComplianceError({
        complianceEvents: [
          ...session.complianceEvents,
          { id: "event-2", action: "gave_up", signature: "intervening:1:0", repairRunId: "repair-1" }
        ]
      })
    ).toThrow("compliance repair gave up");
    try {
      throwIfToolComplianceError({
        complianceEvents: [{ id: "event-2", action: "gave_up", signature: "intervening:1:0" }]
      });
    } catch (error: any) {
      expect(error.measurementCategory).toBe("tool_compliance_error");
    }
  });
});

describe("learning eval tutor provenance", () => {
  const runtime = {
    model: "deepseek-v4-flash-vision-exp",
    modelDisplay: "deepseek-v4-flash-vision-exp",
    backgroundModel: "deepseek-v4-flash-vision-exp",
    effectiveModel: "deepseek-v4-flash-vision-exp",
    effectiveBackgroundModel: "deepseek-v4-flash-vision-exp",
    effectiveModelMappings: {},
    effort: "high",
    runTimeoutMs: 1_200_000,
    baseUrl: "https://api.deepseek.com/anthropic"
  };

  it("accepts the preregistered concrete main/background model and effort", () => {
    expect(
      resolveTutorRuntime(runtime, {
        expectedTutorModel: "deepseek-v4-flash-vision-exp",
        expectedTutorEffort: "high",
        idleTimeoutMs: 900_000
      })
    ).toMatchObject({
      tutorRequestedModel: "deepseek-v4-flash-vision-exp",
      tutorModel: "deepseek-v4-flash-vision-exp",
      tutorBackgroundModel: "deepseek-v4-flash-vision-exp",
      tutorEffort: "high",
      tutorRunTimeoutMs: 1_200_000
    });
  });

  it("rejects a hidden host alias or effort override before the first session", () => {
    expect(() =>
      resolveTutorRuntime(
        {
          ...runtime,
          model: "sonnet",
          modelDisplay: "deepseek-v4-flash-vision-exp",
          backgroundModel: "deepseek-v4-flash-vision-exp",
          effectiveModel: "deepseek-v4-pro",
          effectiveBackgroundModel: "deepseek-v4-flash-vision-exp"
        },
        { expectedTutorModel: "deepseek-v4-flash-vision-exp", expectedTutorEffort: "high" }
      )
    ).toThrow("Tutor model mismatch");
    expect(() =>
      resolveTutorRuntime(
        { ...runtime, effort: "max" },
        { expectedTutorModel: "deepseek-v4-flash-vision-exp", expectedTutorEffort: "high" }
      )
    ).toThrow("Tutor effort mismatch");
  });

  it("requires the server timeout to outlast settle plus cleanup grace", () => {
    expect(() => resolveTutorRuntime({ ...runtime, runTimeoutMs: 920_000 }, { idleTimeoutMs: 900_000 })).toThrow(
      "must exceed settle budget"
    );
  });
});
