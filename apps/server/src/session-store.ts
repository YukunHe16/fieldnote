import type { SessionKey, SessionStore, SessionStoreEntry, SessionSummaryEntry } from "@anthropic-ai/claude-agent-sdk";
import type { SqliteDatabase } from "./database.js";

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly database: SqliteDatabase) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const subpath = key.subpath ?? "";
    const timestamp = Date.now();
    this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT COALESCE(MAX(ordinal), -1) + 1 AS next
           FROM session_store_entries
           WHERE project_key = ? AND session_id = ? AND subpath = ?`
        )
        .get(key.projectKey, key.sessionId, subpath) as { next: number };
      const insert = this.database.prepare(
        `INSERT INTO session_store_entries
           (project_key, session_id, subpath, ordinal, entry_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      entries.forEach((entry, index) => {
        insert.run(key.projectKey, key.sessionId, subpath, row.next + index, JSON.stringify(entry), timestamp);
      });
      if (!key.subpath) {
        this.database
          .prepare(
            `INSERT INTO session_store_summaries (project_key, session_id, mtime, data_json)
             VALUES (?, ?, ?, '{}')
             ON CONFLICT(project_key, session_id) DO UPDATE SET mtime = excluded.mtime`
          )
          .run(key.projectKey, key.sessionId, timestamp);
      }
    })();
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.database
      .prepare(
        `SELECT entry_json FROM session_store_entries
         WHERE project_key = ? AND session_id = ? AND subpath = ?
         ORDER BY ordinal ASC`
      )
      .all(key.projectKey, key.sessionId, key.subpath ?? "") as Array<{ entry_json: string }>;
    return rows.length > 0 ? rows.map((row) => JSON.parse(row.entry_json) as SessionStoreEntry) : null;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const rows = this.database
      .prepare(
        `SELECT session_id, mtime FROM session_store_summaries
         WHERE project_key = ? ORDER BY mtime DESC`
      )
      .all(projectKey) as Array<{ session_id: string; mtime: number }>;
    return rows.map((row) => ({ sessionId: row.session_id, mtime: row.mtime }));
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT session_id, mtime, data_json FROM session_store_summaries
         WHERE project_key = ? ORDER BY mtime DESC`
      )
      .all(projectKey) as Array<{ session_id: string; mtime: number; data_json: string }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      mtime: row.mtime,
      data: JSON.parse(row.data_json) as Record<string, unknown>
    }));
  }

  async delete(key: SessionKey): Promise<void> {
    this.database.transaction(() => {
      if (key.subpath) {
        this.database
          .prepare(
            `DELETE FROM session_store_entries
             WHERE project_key = ? AND session_id = ? AND subpath = ?`
          )
          .run(key.projectKey, key.sessionId, key.subpath);
        return;
      }
      this.database
        .prepare("DELETE FROM session_store_entries WHERE project_key = ? AND session_id = ?")
        .run(key.projectKey, key.sessionId);
      this.database
        .prepare("DELETE FROM session_store_summaries WHERE project_key = ? AND session_id = ?")
        .run(key.projectKey, key.sessionId);
    })();
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT subpath FROM session_store_entries
         WHERE project_key = ? AND session_id = ? AND subpath != ''
         ORDER BY subpath`
      )
      .all(key.projectKey, key.sessionId) as Array<{ subpath: string }>;
    return rows.map((row) => row.subpath);
  }
}
