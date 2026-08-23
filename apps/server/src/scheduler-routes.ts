import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAgentProfile } from "./agent-profiles.js";
import type { ScheduledJobRunner } from "./scheduler.js";
import {
  SCHEDULE_DESTINATIONS,
  type SchedulerStore,
  type ScheduledJob,
  type ScheduledJobRun
} from "./scheduler-store.js";
import { SCHEDULE_TEMPLATE_IDS, isSupportedTimeZone } from "./scheduler-time.js";

const timezoneInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => isSupportedTimeZone(value), "Unknown IANA time zone");
const createInput = z.object({
  profileId: z.literal("graduate-admissions").default("graduate-admissions"),
  templateId: z.enum(SCHEDULE_TEMPLATE_IDS),
  destinations: z.array(z.enum(SCHEDULE_DESTINATIONS)).min(1).max(2).default(["web"]),
  enabled: z.boolean().default(false),
  timezone: timezoneInput.optional()
});
const updateInput = z.object({
  id: z.string().uuid(),
  destinations: z.array(z.enum(SCHEDULE_DESTINATIONS)).min(1).max(2).optional(),
  enabled: z.boolean().optional(),
  timezone: timezoneInput.optional()
});

export function registerSchedulerRoutes(
  app: FastifyInstance,
  schedules: SchedulerStore,
  runner: ScheduledJobRunner
): void {
  app.get("/api/scheduled-jobs", async () => ({ items: schedules.listJobs().map(presentJob) }));
  app.post("/api/scheduled-jobs", async (request, reply) => {
    const parsed = createInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { timezone, ...input } = parsed.data;
    try {
      return reply.code(201).send(
        presentJob(
          schedules.createJob({
            ...input,
            ...(timezone !== undefined ? { timezone } : {})
          })
        )
      );
    } catch (error) {
      return reply.code(400).send({ error: safeError(error) });
    }
  });
  app.patch("/api/scheduled-jobs", async (request, reply) => {
    const parsed = updateInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const input = parsed.data;
    try {
      const value = schedules.updateJob(input.id, {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.destinations !== undefined ? { destinations: input.destinations } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {})
      });
      return value ? presentJob(value) : reply.code(404).send({ error: "Scheduled job not found" });
    } catch (error) {
      return reply.code(400).send({ error: safeError(error) });
    }
  });
  app.delete("/api/scheduled-jobs/:id", async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    return schedules.deleteJob(id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "Scheduled job not found" });
  });
  app.post("/api/scheduled-jobs/:id/run", async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const run = runner.runNow(id);
    return run ? reply.code(202).send(presentRun(run)) : reply.code(404).send({ error: "Scheduled job not found" });
  });
  app.get("/api/scheduled-jobs/:id/runs", async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    if (!schedules.getJob(id)) return reply.code(404).send({ error: "Scheduled job not found" });
    return { items: schedules.listRuns(id).map(presentRun) };
  });
  app.get("/api/scheduled-job-runs/:id", async (request, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((request.params as { id: string }).id);
    const run = schedules.getRun(id);
    return run ? presentRun(run) : reply.code(404).send({ error: "Scheduled job run not found" });
  });
}

function presentJob(job: ScheduledJob) {
  const template = getAgentProfile("graduate-admissions").scheduleTemplates.find((item) => item.id === job.templateId);
  return {
    ...job,
    name: template?.name ?? job.templateId,
    description: template?.description ?? "",
    schedule: job.cron
  };
}

function presentRun(run: ScheduledJobRun) {
  return {
    ...run,
    summary: run.content.replace(/\s+/g, " ").trim().slice(0, 240)
  };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}
