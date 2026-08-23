import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import {
  type AdmissionsStore,
  APPLICATION_PROGRAM_STATUSES,
  APPLICATION_REQUIREMENT_STATUSES,
  APPLICATION_TASK_PRIORITIES
} from "./admissions-store.js";

const id = z.string().uuid();
const optionalDate = z.string().trim().min(1).max(64).nullable().optional();
const cycleInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  degree: z.string().trim().max(80).optional(),
  fieldOfStudy: z.string().trim().max(200).optional(),
  intakeTerm: z.string().trim().max(120).optional(),
  targetRegions: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  active: z.boolean().optional()
});
const profileInput = z.object({
  id: id.optional(),
  cycleId: id.optional(),
  educationSummary: z.string().max(10_000).optional(),
  researchSummary: z.string().max(10_000).optional(),
  exams: z.unknown().optional(),
  budgetConstraints: z.string().max(4_000).optional(),
  targetDegree: z.string().max(80).optional(),
  targetField: z.string().max(200).optional(),
  targetYear: z.string().max(120).optional(),
  summary: z.string().max(10_000).optional()
});
const programInput = z.object({
  id: id.optional(),
  cycleId: id.optional(),
  school: z.string().trim().max(200).optional(),
  institution: z.string().trim().max(200).optional(),
  program: z.string().trim().max(240).optional(),
  name: z.string().trim().max(240).optional(),
  country: z.string().trim().max(80).optional(),
  degree: z.string().trim().max(80).optional(),
  status: z.enum(APPLICATION_PROGRAM_STATUSES).optional(),
  officialUrl: z.string().trim().url().max(2_048).or(z.literal("")).optional(),
  applicationFee: z.number().nonnegative().nullable().optional(),
  feeCurrency: z.string().trim().max(12).nullable().optional(),
  deadlineAt: optionalDate,
  deadline: optionalDate,
  deadlines: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        label: z.string().trim().max(80).optional(),
        dueAt: z.string().trim().min(1).max(64)
      })
    )
    .max(12)
    .optional(),
  fundingSummary: z.string().max(8_000).optional(),
  lastVerifiedAt: optionalDate
});
const toProgramDeadlines = (deadlines: NonNullable<z.infer<typeof programInput>["deadlines"]>) =>
  deadlines.map(({ id: deadlineId, label, dueAt }) => ({
    ...(deadlineId !== undefined ? { id: deadlineId } : {}),
    ...(label !== undefined ? { label } : {}),
    dueAt
  }));
const requirementInput = z.object({
  id: id.optional(),
  type: z.string().trim().max(80).optional(),
  label: z.string().trim().max(240).optional(),
  title: z.string().trim().max(240).optional(),
  status: z.enum(APPLICATION_REQUIREMENT_STATUSES).optional(),
  dueAt: optionalDate,
  notes: z.string().max(8_000).optional(),
  sourceId: id.nullable().optional()
});
const taskInput = z.object({
  id: id.optional(),
  cycleId: id.optional(),
  programId: id.nullable().optional(),
  title: z.string().trim().max(240).optional(),
  priority: z.enum(APPLICATION_TASK_PRIORITIES).optional(),
  dueAt: optionalDate,
  completed: z.boolean().optional(),
  status: z.string().optional()
});
const sourceInput = z.object({
  id: id.optional(),
  cycleId: id.optional(),
  url: z.string().trim().url().max(2_048).optional(),
  publisher: z.string().trim().max(240).optional(),
  title: z.string().trim().max(240).optional(),
  snippet: z.string().max(12_000).optional(),
  contentHash: z.string().max(128).optional(),
  verifiedAt: optionalDate,
  fetchedAt: optionalDate,
  programId: id.optional(),
  fieldName: z.string().trim().max(120).optional()
});
const artifactInput = z.object({
  id: id.optional(),
  cycleId: id.optional(),
  programId: id.nullable().optional(),
  type: z.string().trim().max(80).optional(),
  kind: z.string().trim().max(80).optional(),
  version: z.number().int().positive().optional(),
  fileName: z.string().trim().max(240).optional(),
  title: z.string().trim().max(240).optional(),
  relativePath: z.string().trim().max(1_024).optional()
});

