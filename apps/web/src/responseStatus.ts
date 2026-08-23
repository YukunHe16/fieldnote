import type { ChatMessage, RunState } from "./types";

const busyStates = new Set<RunState>(["submitting", "running", "reconnecting", "interrupting"]);

export type ResponseStatusKey = "statusThinking" | "statusStopping" | "statusReconnecting";

export function responseStatusLabel(state?: RunState): ResponseStatusKey {
  if (state === "reconnecting") return "statusReconnecting";
  if (state === "interrupting") return "statusStopping";
  return "statusThinking";
}

export function shouldShowMessageStatus(message: ChatMessage, runState?: RunState, waitingForUser = false) {
  if (waitingForUser) return false;
  if (hasThinkingBlocks(message) || shouldShowThinkingFold(message, runState, waitingForUser)) return false;
  const hasVisibleActivity = hasVisibleToolActivity(message);
  return (
    message.role === "assistant" &&
    !message.content.trim() &&
    !hasVisibleActivity &&
    message.status === "streaming" &&
    busyStates.has(runState ?? "idle")
  );
}

export function shouldShowThinkingFold(message: ChatMessage, runState?: RunState, waitingForUser = false) {
  if (waitingForUser) return false;
  if (message.role !== "assistant") return false;
  if (hasThinkingBlocks(message)) return false;
  if (message.reasoningSummary?.trim()) return true;
  const hasVisibleActivity = hasVisibleToolActivity(message);
  return (
    message.status === "streaming" &&
    busyStates.has(runState ?? "idle") &&
    !message.content.trim() &&
    !hasVisibleActivity
  );
}

export function shouldShowSyntheticStatus(messages: ChatMessage[], runState?: RunState, waitingForUser = false) {
  if (waitingForUser) return false;
  return busyStates.has(runState ?? "idle") && messages.at(-1)?.role === "user";
}

export function isAskUserQuestionBlock(block: {
  technicalName?: string;
  name?: string;
  title?: string;
  activity?: { technicalName?: string; displayName?: string } | null;
}) {
  return /askuserquestion|ask_user_question|等待你选择/i.test(
    `${block.technicalName ?? ""} ${block.name ?? ""} ${block.title ?? ""} ${block.activity?.technicalName ?? ""} ${block.activity?.displayName ?? ""}`
  );
}

export function isLearningFrameworkBlock(block: {
  technicalName?: string;
  name?: string;
  title?: string;
  activity?: { technicalName?: string; displayName?: string } | null;
}) {
  return /mcp__learning__|open_learning_incident|record_learning_intervention|request_learning_verification|propose_learning_outcome|escalate_learning_incident/i.test(
    `${block.technicalName ?? ""} ${block.name ?? ""} ${block.title ?? ""} ${block.activity?.technicalName ?? ""} ${block.activity?.displayName ?? ""}`
  );
}

export function isThinkingBlock(block: { type?: string; kind?: string }) {
  return block.type === "thinking" || block.kind === "thinking";
}

function hasThinkingBlocks(message: ChatMessage) {
  return message.blocks?.some(isThinkingBlock) ?? false;
}

function hasVisibleToolActivity(message: ChatMessage) {
  return (
    message.blocks?.some(
      (block) =>
        block.type !== "text" &&
        !isAskUserQuestionBlock(block) &&
        !isLearningFrameworkBlock(block) &&
        !isThinkingBlock(block)
    ) ?? false
  );
}

export function isConversationBusy(runState?: RunState) {
  return busyStates.has(runState ?? "idle");
}
