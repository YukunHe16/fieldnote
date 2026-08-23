import { randomUUID } from "node:crypto";
import type { MemoryItemDto } from "@fieldnote/contracts";
import type { AdmissionsStore } from "./admissions-store.js";
import { buildDomainCard } from "./domain-card.js";
import type { SqliteDatabase } from "./database.js";

export type DomainCardRevision = {
  id: string;
  profileId: string;
  title: string;
  lines: string[];
  patch: string | null;
  createdAt: number;
};

export function domainCardDiff(previous: string[], next: string[]): string[] {
  const before = new Set(previous);
  const after = new Set(next);
  const added = next.filter((line) => !before.has(line)).map((line) => `+ ${line}`);
  const removed = previous.filter((line) => !after.has(line)).map((line) => `- ${line}`);
  return [...added, ...removed];
}

export class LiveDomainCard {
  constructor(private readonly database: SqliteDatabase) {}

  capture(profileId: string, memories: MemoryItemDto[], admissions?: AdmissionsStore): DomainCardRevision | null {
    const card = buildDomainCard(profileId, memories, admissions);
    if (!card) return null;
    const last = this.latest(profileId);
    const changed = !last || last.lines.join("\n") !== card.lines.join("\n");
    if (!changed && last) return last;
    const patch = last
      ? domainCardDiff(last.lines, card.lines).join("\n")
      : card.lines.map((line) => `+ ${line}`).join("\n");
    const revision: DomainCardRevision = {
      id: randomUUID(),
      profileId: card.profileId,
      title: card.title,
      lines: card.lines,
      patch: patch || null,
      createdAt: Date.now()
    };
    this.database
      .prepare(
        "INSERT INTO domain_card_revisions (id, profile_id, title, lines_json, patch, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        revision.id,
        revision.profileId,
        revision.title,
        JSON.stringify(revision.lines),
        revision.patch,
        revision.createdAt
      );
    return revision;
  }

  latest(profileId: string): DomainCardRevision | null {
    const row = this.database
      .prepare("SELECT * FROM domain_card_revisions WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(profileId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : null;
  }

  digest(profileId: string): { title: string; diff: string; actions: string[] } {
    const latest = this.latest(profileId);
    const diff = latest?.patch?.trim() || "作战卡没有新变化。";
    const actions = (latest?.lines ?? []).slice(0, 3);
    return { title: latest?.title ?? "申请人作战卡", diff, actions };
  }

  private fromRow(row: Record<string, unknown>): DomainCardRevision {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      title: String(row.title),
      lines: JSON.parse(String(row.lines_json)) as string[],
      patch: row.patch ? String(row.patch) : null,
      createdAt: Number(row.created_at)
    };
  }
}
