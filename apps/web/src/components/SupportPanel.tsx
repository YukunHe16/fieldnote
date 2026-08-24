import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { getLocale, localeTag, regionMessage, statusMessage, t, useLocale } from "../i18n";
import { Icon } from "../icons";
import type {
  AdmissionsArtifact,
  AdmissionsCycle,
  AdmissionsProfile,
  AdmissionsProgram,
  AdmissionsProgramDeadline,
  AdmissionsProgramStatus,
  AdmissionsRequirement,
  AdmissionsRequirementStatus,
  AdmissionsSource,
  AdmissionsTask,
  ConversationDetail,
  LearningMetricsCellDto,
  LearningHandoffReportDto,
  LearningMetricsDto,
  LearningPolicyRevisionDto,
  LearningVerificationDto,
  ScheduledJob,
  ScheduledJobRun
} from "../types";
import { splitProgramSummary } from "../programSummary";
import { ConfirmDialog } from "./ConfirmDialog";
import { ActivityBlock } from "./Messages";
import {
  canConfirmLearningVerification,
  isSyntheticSeedIncident,
  summarizeSyntheticSeedIncidents
} from "../learningPresentation";

export type SupportPanelKind = "admissions" | "schedules" | "learning";

function dateLabel(value?: string) {
  if (!value) return t("supportUnset");
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(localeTag(), { month: "short", day: "numeric" });
}

function programDeadlines(program: AdmissionsProgram): AdmissionsProgramDeadline[] {
  if (program.deadlines?.length)
    return [...program.deadlines].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  return program.deadline ? [{ id: `legacy-${program.id}`, label: "", dueAt: program.deadline }] : [];
}

function deadlineRoundLabel(item: AdmissionsProgramDeadline, index: number, total: number) {
  if (item.label) return item.label;
  return total > 1 ? t("deadlineRoundN", { n: index + 1 }) : "";
}

function nextProgramDeadline(program: AdmissionsProgram) {
  const items = programDeadlines(program);
  const now = Date.now();
  return items.find((item) => Date.parse(item.dueAt) >= now) ?? items[items.length - 1];
}

function deadlineLine(item: AdmissionsProgramDeadline, index: number, total: number) {
  const label = deadlineRoundLabel(item, index, total);
  const date = dateLabel(item.dueAt);
  return label ? `${label} · ${date}` : date;
}

function statusLabel(value?: string) {
  return statusMessage(value);
}

function EmptySupport({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="support-empty">
      <Icon name="activity" />
      <p>{title}</p>
      <small>{detail}</small>
    </div>
  );
}

function programStatuses(current?: string): Array<[AdmissionsProgramStatus, string]> {
  const statuses: Array<[AdmissionsProgramStatus, string]> = [
    ["researching", t("statusResearching")],
    ["shortlisted", t("statusShortlisted")],
    ["applying", t("statusApplying")],
    ["submitted", t("statusSubmitted")],
    ["interview", t("statusInterview")],
    ["offer", t("statusOffer")],
    ["rejected", t("statusRejected")]
  ];
  if (current === "withdrawn") statuses.push(["withdrawn", t("statusWithdrawn")]);
  return statuses;
}
function requirementStatuses(): Array<[AdmissionsRequirementStatus, string]> {
  return [
    ["missing", t("statusMissing")],
    ["in_progress", t("statusInProgress")],
    ["ready", t("statusReady")],
    ["submitted", t("statusSubmitted")],
    ["waived", t("statusWaived")]
  ];
}
const REGIONS = ["美国", "加拿大", "香港", "新加坡"];
// The picker always works in the canonical zh values; what reaches the LLM context
// is translated at submit time so an English session reads back in English.
const REGION_SUBMIT_EN: Record<string, string> = {
  美国: "United States",
  加拿大: "Canada",
  香港: "Hong Kong",
  新加坡: "Singapore"
};
const DEGREE_SUBMIT_EN: Record<string, string> = {
  硕士: "Master",
  博士: "PhD",
  硕博混申: "Master and PhD"
};
const DEFAULT_INTAKE: Record<"zh" | "en", string> = { zh: "2027 秋季", en: "2027 Fall" };
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

function regionLabel(region: string) {
  return regionMessage(REGION_ALIASES[region.trim().toLowerCase()] ?? REGION_ALIASES[region] ?? region);
}

function priorityLabel(priority?: string) {
  if (priority === "high") return t("priorityHigh");
  if (priority === "low") return t("priorityLow");
  return t("priorityNormal");
}

function AdmissionsOnboarding({ onComplete }: { onComplete: () => Promise<void> }) {
  const { locale, t } = useLocale();
  const english = locale === "en";
  const [degree, setDegree] = useState("硕士");
  const [intakeTerm, setIntakeTerm] = useState(() => DEFAULT_INTAKE[getLocale()]);
  const [field, setField] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [workingCycle, setWorkingCycle] = useState<AdmissionsCycle>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Follow a locale switch only while the field still holds the other locale's default.
  useEffect(() => {
    setIntakeTerm((current) =>
      current === DEFAULT_INTAKE.zh || current === DEFAULT_INTAKE.en ? DEFAULT_INTAKE[locale] : current
    );
  }, [locale]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!field.trim() || regions.length === 0) {
      setError(!field.trim() ? t("needField") : t("needRegion"));
      return;
    }
    const submitDegree = english ? (DEGREE_SUBMIT_EN[degree] ?? degree) : degree;
    const submitRegions = english ? regions.map((region) => REGION_SUBMIT_EN[region] ?? region) : regions;
    setSaving(true);
    setError("");
    try {
      const cycle = workingCycle
        ? await api.updateAdmissionsCycle(workingCycle.id, {
            degree: submitDegree,
            intakeTerm,
            fieldOfStudy: field.trim(),
            targetRegions: submitRegions,
            name: `${intakeTerm} · ${field.trim()}`,
            active: true
          })
        : await api.createAdmissionsCycle({
            degree: submitDegree,
            intakeTerm,
            fieldOfStudy: field.trim(),
            targetRegions: submitRegions,
            name: `${intakeTerm} · ${field.trim()}`,
            active: true
          });
      setWorkingCycle(cycle);
      try {
        await api.createAdmissionsProfile({
          cycleId: cycle.id,
          targetDegree: submitDegree,
          targetField: field.trim(),
          targetYear: intakeTerm,
          summary: ""
        });
      } catch (profileError) {
        const alreadyCreated = await api.admissionsProfile().catch(() => undefined);
        if (!alreadyCreated) throw profileError;
      }
      await onComplete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("saveFailedRetry"));
    } finally {
      setSaving(false);
    }
  }

  function toggleRegion(region: string) {
    setRegions((current) =>
      current.includes(region) ? current.filter((item) => item !== region) : [...current, region]
    );
    setError("");
  }

  return (
    <div className="admissions-onboarding">
      <header>
        <p>{t("onboardingEyebrow")}</p>
        <h3>{t("onboardingTitle")}</h3>
        <small>{t("onboardingHint")}</small>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>
            <b>1</b>
            {t("targetDegree")}
          </span>
          <select value={degree} onChange={(event) => setDegree(event.target.value)}>
            <option value="硕士">{t("degreeMaster")}</option>
            <option value="博士">{t("degreePhd")}</option>
            <option value="硕博混申">{t("degreeBoth")}</option>
          </select>
        </label>
        <label>
          <span>
            <b>2</b>
            {t("intakeTerm")}
          </span>
          <input
            value={intakeTerm}
            onChange={(event) => setIntakeTerm(event.target.value)}
            placeholder={t("intakePlaceholder")}
            required
          />
        </label>
        <label>
          <span>
            <b>3</b>
            {t("fieldOfStudy")}
          </span>
          <input
            value={field}
            onChange={(event) => {
              setField(event.target.value);
              setError("");
            }}
            placeholder={t("fieldPlaceholder")}
            required
          />
        </label>
        <fieldset>
          <legend>
            <b>4</b>
            {t("targetRegions")}
          </legend>
          <div>
            {REGIONS.map((region) => (
              <button
                key={region}
                type="button"
                aria-pressed={regions.includes(region)}
                onClick={() => toggleRegion(region)}
              >
                {regionMessage(region)}
              </button>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="support-form-error" role="alert">
            {error}
          </p>
        )}
        <button className="support-primary-button" disabled={saving} type="submit">
          {saving ? t("creating") : t("createProfile")}
          <Icon name="arrowUp" size={14} />
        </button>
      </form>
    </div>
  );
}

