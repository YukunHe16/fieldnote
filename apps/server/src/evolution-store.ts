import { randomUUID } from "node:crypto";
import type {
  ConversationDetailDto,
  EvolvedArtifactDto,
  EvolvedArtifactKind,
  EvolvedArtifactStatus,
  EvolutionPolarity,
  EvolutionReviewVerdict,
  EvolutionSignalDto,
  EvolutionSignalKind,
  EvolutionSignalSource,
  MemoryItemDto,
  OverlaySnapshotDto,
  PlaybookDto,
  PlaybookOrigin,
  PlaybookPolarity
} from "@fieldnote/contracts";
import { isAgentProfileId, LEGACY_PROFILE_ID } from "./agent-profiles.js";
import type { SqliteDatabase } from "./database.js";
import { DEFAULT_PARTICIPANT_ID } from "./store.js";
import { scoreOverlayText, skillLabelsFromBlocks } from "./overlay-context.js";

const toIso = (value: number): string => new Date(value).toISOString();

type SignalRow = {
  id: string;
  source: EvolutionSignalSource;
  kind: EvolutionSignalKind;
  polarity: EvolutionPolarity;
  reason: string | null;
  profile_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  run_id: string | null;
  overlay_revision: string | null;
  created_at: number;
};

type PlaybookRow = {
  id: string;
  title: string;
  instruction: string;
  polarity: PlaybookPolarity;
  origin: PlaybookOrigin;
  scope: "global" | "profile";
  profile_id: string | null;
  enabled: number;
  expires_at: number | null;
  revision: number;
  source_run_id: string | null;
  source_signal_id: string | null;
  created_at: number;
  updated_at: number;
};

type ArtifactRow = {
  id: string;
  profile_id: string;
  kind: EvolvedArtifactKind;
  slug: string;
  name: string;
  description: string;
  body: string;
  status: EvolvedArtifactStatus;
  origin: "user" | "distilled";
  revision: number;
  evaluation_json: string | null;
  created_at: number;
  updated_at: number;
};

export interface CreateSignalInput {
  source: EvolutionSignalSource;
  kind: EvolutionSignalKind;
  polarity: EvolutionPolarity;
  reason?: string | null;
  profileId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  overlayRevision?: string | null;
}

export interface CreatePlaybookInput {
  title: string;
  instruction: string;
  polarity: PlaybookPolarity;
  origin: PlaybookOrigin;
  scope: "global" | "profile";
  profileId?: string | null;
  enabled?: boolean;
  expiresAt?: number | null;
  sourceRunId?: string | null;
  sourceSignalId?: string | null;
}

export interface CreateArtifactInput {
  profileId: string;
  kind: EvolvedArtifactKind;
  slug: string;
  name: string;
  description: string;
  body: string;
  origin: "user" | "distilled";
  status?: EvolvedArtifactStatus;
}

