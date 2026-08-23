import type { AgentEvent, AssistantBlockDto, ChatMessage, ConversationDetail, MessageStatus, RunState } from "./types";

const terminalStates = new Set<RunState>(["completed", "failed", "interrupted"]);

function settleBlocks(
  blocks: AssistantBlockDto[],
  status: "completed" | "failed" | "interrupted"
): AssistantBlockDto[] {
  return blocks.map((block) => {
    const wasOpen = block.status === "running" || block.status === "queued";
    return {
      ...block,
      ...(wasOpen ? { status } : {}),
      ...(wasOpen && block.activity ? { activity: { ...block.activity, status } } : {}),
      children: settleBlocks(block.children, status)
    };
  });
}

export function settleRunMessages(
  messages: ChatMessage[],
  runId: string,
  status: "completed" | "failed" | "interrupted"
): ChatMessage[] {
  const messageStatus: MessageStatus = status;
  return messages.map((message) =>
    message.role === "assistant" && message.runId === runId
      ? { ...message, status: messageStatus, blocks: settleBlocks(message.blocks ?? [], status) }
      : message
  );
}

function stateFromEvent(event: AgentEvent): RunState | undefined {
  if (event.type === "run.started") return "running";
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.interrupted") return "interrupted";
  if (event.type === "run.failed") return "failed";
  if (event.type !== "run.status") return undefined;
  if (event.status === "queued" || event.status === "submitting") return "submitting";
  if (event.status === "running" || event.status === "interrupting" || event.status === "reconnecting")
    return event.status;
  if (event.status === "completed" || event.status === "failed" || event.status === "interrupted") return event.status;
  if (event.status === "stopped" || event.status === "aborted") return "interrupted";
  return undefined;
}

function terminalRunIds(events: AgentEvent[]) {
  return new Set(
    events
      .filter(
        (event) =>
          event.runId &&
          (event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.interrupted" ||
            (event.type === "run.status" && terminalStates.has(event.status as RunState)))
      )
      .map((event) => event.runId as string)
  );
}

export function applyRunEventState(
  detail: ConversationDetail,
  event: AgentEvent
): Pick<ConversationDetail, "runState" | "activeRunId"> {
  const nextState = stateFromEvent(event);
  if (!nextState) return { runState: detail.runState, activeRunId: detail.activeRunId };
  const eventRunId = event.runId;
  const terminated = terminalRunIds(detail.events ?? []);

  if (eventRunId && terminated.has(eventRunId) && !terminalStates.has(nextState)) {
    return { runState: detail.runState, activeRunId: detail.activeRunId };
  }
  if (detail.activeRunId && eventRunId && detail.activeRunId !== eventRunId) {
    return { runState: detail.runState, activeRunId: detail.activeRunId };
  }
  if (terminalStates.has(nextState)) {
    return { runState: nextState, activeRunId: undefined };
  }
  return { runState: nextState, activeRunId: eventRunId ?? detail.activeRunId };
}