function feeLabel(program: AdmissionsProgram) {
  if (typeof program.applicationFee !== "number") return "";
  const currency = program.feeCurrency?.trim();
  return currency ? `${currency} ${program.applicationFee}` : String(program.applicationFee);
}

function isCompletedTask(task: AdmissionsTask) {
  return task.completed ?? ["completed", "done"].includes(task.status?.toLowerCase() ?? "");
}

function ProgramDetail({
  program,
  tasks,
  requirements,
  artifacts,
  sources,
  saving,
  error,
  onBack,
  onStatus,
  onRequirementStatus,
  onToggleTask,
  onDelete
}: {
  program: AdmissionsProgram;
  tasks: AdmissionsTask[];
  requirements: AdmissionsRequirement[];
  artifacts: AdmissionsArtifact[];
  sources: AdmissionsSource[];
  saving?: string;
  error?: string;
  onBack: () => void;
  onStatus: (status: AdmissionsProgramStatus) => void;
  onRequirementStatus: (requirement: AdmissionsRequirement, status: AdmissionsRequirementStatus) => void;
  onToggleTask: (task: AdmissionsTask) => void;
  onDelete: () => void;
}) {
  const { t } = useLocale();
  const fee = feeLabel(program);
  const completedTasks = tasks.filter(isCompletedTask).length;
  const summary = splitProgramSummary(program.fundingSummary);
  const requirementCount = requirements.length + summary.requirements.length;
  const rounds = programDeadlines(program);
  return (
    <div className="program-detail">
      <button className="program-detail-back" onClick={onBack}>
        <Icon name="chevronRight" size={14} />
        {t("allPrograms")}
      </button>
      {error && (
        <p className="support-inline-error" role="alert">
          {error}
        </p>
      )}
      <section className="program-dossier">
        <p>
          {program.degree ?? t("program")} · {statusLabel(program.status)}
        </p>
        <h3>{program.name}</h3>
        <small>
          {program.institution ?? t("schoolUnset")}
          {program.country ? ` · ${program.country}` : ""}
        </small>
        <dl>
          <div>
            <dt>{t("deadline")}</dt>
            <dd>
              {rounds.length
                ? rounds.map((item, index) => <span key={item.id}>{deadlineLine(item, index, rounds.length)}</span>)
                : dateLabel()}
            </dd>
          </div>
          {fee && (
            <div>
              <dt>{t("applicationFee")}</dt>
              <dd>{fee}</dd>
            </div>
          )}
          {program.lastVerifiedAt && (
            <div>
              <dt>{t("lastVerified")}</dt>
              <dd>{dateLabel(program.lastVerifiedAt)}</dd>
            </div>
          )}
        </dl>
        <div className="program-actions">
          <label>
            <span className="sr-only">{t("programStatus")}</span>
            <select
              disabled={saving === `program-${program.id}`}
              value={program.status ?? "researching"}
              onChange={(event) => onStatus(event.target.value as AdmissionsProgramStatus)}
            >
              {programStatuses(program.status).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {program.officialUrl && (
            <a href={program.officialUrl} target="_blank" rel="noreferrer">
              {t("openOfficial")} <Icon name="arrowUp" size={12} />
            </a>
          )}
        </div>
      </section>
      <section className="support-section program-overview">
        <header>
          <h4>{t("overview")}</h4>
          <span>{t("itemsCount", { count: summary.overview.length })}</span>
        </header>
        {summary.overview.length ? (
          summary.overview.map((item) => <p key={item}>{item}</p>)
        ) : (
          <p className="support-section-empty">{t("noProgramOverview")}</p>
        )}
      </section>
      <section className="requirements-section">
        <header>
          <h4>{t("materialsRequirements")}</h4>
          <span>{t("itemsCount", { count: requirementCount })}</span>
        </header>
        {summary.requirements.map((item) => (
          <article className="is-note" key={item}>
            <div>
              <b>{item}</b>
            </div>
          </article>
        ))}
        {requirements.length ? (
          requirements.map((requirement) => {
            const source = sources.find((item) => item.id === requirement.sourceId);
            return (
              <article key={requirement.id}>
                <div>
                  <small>
                    {requirement.dueAt ? dateLabel(requirement.dueAt) : t("noDeadline")}
                    {requirement.type ? ` · ${requirement.type}` : ""}
                  </small>
                  <b>{requirement.title}</b>
                  {requirement.notes && <p>{requirement.notes}</p>}
                  {source?.url && (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {t("viewRequirementSource")}
                    </a>
                  )}
                </div>
                <label>
                  <span className="sr-only">{t("requirementStatus")}</span>
                  <select
                    disabled={saving === `requirement-${requirement.id}`}
                    value={requirement.status ?? "missing"}
                    onChange={(event) =>
                      onRequirementStatus(requirement, event.target.value as AdmissionsRequirementStatus)
                    }
                  >
                    {requirementStatuses().map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </article>
            );
          })
        ) : !summary.requirements.length ? (
          <p className="support-section-empty">{t("noRequirements")}</p>
        ) : null}
      </section>
      <section className="support-section support-tasks">
        <header>
          <h4>{t("tasks")}</h4>
          <span>{t("openTodos", { count: tasks.length - completedTasks })}</span>
        </header>
        {tasks.length ? (
          tasks.map((task) => {
            const completed = isCompletedTask(task);
            return (
              <button
                key={task.id}
                className={completed ? "is-complete" : ""}
                disabled={saving === `task-${task.id}`}
                onClick={() => onToggleTask(task)}
              >
                <span className="task-check" aria-hidden="true">
                  {completed ? "✓" : ""}
                </span>
                <span>
                  <b>{task.title}</b>
                  <small>
                    {completed
                      ? t("reopen")
                      : `${dateLabel(task.dueAt ?? undefined)}${task.priority ? ` · ${priorityLabel(task.priority)}` : ""}`}
                  </small>
                </span>
              </button>
            );
          })
        ) : (
          <p className="support-section-empty">{t("noSchoolTasks")}</p>
        )}
      </section>
      <section className="support-list material-list">
        <header className="material-heading">
          <h4>{t("generatedFiles")}</h4>
          <span>{t("copies", { count: artifacts.length })}</span>
        </header>
        {artifacts.length ? (
          artifacts.map((artifact) => (
            <article key={artifact.id}>
              <header>
                <span>{artifact.kind ?? t("file")}</span>
                <time>{dateLabel(artifact.updatedAt)}</time>
              </header>
              <h3>{artifact.title}</h3>
              <footer>
                <span className={`support-status status-${artifact.status ?? "pending"}`}>
                  {statusLabel(artifact.status)}
                </span>
                <a href={api.admissionsArtifactDownloadUrl(artifact.id)}>
                  <Icon name="file" size={13} />
                  {t("download")}
                </a>
              </footer>
            </article>
          ))
        ) : (
          <p className="support-section-empty">{t("noGeneratedFiles")}</p>
        )}
      </section>
      <section className="support-section support-source-index">
        <header>
          <h4>{t("officialSources")}</h4>
          <span>{t("sourcesCount", { count: sources.length })}</span>
        </header>
        {sources.length ? (
          sources.map((source) => (
            <a key={source.id} href={source.url} target="_blank" rel="noreferrer" title={source.snippet}>
              <span>
                <b>{source.title || source.publisher || t("officialSource")}</b>
                <small>{source.snippet || t("openPage")}</small>
              </span>
              <time>{dateLabel(source.verifiedAt)}</time>
            </a>
          ))
        ) : (
          <p className="support-section-empty">{t("noVerifiedSources")}</p>
        )}
      </section>
      <footer className="program-delete-row">
        <button className="program-delete" onClick={onDelete} disabled={saving === `delete-${program.id}`}>
          <Icon name="trash" size={14} />
          {t("deleteProgram")}
        </button>
      </footer>
    </div>
  );
}

function AdmissionsBoard() {
  const { t } = useLocale();
  const [tab, setTab] = useState<"overview" | "programs" | "timeline">("overview");
  const [cycles, setCycles] = useState<AdmissionsCycle[]>([]);
  const [profile, setProfile] = useState<AdmissionsProfile>();
  const [programs, setPrograms] = useState<AdmissionsProgram[]>([]);
  const [tasks, setTasks] = useState<AdmissionsTask[]>([]);
  const [artifacts, setArtifacts] = useState<AdmissionsArtifact[]>([]);
  const [requirements, setRequirements] = useState<AdmissionsRequirement[]>([]);
  const [sources, setSources] = useState<AdmissionsSource[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<AdmissionsProgram>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState("");

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const cycleItems = await api.admissionsCycles();
      setCycles(cycleItems);
      if (!cycleItems.length) {
        setProfile(undefined);
        setPrograms([]);
        setTasks([]);
        setArtifacts([]);
        setRequirements([]);
        setSources([]);
        return;
      }
      const results = await Promise.allSettled([
        api.admissionsProfile(),
        api.admissionsPrograms(),
        api.admissionsTasks(),
        api.admissionsArtifacts(),
        api.admissionsSources()
      ]);
      setProfile(results[0].status === "fulfilled" ? results[0].value : undefined);
      const programItems = results[1].status === "fulfilled" ? results[1].value : [];
      setPrograms(programItems);
      setTasks(results[2].status === "fulfilled" ? results[2].value : []);
      setArtifacts(results[3].status === "fulfilled" ? results[3].value : []);
      setSources(results[4].status === "fulfilled" ? results[4].value : []);
      const requirementResults = await Promise.all(
        programItems.map((program) => api.admissionsRequirements(program.id).catch(() => []))
      );
      setRequirements(requirementResults.flat());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("admissionsLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingDelete) {
        event.stopImmediatePropagation();
        setPendingDelete(undefined);
        return;
      }
      if (selectedProgramId) {
        event.stopImmediatePropagation();
        setSelectedProgramId(undefined);
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [pendingDelete, selectedProgramId]);

  async function updateProgramStatus(program: AdmissionsProgram, status: AdmissionsProgramStatus) {
    setSaving(`program-${program.id}`);
    setError("");
    try {
      const updated = await api.updateAdmissionsProgram(program.id, { status });
      setPrograms((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("programStatusUpdateFailed"));
    } finally {
      setSaving(undefined);
    }
  }

  async function updateRequirementStatus(requirement: AdmissionsRequirement, status: AdmissionsRequirementStatus) {
    if (!requirement.programId) return;
    setSaving(`requirement-${requirement.id}`);
    setError("");
    try {
      const updated = await api.updateAdmissionsRequirement(requirement.programId, requirement.id, { status });
      setRequirements((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("requirementUpdateFailed"));
    } finally {
      setSaving(undefined);
    }
  }

  async function toggleTask(task: AdmissionsTask) {
    const completed = isCompletedTask(task);
    setSaving(`task-${task.id}`);
    setError("");
    try {
      const updated = await api.updateAdmissionsTask(task.id, {
        completed: !completed,
        status: !completed ? "completed" : "pending"
      });
      setTasks((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("taskUpdateFailed"));
    } finally {
      setSaving(undefined);
    }
  }

  async function deleteProgram(program: AdmissionsProgram) {
    setSaving(`delete-${program.id}`);
    setError("");
    try {
      await api.deleteAdmissionsProgram(program.id);
      setPrograms((items) => items.filter((item) => item.id !== program.id));
      setTasks((items) => items.filter((item) => item.programId !== program.id));
      setRequirements((items) => items.filter((item) => item.programId !== program.id));
      setArtifacts((items) => items.filter((item) => item.programId !== program.id));
      setSources((items) => items.filter((item) => item.programId !== program.id));
      if (selectedProgramId === program.id) setSelectedProgramId(undefined);
      setPendingDelete(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("programDeleteFailed"));
    } finally {
      setSaving(undefined);
    }
  }

  const timeline = useMemo(
    () =>
      [
        ...programs.flatMap((program) => {
          const items = programDeadlines(program);
          return items.map((item, index) => {
            const label = deadlineRoundLabel(item, index, items.length);
            return {
              id: `program-${program.id}-${item.id}`,
              date: item.dueAt,
              title: `${program.institution ? `${program.institution} · ` : ""}${program.name}`,
              kind: label ? `${t("deadlineKind")} · ${label}` : t("deadlineKind")
            };
          });
        }),
        ...tasks
          .filter((item) => item.dueAt)
          .map((item) => ({
            id: `task-${item.id}`,
            date: item.dueAt!,
            title: item.title,
            kind: statusLabel(item.status)
          })),
        ...requirements
          .filter((item) => item.dueAt)
          .map((item) => ({
            id: `requirement-${item.id}`,
            date: item.dueAt!,
            title: item.title,
            kind: t("requirementKind")
          }))
      ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)),
    [programs, requirements, tasks, t]
  );
  const completedTasks = tasks.filter(isCompletedTask).length;
  const submittedPrograms = programs.filter((item) => item.status?.toLowerCase() === "submitted").length;
  const selectedProgram = programs.find((item) => item.id === selectedProgramId);
  const deleteConfirm = (
    <ConfirmDialog
      open={Boolean(pendingDelete)}
      title={
        pendingDelete
          ? t("deleteProgramTitle", { name: pendingDelete.institution || pendingDelete.name })
          : t("deleteProgramGeneric")
      }
      description={pendingDelete ? t("deleteProgramBody", { name: pendingDelete.name }) : ""}
      working={pendingDelete ? saving === `delete-${pendingDelete.id}` : false}
      onCancel={() => setPendingDelete(undefined)}
      onConfirm={() => {
        if (pendingDelete) void deleteProgram(pendingDelete);
      }}
    />
  );

  if (loading)
    return (
      <div className="support-loading" role="status">
        {t("loadingAdmissions")}
      </div>
    );
  if (!cycles.length) return <AdmissionsOnboarding onComplete={loadBoard} />;
  if (selectedProgram)
    return (
      <>
        <ProgramDetail
          program={selectedProgram}
          tasks={tasks.filter((item) => item.programId === selectedProgram.id)}
          requirements={requirements.filter((item) => item.programId === selectedProgram.id)}
          artifacts={artifacts.filter((item) => item.programId === selectedProgram.id)}
          sources={sources.filter((item) => item.programId === selectedProgram.id)}
          saving={saving}
          error={error}
          onBack={() => setSelectedProgramId(undefined)}
          onStatus={(status) => void updateProgramStatus(selectedProgram, status)}
          onRequirementStatus={(requirement, status) => void updateRequirementStatus(requirement, status)}
          onToggleTask={(task) => void toggleTask(task)}
          onDelete={() => setPendingDelete(selectedProgram)}
        />
        {deleteConfirm}
      </>
    );
  return (
    <>
      <div className="support-tabs" role="tablist" aria-label={t("admissionsTabs")}>
        {(
          [
            ["overview", t("overview")],
            ["programs", t("programs")],
            ["timeline", t("timeline")]
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="support-content">
        {error && (
          <p className="support-inline-error" role="alert">
            {error}
          </p>
        )}
        {tab === "overview" &&
          (cycles.length || programs.length || tasks.length ? (
            <>
              <section className="support-hero">
                <p>{cycles[0]?.name ?? profile?.targetYear ?? t("currentCycle")}</p>
                <h3>
                  {cycles[0]?.fieldOfStudy ??
                    profile?.targetField ??
                    cycles[0]?.degree ??
                    profile?.targetDegree ??
                    t("admissionsProgress")}
                </h3>
                <small>
                  {cycles[0]?.targetRegions?.map(regionLabel).join(getLocale() === "en" ? ", " : "、") ||
                    profile?.summary ||
                    t("boardSummary")}
                </small>
              </section>
              <div className="support-metrics">
                <div>
                  <b>{programs.length}</b>
                  <span>{t("targetPrograms")}</span>
                </div>
                <div>
                  <b>{submittedPrograms}</b>
                  <span>{t("submitted")}</span>
                </div>
                <div>
                  <b>
                    {completedTasks}/{tasks.length}
                  </b>
                  <span>{t("tasksDone")}</span>
                </div>
              </div>
              <section className="support-section">
                <header>
                  <h4>{t("upNext")}</h4>
                  <span>{t("itemsCount", { count: timeline.length })}</span>
                </header>
                {timeline.slice(0, 4).map((item) => (
                  <div className="support-line" key={item.id}>
                    <time>{dateLabel(item.date)}</time>
                    <span>
                      <b>{item.title}</b>
                      <small>{item.kind}</small>
                    </span>
                  </div>
                ))}
              </section>
              <section className="support-section support-tasks">
                <header>
                  <h4>{t("tasks")}</h4>
                  <span>{t("openTodos", { count: tasks.length - completedTasks })}</span>
                </header>
                {tasks.length ? (
                  tasks.map((task) => {
                    const completed = isCompletedTask(task);
                    return (
                      <button
                        key={task.id}
                        className={completed ? "is-complete" : ""}
                        disabled={saving === `task-${task.id}`}
                        onClick={() => void toggleTask(task)}
                      >
                        <span className="task-check" aria-hidden="true">
                          {completed ? "✓" : ""}
                        </span>
                        <span>
                          <b>{task.title}</b>
                          <small>
                            {completed
                              ? t("reopen")
                              : `${dateLabel(task.dueAt ?? undefined)}${task.priority ? ` · ${priorityLabel(task.priority)}` : ""}`}
                          </small>
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <p className="support-section-empty">{t("noTasks")}</p>
                )}
              </section>
              {sources.length > 0 && (
                <section className="support-section support-source-index">
                  <header>
                    <h4>{t("officialSources")}</h4>
                    <span>{t("sourcesCount", { count: sources.length })}</span>
                  </header>
                  {sources.map((source) => (
                    <a key={source.id} href={source.url} target="_blank" rel="noreferrer" title={source.snippet}>
                      <span>
                        <b>{source.title || source.publisher || t("officialSource")}</b>
                        <small>{source.snippet || t("openPage")}</small>
                      </span>
                      <time>{dateLabel(source.verifiedAt)}</time>
                    </a>
                  ))}
                </section>
              )}
            </>
          ) : (
            <EmptySupport title={t("noAdmissionsData")} detail={t("noAdmissionsDetail")} />
          ))}
        {tab === "programs" &&
          (programs.length ? (
            <div className="support-list program-list">
              {programs.map((program) => {
                const programTasks = tasks.filter((item) => item.programId === program.id);
                const programRequirements = requirements.filter((item) => item.programId === program.id);
                const rounds = programDeadlines(program);
                const nextDeadline = nextProgramDeadline(program);
                const nextIndex = nextDeadline ? rounds.findIndex((item) => item.id === nextDeadline.id) : -1;
                return (
                  <article className="program-card" key={program.id}>
                    <button className="program-card-main" onClick={() => setSelectedProgramId(program.id)}>
                      <span>
                        <header>
                          <span>{program.degree ?? t("program")}</span>
                          <time>
                            {nextDeadline ? deadlineLine(nextDeadline, nextIndex, rounds.length) : dateLabel()}
                          </time>
                        </header>
                        <h3>{program.name}</h3>
                        <p>
                          {program.institution ?? t("schoolUnset")}
                          {program.country ? ` · ${program.country}` : ""}
                        </p>
                        <small>
                          {t("materialsCount", { count: programRequirements.length, tasks: programTasks.length })}
                        </small>
                      </span>
                      <Icon name="chevronRight" size={15} />
                    </button>
                    <div className="program-actions">
                      <label>
                        <span className="sr-only">{t("programStatus")}</span>
                        <select
                          disabled={saving === `program-${program.id}`}
                          value={program.status ?? "researching"}
                          onChange={(event) =>
                            void updateProgramStatus(program, event.target.value as AdmissionsProgramStatus)
                          }
                        >
                          {programStatuses(program.status).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div>
                        {program.officialUrl && (
                          <a href={program.officialUrl} target="_blank" rel="noreferrer">
                            {t("openOfficial")} <Icon name="arrowUp" size={12} />
                          </a>
                        )}
                        <button
                          className="program-delete-icon"
                          onClick={() => setPendingDelete(program)}
                          aria-label={t("removeFile", { name: program.name })}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptySupport title={t("noPrograms")} detail={t("noProgramsDetail")} />
          ))}
        {tab === "timeline" &&
          (timeline.length ? (
            <div className="support-timeline">
              {timeline.map((item) => (
                <article key={item.id}>
                  <time>{dateLabel(item.date)}</time>
                  <i />
                  <span>
                    <b>{item.title}</b>
                    <small>{item.kind}</small>
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <EmptySupport title={t("noTimeline")} detail={t("noTimelineDetail")} />
          ))}
      </div>
      {deleteConfirm}
    </>
  );
}

/** Zones offered for a scheduled job, system zone first, current value always present. */
export const SCHEDULE_TIMEZONE_CHOICES = [
  "Asia/Shanghai",
  "America/Chicago",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Singapore",
  "Asia/Hong_Kong"
] as const;

export function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

export function scheduleTimezoneOptions(current: string, system = systemTimezone()): string[] {
  return [...new Set([system, ...SCHEDULE_TIMEZONE_CHOICES, current].filter(Boolean))];
}

export function jobTimezone(job: ScheduledJob): string {
  return typeof job.timezone === "string" && job.timezone ? job.timezone : systemTimezone();
}

/** Next-run label rendered in the job's own zone, so it matches the timezone selector below it. */
function zonedRunLabel(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString(localeTag(), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone
    });
  } catch {
    return dateLabel(value);
  }
}

function ScheduledJobsPanel({ scheduledRunId }: { scheduledRunId?: string }) {
  const { t } = useLocale();
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<ScheduledJobRun[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>();
  const [report, setReport] = useState<ScheduledJobRun>();
  const [timezoneError, setTimezoneError] = useState("");
  const [loading, setLoading] = useState(true);
  const system = useMemo(systemTimezone, []);

  useEffect(() => {
    void api
      .scheduledJobs()
      .then(setJobs)
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!scheduledRunId) return;
    void api
      .scheduledJobRun(scheduledRunId)
      .then(setReport)
      .catch(() => setReport(undefined));
  }, [scheduledRunId]);
  async function openJob(id: string) {
    setSelectedJob(id);
    setReport(undefined);
    setRuns(await api.scheduledJobRuns(id).catch(() => []));
  }
  async function openReport(id: string) {
    setReport(await api.scheduledJobRun(id).catch(() => undefined));
  }
  async function toggleJob(job: ScheduledJob) {
    const updated = await api.updateScheduledJob(job.id, { enabled: job.enabled === false }).catch(() => undefined);
    if (updated) setJobs((items) => items.map((item) => (item.id === job.id ? { ...item, ...updated } : item)));
  }
  async function runNow(id: string) {
    const run = await api.runScheduledJob(id).catch(() => undefined);
    if (run) setRuns((items) => [run, ...items.filter((item) => item.id !== run.id)]);
  }
  async function changeTimezone(job: ScheduledJob, timezone: string) {
    if (timezone === jobTimezone(job)) return;
    setTimezoneError("");
    const updated = await api.updateScheduledJob(job.id, { timezone }).catch(() => undefined);
    if (!updated) {
      setTimezoneError(t("scheduleTimezoneFailed"));
      return;
    }
    setJobs((items) => items.map((item) => (item.id === job.id ? { ...item, ...updated } : item)));
  }
  if (loading)
    return (
      <div className="support-loading" role="status">
        {t("loadingSchedules")}
      </div>
    );
  if (report)
    return (
      <div className="report-view">
        <button onClick={() => setReport(undefined)}>
          <Icon name="chevronRight" size={14} />
          {t("backToRuns")}
        </button>
        <p>{statusLabel(report.status)}</p>
        <h3>{report.title ?? t("jobReport")}</h3>
        <small>
          {report.startedAt
            ? `${dateLabel(report.startedAt)}${report.completedAt ? ` · ${dateLabel(report.completedAt)}` : ""}`
            : ""}
        </small>
        {Boolean(report.blocks?.length) && (
          <div className="report-activities">
            {report.blocks?.map((block) => (
              <ActivityBlock key={block.id} block={block} defaultExpanded />
            ))}
          </div>
        )}
        <div>{report.content ?? report.summary ?? t("noReportText")}</div>
      </div>
    );
  if (selectedJob)
    return (
      <div className="job-runs">
        <div className="job-runs-toolbar">
          <button
            onClick={() => {
              setSelectedJob(undefined);
              setRuns([]);
            }}
          >
            <Icon name="chevronRight" size={14} />
            {t("allSchedules")}
          </button>
          <button onClick={() => void runNow(selectedJob)}>{t("runNow")}</button>
        </div>
        {runs.length ? (
          runs.map((run) => (
            <button className="job-run" key={run.id} onClick={() => void openReport(run.id)}>
              <span className={`run-dot status-${run.status ?? "pending"}`} />
              <span>
                <b>{run.title ?? dateLabel(run.startedAt)}</b>
                <small>
                  {statusLabel(run.status)}
                  {run.startedAt ? ` · ${dateLabel(run.startedAt)}` : ""}
                </small>
              </span>
              <Icon name="chevronRight" size={14} />
            </button>
          ))
        ) : (
          <EmptySupport title={t("noRuns")} detail={t("noRunsDetail")} />
        )}
      </div>
    );
  return jobs.length ? (
    <div className="scheduled-jobs">
      {timezoneError && (
        <p className="settings-error" role="alert">
          {timezoneError}
        </p>
      )}
      {jobs.map((job) => (
        <article key={job.id}>
          <button className="scheduled-job-main" onClick={() => void openJob(job.id)}>
            <span className="scheduled-job-icon">
              <Icon name="clock" />
            </span>
            <span>
              <b>{job.name}</b>
              <small>
                {job.schedule ?? t("scheduledRun")} ·{" "}
                {job.nextRunAt
                  ? t("nextRun", { date: zonedRunLabel(job.nextRunAt, jobTimezone(job)) })
                  : job.enabled === false
                    ? t("paused")
                    : t("waitingRun")}
              </small>
            </span>
            <Icon name="chevronRight" size={15} />
          </button>
          <label className="schedule-timezone">
            <small>{t("scheduleTimezone")}</small>
            <select value={jobTimezone(job)} onChange={(event) => void changeTimezone(job, event.target.value)}>
              {scheduleTimezoneOptions(jobTimezone(job), system).map((zone) => (
                <option key={zone} value={zone}>
                  {zone === system ? t("scheduleTimezoneSystem", { zone }) : zone}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`schedule-toggle ${job.enabled !== false ? "is-on" : ""}`}
            aria-pressed={job.enabled !== false}
            onClick={() => void toggleJob(job)}
          >
            <span />
            {job.enabled !== false ? t("turnedOn") : t("paused")}
          </button>
        </article>
      ))}
    </div>
  ) : (
    <EmptySupport title={t("noSchedules")} detail={t("noSchedulesDetail")} />
  );
}

function learningLabel(value: string) {
  return t(
    `learning${value
      .split("_")
      .map((part) => (part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : ""))
      .join("")}` as Parameters<typeof t>[0]
  );
}

function OutcomeButtons({
  verification,
  ready,
  finalRound,
  onConfirm
}: {
  verification: LearningVerificationDto;
  ready: boolean;
  /** One-shot baseline: "unresolved" is a final record, not a request for another strategy. */
  finalRound?: boolean;
  onConfirm: (verdict: "resolved" | "partial" | "unresolved") => void;
}) {
  if (!ready) return null;
  return (
    <div className="learning-outcome-buttons">
      <span>{t("learningOutcomePrompt")}</span>
      <button onClick={() => onConfirm("resolved")}>{t("learningUnderstood")}</button>
      <button onClick={() => onConfirm("partial")}>{t("learningPartlyUnderstood")}</button>
      <button onClick={() => onConfirm("unresolved")}>
        {finalRound ? t("learningStillStuckFinal") : t("learningStillStuck")}
      </button>
    </div>
  );
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatRounds(value: number | null): string {
  return value === null ? "—" : (Math.round(value * 10) / 10).toString();
}

function LearningMetricsView({
  metrics,
  loading,
  scope,
  hasTopic,
  onScope,
  researchEnabled,
  onToggleResearch
}: {
  metrics?: LearningMetricsDto;
  loading: boolean;
  scope: "topic" | "all";
  hasTopic: boolean;
  onScope: (scope: "topic" | "all") => void;
  researchEnabled: boolean;
  onToggleResearch: (enabled: boolean) => Promise<boolean>;
}) {
  const cellRows = (cell: LearningMetricsCellDto) => [
    { label: t("learningMetricsIncidents"), value: String(cell.incidents) },
    {
      label: t("learningMetricsResolved"),
      value: cell.incidents === 0 ? "—" : formatRate(cell.outcomes.resolved / cell.incidents)
    },
    { label: t("learningMetricsMeanRounds"), value: formatRounds(cell.meanInterventionRounds) },
    { label: t("learningMetricsFirstRound"), value: formatRate(cell.firstRoundResolutionRate) },
    { label: t("learningMetricsCoverage"), value: formatRate(cell.resolutionWithoutEscalationRate) },
    {
      label: t("learningMetricsEscalated"),
      value: cell.incidents === 0 ? "—" : formatRate(cell.escalated / cell.incidents)
    }
  ];
  const conditionLabel = (condition: "on-call" | "one-shot") =>
    condition === "on-call" ? t("learningConditionOnCall") : t("learningConditionOneShot");
  const comparableConditions = metrics?.conditions.filter((cell) => cell.incidents > 0) ?? [];
  const calibration = (metrics?.calibration ?? []).filter((bin) => bin.count > 0);
  return (
    <div className="learning-metrics">
      <div className="learning-research-toggle">
        <label>
          <input
            type="checkbox"
            checked={researchEnabled}
            onChange={(event) => void onToggleResearch(event.target.checked)}
          />
          <span>{t("researchMode")}</span>
        </label>
        <small>{t("researchModeHint")}</small>
      </div>
      {hasTopic && (
        <div className="learning-metrics-scope" role="radiogroup" aria-label={t("learningMetricsTab")}>
          {(["topic", "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={scope === option}
              className={scope === option ? "is-selected" : ""}
              onClick={() => onScope(option)}
            >
              {option === "topic" ? t("learningMetricsScopeTopic") : t("learningMetricsScopeAll")}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div className="support-loading">{t("loading")}</div>
      ) : !metrics || metrics.overall.incidents === 0 ? (
        <EmptySupport title={t("learningMetricsEmpty")} detail={t("learningMetricsEmptyDetail")} />
      ) : (
        <>
          <div className="learning-metrics-tiles">
            {cellRows(metrics.overall).map((row) => (
              <div className="learning-metrics-tile" key={row.label}>
                <b>{row.value}</b>
                <small>{row.label}</small>
              </div>
            ))}
          </div>
          {comparableConditions.length > 0 && (
            <section className="learning-metrics-section">
              <h4>{t("learningMetricsByCondition")}</h4>
              <table className="learning-metrics-table">
                <thead>
                  <tr>
                    <th>{t("learningMetricsConditionColumn")}</th>
                    <th>{t("learningMetricsIncidents")}</th>
                    <th>{t("learningMetricsResolved")}</th>
                    <th>{t("learningMetricsMeanRounds")}</th>
                    <th>{t("learningMetricsCoverage")}</th>
                    <th>{t("learningMetricsEscalated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {comparableConditions.map((cell) => (
                    <tr key={cell.condition}>
                      <td>{conditionLabel(cell.condition)}</td>
                      <td>{cell.incidents}</td>
                      <td>{cell.incidents === 0 ? "—" : formatRate(cell.outcomes.resolved / cell.incidents)}</td>
                      <td>{formatRounds(cell.meanInterventionRounds)}</td>
                      <td>{formatRate(cell.resolutionWithoutEscalationRate)}</td>
                      <td>{cell.incidents === 0 ? "—" : formatRate(cell.escalated / cell.incidents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {metrics.overall.strategyOutcomes.length > 0 && (
            <section className="learning-metrics-section">
              <h4>{t("learningMetricsStrategyTitle")}</h4>
              <table className="learning-metrics-table">
                <thead>
                  <tr>
                    <th />
                    <th>{t("learningMetricsResolved")}</th>
                    <th>{t("learningMetricsPartial")}</th>
                    <th>{t("learningMetricsUnresolved")}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.overall.strategyOutcomes.map((row) => (
                    <tr key={row.strategy}>
                      <td>{learningLabel(row.strategy)}</td>
                      <td>{row.resolved}</td>
                      <td>{row.partial}</td>
                      <td>{row.unresolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {calibration.length > 0 && (
            <section className="learning-metrics-section">
              <h4>{t("learningMetricsCalibration")}</h4>
              <svg
                className="learning-calibration-chart"
                viewBox={`0 0 ${calibration.length * 64 + 8} 96`}
                role="img"
                aria-label={t("learningMetricsCalibration")}
              >
                {calibration.map((bin, index) => {
                  const rate = bin.agreementRate ?? 0;
                  const height = Math.max(2, Math.round(rate * 64));
                  return (
                    <g key={bin.lower} transform={`translate(${index * 64 + 8}, 0)`}>
                      <rect className="calibration-track" x={8} y={8} width={40} height={64} rx={4} />
                      <rect className="calibration-bar" x={8} y={8 + (64 - height)} width={40} height={height} rx={4} />
                      <text className="calibration-value" x={28} y={Math.max(18, 8 + (64 - height) - 3)}>
                        {Math.round(rate * 100)}%
                      </text>
                      <text className="calibration-label" x={28} y={84}>
                        {bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}
                      </text>
                      <text className="calibration-count" x={28} y={94}>
                        n={bin.count}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <small>{t("learningMetricsCalibrationDetail")}</small>
            </section>
          )}
          {researchEnabled && (
            <section className="learning-metrics-section">
              <a className="learning-metrics-export" href="/api/learning/export?includeMessages=true" download>
                {t("learningMetricsExport")}
              </a>
              <small>{t("learningMetricsExportDetail")}</small>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function LearningAssessment({ verification }: { verification: LearningVerificationDto }) {
  if (!verification.systemVerdict) return null;
  return (
    <div className="learning-assessment">
      <span>
        <small>{t("learningSystemAssessment")}</small>
        <b>{learningLabel(verification.systemVerdict)}</b>
      </span>
      {verification.systemConfidence !== null && (
        <em>{t("learningAssessmentConfidence", { value: Math.round(verification.systemConfidence * 100) })}</em>
      )}
      {verification.userVerdict && (
        <span className="is-user">
          <small>{t("learningUserAssessment")}</small>
          <b>{learningLabel(verification.userVerdict)}</b>
        </span>
      )}
    </div>
  );
}

function LearningHandoffSection({ incidentId }: { incidentId: string }) {
  const { t } = useLocale();
  const [report, setReport] = useState<LearningHandoffReportDto | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (report || loading) return;
    setLoading(true);
    try {
      setReport(await api.learningHandoff(incidentId));
    } catch {
      // The report only exists for escalated incidents; keep the section quiet otherwise.
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      className="learning-rubric learning-handoff"
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open) void load();
      }}
    >
      <summary>{t("learningHandoffTitle")}</summary>
      {loading && <p>{t("loading")}</p>}
      {report && (
        <div className="learning-handoff-body">
          {report.escalationReason && (
            <p>
              <b>{t("learningHandoffReason")}</b>: {report.escalationReason}
            </p>
          )}
          <p>
            <b>{t("learningHandoffAttempts")}</b>
          </p>
          <ul>
            {report.attempts.map((attempt) => (
              <li key={attempt.round}>
                {t("learningRound", { count: attempt.round })} · {learningLabel(attempt.strategy)} →{" "}
                {attempt.outcome ? learningLabel(attempt.outcome) : t("learningHandoffUnverified")}
              </li>
            ))}
          </ul>
          {report.stillOpen.length > 0 && (
            <>
              <p>
                <b>{t("learningHandoffStillOpen")}</b>
              </p>
              <ul>
                {report.stillOpen.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {report.suggestedNextStrategies.length > 0 && (
            <p>
              <b>{t("learningHandoffNext")}</b>:{" "}
              {report.suggestedNextStrategies.map((strategy) => learningLabel(strategy)).join(" · ")}
            </p>
          )}
        </div>
      )}
    </details>
  );
}

function LearningPanel({
  conversation,
  onSessionUpdate,
  onConfirmVerification,
  researchEnabled,
  onToggleResearch
}: {
  conversation?: ConversationDetail;
  onSessionUpdate: (input: { status?: "active" | "paused" | "completed" | "dismissed" }) => Promise<boolean>;
  onConfirmVerification: (id: string, verdict: "resolved" | "partial" | "unresolved") => Promise<boolean>;
  researchEnabled: boolean;
  onToggleResearch: (enabled: boolean) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"current" | "history" | "policies" | "metrics">("current");
  const [policies, setPolicies] = useState<LearningPolicyRevisionDto[]>([]);
  const [loadingPolicies, setLoadingPolicies] = useState(false);
  const [metrics, setMetrics] = useState<LearningMetricsDto>();
  const [metricsScope, setMetricsScope] = useState<"topic" | "all">("topic");
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [busy, setBusy] = useState<string>();
  const session = conversation?.learningSession;
  const profileId = session?.profileId ?? conversation?.profileId;

  const loadPolicies = useCallback(async () => {
    if (!session || !profileId || session.datasetKind === "replay") {
      setPolicies([]);
      return;
    }
    setLoadingPolicies(true);
    try {
      setPolicies(
        await api.learningPolicies({
          profileId,
          topicKey: session.topicKey,
          datasetKind: session.datasetKind === "demo" ? "demo" : "live",
          includeDisabled: true
        })
      );
    } finally {
      setLoadingPolicies(false);
    }
  }, [session, profileId]);

  useEffect(() => {
    if (tab === "policies") void loadPolicies();
  }, [tab, loadPolicies]);

  const loadMetrics = useCallback(async () => {
    if (!session || !profileId) {
      setMetrics(undefined);
      return;
    }
    setLoadingMetrics(true);
    try {
      setMetrics(
        await api.learningMetrics({
          profileId,
          datasetKind: session.datasetKind,
          ...(metricsScope === "topic" && session.topicKey ? { topicKey: session.topicKey } : {})
        })
      );
    } catch {
      setMetrics(undefined);
    } finally {
      setLoadingMetrics(false);
    }
  }, [session, profileId, metricsScope]);

  useEffect(() => {
    if (tab === "metrics") void loadMetrics();
  }, [tab, loadMetrics]);
  if (!session) return <EmptySupport title={t("learningNoSession")} detail={t("learningNoSessionDetail")} />;
  const current = session.incidents.find((incident) =>
    ["observing", "diagnosed", "intervening", "verifying"].includes(incident.status)
  );
  const syntheticExperienceSummary =
    session.datasetKind === "demo" ? summarizeSyntheticSeedIncidents(session.incidents) : null;
  const historical = session.incidents.filter(
    (incident) => incident.id !== current?.id && !(session.datasetKind === "demo" && isSyntheticSeedIncident(incident))
  );
  async function review(policy: LearningPolicyRevisionDto, verdict: "pass" | "reject") {
    setBusy(policy.id);
    try {
      await api.reviewLearningPolicy(policy.id, verdict, conversation?.id);
      await loadPolicies();
    } finally {
      setBusy(undefined);
    }
  }
  async function rollback(policy: LearningPolicyRevisionDto) {
    setBusy(policy.id);
    try {
      await api.rollbackLearningPolicy(policy.id, conversation?.id);
      await loadPolicies();
    } finally {
      setBusy(undefined);
    }
  }
  const incidentView = (incident: NonNullable<typeof current>) => (
    <article className="learning-incident" key={incident.id}>
      <header>
        <span className={`learning-state state-${incident.status}`}>{learningLabel(incident.status)}</span>
        <small>{learningLabel(incident.difficultyType)}</small>
      </header>
      <h3>{incident.hypothesis}</h3>
      <p>
        {t("learningEvidenceCount", { count: incident.evidenceMessageIds.length })} ·{" "}
        {t("learningConfidence", { value: Math.round(incident.confidence * 100) })}
      </p>
      {incident.interventions.length > 0 && (
        <section>
          <h4>{t("learningInterventions")}</h4>
          {incident.interventions.map((item) => (
            <div className="learning-entry" key={item.id}>
              <b>
                {t("learningRound", { count: item.round })} · {learningLabel(item.strategy)}
              </b>
              <small>{item.rationale}</small>
            </div>
          ))}
        </section>
      )}
      {incident.verifications.length > 0 && (
        <section>
          <h4>{t("learningVerifications")}</h4>
          {incident.verifications.map((item) => (
            <div className="learning-entry" key={item.id}>
              <b>{learningLabel(item.method)}</b>
              <small>{item.prompt}</small>
              {item.rubric && (
                <details className="learning-rubric">
                  <summary>{t("learningVerificationRubric")}</summary>
                  <p>{item.rubric}</p>
                </details>
              )}
              <LearningAssessment verification={item} />
              <OutcomeButtons
                verification={item}
                ready={canConfirmLearningVerification(
                  item,
                  incident.interventions,
                  conversation?.messages ?? [],
                  conversation?.activeRunId
                )}
                finalRound={session.condition === "one-shot"}
                onConfirm={(verdict) => void onConfirmVerification(item.id, verdict)}
              />
            </div>
          ))}
        </section>
      )}
      {incident.status === "escalated" && <LearningHandoffSection incidentId={incident.id} />}
    </article>
  );
  return (
    <div className="learning-panel">
      <div className="learning-session-summary">
        <p>
          {session.datasetKind === "demo"
            ? session.executionMode === "agent"
              ? t("learningAgentDemo")
              : t("learningDemo")
            : t("learningMode")}
          {session.condition === "one-shot" && (
            <span className="learning-condition-badge">{t("learningConditionBadgeOneShot")}</span>
          )}
        </p>
        <h3>{session.goal}</h3>
        {session.topicKey && <small>{session.topicKey}</small>}
        <footer className="learning-session-controls">
          <span className={`learning-session-presence is-${session.status}`} role="status">
            <i aria-hidden="true" />
            {learningLabel(session.status)}
          </span>
          {["active", "paused"].includes(session.status) && (
            <div className="learning-session-actions">
              {session.status === "active" && (
                <button onClick={() => void onSessionUpdate({ status: "paused" })}>{t("learningPause")}</button>
              )}
              {session.status === "paused" && (
                <button onClick={() => void onSessionUpdate({ status: "active" })}>{t("learningResume")}</button>
              )}
              <button className="is-danger" onClick={() => void onSessionUpdate({ status: "completed" })}>
                {t("learningEnd")}
              </button>
            </div>
          )}
        </footer>
      </div>
      {syntheticExperienceSummary && syntheticExperienceSummary.total > 0 && (
        <aside className="learning-synthetic-experiences">
          <b>{t("learningSyntheticExperiences", { count: syntheticExperienceSummary.total })}</b>
          <p>{t("learningSyntheticExperiencesDetail")}</p>
          {syntheticExperienceSummary.entries.map((entry) => (
            <small key={`${entry.strategy}-${entry.outcome}`}>
              {t("learningSyntheticExperienceLine", {
                strategy: learningLabel(entry.strategy),
                outcome: learningLabel(entry.outcome),
                count: entry.count
              })}
            </small>
          ))}
        </aside>
      )}
      <nav className="support-tabs" aria-label={t("learningMode")}>
        <button className={tab === "current" ? "active" : ""} onClick={() => setTab("current")}>
          {t("learningCurrent")}
        </button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
          {t("learningHistory")}
        </button>
        <button className={tab === "policies" ? "active" : ""} onClick={() => setTab("policies")}>
          {t("learningPolicies")}
        </button>
        <button className={tab === "metrics" ? "active" : ""} onClick={() => setTab("metrics")}>
          {t("learningMetricsTab")}
        </button>
      </nav>
      <div className="support-content">
        {tab === "current" ? (
          current ? (
            incidentView(current)
          ) : (
            <EmptySupport title={t("learningObserving")} detail={t("learningObservingDetail")} />
          )
        ) : tab === "history" ? (
          historical.length ? (
            <div className="learning-incident-list">{historical.map(incidentView)}</div>
          ) : (
            <EmptySupport title={t("learningNoHistory")} detail={t("learningNoHistoryDetail")} />
          )
        ) : tab === "metrics" ? (
          <LearningMetricsView
            metrics={metrics}
            loading={loadingMetrics}
            scope={metricsScope}
            hasTopic={Boolean(session.topicKey)}
            onScope={setMetricsScope}
            researchEnabled={researchEnabled}
            onToggleResearch={onToggleResearch}
          />
        ) : loadingPolicies ? (
          <div className="support-loading">{t("loading")}</div>
        ) : policies.length ? (
          <div className="learning-policy-list">
            {policies.map((policy) => (
              <article key={policy.id}>
                <header>
                  <span className={`learning-state state-${policy.status}`}>{learningLabel(policy.status)}</span>
                  <small>{learningLabel(policy.difficultyType)}</small>
                </header>
                <p>{policy.orderedStrategies.map(learningLabel).join(" → ")}</p>
                <small>
                  {policy.preview
                    ? t("learningPolicyEvidenceSummary", { count: policy.preview.snapshotCount })
                    : policy.evidenceExperienceIds.length === 0 && !policy.previousRevisionId
                      ? t("learningPolicyBaseline")
                      : policy.evaluationSummary || t("learningPolicyNoSummary")}
                </small>
                {policy.preview && (
                  <div className="learning-policy-preview">
                    <b>{t("learningPolicyPreview")}</b>
                    <span>
                      {learningLabel(policy.preview.currentFirstStrategy)} →{" "}
                      {learningLabel(policy.preview.candidateFirstStrategy)}
                    </span>
                    <small>
                      {t("learningPolicyPreviewChanged", {
                        changed: policy.preview.changedSelectionCount,
                        total: policy.preview.snapshotCount
                      })}
                    </small>
                  </div>
                )}
                {policy.status === "pending" && (
                  <footer>
                    <button disabled={busy === policy.id} onClick={() => void review(policy, "pass")}>
                      {t("learningEnable")}
                    </button>
                    <button
                      disabled={busy === policy.id}
                      className="danger"
                      onClick={() => void review(policy, "reject")}
                    >
                      {t("learningReject")}
                    </button>
                  </footer>
                )}
                {policy.status === "enabled" && policy.previousRevisionId && (
                  <footer>
                    <button disabled={busy === policy.id} onClick={() => void rollback(policy)}>
                      {t("learningRollback")}
                    </button>
                  </footer>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptySupport title={t("learningNoPolicies")} detail={t("learningNoPoliciesDetail")} />
        )}
      </div>
    </div>
  );
}

export function SupportPanel({
  kind,
  onClose,
  scheduledRunId,
  conversation,
  onSessionUpdate,
  onConfirmVerification,
  researchEnabled,
  onToggleResearch
}: {
  kind?: SupportPanelKind;
  onClose: () => void;
  scheduledRunId?: string;
  conversation?: ConversationDetail;
  onSessionUpdate?: (input: { status?: "active" | "paused" | "completed" | "dismissed" }) => Promise<boolean>;
  onConfirmVerification?: (id: string, verdict: "resolved" | "partial" | "unresolved") => Promise<boolean>;
  researchEnabled?: boolean;
  onToggleResearch?: (enabled: boolean) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [docked, setDocked] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches
  );
  useEffect(() => {
    if (!kind) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [kind, onClose]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDocked(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <AnimatePresence>
      {kind && (
        <motion.div
          className={`support-layer ${docked ? "is-docked" : "is-modal"}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (!docked && event.target === event.currentTarget) onClose();
          }}
        >
          <motion.aside
            className="support-panel"
            role={docked ? "complementary" : "dialog"}
            aria-modal={docked ? undefined : true}
            aria-labelledby="support-title"
            initial={{ opacity: 0, x: docked ? 18 : 0, y: docked ? 0 : 12, scale: docked ? 1 : 0.99 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: docked ? 12 : 0, y: docked ? 0 : 9, scale: docked ? 1 : 0.99 }}
            transition={{ type: "spring", bounce: 0, duration: 0.3 }}
          >
            <header>
              <div>
                <p>{t("supportEyebrow")}</p>
                <h2 id="support-title">
                  {kind === "admissions"
                    ? t("admissionsBoard")
                    : kind === "schedules"
                      ? t("scheduledJobs")
                      : t("learningMode")}
                </h2>
              </div>
              <button onClick={onClose} aria-label={t("closeSupport")}>
                <Icon name="close" />
              </button>
            </header>
            <div className="support-scroll">
              {kind === "admissions" ? (
                <AdmissionsBoard />
              ) : kind === "schedules" ? (
                <ScheduledJobsPanel scheduledRunId={scheduledRunId} />
              ) : (
                <LearningPanel
                  conversation={conversation}
                  onSessionUpdate={onSessionUpdate ?? (async () => false)}
                  onConfirmVerification={onConfirmVerification ?? (async () => false)}
                  researchEnabled={researchEnabled ?? false}
                  onToggleResearch={onToggleResearch ?? (async () => false)}
                />
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
