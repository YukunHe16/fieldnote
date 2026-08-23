import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SqliteDatabase } from "./database.js";

export const APPLICATION_PROGRAM_STATUSES = [
  "researching",
  "shortlisted",
  "applying",
  "submitted",
  "interview",
  "offer",
  "rejected",
  "withdrawn"
] as const;
export const APPLICATION_REQUIREMENT_STATUSES = ["missing", "in_progress", "ready", "submitted", "waived"] as const;
export const APPLICATION_TASK_PRIORITIES = ["low", "medium", "high"] as const;
export const APPLICATION_SOURCE_TARGETS = ["cycle", "profile", "program", "requirement", "task", "artifact"] as const;

export type ApplicationProgramStatus = (typeof APPLICATION_PROGRAM_STATUSES)[number];
export type ApplicationRequirementStatus = (typeof APPLICATION_REQUIREMENT_STATUSES)[number];
export type ApplicationTaskPriority = (typeof APPLICATION_TASK_PRIORITIES)[number];
export type ApplicationSourceTarget = (typeof APPLICATION_SOURCE_TARGETS)[number];

export interface ApplicationCycle {
  id: string;
  name: string;
  degree: string;
  fieldOfStudy: string;
  intakeTerm: string;
  targetRegions: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicantProfile {
  id: string;
  cycleId: string;
  educationSummary: string;
  researchSummary: string;
  exams: unknown;
  budgetConstraints: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationProgramDeadline {
  id: string;
  label: string;
  dueAt: string;
}

export interface ApplicationProgram {
  id: string;
  cycleId: string;
  school: string;
  program: string;
  country: string;
  degree: string;
  status: ApplicationProgramStatus;
  officialUrl: string;
  applicationFee: number | null;
  feeCurrency: string | null;
  deadlineAt: string | null;
  deadlines: ApplicationProgramDeadline[];
  fundingSummary: string;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type ProgramDeadlineInput = { id?: string; label?: string; dueAt: string | number | Date };
type ProgramWrite = Omit<ApplicationProgram, "id" | "createdAt" | "updatedAt" | "deadlines" | "deadlineAt"> & {
  deadlineAt?: string | number | Date | null;
  deadlines?: ProgramDeadlineInput[];
};

export interface ApplicationRequirement {
  id: string;
  programId: string;
  type: string;
  label: string;
  status: ApplicationRequirementStatus;
  dueAt: string | null;
  notes: string;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationTask {
  id: string;
  cycleId: string;
  programId: string | null;
  title: string;
  priority: ApplicationTaskPriority;
  dueAt: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationSource {
  id: string;
  cycleId: string;
  url: string;
  publisher: string;
  snippet: string;
  contentHash: string;
  verifiedAt: string;
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationArtifact {
  id: string;
  cycleId: string;
  programId: string | null;
  type: string;
  version: number;
  fileName: string;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationSourceLink {
  sourceId: string;
  targetType: ApplicationSourceTarget;
  targetId: string;
  fieldName: string;
}

export interface WeeklyReviewReadModel {
  changedSince: string;
  changes: Array<{
    type: "program" | "requirement" | "task" | "source" | "artifact";
    id: string;
    title: string;
    updatedAt: string;
  }>;
  upcomingDeadlines: PlanningDeadline[];
  missingRequirements: ApplicationRequirement[];
}

export interface DailyPlanReadModel {
  through: string;
  deadlines: PlanningDeadline[];
  missingRequirements: ApplicationRequirement[];
  openTasks: ApplicationTask[];
}

export interface PlanningDeadline {
  type: "program" | "requirement" | "task";
  id: string;
  title: string;
  dueAt: string;
  programId: string | null;
}

type CycleRow = {
  id: string;
  name: string;
  degree: string;
  field_of_study: string;
  intake_term: string;
  target_regions_json: string;
  active: number;
  created_at: number;
  updated_at: number;
};
type ProfileRow = {
  id: string;
  cycle_id: string;
  education_summary: string;
  research_summary: string;
  exams_json: string;
  budget_constraints: string;
  created_at: number;
  updated_at: number;
};
type ProgramRow = {
  id: string;
  cycle_id: string;
  school: string;
  program: string;
  country: string;
  degree: string;
  status: ApplicationProgramStatus;
  official_url: string;
  application_fee: number | null;
  fee_currency: string | null;
  deadline_at: number | null;
  deadlines_json: string;
  funding_summary: string;
  last_verified_at: number | null;
  created_at: number;
  updated_at: number;
};
type RequirementRow = {
  id: string;
  program_id: string;
  type: string;
  label: string;
  status: ApplicationRequirementStatus;
  due_at: number | null;
  notes: string;
  source_id: string | null;
  created_at: number;
  updated_at: number;
};
type TaskRow = {
  id: string;
  cycle_id: string;
  program_id: string | null;
  title: string;
  priority: ApplicationTaskPriority;
  due_at: number | null;
  completed: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};
type SourceRow = {
  id: string;
  cycle_id: string;
  url: string;
  publisher: string;
  snippet: string;
  content_hash: string;
  verified_at: number;
  fetched_at: number;
  created_at: number;
  updated_at: number;
};
type ArtifactRow = {
  id: string;
  cycle_id: string;
  program_id: string | null;
  type: string;
  version: number;
  file_name: string;
  relative_path: string;
  created_at: number;
  updated_at: number;
};

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS application_cycles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  degree TEXT NOT NULL,
  field_of_study TEXT NOT NULL DEFAULT '',
  intake_term TEXT NOT NULL DEFAULT '',
  target_regions_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applicant_profiles (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL UNIQUE REFERENCES application_cycles(id) ON DELETE CASCADE,
  education_summary TEXT NOT NULL DEFAULT '',
  research_summary TEXT NOT NULL DEFAULT '',
  exams_json TEXT NOT NULL DEFAULT '[]',
  budget_constraints TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS application_programs (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES application_cycles(id) ON DELETE CASCADE,
  school TEXT NOT NULL,
  program TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  degree TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('researching', 'shortlisted', 'applying', 'submitted', 'interview', 'offer', 'rejected', 'withdrawn')),
  official_url TEXT NOT NULL DEFAULT '',
  application_fee REAL,
  fee_currency TEXT,
  deadline_at INTEGER,
  deadlines_json TEXT NOT NULL DEFAULT '[]',
  funding_summary TEXT NOT NULL DEFAULT '',
  last_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_programs_cycle ON application_programs(cycle_id, status, deadline_at);

CREATE TABLE IF NOT EXISTS application_sources (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES application_cycles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  publisher TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  verified_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(cycle_id, url)
);
CREATE INDEX IF NOT EXISTS idx_application_sources_cycle_verified ON application_sources(cycle_id, verified_at DESC);

CREATE TABLE IF NOT EXISTS application_requirements (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES application_programs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('missing', 'in_progress', 'ready', 'submitted', 'waived')),
  due_at INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  source_id TEXT REFERENCES application_sources(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_requirements_program ON application_requirements(program_id, status, due_at);

CREATE TABLE IF NOT EXISTS application_tasks (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES application_cycles(id) ON DELETE CASCADE,
  program_id TEXT REFERENCES application_programs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  due_at INTEGER,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_tasks_cycle_due ON application_tasks(cycle_id, completed, due_at);

CREATE TABLE IF NOT EXISTS application_artifacts (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES application_cycles(id) ON DELETE CASCADE,
  program_id TEXT REFERENCES application_programs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(cycle_id, program_id, type, version)
);
CREATE INDEX IF NOT EXISTS idx_application_artifacts_cycle ON application_artifacts(cycle_id, type, version DESC);

CREATE TABLE IF NOT EXISTS application_source_links (
  source_id TEXT NOT NULL REFERENCES application_sources(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('cycle', 'profile', 'program', 'requirement', 'task', 'artifact')),
  target_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  PRIMARY KEY(source_id, target_type, target_id, field_name)
);
CREATE INDEX IF NOT EXISTS idx_application_source_links_target ON application_source_links(target_type, target_id);

CREATE TRIGGER IF NOT EXISTS application_program_source_links_delete AFTER DELETE ON application_programs BEGIN
  DELETE FROM application_source_links WHERE target_type = 'program' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS application_requirement_source_links_delete AFTER DELETE ON application_requirements BEGIN
  DELETE FROM application_source_links WHERE target_type = 'requirement' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS application_task_source_links_delete AFTER DELETE ON application_tasks BEGIN
  DELETE FROM application_source_links WHERE target_type = 'task' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS application_artifact_source_links_delete AFTER DELETE ON application_artifacts BEGIN
  DELETE FROM application_source_links WHERE target_type = 'artifact' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS applicant_profile_source_links_delete AFTER DELETE ON applicant_profiles BEGIN
  DELETE FROM application_source_links WHERE target_type = 'profile' AND target_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS application_cycle_source_links_delete AFTER DELETE ON application_cycles BEGIN
  DELETE FROM application_source_links WHERE target_type = 'cycle' AND target_id = old.id;
END;
`;

const DEADLINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso = (value: number): string => new Date(value).toISOString();
const timestamp = (value: string | Date | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error("Invalid timestamp");
  return parsed;
};
function writeDeadlines(value: ProgramDeadlineInput[]): ApplicationProgramDeadline[] {
  if (value.length > 12) throw new Error("A programme can have at most 12 deadlines");
  return value
    .map((item) => {
      const due = timestamp(item.dueAt);
      if (due === null) throw new Error("Programme deadline is required");
      return {
        id: item.id && DEADLINE_ID.test(item.id) ? item.id : randomUUID(),
        label: (item.label ?? "").trim().slice(0, 80),
        dueAt: iso(due)
      };
    })
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}
function readDeadlines(value: unknown): ApplicationProgramDeadline[] {
  if (!Array.isArray(value)) return [];
  const items: ApplicationProgramDeadline[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; label?: unknown; dueAt?: unknown };
    try {
      const due = timestamp(typeof record.dueAt === "string" || typeof record.dueAt === "number" ? record.dueAt : null);
      if (due === null) continue;
      items.push({
        id: typeof record.id === "string" && DEADLINE_ID.test(record.id) ? record.id : randomUUID(),
        label: typeof record.label === "string" ? record.label.trim().slice(0, 80) : "",
        dueAt: iso(due)
      });
    } catch {}
  }
  return items.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}
function resolveDeadlines(input: {
  deadlines?: ProgramDeadlineInput[];
  deadlineAt?: string | number | Date | null;
  current?: ApplicationProgramDeadline[];
}): ApplicationProgramDeadline[] {
  if (input.deadlines !== undefined) return writeDeadlines(input.deadlines);
  if (input.deadlineAt !== undefined) {
    const current = input.current ?? [];
    if (input.deadlineAt === null || input.deadlineAt === "") return current.length <= 1 ? [] : current;
    if (current.length <= 1) {
      return writeDeadlines([
        {
          ...(current[0] ? { id: current[0].id } : {}),
          label: current[0]?.label ?? "",
          dueAt: input.deadlineAt
        }
      ]);
    }
    return current;
  }
  return input.current ?? [];
}
function nextDeadlineAt(deadlines: ApplicationProgramDeadline[], now: number): string | null {
  if (!deadlines.length) return null;
  return deadlines.find((item) => Date.parse(item.dueAt) >= now)?.dueAt ?? deadlines[deadlines.length - 1]!.dueAt;
}
function migrateProgramDeadlines(database: SqliteDatabase) {
  const columns = database.prepare("PRAGMA table_info(application_programs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "deadlines_json")) {
    database.exec("ALTER TABLE application_programs ADD COLUMN deadlines_json TEXT NOT NULL DEFAULT '[]'");
  }
  const rows = database.prepare("SELECT id, deadline_at, deadlines_json FROM application_programs").all() as Array<{
    id: string;
    deadline_at: number | null;
    deadlines_json: string | null;
  }>;
  const update = database.prepare("UPDATE application_programs SET deadlines_json = ? WHERE id = ?");
  for (const row of rows) {
    if (readDeadlines(parseJson(row.deadlines_json ?? "[]")).length) continue;
    if (row.deadline_at === null) continue;
    update.run(JSON.stringify([{ id: randomUUID(), label: "", dueAt: iso(row.deadline_at) }]), row.id);
  }
}
const json = (value: unknown): string => JSON.stringify(value ?? []);
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
};
function assertOneOf<T extends readonly string[]>(value: string, values: T, name: string): asserts value is T[number] {
  if (!values.includes(value)) throw new Error(`Invalid ${name}: ${value}`);
}

const REGION_ALIASES: Record<string, string> = {
  美国: "美国",
  usa: "美国",
  us: "美国",
  "united states": "美国",
  加拿大: "加拿大",
  canada: "加拿大",
  香港: "香港",
  "hong kong": "香港",
  hk: "香港",
  新加坡: "新加坡",
  singapore: "新加坡",
  sg: "新加坡"
};

export function canonicalizeTargetRegions(regions: string[]): string[] {
  return [
    ...new Set(
      regions
        .map((region) => REGION_ALIASES[region.trim().toLowerCase()] ?? REGION_ALIASES[region.trim()] ?? region.trim())
        .filter(Boolean)
    )
  ];
}

/** Accepts only storage-relative POSIX paths; file resolution belongs to the artifact service. */
export function cleanArtifactRelativePath(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate.includes("\\") || candidate.includes("\0") || path.posix.isAbsolute(candidate)) {
    throw new Error("Artifact path must be a clean relative path");
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== candidate) {
    throw new Error("Artifact path must be a clean relative path");
  }
  return normalized;
}

export class AdmissionsStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.database.exec(schema);
    migrateProgramDeadlines(this.database);
  }

  createCycle(input: Omit<ApplicationCycle, "id" | "createdAt" | "updatedAt">): ApplicationCycle {
    const id = randomUUID();
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO application_cycles (id, name, degree, field_of_study, intake_term, target_regions_json, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name.trim(),
        input.degree.trim(),
        input.fieldOfStudy.trim(),
        input.intakeTerm.trim(),
        json(canonicalizeTargetRegions(input.targetRegions)),
        input.active ? 1 : 0,
        now,
        now
      );
    return this.requireCycle(id);
  }

  getCycle(id: string): ApplicationCycle | null {
    const row = this.database.prepare("SELECT * FROM application_cycles WHERE id = ?").get(id) as CycleRow | undefined;
    return row ? this.toCycle(row) : null;
  }

  listCycles(): ApplicationCycle[] {
    return (
      this.database
        .prepare("SELECT * FROM application_cycles ORDER BY active DESC, updated_at DESC")
        .all() as CycleRow[]
    ).map((row) => this.toCycle(row));
  }

  updateCycle(
    id: string,
    input: Partial<Omit<ApplicationCycle, "id" | "createdAt" | "updatedAt">>
  ): ApplicationCycle | null {
    const current = this.getCycle(id);
    if (!current) return null;
    const next = {
      ...current,
      ...input,
      targetRegions: canonicalizeTargetRegions(input.targetRegions ?? current.targetRegions)
    };
    this.database
      .prepare(
        `UPDATE application_cycles SET name = ?, degree = ?, field_of_study = ?, intake_term = ?, target_regions_json = ?, active = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.name.trim(),
        next.degree.trim(),
        next.fieldOfStudy.trim(),
        next.intakeTerm.trim(),
        json(next.targetRegions),
        next.active ? 1 : 0,
        this.clock(),
        id
      );
    return this.requireCycle(id);
  }

  deleteCycle(id: string): boolean {
    return this.database.prepare("DELETE FROM application_cycles WHERE id = ?").run(id).changes > 0;
  }

  createApplicantProfile(input: Omit<ApplicantProfile, "id" | "createdAt" | "updatedAt">): ApplicantProfile {
    const id = randomUUID();
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO applicant_profiles (id, cycle_id, education_summary, research_summary, exams_json, budget_constraints, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.cycleId,
        input.educationSummary,
        input.researchSummary,
        json(input.exams),
        input.budgetConstraints,
        now,
        now
      );
    return this.requireProfile(id);
  }

  getApplicantProfile(cycleId: string): ApplicantProfile | null {
    const row = this.database.prepare("SELECT * FROM applicant_profiles WHERE cycle_id = ?").get(cycleId) as
      | ProfileRow
      | undefined;
    return row ? this.toProfile(row) : null;
  }

  updateApplicantProfile(
    id: string,
    input: Partial<Omit<ApplicantProfile, "id" | "cycleId" | "createdAt" | "updatedAt">>
  ): ApplicantProfile | null {
    const row = this.database.prepare("SELECT * FROM applicant_profiles WHERE id = ?").get(id) as
      | ProfileRow
      | undefined;
    if (!row) return null;
    const current = this.toProfile(row);
    const next = { ...current, ...input };
    this.database
      .prepare(
        `UPDATE applicant_profiles SET education_summary = ?, research_summary = ?, exams_json = ?, budget_constraints = ?, updated_at = ? WHERE id = ?`
      )
      .run(next.educationSummary, next.researchSummary, json(next.exams), next.budgetConstraints, this.clock(), id);
    return this.requireProfile(id);
  }

  deleteApplicantProfile(id: string): boolean {
    return this.database.prepare("DELETE FROM applicant_profiles WHERE id = ?").run(id).changes > 0;
  }

  createProgram(input: ProgramWrite): ApplicationProgram {
    assertOneOf(input.status, APPLICATION_PROGRAM_STATUSES, "program status");
    const id = randomUUID();
    const now = this.clock();
    const deadlines = resolveDeadlines({
      ...(input.deadlines !== undefined ? { deadlines: input.deadlines } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {})
    });
    this.database
      .prepare(
        `INSERT INTO application_programs
       (id, cycle_id, school, program, country, degree, status, official_url, application_fee, fee_currency, deadline_at, deadlines_json, funding_summary, last_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.cycleId,
        input.school.trim(),
        input.program.trim(),
        input.country.trim(),
        input.degree.trim(),
        input.status,
        input.officialUrl.trim(),
        input.applicationFee,
        input.feeCurrency?.trim() || null,
        timestamp(nextDeadlineAt(deadlines, now)),
        json(deadlines),
        input.fundingSummary,
        timestamp(input.lastVerifiedAt),
        now,
        now
      );
    return this.requireProgram(id);
  }

  getProgram(id: string): ApplicationProgram | null {
    const row = this.database.prepare("SELECT * FROM application_programs WHERE id = ?").get(id) as
      | ProgramRow
      | undefined;
    return row ? this.toProgram(row) : null;
  }

  listPrograms(cycleId: string): ApplicationProgram[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM application_programs WHERE cycle_id = ? ORDER BY deadline_at IS NULL, deadline_at ASC, school ASC"
        )
        .all(cycleId) as ProgramRow[]
    ).map((row) => this.toProgram(row));
  }

  updateProgram(id: string, input: Partial<Omit<ProgramWrite, "cycleId">>): ApplicationProgram | null {
    const current = this.getProgram(id);
    if (!current) return null;
    const next = { ...current, ...input };
    assertOneOf(next.status, APPLICATION_PROGRAM_STATUSES, "program status");
    const deadlines = resolveDeadlines({
      ...(input.deadlines !== undefined ? { deadlines: input.deadlines } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      current: current.deadlines
    });
    const now = this.clock();
    this.database
      .prepare(
        `UPDATE application_programs SET school = ?, program = ?, country = ?, degree = ?, status = ?, official_url = ?, application_fee = ?, fee_currency = ?, deadline_at = ?, deadlines_json = ?, funding_summary = ?, last_verified_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.school.trim(),
        next.program.trim(),
        next.country.trim(),
        next.degree.trim(),
        next.status,
        next.officialUrl.trim(),
        next.applicationFee,
        next.feeCurrency?.trim() || null,
        timestamp(nextDeadlineAt(deadlines, now)),
        json(deadlines),
        next.fundingSummary,
        timestamp(next.lastVerifiedAt),
        now,
        id
      );
    return this.requireProgram(id);
  }

  deleteProgram(id: string): boolean {
    return this.database.prepare("DELETE FROM application_programs WHERE id = ?").run(id).changes > 0;
  }

  createRequirement(input: Omit<ApplicationRequirement, "id" | "createdAt" | "updatedAt">): ApplicationRequirement {
    assertOneOf(input.status, APPLICATION_REQUIREMENT_STATUSES, "requirement status");
    this.assertRequirementSource(input.programId, input.sourceId);
    const id = randomUUID();
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO application_requirements (id, program_id, type, label, status, due_at, notes, source_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.programId,
        input.type.trim(),
        input.label.trim(),
        input.status,
        timestamp(input.dueAt),
        input.notes,
        input.sourceId,
        now,
        now
      );
    return this.requireRequirement(id);
  }

  getRequirement(id: string): ApplicationRequirement | null {
    const row = this.database.prepare("SELECT * FROM application_requirements WHERE id = ?").get(id) as
      | RequirementRow
      | undefined;
    return row ? this.toRequirement(row) : null;
  }

  listRequirements(programId: string): ApplicationRequirement[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM application_requirements WHERE program_id = ? ORDER BY due_at IS NULL, due_at ASC, label ASC"
        )
        .all(programId) as RequirementRow[]
    ).map((row) => this.toRequirement(row));
  }

  updateRequirement(
    id: string,
    input: Partial<Omit<ApplicationRequirement, "id" | "programId" | "createdAt" | "updatedAt">>
  ): ApplicationRequirement | null {
    const current = this.getRequirement(id);
    if (!current) return null;
    const next = { ...current, ...input };
    assertOneOf(next.status, APPLICATION_REQUIREMENT_STATUSES, "requirement status");
    this.assertRequirementSource(current.programId, next.sourceId);
    this.database
      .prepare(
        `UPDATE application_requirements SET type = ?, label = ?, status = ?, due_at = ?, notes = ?, source_id = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.type.trim(),
        next.label.trim(),
        next.status,
        timestamp(next.dueAt),
        next.notes,
        next.sourceId,
        this.clock(),
        id
      );
    return this.requireRequirement(id);
  }

  deleteRequirement(id: string): boolean {
    return this.database.prepare("DELETE FROM application_requirements WHERE id = ?").run(id).changes > 0;
  }

  createTask(input: Omit<ApplicationTask, "id" | "createdAt" | "updatedAt" | "completedAt">): ApplicationTask {
    assertOneOf(input.priority, APPLICATION_TASK_PRIORITIES, "task priority");
    this.assertTaskProgram(input.cycleId, input.programId);
    const id = randomUUID();
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO application_tasks (id, cycle_id, program_id, title, priority, due_at, completed, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.cycleId,
        input.programId,
        input.title.trim(),
        input.priority,
        timestamp(input.dueAt),
        input.completed ? 1 : 0,
        input.completed ? now : null,
        now,
        now
      );
    return this.requireTask(id);
  }

  getTask(id: string): ApplicationTask | null {
    const row = this.database.prepare("SELECT * FROM application_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? this.toTask(row) : null;
  }

  listTasks(cycleId: string, options: { completed?: boolean } = {}): ApplicationTask[] {
    const completed = options.completed;
    const sql =
      completed === undefined
        ? "SELECT * FROM application_tasks WHERE cycle_id = ? ORDER BY completed ASC, due_at IS NULL, due_at ASC, priority DESC"
        : "SELECT * FROM application_tasks WHERE cycle_id = ? AND completed = ? ORDER BY due_at IS NULL, due_at ASC, priority DESC";
    const rows = (
      completed === undefined
        ? this.database.prepare(sql).all(cycleId)
        : this.database.prepare(sql).all(cycleId, completed ? 1 : 0)
    ) as TaskRow[];
    return rows.map((row) => this.toTask(row));
  }

  updateTask(
    id: string,
    input: Partial<Omit<ApplicationTask, "id" | "cycleId" | "createdAt" | "updatedAt" | "completedAt">>
  ): ApplicationTask | null {
    const current = this.getTask(id);
    if (!current) return null;
    const next = { ...current, ...input };
    assertOneOf(next.priority, APPLICATION_TASK_PRIORITIES, "task priority");
    this.assertTaskProgram(current.cycleId, next.programId);
    const now = this.clock();
    this.database
      .prepare(
        `UPDATE application_tasks SET program_id = ?, title = ?, priority = ?, due_at = ?, completed = ?, completed_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.programId,
        next.title.trim(),
        next.priority,
        timestamp(next.dueAt),
        next.completed ? 1 : 0,
        next.completed ? (current.completedAt ? timestamp(current.completedAt) : now) : null,
        now,
        id
      );
    return this.requireTask(id);
  }

  deleteTask(id: string): boolean {
    return this.database.prepare("DELETE FROM application_tasks WHERE id = ?").run(id).changes > 0;
  }

  createSource(input: Omit<ApplicationSource, "id" | "createdAt" | "updatedAt">): ApplicationSource {
    const id = randomUUID();
    const now = this.clock();
    const result = this.database
      .prepare(
        `INSERT INTO application_sources (id, cycle_id, url, publisher, snippet, content_hash, verified_at, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.cycleId,
        input.url.trim(),
        input.publisher.trim(),
        input.snippet,
        input.contentHash,
        timestamp(input.verifiedAt) ?? now,
        timestamp(input.fetchedAt) ?? now,
        now,
        now
      );
    if (result.changes === 0) throw new Error("Unable to create application source");
    return this.requireSource(id);
  }

  getSource(id: string): ApplicationSource | null {
    const row = this.database.prepare("SELECT * FROM application_sources WHERE id = ?").get(id) as
      | SourceRow
      | undefined;
    return row ? this.toSource(row) : null;
  }

  findSourceByUrl(cycleId: string, url: string): ApplicationSource | null {
    const row = this.database
      .prepare("SELECT * FROM application_sources WHERE cycle_id = ? AND url = ?")
      .get(cycleId, url.trim()) as SourceRow | undefined;
    return row ? this.toSource(row) : null;
  }

  upsertSource(input: Omit<ApplicationSource, "id" | "createdAt" | "updatedAt">): ApplicationSource {
    const existing = this.findSourceByUrl(input.cycleId, input.url);
    return existing
      ? this.updateSource(existing.id, {
          url: input.url,
          publisher: input.publisher,
          snippet: input.snippet,
          contentHash: input.contentHash,
          verifiedAt: input.verifiedAt,
          fetchedAt: input.fetchedAt
        })!
      : this.createSource(input);
  }

  listSources(cycleId: string): ApplicationSource[] {
    return (
      this.database
        .prepare("SELECT * FROM application_sources WHERE cycle_id = ? ORDER BY verified_at DESC")
        .all(cycleId) as SourceRow[]
    ).map((row) => this.toSource(row));
  }

  updateSource(
    id: string,
    input: Partial<Omit<ApplicationSource, "id" | "cycleId" | "createdAt" | "updatedAt">>
  ): ApplicationSource | null {
    const current = this.getSource(id);
    if (!current) return null;
    const next = { ...current, ...input };
    this.database
      .prepare(
        `UPDATE application_sources SET url = ?, publisher = ?, snippet = ?, content_hash = ?, verified_at = ?, fetched_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.url.trim(),
        next.publisher.trim(),
        next.snippet,
        next.contentHash,
        timestamp(next.verifiedAt),
        timestamp(next.fetchedAt),
        this.clock(),
        id
      );
    return this.requireSource(id);
  }

  deleteSource(id: string): boolean {
    return this.database.prepare("DELETE FROM application_sources WHERE id = ?").run(id).changes > 0;
  }

  createArtifact(input: Omit<ApplicationArtifact, "id" | "createdAt" | "updatedAt">): ApplicationArtifact {
    this.assertTaskProgram(input.cycleId, input.programId);
    if (!Number.isInteger(input.version) || input.version < 1)
      throw new Error("Artifact version must be a positive integer");
    const id = randomUUID();
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO application_artifacts (id, cycle_id, program_id, type, version, file_name, relative_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.cycleId,
        input.programId,
        input.type.trim(),
        input.version,
        input.fileName.trim(),
        cleanArtifactRelativePath(input.relativePath),
        now,
        now
      );
    return this.requireArtifact(id);
  }

  getArtifact(id: string): ApplicationArtifact | null {
    const row = this.database.prepare("SELECT * FROM application_artifacts WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
    return row ? this.toArtifact(row) : null;
  }

  listArtifacts(cycleId: string, programId?: string): ApplicationArtifact[] {
    const rows = (
      programId === undefined
        ? this.database
            .prepare("SELECT * FROM application_artifacts WHERE cycle_id = ? ORDER BY type ASC, version DESC")
            .all(cycleId)
        : this.database
            .prepare(
              "SELECT * FROM application_artifacts WHERE cycle_id = ? AND program_id = ? ORDER BY type ASC, version DESC"
            )
            .all(cycleId, programId)
    ) as ArtifactRow[];
    return rows.map((row) => this.toArtifact(row));
  }

  updateArtifact(
    id: string,
    input: Partial<Omit<ApplicationArtifact, "id" | "cycleId" | "createdAt" | "updatedAt">>
  ): ApplicationArtifact | null {
    const current = this.getArtifact(id);
    if (!current) return null;
    const next = { ...current, ...input };
    this.assertTaskProgram(current.cycleId, next.programId);
    if (!Number.isInteger(next.version) || next.version < 1)
      throw new Error("Artifact version must be a positive integer");
    this.database
      .prepare(
        `UPDATE application_artifacts SET program_id = ?, type = ?, version = ?, file_name = ?, relative_path = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        next.programId,
        next.type.trim(),
        next.version,
        next.fileName.trim(),
        cleanArtifactRelativePath(next.relativePath),
        this.clock(),
        id
      );
    return this.requireArtifact(id);
  }

  deleteArtifact(id: string): boolean {
    return this.database.prepare("DELETE FROM application_artifacts WHERE id = ?").run(id).changes > 0;
  }

  linkSource(input: ApplicationSourceLink): void {
    assertOneOf(input.targetType, APPLICATION_SOURCE_TARGETS, "source target");
    const source = this.getSource(input.sourceId);
    if (!source) throw new Error("Application source not found");
    const cycleId = this.targetCycleId(input.targetType, input.targetId);
    if (!cycleId) throw new Error("Application source target not found");
    if (cycleId !== source.cycleId) throw new Error("Application source and target must belong to the same cycle");
    this.database
      .prepare(
        `INSERT OR IGNORE INTO application_source_links (source_id, target_type, target_id, field_name) VALUES (?, ?, ?, ?)`
      )
      .run(input.sourceId, input.targetType, input.targetId, input.fieldName.trim());
  }

  listSourceLinks(targetType: ApplicationSourceTarget, targetId: string): ApplicationSourceLink[] {
    assertOneOf(targetType, APPLICATION_SOURCE_TARGETS, "source target");
    return this.database
      .prepare(
        `SELECT source_id AS sourceId, target_type AS targetType, target_id AS targetId, field_name AS fieldName
       FROM application_source_links WHERE target_type = ? AND target_id = ? ORDER BY field_name ASC`
      )
      .all(targetType, targetId) as ApplicationSourceLink[];
  }

  listTargetsForSource(sourceId: string): ApplicationSourceLink[] {
    return this.database
      .prepare(
        `SELECT source_id AS sourceId, target_type AS targetType, target_id AS targetId, field_name AS fieldName
       FROM application_source_links WHERE source_id = ? ORDER BY target_type ASC, field_name ASC`
      )
      .all(sourceId) as ApplicationSourceLink[];
  }

  weeklyReview(cycleId: string, now = this.clock()): WeeklyReviewReadModel {
    const since = now - 7 * 24 * 60 * 60_000;
    return {
      changedSince: iso(since),
      changes: this.recentChanges(cycleId, since),
      upcomingDeadlines: this.deadlines(cycleId, now, now + 7 * 24 * 60 * 60_000),
      missingRequirements: this.gaps(cycleId)
    };
  }

  dailyPlan(cycleId: string, now = this.clock()): DailyPlanReadModel {
    const through = now + 30 * 24 * 60 * 60_000;
    return {
      through: iso(through),
      deadlines: this.deadlines(cycleId, now, through),
      missingRequirements: this.gaps(cycleId),
      openTasks: this.listTasks(cycleId, { completed: false })
    };
  }

  private assertRequirementSource(programId: string, sourceId: string | null): void {
    if (!sourceId) return;
    const program = this.getProgram(programId);
    const source = this.getSource(sourceId);
    if (!program || !source || program.cycleId !== source.cycleId)
      throw new Error("Requirement source must belong to the program cycle");
  }

  private assertTaskProgram(cycleId: string, programId: string | null): void {
    if (!programId) return;
    const program = this.getProgram(programId);
    if (!program || program.cycleId !== cycleId) throw new Error("Program must belong to the application cycle");
  }

  private targetCycleId(type: ApplicationSourceTarget, id: string): string | null {
    const statements: Record<ApplicationSourceTarget, string> = {
      cycle: "SELECT id AS cycle_id FROM application_cycles WHERE id = ?",
      profile: "SELECT cycle_id FROM applicant_profiles WHERE id = ?",
      program: "SELECT cycle_id FROM application_programs WHERE id = ?",
      requirement:
        "SELECT p.cycle_id FROM application_requirements r JOIN application_programs p ON p.id = r.program_id WHERE r.id = ?",
      task: "SELECT cycle_id FROM application_tasks WHERE id = ?",
      artifact: "SELECT cycle_id FROM application_artifacts WHERE id = ?"
    };
    return (this.database.prepare(statements[type]).get(id) as { cycle_id: string } | undefined)?.cycle_id ?? null;
  }

  private deadlines(cycleId: string, from: number, through: number): PlanningDeadline[] {
    const programItems = this.listPrograms(cycleId).flatMap((program) =>
      program.deadlines.flatMap((item) => {
        const due = Date.parse(item.dueAt);
        if (!Number.isFinite(due) || due < from || due > through) return [];
        return [
          {
            type: "program" as const,
            id: item.id,
            title: item.label
              ? `${program.school} · ${program.program} · ${item.label}`
              : `${program.school} · ${program.program}`,
            dueAt: item.dueAt,
            programId: program.id
          }
        ];
      })
    );
    const other = this.database
      .prepare(
        `SELECT type, id, title, due_at, program_id FROM (
        SELECT 'requirement' AS type, r.id, r.label AS title, r.due_at, r.program_id
          FROM application_requirements r JOIN application_programs p ON p.id = r.program_id
          WHERE p.cycle_id = ? AND r.due_at IS NOT NULL AND r.status NOT IN ('submitted', 'waived')
        UNION ALL
        SELECT 'task', id, title, due_at, program_id
          FROM application_tasks WHERE cycle_id = ? AND due_at IS NOT NULL AND completed = 0
      ) WHERE due_at >= ? AND due_at <= ?`
      )
      .all(cycleId, cycleId, from, through)
      .map((row) => {
        const value = row as {
          type: PlanningDeadline["type"];
          id: string;
          title: string;
          due_at: number;
          program_id: string | null;
        };
        return {
          type: value.type,
          id: value.id,
          title: value.title,
          dueAt: iso(value.due_at),
          programId: value.program_id
        };
      });
    return [...programItems, ...other].sort(
      (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.type.localeCompare(b.type)
    );
  }

  private gaps(cycleId: string): ApplicationRequirement[] {
    return (
      this.database
        .prepare(
          `SELECT r.* FROM application_requirements r JOIN application_programs p ON p.id = r.program_id
       WHERE p.cycle_id = ? AND r.status IN ('missing', 'in_progress') ORDER BY r.due_at IS NULL, r.due_at ASC, r.label ASC`
        )
        .all(cycleId) as RequirementRow[]
    ).map((row) => this.toRequirement(row));
  }

  private recentChanges(cycleId: string, since: number): WeeklyReviewReadModel["changes"] {
    const rows = this.database
      .prepare(
        `SELECT type, id, title, updated_at FROM (
        SELECT 'program' AS type, id, school || ' · ' || program AS title, updated_at FROM application_programs WHERE cycle_id = ?
        UNION ALL
        SELECT 'requirement', r.id, r.label, r.updated_at FROM application_requirements r JOIN application_programs p ON p.id = r.program_id WHERE p.cycle_id = ?
        UNION ALL
        SELECT 'task', id, title, updated_at FROM application_tasks WHERE cycle_id = ?
        UNION ALL
        SELECT 'source', id, publisher || ' · ' || url, updated_at FROM application_sources WHERE cycle_id = ?
        UNION ALL
        SELECT 'artifact', id, type || ' v' || version, updated_at FROM application_artifacts WHERE cycle_id = ?
      ) WHERE updated_at >= ? ORDER BY updated_at DESC, type ASC`
      )
      .all(cycleId, cycleId, cycleId, cycleId, cycleId, since) as Array<{
      type: WeeklyReviewReadModel["changes"][number]["type"];
      id: string;
      title: string;
      updated_at: number;
    }>;
    return rows.map((row) => ({ type: row.type, id: row.id, title: row.title, updatedAt: iso(row.updated_at) }));
  }

  private requireCycle(id: string): ApplicationCycle {
    const value = this.getCycle(id);
    if (!value) throw new Error("Application cycle not found");
    return value;
  }
  private requireProfile(id: string): ApplicantProfile {
    const row = this.database.prepare("SELECT * FROM applicant_profiles WHERE id = ?").get(id) as
      | ProfileRow
      | undefined;
    if (!row) throw new Error("Applicant profile not found");
    return this.toProfile(row);
  }
  private requireProgram(id: string): ApplicationProgram {
    const value = this.getProgram(id);
    if (!value) throw new Error("Application program not found");
    return value;
  }
  private requireRequirement(id: string): ApplicationRequirement {
    const value = this.getRequirement(id);
    if (!value) throw new Error("Application requirement not found");
    return value;
  }
  private requireTask(id: string): ApplicationTask {
    const value = this.getTask(id);
    if (!value) throw new Error("Application task not found");
    return value;
  }
  private requireSource(id: string): ApplicationSource {
    const value = this.getSource(id);
    if (!value) throw new Error("Application source not found");
    return value;
  }
  private requireArtifact(id: string): ApplicationArtifact {
    const value = this.getArtifact(id);
    if (!value) throw new Error("Application artifact not found");
    return value;
  }

  private toCycle(row: CycleRow): ApplicationCycle {
    return {
      id: row.id,
      name: row.name,
      degree: row.degree,
      fieldOfStudy: row.field_of_study,
      intakeTerm: row.intake_term,
      targetRegions: parseJson(row.target_regions_json) as string[],
      active: Boolean(row.active),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
  private toProfile(row: ProfileRow): ApplicantProfile {
    return {
      id: row.id,
      cycleId: row.cycle_id,
      educationSummary: row.education_summary,
      researchSummary: row.research_summary,
      exams: parseJson(row.exams_json),
      budgetConstraints: row.budget_constraints,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
  private toProgram(row: ProgramRow): ApplicationProgram {
    return {
      id: row.id,
      cycleId: row.cycle_id,
      school: row.school,
      program: row.program,
      country: row.country,
      degree: row.degree,
      status: row.status,
      officialUrl: row.official_url,
      applicationFee: row.application_fee,
      feeCurrency: row.fee_currency,
      deadlineAt: row.deadline_at === null ? null : iso(row.deadline_at),
      deadlines: readDeadlines(parseJson(row.deadlines_json ?? "[]")),
      fundingSummary: row.funding_summary,
      lastVerifiedAt: row.last_verified_at === null ? null : iso(row.last_verified_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
  private toRequirement(row: RequirementRow): ApplicationRequirement {
    return {
      id: row.id,
      programId: row.program_id,
      type: row.type,
      label: row.label,
      status: row.status,
      dueAt: row.due_at === null ? null : iso(row.due_at),
      notes: row.notes,
      sourceId: row.source_id,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
  private toTask(row: TaskRow): ApplicationTask {
    return {
      id: row.id,
      cycleId: row.cycle_id,
      programId: row.program_id,
      title: row.title,
      priority: row.priority,
      dueAt: row.due_at === null ? null : iso(row.due_at),
      completed: Boolean(row.completed),
      completedAt: row.completed_at === null ? null : iso(row.completed_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
  private toSource(row: SourceRow): ApplicationSource {
    return {
      id: row.id,
      cycleId: row.cycle_id,
      url: row.url,
      publisher: row.publisher,
      snippet: row.snippet,
      contentHash: row.content_hash,
      verifiedAt: iso(row.verified_at),
      fetchedAt: iso(row.fetched_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
  private toArtifact(row: ArtifactRow): ApplicationArtifact {
    return {
      id: row.id,
      cycleId: row.cycle_id,
      programId: row.program_id,
      type: row.type,
      version: row.version,
      fileName: row.file_name,
      relativePath: row.relative_path,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }
}
