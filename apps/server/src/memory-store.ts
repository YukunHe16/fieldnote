import { createHash, randomUUID } from "node:crypto";
import type {
  ConversationDetailDto,
  MemoryCategory,
  MemoryItemDto,
  MemoryMaintenanceStatusDto,
  MemoryReferenceDto,
  MemoryScope,
  MemorySettingsDto,
  MemorySourceDto,
  MemorySourceKind
} from "@fieldnote/contracts";
import type { SqliteDatabase } from "./database.js";
import { isAgentProfileId, LEGACY_PROFILE_ID } from "./agent-profiles.js";

type MemoryRow = {
  id: string;
  category: MemoryCategory;
  title: string;
  content: string;
  keywords_json: string;
  source_kind: MemorySourceKind;
  scope: MemoryScope;
  profile_id: string | null;
  importance: number;
  pinned: number;
  status: "active" | "superseded";
  fingerprint: string;
  last_maintained_at: number | null;
  created_at: number;
  updated_at: number;
};

type SourceRow = {
  id: string;
  memory_id: string;
  conversation_id: string | null;
  message_id: string | null;
  run_id: string | null;
  had_conversation: number;
  conversation_title: string;
  excerpt: string;
  created_at: number;
};

export const MEMORY_TASK_THRESHOLD = 50;
export const MEMORY_MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60_000;

export interface MemorySourceInput {
  conversationId?: string;
  messageId?: string;
  runId?: string;
  conversationTitle?: string;
  excerpt?: string;
}

export interface CreateMemoryInput {
  category: MemoryCategory;
  title: string;
  content: string;
  keywords?: string[];
  sourceKind: MemorySourceKind;
  scope?: MemoryScope;
  profileId?: string | null;
  importance?: number;
  pinned?: boolean;
  source?: MemorySourceInput;
}

export interface UpdateMemoryInput {
  category?: MemoryCategory;
  title?: string;
  content?: string;
  keywords?: string[];
  sourceKind?: MemorySourceKind;
  scope?: MemoryScope;
  profileId?: string | null;
  importance?: number;
  pinned?: boolean;
  status?: "active" | "superseded";
}

export interface MemoryMutationResult {
  memory: MemoryItemDto | null;
  mutationId: string;
  undoExpiresAt: string;
}

export interface MemoryExtractionJob {
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  attempts: number;
  lastError: string | null;
}

export interface MemoryScopeTarget {
  scope: MemoryScope;
  profileId: string | null;
}

const defaultSettings: MemorySettingsDto = {
  enabled: true,
  autoSave: true,
  referenceHistory: true
};

const toIso = (value: number): string => new Date(value).toISOString();

export class MemoryStore {
  constructor(private readonly database: SqliteDatabase) {}

  getSettings(): MemorySettingsDto {
    const row = this.database.prepare("SELECT value_json FROM local_settings WHERE key = 'memory.config'").get() as
      | { value_json: string }
      | undefined;
    if (!row) return { ...defaultSettings };
    try {
      const value = JSON.parse(row.value_json) as Partial<MemorySettingsDto>;
      return {
        enabled: value.enabled ?? defaultSettings.enabled,
        autoSave: value.autoSave ?? defaultSettings.autoSave,
        referenceHistory: value.referenceHistory ?? defaultSettings.referenceHistory
      };
    } catch {
      return { ...defaultSettings };
    }
  }

