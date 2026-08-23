import fs from "node:fs/promises";
import path from "node:path";
import type { AgentStore } from "./store.js";

export async function deleteConversationData(
  store: AgentStore,
  workspaceRoot: string,
  conversationId: string
): Promise<boolean> {
  validateConversationId(conversationId);
  store.deleteSessionTranscriptsForConversation(conversationId);
  const deleted = store.deleteConversation(conversationId);
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, conversationId);
  if (path.dirname(target) !== root) throw new Error("Unsafe workspace target");
  await fs.rm(target, { recursive: true, force: true });
  return deleted;
}

export async function sweepExpiredTemporaryConversations(
  store: AgentStore,
  workspaceRoot: string,
  options: { now?: number; beforeDelete?: (conversationId: string) => Promise<void> } = {}
): Promise<string[]> {
  const ids = store.listExpiredTemporaryConversationIds(options.now ?? Date.now());
  const deleted: string[] = [];
  for (const id of ids) {
    if (options.beforeDelete) await options.beforeDelete(id);
    if (await deleteConversationData(store, workspaceRoot, id)) deleted.push(id);
  }
  return deleted;
}

function validateConversationId(value: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Invalid conversation id");
}
