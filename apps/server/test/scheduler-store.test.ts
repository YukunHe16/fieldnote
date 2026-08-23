import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { MAX_SCHEDULE_RETRIES, SCHEDULER_SCHEMA, SchedulerStore } from "../src/scheduler-store.js";
import { isSupportedTimeZone, latestScheduledAt, nextScheduledAt } from "../src/scheduler-time.js";

const day = 24 * 60 * 60 * 1_000;
const hour = 60 * 60 * 1_000;
const monday = Date.UTC(2026, 7, 17, 0, 0, 0); // Monday 08:00 in Shanghai.

const chicago = "America/Chicago";
// United States 2026 transitions: forward on 2026-03-08, back on 2026-11-01, both at 02:00 local.
const chicagoSaturdayBeforeSpring = Date.UTC(2026, 2, 7, 14); // Sat 2026-03-07 08:00 CST (UTC-6)
const chicagoSundayAfterSpring = Date.UTC(2026, 2, 8, 13); // Sun 2026-03-08 08:00 CDT (UTC-5)
const chicagoSaturdayBeforeFall = Date.UTC(2026, 9, 31, 13); // Sat 2026-10-31 08:00 CDT (UTC-5)
const chicagoSundayAfterFall = Date.UTC(2026, 10, 1, 14); // Sun 2026-11-01 08:00 CST (UTC-6)
const chicagoMondayBeforeSpring = Date.UTC(2026, 2, 2, 14); // Mon 2026-03-02 08:00 CST
const chicagoMondayAfterSpring = Date.UTC(2026, 2, 9, 13); // Mon 2026-03-09 08:00 CDT

function fixture(now = monday - day) {
  const database = openDatabase(":memory:");
  let current = now;
  return {
    database,
    store: new SchedulerStore(database, () => current),
    now: () => current,
    setNow: (value: number) => {
      current = value;
    }
  };
}

describe("scheduler time", () => {
  it("calculates only the two registered 08:00 Asia/Shanghai templates", () => {
    expect(nextScheduledAt("daily-application-plan", monday - 1)).toBe(monday);
    expect(nextScheduledAt("daily-application-plan", monday)).toBe(monday + day);
    expect(nextScheduledAt("weekly-application-review", monday - 1)).toBe(monday);
    expect(nextScheduledAt("weekly-application-review", monday)).toBe(monday + 7 * day);
    expect(latestScheduledAt("weekly-application-review", monday, monday + 10 * day)).toBe(monday + 7 * day);
  });

  it("keeps pre-migration Asia/Shanghai data on exactly the same instants", () => {
    for (const templateId of ["daily-application-plan", "weekly-application-review"] as const) {
      expect(nextScheduledAt(templateId, monday - 1, "Asia/Shanghai")).toBe(nextScheduledAt(templateId, monday - 1));
      expect(nextScheduledAt(templateId, monday + 3 * day, "Asia/Shanghai")).toBe(
        nextScheduledAt(templateId, monday + 3 * day)
      );
      expect(latestScheduledAt(templateId, monday, monday + 10 * day, "Asia/Shanghai")).toBe(
        latestScheduledAt(templateId, monday, monday + 10 * day)
      );
    }
    // An unusable persisted zone must not stall the loop; it falls back to the default zone.
    expect(nextScheduledAt("daily-application-plan", monday - 1, "Mars/Phobos")).toBe(monday);
    expect(isSupportedTimeZone(chicago)).toBe(true);
    expect(isSupportedTimeZone("Mars/Phobos")).toBe(false);
    expect(isSupportedTimeZone("")).toBe(false);
  });

  it("holds 08:00 local across both America/Chicago daylight-saving transitions", () => {
    expect(nextScheduledAt("daily-application-plan", chicagoSaturdayBeforeSpring, chicago)).toBe(
      chicagoSundayAfterSpring
    );
    expect(chicagoSundayAfterSpring - chicagoSaturdayBeforeSpring).toBe(23 * hour);
    expect(nextScheduledAt("daily-application-plan", chicagoSaturdayBeforeFall, chicago)).toBe(chicagoSundayAfterFall);
    expect(chicagoSundayAfterFall - chicagoSaturdayBeforeFall).toBe(25 * hour);
    expect(nextScheduledAt("weekly-application-review", chicagoMondayBeforeSpring, chicago)).toBe(
      chicagoMondayAfterSpring
    );
    expect(
      latestScheduledAt("daily-application-plan", chicagoSaturdayBeforeSpring, chicagoSundayAfterSpring + hour, chicago)
    ).toBe(chicagoSundayAfterSpring);
    expect(
      latestScheduledAt("daily-application-plan", chicagoSaturdayBeforeSpring, chicagoSundayAfterSpring - 1, chicago)
    ).toBe(chicagoSaturdayBeforeSpring);
    expect(
      latestScheduledAt(
        "weekly-application-review",
        chicagoMondayBeforeSpring,
        chicagoMondayAfterSpring + hour,
        chicago
      )
    ).toBe(chicagoMondayAfterSpring);
    // The default zone is unaffected by American transitions.
    expect(nextScheduledAt("daily-application-plan", chicagoSaturdayBeforeSpring)).toBe(Date.UTC(2026, 2, 8));
  });
});

