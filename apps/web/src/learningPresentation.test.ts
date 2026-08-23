import { describe, expect, it } from "vitest";
import {
  canConfirmLearningVerification,
  isSyntheticSeedIncident,
  pendingLearningVerification,
  summarizeSyntheticSeedIncidents
} from "./learningPresentation";
import type {
  ChatMessage,
  LearningIncidentDto,
  LearningInterventionDto,
  LearningSessionDto,
  LearningVerificationDto
} from "./types";

const intervention = { id: "i1", messageId: "assistant-1" } as LearningInterventionDto;
const verification = {
  id: "v1",
  interventionId: "i1",
  proposedMessageId: "assistant-2",
  systemVerdict: "partial",
  userVerdict: null
} as LearningVerificationDto;

describe("learning outcome presentation", () => {
  it("waits for the proposing assistant message and its run to finish", () => {
    const streaming = [{ id: "assistant-2", role: "assistant", status: "streaming", runId: "run-2" }] as ChatMessage[];
    const completed = [{ ...streaming[0]!, status: "completed" }] as ChatMessage[];
    expect(canConfirmLearningVerification(verification, [intervention], streaming, "run-2")).toBe(false);
    expect(canConfirmLearningVerification(verification, [intervention], completed, "run-2")).toBe(false);
    expect(canConfirmLearningVerification(verification, [intervention], completed, undefined)).toBe(true);
  });

  it("falls back to the intervention message for legacy records", () => {
    const legacy = { ...verification, proposedMessageId: null };
    const messages = [{ id: "assistant-1", role: "assistant", status: "completed", runId: "run-1" }] as ChatMessage[];
    expect(canConfirmLearningVerification(legacy, [intervention], messages)).toBe(true);
  });

  it("offers a learning answer box only after the verification message is complete", () => {
    const requested = {
      ...verification,
      systemVerdict: null,
      proposedMessageId: null,
      requestedMessageId: "assistant-1"
    } as LearningVerificationDto;
    const incident = {
      status: "verifying",
      interventions: [intervention],
      verifications: [requested]
    } as LearningIncidentDto;
    const session = { status: "active", incidents: [incident] } as LearningSessionDto;
    const streaming = [{ id: "assistant-1", role: "assistant", status: "streaming", runId: "run-1" }] as ChatMessage[];
    const completed = [{ ...streaming[0]!, status: "completed" }] as ChatMessage[];

    expect(pendingLearningVerification(session, streaming)).toBeNull();
    expect(pendingLearningVerification(session, completed, "run-2")).toBeNull();
    expect(pendingLearningVerification({ ...session, status: "paused" }, completed)).toBeNull();
    expect(pendingLearningVerification(session, completed)).toBe(requested);
    expect(
      pendingLearningVerification(
        { ...session, incidents: [{ ...incident, verifications: [{ ...requested, systemVerdict: "partial" }] }] },
        completed
      )
    ).toBeNull();
  });

  it("summarizes synthetic seed incidents separately from learner history", () => {
    const seed = (strategy: "contrastive_example" | "direct_explanation", outcome: "resolved" | "unresolved") =>
      ({
        closedSnapshot: { synthetic: true },
        interventions: [{ strategy }],
        verifications: [{ finalVerdict: outcome }]
      }) as LearningIncidentDto;
    const learnerIncident = {
      closedSnapshot: { synthetic: false },
      interventions: [],
      verifications: []
    } as unknown as LearningIncidentDto;
    const seeds = [
      seed("contrastive_example", "resolved"),
      seed("contrastive_example", "resolved"),
      seed("direct_explanation", "unresolved")
    ];

    expect(isSyntheticSeedIncident(seeds[0]!)).toBe(true);
    expect(isSyntheticSeedIncident(learnerIncident)).toBe(false);
    expect(summarizeSyntheticSeedIncidents([...seeds, learnerIncident])).toEqual({
      total: 3,
      entries: [
        { strategy: "contrastive_example", outcome: "resolved", count: 2 },
        { strategy: "direct_explanation", outcome: "unresolved", count: 1 }
      ]
    });
  });
});