export function registerAdmissionsRoutes(
  app: FastifyInstance,
  admissions: AdmissionsStore,
  config: AppConfig,
  onChange?: () => void
): void {
  const activeCycle = () => admissions.listCycles().find((cycle) => cycle.active) ?? admissions.listCycles()[0] ?? null;
  const cycleId = (requested?: string) => requested ?? activeCycle()?.id ?? null;
  app.addHook("onResponse", (request, reply, done) => {
    if (request.method !== "GET" && request.url.startsWith("/api/admissions") && reply.statusCode < 400) {
      onChange?.();
    }
    done();
  });

  app.get("/api/admissions/cycles", async () => ({ items: admissions.listCycles() }));
  app.post("/api/admissions/cycles", async (request, reply) => {
    const input = cycleInput.parse(request.body ?? {});
    const value = admissions.createCycle({
      name: input.name ?? "新的申请周期",
      degree: input.degree ?? "master",
      fieldOfStudy: input.fieldOfStudy ?? "",
      intakeTerm: input.intakeTerm ?? "",
      targetRegions: input.targetRegions ?? ["美国", "加拿大", "香港", "新加坡"],
      active: input.active ?? true
    });
    return reply.code(201).send(value);
  });
  app.patch("/api/admissions/cycles", async (request, reply) => {
    const input = cycleInput.parse(request.body ?? {});
    if (!input.id) return reply.code(400).send({ error: "Cycle id is required" });
    const cycle = input.id;
    const changes: Parameters<AdmissionsStore["updateCycle"]>[1] = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.degree !== undefined) changes.degree = input.degree;
    if (input.fieldOfStudy !== undefined) changes.fieldOfStudy = input.fieldOfStudy;
    if (input.intakeTerm !== undefined) changes.intakeTerm = input.intakeTerm;
    if (input.targetRegions !== undefined) changes.targetRegions = input.targetRegions;
    if (input.active !== undefined) changes.active = input.active;
    return admissions.updateCycle(cycle, changes) ?? reply.code(404).send({ error: "Cycle not found" });
  });
  app.delete("/api/admissions/cycles/:id", async (request, reply) => {
    const value = id.parse((request.params as { id: string }).id);
    return admissions.deleteCycle(value) ? reply.code(204).send() : reply.code(404).send({ error: "Cycle not found" });
  });

  app.get("/api/admissions/profile", async (request, reply) => {
    const selected = cycleId((request.query as { cycleId?: string }).cycleId);
    if (!selected) return reply.code(404).send({ error: "No application cycle" });
    const value = admissions.getApplicantProfile(selected);
    return value
      ? presentProfile(value, admissions.getCycle(selected))
      : reply.code(404).send({ error: "Applicant profile not found" });
  });
  app.post("/api/admissions/profile", async (request, reply) => {
    const input = profileInput.parse(request.body ?? {});
    const selected = cycleId(input.cycleId);
    if (!selected) return reply.code(400).send({ error: "Create an application cycle first" });
    if (admissions.getApplicantProfile(selected))
      return reply.code(409).send({ error: "Applicant profile already exists" });
    const value = admissions.createApplicantProfile({
      cycleId: selected,
      educationSummary: input.educationSummary ?? input.summary ?? "",
      researchSummary: input.researchSummary ?? "",
      exams: input.exams ?? [],
      budgetConstraints: input.budgetConstraints ?? ""
    });
    const cycle = admissions.getCycle(selected);
    if (cycle && (input.targetDegree || input.targetField || input.targetYear)) {
      admissions.updateCycle(selected, {
        ...(input.targetDegree ? { degree: input.targetDegree } : {}),
        ...(input.targetField ? { fieldOfStudy: input.targetField } : {}),
        ...(input.targetYear ? { intakeTerm: input.targetYear } : {})
      });
    }
    return reply.code(201).send(presentProfile(value, admissions.getCycle(selected)));
  });
  app.patch("/api/admissions/profile", async (request, reply) => {
    const input = profileInput.parse(request.body ?? {});
    const selected = cycleId(input.cycleId);
    if (!selected) return reply.code(404).send({ error: "No application cycle" });
    const current = admissions.getApplicantProfile(selected);
    if (!current) return reply.code(404).send({ error: "Applicant profile not found" });
    const value = admissions.updateApplicantProfile(current.id, {
      ...(input.educationSummary !== undefined || input.summary !== undefined
        ? { educationSummary: input.educationSummary ?? input.summary ?? "" }
        : {}),
      ...(input.researchSummary !== undefined ? { researchSummary: input.researchSummary } : {}),
      ...(input.exams !== undefined ? { exams: input.exams } : {}),
      ...(input.budgetConstraints !== undefined ? { budgetConstraints: input.budgetConstraints } : {})
    })!;
    const cycle = admissions.getCycle(selected);
    if (cycle && (input.targetDegree || input.targetField || input.targetYear)) {
      admissions.updateCycle(selected, {
        ...(input.targetDegree ? { degree: input.targetDegree } : {}),
        ...(input.targetField ? { fieldOfStudy: input.targetField } : {}),
        ...(input.targetYear ? { intakeTerm: input.targetYear } : {})
      });
    }
    return presentProfile(value, admissions.getCycle(selected));
  });

  app.get("/api/admissions/programs", async (request) => {
    const selected = cycleId((request.query as { cycleId?: string }).cycleId);
    return { items: selected ? admissions.listPrograms(selected).map(presentProgram) : [] };
  });
  app.post("/api/admissions/programs", async (request, reply) => {
    const input = programInput.parse(request.body ?? {});
    const selected = cycleId(input.cycleId);
    if (!selected) return reply.code(400).send({ error: "Create an application cycle first" });
    const school = input.school ?? input.institution ?? "";
    const program = input.program ?? input.name ?? "";
    if (!school || !program) return reply.code(400).send({ error: "School and program are required" });
    const value = admissions.createProgram({
      cycleId: selected,
      school,
      program,
      country: input.country ?? "",
      degree: input.degree ?? "",
      status: input.status ?? "researching",
      officialUrl: input.officialUrl ?? "",
      applicationFee: input.applicationFee ?? null,
      feeCurrency: input.feeCurrency ?? null,
      deadlineAt: input.deadlineAt ?? input.deadline ?? null,
      ...(input.deadlines ? { deadlines: toProgramDeadlines(input.deadlines) } : {}),
      fundingSummary: input.fundingSummary ?? "",
      lastVerifiedAt: input.lastVerifiedAt ?? null
    });
    return reply.code(201).send(presentProgram(value));
  });
  app.patch("/api/admissions/programs", async (request, reply) => {
    const input = programInput.parse(request.body ?? {});
    if (!input.id) return reply.code(400).send({ error: "Program id is required" });
    const programId = input.id;
    const changes: Parameters<AdmissionsStore["updateProgram"]>[1] = {};
    if (input.school !== undefined || input.institution !== undefined)
      changes.school = input.school ?? input.institution ?? "";
    if (input.program !== undefined || input.name !== undefined) changes.program = input.program ?? input.name ?? "";
    if (input.country !== undefined) changes.country = input.country;
    if (input.degree !== undefined) changes.degree = input.degree;
    if (input.status !== undefined) changes.status = input.status;
    if (input.officialUrl !== undefined) changes.officialUrl = input.officialUrl;
    if (input.applicationFee !== undefined) changes.applicationFee = input.applicationFee;
    if (input.feeCurrency !== undefined) changes.feeCurrency = input.feeCurrency;
    if (input.deadlineAt !== undefined || input.deadline !== undefined)
      changes.deadlineAt = input.deadlineAt ?? input.deadline ?? null;
    if (input.deadlines !== undefined) changes.deadlines = toProgramDeadlines(input.deadlines);
    if (input.fundingSummary !== undefined) changes.fundingSummary = input.fundingSummary;
    if (input.lastVerifiedAt !== undefined) changes.lastVerifiedAt = input.lastVerifiedAt;
    const value = admissions.updateProgram(programId, changes);
    return value ? presentProgram(value) : reply.code(404).send({ error: "Program not found" });
  });
  app.delete("/api/admissions/programs/:id", async (request, reply) => {
    const value = id.parse((request.params as { id: string }).id);
    return admissions.deleteProgram(value)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "Program not found" });
  });

  app.get("/api/admissions/programs/:programId/requirements", async (request) => {
    const programId = id.parse((request.params as { programId: string }).programId);
    return { items: admissions.listRequirements(programId).map(presentRequirement) };
  });
  app.post("/api/admissions/programs/:programId/requirements", async (request, reply) => {
    const programId = id.parse((request.params as { programId: string }).programId);
    const input = requirementInput.parse(request.body ?? {});
    const label = input.label ?? input.title ?? "";
    if (!label) return reply.code(400).send({ error: "Requirement title is required" });
    const value = admissions.createRequirement({
      programId,
      type: input.type ?? "document",
      label,
      status: input.status ?? "missing",
      dueAt: input.dueAt ?? null,
      notes: input.notes ?? "",
      sourceId: input.sourceId ?? null
    });
    return reply.code(201).send(presentRequirement(value));
  });
  app.patch("/api/admissions/programs/:programId/requirements", async (request, reply) => {
    id.parse((request.params as { programId: string }).programId);
    const input = requirementInput.parse(request.body ?? {});
    if (!input.id) return reply.code(400).send({ error: "Requirement id is required" });
    const requirementId = input.id;
    const changes: Parameters<AdmissionsStore["updateRequirement"]>[1] = {};
    if (input.type !== undefined) changes.type = input.type;
    if (input.label !== undefined || input.title !== undefined) changes.label = input.label ?? input.title ?? "";
    if (input.status !== undefined) changes.status = input.status;
    if (input.dueAt !== undefined) changes.dueAt = input.dueAt;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.sourceId !== undefined) changes.sourceId = input.sourceId;
    const value = admissions.updateRequirement(requirementId, changes);
    return value ? presentRequirement(value) : reply.code(404).send({ error: "Requirement not found" });
  });
  app.delete("/api/admissions/programs/:programId/requirements/:id", async (request, reply) => {
    const params = request.params as { programId: string; id: string };
    id.parse(params.programId);
    const value = id.parse(params.id);
    return admissions.deleteRequirement(value)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "Requirement not found" });
  });

  app.get("/api/admissions/tasks", async (request) => {
    const selected = cycleId((request.query as { cycleId?: string }).cycleId);
    return { items: selected ? admissions.listTasks(selected).map(presentTask) : [] };
  });
  app.post("/api/admissions/tasks", async (request, reply) => {
    const input = taskInput.parse(request.body ?? {});
    const selected = cycleId(input.cycleId);
    if (!selected) return reply.code(400).send({ error: "Create an application cycle first" });
    if (!input.title) return reply.code(400).send({ error: "Task title is required" });
    const value = admissions.createTask({
      cycleId: selected,
      programId: input.programId ?? null,
      title: input.title,
      priority: input.priority ?? "medium",
      dueAt: input.dueAt ?? null,
      completed: input.completed ?? input.status === "completed"
    });
    return reply.code(201).send(presentTask(value));
  });
  app.patch("/api/admissions/tasks", async (request, reply) => {
    const input = taskInput.parse(request.body ?? {});
    if (!input.id) return reply.code(400).send({ error: "Task id is required" });
    const taskId = input.id;
    const changes: Parameters<AdmissionsStore["updateTask"]>[1] = {};
    if (input.programId !== undefined) changes.programId = input.programId;
    if (input.title !== undefined) changes.title = input.title;
    if (input.priority !== undefined) changes.priority = input.priority;
    if (input.dueAt !== undefined) changes.dueAt = input.dueAt;
    if (input.completed !== undefined || input.status !== undefined)
      changes.completed = input.completed ?? input.status === "completed";
    const value = admissions.updateTask(taskId, changes);
    return value ? presentTask(value) : reply.code(404).send({ error: "Task not found" });
  });
  app.delete("/api/admissions/tasks/:id", async (request, reply) => {
    const value = id.parse((request.params as { id: string }).id);
    return admissions.deleteTask(value) ? reply.code(204).send() : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/admissions/sources", async (request) => {
    const selected = cycleId((request.query as { cycleId?: string }).cycleId);
    return {
      items: selected ? admissions.listSources(selected).map((source) => presentSource(source, admissions)) : []
    };
  });
  app.post("/api/admissions/sources", async (request, reply) => {
    const input = sourceInput.parse(request.body ?? {});
    const selected = cycleId(input.cycleId);
    if (!selected || !input.url) return reply.code(400).send({ error: "Cycle and source URL are required" });
    const now = new Date().toISOString();
    const value = admissions.createSource({
      cycleId: selected,
      url: input.url,
      publisher: input.publisher ?? input.title ?? new URL(input.url).hostname,
      snippet: input.snippet ?? "",
      contentHash:
        input.contentHash ??
        createHash("sha256")
          .update(`${input.url}\n${input.snippet ?? ""}`)
          .digest("hex"),
      verifiedAt: input.verifiedAt ?? now,
      fetchedAt: input.fetchedAt ?? now
    });
    if (input.programId) {
      admissions.linkSource({
        sourceId: value.id,
        targetType: "program",
        targetId: input.programId,
        fieldName: input.fieldName ?? "general"
      });
    }
    return reply.code(201).send(presentSource(value, admissions));
  });
  app.patch("/api/admissions/sources", async (request, reply) => {
    const input = sourceInput.parse(request.body ?? {});
    if (!input.id) return reply.code(400).send({ error: "Source id is required" });
    const sourceId = input.id;
    const changes: Parameters<AdmissionsStore["updateSource"]>[1] = {};
    if (input.url !== undefined) changes.url = input.url;
    if (input.publisher !== undefined || input.title !== undefined)
      changes.publisher = input.publisher ?? input.title ?? "";
    if (input.snippet !== undefined) changes.snippet = input.snippet;
    if (input.contentHash !== undefined) changes.contentHash = input.contentHash;
    if (input.verifiedAt !== undefined) changes.verifiedAt = input.verifiedAt ?? new Date().toISOString();
    if (input.fetchedAt !== undefined) changes.fetchedAt = input.fetchedAt ?? new Date().toISOString();
    const value = admissions.updateSource(sourceId, changes);
    return value ? presentSource(value, admissions) : reply.code(404).send({ error: "Source not found" });
  });
  app.delete("/api/admissions/sources/:id", async (request, reply) => {
    const value = id.parse((request.params as { id: string }).id);
    return admissions.deleteSource(value)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "Source not found" });
  });

  app.get("/api/admissions/artifacts", async (request) => {
    const selected = cycleId((request.query as { cycleId?: string }).cycleId);
    return { items: selected ? admissions.listArtifacts(selected).map(presentArtifact) : [] };
  });
  app.post("/api/admissions/artifacts", async (request, reply) => {
    const input = artifactInput.parse(request.body ?? {});
    const selected = cycleId(input.cycleId);
    const type = input.type ?? input.kind ?? "document";
    const fileName = input.fileName ?? input.title ?? "document.md";
    if (!selected || !input.relativePath)
      return reply.code(400).send({ error: "Cycle and artifact path are required" });
    const value = admissions.createArtifact({
      cycleId: selected,
      programId: input.programId ?? null,
      type,
      version: input.version ?? 1,
      fileName,
      relativePath: input.relativePath
    });
    return reply.code(201).send(presentArtifact(value));
  });
  app.patch("/api/admissions/artifacts", async (request, reply) => {
    const input = artifactInput.parse(request.body ?? {});
    if (!input.id) return reply.code(400).send({ error: "Artifact id is required" });
    const changes: Parameters<AdmissionsStore["updateArtifact"]>[1] = {};
    if (input.programId !== undefined) changes.programId = input.programId;
    if (input.type !== undefined || input.kind !== undefined) changes.type = input.type ?? input.kind ?? "document";
    if (input.version !== undefined) changes.version = input.version;
    if (input.fileName !== undefined || input.title !== undefined)
      changes.fileName = input.fileName ?? input.title ?? "document.md";
    if (input.relativePath !== undefined) changes.relativePath = input.relativePath;
    const value = admissions.updateArtifact(input.id, changes);
    return value ? presentArtifact(value) : reply.code(404).send({ error: "Artifact not found" });
  });
  app.delete("/api/admissions/artifacts/:id", async (request, reply) => {
    const value = id.parse((request.params as { id: string }).id);
    return admissions.deleteArtifact(value)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "Artifact not found" });
  });
  app.get("/api/admissions/artifacts/:id/download", async (request, reply) => {
    const artifact = admissions.getArtifact(id.parse((request.params as { id: string }).id));
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    const root = path.resolve(config.workspaceRoot, ".admissions-artifacts");
    const absolute = path.resolve(root, artifact.relativePath);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      return reply.code(400).send({ error: "Invalid artifact path" });
    }
    if (!fs.existsSync(absolute)) return reply.code(404).send({ error: "Artifact file not found" });
    return reply
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`)
      .send(fs.createReadStream(absolute));
  });
}

function presentProfile(
  value: ReturnType<AdmissionsStore["getApplicantProfile"]> extends infer T ? Exclude<T, null> : never,
  cycle: ReturnType<AdmissionsStore["getCycle"]>
) {
  return {
    ...value,
    targetDegree: cycle?.degree ?? "",
    targetField: cycle?.fieldOfStudy ?? "",
    targetYear: cycle?.intakeTerm ?? "",
    summary: value.educationSummary
  };
}

function presentProgram<T extends { program: string; school: string; deadlineAt: string | null }>(value: T) {
  return { ...value, name: value.program, institution: value.school, deadline: value.deadlineAt };
}

function presentRequirement<T extends { label: string }>(value: T) {
  return { ...value, title: value.label };
}

function presentTask<T extends { completed: boolean }>(value: T) {
  return { ...value, status: value.completed ? "completed" : "pending" };
}

function presentSource(
  value: ReturnType<AdmissionsStore["getSource"]> extends infer T ? Exclude<T, null> : never,
  _admissions: AdmissionsStore
) {
  const programId = _admissions
    .listTargetsForSource(value.id)
    .find((target) => target.targetType === "program")?.targetId;
  return { ...value, title: value.publisher, ...(programId ? { programId } : {}) };
}

function presentArtifact<T extends { fileName: string; type: string; updatedAt: string }>(value: T) {
  return { ...value, title: value.fileName, kind: value.type, status: "ready" };
}