function clean(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function stripCommands(value: string): string {
  return value
    .replace(/ignore (all|any|previous|above) instructions?/gi, "")
    .replace(/you are now /gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function preparePlaybookInstruction(value: string): string {
  return stripCommands(clean(value, 200));
}

export const EVOLUTION_REVIEW_TASK_THRESHOLD = 15;
export const EVOLUTION_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** Marker prefixes for usage-based review rows; queries and UI detection key off them. */
export const DISABLE_SUGGESTION_PREFIX = "建议停用：";
export const KEEP_REVIEW_REASON = "已确认保留该能力";

export interface EvolutionReviewStatus {
  profileId: string;
  status: "idle" | "running" | "failed";
  lastRunAt: number;
  lastCompletedAt: number | null;
  newTaskCount: number;
  due: boolean;
  lastError: string | null;
}

export class EvolutionStore {
  constructor(private readonly database: SqliteDatabase) {}

  recoverReviews(now = Date.now()): void {
    this.database
      .prepare("UPDATE evolution_review_state SET status = 'idle', updated_at = ? WHERE status = 'running'")
      .run(now);
  }

  createSignal(input: CreateSignalInput): EvolutionSignalDto {
    const id = randomUUID();
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO evolution_signals
         (id, source, kind, polarity, reason, profile_id, conversation_id, message_id, run_id, overlay_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.source,
        input.kind,
        input.polarity,
        input.reason?.trim() || null,
        input.profileId ?? null,
        input.conversationId ?? null,
        input.messageId ?? null,
        input.runId ?? null,
        input.overlayRevision ?? null,
        now
      );
    return this.requireSignal(id);
  }

  latestThumb(messageId: string): EvolutionSignalDto | null {
    const row = this.database
      .prepare(
        `SELECT * FROM evolution_signals WHERE message_id = ? AND kind = 'thumb' ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(messageId) as SignalRow | undefined;
    return row ? this.toSignal(row) : null;
  }

  thumbsForMessages(messageIds: string[]): Map<string, EvolutionPolarity> {
    const ratings = new Map<string, EvolutionPolarity>();
    if (messageIds.length === 0) return ratings;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT message_id, polarity FROM evolution_signals
       WHERE kind = 'thumb' AND message_id IN (${placeholders})
       ORDER BY created_at ASC, rowid ASC`
      )
      .all(...messageIds) as Array<{ message_id: string; polarity: EvolutionPolarity }>;
    for (const row of rows) ratings.set(row.message_id, row.polarity);
    return ratings;
  }

  listSignals(input: { profileId?: string; kind?: EvolutionSignalKind; limit?: number } = {}): EvolutionSignalDto[] {
    const conditions = ["1 = 1"];
    const values: unknown[] = [];
    if (input.profileId) {
      conditions.push("(profile_id = ? OR profile_id IS NULL)");
      values.push(input.profileId);
    }
    if (input.kind) {
      conditions.push("kind = ?");
      values.push(input.kind);
    }
    const rows = this.database
      .prepare(`SELECT * FROM evolution_signals WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, Math.min(200, input.limit ?? 50)) as SignalRow[];
    return rows.map((row) => this.toSignal(row));
  }

  hasRetryOrEditForRun(runId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS ok FROM evolution_signals
       WHERE run_id = ? AND kind IN ('retry', 'edit')
       LIMIT 1`
      )
      .get(runId) as { ok: number } | undefined;
    return Boolean(row);
  }

  countSimilarMethodAccepts(profileId: string, method: string): number {
    const rows = this.database
      .prepare(
        `SELECT reason FROM evolution_signals
       WHERE profile_id = ? AND kind = 'method' AND polarity = 'up'
       ORDER BY created_at DESC LIMIT 80`
      )
      .all(profileId) as Array<{ reason: string | null }>;
    return rows.filter((row) => methodsSimilar(row.reason ?? "", method)).length;
  }

  countThumbs(input: { profileId: string; polarity: EvolutionPolarity; since?: number }): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM evolution_signals
       WHERE kind = 'thumb' AND polarity = ? AND profile_id = ? AND created_at >= ?`
      )
      .get(input.polarity, input.profileId, input.since ?? 0) as { count: number };
    return row.count;
  }

  createPlaybook(input: CreatePlaybookInput): PlaybookDto {
    const title = clean(input.title, 80);
    const instruction = preparePlaybookInstruction(input.instruction);
    if (!title || !instruction) throw new Error("Playbook title and instruction are required");
    const scope = input.scope;
    const profileId = scope === "profile" ? input.profileId?.trim() || LEGACY_PROFILE_ID : null;
    if (scope === "profile" && !isAgentProfileId(profileId ?? "")) throw new Error("Unknown agent profile");
    const id = randomUUID();
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO playbooks
         (id, title, instruction, polarity, origin, scope, profile_id, enabled, expires_at, revision, source_run_id, source_signal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        id,
        title,
        instruction,
        input.polarity,
        input.origin,
        scope,
        profileId,
        input.enabled === false ? 0 : 1,
        input.expiresAt ?? null,
        input.sourceRunId ?? null,
        input.sourceSignalId ?? null,
        now,
        now
      );
    return this.requirePlaybook(id);
  }

  getPlaybook(id: string): PlaybookDto | null {
    const row = this.database.prepare("SELECT * FROM playbooks WHERE id = ?").get(id) as PlaybookRow | undefined;
    return row ? this.toPlaybook(row) : null;
  }

  listPlaybooks(profileId?: string, includeDisabled = false): PlaybookDto[] {
    const now = Date.now();
    const rows = this.database
      .prepare(
        `SELECT * FROM playbooks
       WHERE (? = 1 OR enabled = 1)
         AND (expires_at IS NULL OR expires_at > ?)
         AND (scope = 'global' OR (scope = 'profile' AND profile_id = ?))
       ORDER BY CASE origin WHEN 'user' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
                CASE polarity WHEN 'dont' THEN 0 ELSE 1 END,
                updated_at DESC`
      )
      .all(includeDisabled ? 1 : 0, now, profileId ?? LEGACY_PROFILE_ID) as PlaybookRow[];
    return rows.map((row) => this.toPlaybook(row));
  }

  activePlaybooks(profileId: string, limit = 12): PlaybookDto[] {
    return this.listPlaybooks(profileId).slice(0, limit);
  }

  replacePlaybooks(profileId: string | null, items: Array<Omit<CreatePlaybookInput, "profileId">>): PlaybookDto[] {
    const targetProfile = profileId && isAgentProfileId(profileId) ? profileId : null;
    this.database.transaction(() => {
      if (targetProfile) {
        this.database.prepare("DELETE FROM playbooks WHERE scope = 'profile' AND profile_id = ?").run(targetProfile);
      } else {
        this.database.prepare("DELETE FROM playbooks WHERE scope = 'global'").run();
      }
      for (const item of items) {
        this.createPlaybook({
          ...item,
          scope: targetProfile ? "profile" : "global",
          profileId: targetProfile
        });
      }
    })();
    return this.listPlaybooks(targetProfile ?? undefined, true).filter((item) =>
      targetProfile ? item.profileId === targetProfile : item.scope === "global"
    );
  }

  updatePlaybook(
    id: string,
    input: Partial<Pick<PlaybookDto, "title" | "instruction" | "enabled" | "origin">>
  ): PlaybookDto | null {
    const current = this.getPlaybook(id);
    if (!current) return null;
    const title = input.title !== undefined ? clean(input.title, 80) : current.title;
    const instruction =
      input.instruction !== undefined ? preparePlaybookInstruction(input.instruction) : current.instruction;
    if (!title || !instruction) return current;
    this.database
      .prepare(
        `UPDATE playbooks SET title = ?, instruction = ?, enabled = ?, origin = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
      )
      .run(
        title,
        instruction,
        (input.enabled ?? current.enabled) ? 1 : 0,
        input.origin ?? current.origin,
        Date.now(),
        id
      );
    return this.requirePlaybook(id);
  }

  deletePlaybook(id: string): boolean {
    return this.database.prepare("DELETE FROM playbooks WHERE id = ?").run(id).changes > 0;
  }

  confirmedCount(profileId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM playbooks
       WHERE enabled = 1 AND origin IN ('user', 'confirmed')
         AND (scope = 'global' OR (scope = 'profile' AND profile_id = ?))`
      )
      .get(profileId) as { count: number };
    return row.count;
  }

  createOverlayRevision(input: {
    runId?: string;
    profileId: string;
    playbooks: PlaybookDto[];
    artifactIds: string[];
    memories?: Array<Pick<MemoryItemDto, "id" | "category" | "title" | "content">>;
    card?: { title: string; lines: string[] } | null;
  }): OverlaySnapshotDto {
    const id = randomUUID();
    const card = input.card ? { title: input.card.title, lines: input.card.lines } : null;
    const playbooks = input.playbooks.map((item) => ({
      id: item.id,
      title: item.title,
      polarity: item.polarity,
      instruction: item.instruction
    }));
    const memories = (input.memories ?? []).map((item) => ({
      id: item.id,
      category: item.category,
      title: item.title,
      content: item.content
    }));
    const artifacts = input.artifactIds
      .map((artifactId) => this.getArtifact(artifactId))
      .filter((artifact): artifact is EvolvedArtifactDto => Boolean(artifact));
    const snapshot = {
      playbookIds: playbooks.map((item) => item.id),
      playbooks,
      artifactIds: artifacts.map((item) => item.id),
      artifacts,
      memories,
      cardTitle: card?.title ?? null,
      card
    };
    this.database
      .prepare(
        `INSERT INTO overlay_revisions (id, run_id, profile_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.runId ?? null, input.profileId, JSON.stringify(snapshot), Date.now());
    return {
      id,
      ...snapshot
    };
  }

  overlayForRun(runId: string): OverlaySnapshotDto | null {
    const row = this.database
      .prepare(`SELECT id, snapshot_json FROM overlay_revisions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(runId) as { id: string; snapshot_json: string } | undefined;
    if (!row) return null;
    const snapshot = JSON.parse(row.snapshot_json) as OverlaySnapshotDto & {
      playbooks?: OverlaySnapshotDto["playbooks"];
      card?: OverlaySnapshotDto["card"];
    };
    const playbooks = snapshot.playbooks ?? [];
    return {
      id: row.id,
      playbookIds: snapshot.playbookIds ?? playbooks.map((item) => item.id),
      artifactIds: snapshot.artifactIds ?? [],
      cardTitle: snapshot.cardTitle ?? snapshot.card?.title ?? null,
      playbooks,
      card: snapshot.card ?? null,
      ...(Array.isArray(snapshot.memories) ? { memories: snapshot.memories } : {}),
      ...(Array.isArray(snapshot.artifacts) ? { artifacts: snapshot.artifacts } : {})
    };
  }

  decorateConversation(conversation: ConversationDetailDto): ConversationDetailDto {
    const ratings = this.thumbsForMessages(conversation.messages.map((message) => message.id));
    const overlays = new Map<string, OverlaySnapshotDto | null>();
    const overlayFor = (runId: string | null) => {
      if (!runId) return null;
      if (!overlays.has(runId)) overlays.set(runId, this.overlayForRun(runId));
      return overlays.get(runId) ?? null;
    };
    return {
      ...conversation,
      messages: conversation.messages.map((message) => {
        const overlay = overlayFor(message.runId);
        return {
          ...message,
          rating: ratings.get(message.id) ?? null,
          playbookReferences: overlay?.playbooks ?? [],
          skillReferences: skillLabelsFromBlocks(message.blocks ?? [])
        };
      })
    };
  }

  nextAvailableSlug(profileId: string, kind: EvolvedArtifactKind, base: string): string {
    const taken = new Set(
      this.listArtifacts(profileId)
        .filter((item) => item.kind === kind && (item.status === "enabled" || item.status === "pending"))
        .map((item) => item.slug)
    );
    if (!taken.has(base)) return base;
    for (let index = 2; index < 80; index += 1) {
      const candidate = `${base}-${index}`.slice(0, 41);
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`.replace(/[^a-z0-9-]/g, "").slice(0, 41);
  }

  createArtifact(input: CreateArtifactInput): EvolvedArtifactDto {
    const existing = this.database
      .prepare("SELECT * FROM evolved_artifacts WHERE profile_id = ? AND kind = ? AND slug = ?")
      .get(input.profileId, input.kind, input.slug) as ArtifactRow | undefined;
    const now = Date.now();
    if (existing) {
      this.database
        .prepare(
          `UPDATE evolved_artifacts
         SET name = ?, description = ?, body = ?, status = ?, origin = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`
        )
        .run(input.name, input.description, input.body, input.status ?? "pending", input.origin, now, existing.id);
      return this.requireArtifact(existing.id);
    }
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO evolved_artifacts
         (id, profile_id, kind, slug, name, description, body, status, origin, revision, evaluation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`
      )
      .run(
        id,
        input.profileId,
        input.kind,
        input.slug,
        input.name,
        input.description,
        input.body,
        input.status ?? "pending",
        input.origin,
        now,
        now
      );
    return this.requireArtifact(id);
  }

  getArtifact(id: string): EvolvedArtifactDto | null {
    const row = this.database.prepare("SELECT * FROM evolved_artifacts WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
    return row ? this.toArtifact(row) : null;
  }

  listArtifacts(profileId: string, status?: EvolvedArtifactStatus): EvolvedArtifactDto[] {
    const rows = status
      ? (this.database
          .prepare("SELECT * FROM evolved_artifacts WHERE profile_id = ? AND status = ? ORDER BY updated_at DESC")
          .all(profileId, status) as ArtifactRow[])
      : (this.database
          .prepare("SELECT * FROM evolved_artifacts WHERE profile_id = ? ORDER BY updated_at DESC")
          .all(profileId) as ArtifactRow[]);
    return rows.map((row) => this.toArtifact(row));
  }

  enabledArtifacts(profileId: string): EvolvedArtifactDto[] {
    return this.listArtifacts(profileId, "enabled");
  }

  listPlaybookProfileIds(): string[] {
    const rows = this.database
      .prepare("SELECT DISTINCT profile_id FROM playbooks WHERE profile_id IS NOT NULL")
      .all() as Array<{ profile_id: string }>;
    return rows.map((row) => row.profile_id);
  }

  getReviewStatus(profileId: string, newTaskCount: number, now = Date.now()): EvolutionReviewStatus {
    const row = this.ensureReviewState(profileId, now);
    const nextScheduledAt = row.last_run_at + EVOLUTION_REVIEW_INTERVAL_MS;
    return {
      profileId,
      status: row.status,
      lastRunAt: row.last_run_at,
      lastCompletedAt: row.last_completed_at,
      newTaskCount,
      due: row.status !== "running" && (newTaskCount >= EVOLUTION_REVIEW_TASK_THRESHOLD || now >= nextScheduledAt),
      lastError: row.last_error
    };
  }

  markReviewRunning(profileId: string, now = Date.now()): EvolutionReviewStatus {
    this.ensureReviewState(profileId, now);
    this.database
      .prepare(
        "UPDATE evolution_review_state SET status = 'running', last_error = NULL, updated_at = ? WHERE profile_id = ?"
      )
      .run(now, profileId);
    return this.requireReviewStatus(profileId, now);
  }

  markReviewCompleted(profileId: string, watermark = Date.now(), now = Date.now()): EvolutionReviewStatus {
    this.ensureReviewState(profileId, now);
    this.database
      .prepare(
        `UPDATE evolution_review_state
       SET status = 'idle', last_run_at = ?, last_completed_at = ?, last_error = NULL, updated_at = ?
       WHERE profile_id = ?`
      )
      .run(watermark, now, now, profileId);
    return this.requireReviewStatus(profileId, now);
  }

  markReviewFailed(profileId: string, error: string, now = Date.now()): EvolutionReviewStatus {
    this.ensureReviewState(profileId, now);
    this.database
      .prepare(
        "UPDATE evolution_review_state SET status = 'failed', last_error = ?, updated_at = ? WHERE profile_id = ?"
      )
      .run(error.slice(0, 1_000), now, profileId);
    return this.requireReviewStatus(profileId, now);
  }

  pendingArtifacts(profileId?: string): EvolvedArtifactDto[] {
    const rows = profileId
      ? (this.database
          .prepare(
            "SELECT * FROM evolved_artifacts WHERE status = 'pending' AND profile_id = ? ORDER BY updated_at DESC"
          )
          .all(profileId) as ArtifactRow[])
      : (this.database
          .prepare("SELECT * FROM evolved_artifacts WHERE status = 'pending' ORDER BY updated_at DESC")
          .all() as ArtifactRow[]);
    return rows.map((row) => this.toArtifact(row));
  }

  /**
   * Usage since the artifact's last status change, over overlay revisions of runs that are
   * evolution-eligible (conversations with non-live learning sessions and replay
   * conversations are excluded via SQL, mirroring isEvolutionEligibleConversation).
   */
  artifactUsageStats(profileId: string): Record<string, { uses: number; retriedRuns: number }> {
    const artifacts = this.listArtifacts(profileId);
    if (artifacts.length === 0) return {};
    const enabledSince = new Map<string, number>();
    for (const artifact of artifacts) enabledSince.set(artifact.id, Date.parse(artifact.updatedAt) || 0);
    const hasTable = (name: string): boolean =>
      Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const exclusions = [
      hasTable("learning_sessions")
        ? "AND r.conversation_id NOT IN (SELECT conversation_id FROM learning_sessions WHERE dataset_kind != 'live')"
        : "",
      hasTable("replay_marks") ? "AND r.conversation_id NOT IN (SELECT conversation_id FROM replay_marks)" : "",
      `AND r.conversation_id NOT IN (SELECT id FROM conversations WHERE participant_id != '${DEFAULT_PARTICIPANT_ID}')`
    ].join("\n         ");
    const rows = this.database
      .prepare(
        `SELECT o.id, o.run_id, o.snapshot_json, o.created_at
       FROM overlay_revisions o
       JOIN runs r ON r.id = o.run_id
       WHERE o.profile_id = ?
         ${exclusions}
       ORDER BY o.created_at DESC LIMIT 500`
      )
      .all(profileId) as Array<{ id: string; run_id: string | null; snapshot_json: string; created_at: number }>;
    // Retry/edit signals carry the REJECTED run's overlay revision in overlay_revision while
    // their run_id names the corrective replacement run. Blame must land on the rejected
    // revision; matching by run_id would credit the failing run as a clean use and mark the
    // fix as the failure (and blame artifacts enabled only after the failing run).
    const retriedRevisionIds = new Set(
      (
        this.database
          .prepare(
            "SELECT DISTINCT overlay_revision FROM evolution_signals WHERE kind IN ('retry', 'edit') AND overlay_revision IS NOT NULL"
          )
          .all() as Array<{ overlay_revision: string }>
      ).map((row) => row.overlay_revision)
    );
    // Legacy edit signals (written before overlay_revision was recorded) can only match by
    // their replacement run id — kept as a fallback so old feedback is not dropped entirely.
    const legacyRetriedRunIds = new Set(
      (
        this.database
          .prepare(
            "SELECT DISTINCT run_id FROM evolution_signals WHERE kind IN ('retry', 'edit') AND overlay_revision IS NULL AND run_id IS NOT NULL"
          )
          .all() as Array<{ run_id: string }>
      ).map((row) => row.run_id)
    );
    const stats: Record<string, { uses: number; retriedRuns: number }> = {};
    for (const row of rows) {
      let artifactIds: string[] = [];
      try {
        const snapshot = JSON.parse(row.snapshot_json) as { artifactIds?: unknown };
        if (Array.isArray(snapshot.artifactIds))
          artifactIds = snapshot.artifactIds.filter((value): value is string => typeof value === "string");
      } catch {
        continue;
      }
      for (const artifactId of artifactIds) {
        const since = enabledSince.get(artifactId);
        if (since === undefined || row.created_at < since) continue;
        let entry = stats[artifactId];
        if (!entry) {
          entry = { uses: 0, retriedRuns: 0 };
          stats[artifactId] = entry;
        }
        entry.uses += 1;
        if (retriedRevisionIds.has(row.id) || (row.run_id && legacyRetriedRunIds.has(row.run_id)))
          entry.retriedRuns += 1;
      }
    }
    return stats;
  }

  /**
   * Disable suggestions live only in the append-only review audit — writing them through
   * setArtifactStatus would bump updated_at and reset the usage window above.
   */
  recordDisableSuggestion(artifactId: string, reason: string): void {
    this.database
      .prepare(
        "INSERT INTO evolution_reviews (id, artifact_id, verdict, reason, notified, created_at) VALUES (?, ?, 'needs_human', ?, 0, ?)"
      )
      .run(randomUUID(), artifactId, reason, Date.now());
  }

  recordKeepReview(artifactId: string): void {
    this.database
      .prepare(
        `INSERT INTO evolution_reviews (id, artifact_id, verdict, reason, notified, created_at) VALUES (?, ?, 'pass', '${KEEP_REVIEW_REASON}', 0, ?)`
      )
      .run(randomUUID(), artifactId, Date.now());
  }

  /** The still-open disable suggestion for an artifact: the newest review row, if it is one. */
  openDisableSuggestion(artifactId: string): string | null {
    const row = this.database
      .prepare(
        "SELECT reason FROM evolution_reviews WHERE artifact_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get(artifactId) as { reason: string | null } | undefined;
    return row?.reason?.startsWith(DISABLE_SUGGESTION_PREFIX) ? row.reason : null;
  }

  /** True when a suggestion was raised or dismissed recently — suppresses re-paging. */
  hasRecentUsageReview(artifactId: string, since: number): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 FROM evolution_reviews
       WHERE artifact_id = ? AND created_at >= ?
         AND (reason LIKE '${DISABLE_SUGGESTION_PREFIX}%' OR reason = '${KEEP_REVIEW_REASON}')
       LIMIT 1`
      )
      .get(artifactId, since);
    return Boolean(row);
  }

  setArtifactStatus(
    id: string,
    status: EvolvedArtifactStatus,
    evaluation?: { verdict: EvolutionReviewVerdict; reason: string; replayRunId?: string | null }
  ): EvolvedArtifactDto | null {
    const current = this.getArtifact(id);
    if (!current) return null;
    this.database
      .prepare(`UPDATE evolved_artifacts SET status = ?, evaluation_json = ?, updated_at = ? WHERE id = ?`)
      .run(
        status,
        evaluation ? JSON.stringify(evaluation) : current.evaluation ? JSON.stringify(current.evaluation) : null,
        Date.now(),
        id
      );
    if (evaluation) {
      this.database
        .prepare(
          `INSERT INTO evolution_reviews (id, artifact_id, verdict, reason, notified, created_at) VALUES (?, ?, ?, ?, 0, ?)`
        )
        .run(randomUUID(), id, evaluation.verdict, evaluation.reason, Date.now());
    }
    return this.requireArtifact(id);
  }

  private ensureReviewState(
    profileId: string,
    now: number
  ): {
    status: EvolutionReviewStatus["status"];
    last_run_at: number;
    last_completed_at: number | null;
    last_error: string | null;
  } {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO evolution_review_state
         (profile_id, status, last_run_at, last_completed_at, last_error, updated_at)
       VALUES (?, 'idle', ?, NULL, NULL, ?)`
      )
      .run(profileId, now, now);
    return this.database
      .prepare(
        "SELECT status, last_run_at, last_completed_at, last_error FROM evolution_review_state WHERE profile_id = ?"
      )
      .get(profileId) as {
      status: EvolutionReviewStatus["status"];
      last_run_at: number;
      last_completed_at: number | null;
      last_error: string | null;
    };
  }

  private requireReviewStatus(profileId: string, now: number): EvolutionReviewStatus {
    const row = this.ensureReviewState(profileId, now);
    return {
      profileId,
      status: row.status,
      lastRunAt: row.last_run_at,
      lastCompletedAt: row.last_completed_at,
      newTaskCount: 0,
      due: false,
      lastError: row.last_error
    };
  }

  private requireSignal(id: string): EvolutionSignalDto {
    const row = this.database.prepare("SELECT * FROM evolution_signals WHERE id = ?").get(id) as SignalRow;
    return this.toSignal(row);
  }

  private requirePlaybook(id: string): PlaybookDto {
    return this.toPlaybook(this.database.prepare("SELECT * FROM playbooks WHERE id = ?").get(id) as PlaybookRow);
  }

  private requireArtifact(id: string): EvolvedArtifactDto {
    return this.toArtifact(
      this.database.prepare("SELECT * FROM evolved_artifacts WHERE id = ?").get(id) as ArtifactRow
    );
  }

  private toSignal(row: SignalRow): EvolutionSignalDto {
    return {
      id: row.id,
      source: row.source,
      kind: row.kind,
      polarity: row.polarity,
      reason: row.reason,
      profileId: row.profile_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      runId: row.run_id,
      overlayRevision: row.overlay_revision,
      createdAt: toIso(row.created_at)
    };
  }

  private toPlaybook(row: PlaybookRow): PlaybookDto {
    return {
      id: row.id,
      title: row.title,
      instruction: row.instruction,
      polarity: row.polarity,
      origin: row.origin,
      scope: row.scope,
      profileId: row.profile_id,
      enabled: row.enabled === 1,
      expiresAt: row.expires_at ? toIso(row.expires_at) : null,
      revision: row.revision,
      sourceRunId: row.source_run_id,
      sourceSignalId: row.source_signal_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at)
    };
  }

  private toArtifact(row: ArtifactRow): EvolvedArtifactDto {
    let evaluation: EvolvedArtifactDto["evaluation"] = null;
    if (row.evaluation_json) {
      try {
        evaluation = JSON.parse(row.evaluation_json) as EvolvedArtifactDto["evaluation"];
      } catch {
        evaluation = null;
      }
    }
    return {
      id: row.id,
      profileId: row.profile_id,
      kind: row.kind,
      slug: row.slug,
      name: row.name,
      description: row.description,
      body: row.body,
      status: row.status,
      origin: row.origin,
      revision: row.revision,
      evaluation,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at)
    };
  }
}

export function methodsSimilar(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) return false;
  return scoreOverlayText(left, right) >= 4;
}
