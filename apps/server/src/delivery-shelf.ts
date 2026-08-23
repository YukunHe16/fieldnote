import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SqliteDatabase } from "./database.js";

export type ShelfItem = {
  id: string;
  profileId: string;
  conversationId: string | null;
  attachmentId: string | null;
  fileName: string;
  mimeType: string;
  relativePath: string;
  sourceWorkspace: string;
  createdAt: number;
};

export class DeliveryShelf {
  constructor(private readonly database: SqliteDatabase) {}

  put(input: {
    profileId: string;
    conversationId?: string | null;
    attachmentId?: string | null;
    fileName: string;
    mimeType: string;
    relativePath: string;
    sourceWorkspace: string;
  }): ShelfItem {
    const existing = this.database
      .prepare("SELECT * FROM delivery_shelf WHERE profile_id = ? AND source_workspace = ? AND relative_path = ?")
      .get(input.profileId, input.sourceWorkspace, input.relativePath) as Record<string, unknown> | undefined;
    if (existing) return this.fromRow(existing);
    const item: ShelfItem = {
      id: randomUUID(),
      profileId: input.profileId,
      conversationId: input.conversationId ?? null,
      attachmentId: input.attachmentId ?? null,
      fileName: input.fileName,
      mimeType: input.mimeType,
      relativePath: input.relativePath,
      sourceWorkspace: input.sourceWorkspace,
      createdAt: Date.now()
    };
    this.database
      .prepare(
        `INSERT INTO delivery_shelf
        (id, profile_id, conversation_id, attachment_id, file_name, mime_type, relative_path, source_workspace, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.profileId,
        item.conversationId,
        item.attachmentId,
        item.fileName,
        item.mimeType,
        item.relativePath,
        item.sourceWorkspace,
        item.createdAt
      );
    return item;
  }

  list(profileId: string, limit = 20): ShelfItem[] {
    return (
      this.database
        .prepare("SELECT * FROM delivery_shelf WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(profileId, limit) as Record<string, unknown>[]
    ).map((row) => this.fromRow(row));
  }

  get(id: string): ShelfItem | null {
    const row = this.database.prepare("SELECT * FROM delivery_shelf WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  remove(id: string): ShelfItem | null {
    const current = this.get(id);
    if (!current) return null;
    this.database.prepare("DELETE FROM delivery_shelf WHERE id = ?").run(id);
    return current;
  }

  fileAbsolutePath(item: ShelfItem, workspaceRoot: string): string | null {
    const root = path.resolve(workspaceRoot);
    const source = path.resolve(item.sourceWorkspace);
    const sourceRelative = path.relative(root, source);
    if (!sourceRelative || sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) return null;
    const absolute = path.resolve(source, item.relativePath);
    const fileRelative = path.relative(source, absolute);
    if (!fileRelative || fileRelative.startsWith("..") || path.isAbsolute(fileRelative)) return null;
    return fs.existsSync(absolute) ? absolute : null;
  }

  search(profileId: string, query: string, limit = 8): ShelfItem[] {
    const needle = query.trim().toLowerCase();
    return this.list(profileId, 40)
      .filter(
        (item) => item.fileName.toLowerCase().includes(needle) || item.relativePath.toLowerCase().includes(needle)
      )
      .slice(0, limit);
  }

  citeIntoWorkspace(item: ShelfItem, targetWorkspace: string): string | null {
    const source = path.resolve(item.sourceWorkspace, item.relativePath);
    if (!fs.existsSync(source)) return null;
    const destDir = path.join(targetWorkspace, "shelf");
    fs.mkdirSync(destDir, { recursive: true });
    const destName = path.basename(item.relativePath);
    const dest = path.join(destDir, destName);
    fs.copyFileSync(source, dest);
    return path.join("shelf", destName);
  }

  private fromRow(row: Record<string, unknown>): ShelfItem {
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      attachmentId: row.attachment_id ? String(row.attachment_id) : null,
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      relativePath: String(row.relative_path),
      sourceWorkspace: String(row.source_workspace),
      createdAt: Number(row.created_at)
    };
  }
}
