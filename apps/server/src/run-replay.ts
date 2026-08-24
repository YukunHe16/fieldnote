import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  EvolvedArtifactDto,
  FrozenLearningSessionDto,
  InputFileManifestItemDto,
  MemoryCategory,
  OverlaySnapshotDto
} from "@fieldnote/contracts";
import type { SqliteDatabase } from "./database.js";

export const REPLAY_MARK_FILE = ".replay.json";

export type FrozenOverlay = OverlaySnapshotDto;

export type ReplayMark = {
  sourceRunId: string;
  mode: "frozen" | "with-artifact";
  includeArtifactId?: string | null;
  prompt: string;
  overlay: FrozenOverlay;
};

export type RunSnapshot = {
  id: string;
  runId: string;
  conversationId: string;
  profileId: string;
  prompt: string;
  overlay: FrozenOverlay;
  workspaceDir: string;
  createdAt: number;
};

function emptyOverlay(): FrozenOverlay {
  return {
    id: "",
    playbookIds: [],
    artifactIds: [],
    cardTitle: null,
    playbooks: [],
    card: null,
    memories: [],
    artifacts: [],
    inputFiles: [],
    learning: null
  };
}

function asOverlay(value: unknown): FrozenOverlay {
  if (!value || typeof value !== "object") return emptyOverlay();
  const raw = value as Record<string, unknown>;
  const playbooks = Array.isArray(raw.playbooks)
    ? raw.playbooks.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const playbook = item as Record<string, unknown>;
        const id = String(playbook.id ?? "").trim();
        if (!id) return [];
        return [
          {
            id,
            title: String(playbook.title ?? ""),
            polarity: playbook.polarity === "dont" ? ("dont" as const) : ("do" as const),
            ...(typeof playbook.instruction === "string" ? { instruction: playbook.instruction } : {})
          }
        ];
      })
    : [];
  const card =
    raw.card && typeof raw.card === "object"
      ? {
          title: String((raw.card as { title?: unknown }).title ?? ""),
          lines: Array.isArray((raw.card as { lines?: unknown }).lines)
            ? (raw.card as { lines: unknown[] }).lines.map((line) => String(line))
            : []
        }
      : null;
  const memoryCategories = new Set<MemoryCategory>(["profile", "preference", "goal", "project", "task"]);
  const memories = Array.isArray(raw.memories)
    ? raw.memories.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const memory = item as Record<string, unknown>;
        const category = String(memory.category ?? "") as MemoryCategory;
        if (!memoryCategories.has(category)) return [];
        return [
          {
            id: String(memory.id ?? ""),
            category,
            title: String(memory.title ?? ""),
            content: String(memory.content ?? "")
          }
        ];
      })
    : undefined;
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const artifact = item as Record<string, unknown>;
        if (
          typeof artifact.id !== "string" ||
          typeof artifact.body !== "string" ||
          (artifact.kind !== "skill" && artifact.kind !== "subagent")
        )
          return [];
        return [{ ...(artifact as unknown as EvolvedArtifactDto) }];
      })
    : undefined;
  const inputFiles = Array.isArray(raw.inputFiles)
    ? raw.inputFiles.filter((item): item is InputFileManifestItemDto => {
        if (!item || typeof item !== "object") return false;
        const file = item as Record<string, unknown>;
        return (
          typeof file.attachmentId === "string" &&
          typeof file.conversationId === "string" &&
          typeof file.sourceMessageId === "string" &&
          typeof file.originalFileName === "string" &&
          typeof file.relativePath === "string" &&
          typeof file.mimeType === "string" &&
          typeof file.size === "number" &&
          typeof file.sha256 === "string"
        );
      })
    : undefined;
  const learning =
    raw.learning && typeof raw.learning === "object"
      ? { ...(raw.learning as FrozenLearningSessionDto) }
      : raw.learning === null
        ? null
        : undefined;
  return {
    id: String(raw.id ?? ""),
    playbookIds: Array.isArray(raw.playbookIds)
      ? raw.playbookIds.map((id) => String(id))
      : playbooks.map((item) => item.id),
    artifactIds: Array.isArray(raw.artifactIds) ? raw.artifactIds.map((id) => String(id)) : [],
    cardTitle: raw.cardTitle == null ? (card?.title ?? null) : String(raw.cardTitle),
    playbooks,
    card,
    ...(memories ? { memories } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(inputFiles ? { inputFiles } : {}),
    ...(learning !== undefined ? { learning } : {})
  };
}

