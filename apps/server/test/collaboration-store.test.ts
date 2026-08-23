import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationStore } from "../src/collaboration-store.js";
import { openDatabase } from "../src/database.js";
import { AgentStore, type RunRecord } from "../src/store.js";

const databases: Array<{ close(): void }> = [];

function createContext(databasePath = ":memory:") {
  const database = openDatabase(databasePath);
  databases.push(database);
  const agents = new AgentStore(database);
  const conversation = agents.createConversation("web", "测试");
  const run = agents.createRun(conversation.id, "核验项目", "normal");
  const otherRun = agents.createRun(conversation.id, "另一轮", "normal");
  return { database, agents, conversation, store: new CollaborationStore(database), run, otherRun };
}

function task(store: CollaborationStore, run: RunRecord) {
  return store.createTask({
    runId: run.id,
    assistantMessageId: run.assistantMessageId,
    specialistId: "source-verifier",
    displayName: "来源核验专家",
    requestSummary: "核验项目的官方截止日期"
  });
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("collaboration store", () => {
  it("persists structured and unstructured specialist results through the full lifecycle", () => {
    const { store, run } = createContext();
    const structuredTask = store.markRunning(task(store, run).id);
    const completed = store.completeStructured(structuredTask.id, {
      summary: "官方页面已核验截止日期。",
      findings: [
        {
          claim: "截止日期为 12 月 1 日",
          status: "verified",
          sourceUrls: ["https://example.edu/deadline", "javascript:alert(1)"],
          verifiedAt: "2023-11-14T22:13:20.000Z"
        },
        {
          claim: "没有可追溯来源的结论",
          status: "verified",
          sourceUrls: ["javascript:alert(1)"]
        }
      ],
      openQuestions: ["是否接受晚交材料？"],
      recommendedFollowups: [{ specialistId: "admissions-researcher", question: "确认例外条款" }]
    });
    expect(completed.status).toBe("completed");
    expect(completed.structured).toBe(true);
    expect(completed.result?.findings[0]?.sourceUrls).toEqual(["https://example.edu/deadline"]);
    expect(completed.result?.findings[0]?.verifiedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(completed.result?.findings[1]).toMatchObject({ status: "unresolved", sourceUrls: [] });

    const unstructuredTask = store.markRunning(task(store, run).id);
    const unstructured = store.completeUnstructured(unstructuredTask.id, "专家只返回了简短文本摘要");
    expect(unstructured).toMatchObject({ status: "completed", structured: false, result: null });
    expect(store.listForRun(run.id)).toHaveLength(2);
    expect(store.listForMessage(run.assistantMessageId)).toHaveLength(2);
  });

  it("rejects illegal task transitions and preserves terminal records", () => {
    const { store, run } = createContext();
    const queued = task(store, run);
    expect(() => store.completeUnstructured(queued.id, "not started")).toThrow("Cannot complete a queued");
    const failed = store.fail(queued.id, "   network\n  timeout   ");
    expect(failed).toMatchObject({ status: "failed", error: "network timeout" });
    expect(() => store.markRunning(queued.id)).toThrow("Cannot mark running a failed");
    expect(() => store.interrupt(queued.id)).toThrow("Cannot interrupted a failed");
    expect(store.interrupt(task(store, run).id).status).toBe("interrupted");
  });

  it("creates only same-run handoffs and tracks running and terminal state", () => {
    const { store, run, otherRun } = createContext();
    const source = store.markRunning(task(store, run).id);
    store.completeUnstructured(source.id, "已找到需要复核的来源");
    const target = task(store, run);
    const handoff = store.createHandoff({
      runId: run.id,
      sourceTaskId: source.id,
      targetTaskId: target.id,
      question: "复核截止日期是否适用于国际生"
    });
    expect(handoff).toMatchObject({ status: "queued", question: "复核截止日期是否适用于国际生" });
    store.markRunning(target.id);
    expect(store.markHandoffRunning(handoff.id).status).toBe("running");
    store.completeUnstructured(target.id, "复核完成");
    expect(store.updateHandoffTerminal(handoff.id, "completed")).toMatchObject({ status: "completed", error: null });

    const otherTask = task(store, otherRun);
    expect(() =>
      store.createHandoff({
        runId: run.id,
        sourceTaskId: source.id,
        targetTaskId: otherTask.id,
        question: "非法跨轮交接"
      })
    ).toThrow("same run");
  });

  it("interrupts every open task and handoff when its host run cannot resume", () => {
    const { store, run } = createContext();
    const source = store.markRunning(task(store, run).id);
    store.completeUnstructured(source.id, "需要继续复核");
    const target = store.markRunning(task(store, run).id);
    const handoff = store.createHandoff({
      runId: run.id,
      sourceTaskId: source.id,
      targetTaskId: target.id,
      question: "继续核查"
    });
    store.markHandoffRunning(handoff.id);

    expect(store.interruptRun(run.id, "Server restarted")).toBe(1);
    expect(store.getTask(target.id)).toMatchObject({ status: "interrupted", error: "Server restarted" });
    expect(store.listHandoffsForRun(run.id)[0]).toMatchObject({ status: "interrupted", error: "Server restarted" });
    expect(store.getTask(source.id)?.status).toBe("completed");
  });

  it("keeps old collaboration records on a superseded run and binds retry work to a new run", () => {
    const { database, agents, conversation, store, run } = createContext();
    const oldTask = store.markRunning(task(store, run).id);
    store.completeUnstructured(oldTask.id, "旧分支结论");
    agents.createBranchFromMessage(run.userMessageId, { asNewConversation: false, includeTarget: true });
    expect(
      (database.prepare("SELECT superseded_at FROM runs WHERE id = ?").get(run.id) as { superseded_at: number | null })
        .superseded_at
    ).not.toBeNull();

    const retryRun = agents.createRun(conversation.id, "重新核验项目", "normal");
    const retryTask = store.createTask({
      runId: retryRun.id,
      assistantMessageId: retryRun.assistantMessageId,
      specialistId: "source-verifier",
      displayName: "来源核验专家",
      requestSummary: "在新分支重新核验"
    });
    expect(store.listForRun(run.id).map((item) => item.id)).toEqual([oldTask.id]);
    expect(store.listForRun(retryRun.id).map((item) => item.id)).toEqual([retryTask.id]);
  });

  it("reopens persisted tasks and handoffs after a database restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-store-"));
    const databasePath = path.join(root, "agent.sqlite");
    const firstContext = createContext(databasePath);
    const source = firstContext.store.markRunning(task(firstContext.store, firstContext.run).id);
    firstContext.store.completeUnstructured(source.id, "源任务完成");
    const target = task(firstContext.store, firstContext.run);
    const handoff = firstContext.store.createHandoff({
      runId: firstContext.run.id,
      sourceTaskId: source.id,
      targetTaskId: target.id,
      question: "继续复核"
    });
    firstContext.database.close();
    databases.pop();

    const second = openDatabase(databasePath);
    databases.push(second);
    const secondStore = new CollaborationStore(second);
    expect(secondStore.getTask(source.id)).toMatchObject({ status: "completed", resultSummary: "源任务完成" });
    expect(secondStore.listHandoffsForRun(firstContext.run.id)[0]).toMatchObject({ id: handoff.id, status: "queued" });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
