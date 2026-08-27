import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { EvolutionStore } from "../src/evolution-store.js";
import { LearningStore } from "../src/learning-store.js";
import { MemoryStore } from "../src/memory-store.js";
import { AgentStore } from "../src/store.js";

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

  it("remaps rows left behind by the removed graduate-admissions profile on the next boot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "removed-profile-db-"));
    const databasePath = path.join(root, "agent.db");

    const seeded = openDatabase(databasePath);
    const store = new AgentStore(seeded);
    const memories = new MemoryStore(seeded);
    const evolution = new EvolutionStore(seeded);
    // The learning tables are created by their store, after `openDatabase` has returned —
    // the migration has to tolerate that and still find them on the next boot.
    const learning = new LearningStore(seeded);

    const conversation = store.createConversation("web", "旧档案对话", { profileId: "local-operator" });
    const memory = memories.create({
      category: "task",
      title: "旧任务",
      content: "在旧档案下记录的任务",
      sourceKind: "auto",
      scope: "profile",
      profileId: "local-operator"
    });
    const playbook = evolution.createPlaybook({
      title: "旧做法",
      instruction: "在旧档案下确认过的做法",
      polarity: "do",
      origin: "user",
      scope: "profile",
      profileId: "local-operator"
    });
    const session = learning.createSession({
      conversationId: conversation.id,
      profileId: "local-operator",
      goal: "旧档案下的学习目标"
    });
    const survivor = evolution.createArtifact({
      profileId: "local-operator",
      kind: "skill",
      slug: "shared-slug",
      name: "已经存在的能力",
      description: "本地助手下已有的能力",
      body: "1. 先看\n2. 再写",
      origin: "distilled",
      status: "enabled"
    });
    const colliding = evolution.createArtifact({
      profileId: "local-operator",
      kind: "skill",
      slug: "temporary-slug",
      name: "同名能力",
      description: "旧档案下的同名能力",
      body: "1. 先看\n2. 再写",
      origin: "distilled",
      status: "enabled"
    });

    // Re-point the seeded rows onto the removed profile: this is the shape a database written
    // before the removal has on disk. `colliding` is given the slug `survivor` already uses, so
    // remapping it would violate UNIQUE(profile_id, kind, slug).
    for (const [table, id] of [
      ["conversations", conversation.id],
      ["memory_items", memory.id],
      ["playbooks", playbook.id],
      ["learning_sessions", session.id]
    ] as const) {
      seeded.prepare(`UPDATE ${table} SET profile_id = 'graduate-admissions' WHERE id = ?`).run(id);
    }
    seeded
      .prepare("UPDATE evolved_artifacts SET profile_id = 'graduate-admissions', slug = 'shared-slug' WHERE id = ?")
      .run(colliding.id);
    seeded.close();

    const reopened = openDatabase(databasePath);
    const profileOf = (table: string, id: string): string =>
      (reopened.prepare(`SELECT profile_id FROM ${table} WHERE id = ?`).get(id) as { profile_id: string }).profile_id;

    expect(profileOf("conversations", conversation.id)).toBe("local-operator");
    expect(profileOf("memory_items", memory.id)).toBe("local-operator");
    expect(profileOf("playbooks", playbook.id)).toBe("local-operator");
    expect(profileOf("learning_sessions", session.id)).toBe("local-operator");
    expect(profileOf("evolved_artifacts", survivor.id)).toBe("local-operator");
    // `UPDATE OR IGNORE` keeps startup alive: the row that cannot be remapped keeps the dead
    // profile id rather than aborting `openDatabase`, and nothing is deleted.
    expect(profileOf("evolved_artifacts", colliding.id)).toBe("graduate-admissions");
    expect((reopened.prepare("SELECT COUNT(*) AS count FROM evolved_artifacts").get() as { count: number }).count).toBe(
      2
    );

    reopened.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});
