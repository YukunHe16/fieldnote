import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { registerSchedulerRoutes } from "../src/scheduler-routes.js";
import { SchedulerStore } from "../src/scheduler-store.js";

describe("scheduler HTTP API", () => {
  it("creates, updates, runs, and reads safe schedule templates", async () => {
    const database = openDatabase(":memory:");
    const schedules = new SchedulerStore(database);
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, schedules, { runNow: (id: string) => schedules.runNow(id) } as never);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-jobs",
      payload: {
        profileId: "graduate-admissions",
        templateId: "weekly-application-review",
        destinations: ["web", "feishu"],
        enabled: true
      }
    });
    expect(created.statusCode).toBe(201);
    const job = created.json<{ id: string; name: string; schedule: string }>();
    expect(job).toMatchObject({ name: "每周申请回顾", schedule: "0 8 * * 1" });
    const paused = await app.inject({
      method: "PATCH",
      url: "/api/scheduled-jobs",
      payload: { id: job.id, enabled: false }
    });
    expect(paused.json()).toMatchObject({ enabled: false, nextRunAt: null });
    const run = await app.inject({ method: "POST", url: `/api/scheduled-jobs/${job.id}/run` });
    expect(run.statusCode).toBe(202);
    const runId = run.json<{ id: string }>().id;
    schedules.completeRun(runId, { title: "本周申学进度", content: "完成文书初稿" });
    const history = await app.inject({ method: "GET", url: `/api/scheduled-jobs/${job.id}/runs` });
    expect(history.json<{ items: Array<{ id: string; summary: string }> }>().items[0]).toMatchObject({
      id: runId,
      summary: "完成文书初稿"
    });
    const report = await app.inject({ method: "GET", url: `/api/scheduled-job-runs/${runId}` });
    expect(report.json()).toMatchObject({ title: "本周申学进度", content: "完成文书初稿" });

    await app.close();
    database.close();
  });

  it("accepts an IANA time zone and rejects an unknown one with 400", async () => {
    const database = openDatabase(":memory:");
    const schedules = new SchedulerStore(database);
    const app = Fastify({ logger: false });
    registerSchedulerRoutes(app, schedules, { runNow: (id: string) => schedules.runNow(id) } as never);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-jobs",
      payload: { templateId: "daily-application-plan", enabled: true, timezone: "America/Chicago" }
    });
    expect(created.statusCode).toBe(201);
    const job = created.json<{ id: string; timezone: string }>();
    expect(job.timezone).toBe("America/Chicago");

    const moved = await app.inject({
      method: "PATCH",
      url: "/api/scheduled-jobs",
      payload: { id: job.id, timezone: "Europe/London" }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ timezone: "Europe/London", enabled: true });
    expect(schedules.getJob(job.id)?.timezone).toBe("Europe/London");

    const rejectedUpdate = await app.inject({
      method: "PATCH",
      url: "/api/scheduled-jobs",
      payload: { id: job.id, timezone: "Mars/Phobos" }
    });
    expect(rejectedUpdate.statusCode).toBe(400);
    expect(rejectedUpdate.json<{ error: string }>().error).toContain("timezone");
    expect(schedules.getJob(job.id)?.timezone).toBe("Europe/London");

    const rejectedCreate = await app.inject({
      method: "POST",
      url: "/api/scheduled-jobs",
      payload: { templateId: "weekly-application-review", timezone: "not a zone" }
    });
    expect(rejectedCreate.statusCode).toBe(400);

    await app.close();
    database.close();
  });
});
