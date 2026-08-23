import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { type AdmissionsStore, cleanArtifactRelativePath } from "./admissions-store.js";
import type { SchedulerStore } from "./scheduler-store.js";
import type { ScheduledJobRunner } from "./scheduler.js";
import { exportTextDocument } from "./document-export.js";

type FetchLike = typeof fetch;
type ResolveHost = (hostname: string) => Promise<string[]>;
const toProgramDeadlines = (deadlines: Array<{ label?: string | undefined; dueAt: string }>) =>
  deadlines.map(({ label, dueAt }) => ({
    ...(label !== undefined ? { label } : {}),
    dueAt
  }));

export interface AdmissionsToolContext {
  store: AdmissionsStore;
  config: AppConfig;
  workspacePath: string;
  fetchImpl?: FetchLike;
  resolveHost?: ResolveHost;
  schedulerStore?: SchedulerStore;
  schedulerRunner?: Pick<ScheduledJobRunner, "runNow">;
}

export function createAdmissionsMcpServers(context: AdmissionsToolContext) {
  const fetchImpl = context.fetchImpl ?? fetch;
  const resolveHost = context.resolveHost ?? resolvePublicAddresses;
  const activeCycle = (requested?: string) => {
    const cycle = requested
      ? context.store.getCycle(requested)
      : (context.store.listCycles().find((item) => item.active) ?? context.store.listCycles()[0] ?? null);
    if (!cycle) throw new Error("No application cycle exists. Create one in the admissions workspace first.");
    return cycle;
  };

  const evidence = createSdkMcpServer({
    name: "admissions_evidence",
    version: "1.0.0",
    instructions:
      "Use official sources for dynamic admissions facts. Store only concise evidence snippets and verification dates.",
    alwaysLoad: true,
    tools: [
      tool(
        "list_sources",
        "List saved official-source evidence for the active application cycle.",
        { cycleId: z.string().uuid().optional() },
        async ({ cycleId }) => toolJson(context.store.listSources(activeCycle(cycleId).id).slice(0, 100))
      ),
      tool(
        "search_official_sources",
        "Application-managed search fallback when built-in WebSearch is unavailable or returns no useful leads. Domains are optional and must not be invented. Fetch a result page before treating a claim as verified.",
        {
          query: z.string().min(1).max(500),
          domains: z.array(z.string().min(1).max(253)).max(8).optional(),
          limit: z.number().int().min(1).max(10).optional()
        },
        async ({ query, domains, limit }, extra) => {
          try {
            const signal = toolAbortSignal(extra);
            const normalizedDomains = (domains ?? []).map(normalizeSearchDomain);
            const normalizedQuery = normalizeSearchQuery(query);
            const results = await searchOfficialLeads(
              normalizedQuery,
              normalizedDomains,
              limit ?? 8,
              fetchImpl,
              resolveHost,
              signal
            );
            return toolJson({
              query: normalizedQuery,
              domains: normalizedDomains,
              results,
              note:
                results.length === 0
                  ? "No search leads. Retry with the official programme name, or use built-in WebSearch."
                  : "Search results are discovery leads. Fetch the official page before treating a claim as verified."
            });
          } catch (error) {
            return toolError(safeFetchError(error));
          }
        }
      ),
      tool(
        "fetch_official_page",
        "Fetch a public HTTP(S) page, return a concise text extract, and optionally save it as evidence. JavaScript shells still return metadata, embedded JSON, noscript text, and same-host candidate links. Never fetch private network addresses or pages containing applicant credentials.",
        {
          url: z.string().url().max(2_048),
          cycleId: z.string().uuid().optional(),
          publisher: z.string().max(240).optional(),
          save: z.boolean().optional()
        },
        async ({ url, cycleId, publisher, save }, extra) => {
          try {
            const page = await fetchPublicPage(url, fetchImpl, resolveHost, toolAbortSignal(extra));
            const cycle = cycleId
              ? activeCycle(cycleId)
              : (context.store.listCycles().find((item) => item.active) ?? context.store.listCycles()[0] ?? null);
            const canSave =
              save !== false && Boolean(cycle) && page.text.length > 0 && !(page.jsRendered && page.text.length < 80);
            const source =
              !canSave || !cycle
                ? null
                : context.store.upsertSource({
                    cycleId: cycle.id,
                    url: page.url,
                    publisher: publisher?.trim() || page.publisher,
                    snippet: page.text.slice(0, 6_000),
                    contentHash: page.contentHash,
                    verifiedAt: page.fetchedAt,
                    fetchedAt: page.fetchedAt
                  });
            return toolJson({
              url: page.url,
              publisher: source?.publisher ?? publisher ?? page.publisher,
              fetchedAt: page.fetchedAt,
              sourceId: source?.id ?? null,
              jsRendered: page.jsRendered,
              candidateLinks: page.candidateLinks,
              ...(!source && save !== false
                ? {
                    saveWarning: !cycle
                      ? "No application cycle exists, so this page was read but not saved to the admissions board."
                      : page.jsRendered
                        ? "The page looks JavaScript-rendered, so little static text was saved. Follow a candidate link or search for a static/PDF official page."
                        : "The page did not contain enough readable text to save as evidence."
                  }
                : {}),
              ...(page.jsRendered
                ? {
                    renderWarning:
                      "Static fetch found little body text. Follow candidateLinks, or use WebSearch/WebFetch for a static or PDF official page."
                  }
                : {}),
              text: page.text.slice(0, 12_000)
            });
          } catch (error) {
            return toolError(safeFetchError(error));
          }
        }
      ),
      tool(
        "save_source",
        "Save a concise verified official-source excerpt already obtained during research.",
        {
          url: z.string().url().max(2_048),
          publisher: z.string().min(1).max(240),
          snippet: z.string().min(1).max(12_000),
          cycleId: z.string().uuid().optional(),
          programId: z.string().uuid().optional(),
          fieldName: z.string().max(120).optional()
        },
        async ({ url, publisher, snippet, cycleId, programId, fieldName }) => {
          try {
            await assertPublicHttpUrl(url, resolveHost);
            const cycle = activeCycle(cycleId);
            const now = new Date().toISOString();
            const source = context.store.upsertSource({
              cycleId: cycle.id,
              url,
              publisher,
              snippet,
              contentHash: createHash("sha256").update(`${url}\n${snippet}`).digest("hex"),
              verifiedAt: now,
              fetchedAt: now
            });
            if (programId) {
              context.store.linkSource({
                sourceId: source.id,
                targetType: "program",
                targetId: programId,
                fieldName: fieldName ?? "general"
              });
            }
            return toolJson(source);
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      )
    ]
  });

  const academic = createSdkMcpServer({
    name: "academic_research",
    version: "1.0.0",
    instructions:
      "Academic metadata helps discover research fit but never proves current affiliation or admissions availability.",
    alwaysLoad: true,
    tools: [
      tool(
        "search_openalex",
        "Search OpenAlex works, authors, or institutions. Confirm faculty affiliation and recruiting status on an official university page afterward.",
        {
          query: z.string().min(1).max(300),
          entity: z.enum(["works", "authors", "institutions"]).optional(),
          limit: z.number().int().min(1).max(10).optional()
        },
        async ({ query, entity, limit }, extra) =>
          academicGet(
            `https://api.openalex.org/${entity ?? "works"}?search=${encodeURIComponent(query)}&per-page=${limit ?? 5}`,
            fetchImpl,
            resolveHost,
            toolAbortSignal(extra),
            (value) => ({
              source: "OpenAlex",
              results: ((value as { results?: Array<Record<string, any>> }).results ?? []).map((item) => ({
                id: item.id,
                name: item.display_name,
                doi: item.doi,
                year: item.publication_year,
                citedBy: item.cited_by_count,
                url: item.primary_location?.landing_page_url ?? item.homepage_url,
                orcid: item.orcid,
                institutions: item.last_known_institutions?.map((institution: Record<string, unknown>) => ({
                  id: institution.id,
                  name: institution.display_name
                }))
              }))
            })
          )
      ),
      tool(
        "search_crossref",
        "Search Crossref publication and funding metadata. Use DOI links as research evidence, not as admissions-policy evidence.",
        { query: z.string().min(1).max(300), limit: z.number().int().min(1).max(10).optional() },
        async ({ query, limit }, extra) =>
          academicGet(
            `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit ?? 5}`,
            fetchImpl,
            resolveHost,
            toolAbortSignal(extra),
            (value) => ({
              source: "Crossref",
              results: ((value as { message?: { items?: Array<Record<string, any>> } }).message?.items ?? []).map(
                (item) => ({
                  doi: item.DOI,
                  title: Array.isArray(item.title) ? item.title[0] : item.title,
                  authors: Array.isArray(item.author)
                    ? item.author.slice(0, 20).map((author: Record<string, unknown>) => ({
                        given: author.given,
                        family: author.family,
                        orcid: author.ORCID
                      }))
                    : [],
                  published: item.published,
                  url: item.URL,
                  subjects: item.subject
                })
              )
            })
          )
      ),
      tool(
        "search_ror",
        "Search ROR to disambiguate research organizations and official domains.",
        { query: z.string().min(1).max(300), limit: z.number().int().min(1).max(10).optional() },
        async ({ query, limit }, extra) =>
          academicGet(
            `https://api.ror.org/v2/organizations?query=${encodeURIComponent(query)}`,
            fetchImpl,
            resolveHost,
            toolAbortSignal(extra),
            (value) => ({
              source: "ROR",
              results: ((value as { items?: Array<Record<string, any>> }).items ?? [])
                .slice(0, limit ?? 5)
                .map((item) => ({
                  id: item.id,
                  names: item.names,
                  locations: item.locations,
                  links: item.links,
                  status: item.status
                }))
            })
          )
      )
    ]
  });

  const tracker = createSdkMcpServer({
    name: "application_tracker",
    version: "1.0.0",
    instructions:
      "Read tracker state freely. Write only when the user clearly asked to save or update the corresponding item. Delete a programme only after the user clearly asked to remove it. Save every published application round; do not collapse multiple rounds into one deadline.",
    alwaysLoad: true,
    tools: [
      tool(
        "create_application_cycle",
        "Create the first application cycle when the user wants a tracker, board, or to save programmes. Infer degree, intake term, field, and regions from the conversation when they are already known.",
        {
          degree: z.string().min(1).max(80),
          intakeTerm: z.string().min(1).max(120),
          fieldOfStudy: z.string().min(1).max(200),
          targetRegions: z.array(z.string().min(1).max(80)).min(1).max(20),
          name: z.string().min(1).max(120).optional()
        },
        async ({ degree, intakeTerm, fieldOfStudy, targetRegions, name }) => {
          try {
            if (context.store.listCycles().length > 0) {
              return toolError(
                "An application cycle already exists. Use the existing cycle instead of creating a duplicate."
              );
            }
            const cycle = context.store.createCycle({
              name: name?.trim() || `${intakeTerm.trim()} ${degree.trim()}`,
              degree,
              fieldOfStudy,
              intakeTerm,
              targetRegions: [...new Set(targetRegions.map((region) => region.trim()).filter(Boolean))],
              active: true
            });
            if (!context.store.getApplicantProfile(cycle.id)) {
              context.store.createApplicantProfile({
                cycleId: cycle.id,
                educationSummary: "",
                researchSummary: "",
                exams: {},
                budgetConstraints: ""
              });
            }
            return toolJson(cycle);
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "set_applicant_profile",
        "Create or update the applicant background summary after the user explicitly asks to save it. Store concise summaries only; do not store transcripts, identity documents, financial account data, or recommendation letters.",
        {
          educationSummary: z.string().max(10_000).optional(),
          researchSummary: z.string().max(10_000).optional(),
          exams: z
            .record(z.string().max(100), z.union([z.string().max(300), z.number(), z.boolean(), z.null()]))
            .optional(),
          budgetConstraints: z.string().max(4_000).optional(),
          cycleId: z.string().uuid().optional()
        },
        async (value) => {
          try {
            const cycle = activeCycle(value.cycleId);
            const current = context.store.getApplicantProfile(cycle.id);
            if (current) {
              return toolJson(
                context.store.updateApplicantProfile(current.id, {
                  ...(value.educationSummary !== undefined ? { educationSummary: value.educationSummary } : {}),
                  ...(value.researchSummary !== undefined ? { researchSummary: value.researchSummary } : {}),
                  ...(value.exams !== undefined ? { exams: value.exams } : {}),
                  ...(value.budgetConstraints !== undefined ? { budgetConstraints: value.budgetConstraints } : {})
                })
              );
            }
            return toolJson(
              context.store.createApplicantProfile({
                cycleId: cycle.id,
                educationSummary: value.educationSummary ?? "",
                researchSummary: value.researchSummary ?? "",
                exams: value.exams ?? {},
                budgetConstraints: value.budgetConstraints ?? ""
              })
            );
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "get_snapshot",
        "Read the active application cycle, applicant summary, programmes, open tasks, requirements, and upcoming deadlines.",
        { cycleId: z.string().uuid().optional() },
        async ({ cycleId }) => {
          try {
            const cycle = activeCycle(cycleId);
            const programs = context.store.listPrograms(cycle.id);
            return toolJson({
              cycle,
              profile: context.store.getApplicantProfile(cycle.id),
              programs,
              tasks: context.store.listTasks(cycle.id, { completed: false }),
              requirements: programs.flatMap((program) => context.store.listRequirements(program.id)),
              dailyPlan: context.store.dailyPlan(cycle.id)
            });
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "add_program",
        "Save one target programme after the user asks to add it. Dynamic facts should have an official URL and verification date. Save every published application round in deadlines; use deadlineAt only when the programme has a single date.",
        {
          school: z.string().min(1).max(200),
          program: z.string().min(1).max(240),
          country: z.string().max(80),
          degree: z.string().max(80),
          officialUrl: z.string().url().max(2_048).or(z.literal("")).optional(),
          deadlineAt: z.string().nullable().optional(),
          deadlines: z
            .array(
              z.object({
                label: z.string().max(80).optional(),
                dueAt: z.string().min(1).max(64)
              })
            )
            .max(12)
            .optional(),
          fundingSummary: z.string().max(8_000).optional(),
          cycleId: z.string().uuid().optional()
        },
        async (value) => {
          try {
            const cycle = activeCycle(value.cycleId);
            return toolJson(
              context.store.createProgram({
                cycleId: cycle.id,
                school: value.school,
                program: value.program,
                country: value.country,
                degree: value.degree,
                status: "researching",
                officialUrl: value.officialUrl ?? "",
                applicationFee: null,
                feeCurrency: null,
                deadlineAt: value.deadlineAt ?? null,
                ...(value.deadlines ? { deadlines: toProgramDeadlines(value.deadlines) } : {}),
                fundingSummary: value.fundingSummary ?? "",
                lastVerifiedAt: value.officialUrl ? new Date().toISOString() : null
              })
            );
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "update_program",
        "Update a saved programme's official URL, application rounds, tuition/funding notes, name, or other facts after the user asks to correct the tracker. Do not invent missing facts. Use deadlines to replace every published round. deadlineAt updates a single date only when the programme has at most one round. Set lastVerifiedAt when official facts change.",
        {
          programId: z.string().uuid(),
          school: z.string().min(1).max(200).optional(),
          program: z.string().min(1).max(240).optional(),
          country: z.string().max(80).optional(),
          degree: z.string().max(80).optional(),
          officialUrl: z.string().url().max(2_048).or(z.literal("")).optional(),
          deadlineAt: z.string().nullable().optional(),
          deadlines: z
            .array(
              z.object({
                label: z.string().max(80).optional(),
                dueAt: z.string().min(1).max(64)
              })
            )
            .max(12)
            .optional(),
          fundingSummary: z.string().max(8_000).optional(),
          applicationFee: z.number().nonnegative().nullable().optional(),
          feeCurrency: z.string().max(16).nullable().optional(),
          lastVerifiedAt: z.string().nullable().optional()
        },
        async (value) => {
          try {
            const current = context.store.getProgram(value.programId);
            if (!current) return toolError("Program not found");
            const factsChanged =
              value.officialUrl !== undefined ||
              value.deadlineAt !== undefined ||
              value.deadlines !== undefined ||
              value.fundingSummary !== undefined;
            const updated = context.store.updateProgram(value.programId, {
              ...(value.school !== undefined ? { school: value.school } : {}),
              ...(value.program !== undefined ? { program: value.program } : {}),
              ...(value.country !== undefined ? { country: value.country } : {}),
              ...(value.degree !== undefined ? { degree: value.degree } : {}),
              ...(value.officialUrl !== undefined ? { officialUrl: value.officialUrl } : {}),
              ...(value.deadlineAt !== undefined ? { deadlineAt: value.deadlineAt } : {}),
              ...(value.deadlines !== undefined ? { deadlines: toProgramDeadlines(value.deadlines) } : {}),
              ...(value.fundingSummary !== undefined ? { fundingSummary: value.fundingSummary } : {}),
              ...(value.applicationFee !== undefined ? { applicationFee: value.applicationFee } : {}),
              ...(value.feeCurrency !== undefined ? { feeCurrency: value.feeCurrency } : {}),
              lastVerifiedAt:
                value.lastVerifiedAt !== undefined
                  ? value.lastVerifiedAt
                  : factsChanged
                    ? new Date().toISOString()
                    : current.lastVerifiedAt
            });
            return updated ? toolJson(updated) : toolError("Program not found");
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "update_program_status",
        "Update a saved programme's workflow status after the user explicitly reports that change.",
        {
          programId: z.string().uuid(),
          status: z.enum(["researching", "shortlisted", "applying", "submitted", "interview", "offer", "rejected"])
        },
        async ({ programId, status }) => {
          const value = context.store.updateProgram(programId, { status });
          return value ? toolJson(value) : toolError("Program not found");
        }
      ),
      tool(
        "delete_program",
        "Permanently remove a saved programme from the tracker after the user clearly asks to delete it. Do not use this to mark a programme withdrawn.",
        { programId: z.string().uuid() },
        async ({ programId }) => {
          const current = context.store.getProgram(programId);
          if (!current) return toolError("Program not found");
          context.store.deleteProgram(programId);
          return toolJson({ deleted: true, programId, school: current.school, program: current.program });
        }
      ),
      tool(
        "update_application_cycle",
        "Update the active application cycle name, degree, intake, field, or target regions after the user asks to change the board coordinates.",
        {
          cycleId: z.string().uuid().optional(),
          name: z.string().min(1).max(120).optional(),
          degree: z.string().min(1).max(80).optional(),
          intakeTerm: z.string().min(1).max(120).optional(),
          fieldOfStudy: z.string().min(1).max(200).optional(),
          targetRegions: z.array(z.string().min(1).max(80)).min(1).max(20).optional()
        },
        async (value) => {
          try {
            const cycle = activeCycle(value.cycleId);
            const updated = context.store.updateCycle(cycle.id, {
              ...(value.name !== undefined ? { name: value.name } : {}),
              ...(value.degree !== undefined ? { degree: value.degree } : {}),
              ...(value.intakeTerm !== undefined ? { intakeTerm: value.intakeTerm } : {}),
              ...(value.fieldOfStudy !== undefined ? { fieldOfStudy: value.fieldOfStudy } : {}),
              ...(value.targetRegions !== undefined ? { targetRegions: value.targetRegions } : {})
            });
            return updated ? toolJson(updated) : toolError("Application cycle not found");
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "add_requirement",
        "Add a document or application requirement to a saved programme after the user asks to track it.",
        {
          programId: z.string().uuid(),
          label: z.string().min(1).max(240),
          type: z.string().min(1).max(80).optional(),
          status: z.enum(["missing", "in_progress", "ready", "submitted", "waived"]).optional(),
          dueAt: z.string().nullable().optional(),
          notes: z.string().max(8_000).optional(),
          sourceId: z.string().uuid().nullable().optional()
        },
        async (value) => {
          try {
            if (!context.store.getProgram(value.programId)) return toolError("Program not found");
            return toolJson(
              context.store.createRequirement({
                programId: value.programId,
                type: value.type ?? "document",
                label: value.label,
                status: value.status ?? "missing",
                dueAt: value.dueAt ?? null,
                notes: value.notes ?? "",
                sourceId: value.sourceId ?? null
              })
            );
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "update_requirement_status",
        "Update a saved requirement's workflow status after the user explicitly reports that change.",
        {
          requirementId: z.string().uuid(),
          status: z.enum(["missing", "in_progress", "ready", "submitted", "waived"])
        },
        async ({ requirementId, status }) => {
          const value = context.store.updateRequirement(requirementId, { status });
          return value ? toolJson(value) : toolError("Requirement not found");
        }
      ),
      tool(
        "update_requirement",
        "Update a saved requirement's notes, due date, label, or type after the user asks to correct it.",
        {
          requirementId: z.string().uuid(),
          label: z.string().min(1).max(240).optional(),
          type: z.string().min(1).max(80).optional(),
          dueAt: z.string().nullable().optional(),
          notes: z.string().max(8_000).optional()
        },
        async (value) => {
          const current = context.store.getRequirement(value.requirementId);
          if (!current) return toolError("Requirement not found");
          const updated = context.store.updateRequirement(value.requirementId, {
            ...(value.label !== undefined ? { label: value.label } : {}),
            ...(value.type !== undefined ? { type: value.type } : {}),
            ...(value.dueAt !== undefined ? { dueAt: value.dueAt } : {}),
            ...(value.notes !== undefined ? { notes: value.notes } : {})
          });
          return updated ? toolJson(updated) : toolError("Requirement not found");
        }
      ),
      tool(
        "add_task",
        "Add an application task after the user asks to track it.",
        {
          title: z.string().min(1).max(240),
          dueAt: z.string().nullable().optional(),
          priority: z.enum(["low", "medium", "high"]).optional(),
          programId: z.string().uuid().nullable().optional(),
          cycleId: z.string().uuid().optional()
        },
        async (value) => {
          try {
            const cycle = activeCycle(value.cycleId);
            return toolJson(
              context.store.createTask({
                cycleId: cycle.id,
                programId: value.programId ?? null,
                title: value.title,
                priority: value.priority ?? "medium",
                dueAt: value.dueAt ?? null,
                completed: false
              })
            );
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      ),
      tool(
        "set_task_completed",
        "Mark one saved application task complete or reopen it after the user clearly requests that change.",
        { taskId: z.string().uuid(), completed: z.boolean() },
        async ({ taskId, completed }) => {
          const value = context.store.updateTask(taskId, { completed });
          return value ? toolJson(value) : toolError("Task not found");
        }
      ),
      tool(
        "update_task",
        "Update a saved task's title, due date, or priority after the user asks to correct the tracker.",
        {
          taskId: z.string().uuid(),
          title: z.string().min(1).max(240).optional(),
          dueAt: z.string().nullable().optional(),
          priority: z.enum(["low", "medium", "high"]).optional()
        },
        async (value) => {
          const current = context.store.getTask(value.taskId);
          if (!current) return toolError("Task not found");
          const updated = context.store.updateTask(value.taskId, {
            ...(value.title !== undefined ? { title: value.title } : {}),
            ...(value.dueAt !== undefined ? { dueAt: value.dueAt } : {}),
            ...(value.priority !== undefined ? { priority: value.priority } : {})
          });
          return updated ? toolJson(updated) : toolError("Task not found");
        }
      )
    ]
  });

  const artifacts = createSdkMcpServer({
    name: "admissions_artifacts",
    version: "1.0.0",
    instructions:
      "Register only files created inside the current conversation workspace. Never read or copy an arbitrary path.",
    alwaysLoad: true,
    tools: [
      tool(
        "list_artifacts",
        "List versioned admissions documents for the active cycle.",
        { cycleId: z.string().uuid().optional(), programId: z.string().uuid().optional() },
        async ({ cycleId, programId }) => toolJson(context.store.listArtifacts(activeCycle(cycleId).id, programId))
      ),
      tool(
        "register_artifact",
        "Copy a document created inside the conversation workspace into managed admissions artifacts and register its version.",
        {
          sourceRelativePath: z.string().min(1).max(1_024),
          type: z.string().min(1).max(80),
          fileName: z.string().min(1).max(240).optional(),
          version: z.number().int().positive().optional(),
          exportFormats: z
            .array(z.enum(["docx", "pdf"]))
            .max(2)
            .optional(),
          programId: z.string().uuid().nullable().optional(),
          cycleId: z.string().uuid().optional()
        },
        async (value) => {
          try {
            const cycle = activeCycle(value.cycleId);
            const relative = cleanArtifactRelativePath(value.sourceRelativePath);
            const source = path.resolve(context.workspacePath, relative);
            const workspace = path.resolve(context.workspacePath);
            if (!isWithin(workspace, source) || source === workspace)
              throw new Error("Artifact source is outside the conversation workspace");
            const extension = path.extname(source).toLowerCase();
            if (!new Set([".md", ".txt", ".docx", ".pdf"]).has(extension)) throw new Error("Unsupported artifact type");
            const fileName = value.fileName?.trim() || path.basename(source);
            const managedRelative = cleanArtifactRelativePath(`${cycle.id}/${randomUUID()}-${safeFileName(fileName)}`);
            const destination = path.resolve(context.config.workspaceRoot, ".admissions-artifacts", managedRelative);
            const artifactRoot = path.resolve(context.config.workspaceRoot, ".admissions-artifacts");
            await copyWorkspaceArtifact(source, workspace, destination, artifactRoot);
            const sourceArtifact = context.store.createArtifact({
              cycleId: cycle.id,
              programId: value.programId ?? null,
              type: value.type,
              version:
                value.version ?? nextArtifactVersion(context.store, cycle.id, value.programId ?? null, value.type),
              fileName,
              relativePath: managedRelative
            });
            if (!value.exportFormats?.length) return toolJson(sourceArtifact);
            if (!new Set([".md", ".txt"]).has(extension)) {
              return toolError("DOCX/PDF export requires a Markdown or plain-text source artifact.");
            }
            const exportBase = `${randomUUID()}-${safeFileName(path.basename(fileName, extension))}`;
            const exported = await exportTextDocument({
              sourcePath: destination,
              outputDirectory: path.join(artifactRoot, cycle.id),
              baseName: exportBase,
              formats: value.exportFormats
            });
            const exportArtifacts = exported.map((item) => {
              const exportedFileName = `${path.basename(fileName, extension)}.${item.format}`;
              const exportedType = `${value.type} ${item.format.toUpperCase()}`;
              return context.store.createArtifact({
                cycleId: cycle.id,
                programId: value.programId ?? null,
                type: exportedType,
                version: nextArtifactVersion(context.store, cycle.id, value.programId ?? null, exportedType),
                fileName: exportedFileName,
                relativePath: cleanArtifactRelativePath(
                  path.relative(artifactRoot, item.path).split(path.sep).join("/")
                )
              });
            });
            return toolJson({ source: sourceArtifact, exports: exportArtifacts });
          } catch (error) {
            return toolError(safeError(error));
          }
        }
      )
    ]
  });

  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {
    admissions_evidence: evidence,
    academic_research: academic,
    application_tracker: tracker,
    admissions_artifacts: artifacts
  };
  if (context.schedulerStore && context.schedulerRunner) {
    servers.admissions_schedule = createSdkMcpServer({
      name: "admissions_schedule",
      version: "1.0.0",
      instructions:
        "Manage only the two safe admissions schedule templates. Never create arbitrary background prompts.",
      alwaysLoad: true,
      tools: [
        tool("list_schedules", "List admissions summary and reminder schedules.", {}, async () =>
          toolJson(context.schedulerStore!.listJobs("graduate-admissions"))
        ),
        tool(
          "create_schedule",
          "Create a weekly application review or daily action plan only after the user asks for it.",
          {
            templateId: z.enum(["weekly-application-review", "daily-application-plan"]),
            destinations: z
              .array(z.enum(["web", "feishu"]))
              .min(1)
              .max(2)
              .optional(),
            enabled: z.boolean().optional()
          },
          async ({ templateId, destinations, enabled }) => {
            try {
              return toolJson(
                context.schedulerStore!.createJob({
                  profileId: "graduate-admissions",
                  templateId,
                  destinations: destinations ?? ["web"],
                  enabled: enabled ?? true
                })
              );
            } catch (error) {
              return toolError(safeError(error));
            }
          }
        ),
        tool(
          "update_schedule",
          "Pause, resume, or change delivery channels for one saved admissions schedule.",
          {
            jobId: z.string().uuid(),
            enabled: z.boolean().optional(),
            destinations: z
              .array(z.enum(["web", "feishu"]))
              .min(1)
              .max(2)
              .optional()
          },
          async ({ jobId, enabled, destinations }) => {
            const value = context.schedulerStore!.updateJob(jobId, {
              ...(enabled !== undefined ? { enabled } : {}),
              ...(destinations !== undefined ? { destinations } : {})
            });
            return value ? toolJson(value) : toolError("Scheduled job not found");
          }
        ),
        tool(
          "run_schedule_now",
          "Run one saved admissions schedule immediately after the user asks.",
          { jobId: z.string().uuid() },
          async ({ jobId }) => {
            const value = context.schedulerRunner!.runNow(jobId);
            return value ? toolJson(value) : toolError("Scheduled job not found");
          }
        )
      ]
    });
  }
  return servers;
}

async function academicGet(
  url: string,
  fetchImpl: FetchLike,
  resolveHost: ResolveHost,
  signal: AbortSignal | undefined,
  select: (value: unknown) => unknown
) {
  try {
    const { response } = await fetchPublicResponse(url, fetchImpl, resolveHost, {
      accept: "application/json",
      timeoutMs: 12_000,
      allowedContentTypes: ["application/json"],
      ...(signal ? { signal } : {})
    });
    if (!response.ok) throw new Error(`Research source returned HTTP ${response.status}`);
    return toolJson(select(JSON.parse(await readLimitedText(response))), 24_000);
  } catch (error) {
    return toolError(safeFetchError(error));
  }
}

const PUBLIC_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function fetchPublicPage(url: string, fetchImpl: FetchLike, resolveHost: ResolveHost, signal?: AbortSignal) {
  const { response, url: finalUrl } = await fetchPublicResponse(url, fetchImpl, resolveHost, {
    accept: "text/html,application/xhtml+xml,text/plain,application/json",
    timeoutMs: 15_000,
    allowedContentTypes: ["text/html", "application/xhtml+xml", "text/plain", "application/json"],
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error(`Official page returned HTTP ${response.status}`);
  const body = await readLimitedText(response);
  const extracted = extractPageContent(body, finalUrl);
  if (!extracted.text && extracted.candidateLinks.length === 0 && !extracted.jsRendered) {
    throw new Error("Official page did not contain readable text");
  }
  return {
    url: finalUrl,
    publisher: new URL(finalUrl).hostname,
    fetchedAt: new Date().toISOString(),
    contentHash: createHash("sha256").update(body).digest("hex"),
    text: extracted.text,
    jsRendered: extracted.jsRendered,
    candidateLinks: extracted.candidateLinks
  };
}

const maxFetchBytes = 500 * 1024;

async function fetchPublicResponse(
  initialUrl: string,
  fetchImpl: FetchLike,
  resolveHost: ResolveHost,
  options: { accept: string; timeoutMs: number; allowedContentTypes: string[]; signal?: AbortSignal }
): Promise<{ response: Response; url: string }> {
  let currentUrl = initialUrl;
  const deadlineAt = Date.now() + options.timeoutMs;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    // Production requests connect to one pre-validated address while retaining the
    // original Host/SNI. Injected fetch implementations remain available for tests.
    const addresses = await assertPublicHttpUrl(currentUrl, resolveHost);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error("Request timed out");
    const response =
      fetchImpl === fetch
        ? await requestPinnedFromAddresses(currentUrl, addresses, options.accept, remainingMs, options.signal)
        : await fetchImpl(currentUrl, {
            headers: { Accept: options.accept, "User-Agent": PUBLIC_FETCH_USER_AGENT },
            redirect: "manual",
            signal: requestAbortSignal(remainingMs, options.signal)
          });
    if (isRedirect(response.status)) {
      if (redirects === 5) throw new Error("Too many redirects");
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect response is missing Location");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !options.allowedContentTypes.includes(contentType)) {
      throw new Error("Unsupported response content type");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxFetchBytes)) {
      throw new Error("Response body exceeds 500 KB");
    }
    return { response, url: currentUrl };
  }
  throw new Error("Too many redirects");
}

async function requestPinnedFromAddresses(
  url: string,
  addresses: string[],
  accept: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const deadlineAt = Date.now() + timeoutMs;
  let lastError: unknown;
  for (const address of addresses) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    try {
      return await requestPinned(url, address, accept, Math.min(remainingMs, 7_000), signal);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error("Request timed out");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxFetchBytes) {
        await reader.cancel();
        throw new Error("Response body exceeds 500 KB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function assertPublicHttpUrl(value: string, resolveHost: ResolveHost): Promise<string[]> {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error("Only public HTTP(S) URLs are allowed");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Private network URLs are not allowed");
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress))
    throw new Error("Private network URLs are not allowed");
  return addresses;
}

function requestPinned(
  urlValue: string,
  address: string,
  accept: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const url = new URL(urlValue);
  const originalHostname = url.hostname.replace(/^\[|\]$/g, "");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (operation: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const req = request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        ...(isIP(originalHostname) ? {} : { servername: originalHostname }),
        headers: { Host: url.host, Accept: accept, "User-Agent": PUBLIC_FETCH_USER_AGENT }
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxFetchBytes) {
            response.destroy(new Error("Response body exceeds 500 KB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", fail);
        response.once("aborted", () => fail(new Error("Response was aborted")));
        response.once("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
            else if (value !== undefined) headers.set(name, String(value));
          }
          const body = Buffer.concat(chunks);
          finish(() =>
            resolve(
              new Response(body.length ? body : null, {
                status: response.statusCode ?? 500,
                ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
                headers
              })
            )
          );
        });
      }
    );
    const onAbort = () => req.destroy(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
    const deadline = setTimeout(() => req.destroy(new Error("Request timed out")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    req.once("error", fail);
    if (signal?.aborted) onAbort();
    req.end();
  });
}

function requestAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toolAbortSignal(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: AbortSignal } | null)?.signal;
  return signal && typeof signal.addEventListener === "function" ? signal : undefined;
}

export async function resolvePublicAddresses(
  hostname: string,
  systemResolve: ResolveHost = async (host) => (await dns.lookup(host, { all: true })).map((entry) => entry.address),
  dnsFetch: FetchLike = fetch
): Promise<string[]> {
  let systemAddresses: string[] = [];
  try {
    systemAddresses = await systemResolve(hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOTFOUND" && code !== "EAI_AGAIN") throw error;
  }
  if (systemAddresses.length > 0 && !systemAddresses.every(isSyntheticDnsAddress)) return systemAddresses;
  return resolveWithPublicDns(hostname, dnsFetch);
}

function isSyntheticDnsAddress(address: string): boolean {
  const [first, second] = address.split(".").map(Number);
  return first === 198 && (second === 18 || second === 19);
}

async function resolveWithPublicDns(hostname: string, dnsFetch: FetchLike): Promise<string[]> {
  const addresses = await queryPublicDns(hostname, "A", dnsFetch);
  return addresses.length > 0 ? addresses : queryPublicDns(hostname, "AAAA", dnsFetch);
}

async function queryPublicDns(hostname: string, type: "A" | "AAAA", dnsFetch: FetchLike): Promise<string[]> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  const response = await dnsFetch(url, {
    headers: { Accept: "application/dns-json", "User-Agent": "fieldnote/0.1" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Public DNS lookup returned HTTP ${response.status}`);
  const payload = (await response.json()) as {
    Status?: number;
    Answer?: Array<{ type?: number; data?: string }>;
  };
  if (payload.Status !== 0) return [];
  const expectedType = type === "A" ? 1 : 28;
  return [
    ...new Set(
      (payload.Answer ?? [])
        .filter((answer) => answer.type === expectedType && typeof answer.data === "string" && isIP(answer.data) > 0)
        .map((answer) => answer.data!)
    )
  ];
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  )
    return true;
  if (normalized.startsWith("::ffff:")) {
    const embedded = normalized.slice(7);
    if (isIP(embedded) === 4) return isPrivateAddress(embedded);
    const words = embedded.split(":");
    if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return true;
    const high = Number.parseInt(words[0]!, 16);
    const low = Number.parseInt(words[1]!, 16);
    return isPrivateAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = -1, b = -1, c = -1] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function copyWorkspaceArtifact(
  source: string,
  workspace: string,
  destination: string,
  artifactRoot: string
): Promise<void> {
  const root = path.resolve(workspace);
  const resolvedSource = path.resolve(source);
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedDestination = path.resolve(destination);
  if (!isWithin(root, resolvedSource) || !isWithin(resolvedArtifactRoot, resolvedDestination)) {
    throw new Error("Artifact path is outside its allowed directory");
  }
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("Workspace symlinks are not allowed");
  const realRoot = await fs.realpath(root);
  const sourceStat = await fs.lstat(resolvedSource);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size > 20 * 1024 * 1024) {
    throw new Error("Artifact must be a non-symbolic-link file no larger than 20 MB");
  }
  const realSource = await fs.realpath(resolvedSource);
  if (!isWithin(realRoot, realSource)) throw new Error("Artifact source resolves outside the conversation workspace");

  await fs.mkdir(resolvedArtifactRoot, { recursive: true });
  const artifactRootStat = await fs.lstat(resolvedArtifactRoot);
  if (artifactRootStat.isSymbolicLink()) throw new Error("Managed artifact directory cannot be a symbolic link");
  const realConfigRoot = await fs.realpath(path.dirname(resolvedArtifactRoot));
  const realArtifactRoot = await fs.realpath(resolvedArtifactRoot);
  if (!isWithin(realConfigRoot, realArtifactRoot))
    throw new Error("Managed artifact directory resolves outside the workspace");
  await fs.mkdir(path.dirname(resolvedDestination), { recursive: true });
  for (let current = path.dirname(resolvedDestination); ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Managed artifact path cannot contain a symbolic link");
    if (current === resolvedArtifactRoot) break;
  }
  const realDestinationDirectory = await fs.realpath(path.dirname(resolvedDestination));
  if (!isWithin(realArtifactRoot, realDestinationDirectory)) {
    throw new Error("Managed artifact destination resolves outside the artifact directory");
  }

  const handle = await fs.open(resolvedSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const afterOpen = await fs.lstat(resolvedSource);
    const afterOpenReal = await fs.realpath(resolvedSource);
    if (
      !opened.isFile() ||
      opened.size > 20 * 1024 * 1024 ||
      opened.dev !== afterOpen.dev ||
      opened.ino !== afterOpen.ino ||
      !isWithin(realRoot, afterOpenReal)
    ) {
      throw new Error("Artifact source changed while it was being read");
    }
    const data = await handle.readFile();
    if (data.byteLength > 20 * 1024 * 1024) throw new Error("Artifact must be no larger than 20 MB");
    const afterRead = await fs.lstat(resolvedSource);
    const afterReadReal = await fs.realpath(resolvedSource);
    if (
      opened.dev !== afterRead.dev ||
      opened.ino !== afterRead.ino ||
      afterRead.isSymbolicLink() ||
      !isWithin(realRoot, afterReadReal)
    ) {
      throw new Error("Artifact source changed while it was being copied");
    }
    const temporary = `${resolvedDestination}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, resolvedDestination);
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type SearchHit = { title: string; url: string; snippet: string };

function htmlToText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPageContent(
  html: string,
  pageUrl: string
): {
  text: string;
  jsRendered: boolean;
  candidateLinks: string[];
} {
  const visible = htmlToText(html);
  const text = joinUniqueText([
    htmlToText(firstTag(html, "title")),
    metaContent(html, "description"),
    metaContent(html, "og:description"),
    ...collectNoscriptText(html),
    ...collectJsonLdText(html),
    ...collectEmbeddedAppText(html),
    visible
  ]).slice(0, 60_000);
  return {
    text,
    jsRendered: looksJsRendered(html, visible),
    candidateLinks: extractCandidateLinks(html, pageUrl)
  };
}

function looksJsRendered(html: string, visibleText: string): boolean {
  if (visibleText.length >= 280) return false;
  return (
    /__NEXT_DATA__|id=["']__next["']|id=["']root["']|id=["']app["']|ng-version|data-reactroot|window\.__NUXT__/i.test(
      html
    ) ||
    ((html.match(/<script\b/gi) ?? []).length >= 3 && html.length > 2_000 && visibleText.length < 40)
  );
}

function collectNoscriptText(html: string): string[] {
  return [...html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)]
    .map((match) => htmlToText(match[1] ?? ""))
    .filter((text) => text.length >= 12);
}

function collectJsonLdText(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectJsonStrings(JSON.parse(match[1] ?? ""), out);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

function collectEmbeddedAppText(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*(?:id=["']__NEXT_DATA__["']|id=["']__NUXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      collectJsonStrings(JSON.parse(match[1] ?? ""), out);
    } catch {
      /* ignore malformed app payloads */
    }
  }
  return out;
}

function collectJsonStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= 24) return;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length < 32 || text.length > 2_000) return;
    if (/^https?:\/\//i.test(text) || /^[A-Z0-9_]+$/.test(text) || !/[A-Za-z]{4,}/.test(text)) return;
    out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectJsonStrings(item, out, depth + 1);
  }
}

function extractCandidateLinks(html: string, pageUrl: string): string[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let resolved: URL;
    try {
      resolved = new URL(match[1] ?? "", page);
    } catch {
      continue;
    }
    if (!new Set(["http:", "https:"]).has(resolved.protocol) || resolved.username || resolved.password) continue;
    if (officialSiteKey(resolved.hostname) !== officialSiteKey(page.hostname)) continue;
    if (
      !/admission|programme|program|tuition|fee|deadline|faq|apply|graduate|prospectus|course|\.pdf/i.test(
        `${resolved.pathname}${resolved.search}`
      )
    ) {
      continue;
    }
    if (seen.has(resolved.href)) continue;
    seen.add(resolved.href);
    links.push(resolved.href);
    if (links.length >= 8) break;
  }
  return links;
}

function officialSiteKey(hostname: string): string {
  const labels = hostname.toLowerCase().split(".");
  if (labels.length <= 2) return hostname.toLowerCase();
  const two = labels.slice(-2).join(".");
  if (new Set(["edu.sg", "ac.uk", "edu.hk", "ac.jp", "edu.au", "co.uk"]).has(two) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return two;
}

function firstTag(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ?? "";
}

function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']${escaped}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeXml(match[1]).trim();
  }
  return "";
}

function joinUniqueText(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const text = part.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.join(" ").trim();
}

function normalizeSearchQuery(value: string): string {
  const normalized = value.replace(/[“”]/g, '"').replace(/\\+"/g, '"').replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Search query is empty");
  return normalized;
}

function normalizeSearchDomain(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  const hostname = candidate.includes("://") ? new URL(candidate).hostname : candidate;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
    throw new Error(`Invalid official domain: ${value}`);
  }
  return hostname;
}

async function searchOfficialLeads(
  query: string,
  domains: string[],
  limit: number,
  fetchImpl: FetchLike,
  resolveHost: ResolveHost,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const scopes = domains.length > 0 ? domains : [""];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const domain of scopes) {
    const scopedQuery = domain ? `${query} site:${domain}` : query;
    const filter = domain ? [domain] : domains;
    const batch = await searchOneQuery(scopedQuery, filter, fetchImpl, resolveHost, signal);
    for (const hit of batch) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  }
  return rankOfficialLeads(hits, domains).slice(0, limit);
}

async function searchOneQuery(
  query: string,
  domains: string[],
  fetchImpl: FetchLike,
  resolveHost: ResolveHost,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const attempts: Array<() => Promise<string>> = [
    () =>
      fetchSearchDocument(bingSearchUrl(query, true), fetchImpl, resolveHost, signal, [
        "application/rss+xml",
        "application/xml",
        "text/xml",
        "text/html"
      ]),
    () =>
      fetchSearchDocument(bingSearchUrl(query, false), fetchImpl, resolveHost, signal, [
        "text/html",
        "application/xhtml+xml"
      ]),
    () =>
      fetchSearchDocument(duckDuckGoSearchUrl(query), fetchImpl, resolveHost, signal, [
        "text/html",
        "application/xhtml+xml"
      ])
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const results = parseSearchDocument(await attempt(), domains);
      if (results.length > 0) return results;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  if (lastError && domains.length === 0) throw lastError;
  return [];
}

async function fetchSearchDocument(
  url: string,
  fetchImpl: FetchLike,
  resolveHost: ResolveHost,
  signal: AbortSignal | undefined,
  allowedContentTypes: string[]
): Promise<string> {
  const { response } = await fetchPublicResponse(url, fetchImpl, resolveHost, {
    accept: allowedContentTypes.join(","),
    timeoutMs: 12_000,
    allowedContentTypes,
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new Error(`Official-source search returned HTTP ${response.status}`);
  return readLimitedText(response);
}

function bingSearchUrl(query: string, rss: boolean): string {
  const url = new URL("https://www.bing.com/search");
  if (rss) url.searchParams.set("format", "rss");
  url.searchParams.set("count", "8");
  url.searchParams.set("q", query);
  return url.toString();
}

function duckDuckGoSearchUrl(query: string): string {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  return url.toString();
}

function parseSearchDocument(value: string, domains: string[]): SearchHit[] {
  if (/<item\b/i.test(value)) return parseSearchRss(value, domains);
  const bing = parseBingHtml(value, domains);
  if (bing.length > 0) return bing;
  return parseDuckDuckGoHtml(value, domains);
}

function parseSearchRss(value: string, domains: string[]): SearchHit[] {
  const results: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of value.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    pushSearchHit(
      results,
      seen,
      rssTag(item[1] ?? "", "title"),
      decodeXml(rssTag(item[1] ?? "", "link")),
      htmlToText(decodeXml(rssTag(item[1] ?? "", "description"))),
      domains
    );
  }
  return results;
}

function parseBingHtml(value: string, domains: string[]): SearchHit[] {
  const results: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of value.matchAll(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/gi)) {
    const block = item[0] ?? "";
    const href =
      block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i)?.[1] ?? block.match(/<a[^>]+href="([^"]+)"/i)?.[1] ?? "";
    const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const snippet = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    pushSearchHit(results, seen, title, href, snippet, domains);
  }
  return results;
}

function parseDuckDuckGoHtml(value: string, domains: string[]): SearchHit[] {
  const results: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of value.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const snippet =
      value
        .slice(item.index ?? 0, (item.index ?? 0) + 800)
        .match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1] ?? "";
    pushSearchHit(results, seen, item[2] ?? "", decodeDuckDuckGoHref(item[1] ?? ""), snippet, domains);
  }
  return results;
}

function decodeDuckDuckGoHref(href: string): string {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    return url.searchParams.get("uddg") || url.href;
  } catch {
    return href;
  }
}

function pushSearchHit(
  results: SearchHit[],
  seen: Set<string>,
  title: string,
  link: string,
  snippet: string,
  domains: string[]
): void {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return;
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) return;
  const hostname = parsed.hostname.toLowerCase();
  if (domains.length > 0 && !domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) return;
  if (seen.has(parsed.href)) return;
  seen.add(parsed.href);
  results.push({
    title: htmlToText(decodeXml(title)).slice(0, 300),
    url: parsed.href,
    snippet: htmlToText(decodeXml(snippet)).slice(0, 800)
  });
}

function rankOfficialLeads(hits: SearchHit[], domains: string[]): SearchHit[] {
  return [...hits].sort((left, right) => officialLeadScore(right, domains) - officialLeadScore(left, domains));
}

function officialLeadScore(hit: SearchHit, domains: string[]): number {
  try {
    const url = new URL(hit.url);
    const host = url.hostname.toLowerCase();
    const path = `${url.pathname}${url.search}`.toLowerCase();
    let score = 0;
    if (domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) score += 8;
    if (/admission|programme|program|graduate|tuition|fee|deadline|apply|prospectus/.test(path)) score += 5;
    if (path.endsWith(".pdf")) score += 2;
    if (/news|blog|forum|reddit|wikipedia|topuniversities/.test(`${host}${path}`)) score -= 6;
    if (/official|admission|deadline|tuition/i.test(`${hit.title} ${hit.snippet}`)) score += 1;
    return score;
  } catch {
    return -1;
  }
}

function rssTag(value: string, tag: string): string {
  const match = value.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return (match?.[1] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function nextArtifactVersion(store: AdmissionsStore, cycleId: string, programId: string | null, type: string): number {
  return (
    Math.max(
      0,
      ...store
        .listArtifacts(cycleId, programId ?? undefined)
        .filter((artifact) => artifact.type === type)
        .map((artifact) => artifact.version)
    ) + 1
  );
}

function safeFileName(value: string): string {
  return (
    value
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 160) || "document"
  );
}

function toolJson(value: unknown, limit = 18_000) {
  const text = JSON.stringify(value).slice(0, limit);
  return { content: [{ type: "text" as const, text }] };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function safeFetchError(error: unknown): string {
  const message = safeError(error);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Public DNS lookup failed";
  if (code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) return "Request timed out";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `Network connection failed${code ? ` (${code})` : ""}`;
  }
  if (/certificate|tls|ssl/i.test(message)) return "TLS certificate verification failed";
  return message;
}