function copyWorkspace(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => path.basename(source) !== REPLAY_MARK_FILE
  });
}

export class RunReplayStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly snapshotRoot: string
  ) {}

  freeze(input: {
    runId: string;
    conversationId: string;
    profileId: string;
    prompt: string;
    overlay: FrozenOverlay | Record<string, unknown>;
    workspacePath: string;
  }): RunSnapshot | null {
    if (this.getByRun(input.runId)) return this.getByRun(input.runId);
    const workspaceDir = path.join(this.snapshotRoot, input.runId);
    try {
      fs.mkdirSync(this.snapshotRoot, { recursive: true });
      if (fs.existsSync(input.workspacePath)) {
        copyWorkspace(input.workspacePath, workspaceDir);
      } else {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
    } catch {
      return null;
    }
    const snapshot: RunSnapshot = {
      id: randomUUID(),
      runId: input.runId,
      conversationId: input.conversationId,
      profileId: input.profileId,
      prompt: input.prompt,
      overlay: asOverlay(input.overlay),
      workspaceDir,
      createdAt: Date.now()
    };
    this.database
      .prepare(
        `INSERT OR IGNORE INTO run_snapshots
        (id, run_id, conversation_id, profile_id, prompt, overlay_json, workspace_dir, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.runId,
        snapshot.conversationId,
        snapshot.profileId,
        snapshot.prompt,
        JSON.stringify(snapshot.overlay),
        snapshot.workspaceDir,
        snapshot.createdAt
      );
    return snapshot;
  }

  getByRun(runId: string): RunSnapshot | null {
    const row = this.database.prepare("SELECT * FROM run_snapshots WHERE run_id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForProfile(profileId: string, limit = 20): RunSnapshot[] {
    const rows = this.database
      .prepare("SELECT * FROM run_snapshots WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(profileId, Math.max(1, Math.min(100, limit))) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }

  latestForProfile(profileId: string): RunSnapshot | null {
    const row = this.database
      .prepare("SELECT * FROM run_snapshots WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(profileId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : null;
  }

  restoreInto(runId: string, targetWorkspace: string): boolean {
    const snapshot = this.getByRun(runId);
    if (!snapshot || !fs.existsSync(snapshot.workspaceDir)) return false;
    fs.mkdirSync(path.dirname(targetWorkspace), { recursive: true });
    copyWorkspace(snapshot.workspaceDir, targetWorkspace);
    return true;
  }

  pinConversation(conversationId: string, mark: ReplayMark): void {
    this.database
      .prepare(
        `INSERT INTO replay_marks
        (conversation_id, source_run_id, mode, include_artifact_id, prompt, overlay_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         source_run_id = excluded.source_run_id,
         mode = excluded.mode,
         include_artifact_id = excluded.include_artifact_id,
         prompt = excluded.prompt,
         overlay_json = excluded.overlay_json,
         created_at = excluded.created_at`
      )
      .run(
        conversationId,
        mark.sourceRunId,
        mark.mode,
        mark.includeArtifactId ?? null,
        mark.prompt,
        JSON.stringify(mark.overlay),
        Date.now()
      );
  }

  markForConversation(conversationId: string): ReplayMark | null {
    const row = this.database.prepare("SELECT * FROM replay_marks WHERE conversation_id = ?").get(conversationId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      sourceRunId: String(row.source_run_id),
      mode: row.mode === "with-artifact" ? "with-artifact" : "frozen",
      includeArtifactId: row.include_artifact_id == null ? null : String(row.include_artifact_id),
      prompt: String(row.prompt ?? ""),
      overlay: asOverlay(JSON.parse(String(row.overlay_json)))
    };
  }

  latestMatching(profileId: string, match: (snapshot: RunSnapshot) => boolean, limit = 20): RunSnapshot | null {
    const rows = this.database
      .prepare("SELECT * FROM run_snapshots WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(profileId, limit) as Record<string, unknown>[];
    for (const row of rows) {
      const snapshot = this.fromRow(row);
      if (match(snapshot)) return snapshot;
    }
    return null;
  }

  private fromRow(row: Record<string, unknown>): RunSnapshot {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      conversationId: String(row.conversation_id),
      profileId: String(row.profile_id),
      prompt: String(row.prompt),
      overlay: asOverlay(JSON.parse(String(row.overlay_json))),
      workspaceDir: String(row.workspace_dir),
      createdAt: Number(row.created_at)
    };
  }
}