  getMaintenanceStatus(now = Date.now()): MemoryMaintenanceStatusDto {
    this.ensureMaintenanceState(now);
    const row = this.database
      .prepare("SELECT status, last_run_at, last_completed_at, last_error FROM memory_maintenance_state WHERE id = 1")
      .get() as {
      status: MemoryMaintenanceStatusDto["status"];
      last_run_at: number;
      last_completed_at: number | null;
      last_error: string | null;
    };
    const newTaskCount = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_items
         WHERE category = 'task' AND source_kind = 'auto'
           AND (created_at > ? OR (created_at = ? AND COALESCE(last_maintained_at, 0) < ?))`
        )
        .get(row.last_run_at, row.last_run_at, row.last_run_at) as { count: number }
    ).count;
    const nextScheduledAt = row.last_run_at + MEMORY_MAINTENANCE_INTERVAL_MS;
    return {
      status: row.status,
      lastRunAt: toIso(row.last_run_at),
      lastCompletedAt: row.last_completed_at ? toIso(row.last_completed_at) : null,
      nextScheduledAt: toIso(nextScheduledAt),
      newTaskCount,
      taskThreshold: MEMORY_TASK_THRESHOLD,
      intervalDays: 7,
      due: newTaskCount >= MEMORY_TASK_THRESHOLD || now >= nextScheduledAt,
      lastError: row.last_error
    };
  }

  recoverMaintenance(now = Date.now()): void {
    this.ensureMaintenanceState(now);
    this.database
      .prepare(
        "UPDATE memory_maintenance_state SET status = 'idle', updated_at = ? WHERE id = 1 AND status = 'running'"
      )
      .run(now);
  }

  markMaintenanceRunning(now = Date.now()): MemoryMaintenanceStatusDto {
    this.ensureMaintenanceState(now);
    this.database
      .prepare(
        `UPDATE memory_maintenance_state
         SET status = 'running', last_attempt_at = ?, last_error = NULL, updated_at = ? WHERE id = 1`
      )
      .run(now, now);
    return this.getMaintenanceStatus(now);
  }

  markMaintenanceCompleted(watermark = Date.now(), completedAt = Date.now()): MemoryMaintenanceStatusDto {
    this.ensureMaintenanceState(completedAt);
    this.database
      .prepare(
        `UPDATE memory_maintenance_state
         SET status = 'idle', last_run_at = ?, last_completed_at = ?, last_attempt_at = ?,
             last_error = NULL, updated_at = ? WHERE id = 1`
      )
      .run(watermark, completedAt, watermark, completedAt);
    return this.getMaintenanceStatus(completedAt);
  }

  markMaintenanceFailed(error: string, now = Date.now()): MemoryMaintenanceStatusDto {
    this.ensureMaintenanceState(now);
    this.database
      .prepare(
        `UPDATE memory_maintenance_state
         SET status = 'failed', last_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = 1`
      )
      .run(now, error.slice(0, 1_000), now);
    return this.getMaintenanceStatus(now);
  }

  maintenanceCandidates(
    limit = 50,
    watermark = Date.now(),
    includeBeforeCutoff = false,
    target?: MemoryScopeTarget
  ): MemoryItemDto[] {
    this.ensureMaintenanceState(watermark);
    const bounded = Math.min(200, Math.max(1, limit));
    const editableLimit = Math.max(1, Math.floor(bounded * 0.75));
    const protectedLimit = bounded - editableLimit;
    const cutoffCondition = includeBeforeCutoff
      ? ""
      : "AND created_at >= (SELECT eligibility_cutoff_at FROM memory_maintenance_state WHERE id = 1)";
    const selectedTarget = target
      ? { scope: target.scope, profile_id: target.profileId }
      : (this.database
          .prepare(
            `SELECT scope, profile_id FROM memory_items
             WHERE source_kind = 'auto' AND status = 'active' AND pinned = 0
               ${cutoffCondition}
               AND created_at <= ? AND COALESCE(last_maintained_at, 0) < ?
             GROUP BY scope, profile_id
             ORDER BY MIN(updated_at) ASC, scope ASC, profile_id ASC LIMIT 1`
          )
          .get(watermark, watermark) as { scope: MemoryScope; profile_id: string | null } | undefined);
    if (!selectedTarget) return [];
    const scopeTarget: MemoryScopeTarget = {
      scope: selectedTarget.scope,
      profileId: selectedTarget.scope === "profile" ? selectedTarget.profile_id : null
    };
    if (scopeTarget.scope === "profile" && !scopeTarget.profileId) return [];
    const editable = this.database
      .prepare(
        `SELECT * FROM memory_items
         WHERE source_kind = 'auto' AND status = 'active' AND pinned = 0
           AND ${this.scopeTargetSql(scopeTarget)}
           ${cutoffCondition}
           AND created_at <= ? AND COALESCE(last_maintained_at, 0) < ?
         ORDER BY updated_at ASC LIMIT ?`
      )
      .all(...this.scopeTargetValues(scopeTarget), watermark, watermark, editableLimit) as MemoryRow[];
    const protectedRows =
      protectedLimit > 0
        ? (this.database
            .prepare(
              `SELECT * FROM memory_items
             WHERE status = 'active' AND (source_kind != 'auto' OR pinned = 1)
               AND (${this.scopeTargetSql(scopeTarget)}${scopeTarget.scope === "profile" ? " OR scope = 'global'" : ""})
             ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`
            )
            .all(...this.scopeTargetValues(scopeTarget), protectedLimit) as MemoryRow[])
        : [];
    return [...editable, ...protectedRows].map((row) => this.toMemory(row));
  }

  markMemoriesMaintained(memoryIds: string[], watermark: number, target?: MemoryScopeTarget): void {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.database
      .prepare(
        `UPDATE memory_items SET last_maintained_at = ?
         WHERE id IN (${placeholders}) AND source_kind = 'auto' AND pinned = 0
           ${target ? `AND ${this.scopeTargetSql(target)}` : ""}`
      )
      .run(watermark, ...ids, ...(target ? this.scopeTargetValues(target) : []));
  }

  updateAutomaticMemory(
    memoryId: string,
    input: Pick<UpdateMemoryInput, "title" | "content" | "keywords" | "importance">,
    target?: MemoryScopeTarget
  ): MemoryItemDto | null {
    const row = this.database
      .prepare(
        `SELECT id FROM memory_items
         WHERE id = ? AND source_kind = 'auto' AND pinned = 0 AND status = 'active'
           ${target ? `AND ${this.scopeTargetSql(target)}` : ""}`
      )
      .get(memoryId, ...(target ? this.scopeTargetValues(target) : [])) as { id: string } | undefined;
    return row ? this.update(memoryId, input) : null;
  }

  supersedeAutomaticMemories(memoryIds: string[], target?: MemoryScopeTarget): number {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    return this.database
      .prepare(
        `UPDATE memory_items SET status = 'superseded', updated_at = ?
         WHERE id IN (${placeholders}) AND source_kind = 'auto' AND pinned = 0 AND status = 'active'
           ${target ? `AND ${this.scopeTargetSql(target)}` : ""}`
      )
      .run(Date.now(), ...ids, ...(target ? this.scopeTargetValues(target) : [])).changes;
  }

  mergeTaskMemories(input: {
    sourceMemoryIds: string[];
    category: "task" | "project";
    title: string;
    content: string;
    keywords: string[];
    importance: number;
    target?: MemoryScopeTarget;
  }): MemoryItemDto | null {
    const sourceIds = [...new Set(input.sourceMemoryIds)];
    if (sourceIds.length < 2) return null;
    const placeholders = sourceIds.map(() => "?").join(",");
    const eligible = this.database
      .prepare(
        `SELECT id, scope, profile_id FROM memory_items
         WHERE id IN (${placeholders}) AND category = 'task' AND source_kind = 'auto'
           AND status = 'active' AND pinned = 0
           ${input.target ? `AND ${this.scopeTargetSql(input.target)}` : ""}`
      )
      .all(...sourceIds, ...(input.target ? this.scopeTargetValues(input.target) : [])) as Array<{
      id: string;
      scope: MemoryScope;
      profile_id: string | null;
    }>;
    if (eligible.length < 2) return null;
    const scope = eligible[0]!.scope;
    const profileId = eligible[0]!.profile_id;
    if (eligible.some((item) => item.scope !== scope || item.profile_id !== profileId)) return null;
    const normalized = normalizeInput({
      category: input.category,
      title: input.title,
      content: input.content,
      keywords: input.keywords,
      sourceKind: "auto",
      importance: input.importance
    });
    const fingerprint = memoryFingerprint(normalized.category, normalized.title, normalized.content);
    const exact = this.database
      .prepare(
        `SELECT * FROM memory_items WHERE category = ? AND fingerprint = ? AND scope = ?
           AND COALESCE(profile_id, '') = COALESCE(?, '') AND status = 'active' LIMIT 1`
      )
      .get(normalized.category, fingerprint, scope, profileId) as MemoryRow | undefined;
    if (exact && (exact.source_kind !== "auto" || exact.pinned === 1)) {
      this.supersedeAutomaticMemories(
        eligible.map((item) => item.id),
        input.target
      );
      return this.toMemory(exact);
    }
    const merged = exact
      ? this.toMemory(exact)
      : this.create({
          category: normalized.category,
          title: normalized.title,
          content: normalized.content,
          keywords: normalized.keywords,
          sourceKind: "auto",
          importance: normalized.importance,
          scope,
          profileId
        });
    const supersededIds = eligible.map((item) => item.id).filter((id) => id !== merged.id);
    const timestamp = Date.now();
    this.database.transaction(() => {
      const sources =
        supersededIds.length > 0
          ? (this.database
              .prepare(`SELECT * FROM memory_sources WHERE memory_id IN (${supersededIds.map(() => "?").join(",")})`)
              .all(...supersededIds) as SourceRow[])
          : [];
      const insert = this.database.prepare(
        `INSERT INTO memory_sources
           (id, memory_id, conversation_id, message_id, run_id, had_conversation,
            conversation_title, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const source of sources) {
        insert.run(
          randomUUID(),
          merged.id,
          source.conversation_id,
          source.message_id,
          source.run_id,
          source.had_conversation,
          source.conversation_title,
          source.excerpt,
          source.created_at
        );
      }
      if (supersededIds.length > 0) {
        this.database
          .prepare(
            `UPDATE memory_items SET status = 'superseded', updated_at = ?
             WHERE id IN (${supersededIds.map(() => "?").join(",")})`
          )
          .run(timestamp, ...supersededIds);
      }
    })();
    return this.get(merged.id);
  }

  updateSettings(input: Partial<MemorySettingsDto>): MemorySettingsDto {
    const next = { ...this.getSettings(), ...input };
    this.database
      .prepare(
        `INSERT INTO local_settings (key, value_json, updated_at) VALUES ('memory.config', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(next), Date.now());
    return next;
  }

  list(
    input: {
      category?: MemoryCategory;
      query?: string;
      includeSuperseded?: boolean;
      profileId?: string;
      includeGlobal?: boolean;
    } = {}
  ): MemoryItemDto[] {
    const conditions = [input.includeSuperseded ? "1 = 1" : "mi.status = 'active'"];
    const values: unknown[] = [];
    if (input.category) {
      conditions.push("mi.category = ?");
      values.push(input.category);
    }
    if (input.profileId) {
      conditions.push(
        input.includeGlobal === false
          ? "mi.scope = 'profile' AND mi.profile_id = ?"
          : "(mi.scope = 'global' OR (mi.scope = 'profile' AND mi.profile_id = ?))"
      );
      values.push(input.profileId);
    }
    const query = input.query?.trim() ?? "";
    let join = "";
    if (query) {
      if ([...query].length >= 3) {
        join = "JOIN memories_fts mf ON mf.memory_id = mi.id";
        conditions.push("memories_fts MATCH ?");
        values.push(quoteFts(query));
      } else {
        conditions.push("(mi.title LIKE ? OR mi.content LIKE ? OR mi.keywords_json LIKE ?)");
        const like = `%${query}%`;
        values.push(like, like, like);
      }
    }
    const rows = this.database
      .prepare(
        `SELECT DISTINCT mi.* FROM memory_items mi ${join}
         WHERE ${conditions.join(" AND ")}
         ORDER BY mi.pinned DESC, mi.importance DESC, mi.updated_at DESC
         LIMIT 500`
      )
      .all(...values) as MemoryRow[];
    return rows.map((row) => this.toMemory(row));
  }

  countAutoTasksSince(profileId: string, since: number): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_items
       WHERE category = 'task' AND source_kind = 'auto' AND status = 'active'
         AND scope = 'profile' AND profile_id = ? AND created_at > ?`
      )
      .get(profileId, since) as { count: number };
    return row.count;
  }

  recentAutoTasks(profileId: string, limit = 30): MemoryItemDto[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_items
       WHERE category = 'task' AND source_kind = 'auto' AND status = 'active'
         AND scope = 'profile' AND profile_id = ?
       ORDER BY created_at DESC LIMIT ?`
      )
      .all(profileId, Math.min(80, Math.max(1, limit))) as MemoryRow[];
    return rows.map((row) => this.toMemory(row));
  }

  listAutoTaskProfileIds(): string[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT profile_id FROM memory_items
       WHERE category = 'task' AND source_kind = 'auto' AND profile_id IS NOT NULL`
      )
      .all() as Array<{ profile_id: string }>;
    return rows.map((row) => row.profile_id);
  }

  search(input: { query: string; categories?: MemoryCategory[]; limit?: number; profileId?: string }): MemoryItemDto[] {
    const query = input.query.trim();
    if (!query) return [];
    const categories = input.categories ?? ["profile", "preference", "goal", "project", "task"];
    if (categories.length === 0) return [];
    const limit = Math.min(20, Math.max(1, input.limit ?? 6));
    const placeholders = categories.map(() => "?").join(",");
    const match = buildFtsMatch(query);
    const scopeSql = input.profileId ? "AND (scope = 'global' OR (scope = 'profile' AND profile_id = ?))" : "";
    const scopeValues = input.profileId ? [input.profileId] : [];
    if (!match) {
      const like = `%${query}%`;
      const rows = this.database
        .prepare(
          `SELECT * FROM memory_items
           WHERE status = 'active' AND category IN (${placeholders})
             ${scopeSql}
             AND (title LIKE ? OR content LIKE ? OR keywords_json LIKE ?)
           ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ?`
        )
        .all(...categories, ...scopeValues, like, like, like, limit) as MemoryRow[];
      return rows.map((row) => this.toMemory(row));
    }
    const rows = this.database
      .prepare(
        `SELECT mi.* FROM memories_fts
         JOIN memory_items mi ON mi.id = memories_fts.memory_id
         WHERE memories_fts MATCH ? AND mi.status = 'active' AND mi.category IN (${placeholders})
           ${input.profileId ? "AND (mi.scope = 'global' OR (mi.scope = 'profile' AND mi.profile_id = ?))" : ""}
         ORDER BY mi.pinned DESC, bm25(memories_fts), mi.importance DESC, mi.updated_at DESC
         LIMIT ?`
      )
      .all(match, ...categories, ...scopeValues, limit) as MemoryRow[];
    return rows.map((row) => this.toMemory(row));
  }

  stableContext(profileId?: string, limitCharacters = 3_000): MemoryItemDto[] {
    const items = (profileId ? this.list({ profileId }) : this.list().filter((item) => item.scope === "global")).filter(
      (item) => item.category !== "task"
    );
    const selected: MemoryItemDto[] = [];
    let size = 0;
    for (const item of items) {
      const nextSize = item.title.length + item.content.length + 8;
      if (selected.length > 0 && size + nextSize > limitCharacters) break;
      selected.push(item);
      size += nextSize;
      if (selected.length >= 20) break;
    }
    return selected;
  }

  recordReferences(runId: string, items: MemoryItemDto[]): MemoryReferenceDto[] {
    const unique = [...new Map(items.map((item) => [item.id, item])).values()];
    const timestamp = Date.now();
    const insert = this.database.prepare(
      `INSERT INTO run_memory_refs (run_id, memory_id, rank, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, memory_id) DO UPDATE SET rank = MIN(rank, excluded.rank)`
    );
    this.database.transaction(() => unique.forEach((item, index) => insert.run(runId, item.id, index, timestamp)))();
    return unique.map(toReference);
  }

  referencesForRun(runId: string): MemoryReferenceDto[] {
    const rows = this.database
      .prepare(
        `SELECT mi.* FROM run_memory_refs r
         JOIN memory_items mi ON mi.id = r.memory_id
         WHERE r.run_id = ? ORDER BY r.rank ASC`
      )
      .all(runId) as MemoryRow[];
    return rows.map((row) => toReference(this.toMemory(row)));
  }

  decorateConversation(conversation: ConversationDetailDto): ConversationDetailDto {
    return {
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        memoryReferences: message.role === "assistant" && message.runId ? this.referencesForRun(message.runId) : []
      }))
    };
  }

  enqueueExtraction(runId: string): void {
    const timestamp = Date.now();
    this.database
      .prepare(
        `INSERT INTO memory_extraction_jobs (run_id, status, attempts, created_at, updated_at)
         VALUES (?, 'queued', 0, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`
      )
      .run(runId, timestamp, timestamp);
  }

  recoverExtractions(): void {
    this.database
      .prepare("UPDATE memory_extraction_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(Date.now());
  }

  nextExtraction(): MemoryExtractionJob | null {
    const row = this.database
      .prepare(
        `SELECT run_id, status, attempts, last_error FROM memory_extraction_jobs
         WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
      )
      .get() as
      | { run_id: string; status: MemoryExtractionJob["status"]; attempts: number; last_error: string | null }
      | undefined;
    return row ? { runId: row.run_id, status: row.status, attempts: row.attempts, lastError: row.last_error } : null;
  }

  getExtraction(runId: string): MemoryExtractionJob | null {
    const row = this.database
      .prepare("SELECT run_id, status, attempts, last_error FROM memory_extraction_jobs WHERE run_id = ?")
      .get(runId) as
      | { run_id: string; status: MemoryExtractionJob["status"]; attempts: number; last_error: string | null }
      | undefined;
    return row ? { runId: row.run_id, status: row.status, attempts: row.attempts, lastError: row.last_error } : null;
  }

  markExtraction(runId: string, status: MemoryExtractionJob["status"], error?: string): MemoryExtractionJob | null {
    const increment = status === "running" ? 1 : 0;
    this.database
      .prepare(
        `UPDATE memory_extraction_jobs SET status = ?, attempts = attempts + ?, last_error = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(status, increment, error?.slice(0, 1_000) ?? null, Date.now(), runId);
    const row = this.database
      .prepare("SELECT run_id, status, attempts, last_error FROM memory_extraction_jobs WHERE run_id = ?")
      .get(runId) as
      | { run_id: string; status: MemoryExtractionJob["status"]; attempts: number; last_error: string | null }
      | undefined;
    return row ? { runId: row.run_id, status: row.status, attempts: row.attempts, lastError: row.last_error } : null;
  }

  get(memoryId: string): MemoryItemDto | null {
    const row = this.database.prepare("SELECT * FROM memory_items WHERE id = ?").get(memoryId) as MemoryRow | undefined;
    return row ? this.toMemory(row) : null;
  }

  findRelated(
    category: MemoryCategory,
    title: string,
    keywords: string[] = [],
    scope: MemoryScope = "global",
    profileId: string | null = null
  ): MemoryItemDto | null {
    const candidates =
      scope === "profile" && profileId
        ? this.list({ category, profileId, includeGlobal: false })
        : this.list({ category }).filter((item) => item.scope === "global");
    const normalizedTitle = normalizeMemoryIdentity(title);
    const exactTitle = candidates.find((item) => normalizeMemoryIdentity(item.title) === normalizedTitle);
    if (exactTitle) return exactTitle;
    const normalizedKeywords = new Set(keywords.map(normalizeMemoryIdentity).filter(Boolean));
    if (normalizedKeywords.size === 0) return null;
    return (
      candidates.find((item) => {
        const overlaps = item.keywords
          .map(normalizeMemoryIdentity)
          .filter((keyword) => normalizedKeywords.has(keyword));
        if (overlaps.length >= 2) return true;
        return (
          overlaps.length === 1 &&
          normalizedKeywords.size === 1 &&
          normalizedTitle.includes(overlaps[0]!) &&
          normalizeMemoryIdentity(item.title).includes(overlaps[0]!)
        );
      }) ?? null
    );
  }

  create(input: CreateMemoryInput): MemoryItemDto {
    const normalized = normalizeInput(input);
    const { scope, profileId } = resolveMemoryScope(normalized.category, input.scope, input.profileId);
    if (containsSensitiveContent(`${normalized.title}\n${normalized.content}\n${normalized.keywords.join(" ")}`)) {
      throw new Error("Sensitive information cannot be saved to memory");
    }
    const fingerprint = memoryFingerprint(normalized.category, normalized.title, normalized.content);
    const existing = this.database
      .prepare(
        `SELECT id FROM memory_items WHERE category = ? AND fingerprint = ? AND scope = ?
           AND COALESCE(profile_id, '') = COALESCE(?, '') AND status = 'active' LIMIT 1`
      )
      .get(normalized.category, fingerprint, scope, profileId) as { id: string } | undefined;
    if (existing) {
      if (input.source) this.addSource(existing.id, input.source);
      return this.get(existing.id)!;
    }
    const id = randomUUID();
    const timestamp = Date.now();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO memory_items
             (id, category, title, content, keywords_json, source_kind, importance, pinned,
              scope, profile_id, status, fingerprint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        )
        .run(
          id,
          normalized.category,
          normalized.title,
          normalized.content,
          JSON.stringify(normalized.keywords),
          normalized.sourceKind,
          normalized.importance,
          normalized.pinned ? 1 : 0,
          scope,
          profileId,
          fingerprint,
          timestamp,
          timestamp
        );
      if (input.source) this.insertSource(id, input.source, timestamp);
    })();
    return this.get(id)!;
  }

  update(memoryId: string, input: UpdateMemoryInput): MemoryItemDto | null {
    const current = this.get(memoryId);
    if (!current) return null;
    const next = normalizeInput({
      category: input.category ?? current.category,
      title: input.title ?? current.title,
      content: input.content ?? current.content,
      keywords: input.keywords ?? current.keywords,
      sourceKind: input.sourceKind ?? current.sourceKind,
      importance: input.importance ?? current.importance,
      pinned: input.pinned ?? current.pinned
    });
    const { scope, profileId } = resolveMemoryScope(
      next.category,
      input.scope,
      input.profileId === undefined ? current.profileId : input.profileId
    );
    if (containsSensitiveContent(`${next.title}\n${next.content}\n${next.keywords.join(" ")}`)) {
      throw new Error("Sensitive information cannot be saved to memory");
    }
    const status = input.status ?? current.status;
    this.database
      .prepare(
        `UPDATE memory_items SET category = ?, title = ?, content = ?, keywords_json = ?,
         source_kind = ?, scope = ?, profile_id = ?, importance = ?, pinned = ?, status = ?, fingerprint = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        next.category,
        next.title,
        next.content,
        JSON.stringify(next.keywords),
        next.sourceKind,
        scope,
        profileId,
        next.importance,
        next.pinned ? 1 : 0,
        status,
        memoryFingerprint(next.category, next.title, next.content),
        Date.now(),
        memoryId
      );
    return this.get(memoryId);
  }

  delete(memoryId: string): boolean {
    return this.database.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId).changes > 0;
  }

  createExplicit(input: Omit<CreateMemoryInput, "sourceKind">): MemoryMutationResult {
    const normalized = normalizeInput({ ...input, sourceKind: "explicit" });
    const { scope, profileId } = resolveMemoryScope(normalized.category, input.scope, input.profileId);
    const related = this.findRelated(normalized.category, normalized.title, normalized.keywords, scope, profileId);
    if (related) {
      if (
        related.content === normalized.content &&
        normalizeMemoryIdentity(related.title) === normalizeMemoryIdentity(normalized.title)
      ) {
        if (related.sourceKind === "auto") {
          const promoted = this.update(related.id, { sourceKind: "explicit", pinned: related.pinned });
          if (!promoted) throw new Error("Memory could not be promoted");
          if (input.source) this.addSource(promoted.id, input.source);
          return this.recordMutation("update", promoted.id, related, this.get(promoted.id));
        }
        if (input.source) this.addSource(related.id, input.source);
        return { memory: this.get(related.id), mutationId: "", undoExpiresAt: new Date(0).toISOString() };
      }
      const before = related;
      const updated = this.update(related.id, {
        title: normalized.title,
        content: normalized.content,
        keywords: normalized.keywords,
        sourceKind: "explicit",
        importance: normalized.importance,
        pinned: related.pinned
      });
      if (!updated) throw new Error("Memory could not be updated");
      if (input.source) this.addSource(updated.id, input.source);
      return this.recordMutation("update", updated.id, before, this.get(updated.id));
    }
    const created = this.create({ ...input, sourceKind: "explicit" });
    return this.recordMutation("create", created.id, null, created);
  }

  deleteExplicit(memoryId: string): MemoryMutationResult | null {
    const memory = this.get(memoryId);
    if (!memory) return null;
    this.delete(memoryId);
    return this.recordMutation("delete", memoryId, memory, null);
  }

  undoMutation(mutationId: string): MemoryItemDto | null {
    const row = this.database.prepare("SELECT * FROM memory_mutations WHERE id = ?").get(mutationId) as
      | {
          id: string;
          memory_id: string;
          operation: "create" | "update" | "delete";
          before_json: string | null;
          after_json: string | null;
          undo_expires_at: number;
          undone_at: number | null;
        }
      | undefined;
    if (!row) throw new Error("Mutation not found");
    if (row.undone_at) throw new Error("Mutation was already undone");
    if (row.undo_expires_at < Date.now()) throw new Error("Undo period has expired");
    const before = parseMemorySnapshot(row.before_json);
    const after = parseMemorySnapshot(row.after_json);
    let result: MemoryItemDto | null = null;
    this.database.transaction(() => {
      if (row.operation === "create") {
        const current = this.get(row.memory_id);
        if (!current || current.updatedAt !== after?.updatedAt) throw new Error("Memory changed after this action");
        this.delete(row.memory_id);
      } else if (row.operation === "delete") {
        if (!before || this.get(row.memory_id)) throw new Error("Memory cannot be restored");
        result = this.restoreSnapshot(before);
      } else {
        const current = this.get(row.memory_id);
        if (!before || !after || !current || current.updatedAt !== after.updatedAt) {
          throw new Error("Memory changed after this action");
        }
        this.delete(row.memory_id);
        result = this.restoreSnapshot(before);
      }
      this.database.prepare("UPDATE memory_mutations SET undone_at = ? WHERE id = ?").run(Date.now(), mutationId);
    })();
    return result;
  }

  clear(): number {
    let deleted = 0;
    this.database.transaction(() => {
      deleted = this.database.prepare("DELETE FROM memory_items").run().changes;
      this.database.prepare("DELETE FROM memory_mutations").run();
    })();
    return deleted;
  }

  addSource(memoryId: string, source: MemorySourceInput): MemorySourceDto {
    if (!this.get(memoryId)) throw new Error("Memory not found");
    const timestamp = Date.now();
    const id = this.insertSource(memoryId, source, timestamp);
    return this.toSource(this.database.prepare("SELECT * FROM memory_sources WHERE id = ?").get(id) as SourceRow);
  }

  private insertSource(memoryId: string, source: MemorySourceInput, timestamp: number): string {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO memory_sources
           (id, memory_id, conversation_id, message_id, run_id, had_conversation,
            conversation_title, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        memoryId,
        source.conversationId ?? null,
        source.messageId ?? null,
        source.runId ?? null,
        source.conversationId ? 1 : 0,
        cleanText(source.conversationTitle ?? "", 120),
        cleanText(source.excerpt ?? "", 280),
        timestamp
      );
    return id;
  }

  private toMemory(row: MemoryRow): MemoryItemDto {
    const sources = this.database
      .prepare("SELECT * FROM memory_sources WHERE memory_id = ? ORDER BY created_at DESC")
      .all(row.id) as SourceRow[];
    return {
      id: row.id,
      category: row.category,
      title: row.title,
      content: row.content,
      keywords: parseKeywords(row.keywords_json),
      sourceKind: row.source_kind,
      scope: row.scope,
      profileId: row.profile_id,
      importance: row.importance,
      pinned: row.pinned === 1,
      status: row.status,
      sources: sources.map((source) => this.toSource(source)),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at)
    };
  }

  private toSource(row: SourceRow): MemorySourceDto {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      runId: row.run_id,
      conversationTitle: row.conversation_title,
      excerpt: row.excerpt,
      sourceDeleted: row.had_conversation === 1 && row.conversation_id === null,
      createdAt: toIso(row.created_at)
    };
  }

  private recordMutation(
    operation: "create" | "update" | "delete",
    memoryId: string,
    before: MemoryItemDto | null,
    after: MemoryItemDto | null
  ): MemoryMutationResult {
    const mutationId = randomUUID();
    const timestamp = Date.now();
    const undoExpiresAt = timestamp + 10 * 60_000;
    this.database
      .prepare(
        `INSERT INTO memory_mutations
           (id, memory_id, operation, before_json, after_json, undo_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mutationId,
        memoryId,
        operation,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        undoExpiresAt,
        timestamp
      );
    return { memory: after, mutationId, undoExpiresAt: toIso(undoExpiresAt) };
  }

  private restoreSnapshot(snapshot: MemoryItemDto): MemoryItemDto {
    const createdAt = new Date(snapshot.createdAt).getTime();
    const updatedAt = new Date(snapshot.updatedAt).getTime();
    const { scope, profileId } = resolveMemoryScope(snapshot.category, snapshot.scope, snapshot.profileId);
    this.database
      .prepare(
        `INSERT INTO memory_items
           (id, category, title, content, keywords_json, source_kind, importance, pinned,
            scope, profile_id, status, fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.category,
        snapshot.title,
        snapshot.content,
        JSON.stringify(snapshot.keywords),
        snapshot.sourceKind,
        snapshot.importance,
        snapshot.pinned ? 1 : 0,
        scope,
        profileId,
        snapshot.status,
        memoryFingerprint(snapshot.category, snapshot.title, snapshot.content),
        createdAt,
        updatedAt
      );
    for (const source of snapshot.sources) {
      const conversationExists = source.conversationId
        ? Boolean(this.database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(source.conversationId))
        : false;
      const messageExists = source.messageId
        ? Boolean(this.database.prepare("SELECT 1 FROM messages WHERE id = ?").get(source.messageId))
        : false;
      const runExists = source.runId
        ? Boolean(this.database.prepare("SELECT 1 FROM runs WHERE id = ?").get(source.runId))
        : false;
      this.database
        .prepare(
          `INSERT INTO memory_sources
             (id, memory_id, conversation_id, message_id, run_id, had_conversation,
              conversation_title, excerpt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          source.id,
          snapshot.id,
          conversationExists ? source.conversationId : null,
          messageExists ? source.messageId : null,
          runExists ? source.runId : null,
          source.sourceDeleted || source.conversationId ? 1 : 0,
          source.conversationTitle,
          source.excerpt,
          new Date(source.createdAt).getTime()
        );
    }
    return this.get(snapshot.id)!;
  }

  private ensureMaintenanceState(now: number): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO memory_maintenance_state
           (id, status, last_run_at, eligibility_cutoff_at, updated_at)
         VALUES (1, 'idle', ?, ?, ?)`
      )
      .run(now, now, now);
    this.database
      .prepare(
        `UPDATE memory_maintenance_state
         SET eligibility_cutoff_at = CASE
           WHEN eligibility_cutoff_at IS NULL OR eligibility_cutoff_at > last_run_at THEN last_run_at
           ELSE eligibility_cutoff_at
         END
         WHERE id = 1`
      )
      .run();
  }

  private scopeTargetSql(target: MemoryScopeTarget): string {
    return target.scope === "profile"
      ? "scope = 'profile' AND profile_id = ?"
      : "scope = 'global' AND profile_id IS NULL";
  }

  private scopeTargetValues(target: MemoryScopeTarget): unknown[] {
    return target.scope === "profile" ? [target.profileId] : [];
  }
}

type NormalizedMemoryInput = {
  category: MemoryCategory;
  title: string;
  content: string;
  keywords: string[];
  sourceKind: MemorySourceKind;
  importance: number;
  pinned: boolean;
};

function resolveMemoryScope(
  category: MemoryCategory,
  requestedScope: MemoryScope | undefined,
  requestedProfileId: string | null | undefined
): MemoryScopeTarget {
  const expectedScope: MemoryScope = category === "profile" || category === "preference" ? "global" : "profile";
  if (requestedScope && requestedScope !== expectedScope) {
    throw new Error(`${category} memories must use ${expectedScope} scope`);
  }
  if (expectedScope === "global") return { scope: "global", profileId: null };
  const profileId = requestedProfileId?.trim() || LEGACY_PROFILE_ID;
  if (!isAgentProfileId(profileId)) throw new Error(`Unknown agent profile: ${profileId}`);
  return { scope: "profile", profileId };
}

function normalizeInput(input: Omit<CreateMemoryInput, "source">): NormalizedMemoryInput {
  const title = cleanText(input.title, 120);
  const content = cleanText(input.content, 2_000);
  if (!title || !content) throw new Error("Memory title and content are required");
  return {
    category: input.category,
    title,
    content,
    keywords: [...new Set((input.keywords ?? []).map((item) => cleanText(item, 40)).filter(Boolean))].slice(0, 20),
    sourceKind: input.sourceKind,
    importance: Math.min(5, Math.max(1, Math.round(input.importance ?? 3))),
    pinned: input.pinned ?? false
  };
}

function cleanText(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function memoryFingerprint(category: MemoryCategory, title: string, content: string): string {
  return createHash("sha256")
    .update(`${category}\n${title.toLocaleLowerCase()}\n${content.toLocaleLowerCase()}`)
    .digest("hex");
}

function parseKeywords(value: string): string[] {
  try {
    const result = JSON.parse(value) as unknown;
    return Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function quoteFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildFtsMatch(value: string): string | null {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      if ([...word].length < 3) continue;
      const characters = [...word];
      if (characters.length <= 8) terms.add(characters.join(""));
      else
        for (let index = 0; index <= characters.length - 3 && terms.size < 16; index += 2) {
          terms.add(characters.slice(index, index + 3).join(""));
        }
    } else if ([...word].length >= 3) {
      terms.add(word);
    }
  }
  return terms.size > 0 ? [...terms].map(quoteFts).join(" OR ") : null;
}

function toReference(item: MemoryItemDto): MemoryReferenceDto {
  return {
    memoryId: item.id,
    category: item.category,
    title: item.title,
    content: item.content,
    source: item.sources[0] ?? null
  };
}

function parseMemorySnapshot(value: string | null): MemoryItemDto | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as MemoryItemDto;
  } catch {
    return null;
  }
}

function normalizeMemoryIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function containsSensitiveContent(value: string): boolean {
  return /(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+|健康|病历|银行卡|身份证|住址)/i.test(
    value
  );
}
