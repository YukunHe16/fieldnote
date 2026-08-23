import type {
  ChatMessage,
  LearningIncidentDto,
  LearningInterventionDto,
  LearningInterventionStrategy,
  LearningOutcome,
  LearningSessionDto,
  LearningVerificationDto
} from "./types";

export interface SyntheticExperienceSummary {
  total: number;
  entries: Array<{
    strategy: LearningInterventionStrategy;
    outcome: Exclude<LearningOutcome, "unknown">;
    count: number;
  }>;
}

export function isSyntheticSeedIncident(incident: LearningIncidentDto): boolean {
  const snapshot = incident.closedSnapshot;
  return Boolean(snapshot && typeof snapshot === "object" && (snapshot as { synthetic?: unknown }).synthetic === true);
}

export function summarizeSyntheticSeedIncidents(incidents: LearningIncidentDto[]): SyntheticExperienceSummary {
  const entries = new Map<string, SyntheticExperienceSummary["entries"][number]>();
  for (const incident of incidents) {
    if (!isSyntheticSeedIncident(incident)) continue;
    const strategy = incident.interventions[0]?.strategy;
    const outcome = incident.verifications[0]?.finalVerdict;
    if (!strategy || !outcome || outcome === "unknown") continue;
    const key = `${strategy}:${outcome}`;
    const entry = entries.get(key);
    if (entry) entry.count += 1;
    else entries.set(key, { strategy, outcome, count: 1 });
  }
  return {
    total: [...entries.values()].reduce((total, entry) => total + entry.count, 0),
    entries: [...entries.values()]
  };
}

export function canConfirmLearningVerification(
  verification: LearningVerificationDto,
  interventions: LearningInterventionDto[],
  messages: ChatMessage[],
  activeRunId?: string
): boolean {
  const intervention = interventions.find((item) => item.id === verification.interventionId);
  const messageId = verification.proposedMessageId ?? intervention?.messageId;
  if (!messageId || !verification.systemVerdict || verification.userVerdict) return false;
  const message = messages.find((item) => item.id === messageId);
  return message?.status === "completed" && message.runId !== activeRunId;
}

export function pendingLearningVerification(
  session: LearningSessionDto | null | undefined,
  messages: ChatMessage[],
  activeRunId?: string
): LearningVerificationDto | null {
  if (!session || session.status !== "active" || activeRunId) return null;
  const incident = [...session.incidents].reverse().find((item) => item.status === "verifying");
  if (!incident) return null;
  const verification = [...incident.verifications].reverse().find((item) => !item.systemVerdict && !item.userVerdict);
  if (!verification) return null;
  const intervention = incident.interventions.find((item) => item.id === verification.interventionId);
  const messageId = verification.requestedMessageId ?? intervention?.messageId;
  if (!messageId) return null;
  const message = messages.find((item) => item.id === messageId);
  return message?.status === "completed" ? verification : null;
}
