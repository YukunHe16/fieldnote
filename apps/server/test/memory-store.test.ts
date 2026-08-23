import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { MemoryStore } from "../src/memory-store.js";
import { AgentStore } from "../src/store.js";

describe("MemoryStore", () => {
  it("migrates legacy work memories to the local operator without changing global facts", () => {
    const databasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memory-legacy-")), "agent.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`CREATE TABLE memory_items (
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const insert = legacy.prepare(
      `INSERT INTO memory_items
       (id, category, title, content, keywords_json, source_kind, fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 'manual', ?, 1, 1)`
    );
    for (const category of ["profile", "preference", "goal", "project", "task"] as const) {
      insert.run(category, category, `${category} 标题`, `${category} 内容`, category);
    }
    legacy.close();

    const database = openDatabase(databasePath);
    const rows = database.prepare("SELECT category, scope, profile_id FROM memory_items ORDER BY id").all() as Array<{
      category: string;
      scope: string;
      profile_id: string | null;
    }>;
    expect(rows).toEqual([
      { category: "goal", scope: "profile", profile_id: "local-operator" },
      { category: "preference", scope: "global", profile_id: null },
      { category: "profile", scope: "global", profile_id: null },
      { category: "project", scope: "profile", profile_id: "local-operator" },
      { category: "task", scope: "profile", profile_id: "local-operator" }
    ]);
    database.close();

    const reopened = openDatabase(databasePath);
    expect(
      reopened
        .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE scope = 'profile' AND profile_id = 'local-operator'")
        .get()
    ).toEqual({ count: 3 });
    reopened.close();
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });
  });

  it("defaults work memories to a valid profile scope and rejects invalid scopes", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    expect(
      memories.createExplicit({
        category: "project",
        title: "默认工作空间",
        content: "归属通用助手"
      }).memory
    ).toMatchObject({ scope: "profile", profileId: "local-operator" });
    expect(() =>
      memories.create({
        category: "task",
        title: "错误全局任务",
        content: "不允许跨助手共享",
        sourceKind: "manual",
        scope: "global"
      })
    ).toThrow(/task memories must use profile scope/i);
    expect(() =>
      memories.create({
        category: "preference",
        title: "错误 Profile 偏好",
        content: "不允许这样保存",
        sourceKind: "manual",
        scope: "profile",
        profileId: "graduate-admissions"
      })
    ).toThrow(/preference memories must use global scope/i);
    expect(() =>
      memories.create({
        category: "project",
        title: "未知助手",
        content: "不允许未知归属",
        sourceKind: "manual",
        scope: "profile",
        profileId: "unknown-agent"
      })
    ).toThrow(/unknown agent profile/i);
    database.close();
  });

  it("stores settings and searches Chinese memory text with trigram FTS", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);

    expect(memories.getSettings()).toEqual({ enabled: true, autoSave: true, referenceHistory: true });
    expect(memories.updateSettings({ autoSave: false })).toEqual({
      enabled: true,
      autoSave: false,
      referenceHistory: true
    });

    const created = memories.create({
      category: "preference",
      title: "回答风格",
      content: "用户偏好简洁、直接的中文回答",
      keywords: ["简洁", "中文"],
      sourceKind: "manual",
      importance: 4
    });
    expect(memories.list({ query: "简洁、直接" }).map((item) => item.id)).toEqual([created.id]);
    expect(memories.list({ category: "task" })).toEqual([]);
    expect(memories.update(created.id, { pinned: true })?.pinned).toBe(true);
    database.close();
  });

  it("deduplicates exact memories and retains source snapshots after conversation deletion", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const conversation = store.createConversation("web", "项目发布计划");
    const run = store.createRun(conversation.id, "整理发布计划", "normal");

    const first = memories.create({
      category: "task",
      title: "完成发布计划",
      content: "整理了项目的发布步骤和检查清单",
      keywords: ["发布", "检查清单"],
      sourceKind: "auto",
      source: {
        conversationId: conversation.id,
        messageId: run.userMessageId,
        runId: run.id,
        conversationTitle: conversation.title,
        excerpt: "发布步骤与检查清单"
      }
    });
    const duplicate = memories.create({
      category: "task",
      title: "完成发布计划",
      content: "整理了项目的发布步骤和检查清单",
      sourceKind: "auto"
    });
    expect(duplicate.id).toBe(first.id);

    store.deleteConversation(conversation.id);
    const retained = memories.get(first.id);
    expect(retained?.sources[0]).toMatchObject({
      conversationId: null,
      conversationTitle: "项目发布计划",
      sourceDeleted: true
    });
    expect(memories.delete(first.id)).toBe(true);
    expect(memories.get(first.id)).toBeNull();
    database.close();
  });

  it("keeps stable context separate from searchable task history and records run references", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "继续发布项目", "normal");
    const preference = memories.create({
      category: "preference",
      title: "沟通偏好",
      content: "回答保持简洁",
      sourceKind: "manual"
    });
    const task = memories.create({
      category: "task",
      title: "发布项目准备",
      content: "已经完成发布项目的上线清单",
      keywords: ["发布项目"],
      sourceKind: "auto",
      source: { conversationId: conversation.id, runId: run.id, conversationTitle: conversation.title }
    });

    expect(memories.stableContext().map((item) => item.id)).toEqual([preference.id]);
    const results = memories.search({ query: "发布项目", categories: ["task"] });
    expect(results.map((item) => item.id)).toEqual([task.id]);
    const references = memories.recordReferences(run.id, results);
    expect(references[0]).toMatchObject({ memoryId: task.id, title: "发布项目准备" });
    expect(memories.referencesForRun(run.id)).toEqual(references);

    const explicit = memories.createExplicit({
      category: "profile",
      title: "用户称呼",
      content: "称呼用户为小林"
    });
    expect(explicit.mutationId).not.toBe("");
    expect(new Date(explicit.undoExpiresAt).getTime()).toBeGreaterThan(Date.now());
    const forgotten = memories.deleteExplicit(explicit.memory!.id);
    expect(forgotten?.memory).toBeNull();
    expect(memories.get(explicit.memory!.id)).toBeNull();
    expect(memories.undoMutation(forgotten!.mutationId)).toMatchObject({ id: explicit.memory!.id });
    database.close();
  });

  it("supersedes task memories from a replaced branch", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "旧请求", "normal");
    store.replaceMessageText(run.assistantMessageId, "旧回答");
    store.setMessageStatus(run.assistantMessageId, "completed");
    store.setRunStatus(run.id, "completed");
    const task = memories.create({
      category: "task",
      title: "旧任务",
      content: "这是将被改写的旧任务结果",
      sourceKind: "auto",
      source: { conversationId: conversation.id, runId: run.id, conversationTitle: conversation.title }
    });

    store.createBranchFromMessage(run.userMessageId, { asNewConversation: false, includeTarget: false });
    expect(memories.get(task.id)?.status).toBe("superseded");
    expect(memories.search({ query: "旧任务", categories: ["task"] })).toEqual([]);
    database.close();
  });

  it("rejects sensitive values and invalidates undo history when all memory is cleared", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    expect(() =>
      memories.create({
        category: "profile",
        title: "访问令牌",
        content: "api_key=sk-sensitive-value-123456789",
        sourceKind: "manual"
      })
    ).toThrow(/sensitive information/i);
    const explicit = memories.createExplicit({
      category: "profile",
      title: "称呼",
      content: "称呼用户为小林"
    });
    expect(memories.clear()).toBe(1);
    expect(() => memories.undoMutation(explicit.mutationId)).toThrow(/not found/i);
    database.close();
  });

  it("becomes due at 50 new task memories or seven days, whichever comes first", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    const initial = Date.now();
    expect(memories.getMaintenanceStatus(initial)).toMatchObject({
      due: false,
      newTaskCount: 0,
      taskThreshold: 50,
      intervalDays: 7
    });
    database.prepare("UPDATE memory_maintenance_state SET last_run_at = ? WHERE id = 1").run(initial - 1_000);
    for (let index = 0; index < 49; index += 1) {
      memories.create({
        category: "task",
        title: `任务 ${index}`,
        content: `第 ${index} 个待整理任务`,
        sourceKind: "auto"
      });
    }
    expect(memories.getMaintenanceStatus(initial + 2_000)).toMatchObject({ due: false, newTaskCount: 49 });
    memories.create({ category: "task", title: "任务 49", content: "第 49 个待整理任务", sourceKind: "auto" });
    expect(memories.getMaintenanceStatus(initial + 2_000)).toMatchObject({ due: true, newTaskCount: 50 });

    memories.markMaintenanceCompleted(initial + 3_000);
    expect(memories.getMaintenanceStatus(initial + 3_000 + 7 * 24 * 60 * 60_000)).toMatchObject({
      due: true,
      newTaskCount: 0
    });
    database.close();
  });

  it("merges only automatic unpinned task memories and preserves their sources", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const conversation = store.createConversation();
    const first = memories.create({
      category: "task",
      title: "发布准备一",
      content: "整理发布清单",
      sourceKind: "auto",
      source: { conversationId: conversation.id, conversationTitle: conversation.title, excerpt: "发布清单" }
    });
    const second = memories.create({
      category: "task",
      title: "发布准备二",
      content: "检查发布风险",
      sourceKind: "auto",
      source: { conversationId: conversation.id, conversationTitle: conversation.title, excerpt: "发布风险" }
    });
    const pinned = memories.create({
      category: "task",
      title: "置顶任务",
      content: "永远不自动整理",
      sourceKind: "auto",
      pinned: true
    });
    const merged = memories.mergeTaskMemories({
      sourceMemoryIds: [first.id, second.id, pinned.id],
      category: "project",
      title: "持续发布项目",
      content: "维护发布清单并持续检查风险",
      keywords: ["发布"],
      importance: 4
    });
    expect(merged).toMatchObject({ category: "project", title: "持续发布项目" });
    expect(merged?.sources).toHaveLength(2);
    expect(memories.get(first.id)?.status).toBe("superseded");
    expect(memories.get(second.id)?.status).toBe("superseded");
    expect(memories.get(pinned.id)?.status).toBe("active");
    database.close();
  });

  it("updates an explicitly remembered stable fact instead of creating a duplicate", () => {
    const database = openDatabase(":memory:");
    const store = new AgentStore(database);
    const memories = new MemoryStore(database);
    const conversation = store.createConversation();
    const run = store.createRun(conversation.id, "记住年龄", "normal");
    const first = memories.createExplicit({
      category: "profile",
      title: "用户年龄",
      content: "用户今年 20 岁",
      keywords: ["年龄"],
      source: {
        conversationId: conversation.id,
        messageId: run.userMessageId,
        runId: run.id,
        conversationTitle: conversation.title
      }
    });
    const corrected = memories.createExplicit({
      category: "profile",
      title: "用户年龄",
      content: "用户今年 21 岁",
      keywords: ["年龄"]
    });
    expect(corrected.memory?.id).toBe(first.memory?.id);
    expect(corrected.memory?.content).toBe("用户今年 21 岁");
    expect(memories.list({ category: "profile" })).toHaveLength(1);
    const restored = memories.undoMutation(corrected.mutationId);
    expect(restored?.content).toBe("用户今年 20 岁");
    expect(restored?.sources[0]).toMatchObject({ messageId: run.userMessageId, runId: run.id });
    database.close();
  });

  it("promotes an identical automatic fact to explicit and never merges into protected memory", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    const automatic = memories.create({
      category: "profile",
      title: "用户年龄",
      content: "用户今年 21 岁",
      keywords: ["年龄"],
      sourceKind: "auto"
    });
    const promoted = memories.createExplicit({
      category: "profile",
      title: "用户年龄",
      content: "用户今年 21 岁",
      keywords: ["年龄"]
    });
    expect(promoted).toMatchObject({ memory: { id: automatic.id, sourceKind: "explicit" } });
    expect(promoted.mutationId).not.toBe("");

    const protectedProject = memories.createExplicit({
      category: "project",
      title: "持续发布项目",
      content: "维护发布清单并持续检查风险"
    }).memory!;
    const first = memories.create({ category: "task", title: "发布一", content: "整理发布清单", sourceKind: "auto" });
    const second = memories.create({ category: "task", title: "发布二", content: "检查发布风险", sourceKind: "auto" });
    const merged = memories.mergeTaskMemories({
      sourceMemoryIds: [first.id, second.id],
      category: "project",
      title: protectedProject.title,
      content: protectedProject.content,
      keywords: [],
      importance: 4
    });
    expect(merged?.id).toBe(protectedProject.id);
    expect(memories.get(protectedProject.id)?.sources).toHaveLength(0);
    expect(memories.get(first.id)?.status).toBe("superseded");
    expect(memories.get(second.id)?.status).toBe("superseded");
    database.close();
  });

  it("keeps pre-feature memories outside maintenance and preserves tasks created during a run", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    const old = memories.create({
      category: "task",
      title: "旧任务",
      content: "维护功能上线前的任务",
      sourceKind: "auto"
    });
    const baseline = Date.now();
    database.prepare("UPDATE memory_items SET created_at = ? WHERE id = ?").run(baseline - 10_000, old.id);
    memories.getMaintenanceStatus(baseline);
    database
      .prepare("UPDATE memory_maintenance_state SET eligibility_cutoff_at = ? WHERE id = 1")
      .run(baseline + 10_000);
    memories.getMaintenanceStatus(baseline + 1);
    expect(database.prepare("SELECT eligibility_cutoff_at FROM memory_maintenance_state WHERE id = 1").get()).toEqual({
      eligibility_cutoff_at: baseline
    });
    expect(memories.maintenanceCandidates(50, baseline + 1_000).map((item) => item.id)).not.toContain(old.id);
    expect(memories.maintenanceCandidates(50, baseline + 1_000, true).map((item) => item.id)).toContain(old.id);

    const during = memories.create({
      category: "task",
      title: "整理期间新增",
      content: "维护执行期间创建的任务",
      sourceKind: "auto"
    });
    const watermark = baseline + 2_000;
    database.prepare("UPDATE memory_items SET created_at = ? WHERE id = ?").run(watermark + 100, during.id);
    memories.markMaintenanceCompleted(watermark, watermark + 500);
    expect(memories.getMaintenanceStatus(watermark + 500)).toMatchObject({ newTaskCount: 1 });
    database.close();
  });

  it("shares global preferences while isolating project and task memories by agent profile", () => {
    const database = openDatabase(":memory:");
    const memories = new MemoryStore(database);
    const preference = memories.create({
      category: "preference",
      title: "回答语言",
      content: "使用中文",
      sourceKind: "auto",
      scope: "global"
    });
    const admissions = memories.create({
      category: "project",
      title: "2027 申请",
      content: "申请美国和加拿大的计算机博士",
      sourceKind: "auto",
      scope: "profile",
      profileId: "graduate-admissions"
    });
    const local = memories.create({
      category: "project",
      title: "本地项目",
      content: "维护本地 Agent 工作台",
      sourceKind: "auto",
      scope: "profile",
      profileId: "local-operator"
    });
    const sameAdmissionsTask = memories.create({
      category: "task",
      title: "整理资料",
      content: "完成资料整理",
      sourceKind: "auto",
      scope: "profile",
      profileId: "graduate-admissions"
    });
    const sameLocalTask = memories.create({
      category: "task",
      title: "整理资料",
      content: "完成资料整理",
      sourceKind: "auto",
      scope: "profile",
      profileId: "local-operator"
    });

    expect(memories.stableContext("graduate-admissions").map((item) => item.id)).toEqual(
      expect.arrayContaining([preference.id, admissions.id])
    );
    expect(memories.stableContext("graduate-admissions").map((item) => item.id)).not.toContain(local.id);
    expect(
      memories
        .search({ query: "资料整理", categories: ["task"], profileId: "graduate-admissions" })
        .map((item) => item.id)
    ).toContain(sameAdmissionsTask.id);
    expect(
      memories
        .search({ query: "资料整理", categories: ["task"], profileId: "graduate-admissions" })
        .map((item) => item.id)
    ).not.toContain(sameLocalTask.id);
    expect(
      memories.mergeTaskMemories({
        sourceMemoryIds: [sameAdmissionsTask.id, sameLocalTask.id],
        category: "project",
        title: "错误跨域合并",
        content: "不应合并",
        keywords: [],
        importance: 2
      })
    ).toBeNull();
    database.close();
  });
});
