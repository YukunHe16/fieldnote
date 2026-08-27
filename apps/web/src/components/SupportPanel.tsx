import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { getLocale, t, useLocale } from "../i18n";
import { Icon } from "../icons";
import type {
  ConversationDetail,
  LearningMetricsCellDto,
  LearningHandoffReportDto,
  LearningMetricsDto,
  LearningStrategyVariantDto,
  LearningPolicyRevisionDto,
  LearningVerificationDto
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ActivityBlock } from "./Messages";
import {
  canConfirmLearningVerification,
  isSyntheticSeedIncident,
  summarizeSyntheticSeedIncidents
} from "../learningPresentation";

export type SupportPanelKind = "learning";

function EmptySupport({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="support-empty">
      <Icon name="activity" />
      <p>{title}</p>
      <small>{detail}</small>
    </div>
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

/** Below this many confirmed verifications a confidence bucket is a record, not a rate. */
const CALIBRATION_MIN_N = 5;

function LearningMetricsView({
  metrics,
  loading,
  scope,
  topicKey,
  onScope,
  researchEnabled,
  exportParticipantId
}: {
  metrics?: LearningMetricsDto;
  loading: boolean;
  exportParticipantId?: string;
  scope: "topic" | "all";
  topicKey: string | null;
  onScope: (scope: "topic" | "all") => void;
  researchEnabled: boolean;
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
  const conditionLabel = (condition: "on-call" | "one-shot" | "multi-turn") =>
    condition === "on-call"
      ? t("learningConditionOnCall")
      : condition === "one-shot"
        ? t("learningConditionOneShot")
        : t("learningConditionMultiTurn");
  const comparableConditions = metrics?.conditions.filter((cell) => cell.incidents > 0) ?? [];
  const calibration = metrics?.calibration ?? [];
  const hasCalibration = calibration.some((bin) => bin.count > 0);
  return (
    <div className="learning-metrics">
      {!researchEnabled && <p className="learning-research-note">{t("researchModeWhere")}</p>}
      {topicKey && (
        <div className="learning-metrics-scope-row">
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
          <small>{t("learningMetricsScopeHint", { topic: topicKey })}</small>
        </div>
      )}
      {loading ? (
        <div className="support-loading">{t("loading")}</div>
      ) : !metrics || (metrics.overall.incidents === 0 && (metrics.sessions?.total ?? 0) === 0) ? (
        <EmptySupport title={t("learningMetricsEmpty")} detail={t("learningMetricsEmptyDetail")} />
      ) : (
        <>
          {metrics.overall.incidents > 0 && (
            <div className="learning-metrics-tiles">
              {cellRows(metrics.overall).map((row) => (
                <div className="learning-metrics-tile" key={row.label}>
                  <b>{row.value}</b>
                  <small>{row.label}</small>
                </div>
              ))}
            </div>
          )}
          {metrics.sessions && metrics.sessions.total > 0 && (
            <section className="learning-metrics-section">
              <h4>{t("learningMetricsReliability")}</h4>
              <div className="learning-metrics-tiles">
                {[
                  { label: t("learningMetricsSessions"), value: String(metrics.sessions.total) },
                  {
                    label: t("learningMetricsStalled"),
                    // Categories overlap; `unhealthy` is the distinct-session numerator.
                    value:
                      metrics.sessions.total === 0
                        ? "—"
                        : formatRate(metrics.sessions.unhealthy / metrics.sessions.total)
                  },
                  { label: t("learningMetricsNeverOpened"), value: String(metrics.sessions.neverOpened) },
                  { label: t("learningMetricsErrored"), value: String(metrics.sessions.errored) },
                  {
                    label: t("learningMetricsNudged"),
                    value: `${metrics.sessions.recoveredAfterNudge}/${metrics.sessions.nudged}`
                  }
                ].map((row) => (
                  <div className="learning-metrics-tile" key={row.label}>
                    <b>{row.value}</b>
                    <small>{row.label}</small>
                  </div>
                ))}
              </div>
            </section>
          )}
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
              <small>{t("learningMetricsStrategyDetail")}</small>
            </section>
          )}
          {hasCalibration && (
            <section className="learning-metrics-section">
              <h4>{t("learningMetricsCalibration")}</h4>
              <svg
                className="learning-calibration-chart"
                viewBox="0 0 240 86"
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={t("learningMetricsCalibration")}
              >
                {calibration.map((bin, index) => {
                  const slot = 240 / calibration.length;
                  const cx = index * slot + slot / 2;
                  const width = Math.min(28, slot - 12);
                  const rate = bin.agreementRate;
                  const height = rate === null ? 0 : Math.max(2, Math.round(rate * 56));
                  // A bucket holding one or two verifications is a record, not a rate.
                  // Hollow bars keep it from being read as a result.
                  const sparse = bin.count > 0 && bin.count < CALIBRATION_MIN_N;
                  const onBar = height > 40;
                  return (
                    <g key={bin.lower}>
                      <rect className="calibration-track" x={cx - width / 2} y={6} width={width} height={56} rx={3} />
                      {rate !== null && (
                        <rect
                          className={sparse ? "calibration-bar is-sparse" : "calibration-bar"}
                          x={cx - width / 2}
                          y={6 + (56 - height)}
                          width={width}
                          height={height}
                          rx={3}
                        />
                      )}
                      {rate !== null && (
                        <text
                          className={onBar && !sparse ? "calibration-value on-bar" : "calibration-value"}
                          x={cx}
                          y={onBar ? 18 : 6 + (56 - height) - 3}
                        >
                          {Math.round(rate * 100)}%
                        </text>
                      )}
                      <text className="calibration-label" x={cx} y={74}>
                        {bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}
                      </text>
                      <text className="calibration-count" x={cx} y={84}>
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
              <div className="learning-metrics-exports">
                <a
                  className="learning-metrics-export"
                  href={`/api/learning/export?includeMessages=true${
                    exportParticipantId ? `&participantId=${encodeURIComponent(exportParticipantId)}` : ""
                  }`}
                  download
                >
                  {t("learningMetricsExport")}
                </a>
                <a
                  className="learning-metrics-export"
                  href={`/api/learning/export/html${
                    exportParticipantId ? `?participantId=${encodeURIComponent(exportParticipantId)}` : ""
                  }`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("learningMetricsExportHtml")}
                </a>
              </div>
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
  researchEnabled
}: {
  conversation?: ConversationDetail;
  onSessionUpdate: (input: { status?: "active" | "paused" | "completed" | "dismissed" }) => Promise<boolean>;
  onConfirmVerification: (id: string, verdict: "resolved" | "partial" | "unresolved") => Promise<boolean>;
  researchEnabled: boolean;
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"current" | "history" | "policies" | "metrics">("current");
  const [policies, setPolicies] = useState<LearningPolicyRevisionDto[]>([]);
  const [variants, setVariants] = useState<LearningStrategyVariantDto[]>([]);
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
          conversationId: conversation?.id,
          topicKey: session.topicKey,
          datasetKind: session.datasetKind === "demo" ? "demo" : "live",
          includeDisabled: true
        })
      );
      setVariants(
        await api
          .learningVariants({ profileId, conversationId: conversation?.id, topicKey: session.topicKey })
          .catch(() => [])
      );
    } finally {
      setLoadingPolicies(false);
    }
  }, [session, profileId, conversation?.id]);

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
          // The panel follows its conversation's person, not the global switcher.
          ...(conversation?.participantId ? { participantId: conversation.participantId } : {}),
          datasetKind: session.datasetKind,
          ...(metricsScope === "topic" && session.topicKey ? { topicKey: session.topicKey } : {})
        })
      );
    } catch {
      setMetrics(undefined);
    } finally {
      setLoadingMetrics(false);
    }
  }, [session, profileId, metricsScope, conversation?.participantId]);

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
  async function reviewVariantAction(
    variant: LearningStrategyVariantDto,
    verdict: "trial" | "reject" | "enable" | "retire" | "keep"
  ) {
    setBusy(variant.id);
    try {
      await api.reviewLearningVariant(variant.id, verdict, conversation?.id);
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
        {incident.reviewOf && (
          <em className="learning-revisit-chip">{t("learningRevisitOf", { round: incident.reviewOf.round })}</em>
        )}
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
      {incident.verifications.some((item) => item.finalVerdict) && (
        <a
          className="learning-report-link"
          href={`/api/learning/incidents/${encodeURIComponent(incident.id)}/report.html`}
          target="_blank"
          rel="noreferrer"
        >
          {t("learningLoopReport")}
        </a>
      )}
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
          {session.condition === "multi-turn" && (
            <span className="learning-condition-badge">{t("learningConditionBadgeMultiTurn")}</span>
          )}
          {session.conditionAssignment && (
            <span
              className="learning-condition-badge"
              title={`seed ${session.conditionAssignment.seed} · #${session.conditionAssignment.index}`}
            >
              {t("learningConditionRandom")}
            </span>
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
            exportParticipantId={conversation?.participantId}
            metrics={metrics}
            loading={loadingMetrics}
            scope={metricsScope}
            topicKey={session.topicKey}
            onScope={setMetricsScope}
            researchEnabled={researchEnabled}
          />
        ) : loadingPolicies ? (
          <div className="support-loading">{t("loading")}</div>
        ) : policies.length || variants.length ? (
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
            {variants.length > 0 && (
              <div className="learning-variant-list">
                <h4>{t("learningVariants")}</h4>
                {variants.map((variant) => (
                  <article key={variant.id}>
                    <header>
                      <span className={`learning-state state-${variant.status}`}>{learningLabel(variant.status)}</span>
                      <small>
                        {learningLabel(variant.baseStrategy)} · {learningLabel(variant.difficultyType)}
                      </small>
                    </header>
                    <b>{variant.title}</b>
                    <p>{variant.instruction}</p>
                    <small>
                      {t("learningVariantEvidence", { count: variant.attributedCount })}
                      {variant.recommendationSummary ? ` · ${variant.recommendationSummary}` : ""}
                    </small>
                    {variant.status === "pending" && (
                      <footer>
                        <button
                          disabled={busy === variant.id}
                          onClick={() => void reviewVariantAction(variant, "trial")}
                        >
                          {t("learningVariantTryOut")}
                        </button>
                        <button
                          disabled={busy === variant.id}
                          className="danger"
                          onClick={() => void reviewVariantAction(variant, "reject")}
                        >
                          {t("learningReject")}
                        </button>
                      </footer>
                    )}
                    {variant.status === "trial" && (
                      <footer>
                        {variant.recommendation === "promote" && (
                          <button
                            disabled={busy === variant.id}
                            onClick={() => void reviewVariantAction(variant, "enable")}
                          >
                            {t("learningVariantPromote")}
                          </button>
                        )}
                        {variant.recommendation && (
                          <button
                            disabled={busy === variant.id}
                            onClick={() => void reviewVariantAction(variant, "keep")}
                          >
                            {t("learningVariantKeep")}
                          </button>
                        )}
                        <button
                          disabled={busy === variant.id}
                          className="danger"
                          onClick={() => void reviewVariantAction(variant, "retire")}
                        >
                          {t("learningVariantRetire")}
                        </button>
                      </footer>
                    )}
                    {variant.status === "enabled" && (
                      <footer>
                        <button
                          disabled={busy === variant.id}
                          className="danger"
                          onClick={() => void reviewVariantAction(variant, "retire")}
                        >
                          {t("learningVariantRetire")}
                        </button>
                      </footer>
                    )}
                  </article>
                ))}
              </div>
            )}
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
  conversation,
  onSessionUpdate,
  onConfirmVerification,
  researchEnabled
}: {
  kind?: SupportPanelKind;
  onClose: () => void;
  conversation?: ConversationDetail;
  onSessionUpdate?: (input: { status?: "active" | "paused" | "completed" | "dismissed" }) => Promise<boolean>;
  onConfirmVerification?: (id: string, verdict: "resolved" | "partial" | "unresolved") => Promise<boolean>;
  researchEnabled?: boolean;
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
                <h2 id="support-title">{t("learningMode")}</h2>
              </div>
              <button onClick={onClose} aria-label={t("closeSupport")}>
                <Icon name="close" />
              </button>
            </header>
            <div className="support-scroll">
              <LearningPanel
                conversation={conversation}
                onSessionUpdate={onSessionUpdate ?? (async () => false)}
                onConfirmVerification={onConfirmVerification ?? (async () => false)}
                researchEnabled={researchEnabled ?? false}
              />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