describe("SchedulerStore", () => {
  it("creates only registered profile templates and supports CRUD", () => {
    const { database, store } = fixture();
    const job = store.createJob({
      profileId: "graduate-admissions",
      templateId: "daily-application-plan",
      destinations: ["web", "feishu"],
      enabled: true
    });
    expect(job).toMatchObject({
      cron: "0 8 * * *",
      timezone: "Asia/Shanghai",
      enabled: true,
      destinations: ["web", "feishu"]
    });
    expect(store.updateJob(job.id, { enabled: false })?.nextRunAt).toBeNull();
    expect(store.listJobs("graduate-admissions")).toHaveLength(1);
    expect(() => store.createJob({ profileId: "local-operator", templateId: "daily-application-plan" })).toThrow(
      /not registered/
    );
    expect(store.deleteJob(job.id)).toBe(true);
    database.close();
  });

  it("seeds both safe templates disabled without creating duplicates", () => {
    const { database, store } = fixture();
    expect(store.ensureProfileTemplates("graduate-admissions")).toHaveLength(2);
    expect(store.ensureProfileTemplates("graduate-admissions")).toHaveLength(2);
    expect(store.listJobs().every((job) => !job.enabled && job.nextRunAt === null)).toBe(true);
    database.close();
  });

  it("claims a due schedule exactly once, records destinations, and completes it", () => {
    const { database, store, setNow } = fixture();
    const job = store.createJob({
      profileId: "graduate-admissions",
      templateId: "daily-application-plan",
      destinations: ["web", "feishu"],
      enabled: true
    });
    setNow(monday + 30_000);
    const [run] = store.claimDue();
    expect(run).toMatchObject({
      jobId: job.id,
      status: "running",
      attemptCount: 1,
      retryCount: 0,
      mergedScheduleCount: 1
    });
    expect(store.claimDue()).toEqual([]);
    expect(store.listDeliveries(run.id).map((delivery) => delivery.destination)).toEqual(["feishu", "web"]);
    expect(store.completeDelivery(run.id, "web", "message-id")?.status).toBe("delivered");
    expect(store.completeRun(run.id)?.status).toBe("completed");
    expect(store.listRuns(job.id)).toHaveLength(1);
    database.close();
  });

  it("retries a failed run at most three times", () => {
    const { database, store, setNow } = fixture();
    store.createJob({ profileId: "graduate-admissions", templateId: "daily-application-plan", enabled: true });
    setNow(monday + 1);
    let run = store.claimDue()[0]!;
    for (let retry = 0; retry < MAX_SCHEDULE_RETRIES; retry += 1) {
      run = store.failRun(run.id, "temporary failure", undefined, 1)!;
      expect(run.status).toBe("queued");
      const retryAt = new Date(run.retryAt!).getTime();
      setNow(retryAt);
      run = store.claimDue()[0]!;
      expect(run.attemptCount).toBe(retry + 2);
    }
    run = store.failRun(run.id, "permanent failure")!;
    expect(run).toMatchObject({ status: "failed", retryCount: MAX_SCHEDULE_RETRIES, completedAt: expect.any(String) });
    expect(store.claimDue()).toEqual([]);
    database.close();
  });

  it("merges startup misses into one latest scheduled run and preserves manual history", () => {
    const { database, store, setNow } = fixture(monday - 4 * day);
    const job = store.createJob({
      profileId: "graduate-admissions",
      templateId: "daily-application-plan",
      enabled: true
    });
    setNow(monday + 3 * day + 2_000);
    const [catchUp] = store.claimDue();
    expect(catchUp).toMatchObject({ scheduledAt: new Date(monday + 3 * day).toISOString(), mergedScheduleCount: 7 });
    expect(store.getJob(job.id)?.nextRunAt).toBe(new Date(monday + 4 * day).toISOString());
    const manual = store.runNow(job.id)!;
    expect(manual.scheduledAt).toBe(new Date(monday + 3 * day + 2_000).toISOString());
    expect(store.listRuns(job.id)).toHaveLength(2);
    database.close();
  });

  it("stores a per-job time zone and anchors the next run to it", () => {
    const { database, store } = fixture(chicagoSaturdayBeforeSpring - hour);
    const job = store.createJob({
      profileId: "graduate-admissions",
      templateId: "daily-application-plan",
      enabled: true,
      timezone: chicago
    });
    expect(job.timezone).toBe(chicago);
    expect(job.nextRunAt).toBe(new Date(chicagoSaturdayBeforeSpring).toISOString());
    expect(() =>
      store.createJob({
        profileId: "graduate-admissions",
        templateId: "weekly-application-review",
        timezone: "Mars/Phobos"
      })
    ).toThrow(/Unsupported IANA time zone/);
    database.close();
  });

  it("rebuilds a Shanghai-pinned schedule table into an editable time zone column", () => {
    const database = openDatabase(":memory:");
    const legacySchema = SCHEDULER_SCHEMA.replace(
      "timezone TEXT NOT NULL,",
      "timezone TEXT NOT NULL CHECK (timezone = 'Asia/Shanghai'),"
    );
    expect(legacySchema).not.toBe(SCHEDULER_SCHEMA);
    database.exec(legacySchema);
    database
      .prepare(
        `INSERT INTO scheduled_jobs (id, profile_id, template_id, cron, timezone, enabled, destinations_json, next_run_at, last_run_at, created_at, updated_at)
       VALUES ('job-legacy', 'graduate-admissions', 'daily-application-plan', '0 8 * * *', 'Asia/Shanghai', 1, '["web","feishu"]', ?, ?, ?, ?)`
      )
      .run(monday, monday - day, monday - 2 * day, monday - day);
    database
      .prepare(
        `INSERT INTO scheduled_job_runs (id, job_id, scheduled_at, status, attempt_count, retry_count, merged_schedule_count, title, content, blocks_json, created_at, updated_at)
       VALUES ('run-legacy', 'job-legacy', ?, 'completed', 1, 0, 1, '今日申学计划', '历史报告', '[]', ?, ?)`
      )
      .run(monday - day, monday - day, monday - day);
    expect(() =>
      database.prepare("UPDATE scheduled_jobs SET timezone = ? WHERE id = 'job-legacy'").run(chicago)
    ).toThrow(/CHECK constraint/i);

    const store = new SchedulerStore(database, () => monday + 1_000);
    expect(store.getJob("job-legacy")).toMatchObject({
      timezone: "Asia/Shanghai",
      cron: "0 8 * * *",
      enabled: true,
      destinations: ["web", "feishu"],
      nextRunAt: new Date(monday).toISOString(),
      lastRunAt: new Date(monday - day).toISOString()
    });
    expect(store.listRuns("job-legacy")).toMatchObject([
      { id: "run-legacy", title: "今日申学计划", content: "历史报告" }
    ]);

    const moved = store.updateJob("job-legacy", { timezone: chicago })!;
    expect(moved.timezone).toBe(chicago);
    // Moving the anchor re-derives the cursor instead of keeping the Shanghai instant.
    expect(moved.nextRunAt).toBe(
      new Date(nextScheduledAt("daily-application-plan", monday + 1_000, chicago)).toISOString()
    );
    expect(store.updateJob("job-legacy", { enabled: true })?.nextRunAt).toBe(moved.nextRunAt);
    expect(() => store.updateJob("job-legacy", { timezone: "Mars/Phobos" })).toThrow(/Unsupported IANA time zone/);
    database.close();
  });

  it("returns stale running work to the retry queue on startup", () => {
    const { database, store, setNow, now } = fixture();
    const job = store.createJob({
      profileId: "graduate-admissions",
      templateId: "daily-application-plan",
      enabled: true
    });
    setNow(monday + 1);
    const running = store.claimDue()[0]!;
    setNow(now() + 60_000);
    const restarted = new SchedulerStore(database, now);
    expect(restarted.getRun(running.id)).toMatchObject({
      status: "queued",
      retryAt: new Date(now()).toISOString(),
      startedAt: null
    });
    expect(restarted.claimDue()[0]).toMatchObject({ id: running.id, status: "running", attemptCount: 2 });
    expect(restarted.getJob(job.id)).not.toBeNull();
    database.close();
  });
});
