import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { MemoryStore } from "../src/memory-store.js";
import { AgentStore } from "../src/store.js";
import { sweepExpiredTemporaryConversations } from "../src/temporary-conversations.js";

describe("temporary conversation cleanup", () => {
  it("removes expired history, workspace, and session transcripts while retaining memories", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "temporary-conversations-"));
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const expired = store.createConversation("web", "临时对话", {
      temporary: true,
      expiresAt: Date.now() - 1
    });
    const future = store.createConversation("web", "仍可恢复", {
      temporary: true,
      expiresAt: Date.now() + 60_000
    });
    store.updateBranchSession(expired.activeBranchId, "temporary-session");
    database
      .prepare(
        `INSERT INTO session_store_entries
         (project_key, session_id, subpath, ordinal, entry_json, created_at)
       VALUES ('project', 'temporary-session', '', 0, '{}', ?)`
      )
      .run(Date.now());
    database
      .prepare(
        `INSERT INTO session_store_summaries (project_key, session_id, mtime, data_json)
       VALUES ('project', 'temporary-session', ?, '{}')`
      )
      .run(Date.now());
    const memory = memories.create({
      category: "task",
      title: "保留的摘要",
      content: "即使来源对话删除，这条结构化记忆仍保留",
      sourceKind: "auto",
      source: { conversationId: expired.id, conversationTitle: expired.title }
    });
    const directory = path.join(workspaceRoot, expired.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "note.txt"), "temporary");
    const interrupted: string[] = [];

    const deleted = await sweepExpiredTemporaryConversations(store, workspaceRoot, {
      beforeDelete: async (conversationId) => {
        interrupted.push(conversationId);
      }
    });

    expect(deleted).toEqual([expired.id]);
    expect(interrupted).toEqual([expired.id]);
    expect(store.getConversation(expired.id)).toBeNull();
    expect(store.getConversation(future.id)).not.toBeNull();
    await expect(fs.stat(directory)).rejects.toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_store_entries").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_store_summaries").get()).toEqual({ count: 0 });
    expect(memories.get(memory.id)?.sources[0]).toMatchObject({ conversationId: null, sourceDeleted: true });

    database.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
});
