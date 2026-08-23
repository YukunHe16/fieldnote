import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";

describe("database migrations", () => {
  it("adds memory scope columns before creating their index on an existing database", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-agent-db-"));
    const databasePath = path.join(root, "agent.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        source_kind TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        fingerprint TEXT NOT NULL,
        last_maintained_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    const columns = migrated.pragma("table_info(memory_items)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["scope", "profile_id"]));
    const indexes = migrated.pragma("index_list(memory_items)") as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_memory_items_scope");
    migrated.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});
