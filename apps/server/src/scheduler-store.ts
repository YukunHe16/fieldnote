import { randomUUID } from "node:crypto";
import { getAgentProfile, isAgentProfileId } from "./agent-profiles.js";
import type { SqliteDatabase } from "./database.js";
import {
  SCHEDULE_TEMPLATE_CRONS,
  SCHEDULER_TIME_ZONE,
  type ScheduleTemplateId,
  assertSupportedTimeZone,
  isScheduleTemplateId,
  latestScheduledAt,
  mergedScheduleCount,
  nextScheduledAt
} from "./scheduler-time.js";

export const SCHEDULE_DESTINATIONS = ["web", "feishu"] as const;
export const SCHEDULE_RUN_STATUSES = ["queued", "running", "completed", "failed"] as const;
export const SCHEDULE_DELIVERY_STATUSES = ["queued", "delivered", "failed"] as const;
export const MAX_SCHEDULE_RETRIES = 3;

export type ScheduleDestination = (typeof SCHEDULE_DESTINATIONS)[number];
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];
export type ScheduleDeliveryStatus = (typeof SCHEDULE_DELIVERY_STATUSES)[number];

export interface ScheduledJob {
  id: string;
  profileId: string;
  templateId: ScheduleTemplateId;
  cron: string;
  /** IANA zone the 08:00 wall-clock schedule is anchored to. */
  timezone: string;
  enabled: boolean;
  destinations: ScheduleDestination[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  scheduledAt: string;
  status: ScheduleRunStatus;
  attemptCount: number;
  retryCount: number;
  retryAt: string | null;
  mergedScheduleCount: number;
  error: string | null;
  title: string | null;
  content: string;
  blocks: unknown[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledDelivery {
  id: string;
  runId: string;
  destination: ScheduleDestination;
  status: ScheduleDeliveryStatus;
  externalReference: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type JobRow = {
  id: string;
  profile_id: string;
  template_id: string;
  cron: string;
  timezone: string;
  enabled: number;
  destinations_json: string;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
};
type RunRow = {
  id: string;
  job_id: string;
  scheduled_at: number;
  status: ScheduleRunStatus;
  attempt_count: number;
  retry_count: number;
  retry_at: number | null;
  merged_schedule_count: number;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  title: string | null;
  content: string;
  blocks_json: string;
};
type DeliveryRow = {
  id: string;
  run_id: string;
  destination: ScheduleDestination;
  status: ScheduleDeliveryStatus;
  external_reference: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

export const SCHEDULER_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  template_id TEXT NOT NULL CHECK (template_id IN ('weekly-application-review', 'daily-application-plan')),
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  destinations_json TEXT NOT NULL DEFAULT '["web"]',
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(profile_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  merged_schedule_count INTEGER NOT NULL DEFAULT 1 CHECK (merged_schedule_count > 0),
  error TEXT,
  title TEXT,
  content TEXT NOT NULL DEFAULT '',
  blocks_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_claim ON scheduled_job_runs(status, retry_at, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_history ON scheduled_job_runs(job_id, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scheduled_job_runs(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('web', 'feishu')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  external_reference TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(run_id, destination)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_deliveries_run ON scheduled_deliveries(run_id, status);
`;

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());
const parseDestinations = (value: string): ScheduleDestination[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string" && SCHEDULE_DESTINATIONS.includes(item as ScheduleDestination))
    ) {
      return [...new Set(parsed as ScheduleDestination[])];
    }
  } catch {
    /* Invalid persisted values are treated as a safe web-only job. */
  }
  return ["web"];
};
const cleanDestinations = (destinations: readonly ScheduleDestination[]): ScheduleDestination[] => {
  const cleaned = [...new Set(destinations)];
  if (!cleaned.length || cleaned.some((item) => !SCHEDULE_DESTINATIONS.includes(item)))
    throw new Error("At least one valid schedule destination is required");
  return cleaned;
};

/**
 * Early builds pinned every job to Asia/Shanghai with `CHECK (timezone = 'Asia/Shanghai')`.
 * SQLite cannot drop a CHECK in place, so the table is rebuilt: create, copy, drop, rename —
 * the same twelve-step shape the other migrations in database.ts use.
 */
function migrateScheduledJobTimezone(database: SqliteDatabase): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_jobs'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || !/CHECK\s*\(\s*timezone/i.test(row.sql)) return;
  database.pragma("foreign_keys = OFF");
  try {
    database.exec(`
      CREATE TABLE scheduled_jobs_zoned (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        template_id TEXT NOT NULL CHECK (template_id IN ('weekly-application-review', 'daily-application-plan')),
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        destinations_json TEXT NOT NULL DEFAULT '["web"]',
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(profile_id, template_id)
      );
      INSERT INTO scheduled_jobs_zoned
        (id, profile_id, template_id, cron, timezone, enabled, destinations_json, next_run_at, last_run_at, created_at, updated_at)
      SELECT id, profile_id, template_id, cron, timezone, enabled, destinations_json, next_run_at, last_run_at, created_at, updated_at
      FROM scheduled_jobs;
      DROP TABLE scheduled_jobs;
      ALTER TABLE scheduled_jobs_zoned RENAME TO scheduled_jobs;
      CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at);
    `);
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

export class SchedulerStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.database.exec(SCHEDULER_SCHEMA);
    migrateScheduledJobTimezone(this.database);
    const columns = this.database.pragma("table_info(scheduled_job_runs)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "title"))
      this.database.exec("ALTER TABLE scheduled_job_runs ADD COLUMN title TEXT");
    if (!columns.some((column) => column.name === "content"))
      this.database.exec("ALTER TABLE scheduled_job_runs ADD COLUMN content TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === "blocks_json"))
      this.database.exec("ALTER TABLE scheduled_job_runs ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]'");
    this.recoverRunningRuns();
  }

  /** A process restart cannot resume an SDK stream; make its durable run claimable again. */
  recoverRunningRuns(now = this.clock()): number {
    return this.database
      .prepare(
        `UPDATE scheduled_job_runs
       SET status = 'queued', retry_at = ?, started_at = NULL,
           error = 'Scheduler restarted before this run finished', updated_at = ?
       WHERE status = 'running'`
      )
      .run(now, now).changes;
  }

  createJob(input: {
    profileId: string;
    templateId: ScheduleTemplateId;
    destinations?: ScheduleDestination[];
    enabled?: boolean;
    timezone?: string;
  }): ScheduledJob {
    const template = this.assertRegisteredTemplate(input.profileId, input.templateId);
    const now = this.clock();
    const destinations = cleanDestinations(input.destinations ?? ["web"]);
    this.assertAllowedDestinations(template.allowedChannels, destinations);
    const timezone = input.timezone === undefined ? template.timezone : assertSupportedTimeZone(input.timezone.trim());
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO scheduled_jobs (id, profile_id, template_id, cron, timezone, enabled, destinations_json, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.profileId,
        input.templateId,
        template.cron,
        timezone,
        input.enabled ? 1 : 0,
        JSON.stringify(destinations),
        input.enabled ? nextScheduledAt(input.templateId, now, timezone) : null,
        now,
        now
      );
    return this.requireJob(id);
  }

  getJob(id: string): ScheduledJob | null {
    const row = this.database.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? this.toJob(row) : null;
  }

  listJobs(profileId?: string): ScheduledJob[] {
    const rows = (
      profileId
        ? this.database
            .prepare("SELECT * FROM scheduled_jobs WHERE profile_id = ? ORDER BY created_at DESC")
            .all(profileId)
        : this.database.prepare("SELECT * FROM scheduled_jobs ORDER BY created_at DESC").all()
    ) as JobRow[];
    return rows.map((row) => this.toJob(row));
  }

  ensureProfileTemplates(profileId: string): ScheduledJob[] {
    if (!isAgentProfileId(profileId)) throw new Error(`Unknown agent profile: ${profileId}`);
    const profile = getAgentProfile(profileId);
    for (const template of profile.scheduleTemplates) {
      const existing = this.database
        .prepare("SELECT id FROM scheduled_jobs WHERE profile_id = ? AND template_id = ?")
        .get(profileId, template.id) as { id: string } | undefined;
      if (!existing) {
        this.createJob({
          profileId,
          templateId: template.id,
          destinations: ["web"],
          enabled: template.enabledByDefault
        });
      }
    }
    return this.listJobs(profileId);
  }

  updateJob(
    id: string,
    input: { enabled?: boolean; destinations?: ScheduleDestination[]; timezone?: string }
  ): ScheduledJob | null {
    const current = this.getJob(id);
    if (!current) return null;
    const now = this.clock();
    const enabled = input.enabled ?? current.enabled;
    const destinations = cleanDestinations(input.destinations ?? current.destinations);
    const template = this.assertRegisteredTemplate(current.profileId, current.templateId);
    this.assertAllowedDestinations(template.allowedChannels, destinations);
    const timezone = input.timezone === undefined ? current.timezone : assertSupportedTimeZone(input.timezone.trim());
    // A zone change moves the wall-clock anchor, so the pending cursor is recomputed even when
    // the job was already running on the old zone.
    const keepCursor = current.enabled && current.nextRunAt && timezone === current.timezone;
    const nextRunAt = enabled
      ? keepCursor
        ? new Date(current.nextRunAt!).getTime()
        : nextScheduledAt(current.templateId, now, timezone)
      : null;
    this.database
      .prepare(
        "UPDATE scheduled_jobs SET enabled = ?, destinations_json = ?, timezone = ?, next_run_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(enabled ? 1 : 0, JSON.stringify(destinations), timezone, nextRunAt, now, id);
    return this.requireJob(id);
  }

  deleteJob(id: string): boolean {
    return this.database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id).changes > 0;
  }

  /** Claims due retries and schedules. Each job is claimed at most once per call. */
  claimDue(now = this.clock()): ScheduledJobRun[] {
    return this.database.transaction(() => {
      const claimed: ScheduledJobRun[] = [];
      const retryRows = this.database
        .prepare(
          `SELECT * FROM scheduled_job_runs WHERE status = 'queued' AND retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at ASC`
        )
        .all(now) as RunRow[];
      const claimedJobs = new Set<string>();
      for (const row of retryRows) {
        const updated = this.database
          .prepare(
            `UPDATE scheduled_job_runs SET status = 'running', attempt_count = attempt_count + 1, retry_at = NULL, started_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`
          )
          .run(now, now, row.id);
        if (updated.changes) {
          claimed.push(this.requireRun(row.id));
          claimedJobs.add(row.job_id);
        }
      }

      const jobs = this.database
        .prepare(
          "SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC"
        )
        .all(now) as JobRow[];
      for (const jobRow of jobs) {
        if (claimedJobs.has(jobRow.id)) continue;
        const job = this.toJob(jobRow);
        const firstAt = jobRow.next_run_at!;
        const scheduledAt = latestScheduledAt(job.templateId, firstAt, now, job.timezone);
        if (scheduledAt === null) continue;
        const mergedCount = mergedScheduleCount(job.templateId, firstAt, scheduledAt);
        const run = this.insertAndClaimRun(job, scheduledAt, mergedCount, now);
        const nextRunAt = nextScheduledAt(job.templateId, scheduledAt, job.timezone);
        this.database
          .prepare("UPDATE scheduled_jobs SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?")
          .run(nextRunAt, scheduledAt, now, job.id);
        if (run) claimed.push(run);
      }
      return claimed;
    })();
  }

  /** Creates a one-off running job without changing the recurring next-run cursor. */
  runNow(jobId: string, now = this.clock()): ScheduledJobRun | null {
    const job = this.getJob(jobId);
    if (!job) return null;
    return this.database.transaction(() => this.insertAndClaimRun(job, now, 1, now))();
  }

  completeRun(
    runId: string,
    result: { title?: string; content?: string; blocks?: unknown[] } = {},
    now = this.clock()
  ): ScheduledJobRun | null {
    const updated = this.database
      .prepare(
        `UPDATE scheduled_job_runs SET status = 'completed', title = ?, content = ?, blocks_json = ?,
         completed_at = ?, retry_at = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`
      )
      .run(
        result.title?.slice(0, 240) ?? null,
        result.content ?? "",
        JSON.stringify(result.blocks ?? []),
        now,
        now,
        runId
      );
    return updated.changes ? this.requireRun(runId) : null;
  }

  failRun(runId: string, error: string, now = this.clock(), retryDelayMs = 60_000): ScheduledJobRun | null {
    const row = this.database.prepare("SELECT * FROM scheduled_job_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row || row.status !== "running") return null;
    const retry = row.retry_count < MAX_SCHEDULE_RETRIES;
    this.database
      .prepare(
        `UPDATE scheduled_job_runs SET status = ?, retry_count = retry_count + ?, retry_at = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        retry ? "queued" : "failed",
        retry ? 1 : 0,
        retry ? now + retryDelayMs : null,
        error.slice(0, 2_000),
        retry ? null : now,
        now,
        runId
      );
    return this.requireRun(runId);
  }

  listRuns(jobId: string, limit = 50): ScheduledJobRun[] {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    return (
      this.database
        .prepare("SELECT * FROM scheduled_job_runs WHERE job_id = ? ORDER BY scheduled_at DESC LIMIT ?")
        .all(jobId, capped) as RunRow[]
    ).map((row) => this.toRun(row));
  }

  getRun(id: string): ScheduledJobRun | null {
    const row = this.database.prepare("SELECT * FROM scheduled_job_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? this.toRun(row) : null;
  }

  listDeliveries(runId: string): ScheduledDelivery[] {
    return (
      this.database
        .prepare("SELECT * FROM scheduled_deliveries WHERE run_id = ? ORDER BY destination ASC")
        .all(runId) as DeliveryRow[]
    ).map((row) => this.toDelivery(row));
  }

  completeDelivery(
    runId: string,
    destination: ScheduleDestination,
    externalReference: string,
    now = this.clock()
  ): ScheduledDelivery | null {
    const result = this.database
      .prepare(
        `UPDATE scheduled_deliveries SET status = 'delivered', external_reference = ?, error = NULL, updated_at = ?
       WHERE run_id = ? AND destination = ? AND status = 'queued'`
      )
      .run(externalReference, now, runId, destination);
    if (!result.changes) return null;
    return this.requireDelivery(runId, destination);
  }

  failDelivery(
    runId: string,
    destination: ScheduleDestination,
    error: string,
    now = this.clock()
  ): ScheduledDelivery | null {
    const result = this.database
      .prepare(
        `UPDATE scheduled_deliveries SET status = 'failed', error = ?, updated_at = ? WHERE run_id = ? AND destination = ? AND status = 'queued'`
      )
      .run(error.slice(0, 2_000), now, runId, destination);
    if (!result.changes) return null;
    return this.requireDelivery(runId, destination);
  }

  private insertAndClaimRun(
    job: ScheduledJob,
    scheduledAt: number,
    mergedCount: number,
    now: number
  ): ScheduledJobRun | null {
    const id = randomUUID();
    const inserted = this.database
      .prepare(
        `INSERT OR IGNORE INTO scheduled_job_runs
       (id, job_id, scheduled_at, status, attempt_count, merged_schedule_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 1, ?, ?, ?, ?)`
      )
      .run(id, job.id, scheduledAt, mergedCount, now, now, now);
    if (!inserted.changes) return null;
    for (const destination of job.destinations) {
      this.database
        .prepare(
          "INSERT OR IGNORE INTO scheduled_deliveries (id, run_id, destination, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)"
        )
        .run(randomUUID(), id, destination, now, now);
    }
    return this.requireRun(id);
  }

  private assertRegisteredTemplate(profileId: string, templateId: ScheduleTemplateId) {
    if (!isAgentProfileId(profileId)) throw new Error(`Unknown agent profile: ${profileId}`);
    const profile = getAgentProfile(profileId);
    const template = profile.scheduleTemplates.find((item) => item.id === templateId);
    if (!template) throw new Error(`Schedule template ${templateId} is not registered for profile ${profileId}`);
    if (template.cron !== SCHEDULE_TEMPLATE_CRONS[templateId] || template.timezone !== SCHEDULER_TIME_ZONE) {
      throw new Error(`Unsupported scheduler template: ${templateId}`);
    }
    return template;
  }

  private assertAllowedDestinations(allowed: readonly string[], destinations: readonly ScheduleDestination[]): void {
    if (destinations.some((destination) => !allowed.includes(destination)))
      throw new Error("Schedule destination is not enabled for this template");
  }

  private requireJob(id: string): ScheduledJob {
    const job = this.getJob(id);
    if (!job) throw new Error("Scheduled job not found");
    return job;
  }
  private requireRun(id: string): ScheduledJobRun {
    const row = this.database.prepare("SELECT * FROM scheduled_job_runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) throw new Error("Scheduled job run not found");
    return this.toRun(row);
  }
  private requireDelivery(runId: string, destination: ScheduleDestination): ScheduledDelivery {
    const row = this.database
      .prepare("SELECT * FROM scheduled_deliveries WHERE run_id = ? AND destination = ?")
      .get(runId, destination) as DeliveryRow | undefined;
    if (!row) throw new Error("Scheduled delivery not found");
    return this.toDelivery(row);
  }
  private toJob(row: JobRow): ScheduledJob {
    if (!isScheduleTemplateId(row.template_id))
      throw new Error(`Unsupported persisted schedule template: ${row.template_id}`);
    return {
      id: row.id,
      profileId: row.profile_id,
      templateId: row.template_id,
      cron: row.cron,
      timezone: row.timezone || SCHEDULER_TIME_ZONE,
      enabled: Boolean(row.enabled),
      destinations: parseDestinations(row.destinations_json),
      nextRunAt: iso(row.next_run_at),
      lastRunAt: iso(row.last_run_at),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
  private toRun(row: RunRow): ScheduledJobRun {
    let blocks: unknown[] = [];
    try {
      const parsed = JSON.parse(row.blocks_json) as unknown;
      if (Array.isArray(parsed)) blocks = parsed;
    } catch {
      /* safe empty fallback */
    }
    return {
      id: row.id,
      jobId: row.job_id,
      scheduledAt: new Date(row.scheduled_at).toISOString(),
      status: row.status,
      attemptCount: row.attempt_count,
      retryCount: row.retry_count,
      retryAt: iso(row.retry_at),
      mergedScheduleCount: row.merged_schedule_count,
      error: row.error,
      title: row.title,
      content: row.content,
      blocks,
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
  private toDelivery(row: DeliveryRow): ScheduledDelivery {
    return {
      id: row.id,
      runId: row.run_id,
      destination: row.destination,
      status: row.status,
      externalReference: row.external_reference,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
}
